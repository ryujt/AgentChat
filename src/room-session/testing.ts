// room-session 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다(V-U8 의 import-testing).
// 하위 모듈 다섯 개(signaling-client, mesh, shared-state, inbox, records)의 계약에 맞춘 가짜와 가짜 시계를 둔다.
// 가짜는 계약의 모양만 따른다. 연결 규칙이나 병합 규칙을 검증하는 용도가 아니다(그것은 각 모듈의 시험이 한다).

import assert from 'node:assert/strict';
import type { LogFields, LogLevel, LogModule, LogPort } from '../diagnostics/log-port.js';
import type { DeliveryMode, InboxEvent, InboxEvents, ModeChanged } from '../inbox/contract.js';
import type {
  AttemptFailed,
  CreateMesh,
  Mesh,
  MeshDeps,
  MeshEvents,
  MeshLink,
  MeshSendResult,
} from '../mesh/contract.js';
import {
  LIMITS,
  makeEntryId,
  parseP2PFrame,
  presenceKey,
  stateFingerprint,
  utf8ByteLength,
} from '../protocol/index.js';
import type {
  ClaimRecord,
  LinkFailure,
  Member,
  Now,
  P2PFrame,
  PresenceRecord,
  ScenarioRecord,
  ServerSignalMessage,
  SignalPayload,
  StateRecord,
  StopRecord,
  TestRecord,
  Timers,
  Unsubscribe,
  VerificationRecord,
} from '../protocol/index.js';
import type {
  OpenTranscript,
  RecordsMeta,
  ReportInput,
  TranscriptEntry,
  WriteReport,
} from '../records/contract.js';
import type {
  ApplyLocalResult,
  ClaimView,
  CreateReplica,
  MergeRemoteResult,
  PresenceBody,
  Replica,
  ReplicaDeps,
  ReplicaView,
  ScenarioView,
  StateChange,
  StateCommand,
  StopView,
  TestView,
} from '../shared-state/contract.js';
import type {
  CreateSignalingClient,
  MembersUpdate,
  RelayError,
  SignalingBlockReason,
  SignalingClient,
  SignalingClientEvents,
  SignalingJoinFailure,
  SignalingJoinRequest,
  SignalingJoined,
  SignalingState,
} from '../signaling-client/contract.js';
import type { RoomSession, RoomSessionConfig, RoomSessionDeps, SessionInbox } from './contract.js';
import { DEFAULT_ROOM_SESSION_LIMITS, createRoomSession } from './session.js';

/** 시험의 기준 시각(2026-11 무렵의 epoch ms). */
export const T0 = 1_794_700_000_000;
export const SEC = 1_000;
export const MIN = 60_000;

/** 밀린 마이크로태스크를 모두 돌린다. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── 가짜 시계 ───────────────────────────────────────────────────────────────

/** 걸린 시각에 맞춰 타이머를 부르는 가짜 시계. 타이머 하나를 부를 때마다 settle 로 밀린 일을 끝낸다. */
export class FakeClock {
  private current: number;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; run: () => void }>();
  /** 타이머 하나를 부른 뒤와 움직임이 끝난 뒤에 부른다. 가짜 망이 자기 전달 큐를 비우는 함수로 바꾼다. */
  settle: () => Promise<void> = flushMicrotasks;

  constructor(start: number = T0) {
    this.current = start;
  }

  readonly now: Now = () => this.current;

  readonly timers: Timers = {
    setTimeout: (callback, delayMs) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { at: this.current + Math.max(0, delayMs), run: callback });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') this.pending.delete(handle);
    },
  };

  /** 걸려 있는 타이머 수. */
  get timerCount(): number {
    return this.pending.size;
  }

  /** 걸려 있는 타이머의 남은 시간(짧은 순). */
  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.at - this.current).sort((a, b) => a - b);
  }

  /** 벽시계만 바꾼다(타이머는 부르지 않는다). 시계가 다른 PC 를 흉내 낼 때 쓴다. */
  jump(ms: number): void {
    this.current += ms;
  }

  /** 시간을 ms 만큼 움직인다. 그 사이의 타이머를 걸린 시각 순서로 부른다. */
  async advance(ms: number): Promise<void> {
    const end = this.current + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.pending) {
        if (timer.at <= end && (timer.at < nextAt || (timer.at === nextAt && nextId !== null && id < nextId))) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null) break;
      const timer = this.pending.get(nextId);
      this.pending.delete(nextId);
      if (timer === undefined) continue;
      this.current = Math.max(this.current, timer.at);
      timer.run();
      await this.settle();
    }
    this.current = end;
    await this.settle();
  }
}

// ── 이벤트 ──────────────────────────────────────────────────────────────────

