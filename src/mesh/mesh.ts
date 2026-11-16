// 피어별 연결 시도와 링크 (architecture.md 3.6, protocol.md 3절·4.5).
// offer 규칙, cid, 후보 묶음과 두 큐, 시도 안 재전송, 연결 기한, 교체 확인, ping 생존 판정을 맡는다.
// 누구에게 언제 접촉할지는 정하지 않는다. ping·pong 외 프레임의 뜻을 모른다.

import type { LogFields, LogLevel } from '../diagnostics/log-port.js';
import {
  DATA_CHANNEL_LABEL,
  LIMITS,
  encodeP2PFrame,
  isOfferSide,
  isRelayCandidate,
  makeCid,
  parseCid,
  parseP2PFrame,
  utf8ByteLength,
  type CandidateItem,
  type CidParts,
  type ServerSignalMessage,
  type SignalKind,
  type SignalPayload,
  type TimerHandle,
} from '../protocol/index.js';
import type {
  AttemptDiag,
  AttemptFailure,
  CandidateCounts,
  CreateMeshResult,
  Mesh,
  MeshDeps,
  MeshEvents,
  MeshLink,
  MeshNetInfo,
  MeshSendResult,
} from './contract.js';
import { createEmitter } from './emitter.js';
import type { LoadNative, NativeChannel, NativePeer, NativeRtc } from './native.js';

const MODULE = 'mesh';

// ping·pong 은 200바이트를 넘지 않는다. 그보다 훨씬 긴 프레임은 해석하지 않고 그대로 올린다.
// 큰 state 프레임을 여기서 한 번, 받는 쪽에서 한 번 해석하지 않으려는 것이다.
const CONTROL_FRAME_MAX_CHARS = 1024;

// 답을 기다리는 ping 번호를 기억하는 수. 넘으면 오래된 것부터 잊는다.
const OUTSTANDING_PINGS_MAX = 16;
/**
 * 끊김 판정 타이머를 기한(마지막 생존 증거 + P2P_DEAD_AFTER_MS)보다 이만큼 먼저 건다.
 * 타이머는 늦게 깬다(같은 PC 의 4~6 프로세스에서 1~3ms). 증거 시각도 pong 을 처리한 때라 실제보다 늦다.
 * 기한에 딱 맞춰 걸면 상대가 죽은 때부터 15초를 몇 ms 넘겨 끊김을 알게 된다(V-L4 실측 15002ms. W9 이력).
 * "15초 안에 끊김으로 본다"를 지키려고 앞당긴다. ping 주기(5초)에 견주면 무시할 만큼 작다.
 */
export const DEAD_TIMER_LEAD_MS = 100;

// 피어 이름 하나에서 기억하는 offer 쪽 sid 의 수(다시 시작할 때마다 sid 가 바뀐다).
const SEEN_OFFER_SIDS_MAX = 16;

const NATIVE_DETAIL_MAX_CHARS = 300;

const FAILURES = {
  noOffer: { stage: 'signaling', reason: 'no_offer' },
  noAnswer: { stage: 'signaling', reason: 'no_answer' },
  peerGone: { stage: 'signaling', reason: 'peer_gone' },
  iceTimeout: { stage: 'ice', reason: 'ice_timeout' },
  failed: { stage: 'ice', reason: 'failed' },
} as const satisfies Record<string, AttemptFailure>;

/**
 * - await-offer: offer-request 를 보냈고 offer 를 못 받았다(내 이름이 크다). pc 가 없다.
 * - await-answer: offer 를 보냈고 answer 를 못 받았다(내 이름이 작다).
 * - await-open: offer 와 answer 가 오갔고 채널이 아직 열리지 않았다.
 */
type AttemptPhase = 'await-offer' | 'await-answer' | 'await-open';

/** pc 하나와 그 채널. live 가 거짓이면 닫은 것이고, 늦게 온 콜백은 아무 것도 바꾸지 않는다. */
interface Conn {
  readonly pc: NativePeer;
  dc: NativeChannel | null;
  live: boolean;
}

interface Attempt {
  readonly peer: string;
  readonly offerSide: boolean;
  phase: AttemptPhase;
  cid: string | null;
  /** 이 시도의 시그널에 서버가 붙인 상대 sid. */
  remoteSid: string | null;
  conn: Conn | null;
  readonly startedAt: number;
  deadline: TimerHandle;
  resendTimer: TimerHandle | null;
  periodicResends: number;
  resends: number;
  lastResendAt: number | null;
  /** 내가 만든 offer 또는 answer. 다시 보낼 때 새로 만들지 않고 이것을 그대로 보낸다. */
  localSdp: string | null;
  readonly localCandidates: CandidateItem[];
  unsent: CandidateItem[];
  batchTimer: TimerHandle | null;
  remoteDescribed: boolean;
  /** 시도 큐: 원격 설명이 없어 아직 넣지 못한 후보. */
  queue: CandidateItem[];
  /** 같은 후보 문자열은 시도마다 한 번만 넣는다(재전송으로 중복이 온다). */
  readonly remoteSeen: Set<string>;
  readonly local: { host: number; srflx: number };
  readonly remote: { host: number; srflx: number };
  queuedApplied: number;
  dupIgnored: number;
}

interface Probe {
  /** 이 번호 이상의 ping 에 대한 pong 만 확인으로 친다. */
  readonly n: number;
  readonly startedAt: number;
  readonly timer: TimerHandle;
  /** 확인하는 동안 온 요청 가운데 가장 새 것 하나. */
  held: ServerSignalMessage | null;
}

interface Link {
  readonly peer: string;
  readonly sid: string;
  readonly cid: string;
  readonly conn: Conn;
  readonly channel: NativeChannel;
  readonly openedAt: number;
  lastAliveAt: number;
  nextPing: number;
  readonly outstanding: Set<number>;
  pingTimer: TimerHandle | null;
  deadTimer: TimerHandle | null;
  /** 상대 쪽에서 닫힌 것을 알았고 곧 링크를 끝낸다. */
  ending: TimerHandle | null;
  probe: Probe | null;
}

