// signaling-client 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다.
// 가짜 시계, 가짜 소켓, 메모리 로그를 준다. 이 모듈에 붙는 모듈(room-session)의 시험도 가져다 쓸 수 있다.

import type { LogFields, LogLevel, LogModule, LogPort } from '../diagnostics/log-port.js';
import type { Now, TimerHandle, Timers } from '../protocol/index.js';
import type { OpenSignalingSocket, SignalingSocketHandlers } from './contract.js';

// ── 가짜 시계 ───────────────────────────────────────────────────────────────

export interface FakeClock {
  readonly now: Now;
  readonly timers: Timers;
  /** 시간을 ms 만큼 움직인다. 그 사이에 찬 타이머를 시각 순서대로 울린다. 울리면서 새로 건 것도 구간 안이면 울린다. */
  advance(ms: number): void;
  /** 걸려 있는 타이머 수. */
  pending(): number;
}

export function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let current = startMs;
  let nextHandle = 1;
  const pending = new Map<number, { readonly at: number; readonly callback: () => void }>();

  const timers: Timers = {
    setTimeout(callback: () => void, delayMs: number): TimerHandle {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { at: current + Math.max(0, delayMs), callback });
      return handle;
    },
    clearTimeout(handle: TimerHandle): void {
      if (typeof handle === 'number') pending.delete(handle);
    },
  };

  return {
    now: () => current,
    timers,
    advance(ms: number): void {
      const target = current + ms;
      for (;;) {
        let dueHandle: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [handle, timer] of pending) {
          // 같은 시각이면 먼저 건 것이 먼저 울린다(손잡이가 작다).
          if (timer.at <= target && (timer.at < dueAt || (timer.at === dueAt && dueHandle !== null && handle < dueHandle))) {
            dueHandle = handle;
            dueAt = timer.at;
          }
        }
        if (dueHandle === null) break;
        const timer = pending.get(dueHandle);
        pending.delete(dueHandle);
        current = Math.max(current, dueAt);
        timer?.callback();
      }
      current = target;
    },
    pending: () => pending.size,
  };
}

/** 실제 시계와 타이머. 실제 소켓이나 실제 라이브러리를 붙여 보는 시험이 쓴다. */
export function createRealClock(): { readonly now: Now; readonly timers: Timers } {
  return {
    now: () => Date.now(),
    timers: {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  };
}

// ── 메모리 로그 ─────────────────────────────────────────────────────────────

export interface LoggedEvent {
  readonly level: LogLevel;
  readonly module: LogModule;
  readonly event: string;
  readonly fields: LogFields;
}

export interface MemoryLog extends LogPort {
  readonly events: LoggedEvent[];
  named(event: string): LoggedEvent[];
  /** 남긴 모든 줄을 한 글로 잇는다. 금지 값이 섞였는지 찾을 때 쓴다. */
  text(): string;
}

export function createMemoryLog(): MemoryLog {
  const events: LoggedEvent[] = [];
  return {
    events,
    event(level, module, event, fields = {}): void {
      events.push({ level, module, event, fields });
    },
    named: (event) => events.filter((entry) => entry.event === event),
    text: () => events.map((entry) => JSON.stringify(entry)).join('\n'),
  };
}

// ── 가짜 소켓 ───────────────────────────────────────────────────────────────

export interface FakeSocket {
  readonly url: string;
  /** 클라이언트가 보낸 텍스트 그대로. */
  readonly sent: string[];
  /** 보낸 것을 JSON 으로 읽은 값. */
  messages(): Record<string, unknown>[];
  /** 그 action 으로 보낸 것만. */
  actions(action: string): Record<string, unknown>[];
  /** 클라이언트가 close() 를 불렀는가. */
  readonly closedByClient: boolean;
  /** 서버 쪽에서 접속을 받아들인다. */
  open(): void;
  /** 서버가 텍스트 프레임을 보낸다. 객체는 JSON 으로 바꾼다. */
  receive(frame: string | Record<string, unknown>): void;
  /** 서버가 닫는다(접속 실패 포함). */
  drop(): void;
}

export interface FakeSocketHub {
  readonly open: OpenSignalingSocket;
  readonly sockets: FakeSocket[];
  /** 가장 최근에 연 소켓. */
  last(): FakeSocket;
}

/** 클라이언트가 close() 를 부르면 닫힘을 바로 알리는가. 실제 소켓은 닫는 악수 뒤에 알린다. */
export function createFakeSocketHub(options: { readonly closeNotifies?: boolean } = {}): FakeSocketHub {
  const sockets: FakeSocket[] = [];
  const closeNotifies = options.closeNotifies ?? true;

  const open: OpenSignalingSocket = (url: string, handlers: SignalingSocketHandlers) => {
    const sent: string[] = [];
    let opened = false;
    let closed = false;
    let closedByClient = false;
    const notifyClosed = (): void => {
      if (closed) return;
      closed = true;
      handlers.onClose();
    };
    const fake: FakeSocket = {
      url,
      sent,
      messages: () => sent.map((text) => JSON.parse(text) as Record<string, unknown>),
      actions: (action) => fake.messages().filter((message) => message['action'] === action),
      get closedByClient() {
        return closedByClient;
      },
      open(): void {
        if (closed || opened) return;
        opened = true;
        handlers.onOpen();
      },
      receive(frame): void {
        if (closed) return;
        handlers.onText(typeof frame === 'string' ? frame : JSON.stringify(frame));
      },
      drop: notifyClosed,
    };
    sockets.push(fake);
    return {
      send(text: string): boolean {
        if (!opened || closed || closedByClient) return false;
        sent.push(text);
        return true;
      },
      close(): void {
        closedByClient = true;
        if (closeNotifies) notifyClosed();
      },
    };
  };

  return {
    open,
    sockets,
    last(): FakeSocket {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) throw new Error('아직 연 소켓이 없다');
      return socket;
    },
  };
}