/** Subscribable 의 약속(등록 순서, 동기 호출, 예외 격리, 해지)을 따르는 작은 이벤트 묶음. */
class Emitter<Events extends { [E in keyof Events]: (payload: never) => void }> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();
  /** 리스너가 던진 예외. 격리 때문에 가려진 결함을 시험이 볼 수 있게 모아 둔다. */
  readonly errors: unknown[] = [];

  on<E extends keyof Events>(event: E, listener: Events[E]): Unsubscribe {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  emit<E extends keyof Events>(event: E, ...payload: Parameters<Events[E]>): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as (...args: unknown[]) => void)(...payload);
      } catch (error) {
        this.errors.push(error);
      }
    }
  }

  count(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

// ── 가짜 로그, 수신함, 기록 ─────────────────────────────────────────────────

export interface LoggedEvent {
  readonly level: LogLevel;
  readonly module: LogModule;
  readonly event: string;
  readonly fields: LogFields;
}

export class FakeLog {
  readonly events: LoggedEvent[] = [];
  readonly port: LogPort = {
    event: (level, module, event, fields) => {
      this.events.push({ level, module, event, fields: fields ?? {} });
    },
  };

  named(event: string): LoggedEvent[] {
    return this.events.filter((entry) => entry.event === event);
  }
}

/** room-session 이 쓰는 부분만 가진 수신함. 넣은 사건을 그대로 보관한다. */
export class FakeInbox implements SessionInbox {
  private readonly emitter = new Emitter<InboxEvents>();
  private queue: InboxEvent[] = [];
  private handedOut = 0;
  private listeningValue = false;
  private modeValue: DeliveryMode = 'poll';
  /** discardAll 이 돌려준 값의 이력. */
  readonly discards: number[] = [];
  /** 이 프로세스가 뜬 뒤 넣은 모든 사건(비운 것 포함). */
  readonly pushed: InboxEvent[] = [];

  push(event: InboxEvent): void {
    this.queue.push(event);
    this.pushed.push(event);
  }

  discardAll(): number {
    const unseen = this.queue.length - this.handedOut;
    this.queue = [];
    this.handedOut = 0;
    this.discards.push(unseen);
    return unseen;
  }

  mode(): DeliveryMode {
    return this.modeValue;
  }

  listening(): boolean {
    return this.listeningValue;
  }

  on<E extends keyof InboxEvents>(event: E, listener: InboxEvents[E]): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  /** 대기열에 있는 사건(내준 것 포함). */
  get events(): readonly InboxEvent[] {
    return this.queue;
  }

  /** 아직 내주지 않은 사건을 에이전트에게 내준 것으로 친다. */
  take(): InboxEvent[] {
    const fresh = this.queue.slice(this.handedOut);
    this.handedOut = this.queue.length;
    return fresh;
  }

  setListening(value: boolean): void {
    if (this.listeningValue === value) return;
    this.listeningValue = value;
    this.emitter.emit('listening-changed', value);
  }

  changeMode(change: ModeChanged): void {
    this.modeValue = change.to;
    this.emitter.emit('mode-changed', change);
  }

  listenerCount(event: keyof InboxEvents): number {
    return this.emitter.count(event);
  }

  get listenerErrors(): readonly unknown[] {
    return this.emitter.errors;
  }
}

export interface FakeTranscript {
  readonly path: string;
  readonly meta: RecordsMeta;
  readonly entries: TranscriptEntry[];
  closed: boolean;
}

/** 메모리에만 쓰는 기록 파일과 보고서. */
export class FakeRecords {
  readonly transcripts: FakeTranscript[] = [];
  readonly reports: ReportInput[] = [];
  failOpen = false;
  failAppend = false;
  failReport = false;

  readonly openTranscript: OpenTranscript = async (options) => {
    if (this.failOpen) return { ok: false, code: 'RECORD_FAILED', detail: 'cannot create the directory' };
    const file: FakeTranscript = {
      path: `${options.dir}/rooms/x/${options.meta.room_id}/${options.meta.name}/transcript-${options.meta.sid}.jsonl`,
      meta: options.meta,
      entries: [],
      closed: false,
    };
    this.transcripts.push(file);
    return {
      ok: true,
      transcript: {
        path: file.path,
        append: async (entry) => {
          if (file.closed || this.failAppend) return { ok: false, code: 'RECORD_FAILED', detail: 'write failed' };
          file.entries.push(entry);
          return { ok: true };
        },
        close: async () => {
          file.closed = true;
        },
      },
    };
  };

  readonly writeReport: WriteReport = async (options) => {
    if (this.failReport) return { ok: false, code: 'RECORD_FAILED', detail: 'write failed' };
    this.reports.push(options.input);
    const claims = options.input.scenarios.flatMap((scenario) => scenario.claims);
    const count = (kind: string): number => claims.filter((claim) => claim.classification === kind).length;
    return {
      ok: true,
      path: `${options.dir}/rooms/x/${options.meta.room_id}/${options.meta.name}/report-${options.input.test.test_id}.md`,
      summary: {
        scenarios: options.input.scenarios.length,
        passed: count('passed'),
        failed: count('failed'),
        unverified: count('unverified'),
        late: count('late'),
      },
    };
  };

  /** 가장 최근에 연 기록 파일. */
  get last(): FakeTranscript {
    const file = this.transcripts.at(-1);
    assert.ok(file, '기록 파일을 연 적이 없다');
    return file;
  }
}

// ── 가짜 망: 시그널링 서버, 클라이언트, mesh ────────────────────────────────

export interface FakeLinkEnd {
  readonly sid: string;
  readonly cid: string;
  /** 상대도 이 망의 가짜 mesh 다. 프레임이 그쪽으로 전달된다. */
  readonly paired: boolean;
}

const DEFAULT_DIAG: AttemptFailed['diag'] = {
  ice_state: 'checking',
  pc_state: 'connecting',
  local: { host: 1, srflx: 1 },
  remote: { host: 1, srflx: 0 },
  resends: 4,
  duration_ms: 15_000,
};

export class FakeMesh implements Mesh {
  private readonly emitter = new Emitter<MeshEvents>();
  private readonly open = new Map<string, FakeLinkEnd>();
  private readonly attempts = new Set<string>();
  /** expireAttempt 가 낼 분류. 정하지 않은 피어는 ice / ice_timeout 이다. */
  readonly expireAs = new Map<string, LinkFailure>();
  readonly contacts: string[] = [];
  readonly signals: ServerSignalMessage[] = [];
  readonly relayErrors: RelayError[] = [];
  readonly expired: string[] = [];
  readonly probes: string[] = [];
  readonly alive: string[] = [];
  readonly closed: { peer: string; reason: string }[] = [];
  /** 보낸 프레임 전부. */
  readonly sent: { peer: string; text: string }[] = [];
  resendPendingCalls = 0;
  srflxSeen = false;
  down = false;

  constructor(
    readonly net: FakeNet,
    readonly deps: MeshDeps,
  ) {}

  get name(): string {
    return this.deps.self.peer;
  }

  on<E extends keyof MeshEvents>(event: E, listener: MeshEvents[E]): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  private emit<E extends keyof MeshEvents>(event: E, ...payload: Parameters<MeshEvents[E]>): void {
    if (!this.down) this.emitter.emit(event, ...payload);
  }

  get listenerErrors(): readonly unknown[] {
    return this.emitter.errors;
  }

  // 계약 ---------------------------------------------------------------------

  contact(peer: string): void {
    this.contacts.push(peer);
    if (this.open.has(peer) || this.attempts.has(peer)) return;
    this.attempts.add(peer);
    // 실제 mesh 처럼 주입받은 전송 함수로 첫 시그널을 내보낸다. joined 전 보관을 시험이 볼 수 있다.
    this.deps.sendSignal(peer, { kind: 'offer-request', data: {} });
    this.net.onContact(this, peer);
  }

  handleSignal(signal: ServerSignalMessage): void {
    this.signals.push(signal);
    this.net.onSignal?.(this, signal);
  }

  handleRelayError(error: RelayError): void {
    this.relayErrors.push(error);
  }

  expireAttempt(peer: string): void {
    this.expired.push(peer);
    if (!this.attempts.has(peer)) return;
    this.failAttempt(peer, this.expireAs.get(peer) ?? { stage: 'ice', reason: 'ice_timeout' });
  }

  resendPending(): void {
    this.resendPendingCalls += 1;
  }

  probe(peer: string): void {
    this.probes.push(peer);
  }

  markAlive(peer: string): void {
    this.alive.push(peer);
  }

  send(peer: string, text: string): MeshSendResult {
    const link = this.open.get(peer);
    if (link === undefined) return 'not_open';
    if (utf8ByteLength(text) > LIMITS.P2P_MAX_FRAME_BYTES) return 'too_large';
    this.sent.push({ peer, text });
    if (link.paired) this.net.enqueue(() => this.net.meshOf(peer)?.receive(this.name, text));
    return 'ok';
  }

  closeLink(peer: string, reason: string): void {
    const link = this.open.get(peer);
    if (link === undefined) return;
    this.closed.push({ peer, reason });
    this.open.delete(peer);
    if (link.paired) this.net.enqueue(() => this.net.meshOf(peer)?.dropLink(this.name, 'closed'));
    this.emit('link-closed', { peer, sid: link.sid, reason });
  }

  links(): readonly MeshLink[] {
    return [
      ...[...this.open].map(([peer, link]): MeshLink => ({ peer, sid: link.sid, state: 'open' })),
      ...[...this.attempts].map((peer): MeshLink => ({ peer, sid: null, state: 'connecting' })),
    ];
  }

  netInfo(): { srflx_seen: boolean } {
    return { srflx_seen: this.srflxSeen };
  }

  async shutdown(): Promise<void> {
    if (this.down) return;
    this.down = true;
    for (const [peer, link] of this.open) {
      if (link.paired) this.net.enqueue(() => this.net.meshOf(peer)?.dropLink(this.name, 'closed'));
    }
    this.open.clear();
    this.attempts.clear();
    this.net.forget(this);
  }

  // 시험이 부르는 것 ---------------------------------------------------------

  /** 그 피어와 링크가 열렸다고 알린다. */
  openLink(peer: string, sid: string, options: { cid?: string; paired?: boolean } = {}): void {
    this.attempts.delete(peer);
    this.open.set(peer, { sid, cid: options.cid ?? `${sid}.1`, paired: options.paired ?? false });
    this.emit('link-open', { peer, sid, cid: options.cid ?? `${sid}.1` });
  }

  /** 진행 중인 시도가 실패했다고 알린다. 시도가 없어도 알린다(시험이 순서를 정한다). */
  failAttempt(peer: string, failure: LinkFailure, diag: AttemptFailed['diag'] = DEFAULT_DIAG): void {
    this.attempts.delete(peer);
    this.emit('attempt-failed', { ...failure, peer, diag } as AttemptFailed);
  }

  /** mesh 가 스스로 링크를 닫았다고 알린다(ping_timeout, failed, closed, replaced). */
  dropLink(peer: string, reason: string): void {
    const link = this.open.get(peer);
    if (link === undefined) return;
    this.open.delete(peer);
    this.emit('link-closed', { peer, sid: link.sid, reason });
  }

  /** 열린 링크로 프레임 하나를 받았다고 알린다. */
  receive(peer: string, text: string): void {
    if (this.open.has(peer)) this.emit('frame', { peer, text });
  }

  receivePing(peer: string, sc: number, sf: string): void {
    if (this.open.has(peer)) this.emit('peer-ping', { peer, sc, sf });
  }

  isOpen(peer: string): boolean {
    return this.open.has(peer);
  }

  isAttempting(peer: string): boolean {
    return this.attempts.has(peer);
  }

  /** 그 피어에게 보낸 프레임을 해석해 돌려준다. */
  framesTo(peer: string): P2PFrame[] {
    return this.sent
      .filter((entry) => entry.peer === peer)
      .map((entry) => {
        const parsed = parseP2PFrame(entry.text);
        assert.ok(parsed.ok, `받는 쪽이 거절할 프레임을 보냈다: ${parsed.ok ? '' : parsed.detail}`);
        return parsed.value;
      });
  }
}

export class FakeSignalingClient implements SignalingClient {
  private readonly emitter = new Emitter<SignalingClientEvents>();
  private pendingJoin: { resolve: (joined: SignalingJoined) => void; reject: (failure: SignalingJoinFailure) => void } | null =
    null;
  request: SignalingJoinRequest | null = null;
  registered = false;
  closed = false;
  left = false;
  /** 서버로 나간 시그널. */
  readonly signals: { to: string; payload: SignalPayload }[] = [];
  /** 등록 전이라 보내지 못한 시그널(실제 서버는 NOT_JOINED 로 거절한다). */
  readonly refused: { to: string; payload: SignalPayload }[] = [];

  constructor(
    readonly net: FakeNet,
    readonly url: string,
    /** 세션이 넘긴 접속 순번 공급 함수. 실물은 새 소켓에서 join 을 보낼 때마다 한 번 부른다. */
    readonly nextSeq: (() => number) | undefined = undefined,
  ) {}

  on<E extends keyof SignalingClientEvents>(event: E, listener: SignalingClientEvents[E]): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  get listenerErrors(): readonly unknown[] {
    return this.emitter.errors;
  }

  listenerCount(event: keyof SignalingClientEvents): number {
    return this.emitter.count(event);
  }

  join(request: SignalingJoinRequest): Promise<SignalingJoined> {
    this.request = request;
    this.net.joins.push(request);
    this.net.joinSeqs.push(this.nextSeq === undefined ? null : this.nextSeq());
    return new Promise((resolve, reject) => {
      this.pendingJoin = { resolve, reject };
      if (this.net.rejectJoinWith !== null) this.rejectJoin(this.net.rejectJoinWith);
      else if (!this.net.holdJoined) this.releaseJoined();
    });
  }

  sendSignal(to: string, payload: SignalPayload): boolean {
    if (!this.registered || this.closed) {
      this.refused.push({ to, payload });
      return false;
    }
    this.signals.push({ to, payload });
    return true;
  }

  async leave(): Promise<void> {
    this.left = true;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.registered && this.request !== null) this.net.unregister(this.request.room, this.request.peer, this.request.sid);
    this.registered = false;
    this.rejectJoin({ code: 'CLOSED' });
  }

  // 시험이 부르는 것 ---------------------------------------------------------

  /** 서버가 joined 를 보냈다. 등록하고 지금 방에 있는 다른 참가자를 돌려준다. */
  releaseJoined(): void {
    const pending = this.pendingJoin;
    const request = this.request;
    if (pending === null || request === null) return;
    this.pendingJoin = null;
    const members = this.net.membersOf(request.room).filter((member) => member.peer !== request.peer);
    this.net.register(request.room, request.peer, request.sid);
    this.registered = true;
    pending.resolve({ members, requestedAt: this.net.clock.now() });
  }

  rejectJoin(failure: SignalingJoinFailure): void {
    const pending = this.pendingJoin;
    if (pending === null) return;
    this.pendingJoin = null;
    pending.reject(failure);
  }

  emitSignal(signal: ServerSignalMessage): void {
    if (!this.closed) this.emitter.emit('signal', signal);
  }

  emitMembers(members: readonly Member[], source: MembersUpdate['source'] = 'pong', requestedAt?: number): void {
    if (!this.closed) this.emitter.emit('members', { members, source, requestedAt: requestedAt ?? this.net.clock.now() });
  }

  emitState(state: SignalingState, reason: SignalingBlockReason | null = null): void {
    if (!this.closed) this.emitter.emit('state', { state, reason });
  }

  emitRelayError(error: RelayError): void {
    if (!this.closed) this.emitter.emit('relay-error', error);
  }

  emitGatewayFrame(): void {
    if (!this.closed) this.emitter.emit('gateway-frame');
  }
}

