// 자체 호스팅 시그널링 서버의 리스너 (architecture.md 3.3, deployment.md 3절).
// 맡는 일: HTTP 업그레이드 수락, 핸드셰이크 검사(Origin, 연결 수), 프레임 크기 제한, 미입장 기한,
// 죽은 소켓 정리, 느린 상대 끊기, /healthz, 종료 처리. 규칙 판단은 signaling-core 에 맡긴다.
// 지킬 것은 하나다: 한 연결의 잘못된 입력·단절·느림이 다른 연결을 멈추지 않는다.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import type { ServerLogPort } from '../diagnostics/log-port.js';
import { LIMITS, refOf } from '../protocol/index.js';
import type { Now, TimerHandle, Timers } from '../protocol/index.js';
import { createSignalingCore } from '../signaling-core/index.js';
import type { ConnId, ConnectionSink } from '../signaling-core/index.js';
import { createMemoryRoomStore } from './memory-store.js';

/** 실행 옵션으로 바꿀 수 있는 한도 (deployment.md 3.1). 와이어 계약에는 없다. 클라이언트가 기대지 않는다. */
export interface SelfHostLimits {
  /** 총 연결 수. 넘으면 업그레이드를 HTTP 503 으로 거절한다. */
  readonly maxConnections: number;
  /** 주소별 연결 수. 넘으면 HTTP 429 로 거절한다. */
  readonly maxConnectionsPerIp: number;
  /** 연결 뒤 이 시간 안에 등록되지 않으면 닫는다. */
  readonly joinDeadlineMs: number;
  /** 켜면 X-Forwarded-For 의 마지막 주소(바로 앞 프록시가 붙인 값)로 주소별 제한을 건다. */
  readonly trustProxy: boolean;
}

export const DEFAULT_SELF_HOST_LIMITS: SelfHostLimits = Object.freeze({
  maxConnections: 2000,
  maxConnectionsPerIp: 20,
  joinDeadlineMs: 10_000,
  trustProxy: false,
});

export interface SelfHostServerOptions {
  readonly host: string;
  /** 0 이면 운영체제가 고른다. 실제 포트는 돌려준 address 에 있다. */
  readonly port: number;
  readonly limits: SelfHostLimits;
  /** 허용할 브라우저 출처 하나. 생략하면 Origin 이 없는 연결만 받는다. */
  readonly allowedOrigin?: string;
  readonly log: ServerLogPort;
  readonly now: Now;
  readonly timers: Timers;
  /** 프로세스의 상주 메모리(바이트). server.stats 에 쓴다. 생략하면 process.memoryUsage().rss. */
  readonly rssBytes?: () => number;
  /** 시작한 뒤에 난 리스너 오류. 조립이 종료 코드 1 로 끝낸다. */
  readonly onListenerError?: (error: Error) => void;
}

export interface SelfHostAddress {
  readonly host: string;
  readonly port: number;
  /** 'IPv4' 또는 'IPv6'. */
  readonly family: string;
}

export interface SelfHostServer {
  readonly address: SelfHostAddress;
  /** 신규 수락을 멈추고 열린 연결을 닫는다. 5초 안에 끝난다. 여러 번 불러도 같은 결과다. reject 하지 않는다. */
  close(): Promise<void>;
}

/** 핸드셰이크는 이 시간 안에 끝나야 한다. 한 바이트씩 보내는 접속이 소켓을 붙잡지 못하게 한다. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** ws 가 받는 프레임의 상한. 와이어 상한(16KB)을 조금 넘는 것은 core 가 MESSAGE_TOO_LARGE 로 답하고, 이보다 크면 ws 가 닫는다. */
const FRAME_MAX_BYTES = 4 * LIMITS.SIGNAL_MAX_MESSAGE_BYTES;
/** 한 연결의 보낼 버퍼 상한. 받지 않는 상대가 메모리를 붙잡지 못하게 한다. */
const SEND_BUFFER_MAX_BYTES = 1024 * 1024;
/** 닫기 핸드셰이크를 기다리는 시간. 넘으면 소켓을 바로 끊는다(멈춘 상대는 답하지 않는다). */
const DROP_GRACE_MS = 2_000;
const SWEEP_INTERVAL_MS = 5_000;
const STATS_INTERVAL_MS = 60_000;
const LAG_PROBE_MS = 1_000;
/** close(): 이 시간까지 닫히지 않은 연결은 끊는다. */
const CLOSE_GRACE_MS = 1_500;
/** close(): 이 시간이 지나면 남은 것이 있어도 끝낸다. 전체 기한은 5초다. */
const CLOSE_HARD_MS = 4_500;

