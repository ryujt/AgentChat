// 방 참가 한 번 (architecture.md 3.10 의 "입장·보정"과 "종료", 7절의 S1~S13).
// 하위 모듈을 만들어 서로 잇고, 입장 절차와 필수 피어 판정, 방 동작(채팅, 명령, 상태, 보고서), 퇴장과 종료의 순서를 맡는다.
// 병합은 shared-state, 연결은 mesh, 전달은 inbox 가 한다. 시그널을 내보내는 일은 signal-gate.ts 만 한다.

import type { AttemptFailed, Mesh } from '../mesh/contract.js';
import { LIMITS, refOf } from '../protocol/index.js';
import type { IceServers, ServerAddress, TimerHandle, Unsubscribe } from '../protocol/index.js';
import type { RecordsMeta } from '../records/contract.js';
import type { PresencePatch, PresenceView, Replica, ReplicaView } from '../shared-state/contract.js';
import type { SignalingClient, SignalingJoinFailure, SignalingStateChange } from '../signaling-client/contract.js';
import { createChatDelivery } from './chat-delivery.js';
import type { ChatDelivery } from './chat-delivery.js';
import type {
  ChatSent,
  CommandOutputs,
  FailedPeer,
  ParticipantView,
  Reach,
  ReportWritten,
  RoomEntered,
  RoomLeft,
  RoomSessionDeps,
  SendChatArgs,
  SessionCommand,
  SessionFailure,
  SessionNotice,
  SessionResult,
  SessionStatus,
  SessionWarning,
} from './contract.js';
import { createEventSink } from './events.js';
import type { EventSink } from './events.js';
import { createMeshKeeper } from './mesh-keeper.js';
import type { MeshKeeper } from './mesh-keeper.js';
import { createP2PSession } from './p2p-session.js';
import type { P2PSession, SessionFailureReason } from './p2p-session.js';
import { createGatedMesh } from './signal-gate.js';
import type { SignalGate } from './signal-gate.js';
import { claimCounts, participantView, reportInput, selfParticipant, testStatus } from './views.js';

export interface RoomParams {
  readonly mode: 'create' | 'join';
  readonly roomId: string;
  readonly name: string;
  readonly sid: string;
  readonly key: string;
  /** 프로세스에 하나인 접속 순번 공급 함수. key 와 수명이 같다. */
  readonly nextSeq: () => number;
  readonly server: ServerAddress;
  readonly iceServers: IceServers;
  /** 이 프로세스가 이 방에서 쓴 이름 전부(지금 이름 포함). */
  readonly selfNames: ReadonlySet<string>;
  /** 호스트의 취소. */
  readonly signal: AbortSignal | undefined;
}

/** 방 하나에 들어갔다 나오기까지. 한 번 쓰고 버린다. */
export interface Room {
  /** 한 번만 부른다. 실패하면 열린 링크, 서버 등록, 수신함에 넣은 사건이 남지 않는다. */
  enter(): Promise<SessionResult<RoomEntered>>;
  /** 입장한 뒤에만 부른다. */
  leave(): Promise<RoomLeft>;
  /** 어느 때든 부를 수 있다. 예산을 넘기면 남은 단계를 건너뛴다. reject 하지 않는다. */
  shutdown(budgetMs: number): Promise<void>;
  sendChat(args: SendChatArgs): Promise<SessionResult<ChatSent>>;
  command(command: SessionCommand): SessionResult<CommandOutputs[keyof CommandOutputs]>;
  status(): SessionStatus;
  notice(): SessionNotice;
  writeReport(): Promise<SessionResult<ReportWritten>>;
}

type FailedEntry = FailedPeer & { readonly theirs: number | null };

type EnterOutcome =
  | { readonly kind: 'entered' }
  | { readonly kind: 'failed'; readonly failure: SessionFailure }
  | { readonly kind: 'cancelled' };

interface Entering {
  /** joined.members 의 피어. 빼는 것은 peer_gone 과 bye{leave|shutdown} 뿐이다. */
  readonly required: Set<string>;
  readonly failed: Map<string, FailedEntry>;
  /** hello 까지 받았던 피어. 링크가 닫힌 뒤에도 기한의 사유(hello_timeout 과 sync_timeout)를 가르는 데 쓴다. */
  readonly greeted: Set<string>;
  deadline: TimerHandle | null;
  /** 입장 기한 처리 중이다. 도중의 attempt-failed 로 판정을 끝내지 않는다. */
  expiring: boolean;
  settle: (outcome: EnterOutcome) => void;
}

interface Parts {
  readonly client: SignalingClient;
  readonly gate: SignalGate;
  readonly mesh: Mesh;
  readonly replica: Replica;
  readonly events: EventSink;
  readonly p2p: P2PSession;
  readonly chat: ChatDelivery;
  readonly keeper: MeshKeeper;
}

const CANCELLED: SessionFailure = { ok: false, code: 'CANCELLED', detail: 'the call was cancelled or the process is shutting down' };

function isJoinFailure(value: unknown): value is SignalingJoinFailure {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string';
}

