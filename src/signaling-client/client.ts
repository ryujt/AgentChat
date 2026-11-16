// 시그널링 클라이언트 (architecture.md 3.5, protocol.md 2.4~2.7).
// 접속, 등록, signal 송수신, ping 놓침 계산, 재접속 루프, 게이트웨이 프레임 판별을 한다.
// WebRTC 와 방의 의미는 모른다.

import type { LogFields, LogLevel } from '../diagnostics/log-port.js';
import {
  LIMITS,
  encodeClientMessage,
  parseServerMessage,
  refOf,
  type ErrorMessage,
  type JoinMode,
  type JoinedMessage,
  type PongMessage,
  type SignalErrorCode,
  type SignalPayload,
  type TimerHandle,
} from '../protocol/index.js';
import type {
  RelayError,
  SignalingBlockReason,
  SignalingClient,
  SignalingClientDeps,
  SignalingClientEvents,
  SignalingJoinFailure,
  SignalingJoinRequest,
  SignalingJoined,
  SignalingSocket,
  SignalingState,
} from './contract.js';
import { createEmitter } from './emitter.js';
import { openWsSocket } from './ws-socket.js';

const MODULE = 'signaling-client';

// 응답이 흔적 없이 사라진 join 을 같은 id 로 다시 보내는 주기. 설계에 값이 따로 없어 시그널 재전송 주기를 쓴다.
const JOIN_SILENT_RESEND_MS = LIMITS.SIGNAL_RESEND_MS;

// leave 를 보낸 뒤 소켓이 닫히기를 기다리는 시간. 넘으면 기다리지 않고 끝낸다(종료 예산을 넘기지 않게).
const LEAVE_CLOSE_WAIT_MS = 300;

// 서버 오류를 되짚을 수 있게 기억하는 보낸 signal 의 수. 넘으면 오래된 것부터 잊는다.
const SENT_SIGNAL_MEMORY = 256;

/**
 * - idle: join() 전.
 * - joining: 첫 등록을 기다린다. 실패하면 끝난다.
 * - online: 지금 소켓으로 등록돼 있다.
 * - reconnecting: 다시 붙는 중이다.
 * - detached: 재접속을 멈췄다.
 * - closed: 끝났다. 이벤트를 내지 않는다.
 */
type Phase = 'idle' | 'joining' | 'online' | 'reconnecting' | 'detached' | 'closed';

/** joined 를 기다리는 join 하나. 같은 연결에 다시 보낼 때 같은 글을 쓴다(같은 id). */
interface JoinExchange {
  readonly id: string;
  readonly text: string;
  requestedAt: number;
  /** 기한이 찼을 때의 결과를 정한다. 서버가 SERVER_ERROR 로만 답했으면 그 코드다. */
  serverErrorSeen: boolean;
  deadline: TimerHandle;
  resend: TimerHandle | null;
}

interface PingExchange {
  readonly id: string;
  readonly requestedAt: number;
  readonly timeout: TimerHandle;
}

interface JoinWaiter {
  readonly resolve: (joined: SignalingJoined) => void;
  readonly reject: (failure: SignalingJoinFailure) => void;
}

function isBlockReason(code: SignalErrorCode): code is 'ROOM_FULL' | 'NAME_IN_USE' {
  return code === 'ROOM_FULL' || code === 'NAME_IN_USE';
}

function isRelayErrorCode(code: SignalErrorCode): code is RelayError['code'] {
  return code === 'PEER_NOT_FOUND' || code === 'SERVER_ERROR' || code === 'RELAY_NOT_ALLOWED';
}