/** 대기 큐: 아직 오지 않은 offer 의 후보. 피어당 하나이고 가장 큰 순번의 cid 것만 담는다. */
interface PendingQueue {
  readonly cid: string;
  readonly sid: string;
  readonly seq: number;
  readonly items: CandidateItem[];
  readonly seen: Set<string>;
  readonly timer: TimerHandle;
}

interface Slot {
  attempt: Attempt | null;
  link: Link | null;
  pending: PendingQueue | null;
  /** offer 쪽 sid 별로 지금까지 받아들인 offer 의 가장 큰 순번. */
  readonly seenOffers: Map<string, number>;
}

type CandidateKind = 'host' | 'srflx' | 'other';

function candidateKind(candidate: string): CandidateKind {
  const match = /\styp\s+([a-z]+)/i.exec(candidate);
  const kind = match?.[1]?.toLowerCase();
  return kind === 'host' || kind === 'srflx' ? kind : 'other';
}

function count(counts: { host: number; srflx: number }, candidate: string): void {
  const kind = candidateKind(candidate);
  if (kind !== 'other') counts[kind] += 1;
}

function describeLoadError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > NATIVE_DETAIL_MAX_CHARS ? `${text.slice(0, NATIVE_DETAIL_MAX_CHARS)}…` : text;
}

/** createMesh 의 본체. 네이티브 모듈을 불러오는 함수를 받는다(시험이 실패하는 것으로 바꿔 본다). */
export async function createMeshWith(deps: MeshDeps, load: LoadNative): Promise<CreateMeshResult> {
  let native: NativeRtc;
  try {
    native = await load();
  } catch (error) {
    deps.log.event('error', MODULE, 'mesh.native_load', { outcome: 'failed', error_code: 'NATIVE_LOAD_FAILED' });
    return { ok: false, code: 'NATIVE_LOAD_FAILED', detail: describeLoadError(error) };
  }
  return { ok: true, mesh: buildMesh(deps, native) };
}