export function createRoom(deps: RoomSessionDeps, params: RoomParams): Room {
  const { now, timers, log, inbox } = deps;
  const { name, sid } = params;
  const roomRef = refOf(params.roomId);
  const meta: RecordsMeta = {
    server_key: params.server.serverKey,
    room_id: params.roomId,
    name,
    sid,
    package_version: deps.app.version,
  };

  let stage: 'new' | 'entering' | 'in' | 'closing' | 'closed' = 'new';
  let parts: Parts | null = null;
  let entering: Entering | null = null;
  let cancelled = false;
  /** join 의 답을 기다리는 중이다. 취소하려면 소켓을 닫아야 그 대기가 끝난다. */
  let joinPending = false;
  /** 서버에 등록됐다. 정리할 때 leave 를 보낸다. */
  let registered = false;
  /** 입장 절차가 정리까지 끝났다. 종료가 예산 안에서 이것을 기다린다. */
  let entered: Promise<unknown> = Promise.resolve();
  let closing: Promise<unknown> | null = null;
  let signaling: SignalingStateChange = { state: 'connected', reason: null };
  let blockedNotified = false;
  let conflictNotified = false;
  let lastListeningWrite = Number.NEGATIVE_INFINITY;
  let listeningTimer: TimerHandle | null = null;
  const subscriptions: Unsubscribe[] = [];

  const active = (): boolean => stage === 'entering' || stage === 'in';

  // ── 조회 ──────────────────────────────────────────────────────────────────

  const ownPresence = (view: ReplicaView): PresenceView | undefined =>
    view.presences.find((presence) => presence.peer === name);

  /** 자신을 뺀 참가자. presence 가 있는 이름, 링크가 있거나 시도 중인 피어, 서버가 준 목록의 합집합이다. */
  const participants = (p: Parts, view: ReplicaView): ParticipantView[] => {
    const attempting = new Set(p.mesh.links().map((link) => link.peer));
    const names = new Set<string>([...view.presences.map((presence) => presence.peer), ...attempting, ...p.keeper.members()]);
    names.delete(name);
    return [...names].sort().map((peer) => {
      const synced = p.p2p.link(peer)?.synced === true;
      const facts = p.keeper.facts(peer, attempting.has(peer));
      return participantView(
        peer,
        view.presences.find((presence) => presence.peer === peer),
        { ...facts, link: synced ? 'open' : attempting.has(peer) ? 'connecting' : 'none' },
      );
    });
  };

  /** 기록을 보낸 링크의 참가자와, 방에 있지만(서버 목록) 나와 링크가 없는 참가자. */
  const reachOf = (p: Parts, sentTo: readonly string[]): Reach => ({
    sent_to: [...sentTo].sort(),
    not_connected: p.keeper.members().filter((peer) => !sentTo.includes(peer)).sort(),
  });

  const syncedPeers = (p: Parts): string[] =>
    p.p2p
      .links()
      .filter((link) => link.synced)
      .map((link) => link.peer);

  // ── 로컬 쓰기 ─────────────────────────────────────────────────────────────

  /** 기한에 닿았다. 먼저 닿은 쪽이 stop{time_limit} 을 쓴다. 이미 중단됐으면 기록이 생기지 않는다. */
  const writeTimeLimitStop = (): void => {
    if (parts === null || !active()) return;
    const written = parts.p2p.applyLocal({ type: 'stop_test', reason: 'time_limit', detail: '' });
    if (!written.result.ok) {
      log.event('warn', 'room-session', 'test.stopped', { outcome: 'failed', reason: 'time_limit', error_code: written.result.code });
      return;
    }
    if (written.result.records.length === 0) return;
    const reach = reachOf(parts, written.sentTo);
    log.event('info', 'room-session', 'test.stopped', {
      test_id: parts.replica.view(now()).test?.test_id,
      reason: 'time_limit',
      by: name,
      sent_to: reach.sent_to.length,
      not_connected: reach.not_connected.length,
    });
  };

  const writePresence = (p: Parts, patch: PresencePatch): void => {
    const written = p.p2p.applyLocal({ type: 'set_presence', patch });
    if (!written.result.ok) {
      log.event('warn', 'room-session', 'presence.write_failed', { error_code: written.result.code });
    }
  };

  /** listening 변화로 presence 를 다시 쓴다. 최소 간격 안의 변화는 마지막 값만 쓴다. */
  const writeListening = (): void => {
    if (parts === null || stage !== 'in') return;
    const value = inbox.listening();
    if (ownPresence(parts.replica.view(now()))?.listening === value) return;
    lastListeningWrite = now();
    writePresence(parts, { listening: value });
  };

  const onListeningChanged = (): void => {
    if (stage !== 'in' || listeningTimer !== null) return;
    const wait = lastListeningWrite + deps.limits.PRESENCE_MIN_INTERVAL_MS - now();
    if (wait <= 0) {
      writeListening();
      return;
    }
    listeningTimer = timers.setTimeout(() => {
      listeningTimer = null;
      writeListening();
    }, wait);
  };

  // ── 입장 판정 ─────────────────────────────────────────────────────────────

  const settleEntering = (): void => {
    const pending = entering;
    if (pending === null || parts === null) return;
    if (pending.deadline !== null) timers.clearTimeout(pending.deadline);
    pending.deadline = null;
    entering = null;
    if (pending.failed.size > 0) {
      const failed = [...pending.failed.values()];
      // 버전이 유일한 원인일 때만 따로 돌려준다. 다른 실패가 섞였으면 갱신해도 들어올 수 없다.
      if (failed.every((peer) => peer.stage === 'session' && peer.reason === 'version')) {
        pending.settle({
          kind: 'failed',
          failure: {
            ok: false,
            code: 'PEER_VERSION_MISMATCH',
            details: { peers: failed.map((peer) => ({ name: peer.name, theirs: peer.theirs })), mine: LIMITS.P2P_VERSION },
            detail: 'an existing participant uses a different P2P version',
          },
        });
        return;
      }
      pending.settle({
        kind: 'failed',
        failure: {
          ok: false,
          code: 'DIRECT_CONNECT_FAILED',
          details: {
            timeout_ms: LIMITS.JOIN_MESH_TIMEOUT_MS,
            peers: failed.map(({ theirs: _theirs, ...peer }) => peer as FailedPeer),
          },
          detail: 'could not connect and sync with every existing participant',
        },
      });
      return;
    }
    const linked = parts.mesh.links().some((link) => link.state === 'open');
    if (params.mode === 'join' && pending.required.size === 0 && !linked) {
      // 필수 목록이 모두 빠졌고 열린 링크도 없다. 아무도 없는 방에 들어간 것이다.
      pending.settle({
        kind: 'failed',
        failure: {
          ok: false,
          code: 'SIGNALING_ERROR',
          details: { server_code: 'ROOM_NOT_FOUND' },
          detail: 'every listed participant had already left the room',
        },
      });
      return;
    }
    pending.settle({ kind: 'entered' });
  };

  /** 필수 피어가 모두 정해졌으면(동기화, 실패, 빠짐) 입장을 판정한다. 기한 전에는 남은 피어를 기다린다. */
  const checkEntering = (): void => {
    if (entering === null || entering.expiring || parts === null) return;
    for (const peer of entering.required) {
      if (!entering.failed.has(peer) && parts.p2p.link(peer)?.synced !== true) return;
    }
    settleEntering();
  };

  const sessionFailure = (peer: string, reason: SessionFailureReason | 'sync_timeout', theirs: number | null): FailedEntry =>
    ({ name: peer, stage: 'session', reason, ice_state: null, candidates: null, resends: null, theirs }) as FailedEntry;

  const onJoinDeadline = (): void => {
    const pending = entering;
    if (pending === null || parts === null) return;
    pending.deadline = null;
    pending.expiring = true;
    const undecided = (peer: string): boolean =>
      pending.required.has(peer) && !pending.failed.has(peer) && parts?.p2p.link(peer)?.synced !== true;
    const attempting = new Set(
      parts.mesh
        .links()
        .filter((link) => link.state === 'connecting')
        .map((link) => link.peer),
    );
    for (const peer of [...pending.required]) {
      // 아직 시도 중이면 그 자리에서 끝낸다. mesh 가 이 호출 안에서 단계와 사유를 알린다.
      if (undecided(peer) && attempting.has(peer)) parts.mesh.expireAttempt(peer);
    }
    for (const peer of [...pending.required]) {
      // 채널은 열렸지만 P2P 절차가 끝나지 않았다.
      if (undecided(peer)) {
        const greeted = parts.p2p.link(peer)?.helloReceived === true || pending.greeted.has(peer);
        pending.failed.set(peer, sessionFailure(peer, greeted ? 'sync_timeout' : 'hello_timeout', null));
      }
    }
    pending.expiring = false;
    settleEntering();
  };

  // ── mesh 사건 ─────────────────────────────────────────────────────────────

  const onAttemptFailed = (p: Parts, failure: AttemptFailed): void => {
    const verdict = p.keeper.attemptFailed(failure);
    if (entering !== null) {
      if (failure.stage === 'signaling' && failure.reason === 'peer_gone') {
        entering.required.delete(failure.peer);
      } else if (entering.required.has(failure.peer) && !entering.failed.has(failure.peer)) {
        // 그 밖의 실패는 모두 싣는다. RELAY_NOT_ALLOWED 로 끝난 ice / failed 도 같다.
        entering.failed.set(failure.peer, {
          name: failure.peer,
          stage: failure.stage,
          reason: failure.reason,
          ice_state: failure.diag.ice_state,
          candidates: {
            local: { host: failure.diag.local.host, srflx: failure.diag.local.srflx },
            remote: { host: failure.diag.remote.host, srflx: failure.diag.remote.srflx },
          },
          resends: failure.diag.resends,
          theirs: null,
        } as FailedEntry);
        // 입장은 실패로 정해졌다. 남은 피어의 결과만 기다리고 새로 접촉하지 않는다.
        p.keeper.pause();
      }
      checkEntering();
      return;
    }
    if (verdict.unreachable !== null) p.events.peerChanged(failure.peer, 'unreachable', verdict.unreachable, true);
  };

  const onLinkClosed = (p: Parts, peer: string, reason: string): void => {
    const last = p.p2p.linkClosed(peer);
    p.chat.peerClosed(peer);
    if (last === null) return;
    if (entering !== null && last.helloReceived) entering.greeted.add(peer);
    const byBye = reason === 'bye_leave' || reason === 'bye_shutdown';
    // mesh 가 스스로 닫은 링크만 바로 다시 접촉한다. 그 밖(hello 불일치, 프로토콜 오류, 버전)은 다음 목록 갱신 때다.
    const quickRetry = reason === 'ping_timeout' || reason === 'failed' || reason === 'closed' || reason === 'replaced';
    p.keeper.linkClosed(peer, last.synced, quickRetry);
    if (!byBye) p.events.peerChanged(peer, 'disconnected', reason, last.synced);
    checkEntering();
  };

  const wire = (p: Parts): void => {
    subscriptions.push(
      p.mesh.on('link-open', (link) => {
        if (!active()) return;
        p.keeper.linkOpened(link.peer);
        p.p2p.linkOpened(link);
      }),
      p.mesh.on('link-closed', (link) => {
        if (active()) onLinkClosed(p, link.peer, link.reason);
      }),
      p.mesh.on('attempt-failed', (failure) => {
        if (active()) onAttemptFailed(p, failure);
      }),
      p.mesh.on('frame', (frame) => {
        if (active()) p.p2p.frame(frame.peer, frame.text);
      }),
      p.mesh.on('peer-ping', (ping) => {
        if (active()) p.p2p.ping(ping.peer, ping.sc, ping.sf);
      }),
      p.client.on('members', (update) => {
        if (!active()) return;
        p.keeper.setMembers(update.members, update.requestedAt);
        p.keeper.reconcile();
      }),
      p.client.on('state', (change) => {
        signaling = change;
        if (stage !== 'in') return;
        if (change.state === 'connected') {
          blockedNotified = false;
          conflictNotified = false;
          return;
        }
        if (change.state === 'detached') {
          p.events.system(
            'signaling_detached',
            'Reconnecting to the signaling server has stopped. Open links and chat keep working. To recover, call leave_room, update Agent Chat on this PC, and join again.',
            { reason: change.reason },
          );
        } else if (change.reason !== null && !blockedNotified) {
          blockedNotified = true;
          p.events.system('signaling_blocked', 'The signaling server is rejecting the reconnect. Still retrying. Open links and chat keep working.', {
            reason: change.reason,
          });
        }
        if (change.reason === 'NAME_IN_USE' && !conflictNotified) {
          conflictNotified = true;
          p.events.system('name_conflict', 'Another session with the same name is registered on the signaling server.', {});
        }
      }),
      inbox.on('listening-changed', () => onListeningChanged()),
      inbox.on('mode-changed', (change) => {
        if (active()) p.events.record({ kind: 'mode', from: change.from, to: change.to, cause: change.cause });
      }),
    );
  };

  /** 하위 모듈을 만들어 잇는다. mesh 를 만들지 못하면 사유를 돌려준다. join 을 보내기 전에 끝난다. */
  const assemble = async (): Promise<Parts | SessionFailure> => {
    const replica = deps.createReplica({ self: { peer: name, sid }, selfNames: [...params.selfNames] });
    const events = createEventSink({ self: name, inbox, replica, now, timers, log, onDeadline: writeTimeLimitStop });
    const client = deps.createSignalingClient({ url: params.server.url, now, timers, log, nextSeq: params.nextSeq });
    const gated = await createGatedMesh({
      client,
      createMesh: deps.createMesh,
      mesh: {
        self: { peer: name, sid },
        iceServers: params.iceServers,
        pingInfo: () => ({ sc: replica.snapshot().length, sf: replica.fingerprint() }),
        now,
        timers,
        log,
      },
    });
    if (!gated.result.ok) {
      gated.gate.discard();
      client.close();
      events.abandon();
      return { ok: false, code: 'NATIVE_LOAD_FAILED', detail: gated.result.detail };
    }
    const mesh = gated.result.mesh;
    const chat = createChatDelivery({
      sid,
      sendFrame: (peer, text) => mesh.send(peer, text),
      now,
      timers,
      sentBufferSize: deps.limits.SENT_BUFFER_SIZE,
    });
    let keeper: MeshKeeper | null = null;
    const p2p: P2PSession = createP2PSession({
      self: { peer: name, sid },
      app: deps.app,
      mesh,
      replica,
      events,
      now,
      timers,
      log,
      hooks: {
        synced(peer) {
          const { reconnected } = keeper?.linkSynced(peer) ?? { reconnected: false };
          if (reconnected) events.peerChanged(peer, 'reconnected', null, true);
          checkEntering();
        },
        failed(peer, reason, theirs) {
          const link = p2p.link(peer);
          const first = reason === 'version' && link !== null && keeper !== null && keeper.versionMismatch(peer, link.sid);
          if (entering !== null) {
            if (entering.required.has(peer) && !entering.failed.has(peer)) {
              entering.failed.set(peer, sessionFailure(peer, reason, theirs));
              keeper?.pause();
            }
            return;
          }
          if (first) events.peerChanged(peer, 'unreachable', 'version', true);
        },
        bye(peer, peerSid, reason) {
          if (reason === 'protocol_error') return;
          keeper?.peerLeft(peer, peerSid);
          if (entering !== null) {
            entering.required.delete(peer);
            entering.failed.delete(peer);
          }
          // presence{left} 가 먼저 와서 이미 알렸으면 되풀이하지 않는다. presence 를 쓴 적 없는 피어(입장에 실패한 참가자)는 알리지 않는다.
          const presence = replica.view(now()).presences.find((candidate) => candidate.peer === peer);
          events.peerChanged(peer, 'left', reason, presence !== undefined && presence.status !== 'left');
        },
        chat(peer, frame) {
          const verdict = chat.accept(peer, frame, name);
          if (verdict.kind === 'rate_exceeded' || verdict.kind === 'misaddressed') {
            p2p.countBadFrame(peer, verdict.kind);
            return;
          }
          if (verdict.kind === 'new') {
            // ack 의 뜻: 형식을 검증했고, 중복을 걸렀고, 기록 파일에 쓰기를 요청했고, 수신함에 넣었다.
            events.chatReceived({ id: frame.id, from: peer, to: verdict.to, text: frame.text, wall: frame.wall });
          }
          p2p.ack(peer, frame.id);
          log.event('info', 'room-session', 'chat.received', { msg_id: frame.id, peer, dup: verdict.kind === 'duplicate' });
        },
        ack: (peer, id) => chat.ack(peer, id),
      },
    });
    keeper = createMeshKeeper({
      self: name,
      mesh,
      linkOpenedAt: (peer) => p2p.link(peer)?.openedAt ?? null,
      now,
      timers,
    });
    return { client, gate: gated.gate, mesh, replica, events, p2p, chat, keeper };
  };

  // ── 정리 ──────────────────────────────────────────────────────────────────

  const detach = (p: Parts): void => {
    for (const off of subscriptions.splice(0)) off();
    if (listeningTimer !== null) timers.clearTimeout(listeningTimer);
    listeningTimer = null;
    if (entering !== null && entering.deadline !== null) timers.clearTimeout(entering.deadline);
    p.keeper.stop();
  };

  /** 방을 나간다. bye 를 보내고, 서버 등록을 지우고, 링크를 닫고, 기록 파일을 닫는다. */
  const teardown = async (p: Parts, reason: string, bye: 'leave' | null): Promise<void> => {
    stage = 'closing';
    detach(p);
    if (bye !== null) p.p2p.byeAll(bye);
    // 보낸 글의 ack 는 더 오지 않는다. 기다리던 호출을 결과 불명으로 끝낸다.
    for (const link of p.p2p.links()) p.chat.peerClosed(link.peer);
    p.gate.discard();
    // 등록 전에 실패했으면 서버에 지울 것이 없다. 소켓만 닫는다.
    if (registered) await p.client.leave();
    else p.client.close();
    await p.mesh.shutdown();
    p.p2p.close();
    await p.events.close(reason);
    stage = 'closed';
  };

  const failEntering = async (p: Parts, failure: SessionFailure, reason: string): Promise<SessionFailure> => {
    await teardown(p, reason, 'leave');
    // 입장 도중 받은 글과 테스트 요청이 다음 방의 사건으로 나가지 않게 한다.
    inbox.discardAll();
    return failure;
  };

  const logJoinEnd = (startedAt: number, failure: SessionFailure | null): void => {
    const common = { room_ref: roomRef, sid, duration_ms: now() - startedAt };
    if (failure === null) {
      log.event('info', 'room-session', 'join.end', { ...common, outcome: 'ok', mode: params.mode });
      return;
    }
    if (failure.code === 'DIRECT_CONNECT_FAILED') {
      for (const peer of failure.details.peers) {
        log.event('warn', 'room-session', 'join.end', {
          ...common,
          outcome: 'failed',
          error_code: failure.code,
          peer: peer.name,
          stage: peer.stage,
          reason: peer.reason,
          ice_state: peer.ice_state ?? undefined,
          cand_local_host: peer.candidates?.local.host,
          cand_local_srflx: peer.candidates?.local.srflx,
          cand_remote_host: peer.candidates?.remote.host,
          cand_remote_srflx: peer.candidates?.remote.srflx,
          resends: peer.resends ?? undefined,
        });
      }
      return;
    }
    if (failure.code === 'PEER_VERSION_MISMATCH') {
      for (const peer of failure.details.peers) {
        log.event('warn', 'room-session', 'join.end', {
          ...common,
          outcome: 'failed',
          error_code: failure.code,
          peer: peer.name,
          stage: 'session',
          reason: 'version',
        });
      }
      return;
    }
    log.event(failure.code === 'CANCELLED' ? 'info' : 'warn', 'room-session', 'join.end', {
      ...common,
      outcome: failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
      error_code: failure.code === 'SIGNALING_ERROR' ? failure.details.server_code : failure.code,
      mode: params.mode,
    });
  };

  // ── 입장 ──────────────────────────────────────────────────────────────────

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (stage !== 'entering') return;
    if (entering !== null) {
      const pending = entering;
      if (pending.deadline !== null) timers.clearTimeout(pending.deadline);
      pending.deadline = null;
      entering = null;
      pending.settle({ kind: 'cancelled' });
    } else if (joinPending) {
      // join 의 답을 기다리는 중이면 소켓을 닫아 그 대기를 끝낸다.
      parts?.client.close();
    }
  };

  const enter = async (): Promise<SessionResult<RoomEntered>> => {
    const startedAt = now();
    stage = 'entering';
    const onAbort = (): void => cancel();
    params.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (failure: SessionFailure): SessionFailure => {
      params.signal?.removeEventListener('abort', onAbort);
      logJoinEnd(startedAt, failure);
      return failure;
    };
    try {
      if (params.signal?.aborted === true) cancelled = true;
      const assembled = await assemble();
      if ('ok' in assembled) {
        stage = 'closed';
        inbox.discardAll();
        return finish(assembled);
      }
      const p = assembled;
      parts = p;
      wire(p);
      if (cancelled) return finish(await failEntering(p, CANCELLED, 'join_cancelled'));

      // mesh 와 시그널 처리기가 붙은 뒤에 join 을 보낸다. joined 보다 먼저 온 offer 를 버리지 않는다.
      let members: Awaited<ReturnType<SignalingClient['join']>>;
      joinPending = true;
      try {
        members = await p.client.join({ room: params.roomId, peer: name, sid, key: params.key, mode: params.mode });
        joinPending = false;
        registered = true;
      } catch (thrown) {
        joinPending = false;
        const failure = isJoinFailure(thrown) ? thrown : ({ code: 'SERVER_UNREACHABLE' } as const);
        let mapped: SessionFailure;
        if (cancelled || failure.code === 'CLOSED') mapped = CANCELLED;
        else if (failure.code === 'SERVER_UNREACHABLE') {
          mapped = { ok: false, code: 'SERVER_UNREACHABLE', detail: 'could not connect to or register with the signaling server in time' };
        } else {
          mapped = {
            ok: false,
            code: 'SIGNALING_ERROR',
            details:
              failure.retryAfterMs === undefined
                ? { server_code: failure.code }
                : { server_code: failure.code, retry_after_ms: failure.retryAfterMs },
            detail: 'the signaling server rejected the request',
          };
        }
        return finish(await failEntering(p, mapped, 'join_failed'));
      }
      const joinedAt = now();
      if (cancelled) return finish(await failEntering(p, CANCELLED, 'join_cancelled'));

      // 링크가 열리기 전에 기록 파일을 연다. 그동안 mesh 가 내보내려는 시그널은 계속 들고 있다.
      const opened = await deps.openTranscript({ dir: deps.config.home, meta, now, log });
      p.events.attachTranscript(opened.ok ? opened.transcript : null);
      if (cancelled) return finish(await failEntering(p, CANCELLED, 'join_cancelled'));

      p.keeper.setMembers(members.members, members.requestedAt);
      const outcome = await new Promise<EnterOutcome>((settle) => {
        entering = {
          required: new Set(members.members.map((member) => member.peer).filter((peer) => peer !== name)),
          failed: new Map(),
          greeted: new Set(),
          deadline: null,
          expiring: false,
          settle,
        };
        // 기한은 joined 를 받은 때부터 잰다.
        entering.deadline = timers.setTimeout(onJoinDeadline, Math.max(0, LIMITS.JOIN_MESH_TIMEOUT_MS - (now() - joinedAt)));
        p.gate.open();
        p.keeper.reconcile();
        checkEntering();
      });
      if (outcome.kind === 'cancelled' || cancelled) return finish(await failEntering(p, CANCELLED, 'join_cancelled'));
      if (outcome.kind === 'failed') return finish(await failEntering(p, outcome.failure, 'join_failed'));

      stage = 'in';
      p.events.enableStateEvents();
      // 첫 동기화가 끝난 뒤에 쓴다. 스냅샷에 든 자기 옛 presence 보다 lc 가 커야 이긴다.
      // 재입장이면 옛 역할과 도구를 이어받는다. 지우면 다른 참가자의 역할 현황에서도 사라지고, 문맥을 잃은 에이전트가
      // 자기 역할을 알 길이 없다(PRD "재입장한 에이전트에는 … 역할 현황을 전달한다", 검토 1차 PRODUCT-R1-01).
      // 상태는 joined 로 둔다(다시 준비를 알려야 한다). 메모는 옛 진행 상황이라 비운다.
      const previous = ownPresence(p.replica.view(now()));
      writePresence(p, {
        client: deps.config.client,
        tools: previous === undefined ? [] : [...previous.tools],
        role: previous?.role ?? null,
        status: 'joined',
        listening: inbox.listening(),
        note: null,
      });
      params.signal?.removeEventListener('abort', onAbort);
      logJoinEnd(startedAt, null);
      const at = now();
      const view = p.replica.view(at);
      const mine = ownPresence(view);
      return {
        ok: true,
        room_id: params.roomId,
        server: params.server.serverKey,
        name,
        participants:
          params.mode === 'create' ? [selfParticipant(name, mine, deps.config.client)] : participants(p, view),
        test: params.mode === 'create' ? null : testStatus(view.test, view.scenarios, at),
        you: {
          role: mine?.role ?? null,
          tools: mine === undefined ? [] : [...mine.tools],
          status: mine?.status ?? 'joined',
          note: mine?.note ?? null,
          rejoined: previous !== undefined,
        },
      };
    } catch {
      // 하위 모듈이 약속과 달리 던졌다. 남기지 않고 정리한다.
      log.event('error', 'room-session', 'join.end', { room_ref: roomRef, sid, outcome: 'failed', error_code: 'INTERNAL' });
      params.signal?.removeEventListener('abort', onAbort);
      if (parts !== null && stage !== 'closed') {
        try {
          await teardown(parts, 'join_failed', null);
        } catch {
          stage = 'closed';
        }
      }
      stage = 'closed';
      inbox.discardAll();
      return { ok: false, code: 'SERVER_UNREACHABLE', detail: 'an internal error interrupted the join' };
    }
  };

  // ── 방 동작 ───────────────────────────────────────────────────────────────

  const reject = (p: Parts, tool: string, failure: { readonly code: SessionFailure['code']; readonly detail: string }): SessionFailure => {
    // INVALID_ARGUMENT 는 규칙 거절이 아니다. 기록 파일의 rule 줄에 남기지 않는다.
    if (failure.code !== 'INVALID_ARGUMENT') {
      p.events.ruleRejected(tool, failure.code, p.replica.view(now()).test?.test_id ?? null);
    }
    return { ok: false, code: failure.code, detail: failure.detail } as SessionFailure;
  };

  const command = (input: SessionCommand): SessionResult<CommandOutputs[keyof CommandOutputs]> => {
    const p = parts;
    if (p === null || stage !== 'in') return { ok: false, code: 'NOT_IN_ROOM' };
    const missing = (): SessionFailure => ({ ok: false, code: 'INVALID_ARGUMENT', detail: 'the state module did not return the written record' });

    switch (input.type) {
      case 'set_status': {
        const patch: { -readonly [K in keyof PresencePatch]: PresencePatch[K] } = {};
        if (input.status !== undefined) patch.status = input.status;
        if (input.role !== undefined) patch.role = input.role;
        if (input.tools !== undefined) patch.tools = input.tools;
        if (input.note !== undefined) patch.note = input.note;
        const written = p.p2p.applyLocal({ type: 'set_presence', patch });
        if (!written.result.ok) return reject(p, input.type, written.result);
        const mine = ownPresence(p.replica.view(now()));
        if (mine === undefined) return missing();
        return {
          ok: true,
          presence: {
            client: mine.client,
            tools: [...mine.tools],
            role: mine.role,
            status: mine.status,
            listening: mine.listening,
            note: mine.note,
          },
        };
      }
      case 'stop_test': {
        const written = p.p2p.applyLocal({ type: 'stop_test', reason: 'user', detail: input.reason });
        if (!written.result.ok) return reject(p, input.type, written.result);
        const test = p.replica.view(now()).test;
        if (test === null) return missing();
        // 이미 중단돼 있었으면 새 기록이 없다. 그때는 지금 이어진 참가자와 그렇지 않은 참가자를 싣는다.
        const reach = reachOf(p, written.result.records.length > 0 ? written.sentTo : syncedPeers(p));
        if (written.result.records.length > 0) {
          log.event('info', 'room-session', 'test.stopped', {
            test_id: test.test_id,
            reason: 'user',
            by: name,
            sent_to: reach.sent_to.length,
            not_connected: reach.not_connected.length,
          });
        }
        return { ok: true, stopped: true, test_id: test.test_id, ...reach };
      }
      case 'start_test': {
        const written = p.p2p.applyLocal(input);
        if (!written.result.ok) return reject(p, input.type, written.result);
        const record = written.result.records.find((candidate) => candidate.kind === 'test');
        if (record === undefined || record.kind !== 'test') return missing();
        return {
          ok: true,
          test_id: record.body.test_id,
          limits: { max_duration_min: record.body.max_duration_min, max_scenarios: record.body.max_scenarios },
          ...reachOf(p, written.sentTo),
        };
      }
      case 'start_scenario': {
        const written = p.p2p.applyLocal(input);
        if (!written.result.ok) {
          const failure = reject(p, input.type, written.result);
          // 기한을 넘긴 것을 본 참가자가 중단을 쓴다. 이미 중단돼 있으면 기록이 생기지 않는다.
          if (written.result.code === 'TIME_LIMIT_REACHED') writeTimeLimitStop();
          return failure;
        }
        const record = written.result.records.find((candidate) => candidate.kind === 'scenario');
        const view = p.replica.view(now());
        const scenario = record?.kind === 'scenario' ? view.scenarios.find((candidate) => candidate.scenario_id === record.rid) : undefined;
        if (scenario === undefined || view.test === null) return missing();
        return {
          ok: true,
          scenario_id: scenario.scenario_id,
          index: scenario.index,
          remaining: Math.max(0, view.test.max_scenarios - view.test.scenarios_used),
        };
      }
      case 'record_claim': {
        const written = p.p2p.applyLocal(input);
        if (!written.result.ok) return reject(p, input.type, written.result);
        const record = written.result.records.find((candidate) => candidate.kind === 'claim');
        const claim = record?.kind === 'claim' ? p.replica.view(now()).claims.find((candidate) => candidate.claim_id === record.rid) : undefined;
        if (claim === undefined) return missing();
        return { ok: true, claim_id: claim.claim_id, status: 'unverified', late: claim.late };
      }
      case 'record_verification': {
        const written = p.p2p.applyLocal(input);
        if (!written.result.ok) return reject(p, input.type, written.result);
        const record = written.result.records.find((candidate) => candidate.kind === 'verification');
        const claim = p.replica.view(now()).claims.find((candidate) => candidate.claim_id === input.claim_id);
        if (record?.kind !== 'verification' || claim === undefined) return missing();
        return { ok: true, verification_id: record.rid, claim_status: claim.status };
      }
    }
  };

  const warningsOf = (p: Parts, others: readonly ParticipantView[]): SessionWarning[] => {
    const warnings: SessionWarning[] = [];
    for (const other of others) {
      if (other.shown_as === 'unreachable') warnings.push({ code: 'unreachable', peer: other.name });
    }
    if (signaling.state !== 'connected') {
      if (signaling.reason === 'NAME_IN_USE') warnings.push({ code: 'name_conflict' });
      warnings.push({ code: 'signaling', state: signaling.state, reason: signaling.reason });
    }
    for (const link of p.p2p.links()) {
      if (link.diverged) warnings.push({ code: 'state_diverged', peer: link.peer });
      if (link.clockSkew) warnings.push({ code: 'clock_skew', peer: link.peer });
    }
    if (p.events.recordFailed()) warnings.push({ code: 'record_failed' });
    return warnings;
  };

  const requireParts = (): Parts => {
    if (parts === null) throw new Error('room is not assembled');
    return parts;
  };

  return {
    enter() {
      const running = enter();
      entered = running;
      return running;
    },

    async leave() {
      const p = requireParts();
      const running = (async (): Promise<RoomLeft> => {
        // presence{left} 를 변경으로 보낸 뒤 bye{leave} 를 보낸다.
        writePresence(p, { status: 'left' });
        const path = p.events.transcriptPath();
        await teardown(p, 'leave', 'leave');
        return { left: true, transcript_path: path, undelivered_events: inbox.discardAll() };
      })();
      closing = running;
      return running;
    },

    async shutdown(budgetMs) {
      let expired = false;
      let timer: TimerHandle | null = null;
      const budget = new Promise<void>((resolve) => {
        timer = timers.setTimeout(() => {
          expired = true;
          resolve();
        }, Math.max(0, budgetMs));
      });
      const within = async (step: () => Promise<unknown>): Promise<void> => {
        if (expired) return;
        try {
          await Promise.race([step(), budget]);
        } catch {
          // 종료는 실패를 알릴 곳이 없다. 다음 단계로 간다.
        }
      };
      try {
        if (stage === 'entering') {
          // 입장 중이면 취소한다. 정리(bye, leave, 링크 닫기, 수신함 비우기)는 입장 절차가 한다.
          cancel();
          await within(() => entered);
        } else if (stage === 'closing') {
          // 퇴장이나 입장 실패의 정리가 진행 중이다. 예산 안에서 그것이 끝나기를 기다린다.
          const running = closing ?? entered;
          await within(() => running);
        } else if (stage === 'in' && parts !== null) {
          const p = parts;
          stage = 'closing';
          detach(p);
          p.chat.close();
          writePresenceQuietly(p);
          p.p2p.byeAll('shutdown');
          p.gate.discard();
          await within(() => p.client.leave());
          await within(() => p.mesh.shutdown());
          p.p2p.close();
          await within(() => p.events.close('shutdown'));
          if (expired) p.events.abandon();
          stage = 'closed';
        }
      } finally {
        if (timer !== null) timers.clearTimeout(timer);
        parts?.chat.close();
      }
    },

    async sendChat(args) {
      const p = parts;
      if (p === null || stage !== 'in') return { ok: false, code: 'NOT_IN_ROOM' };
      const open = syncedPeers(p);
      const others = participants(p, p.replica.view(now()));
      const outcome = await p.chat.send(args, {
        open,
        absent: p.keeper.members().filter((peer) => !open.includes(peer)),
        known: others.map((other) => other.name),
      });
      if (outcome.result.ok && outcome.sent !== null) {
        p.events.record({
          kind: 'chat_out',
          id: outcome.result.message_id,
          to: outcome.sent.to,
          text: outcome.sent.text,
          delivered: outcome.result.delivered,
          undelivered: outcome.result.undelivered,
        });
        log.event('info', 'room-session', 'chat.sent', {
          msg_id: outcome.result.message_id,
          targets: outcome.sent.targets,
          delivered: outcome.result.delivered.length,
          undelivered: outcome.result.undelivered.length,
          bytes: outcome.sent.bytes,
          // ack 가 오지 않은 것은 실패 확정이 아니라 결과 불명이다.
          outcome: outcome.result.undelivered.some((entry) => entry.reason === 'ack_timeout') ? 'unknown' : 'ok',
        });
      }
      return outcome.result;
    },

    command,

    status() {
      const p = requireParts();
      const at = now();
      const view = p.replica.view(at);
      const others = participants(p, view);
      return {
        room: {
          room_id: params.roomId,
          server: params.server.serverKey,
          name,
          signaling: signaling.state,
          net: { stun: params.iceServers.length > 0, srflx_seen: p.mesh.netInfo().srflx_seen },
        },
        participants: others,
        test: testStatus(view.test, view.scenarios, at),
        claims: claimCounts(view.claims, params.selfNames),
        warnings: warningsOf(p, others),
      };
    },

    notice() {
      const p = requireParts();
      const view = p.replica.view(now());
      const unreachable = participants(p, view)
        .filter((other) => other.shown_as === 'unreachable')
        .map((other) => other.name);
      return {
        ...(view.test?.stopped != null ? { test_stopped: { reason: view.test.stopped.reason, by: view.test.stopped.by } } : {}),
        ...(signaling.state !== 'connected'
          ? { signaling: { state: signaling.state, ...(signaling.reason !== null ? { reason: signaling.reason } : {}) } }
          : {}),
        ...(unreachable.length > 0 ? { unreachable } : {}),
        ...(p.events.recordFailed() ? { record_failed: true as const } : {}),
      };
    },

    async writeReport() {
      const p = parts;
      if (p === null || stage !== 'in') return { ok: false, code: 'NOT_IN_ROOM' };
      const view = p.replica.view(now());
      if (view.test === null) {
        p.events.ruleRejected('write_report', 'NO_ACTIVE_TEST', null);
        return { ok: false, code: 'NO_ACTIVE_TEST', detail: 'no test has been started in this room' };
      }
      const input = reportInput(view, view.test, p.replica.fingerprint(), name, participants(p, view));
      const written = await deps.writeReport({ dir: deps.config.home, input, meta, now, log });
      if (!written.ok) return { ok: false, code: 'RECORD_FAILED', detail: written.detail };
      return { ok: true, path: written.path, summary: written.summary };
    },
  };

  /** 종료 때의 presence{left}. 실패해도 종료를 멈추지 않는다. */
  function writePresenceQuietly(p: Parts): void {
    try {
      writePresence(p, { status: 'left' });
    } catch {
      // 종료 중이다. 남은 단계를 계속한다.
    }
  }
}