export function createSignalingClient(deps: SignalingClientDeps): SignalingClient {
  const { now, timers, log } = deps;
  const random = deps.random ?? Math.random;
  const openSocket = deps.openSocket ?? openWsSocket;
  const emitter = createEmitter<SignalingClientEvents>(log);

  let phase: Phase = 'idle';
  let request: SignalingJoinRequest | null = null;
  let waiter: JoinWaiter | null = null;

  // 소켓 세대. 버린 소켓의 늦은 호출을 가린다.
  let generation = 0;
  let socket: SignalingSocket | null = null;
  let connectTimer: TimerHandle | null = null;
  let exchange: JoinExchange | null = null;
  /** 이 소켓에서 NOT_JOINED 로 이미 한 번 다시 등록했는가. 두 번째는 소켓을 버린다. */
  let reRegistered = false;

  let seq = 0;
  let idCounter = 0;

  let pingTimer: TimerHandle | null = null;
  let ping: PingExchange | null = null;
  let misses = 0;

  let backoffTimer: TimerHandle | null = null;
  let failedAttempts = 0;
  let blockReason: SignalingBlockReason | null = null;
  let reported: { state: SignalingState; reason: SignalingBlockReason | null } | null = null;

  const sentSignals = new Map<string, { readonly to: string; readonly cid: string | null }>();
  const counts = { unknownType: 0, emptyFrame: 0, badFrame: 0 };

  let leaving: { readonly generation: number; readonly finish: () => void } | null = null;

  function event(level: LogLevel, name: string, fields: LogFields = {}): void {
    const base: LogFields = request === null ? {} : { room_ref: refOf(request.room), sid: request.sid };
    log.event(level, MODULE, name, { ...base, ...fields });
  }

  function nextId(prefix: string): string {
    idCounter += 1;
    return `${prefix}${idCounter.toString(36)}`;
  }

  function clearTimer(handle: TimerHandle | null): null {
    if (handle !== null) timers.clearTimeout(handle);
    return null;
  }

  function setState(state: SignalingState, reason: SignalingBlockReason | null): void {
    if (reported !== null && reported.state === state && reported.reason === reason) return;
    reported = { state, reason };
    event(state === 'connected' ? 'info' : 'warn', 'signal.state', { state, reason, seq });
    emitter.emit('state', { state, reason });
  }

  // ── 소켓 ──────────────────────────────────────────────────────────────────

  function stopPing(): void {
    pingTimer = clearTimer(pingTimer);
    if (ping !== null) timers.clearTimeout(ping.timeout);
    ping = null;
    misses = 0;
  }

  function clearExchange(): void {
    if (exchange === null) return;
    timers.clearTimeout(exchange.deadline);
    clearTimer(exchange.resend);
    exchange = null;
  }

  /** 지금 소켓을 버린다. 세대를 올려 그 소켓의 늦은 호출을 모두 무시한다. */
  function dropSocket(): void {
    generation += 1;
    connectTimer = clearTimer(connectTimer);
    clearExchange();
    stopPing();
    sentSignals.clear();
    reRegistered = false;
    const old = socket;
    socket = null;
    if (old !== null) {
      try {
        old.close();
      } catch {
        // 주입받은 소켓이 던져도 정리는 이어 간다.
      }
    }
  }

  function connect(): void {
    generation += 1;
    const mine = generation;
    connectTimer = timers.setTimeout(() => {
      if (mine !== generation) return;
      connectTimer = null;
      event('warn', 'signal.error', { error_code: 'SERVER_UNREACHABLE', reason: 'connect_timeout', outcome: 'unknown' });
      connectionFailed();
    }, LIMITS.SIGNAL_CONNECT_TIMEOUT_MS);

    let opened: SignalingSocket | null = null;
    try {
      opened = openSocket(deps.url, {
        onOpen: () => {
          if (mine === generation) handleOpen();
        },
        onText: (text) => {
          if (mine === generation) handleText(text);
        },
        onClose: () => {
          if (leaving !== null && leaving.generation === mine) {
            leaving.finish();
            return;
          }
          if (mine !== generation) return;
          event('info', 'signal.error', { reason: 'socket_closed' });
          connectionFailed();
        },
      });
    } catch {
      opened = null;
    }
    // 여는 중에 닫힘이 먼저 처리됐으면 이 소켓은 이미 버린 것이다.
    if (mine !== generation) {
      try {
        opened?.close();
      } catch {
        // 버리는 소켓이다.
      }
      return;
    }
    if (opened === null) {
      connectionFailed();
      return;
    }
    socket = opened;
  }

  /** 지금 소켓으로는 더 갈 수 없다. 단계에 따라 실패로 끝내거나 다시 붙는다. */
  function connectionFailed(retryAfterMs = 0): void {
    if (phase === 'joining') {
      failJoin({ code: 'SERVER_UNREACHABLE' });
    } else if (phase === 'online' || phase === 'reconnecting') {
      beginReconnect(retryAfterMs);
    }
  }

  // ── join ──────────────────────────────────────────────────────────────────

  function buildJoin(id: string, mode: JoinMode, joinSeq: number): string | null {
    if (request === null) return null;
    const encoded = encodeClientMessage({
      action: 'join',
      v: LIMITS.SIGNAL_VERSION,
      id,
      room: request.room,
      peer: request.peer,
      sid: request.sid,
      key: request.key,
      mode,
      seq: joinSeq,
    });
    return encoded.ok ? encoded.value : null;
  }

  function startExchange(mode: JoinMode): void {
    const id = nextId('j');
    const text = buildJoin(id, mode, seq);
    if (text === null || socket === null) {
      // 첫 join 은 보내기 전에 검증했다. 여기에 오면 결함이다.
      event('error', 'signal.error', { error_code: 'BAD_MESSAGE', reason: 'join_encode' });
      connectionFailed();
      return;
    }
    const mine = generation;
    const deadline = timers.setTimeout(() => {
      if (mine !== generation || exchange === null || exchange.id !== id) return;
      const serverError = exchange.serverErrorSeen;
      event('warn', 'signal.error', {
        error_code: serverError ? 'SERVER_ERROR' : 'SERVER_UNREACHABLE',
        reason: 'request_timeout',
        outcome: 'unknown',
      });
      if (phase === 'joining') failJoin({ code: serverError ? 'SERVER_ERROR' : 'SERVER_UNREACHABLE' });
      else connectionFailed();
    }, LIMITS.SIGNAL_REQUEST_TIMEOUT_MS);
    exchange = { id, text, requestedAt: now(), serverErrorSeen: false, deadline, resend: null };
    socket.send(text);
    scheduleJoinResend(JOIN_SILENT_RESEND_MS);
  }

  /** 같은 join 을 같은 연결에 다시 보낸다. 기한은 늘리지 않는다(기한 타이머가 따로 끝낸다). */
  function scheduleJoinResend(delayMs: number): void {
    if (exchange === null) return;
    const current = exchange;
    clearTimer(current.resend);
    current.resend = timers.setTimeout(() => {
      if (exchange !== current || socket === null) return;
      current.resend = null;
      current.requestedAt = now();
      socket.send(current.text);
      scheduleJoinResend(JOIN_SILENT_RESEND_MS);
    }, delayMs);
  }

  function gatewayRetryDelay(): number {
    const span = LIMITS.GATEWAY_JOIN_RETRY_MAX_MS - LIMITS.GATEWAY_JOIN_RETRY_MIN_MS;
    return LIMITS.GATEWAY_JOIN_RETRY_MIN_MS + Math.floor(random() * span);
  }

  function handleOpen(): void {
    connectTimer = clearTimer(connectTimer);
    if (phase !== 'joining' && phase !== 'reconnecting') return;
    // 접속 순번은 새 연결에서 join 을 보낼 때마다 오른다. 서버가 옛 연결의 늦은 join 을 가리는 값이다.
    // 같은 key 를 여러 클라이언트가 이어 쓰면 프로세스에 하나인 값을 받아 쓴다.
    seq = deps.nextSeq === undefined ? seq + 1 : deps.nextSeq();
    startExchange(phase === 'joining' && request !== null ? request.mode : 'resume');
  }

  function handleJoined(message: JoinedMessage): void {
    if (exchange === null || message.re !== exchange.id) return;
    const requestedAt = exchange.requestedAt;
    clearExchange();
    const first = phase === 'joining';
    phase = 'online';
    failedAttempts = 0;
    blockReason = null;
    schedulePing(LIMITS.SIGNAL_PING_INTERVAL_MS);
    if (first) {
      const pending = waiter;
      waiter = null;
      pending?.resolve({ members: message.members, requestedAt });
      setState('connected', null);
    } else {
      setState('connected', null);
      emitter.emit('members', { members: message.members, requestedAt, source: 'joined' });
    }
  }

  function failJoin(failure: SignalingJoinFailure): void {
    const pending = waiter;
    waiter = null;
    terminate();
    pending?.reject(failure);
  }

  function handleJoinError(message: ErrorMessage): void {
    if (exchange === null) return;
    if (message.code === 'SERVER_ERROR') {
      // 같은 연결에 같은 join 을 다시 보낸다. 바로 보내면 서버 장애 때 되풀이가 빨라져 잠깐 쉰다.
      exchange.serverErrorSeen = true;
      scheduleJoinResend(gatewayRetryDelay());
      return;
    }
    if (phase === 'joining') {
      const failure: { code: SignalErrorCode; retryAfterMs?: number; supported?: readonly number[] } = {
        code: message.code,
      };
      if (message.retry_after_ms !== undefined) failure.retryAfterMs = message.retry_after_ms;
      if (message.supported !== undefined) failure.supported = message.supported;
      failJoin(failure);
      return;
    }
    if (isBlockReason(message.code)) {
      // 끊긴 사이 자리나 이름을 다른 참가자가 차지했다. 멈추지 않고 상한 간격으로 계속 시도한다.
      blockReason = message.code;
      beginReconnect(LIMITS.RECONNECT_BACKOFF_MAX_MS, true);
      return;
    }
    if (message.code === 'UNSUPPORTED_VERSION') {
      detach();
      return;
    }
    connectionFailed(message.retry_after_ms ?? 0);
  }

  // ── 재접속 ────────────────────────────────────────────────────────────────

  function backoffCap(): number {
    const grown = LIMITS.RECONNECT_BACKOFF_BASE_MS * LIMITS.RECONNECT_BACKOFF_FACTOR ** failedAttempts;
    return Math.min(LIMITS.RECONNECT_BACKOFF_MAX_MS, grown);
  }

  /**
   * 소켓을 버리고 대기 뒤 다시 붙는다. 루프는 이것 하나다.
   * @param minDelayMs 서버가 알려 준 최소 대기(RATE_LIMITED), 또는 막혔을 때의 상한 간격.
   * @param fixed 참이면 무작위 대기를 쓰지 않고 minDelayMs 그대로 기다린다.
   */
  function beginReconnect(minDelayMs = 0, fixed = false): void {
    if (phase !== 'online' && phase !== 'reconnecting') return;
    phase = 'reconnecting';
    dropSocket();
    backoffTimer = clearTimer(backoffTimer);
    const jittered = Math.floor(random() * backoffCap());
    const delay = fixed ? minDelayMs : Math.max(minDelayMs, jittered);
    failedAttempts += 1;
    setState('reconnecting', blockReason);
    event('info', 'signal.state', { state: 'reconnecting', reason: blockReason, attempt: failedAttempts, backoff_ms: delay });
    backoffTimer = timers.setTimeout(() => {
      backoffTimer = null;
      if (phase === 'reconnecting') connect();
    }, delay);
  }

  function detach(): void {
    phase = 'detached';
    blockReason = 'UNSUPPORTED_VERSION';
    dropSocket();
    backoffTimer = clearTimer(backoffTimer);
    setState('detached', 'UNSUPPORTED_VERSION');
  }

  /**
   * signal 의 NOT_JOINED: 서버에 이 연결의 등록이 없다(서버는 등록부터 찾는다). 같은 연결에 join(mode=resume) 을 다시 보내면
   * 등록이 없으므로 정원을 다시 판정받는다. ping 의 NOT_JOINED 는 여기로 오지 않고 새 연결로 다시 등록한다(handleError).
   */
  function reRegister(): void {
    if (phase !== 'online') return;
    if (reRegistered) {
      // 다시 등록했는데도 등록이 없다고 한다. 이 연결로는 풀리지 않는다.
      beginReconnect();
      return;
    }
    reRegistered = true;
    phase = 'reconnecting';
    stopPing();
    sentSignals.clear();
    setState('reconnecting', blockReason);
    startExchange('resume');
  }

  // ── ping ──────────────────────────────────────────────────────────────────

  function schedulePing(delayMs: number): void {
    pingTimer = clearTimer(pingTimer);
    pingTimer = timers.setTimeout(() => {
      pingTimer = null;
      sendPing();
    }, Math.max(0, delayMs));
  }

  function sendPing(): void {
    if (phase !== 'online' || socket === null) return;
    const id = nextId('p');
    const encoded = encodeClientMessage({ action: 'ping', id });
    if (!encoded.ok) return;
    const mine = generation;
    const timeout = timers.setTimeout(() => {
      if (mine === generation && ping !== null && ping.id === id) pingMissed('timeout');
    }, LIMITS.SIGNAL_PONG_TIMEOUT_MS);
    ping = { id, requestedAt: now(), timeout };
    socket.send(encoded.value);
  }

  /** 응답은 같은 re 의 pong 뿐이다. 그 밖(기한, 게이트웨이 프레임, 그 ping 의 오류)은 놓친 것이다. */
  function pingMissed(cause: string): void {
    if (ping === null) return;
    timers.clearTimeout(ping.timeout);
    ping = null;
    misses += 1;
    event('warn', 'signal.ping_miss', { misses, reason: cause, outcome: 'unknown' });
    if (misses >= LIMITS.SIGNAL_PING_MISS_MAX) {
      beginReconnect();
      return;
    }
    schedulePing(LIMITS.SIGNAL_PING_RETRY_MS);
  }

  function handlePong(message: PongMessage): void {
    if (phase !== 'online' || ping === null || message.re !== ping.id) return;
    const requestedAt = ping.requestedAt;
    timers.clearTimeout(ping.timeout);
    ping = null;
    misses = 0;
    schedulePing(LIMITS.SIGNAL_PING_INTERVAL_MS - (now() - requestedAt));
    emitter.emit('members', { members: message.members, requestedAt, source: 'pong' });
  }

  // ── 받은 프레임 ───────────────────────────────────────────────────────────

  function handleGatewayFrame(frameBytes: number): void {
    event('warn', 'signal.gateway_frame', { frame_len: frameBytes });
    // 프레임에 re 가 없어 어느 요청이 사라졌는지 모른다. 그때의 상태로 다룬다. 겹쳐서 적용한다.
    if (exchange !== null) scheduleJoinResend(gatewayRetryDelay());
    if (ping !== null) pingMissed('gateway_frame');
    emitter.emit('gateway-frame');
  }

  function handleError(message: ErrorMessage): void {
    event('warn', 'signal.error', { error_code: message.code });
    const re = message.re;

    if (exchange !== null) {
      // 등록을 기다리는 동안 이 연결에 걸린 요청은 join 하나뿐이다. re 가 없는 오류도 그 join 의 것이다.
      if (re === undefined || re === exchange.id) handleJoinError(message);
      return;
    }
    if (phase !== 'online') return;

    if (message.code === 'REPLACED') {
      // 더 새로운 연결이 내 이름으로 등록됐다. 치명이 아니다. 끊김과 똑같이 다룬다.
      beginReconnect();
      return;
    }
    if (message.code === 'RATE_LIMITED') {
      beginReconnect(message.retry_after_ms ?? 0);
      return;
    }
    if (message.code === 'NOT_JOINED') {
      // 지금 등록으로 보낸 요청(또는 re 가 없는 것)의 NOT_JOINED 만 본다. 재등록 때 보낸 signal 의 기억을 비우므로,
      // 모르는 re 는 재등록 전에 보낸 요청이다. 공용 서버는 응답 순서가 바뀌어 그 답이 재등록 뒤에 올 수 있다(protocol.md 2.4).
      if (re !== undefined && !sentSignals.has(re) && ping?.id !== re) {
        event('info', 'signal.error', { error_code: 'NOT_JOINED', reason: 'stale_not_joined', outcome: 'ignored' });
        return;
      }
      if (ping !== null && re === ping.id) {
        // ping 의 NOT_JOINED 는 대개 이 연결의 등록이 남은 채 참가자 기록이 오래됐거나 지워졌거나 인계된 경우다.
        // 서버는 등록된 연결의 join 을 다시 판정하지 않고 joined 만 다시 보내므로, 같은 연결로는 목록에 돌아가지 못한다.
        // 그런데도 joined 를 받아 connected 로 알리면 다음 ping(30초)까지 상대의 시그널이 모두 PEER_NOT_FOUND 로 끝난다.
        // 그래서 곧바로 새 연결로 다시 등록해 정원을 다시 판정받는다(검토 2차 CONNECT-R2-01, protocol.md 2.3 ping 2번).
        event('info', 'signal.error', { error_code: 'NOT_JOINED', reason: 'ping_not_joined', outcome: 'reconnect' });
        timers.clearTimeout(ping.timeout);
        ping = null;
        beginReconnect();
        return;
      }
      reRegister();
      return;
    }
    if (re === undefined) return;

    if (ping !== null && re === ping.id) {
      pingMissed(message.code === 'SERVER_ERROR' ? 'server_error' : 'rejected');
      return;
    }
    const sent = sentSignals.get(re);
    if (sent === undefined) return;
    if (isRelayErrorCode(message.code)) {
      if (message.code !== 'SERVER_ERROR') sentSignals.delete(re);
      emitter.emit('relay-error', { to: sent.to, cid: sent.cid, code: message.code });
    }
  }

  function handleText(text: string): void {
    const parsed = parseServerMessage(text);
    if (!parsed.ok) {
      switch (parsed.code) {
        case 'GATEWAY_FRAME':
          handleGatewayFrame(parsed.frameBytes);
          return;
        case 'EMPTY_FRAME':
          counts.emptyFrame += 1;
          event('debug', 'signal.gateway_frame', { frame_len: 0, dup_ignored: counts.emptyFrame });
          return;
        case 'UNKNOWN_TYPE':
          counts.unknownType += 1;
          event('debug', 'signal.error', { reason: 'unknown_type', dup_ignored: counts.unknownType });
          return;
        case 'BAD_MESSAGE':
          counts.badFrame += 1;
          event('warn', 'signal.error', {
            error_code: 'BAD_MESSAGE',
            reason: 'server_frame',
            frame_len: parsed.frameBytes,
            dup_ignored: counts.badFrame,
          });
          return;
      }
    }
    const message = parsed.value;
    switch (message.type) {
      case 'signal':
        // 소켓이 열린 순간부터 낸다. joined 보다 먼저 온 offer 를 버리면 입장이 기한까지 멈춘다.
        emitter.emit('signal', message);
        return;
      case 'joined':
        handleJoined(message);
        return;
      case 'pong':
        handlePong(message);
        return;
      case 'error':
        handleError(message);
        return;
    }
  }

  // ── 끝내기 ────────────────────────────────────────────────────────────────

  /** 타이머와 소켓을 모두 정리하고 이벤트를 멈춘다. 기다리는 join 은 부르는 쪽이 끝낸다. */
  function terminate(): void {
    phase = 'closed';
    dropSocket();
    backoffTimer = clearTimer(backoffTimer);
    emitter.stop();
  }

  return {
    on: (name, listener) => emitter.on(name, listener),

    join(joinRequest: SignalingJoinRequest): Promise<SignalingJoined> {
      if (phase !== 'idle') return Promise.reject({ code: 'CLOSED' } satisfies SignalingJoinFailure);
      request = joinRequest;
      // 서버가 거절할 join 은 접속하기 전에 걸러 낸다.
      if (buildJoin('check', joinRequest.mode, 1) === null) {
        terminate();
        return Promise.reject({ code: 'BAD_MESSAGE' } satisfies SignalingJoinFailure);
      }
      phase = 'joining';
      return new Promise<SignalingJoined>((resolve, reject) => {
        waiter = { resolve, reject };
        connect();
      });
    },

    sendSignal(to: string, payload: SignalPayload): boolean {
      if (phase !== 'online' || socket === null || request === null) return false;
      if (to === request.peer) return false;
      const id = nextId('s');
      const encoded = encodeClientMessage({ action: 'signal', id, to, ...payload });
      if (!encoded.ok) {
        event('warn', 'signal.error', { error_code: encoded.code, reason: 'signal_encode', kind: payload.kind });
        return false;
      }
      if (!socket.send(encoded.value)) return false;
      sentSignals.set(id, { to, cid: payload.kind === 'offer-request' ? null : payload.cid });
      if (sentSignals.size > SENT_SIGNAL_MEMORY) {
        const oldest = sentSignals.keys().next();
        if (oldest.done !== true) sentSignals.delete(oldest.value);
      }
      return true;
    },

    leave(): Promise<void> {
      if (phase === 'closed' || phase === 'idle') {
        if (phase === 'idle') terminate();
        return Promise.resolve();
      }
      const registered = phase === 'online' ? socket : null;
      const pending = waiter;
      waiter = null;

      if (registered === null) {
        terminate();
        pending?.reject({ code: 'CLOSED' });
        return Promise.resolve();
      }

      // 등록된 소켓은 leave 가 나간 뒤에 닫는다. 세대만 올려 다른 처리를 멈춘다.
      const mine = generation;
      const encoded = encodeClientMessage({ action: 'leave', id: nextId('l') });
      if (encoded.ok) registered.send(encoded.value);
      socket = null;
      terminate();
      return new Promise<void>((resolve) => {
        const wait = timers.setTimeout(() => leaving?.finish(), LEAVE_CLOSE_WAIT_MS);
        leaving = {
          generation: mine,
          finish: () => {
            leaving = null;
            timers.clearTimeout(wait);
            resolve();
          },
        };
        try {
          registered.close();
        } catch {
          leaving?.finish();
        }
      });
    },

    close(): void {
      const pending = waiter;
      waiter = null;
      if (phase !== 'closed') terminate();
      leaving?.finish();
      pending?.reject({ code: 'CLOSED' });
    },
  };
}