/** 가짜 시그널링 서버와 가짜 망. 한 시험에 하나를 쓴다. */
export class FakeNet {
  private readonly rooms = new Map<string, Map<string, string>>();
  private readonly meshes = new Map<string, FakeMesh>();
  private readonly queue: (() => void)[] = [];
  private readonly blocked = new Set<string>();
  private pinging = false;
  readonly allMeshes: FakeMesh[] = [];
  readonly clients: FakeSignalingClient[] = [];
  readonly joins: SignalingJoinRequest[] = [];
  /** joins 와 같은 순서로, 그 join 에 세션이 준 접속 순번. 공급 함수를 받지 못했으면 null. */
  readonly joinSeqs: (number | null)[] = [];
  /** 참이면 contact 한 두 가짜 mesh 를 바로 잇는다. 거짓이면 시험이 openLink·failAttempt 로 정한다. */
  autoConnect = false;
  /** 참이면 join 의 답을 시험이 releaseJoined 를 부를 때까지 보내지 않는다. */
  holdJoined = false;
  rejectJoinWith: SignalingJoinFailure | null = null;
  nativeLoadFails = false;
  /** mesh 가 handleSignal 을 받았을 때 시험이 끼어들 자리. */
  onSignal: ((mesh: FakeMesh, signal: ServerSignalMessage) => void) | null = null;