const WS_OPEN = 1;
const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  403: 'Forbidden',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
});

interface Conn {
  readonly id: ConnId;
  readonly socket: WebSocket;
  readonly ip: string;
  /** 등록되지 않은 채로 있기 시작한 시각. 등록돼 있으면 null. */
  unboundSince: number | null;
  lastMessageAt: number;
  /** 이 연결의 메시지를 받은 순서대로 처리하는 줄. 종료 통지는 그 뒤에 붙는다. */
  queue: Promise<void>;
  /** 서버가 이 연결을 끊기로 한 사유. 정해진 뒤에는 남은 메시지를 처리하지 않는다. */
  dropping: string | null;
  closed: boolean;
  joinTimer: TimerHandle | null;
  killTimer: TimerHandle | null;
}

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'Error';
}

export function startSelfHostServer(options: SelfHostServerOptions): Promise<SelfHostServer> {
  const { limits, log, now, timers, allowedOrigin } = options;
  const rssBytes = options.rssBytes ?? ((): number => process.memoryUsage().rss);

  const store = createMemoryRoomStore();
  const conns = new Map<ConnId, Conn>();
  const ipCounts = new Map<string, number>();
  /** 핸드셰이크가 끝나지 않은 TCP 소켓과 그 기한. */
  const handshakes = new Map<Socket, TimerHandle>();
  /** 거절 응답을 이미 보낸 소켓. 기한이 끊을 때 거절로 다시 세지 않는다. */
  const answered = new WeakSet<Duplex>();
  /** 종료 통지를 처리 중인 연결의 줄. close() 가 끝나기를 기다린다. */
  const draining = new Set<Promise<void>>();
  const startedAt = now();
  let serial = 0;
  let rejected = 0;
  let closing: Promise<void> | null = null;
  let sweepTimer: TimerHandle | null = null;
  let statsTimer: TimerHandle | null = null;
  let lagTimer: TimerHandle | null = null;
  let maxLagMs = 0;

  // ── 연결 끊기 ──────────────────────────────────────────────────────────────

  /** 서버가 연결을 끊는다. 'flush' 는 이미 보낸 글(오류 응답)이 나간 뒤 closeCode 로 닫고, 'now' 는 바로 끊는다. */
  function drop(conn: Conn, reason: string, how: 'flush' | 'now', closeCode = 1000): void {
    if (conn.closed) return;
    if (conn.dropping === null) {
      conn.dropping = reason;
      log.event('info', 'signaling-selfhost', 'conn.drop', { conn_ref: refOf(conn.id), reason });
    }
    if (how === 'now') {
      conn.socket.terminate();
      return;
    }
    if (conn.killTimer !== null) return;
    try {
      conn.socket.close(closeCode);
    } catch {
      conn.socket.terminate();
      return;
    }
    conn.killTimer = timers.setTimeout(() => {
      conn.killTimer = null;
      if (!conn.closed) conn.socket.terminate();
    }, DROP_GRACE_MS);
  }

  function checkSendBuffer(conn: Conn): void {
    if (!conn.closed && conn.socket.bufferedAmount > SEND_BUFFER_MAX_BYTES) drop(conn, 'slow_consumer', 'now');
  }

  // ── core 조립 ──────────────────────────────────────────────────────────────

  const sink: ConnectionSink = {
    async send(connId, text) {
      const conn = conns.get(connId);
      if (conn === undefined || conn.dropping !== null || conn.socket.readyState !== WS_OPEN) return 'gone';
      conn.socket.send(text, { binary: false, compress: false }, (error) => {
        if (error) drop(conn, 'socket_error', 'now');
      });
      checkSendBuffer(conn);
      return 'ok';
    },
    async isOpen(connId) {
      const conn = conns.get(connId);
      return conn !== undefined && conn.dropping === null && conn.socket.readyState === WS_OPEN;
    },
    async close(connId) {
      const conn = conns.get(connId);
      if (conn !== undefined) drop(conn, 'rule', 'flush');
    },
  };

  const core = createSignalingCore({ store, sink, now, log });

  // ── WebSocket 연결 ─────────────────────────────────────────────────────────

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: FRAME_MAX_BYTES,
    // 서브프로토콜은 쓰지 않는다. 클라이언트가 내밀어도 고르지 않는다.
    handleProtocols: () => false,
  });

  function enqueue(conn: Conn, task: () => Promise<void>): void {
    conn.queue = conn.queue.then(task).catch((error: unknown) => {
      // core 는 reject 하지 않기로 돼 있다. 여기 닿으면 결함이다. 이 연결의 줄만 이어 간다.
      log.event('error', 'signaling-selfhost', 'conn.task_failed', { conn_ref: refOf(conn.id), error_code: errorCodeOf(error) });
    });
  }

  function onSocketClosed(conn: Conn): void {
    // 종료 처리는 여러 번 불려도 한 번만 반영된다.
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn.id);
    const left = (ipCounts.get(conn.ip) ?? 1) - 1;
    if (left <= 0) ipCounts.delete(conn.ip);
    else ipCounts.set(conn.ip, left);
    if (conn.joinTimer !== null) timers.clearTimeout(conn.joinTimer);
    if (conn.killTimer !== null) timers.clearTimeout(conn.killTimer);
    conn.joinTimer = null;
    conn.killTimer = null;
    enqueue(conn, () => core.onDisconnect(conn.id));
    const tail = conn.queue;
    draining.add(tail);
    void tail.then(() => draining.delete(tail));
  }

  function accept(socket: WebSocket, ip: string): void {
    serial += 1;
    const at = now();
    const conn: Conn = {
      // 프로세스 수명 동안 재사용하지 않는다(시작 시각 + 증가 번호).
      id: `${startedAt.toString(36)}-${serial.toString(36)}`,
      socket,
      ip,
      unboundSince: at,
      lastMessageAt: at,
      queue: Promise.resolve(),
      dropping: null,
      closed: false,
      joinTimer: null,
      killTimer: null,
    };
    conns.set(conn.id, conn);
    ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);

    conn.joinTimer = timers.setTimeout(() => {
      conn.joinTimer = null;
      if (!conn.closed && store.bindingOf(conn.id) === null) drop(conn, 'join_deadline', 'flush');
    }, limits.joinDeadlineMs);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      conn.lastMessageAt = now();
      // 공용 서버(API Gateway)는 바이너리 프레임을 1003 으로 닫는다. 두 서버의 와이어 동작을 맞춘다(protocol.md 2.1).
      // 앞서 받은 글의 처리가 끝난 뒤 닫도록 줄에 넣는다.
      if (isBinary) {
        enqueue(conn, async () => {
          if (conn.dropping === null) drop(conn, 'binary_frame', 'flush', 1003);
        });
        return;
      }
      const text = toText(data);
      enqueue(conn, () => (conn.dropping === null ? core.onMessage(conn.id, text) : Promise.resolve()));
    });
    // 제어 프레임의 pong 도 보낼 버퍼에 쌓인다. 읽지 않는 상대가 ping 으로 버퍼를 키우지 못하게 한다.
    socket.on('ping', () => checkSendBuffer(conn));
    socket.on('error', (error: Error) => {
      const reason = errorCodeOf(error) === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'frame_too_large' : 'socket_error';
      drop(conn, reason, 'flush');
    });
    socket.on('close', () => onSocketClosed(conn));
  }

  // ── HTTP 와 업그레이드 ─────────────────────────────────────────────────────

  function clientIp(request: IncomingMessage): string {
    const direct = request.socket.remoteAddress ?? 'unknown';
    if (!limits.trustProxy) return direct;
    const header = request.headers['x-forwarded-for'];
    const joined = Array.isArray(header) ? header.join(',') : (header ?? '');
    const hops = joined.split(',').map((part) => part.trim()).filter((part) => part !== '');
    return hops[hops.length - 1] ?? direct;
  }

  function refuse(socket: Duplex, status: number, reason: string, ip: string): void {
    rejected += 1;
    log.event('info', 'signaling-selfhost', 'conn.refused', { reason, error_code: String(status), ip_ref: refOf(ip) });
    // 응답이 나간 뒤 끊는다. 나가지 못하면 핸드셰이크 기한이 끊는다.
    answered.add(socket);
    socket.on('error', () => undefined);
    socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }

  function finishHandshake(socket: Duplex): void {
    const timer = handshakes.get(socket as Socket);
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      handshakes.delete(socket as Socket);
    }
  }

  function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = clientIp(request);
    if (closing !== null) return refuse(socket, 503, 'shutdown', ip);
    const origins = request.headersDistinct.origin;
    if (origins !== undefined && (origins.length !== 1 || origins[0] !== allowedOrigin)) {
      return refuse(socket, 403, 'origin', ip);
    }
    if (conns.size >= limits.maxConnections) return refuse(socket, 503, 'max_connections', ip);
    if ((ipCounts.get(ip) ?? 0) >= limits.maxConnectionsPerIp) return refuse(socket, 429, 'max_connections_per_ip', ip);

    let accepted = false;
    wss.handleUpgrade(request, socket, head, (ws) => {
      accepted = true;
      finishHandshake(socket);
      accept(ws, ip);
    });
    if (!accepted) {
      // ws 가 잘못된 업그레이드 요청을 400 으로 돌려보냈다.
      rejected += 1;
      log.event('info', 'signaling-selfhost', 'conn.refused', { reason: 'bad_handshake', ip_ref: refOf(ip) });
    }
  }

  function onRequest(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? '/').split('?')[0];
    const send = (status: number, type: string, body: string, more: Record<string, string> = {}): void => {
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        Connection: 'close',
        ...more,
      });
      response.end(body);
    };
    if ((request.method === 'GET' || request.method === 'HEAD') && path === '/healthz') {
      // 방 ID 와 이름은 내보내지 않는다. 연결이 꽉 차도 응답한다.
      send(200, 'application/json', JSON.stringify({ ok: true, connections: conns.size, rooms: store.roomCount() }));
      return;
    }
    send(426, 'text/plain; charset=utf-8', 'WebSocket 으로 접속한다.\n', { Upgrade: 'websocket' });
  }

  const http = createServer(onRequest);
  // 연결이 꽉 차도 /healthz 와 거절 응답이 나가게 TCP 수는 넉넉히 둔다.
  http.maxConnections = limits.maxConnections * 2 + 256;
  http.on('upgrade', onUpgrade);
  http.on('connection', (socket: Socket) => {
    const timer = timers.setTimeout(() => {
      handshakes.delete(socket);
      if (!answered.has(socket)) {
        rejected += 1;
        log.event('info', 'signaling-selfhost', 'conn.refused', { reason: 'handshake_timeout', ip_ref: refOf(socket.remoteAddress ?? 'unknown') });
      }
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    handshakes.set(socket, timer);
    socket.on('close', () => finishHandshake(socket));
  });
  http.on('clientError', (_error: Error, socket: Duplex) => {
    socket.destroy();
  });

  // ── 주기 작업 ──────────────────────────────────────────────────────────────

  /** 죽은 소켓과 등록 없이 남은 연결을 닫는다. 판정 기준은 core 의 오래됨과 같은 PARTICIPANT_STALE_MS 다. */
  function sweep(): void {
    const at = now();
    for (const conn of [...conns.values()]) {
      if (conn.dropping !== null) continue;
      if (store.bindingOf(conn.id) !== null) {
        conn.unboundSince = null;
        if (at - conn.lastMessageAt > LIMITS.PARTICIPANT_STALE_MS) drop(conn, 'stale', 'flush');
      } else {
        conn.unboundSince ??= at;
        if (at - conn.unboundSince >= limits.joinDeadlineMs) drop(conn, 'join_deadline', 'flush');
      }
    }
  }

  function armSweep(): void {
    sweepTimer = timers.setTimeout(() => {
      sweep();
      if (closing === null) armSweep();
    }, SWEEP_INTERVAL_MS);
  }

  function armLagProbe(): void {
    const armedAt = now();
    lagTimer = timers.setTimeout(() => {
      maxLagMs = Math.max(maxLagMs, now() - armedAt - LAG_PROBE_MS);
      if (closing === null) armLagProbe();
    }, LAG_PROBE_MS);
  }

  function armStats(): void {
    statsTimer = timers.setTimeout(() => {
      log.event('info', 'signaling-selfhost', 'server.stats', {
        connections: conns.size,
        rooms: store.roomCount(),
        rejected,
        loop_lag_ms: Math.max(0, Math.round(maxLagMs)),
        rss_mb: Math.round(rssBytes() / (1024 * 1024)),
      });
      maxLagMs = 0;
      if (closing === null) armStats();
    }, STATS_INTERVAL_MS);
  }

  // ── 종료 ───────────────────────────────────────────────────────────────────

  function close(): Promise<void> {
    if (closing !== null) return closing;
    closing = new Promise<void>((resolve) => {
      for (const timer of [sweepTimer, statsTimer, lagTimer]) if (timer !== null) timers.clearTimeout(timer);
      let finished = false;
      let graceTimer: TimerHandle | null = null;
      let hardTimer: TimerHandle | null = null;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (graceTimer !== null) timers.clearTimeout(graceTimer);
        if (hardTimer !== null) timers.clearTimeout(hardTimer);
        for (const timer of handshakes.values()) timers.clearTimeout(timer);
        handshakes.clear();
        // 닫힌 연결의 기록 삭제까지 끝난 뒤에 돌려준다.
        void Promise.allSettled([...draining]).then(() => resolve());
      };
      const cutAll = (): void => {
        for (const conn of [...conns.values()]) drop(conn, 'shutdown', 'now');
        for (const socket of [...handshakes.keys()]) socket.destroy();
        http.closeAllConnections();
      };

      // 신규 수락을 멈춘다. 콜백은 모든 소켓이 닫힌 뒤에 온다.
      http.close(() => finish());
      for (const socket of [...handshakes.keys()]) socket.destroy();
      for (const conn of [...conns.values()]) {
        if (conn.dropping === null) {
          conn.dropping = 'shutdown';
          log.event('info', 'signaling-selfhost', 'conn.drop', { conn_ref: refOf(conn.id), reason: 'shutdown' });
        }
        try {
          conn.socket.close(1001);
        } catch {
          conn.socket.terminate();
        }
      }
      graceTimer = timers.setTimeout(cutAll, CLOSE_GRACE_MS);
      hardTimer = timers.setTimeout(() => {
        cutAll();
        finish();
      }, CLOSE_HARD_MS);
    });
    return closing;
  }

  // ── 시작 ───────────────────────────────────────────────────────────────────

  return new Promise<SelfHostServer>((resolve, reject) => {
    const onStartError = (error: Error): void => reject(error);
    http.once('error', onStartError);
    http.listen({ host: options.host, port: options.port }, () => {
      http.off('error', onStartError);
      http.on('error', (error: Error) => {
        log.event('error', 'signaling-selfhost', 'server.error', { error_code: errorCodeOf(error) });
        options.onListenerError?.(error);
      });
      const bound = http.address();
      const address: SelfHostAddress =
        bound !== null && typeof bound === 'object'
          ? { host: bound.address, port: bound.port, family: bound.family }
          : { host: options.host, port: options.port, family: 'IPv4' };
      armSweep();
      armLagProbe();
      armStats();
      resolve({ address, close });
    });
  });
}