/** 이미 불러온 네이티브 모듈로 mesh 를 만든다. 모듈 안에서만 쓴다(index.ts 는 내보내지 않는다). */
export function buildMesh(deps: MeshDeps, native: NativeRtc): Mesh {
  const { self, now, timers, log } = deps;
  const emitter = createEmitter<MeshEvents>(log);
  const slots = new Map<string, Slot>();

  let stopped = false;
  let shutdownDone: Promise<void> | null = null;
  let cidSeq = 0;
  let srflxSeen = false;

  function event(level: LogLevel, name: string, fields: LogFields): void {
    log.event(level, MODULE, name, fields);
  }

  function clearTimer(handle: TimerHandle | null): null {
    if (handle !== null) timers.clearTimeout(handle);
    return null;
  }

  function slotOf(peer: string): Slot {
    let slot = slots.get(peer);
    if (slot === undefined) {
      slot = { attempt: null, link: null, pending: null, seenOffers: new Map() };
      slots.set(peer, slot);
    }
    return slot;
  }

  /** 네이티브 콜백을 감싼다. 닫은 pc 의 늦은 콜백은 버리고, 처리 중의 예외가 프로세스를 죽이지 않게 한다. */
  function guarded(conn: Conn, what: string, run: () => void): void {
    if (stopped || !conn.live) return;
    try {
      run();
    } catch {
      event('error', 'mesh.callback_failed', { kind: what });
    }
  }

  function send(to: string, payload: SignalPayload): boolean {
    try {
      return deps.sendSignal(to, payload);
    } catch {
      return false;
    }
  }

  // ── pc ────────────────────────────────────────────────────────────────────

  function disposeConn(conn: Conn): void {
    conn.live = false;
    // 상대가 닫아 closed 가 된 pc 도 반드시 close() 를 부른다. 부르지 않으면 프로세스가 끝나지 않고 네이티브 정리가 멈춘다.
    try {
      conn.dc?.close();
    } catch {
      // 이미 닫힌 채널이다.
    }
    try {
      conn.pc.close();
    } catch {
      // 이미 닫힌 pc 다.
    }
  }

  function createConn(peer: string): Conn | null {
    let pc: NativePeer;
    try {
      pc = native.createPeer(`${self.peer}:${peer}`, deps.iceServers);
    } catch {
      event('error', 'mesh.pc_create', { peer, outcome: 'failed' });
      return null;
    }
    const conn: Conn = { pc, dc: null, live: true };
    pc.onLocalDescription((sdp, type) => guarded(conn, 'description', () => onLocalDescription(peer, conn, sdp, type)));
    pc.onLocalCandidate((candidate, mid) => guarded(conn, 'candidate', () => onLocalCandidate(peer, conn, candidate, mid)));
    pc.onStateChange((state) => guarded(conn, 'state', () => onPcState(peer, conn, state)));
    pc.onDataChannel((channel) => guarded(conn, 'channel', () => onRemoteChannel(peer, conn, channel)));
    return conn;
  }

  function wireChannel(peer: string, conn: Conn, channel: NativeChannel): void {
    // 콜백은 등록한 순서대로 처리된다(콜백마다 줄이 따로 있고, 한 박자에 쌓인 것은 만든 순서로 비운다. 실측).
    // 받은 프레임을 닫힘보다 먼저 받도록 onMessage 를 onClosed 보다 먼저 건다.
    channel.onOpen(() => guarded(conn, 'open', () => onChannelOpen(peer, conn)));
    channel.onMessage((message) => guarded(conn, 'message', () => onMessage(peer, conn, message)));
    channel.onClosed(() => guarded(conn, 'closed', () => onConnEnded(peer, conn, 'closed')));
    channel.onError(() => {});
  }

  function pcStates(conn: Conn | null): { ice_state: string; pc_state: string } {
    if (conn === null) return { ice_state: 'none', pc_state: 'none' };
    try {
      return { ice_state: conn.pc.iceState(), pc_state: conn.pc.state() };
    } catch {
      return { ice_state: 'unknown', pc_state: 'unknown' };
    }
  }

  // ── 시도 ──────────────────────────────────────────────────────────────────

  function newAttempt(peer: string, phase: AttemptPhase): Attempt {
    const attempt: Attempt = {
      peer,
      offerSide: isOfferSide(self.peer, peer),
      phase,
      cid: null,
      remoteSid: null,
      conn: null,
      startedAt: now(),
      deadline: timers.setTimeout(() => expire(attempt), LIMITS.PEER_CONNECT_TIMEOUT_MS),
      resendTimer: null,
      periodicResends: 0,
      resends: 0,
      lastResendAt: null,
      localSdp: null,
      localCandidates: [],
      unsent: [],
      batchTimer: null,
      remoteDescribed: false,
      queue: [],
      remoteSeen: new Set(),
      local: { host: 0, srflx: 0 },
      remote: { host: 0, srflx: 0 },
      queuedApplied: 0,
      dupIgnored: 0,
    };
    schedulePeriodicResend(attempt);
    return attempt;
  }

  function isCurrent(attempt: Attempt): boolean {
    return !stopped && slots.get(attempt.peer)?.attempt === attempt;
  }

  function clearAttemptTimers(attempt: Attempt): void {
    timers.clearTimeout(attempt.deadline);
    attempt.resendTimer = clearTimer(attempt.resendTimer);
    attempt.batchTimer = clearTimer(attempt.batchTimer);
  }

  function diagOf(attempt: Attempt): AttemptDiag {
    const local: CandidateCounts = { host: attempt.local.host, srflx: attempt.local.srflx };
    const remote: CandidateCounts = { host: attempt.remote.host, srflx: attempt.remote.srflx };
    return { ...pcStates(attempt.conn), local, remote, resends: attempt.resends, duration_ms: now() - attempt.startedAt };
  }

  function attemptFields(attempt: Attempt, diag: AttemptDiag): LogFields {
    return {
      peer: attempt.peer,
      sid: attempt.remoteSid,
      cid: attempt.cid,
      pc_state: diag.pc_state,
      ice_state: diag.ice_state,
      cand_local_host: diag.local.host,
      cand_local_srflx: diag.local.srflx,
      cand_remote_host: diag.remote.host,
      cand_remote_srflx: diag.remote.srflx,
      resends: diag.resends,
      queued_applied: attempt.queuedApplied,
      dup_ignored: attempt.dupIgnored,
      duration_ms: diag.duration_ms,
    };
  }

  /** 열리지 못한 시도를 끝낸다. attempt-failed 를 한 번 낸다. */
  function failAttempt(attempt: Attempt, failure: AttemptFailure, errorCode?: string): void {
    if (!isCurrent(attempt)) return;
    const slot = slotOf(attempt.peer);
    // 상태 이름은 pc 를 닫기 전에 읽는다. 닫은 뒤에는 모두 closed 다.
    const diag = diagOf(attempt);
    clearAttemptTimers(attempt);
    slot.attempt = null;
    if (attempt.conn !== null) disposeConn(attempt.conn);
    const fields: LogFields = { ...attemptFields(attempt, diag), outcome: 'failed', stage: failure.stage, reason: failure.reason };
    // 서버가 relay 후보를 봤다는 것은 결함이나 설정 위반이다.
    event(errorCode === undefined ? 'warn' : 'error', 'link.attempt_end', errorCode === undefined ? fields : { ...fields, error_code: errorCode });
    emitter.emit('attempt-failed', { ...failure, peer: attempt.peer, diag });
  }

  /**
   * 답한 쪽인데 ICE 는 연결됐다. 직접 경로는 있으므로, 기한까지 채널이 열리지 않았다면 내 answer 가 상대에 닿지 않은 것으로 본다.
   * offer 쪽은 answer 를 받아야 DTLS·SCTP 를 시작하므로 채널이 열리지 않는다(protocol.md 3.3. W9 공용 서버 P-W9P-08 실측).
   */
  function answerUnconfirmed(attempt: Attempt): boolean {
    if (attempt.offerSide) return false;
    const { ice_state } = pcStates(attempt.conn);
    return ice_state === 'connected' || ice_state === 'completed';
  }

  /** 기한이 찼을 때의 분류. 시도가 어디까지 갔는지로 정한다. */
  function expire(attempt: Attempt): void {
    switch (attempt.phase) {
      case 'await-offer':
        failAttempt(attempt, FAILURES.noOffer);
        return;
      case 'await-answer':
        failAttempt(attempt, FAILURES.noAnswer);
        return;
      case 'await-open':
        failAttempt(attempt, answerUnconfirmed(attempt) ? FAILURES.noAnswer : FAILURES.iceTimeout);
        return;
    }
  }

  function startOffer(slot: Slot, peer: string): void {
    cidSeq += 1;
    const cid = makeCid(self.sid, cidSeq);
    const attempt = newAttempt(peer, 'await-answer');
    slot.attempt = attempt;
    if (!cid.ok) {
      failAttempt(attempt, FAILURES.failed);
      return;
    }
    attempt.cid = cid.value;
    const conn = createConn(peer);
    if (conn === null) {
      failAttempt(attempt, FAILURES.failed);
      return;
    }
    attempt.conn = conn;
    try {
      // 채널은 offer 쪽이 만든다. 순서 보장·신뢰 전송은 기본값이다. 만들면 offer 가 콜백으로 온다.
      const channel = conn.pc.createDataChannel(DATA_CHANNEL_LABEL);
      conn.dc = channel;
      wireChannel(peer, conn, channel);
    } catch {
      failAttempt(attempt, FAILURES.failed);
    }
  }

  function startOfferRequest(slot: Slot, peer: string): void {
    const attempt = newAttempt(peer, 'await-offer');
    slot.attempt = attempt;
    send(peer, { kind: 'offer-request', data: {} });
  }

  // ── 시그널 보내기와 재전송 ────────────────────────────────────────────────

  function sendDescription(attempt: Attempt): boolean {
    if (attempt.cid === null || attempt.localSdp === null) return false;
    return send(attempt.peer, {
      kind: attempt.offerSide ? 'offer' : 'answer',
      cid: attempt.cid,
      data: { sdp: attempt.localSdp },
    });
  }

  function sendCandidates(attempt: Attempt, items: readonly CandidateItem[]): boolean {
    if (attempt.cid === null || items.length === 0) return false;
    let sent = false;
    for (let start = 0; start < items.length; start += LIMITS.CANDIDATE_LIST_MAX) {
      const list = items.slice(start, start + LIMITS.CANDIDATE_LIST_MAX);
      if (send(attempt.peer, { kind: 'candidate', cid: attempt.cid, data: { list } })) sent = true;
    }
    return sent;
  }

  /** 지금까지 모은 후보를 모두 보낸다. 아직 묶음으로 나가지 않은 것도 여기에 든다. */
  function sendAllCandidates(attempt: Attempt): boolean {
    attempt.batchTimer = clearTimer(attempt.batchTimer);
    attempt.unsent = [];
    return sendCandidates(attempt, attempt.localCandidates);
  }

  function noteResend(attempt: Attempt, kind: SignalKind, cause: string): void {
    attempt.resends += 1;
    attempt.lastResendAt = now();
    event('info', 'signal.resend', { peer: attempt.peer, cid: attempt.cid, kind, cause, resends: attempt.resends });
  }

  /** 시도의 상태에 맞는 시그널을 같은 cid 로 다시 보낸다(protocol.md 3.3 의 표). 새 cid 를 만들지 않는다. */
  function resendAttempt(attempt: Attempt, cause: string): void {
    switch (attempt.phase) {
      case 'await-offer':
        if (send(attempt.peer, { kind: 'offer-request', data: {} })) noteResend(attempt, 'offer-request', cause);
        return;
      case 'await-answer': {
        const description = sendDescription(attempt);
        const candidates = sendAllCandidates(attempt);
        if (description || candidates) noteResend(attempt, 'offer', cause);
        return;
      }
      case 'await-open': {
        // 답한 쪽은 answer 도 다시 보낸다. 내 answer 가 상대에 닿았는지 알 수 없고, 상대는 answer 를 받아야 채널을 연다.
        // 스로틀 아래에서는 상대의 offer 재전송(→ 중복 offer 에 대한 answer 재전송)도 함께 사라질 수 있다. 받는 쪽은 같은 cid 의 중복 answer 를 무시한다.
        const description = !attempt.offerSide && sendDescription(attempt);
        const candidates = sendAllCandidates(attempt);
        if (description || candidates) noteResend(attempt, description ? 'answer' : 'candidate', cause);
        return;
      }
    }
  }

  /** 게이트웨이 프레임과 SERVER_ERROR 로 바로 다시 보낸다. 한 시도에서 정해진 간격보다 자주 하지 않는다. */
  function resendNow(attempt: Attempt, cause: string): void {
    if (attempt.lastResendAt !== null && now() - attempt.lastResendAt < LIMITS.SIGNAL_RESEND_MIN_GAP_MS) return;
    resendAttempt(attempt, cause);
  }

  function schedulePeriodicResend(attempt: Attempt): void {
    attempt.resendTimer = timers.setTimeout(() => {
      attempt.resendTimer = null;
      if (!isCurrent(attempt) || attempt.periodicResends >= LIMITS.SIGNAL_RESEND_MAX) return;
      attempt.periodicResends += 1;
      resendAttempt(attempt, 'periodic');
      if (isCurrent(attempt)) schedulePeriodicResend(attempt);
    }, LIMITS.SIGNAL_RESEND_MS);
  }

  // ── pc 콜백 ───────────────────────────────────────────────────────────────

  function attemptOf(peer: string, conn: Conn): Attempt | null {
    const attempt = slots.get(peer)?.attempt ?? null;
    return attempt !== null && attempt.conn === conn ? attempt : null;
  }

  function linkOf(peer: string, conn: Conn): Link | null {
    const link = slots.get(peer)?.link ?? null;
    return link !== null && link.conn === conn ? link : null;
  }

  function onLocalDescription(peer: string, conn: Conn, sdp: string, type: string): void {
    const attempt = attemptOf(peer, conn);
    // 같은 offer 를 두 번 받으면 라이브러리가 answer 를 또 만든다. 처음 만든 것만 쓴다.
    if (attempt === null || attempt.localSdp !== null) return;
    if (type !== (attempt.offerSide ? 'offer' : 'answer')) return;
    if (isRelayCandidate(sdp)) {
      failAttempt(attempt, FAILURES.failed, 'RELAY_NOT_ALLOWED');
      return;
    }
    attempt.localSdp = sdp;
    sendDescription(attempt);
  }

  function onLocalCandidate(peer: string, conn: Conn, candidate: string, mid: string): void {
    // 링크가 열린 뒤에 나온 후보도 센다. 같은 PC 에서는 host 후보로 먼저 열리고 srflx 는 그 뒤에 나온다.
    if (candidateKind(candidate) === 'srflx') srflxSeen = true;
    if (isRelayCandidate(candidate)) return;
    const attempt = attemptOf(peer, conn);
    if (attempt === null) return;
    if (candidate.length > LIMITS.CANDIDATE_MAX_CHARS || mid.length > LIMITS.CANDIDATE_MID_MAX_CHARS) return;
    count(attempt.local, candidate);
    const item: CandidateItem = { candidate, mid };
    attempt.localCandidates.push(item);
    attempt.unsent.push(item);
    if (attempt.batchTimer !== null) return;
    // 후보를 잠깐 모아 한 메시지로 보낸다. 서버 호출 수와 순서 뒤바뀜이 함께 준다.
    attempt.batchTimer = timers.setTimeout(() => {
      attempt.batchTimer = null;
      if (!isCurrent(attempt)) return;
      const batch = attempt.unsent;
      attempt.unsent = [];
      sendCandidates(attempt, batch);
    }, LIMITS.CANDIDATE_BATCH_MS);
  }

  function onPcState(peer: string, conn: Conn, state: string): void {
    // 두 상태를 모두 처리한다. 상대가 사라지면 failed 없이 closed 만 오기도 한다.
    if (state === 'failed' || state === 'closed') onConnEnded(peer, conn, state);
  }

  function onConnEnded(peer: string, conn: Conn, state: 'failed' | 'closed'): void {
    const attempt = attemptOf(peer, conn);
    if (attempt !== null) {
      failAttempt(attempt, FAILURES.failed);
      return;
    }
    const link = linkOf(peer, conn);
    if (link === null || link.ending !== null) return;
    // pc 의 닫힘 통지는 채널이 마지막으로 받은 프레임의 콜백보다 먼저 올 수 있다(실측).
    // 한 박자 늦춰 그 프레임(상대의 bye 등)을 받은 뒤에 링크를 끝낸다.
    link.ending = timers.setTimeout(() => {
      link.ending = null;
      endLink(link, state);
    }, 0);
  }

  function onRemoteChannel(peer: string, conn: Conn, channel: NativeChannel): void {
    // 쌍마다 채널은 하나다. 다른 라벨이나 두 번째 채널은 받지 않는다.
    let label = '';
    try {
      label = channel.getLabel();
    } catch {
      label = '';
    }
    if (conn.dc !== null || label !== DATA_CHANNEL_LABEL || attemptOf(peer, conn) === null) {
      try {
        channel.close();
      } catch {
        // 이미 닫힌 채널이다.
      }
      return;
    }
    conn.dc = channel;
    wireChannel(peer, conn, channel);
    // 받은 채널은 이미 열려 있을 수 있다. 열림 콜백이 또 와도 한 번만 처리한다.
    if (channel.isOpen()) onChannelOpen(peer, conn);
  }

  function onChannelOpen(peer: string, conn: Conn): void {
    const attempt = attemptOf(peer, conn);
    if (attempt === null || conn.dc === null || attempt.cid === null || attempt.remoteSid === null) return;
    const slot = slotOf(peer);
    const diag = diagOf(attempt);
    clearAttemptTimers(attempt);
    slot.attempt = null;
    const link: Link = {
      peer,
      sid: attempt.remoteSid,
      cid: attempt.cid,
      conn,
      channel: conn.dc,
      openedAt: now(),
      lastAliveAt: now(),
      nextPing: 1,
      outstanding: new Set(),
      pingTimer: null,
      deadTimer: null,
      ending: null,
      probe: null,
    };
    slot.link = link;
    schedulePing(link);
    armDeadTimer(link);
    event('info', 'link.attempt_end', { ...attemptFields(attempt, diag), outcome: 'ok' });
    emitter.emit('link-open', { peer, sid: link.sid, cid: link.cid });
  }

  // ── 링크 ──────────────────────────────────────────────────────────────────

  function isOpenLink(link: Link): boolean {
    return !stopped && slots.get(link.peer)?.link === link;
  }

  function clearLinkTimers(link: Link): void {
    link.pingTimer = clearTimer(link.pingTimer);
    link.deadTimer = clearTimer(link.deadTimer);
    link.ending = clearTimer(link.ending);
    if (link.probe !== null) timers.clearTimeout(link.probe.timer);
    link.probe = null;
  }

  /** 열린 링크를 닫고 link-closed 를 낸다. 교체 확인 중에 들고 있던 요청이 있으면 이어서 처리한다. */
  function endLink(link: Link, reason: string): void {
    if (!isOpenLink(link)) return;
    const slot = slotOf(link.peer);
    const held = link.probe?.held ?? null;
    const closedAt = now();
    clearLinkTimers(link);
    slot.link = null;
    disposeConn(link.conn);
    event('info', 'link.closed', {
      peer: link.peer,
      sid: link.sid,
      cid: link.cid,
      reason,
      last_alive_age_ms: closedAt - link.lastAliveAt,
      open_ms: closedAt - link.openedAt,
    });
    emitter.emit('link-closed', { peer: link.peer, sid: link.sid, reason });
    // 링크가 없어졌으므로 미뤄 둔 요청은 새 요청으로 받는다.
    if (held !== null && !stopped) handleSignal(held);
  }

  function sendPing(link: Link): number | null {
    const n = link.nextPing;
    link.nextPing += 1;
    let text: string;
    try {
      const info = deps.pingInfo();
      const frame = encodeP2PFrame({ v: LIMITS.P2P_VERSION, t: 'ping', n, sc: info.sc, sf: info.sf });
      if (!frame.ok) {
        event('error', 'link.ping', { peer: link.peer, outcome: 'failed', error_code: frame.code });
        return null;
      }
      text = frame.value;
    } catch {
      event('error', 'link.ping', { peer: link.peer, outcome: 'failed' });
      return null;
    }
    try {
      link.channel.sendMessage(text);
    } catch {
      return null;
    }
    link.outstanding.add(n);
    if (link.outstanding.size > OUTSTANDING_PINGS_MAX) {
      const oldest = link.outstanding.values().next();
      if (oldest.done !== true) link.outstanding.delete(oldest.value);
    }
    return n;
  }

  function schedulePing(link: Link): void {
    link.pingTimer = timers.setTimeout(() => {
      link.pingTimer = null;
      if (!isOpenLink(link)) return;
      sendPing(link);
      schedulePing(link);
    }, LIMITS.P2P_PING_INTERVAL_MS);
  }

  /** 마지막 생존 증거 뒤로 정해진 시간(P2P_DEAD_AFTER_MS)이 지나기 전에 링크를 죽은 것으로 본다. */
  function armDeadTimer(link: Link): void {
    link.deadTimer = clearTimer(link.deadTimer);
    const remaining = LIMITS.P2P_DEAD_AFTER_MS - DEAD_TIMER_LEAD_MS - (now() - link.lastAliveAt);
    link.deadTimer = timers.setTimeout(() => {
      link.deadTimer = null;
      endLink(link, 'ping_timeout');
    }, Math.max(0, remaining));
  }

  function noteAlive(link: Link): void {
    link.lastAliveAt = now();
    armDeadTimer(link);
  }

  function onPong(link: Link, n: number): void {
    // 생존 증거는 내 ping 에 대한 pong 뿐이다(n 이 같다).
    if (!link.outstanding.has(n)) return;
    for (const sent of [...link.outstanding]) {
      if (sent <= n) link.outstanding.delete(sent);
    }
    noteAlive(link);
    const probe = link.probe;
    if (probe !== null && n >= probe.n) {
      // 링크는 살아 있다. 요청을 버리고 링크를 유지한다.
      timers.clearTimeout(probe.timer);
      link.probe = null;
      event('info', 'link.replace_probe', { peer: link.peer, cid: link.cid, outcome: 'kept', duration_ms: now() - probe.startedAt });
    }
  }

  function onMessage(peer: string, conn: Conn, message: string | Buffer | ArrayBuffer): void {
    // 프레임은 텍스트뿐이다.
    if (typeof message !== 'string') return;
    // 상대의 첫 프레임이 내 열림 콜백보다 먼저 올 수 있다. 버리지 않게 먼저 링크로 올린다.
    if (linkOf(peer, conn) === null && conn.dc !== null && conn.dc.isOpen()) onChannelOpen(peer, conn);
    const link = linkOf(peer, conn);
    if (link === null) return;

    if (message.length <= CONTROL_FRAME_MAX_CHARS) {
      const parsed = parseP2PFrame(message);
      if (parsed.ok && parsed.value.t === 'ping') {
        const pong = encodeP2PFrame({ v: LIMITS.P2P_VERSION, t: 'pong', n: parsed.value.n });
        if (pong.ok) {
          try {
            link.channel.sendMessage(pong.value);
          } catch {
            // 닫히는 중이다. 닫힘 콜백이 정리한다.
          }
        }
        emitter.emit('peer-ping', { peer, sc: parsed.value.sc, sf: parsed.value.sf });
        return;
      }
      if (parsed.ok && parsed.value.t === 'pong') {
        onPong(link, parsed.value.n);
        return;
      }
    }
    emitter.emit('frame', { peer, text: message });
  }

  /** 교체 확인: 열린 링크로 ping 을 바로 보내고, 정해진 시간 안에 pong 이 없을 때만 링크를 닫는다. */
  function startProbe(link: Link, held: ServerSignalMessage | null): void {
    if (link.probe !== null) {
      // 확인하는 동안 온 요청은 가장 새 것 하나만 들고 있는다.
      if (held !== null) link.probe.held = held;
      return;
    }
    const sent = sendPing(link);
    const probe: Probe = {
      // ping 을 보내지 못했으면 어떤 pong 도 맞지 않는다. 기한 뒤에 교체된다.
      n: sent ?? link.nextPing,
      startedAt: now(),
      held,
      timer: timers.setTimeout(() => {
        if (link.probe !== probe || !isOpenLink(link)) return;
        event('info', 'link.replace_probe', { peer: link.peer, cid: link.cid, outcome: 'replaced', duration_ms: now() - probe.startedAt });
        endLink(link, 'replaced');
      }, LIMITS.REPLACE_PROBE_MS),
    };
    link.probe = probe;
  }

  // ── 받은 시그널 ───────────────────────────────────────────────────────────

  function addRemoteCandidate(attempt: Attempt, item: CandidateItem): void {
    if (attempt.conn === null) return;
    try {
      attempt.conn.pc.addRemoteCandidate(item.candidate, item.mid);
    } catch {
      event('debug', 'signal.candidate', { peer: attempt.peer, cid: attempt.cid, outcome: 'failed' });
    }
  }

  /** 현재 시도의 후보 하나. 원격 설명이 있으면 넣고, 없으면 시도 큐에 둔다. 넣었거나 뒀으면 참. */
  function acceptCandidate(attempt: Attempt, item: CandidateItem): boolean {
    if (isRelayCandidate(item.candidate)) return false;
    if (attempt.remoteSeen.has(item.candidate)) {
      attempt.dupIgnored += 1;
      return false;
    }
    if (!attempt.remoteDescribed && attempt.queue.length >= LIMITS.CANDIDATE_QUEUE_MAX) return false;
    attempt.remoteSeen.add(item.candidate);
    count(attempt.remote, item.candidate);
    if (attempt.remoteDescribed) addRemoteCandidate(attempt, item);
    else attempt.queue.push(item);
    return true;
  }

  function clearPending(slot: Slot): void {
    if (slot.pending === null) return;
    timers.clearTimeout(slot.pending.timer);
    slot.pending = null;
  }

  function queuePending(slot: Slot, cid: string, parts: CidParts, items: readonly CandidateItem[]): void {
    let pending = slot.pending;
    if (pending !== null && pending.cid !== cid) {
      // 더 작은 순번은 버린다. 더 큰 순번(또는 다시 시작한 상대의 것)이 오면 비우고 새로 시작한다.
      if (pending.sid === parts.sid && parts.seq < pending.seq) return;
      clearPending(slot);
      pending = null;
    }
    if (pending === null) {
      const created: PendingQueue = {
        cid,
        sid: parts.sid,
        seq: parts.seq,
        items: [],
        seen: new Set(),
        // offer 가 끝내 오지 않으면 비운다.
        timer: timers.setTimeout(() => {
          if (slot.pending === created) slot.pending = null;
        }, LIMITS.PEER_CONNECT_TIMEOUT_MS),
      };
      slot.pending = created;
      pending = created;
    }
    for (const item of items) {
      if (isRelayCandidate(item.candidate) || pending.seen.has(item.candidate)) continue;
      if (pending.items.length >= LIMITS.CANDIDATE_QUEUE_MAX) break;
      pending.seen.add(item.candidate);
      pending.items.push(item);
    }
  }

  function onOfferRequest(slot: Slot, signal: ServerSignalMessage): void {
    const current = slot.attempt;
    if (current !== null && current.remoteSid !== null && current.remoteSid !== signal.sid) {
      // answer 를 준 상대와 sid 가 다르다. 같은 이름의 상대가 다시 시작했다(protocol.md 3.2 ① 의 예외).
      // 옛 상대와의 pc 는 새 상대와 열릴 수 없다. 이벤트 없이 끝내고 새 cid 로 다시 건다.
      // answer 쪽의 "진행 중인 시도가 바뀌는 경우"와 같다. 실패가 아니고, 기한과 진단 값은 바뀐 때부터 새로 센다.
      clearAttemptTimers(current);
      if (current.conn !== null) disposeConn(current.conn);
      slot.attempt = null;
      event('info', 'link.attempt_swap', { peer: signal.from, cid: current.cid, sid: signal.sid, reason: 'peer_restarted' });
      startOffer(slot, signal.from);
      return;
    }
    if (current !== null) {
      // 상대가 내 offer 를 못 받았을 수 있다. answer 를 못 받았으면 offer 와 후보 묶음, 받았으면 후보 묶음만 다시 보낸다.
      resendAttempt(current, 'offer_request');
      return;
    }
    if (slot.link !== null) {
      startProbe(slot.link, signal);
      return;
    }
    startOffer(slot, signal.from);
  }

  function rememberOffer(slot: Slot, parts: CidParts): void {
    slot.seenOffers.delete(parts.sid);
    slot.seenOffers.set(parts.sid, parts.seq);
    if (slot.seenOffers.size > SEEN_OFFER_SIDS_MAX) {
      const oldest = slot.seenOffers.keys().next();
      if (oldest.done !== true) slot.seenOffers.delete(oldest.value);
    }
  }

  function onOffer(slot: Slot, signal: Extract<ServerSignalMessage, { kind: 'offer' }>, parts: CidParts): void {
    const peer = signal.from;
    const current = slot.attempt;
    if (current !== null && current.cid === signal.cid) {
      // 중복이다. 상대가 answer 를 못 받았다는 뜻이면 처음 만든 answer 와 후보 묶음을 다시 보낸다.
      current.dupIgnored += 1;
      if (current.localSdp !== null) {
        const description = sendDescription(current);
        const candidates = sendAllCandidates(current);
        if (description || candidates) noteResend(current, 'answer', 'dup_offer');
      }
      return;
    }
    if (slot.link !== null && slot.link.cid === signal.cid) {
      // 열린 링크와 같은 cid 다. 상대가 answer 를 받기 전에 다시 보낸 offer 가 늦게 왔다. 교체 확인 대상이 아니다(protocol.md 3.2).
      // 링크가 열렸다는 것은 상대도 answer 를 받았다는 뜻이라 answer 를 다시 보내지 않는다.
      event('debug', 'signal.ignored', { peer, cid: signal.cid, kind: 'offer', reason: 'dup_offer_open_link' });
      return;
    }
    const seen = slot.seenOffers.get(parts.sid);
    if (seen !== undefined && parts.seq < seen) {
      event('debug', 'signal.ignored', { peer, cid: signal.cid, kind: 'offer', reason: 'old_offer' });
      return;
    }
    if (isRelayCandidate(signal.data.sdp)) {
      event('warn', 'signal.ignored', { peer, cid: signal.cid, kind: 'offer', reason: 'relay' });
      return;
    }
    if (slot.link !== null) {
      startProbe(slot.link, signal);
      return;
    }

    let attempt: Attempt;
    if (current !== null && current.conn !== null) {
      // 진행 중인 시도가 새 cid 로 바뀐다(다시 시작한 상대, 먼저 포기하고 다시 건 상대). 시도의 끝이 아니다.
      // 이벤트를 내지 않고, 기한과 진단 값은 바뀐 때부터 새로 센다.
      clearAttemptTimers(current);
      disposeConn(current.conn);
      attempt = newAttempt(peer, 'await-open');
      event('info', 'link.attempt_swap', { peer, cid: signal.cid, sid: signal.sid });
    } else if (current !== null) {
      // offer-request 를 보내고 기다리던 시도가 첫 offer 를 받았다. 같은 시도가 이어진다. 기한을 새로 재지 않는다.
      attempt = current;
    } else {
      attempt = newAttempt(peer, 'await-open');
    }
    slot.attempt = attempt;
    attempt.phase = 'await-open';
    attempt.cid = signal.cid;
    attempt.remoteSid = signal.sid;
    rememberOffer(slot, parts);

    const conn = createConn(peer);
    if (conn === null) {
      failAttempt(attempt, FAILURES.failed);
      return;
    }
    attempt.conn = conn;
    try {
      // offer 를 넣으면 answer 가 콜백으로 온다. 같은 cid 로 보낸다.
      conn.pc.setRemoteDescription(signal.data.sdp, 'offer');
    } catch {
      failAttempt(attempt, FAILURES.failed);
      return;
    }
    attempt.remoteDescribed = true;

    // offer 보다 먼저 와 대기 큐에 있던 후보를 원격 설명을 적용한 뒤에 넣는다.
    const pending = slot.pending;
    if (pending !== null && pending.cid === signal.cid) {
      for (const item of pending.items) {
        if (acceptCandidate(attempt, item)) attempt.queuedApplied += 1;
      }
      clearPending(slot);
    } else if (pending !== null && pending.sid === parts.sid && pending.seq < parts.seq) {
      clearPending(slot);
    }
  }

  function onAnswer(slot: Slot, signal: Extract<ServerSignalMessage, { kind: 'answer' }>): void {
    const attempt = slot.attempt;
    // 현재 시도의 cid 와 같고 아직 원격 설명이 없을 때만 적용한다.
    if (attempt === null || attempt.cid !== signal.cid || attempt.conn === null) return;
    if (attempt.remoteDescribed) {
      attempt.dupIgnored += 1;
      return;
    }
    if (isRelayCandidate(signal.data.sdp)) {
      event('warn', 'signal.ignored', { peer: signal.from, cid: signal.cid, kind: 'answer', reason: 'relay' });
      return;
    }
    try {
      attempt.conn.pc.setRemoteDescription(signal.data.sdp, 'answer');
    } catch {
      // 받아들이지 못한 answer 다. 시도는 그대로 두고 올바른 answer 나 기한을 기다린다.
      event('warn', 'signal.ignored', { peer: signal.from, cid: signal.cid, kind: 'answer', reason: 'rejected' });
      return;
    }
    attempt.remoteDescribed = true;
    attempt.remoteSid = signal.sid;
    attempt.phase = 'await-open';
    const queued = attempt.queue;
    attempt.queue = [];
    for (const item of queued) addRemoteCandidate(attempt, item);
  }

  function onCandidate(
    slot: Slot,
    signal: Extract<ServerSignalMessage, { kind: 'candidate' }>,
    parts: CidParts,
    iOffer: boolean,
  ): void {
    const attempt = slot.attempt;
    if (attempt !== null && attempt.cid === signal.cid) {
      for (const item of signal.data.list) acceptCandidate(attempt, item);
      return;
    }
    if (!iOffer && parts.seq > (slot.seenOffers.get(parts.sid) ?? -1)) {
      // 아직 오지 않은 offer 의 후보다. offer 쪽에는 offer 가 오기 전까지 그 cid 의 시도가 없다.
      queuePending(slot, signal.cid, parts, signal.data.list);
      return;
    }
    // 옛 시도의 후보다.
    event('debug', 'signal.ignored', { peer: signal.from, cid: signal.cid, kind: 'candidate', reason: 'old_attempt' });
  }

  function handleSignal(signal: ServerSignalMessage): void {
    if (stopped) return;
    const peer = signal.from;
    if (peer === self.peer) return;
    const iOffer = isOfferSide(self.peer, peer);
    const slot = slotOf(peer);

    if (signal.kind === 'offer-request') {
      // offer 는 항상 이름이 작은 쪽만 만든다.
      if (iOffer) onOfferRequest(slot, signal);
      else event('debug', 'signal.ignored', { peer, kind: 'offer-request', reason: 'not_offer_side' });
      return;
    }

    // cid 의 앞부분은 offer 쪽의 sid 여야 한다. offer 쪽이 나면 내 sid, 상대면 서버가 붙인 sid 다.
    const parts = parseCid(signal.cid);
    if (!parts.ok || parts.value.sid !== (iOffer ? self.sid : signal.sid)) {
      event('debug', 'signal.ignored', { peer, cid: signal.cid, kind: signal.kind, reason: 'cid_sid' });
      return;
    }
    switch (signal.kind) {
      case 'offer':
        if (iOffer) event('debug', 'signal.ignored', { peer, cid: signal.cid, kind: 'offer', reason: 'not_answer_side' });
        else onOffer(slot, signal, parts.value);
        return;
      case 'answer':
        if (iOffer) onAnswer(slot, signal);
        else event('debug', 'signal.ignored', { peer, cid: signal.cid, kind: 'answer', reason: 'not_offer_side' });
        return;
      case 'candidate':
        onCandidate(slot, signal, parts.value, iOffer);
        return;
    }
  }

  // ── 공개 진입점 ───────────────────────────────────────────────────────────

  return {
    on: (name, listener) => emitter.on(name, listener),

    contact(peer: string): void {
      if (stopped || peer === self.peer) return;
      const slot = slotOf(peer);
      if (slot.link !== null || slot.attempt !== null) return;
      if (isOfferSide(self.peer, peer)) startOffer(slot, peer);
      else startOfferRequest(slot, peer);
    },

    handleSignal,

    handleRelayError(error): void {
      if (stopped) return;
      const attempt = slots.get(error.to)?.attempt ?? null;
      if (attempt === null) return;
      // 그 signal 을 보낸 시도에만 적용한다. cid 가 없는 것은 offer-request 의 오류다.
      if (error.cid === null ? attempt.phase !== 'await-offer' : error.cid !== attempt.cid) return;
      switch (error.code) {
        case 'PEER_NOT_FOUND':
          failAttempt(attempt, FAILURES.peerGone);
          return;
        case 'SERVER_ERROR':
          resendNow(attempt, 'server_error');
          return;
        case 'RELAY_NOT_ALLOWED':
          // 실패 분류에 이 경우의 사유가 따로 없어 "pc 가 닫혔다"로 끝낸다. 원인은 로그의 error_code 로 남긴다.
          failAttempt(attempt, FAILURES.failed, 'RELAY_NOT_ALLOWED');
          return;
      }
    },

    expireAttempt(peer: string): void {
      if (stopped) return;
      const attempt = slots.get(peer)?.attempt ?? null;
      if (attempt !== null) expire(attempt);
    },

    resendPending(): void {
      if (stopped) return;
      for (const slot of [...slots.values()]) {
        if (slot.attempt !== null) resendNow(slot.attempt, 'gateway_frame');
      }
    },

    probe(peer: string): void {
      if (stopped) return;
      const link = slots.get(peer)?.link ?? null;
      if (link !== null) startProbe(link, null);
    },

    markAlive(peer: string): void {
      if (stopped) return;
      const link = slots.get(peer)?.link ?? null;
      if (link !== null) noteAlive(link);
    },

    send(peer: string, text: string): MeshSendResult {
      const link = stopped ? null : (slots.get(peer)?.link ?? null);
      if (link === null) return 'not_open';
      if (utf8ByteLength(text) > LIMITS.P2P_MAX_FRAME_BYTES) return 'too_large';
      try {
        if (!link.channel.isOpen()) return 'not_open';
        link.channel.sendMessage(text);
        return 'ok';
      } catch {
        return 'not_open';
      }
    },

    closeLink(peer: string, reason: string): void {
      if (stopped) return;
      const link = slots.get(peer)?.link ?? null;
      if (link !== null) endLink(link, reason);
    },

    links(): readonly MeshLink[] {
      const list: MeshLink[] = [];
      if (stopped) return list;
      for (const [peer, slot] of slots) {
        if (slot.link !== null) list.push({ peer, sid: slot.link.sid, state: 'open' });
        else if (slot.attempt !== null) list.push({ peer, sid: slot.attempt.remoteSid, state: 'connecting' });
      }
      return list;
    },

    netInfo(): MeshNetInfo {
      return { srflx_seen: srflxSeen };
    },

    shutdown(): Promise<void> {
      if (shutdownDone !== null) return shutdownDone;
      stopped = true;
      emitter.stop();
      for (const slot of slots.values()) {
        if (slot.attempt !== null) {
          clearAttemptTimers(slot.attempt);
          if (slot.attempt.conn !== null) disposeConn(slot.attempt.conn);
        }
        if (slot.link !== null) {
          clearLinkTimers(slot.link);
          disposeConn(slot.link.conn);
        }
        clearPending(slot);
      }
      slots.clear();
      // 네이티브 정리는 프로세스 전체의 것이다. 이 호출과 같은 박자에 닫힌 다른 pc 의 close() 가 모두 불린 뒤에 한다.
      shutdownDone = Promise.resolve().then(() => {
        try {
          native.cleanup();
        } catch {
          event('error', 'mesh.cleanup', { outcome: 'failed' });
        }
      });
      return shutdownDone;
    },
  };
}