  constructor(readonly clock: FakeClock) {
    clock.settle = () => this.settle();
  }

  readonly createSignalingClient: CreateSignalingClient = (deps) => {
    const client = new FakeSignalingClient(this, deps.url, deps.nextSeq);
    this.clients.push(client);
    return client;
  };

  readonly createMesh: CreateMesh = async (deps) => {
    if (this.nativeLoadFails) return { ok: false, code: 'NATIVE_LOAD_FAILED', detail: 'cannot load the native module' };
    const mesh = new FakeMesh(this, deps);
    this.meshes.set(mesh.name, mesh);
    this.allMeshes.push(mesh);
    return { ok: true, mesh };
  };

  /** 그 이름의 지금 mesh. */
  meshOf(name: string): FakeMesh | undefined {
    return this.meshes.get(name);
  }

  /** 그 이름으로 가장 최근에 만든 클라이언트. */
  clientOf(name: string): FakeSignalingClient {
    const client = [...this.clients].reverse().find((candidate) => candidate.request?.peer === name);
    assert.ok(client, `${name} 의 시그널링 클라이언트가 없다`);
    return client;
  }

  forget(mesh: FakeMesh): void {
    if (this.meshes.get(mesh.name) === mesh) this.meshes.delete(mesh.name);
  }

  // 서버의 참가자 기록 -------------------------------------------------------

  register(room: string, peer: string, sid: string): void {
    const members = this.rooms.get(room) ?? new Map<string, string>();
    members.set(peer, sid);
    this.rooms.set(room, members);
  }

  unregister(room: string, peer: string, sid?: string): void {
    const members = this.rooms.get(room);
    if (members === undefined) return;
    if (sid === undefined || members.get(peer) === sid) members.delete(peer);
  }

  membersOf(room: string): Member[] {
    return [...(this.rooms.get(room) ?? [])].map(([peer, sid]) => ({ peer, sid }));
  }

  // 전달 --------------------------------------------------------------------

  enqueue(task: () => void): void {
    this.queue.push(task);
  }

  /** 밀린 프레임과 마이크로태스크를 더 남지 않을 때까지 돌린다. */
  async settle(): Promise<void> {
    for (;;) {
      await flushMicrotasks();
      if (this.queue.length === 0) return;
      for (const task of this.queue.splice(0)) task();
    }
  }

  /** 두 이름 사이에는 링크가 열리지 않는다(부분 mesh). 시도는 기한에 ice / ice_timeout 으로 끝난다. */
  block(a: string, b: string): void {
    this.blocked.add([a, b].sort().join('|'));
  }

  onContact(from: FakeMesh, peer: string): void {
    if (!this.autoConnect) return;
    const other = this.meshes.get(peer);
    if (other === undefined || this.blocked.has([from.name, peer].sort().join('|'))) {
      this.clock.timers.setTimeout(() => {
        if (!from.isAttempting(peer)) return;
        from.failAttempt(
          peer,
          other === undefined ? { stage: 'signaling', reason: 'no_answer' } : { stage: 'ice', reason: 'ice_timeout' },
        );
      }, LIMITS.PEER_CONNECT_TIMEOUT_MS);
      return;
    }
    const cid = `${from.name < peer ? from.deps.self.sid : other.deps.self.sid}.1`;
    this.enqueue(() => {
      if (from.down || other.down || from.isOpen(peer)) return;
      // 양쪽의 link-open 이 프레임보다 먼저다. 그래서 첫 동기화는 동시에 시작한 교환이 된다.
      from.openLink(peer, other.deps.self.sid, { cid, paired: true });
      other.openLink(from.name, from.deps.self.sid, { cid, paired: true });
    });
  }

  /** 열린 링크마다 P2P_PING_INTERVAL_MS 마다 양쪽이 자기 기록 수와 지문을 실은 ping 을 보낸다. */
  startPings(): void {
    if (this.pinging) return;
    this.pinging = true;
    const tick = (): void => {
      for (const mesh of [...this.meshes.values()]) {
        for (const link of mesh.links()) {
          if (link.state !== 'open') continue;
          const info = mesh.deps.pingInfo();
          this.enqueue(() => this.meshes.get(link.peer)?.receivePing(mesh.name, info.sc, info.sf));
        }
      }
      this.clock.timers.setTimeout(tick, LIMITS.P2P_PING_INTERVAL_MS);
    };
    this.clock.timers.setTimeout(tick, LIMITS.P2P_PING_INTERVAL_MS);
  }

  /** 가짜들의 리스너가 던진 예외가 없어야 한다(격리 때문에 가려진 결함을 본다). */
  assertNoListenerErrors(): void {
    const errors = [
      ...this.allMeshes.flatMap((mesh) => mesh.listenerErrors),
      ...this.clients.flatMap((client) => client.listenerErrors),
    ];
    assert.deepEqual(errors, [], '리스너가 예외를 던졌다');
  }
}

// ── 가짜 복제본 ─────────────────────────────────────────────────────────────

export interface FakeReplicaControl {
  /** 병합에서 버릴 기록(검증에서 버리는 기록을 흉내 낸다). 버린 것은 ignored 로 센다. */
  refuse: (record: StateRecord) => boolean;
  /** 값이 있으면 fingerprint() 가 이 값을 돌려준다. */
  fingerprint: string | null;
  /** 값이 있으면 다음 applyLocal 이 이 코드로 거절한다(한 번). */
  failNext: ApplyLocalResult | null;
  /** mergeRemote 가 overflow 를 돌려주게 한다. */
  overflow: boolean;
  /** adoptElapsed 가 받은 값의 이력. */
  readonly adopted: { testId: string; ms: number; now: number; changed: boolean }[];
  /** mergeRemote 호출 이력. */
  readonly merges: { from: string; snapshot: boolean; count: number }[];
}

export type FakeReplica = Replica & { readonly control: FakeReplicaControl };

function identityOf(record: StateRecord): string {
  return record.kind === 'presence' || record.kind === 'test' ? record.key : record.rid;
}

function order(a: { lc: number; author: string; id: string }, b: { lc: number; author: string; id: string }): number {
  return a.lc - b.lc || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * shared-state 계약의 모양을 따르는 가짜 복제본. 규칙은 방 조율을 시험하는 데 필요한 만큼만 흉내 낸다
 * (키 기록은 (lc, author) 가 큰 쪽, 추가 기록은 합집합, 경과 시간은 큰 값만 따른다).
 */
export function createFakeReplica(deps: ReplicaDeps): FakeReplica {
  const records = new Map<string, StateRecord>();
  const selfNames = new Set(deps.selfNames);
  let seq = 1;
  let maxLc = 0;
  /** 현재 테스트의 기준 시각과 이미 흐른 시간. */
  let elapsed: { testId: string; base: number; ref: number } | null = null;
  const control: FakeReplicaControl = {
    refuse: () => false,
    fingerprint: null,
    failNext: null,
    overflow: false,
    adopted: [],
    merges: [],
  };

  const all = (): StateRecord[] => [...records.values()];
  const testRecord = (): TestRecord | null => {
    const record = records.get('test');
    return record !== undefined && record.kind === 'test' ? record : null;
  };
  const testElapsed = (now: number): number | null =>
    elapsed === null ? null : Math.max(0, elapsed.base + (now - elapsed.ref));

  const stopOf = (testId: string): StopView | null => {
    const stops = all()
      .filter((record): record is StopRecord => record.kind === 'stop' && record.body.test_id === testId)
      .sort((a, b) => order({ lc: a.lc, author: a.author, id: a.rid }, { lc: b.lc, author: b.author, id: b.rid }));
    const first = stops[0];
    if (first === undefined) return null;
    return { stop_id: first.rid, reason: first.body.reason, detail: first.body.detail, by: first.author, lc: first.lc, wall: first.wall };
  };

  const scenariosOf = (test: TestRecord): ScenarioView[] =>
    all()
      .filter((record): record is ScenarioRecord => record.kind === 'scenario' && record.body.test_id === test.body.test_id)
      .sort((a, b) => order({ lc: a.lc, author: a.author, id: a.rid }, { lc: b.lc, author: b.author, id: b.rid }))
      .map((record, index) => ({
        scenario_id: record.rid,
        index: index + 1,
        title: record.body.title,
        plan: record.body.plan,
        actor: record.body.actor ?? null,
        verifier: record.body.verifier ?? null,
        by: record.author,
        lc: record.lc,
        wall: record.wall,
        over_limit: index + 1 > test.body.max_scenarios,
      }));

  const claimsOf = (test: TestRecord): ClaimView[] => {
    const stop = stopOf(test.body.test_id);
    return all()
      .filter((record): record is ClaimRecord => record.kind === 'claim' && record.body.test_id === test.body.test_id)
      .sort((a, b) => order({ lc: a.lc, author: a.author, id: a.rid }, { lc: b.lc, author: b.author, id: b.rid }))
      .map((record) => {
        const verifications = all()
          .filter((item): item is VerificationRecord => item.kind === 'verification' && item.body.claim === record.rid)
          .sort((a, b) => order({ lc: a.lc, author: a.author, id: a.rid }, { lc: b.lc, author: b.author, id: b.rid }))
          .map((item) => ({
            verification_id: item.rid,
            by: item.author,
            lc: item.lc,
            wall: item.wall,
            result: item.body.result,
            evidence: item.body.evidence,
            counted: item.author !== record.author,
          }));
        const counted = verifications.filter((item) => item.counted);
        const status = counted.some((item) => item.result === 'refuted')
          ? 'refuted'
          : counted.some((item) => item.result === 'confirmed')
            ? 'confirmed'
            : 'unverified';
        const late = stop !== null && record.lc > stop.lc;
        const classification = late
          ? 'late'
          : status === 'confirmed'
            ? record.body.outcome === 'pass'
              ? 'passed'
              : 'failed'
            : status === 'refuted' && record.body.outcome === 'pass'
              ? 'failed'
              : 'unverified';
        return {
          claim_id: record.rid,
          scenario_id: record.body.scenario,
          by: record.author,
          lc: record.lc,
          wall: record.wall,
          action: record.body.action,
          expected: record.body.expected,
          observed: record.body.observed,
          outcome: record.body.outcome,
          steps: record.body.steps,
          status,
          late,
          classification,
          verifications,
        } satisfies ClaimView;
      });
  };

  const testView = (now: number): TestView | null => {
    const test = testRecord();
    if (test === null) return null;
    const spent = testElapsed(now) ?? 0;
    return {
      test_id: test.body.test_id,
      request: test.body.request,
      by: test.author,
      started_wall: test.body.started_wall,
      max_duration_min: test.body.max_duration_min,
      max_scenarios: test.body.max_scenarios,
      elapsed_ms: spent,
      remaining_ms: Math.max(0, test.body.max_duration_min * MIN - spent),
      scenarios_used: scenariosOf(test).filter((scenario) => !scenario.over_limit).length,
      stopped: stopOf(test.body.test_id),
    };
  };

  const view = (now: number): ReplicaView => {
    const test = testRecord();
    return {
      presences: all()
        .filter((record): record is PresenceRecord => record.kind === 'presence')
        .map((record) => ({ ...record.body, peer: record.author, lc: record.lc, wall: record.wall }))
        .sort((a, b) => (a.peer < b.peer ? -1 : 1)),
      test: testView(now),
      scenarios: test === null ? [] : scenariosOf(test),
      claims: test === null ? [] : claimsOf(test),
    };
  };

  /** 기록 하나를 넣고 그것이 만든 변화를 돌려준다. 넣지 않았으면 null. */
  const put = (record: StateRecord, now: number): StateChange[] | null => {
    const id = identityOf(record);
    const held = records.get(id);
    if (held !== undefined) {
      const key = record.kind === 'presence' || record.kind === 'test';
      if (!key) return null;
      if (order({ lc: record.lc, author: record.author, id }, { lc: held.lc, author: held.author, id }) <= 0) return null;
    }
    const before = view(now);
    const previousTest = testRecord();
    records.set(id, record);
    maxLc = Math.max(maxLc, record.lc);
    const changes: StateChange[] = [];
    const test = testRecord();
    if (record.kind === 'test') {
      elapsed = { testId: record.body.test_id, base: 0, ref: now };
      const started = testView(now);
      if (started !== null) {
        changes.push(
          previousTest === null
            ? { type: 'test_started', test: started }
            : { type: 'test_replaced', test: started, previous_test_id: previousTest.body.test_id },
        );
      }
    } else if (record.kind === 'presence') {
      const previous = before.presences.find((presence) => presence.peer === record.author);
      const strip = (presence: (typeof before.presences)[number]): PresenceBody => ({
        client: presence.client,
        tools: presence.tools,
        role: presence.role,
        status: presence.status,
        listening: presence.listening,
        note: presence.note,
      });
      changes.push({
        type: 'presence_changed',
        peer: record.author,
        previous: previous === undefined ? null : strip(previous),
        current: record.body,
      });
    } else if (test !== null && record.body.test_id === test.body.test_id) {
      const after = view(now);
      if (record.kind === 'stop') {
        const stop = after.test?.stopped;
        if (before.test?.stopped === null && stop != null) changes.push({ type: 'test_stopped', test_id: test.body.test_id, stop });
      } else if (record.kind === 'scenario') {
        const scenario = after.scenarios.find((candidate) => candidate.scenario_id === record.rid);
        if (scenario !== undefined) changes.push({ type: scenario.over_limit ? 'scenario_over_limit' : 'scenario_started', scenario });
      } else if (record.kind === 'claim') {
        const claim = after.claims.find((candidate) => candidate.claim_id === record.rid);
        if (claim !== undefined) changes.push({ type: 'claim_added', claim });
      } else {
        const claim = after.claims.find((candidate) => candidate.claim_id === record.body.claim);
        const verification = claim?.verifications.find((candidate) => candidate.verification_id === record.rid);
        if (claim !== undefined && verification !== undefined) {
          changes.push({ type: 'verification_added', claim_id: claim.claim_id, claim_by: claim.by, verification, claim_status: claim.status });
        }
      }
    }
    return changes;
  };

  const nextId = (): string => {
    const id = makeEntryId(deps.self.sid, seq);
    assert.ok(id.ok);
    seq += 1;
    return id.value;
  };

  const rejected = (code: Extract<ApplyLocalResult, { ok: false }>['code']): ApplyLocalResult => ({ ok: false, code, detail: code });

  const applyLocal = (command: StateCommand, now: number): ApplyLocalResult => {
    if (control.failNext !== null) {
      const failure = control.failNext;
      control.failNext = null;
      return failure;
    }
    const common = { author: deps.self.peer, lc: Math.max(maxLc + 1, now), wall: now };
    const test = testRecord();
    const stopped = test === null ? null : stopOf(test.body.test_id);
    let record: StateRecord;
    switch (command.type) {
      case 'set_presence': {
        const mine = records.get(presenceKey(deps.self.peer));
        const base: PresenceBody =
          mine !== undefined && mine.kind === 'presence'
            ? mine.body
            : { client: 'unknown', tools: [], role: null, status: 'joined', listening: false, note: null };
        const patch = Object.fromEntries(Object.entries(command.patch).filter(([, value]) => value !== undefined));
        record = { kind: 'presence', key: presenceKey(deps.self.peer), ...common, body: { ...base, ...patch, tools: [...(command.patch.tools ?? base.tools)] } };
        break;
      }
      case 'start_test':
        if (test !== null) return rejected(stopped === null ? 'TEST_ALREADY_ACTIVE' : 'TEST_ENDED');
        record = {
          kind: 'test',
          key: 'test',
          ...common,
          body: {
            test_id: nextId(),
            request: command.request,
            started_wall: now,
            max_duration_min: command.max_duration_min,
            max_scenarios: command.max_scenarios,
          },
        };
        break;
      case 'stop_test':
        if (test === null) return rejected('NO_ACTIVE_TEST');
        if (stopped !== null) return { ok: true, records: [], changes: [] };
        record = { kind: 'stop', rid: nextId(), ...common, body: { test_id: test.body.test_id, reason: command.reason, detail: command.detail } };
        break;
      case 'start_scenario': {
        if (test === null) return rejected('NO_ACTIVE_TEST');
        if (stopped !== null) return rejected('TEST_STOPPED');
        if ((testElapsed(now) ?? 0) >= test.body.max_duration_min * MIN) return rejected('TIME_LIMIT_REACHED');
        if (scenariosOf(test).length >= test.body.max_scenarios) return rejected('SCENARIO_LIMIT_REACHED');
        const body: ScenarioRecord['body'] = { test_id: test.body.test_id, title: command.title, plan: command.plan ?? null };
        if (command.actor !== undefined) body.actor = command.actor;
        if (command.verifier !== undefined) body.verifier = command.verifier;
        record = { kind: 'scenario', rid: nextId(), ...common, body };
        break;
      }
      case 'record_claim': {
        if (test === null) return rejected('NO_ACTIVE_TEST');
        const scenario = scenariosOf(test).find((candidate) => candidate.scenario_id === command.scenario_id);
        if (scenario === undefined) return rejected('UNKNOWN_SCENARIO');
        if (scenario.over_limit) return rejected('SCENARIO_OVER_LIMIT');
        record = {
          kind: 'claim',
          rid: nextId(),
          ...common,
          body: {
            test_id: test.body.test_id,
            scenario: command.scenario_id,
            action: command.action,
            expected: command.expected ?? null,
            observed: command.observed,
            outcome: command.outcome,
            steps: command.steps,
          },
        };
        break;
      }
      case 'record_verification': {
        const claim = test === null ? undefined : claimsOf(test).find((candidate) => candidate.claim_id === command.claim_id);
        if (test === null || claim === undefined) return rejected('UNKNOWN_CLAIM');
        if (selfNames.has(claim.by)) return rejected('SELF_VERIFY_FORBIDDEN');
        record = {
          kind: 'verification',
          rid: nextId(),
          ...common,
          body: { test_id: test.body.test_id, claim: command.claim_id, result: command.result, evidence: command.evidence },
        };
        break;
      }
    }
    const changes = put(record, now);
    return { ok: true, records: changes === null ? [] : [record], changes: changes ?? [] };
  };

  const mergeRemote: Replica['mergeRemote'] = (incoming, origin, now): MergeRemoteResult => {
    control.merges.push({ from: origin.from, snapshot: origin.snapshot, count: incoming.length });
    if (control.overflow) return { applied: [], ignored: 0, anomalies: 0, changes: [], overflow: true };
    const applied: StateRecord[] = [];
    const changes: StateChange[] = [];
    let ignored = 0;
    let anomalies = 0;
    for (const record of incoming) {
      if (!origin.snapshot && record.author !== origin.from) {
        anomalies += 1;
        continue;
      }
      if (control.refuse(record)) {
        ignored += 1;
        continue;
      }
      const made = put(record, now);
      if (made === null) {
        ignored += 1;
      } else {
        applied.push(record);
        changes.push(...made);
      }
    }
    return { applied, ignored, anomalies, changes, overflow: false };
  };

  return {
    control,
    applyLocal,
    mergeRemote,
    snapshot: all,
    view,
    fingerprint: () => control.fingerprint ?? stateFingerprint(all()),
    testElapsed,
    adoptElapsed(testId, ms, now) {
      const mine = testElapsed(now);
      const changed = elapsed !== null && elapsed.testId === testId && mine !== null && ms > mine;
      if (changed) elapsed = { testId, base: ms, ref: now };
      control.adopted.push({ testId, ms, now, changed });
      return changed;
    },
  };
}

// ── 기록 만들기 ─────────────────────────────────────────────────────────────

/** 이름에서 sid 를 만든다(소문자·숫자 12자). 시험에서 기록 ID 를 읽기 쉽게 하려는 것이다. */
export function sidOf(name: string, generation = 0): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${base}${String(generation)}`.padEnd(12, '0').slice(0, 12);
}

export function presenceRecord(author: string, lc: number, body: Partial<PresenceBody> = {}): PresenceRecord {
  return {
    kind: 'presence',
    key: presenceKey(author),
    author,
    lc,
    wall: lc,
    body: { client: 'claude-code', tools: [], role: null, status: 'joined', listening: false, note: null, ...body },
  };
}

export function testRecordOf(author: string, lc: number, testId: string, body: Partial<TestRecord['body']> = {}): TestRecord {
  return {
    kind: 'test',
    key: 'test',
    author,
    lc,
    wall: lc,
    body: { test_id: testId, request: '로그인 흐름을 함께 본다', started_wall: lc, max_duration_min: 60, max_scenarios: 20, ...body },
  };
}

export function stopRecordOf(author: string, lc: number, rid: string, testId: string, reason: 'user' | 'time_limit' = 'user'): StopRecord {
  return { kind: 'stop', rid, author, lc, wall: lc, body: { test_id: testId, reason, detail: reason === 'user' ? '사용자가 멈추라고 했다' : '' } };
}

export function scenarioRecordOf(author: string, lc: number, rid: string, testId: string, title = '시나리오'): ScenarioRecord {
  return { kind: 'scenario', rid, author, lc, wall: lc, body: { test_id: testId, title, plan: null } };
}

export function claimRecordOf(author: string, lc: number, rid: string, testId: string, scenario: string): ClaimRecord {
  return {
    kind: 'claim',
    rid,
    author,
    lc,
    wall: lc,
    body: { test_id: testId, scenario, action: '버튼을 눌렀다', expected: null, observed: '화면이 바뀌었다', outcome: 'pass', steps: '1. 누른다' },
  };
}

// ── 시험이 직접 연기하는 상대 피어 ──────────────────────────────────────────

/** 가짜 mesh 의 링크 반대편을 시험이 손으로 연기한다. 세션이 그 피어에게 보낸 프레임을 읽고, 프레임을 넣는다. */
export class ScriptedPeer {
  private taken = 0;

  constructor(
    readonly mesh: FakeMesh,
    readonly name: string,
    readonly sid: string = sidOf(name),
  ) {}

  /** 링크가 열렸다. 세션은 hello 와 스냅샷, sync_end 를 보낸다. */
  open(): this {
    this.mesh.openLink(this.name, this.sid);
    return this;
  }

  /** 세션이 이 피어에게 보낸 프레임 전부. */
  frames(): P2PFrame[] {
    return this.mesh.framesTo(this.name);
  }

  /** 지난번 take 뒤에 보낸 프레임. */
  take(): P2PFrame[] {
    const frames = this.frames();
    const fresh = frames.slice(this.taken);
    this.taken = frames.length;
    return fresh;
  }

  send(frame: unknown): this {
    this.mesh.receive(this.name, typeof frame === 'string' ? frame : JSON.stringify(frame));
    return this;
  }

  hello(overrides: Record<string, unknown> = {}): this {
    return this.send({
      v: LIMITS.P2P_VERSION,
      t: 'hello',
      peer: this.name,
      sid: this.sid,
      wall: this.mesh.net.clock.now(),
      client: { name: 'agent-chat', version: '0.1.0' },
      ...overrides,
    });
  }

  state(records: readonly StateRecord[], snap = false): this {
    return this.send({ v: LIMITS.P2P_VERSION, t: 'state', records, ...(snap ? { snap: true } : {}) });
  }

  syncEnd(fields: Record<string, unknown> = {}): this {
    return this.send({ v: LIMITS.P2P_VERSION, t: 'sync_end', count: 0, ...fields });
  }

  chat(id: string, text: string, to: readonly string[] | null = null): this {
    return this.send({ v: LIMITS.P2P_VERSION, t: 'chat', id, to, text, wall: this.mesh.net.clock.now() });
  }

  ack(id: string): this {
    return this.send({ v: LIMITS.P2P_VERSION, t: 'ack', id });
  }

  bye(reason: string): this {
    return this.send({ v: LIMITS.P2P_VERSION, t: 'bye', reason });
  }

  ping(sc: number, sf: string): this {
    this.mesh.receivePing(this.name, sc, sf);
    return this;
  }

  /** 링크를 열고 첫 동기화까지 끝낸다(hello, 스냅샷, sync_end). */
  sync(records: readonly StateRecord[] = [], end: Record<string, unknown> = {}): this {
    this.open().hello();
    if (records.length > 0) this.state(records, true);
    return this.syncEnd({ count: records.length, ...end });
  }
}

// ── 시험대 ──────────────────────────────────────────────────────────────────

export const TEST_CONFIG: RoomSessionConfig = {
  defaultServer: 'ws://127.0.0.1:8787',
  name: 'agent-test01',
  client: 'claude-code',
  iceServers: { raw: null, parsed: { ok: true, value: [{ url: 'stun:stun.example.org', hostname: 'stun.example.org', port: 3478 }] } },
  home: '/nonexistent/agent-chat-home',
};

export interface SessionUnderTest {
  readonly session: RoomSession;
  readonly inbox: FakeInbox;
  readonly records: FakeRecords;
  readonly log: FakeLog;
  /** 이 세션이 입장마다 만든 복제본(순서대로). */
  readonly replicas: Replica[];
  /** 가장 최근 복제본. */
  replica(): Replica;
  fake(): FakeReplica;
}

export interface TestBed {
  readonly clock: FakeClock;
  readonly net: FakeNet;
  settle(): Promise<void>;
  /** 가짜 망의 전달을 돌리면서 그 호출이 끝나기를 기다린다. 서로 이은 세션끼리의 호출에 쓴다. */
  run<T>(pending: Promise<T>): Promise<T>;
  /** 세션 하나를 만든다. createReplica 를 주지 않으면 가짜 복제본을 쓴다. */
  session(options?: {
    name?: string;
    config?: Partial<RoomSessionConfig>;
    createReplica?: CreateReplica;
    deps?: Partial<RoomSessionDeps>;
  }): SessionUnderTest;
  /** 그 세션의 mesh 반대편을 연기할 피어. */
  remote(name: string, peer: string, sid?: string): ScriptedPeer;
}

export function createTestBed(): TestBed {
  const clock = new FakeClock();
  const net = new FakeNet(clock);
  return {
    clock,
    net,
    settle: () => net.settle(),
    async run<T>(pending: Promise<T>): Promise<T> {
      let outcome: { readonly value: T } | null = null;
      void pending.then((value) => {
        outcome = { value };
      });
      for (let round = 0; round < 200 && outcome === null; round += 1) await net.settle();
      const settled = outcome as { readonly value: T } | null;
      assert.ok(settled !== null, '호출이 끝나지 않았다(시간을 움직여야 끝나는 호출일 수 있다)');
      return settled.value;
    },
    session(options = {}) {
      const inbox = new FakeInbox();
      const records = new FakeRecords();
      const log = new FakeLog();
      const replicas: Replica[] = [];
      const make = options.createReplica ?? createFakeReplica;
      const session = createRoomSession({
        config: { ...TEST_CONFIG, ...(options.name === undefined ? {} : { name: options.name }), ...options.config },
        app: { name: 'agent-chat', version: '0.1.0' },
        limits: DEFAULT_ROOM_SESSION_LIMITS,
        inbox,
        createSignalingClient: net.createSignalingClient,
        createMesh: net.createMesh,
        createReplica: (deps) => {
          const replica = make(deps);
          replicas.push(replica);
          return replica;
        },
        openTranscript: records.openTranscript,
        writeReport: records.writeReport,
        now: clock.now,
        timers: clock.timers,
        log: log.port,
        ...options.deps,
      });
      const replica = (): Replica => {
        const latest = replicas.at(-1);
        assert.ok(latest, '복제본을 만든 적이 없다');
        return latest;
      };
      return {
        session,
        inbox,
        records,
        log,
        replicas,
        replica,
        fake: () => {
          const latest = replica() as Partial<FakeReplica>;
          assert.ok(latest.control, '가짜 복제본이 아니다');
          return latest as FakeReplica;
        },
      };
    },
    remote(name, peer, sid) {
      const mesh = net.meshOf(name);
      assert.ok(mesh, `${name} 의 mesh 가 없다`);
      return new ScriptedPeer(mesh, peer, sid);
    },
  };
}

/** 방 ID 표본. 형식(소문자·숫자 8~32자)만 맞는다. */
export const ROOM = 'room0000test0001';

export interface EnteredRoom {
  readonly mesh: FakeMesh;
  readonly client: FakeSignalingClient;
  /** 이름 → 그 피어를 연기하는 손잡이. 첫 동기화까지 끝난 상태다. */
  readonly remotes: ReadonlyMap<string, ScriptedPeer>;
  remote(peer: string): ScriptedPeer;
}

/**
 * 세션을 방에 넣는다. peers 가 비면 create, 아니면 그 피어들이 이미 있는 방에 join 한다.
 * 피어마다 링크를 열고 첫 동기화를 끝낸다. 피어의 스냅샷은 그 피어의 presence 하나(또는 준 기록)다.
 */
export async function enterRoom(
  bed: TestBed,
  sut: SessionUnderTest,
  name: string,
  peers: readonly string[] = [],
  options: { records?: (peer: string) => readonly StateRecord[]; room?: string } = {},
): Promise<EnteredRoom> {
  const room = options.room ?? ROOM;
  for (const peer of peers) bed.net.register(room, peer, sidOf(peer));
  const entering = peers.length === 0 ? sut.session.create({ room_id: room, name }) : sut.session.join({ room_id: room, name });
  await bed.settle();
  const remotes = new Map<string, ScriptedPeer>();
  for (const peer of peers) {
    const remote = bed.remote(name, peer);
    remote.sync(options.records?.(peer) ?? [presenceRecord(peer, bed.clock.now() - SEC, { status: 'ready', listening: true })]);
    remotes.set(peer, remote);
  }
  await bed.settle();
  const result = await entering;
  assert.ok(result.ok, `입장에 실패했다: ${result.ok ? '' : result.code}`);
  for (const remote of remotes.values()) remote.take();
  const mesh = bed.net.meshOf(name);
  assert.ok(mesh);
  return {
    mesh,
    client: bed.net.clientOf(name),
    remotes,
    remote(peer) {
      const remote = remotes.get(peer);
      assert.ok(remote, `${peer} 는 이 방에 넣은 피어가 아니다`);
      return remote;
    },
  };
}
