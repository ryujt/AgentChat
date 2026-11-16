// inbox 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다(V-U8 의 import-testing).
// 가짜 시계, 로그 기록기, 사건 표본을 준다. inbox 와 mcp-server 의 시험이 함께 쓴다.

import type { LogFields, LogLevel, LogModule, LogPort } from '../diagnostics/log-port.js';
import type { Timers } from '../protocol/index.js';
import type { ChatEvent, SystemEvent, TestEvent } from './contract.js';

export interface FakeClock {
  readonly now: () => number;
  readonly timers: Timers;
  /** 시간을 ms 만큼 움직인다. 그 사이에 기한이 된 타이머를 기한 순서대로, 그 시각에 맞춰 울린다. */
  advance(ms: number): void;
  /** 걸려 있는 타이머 수. */
  pending(): number;
}

interface FakeTimer {
  readonly id: number;
  readonly due: number;
  readonly callback: () => void;
}

/** 손으로 움직이는 시계. 전역 시계와 타이머를 건드리지 않는다. */
export function createFakeClock(start = Date.UTC(2026, 10, 15, 2, 0, 0)): FakeClock {
  let current = start;
  let nextId = 1;
  const pending = new Map<number, FakeTimer>();

  function nextDue(limit: number): FakeTimer | null {
    let best: FakeTimer | null = null;
    for (const timer of pending.values()) {
      if (timer.due > limit) continue;
      if (best === null || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) best = timer;
    }
    return best;
  }

  return {
    now: () => current,
    timers: {
      setTimeout: (callback, delayMs) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { id, due: current + Math.max(0, Number.isFinite(delayMs) ? delayMs : 0), callback });
        return id;
      },
      clearTimeout: (handle) => {
        if (typeof handle === 'number') pending.delete(handle);
      },
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const timer = nextDue(target);
        if (timer === null) break;
        pending.delete(timer.id);
        current = Math.max(current, timer.due);
        timer.callback();
      }
      current = target;
    },
    pending: () => pending.size,
  };
}

export interface LoggedEvent {
  readonly level: LogLevel;
  readonly module: LogModule;
  readonly event: string;
  readonly fields: LogFields;
}

export interface RecordingLog extends LogPort {
  readonly events: LoggedEvent[];
  named(event: string): LoggedEvent[];
}

export function createRecordingLog(): RecordingLog {
  const events: LoggedEvent[] = [];
  return {
    events,
    event(level, module, event, fields) {
      events.push({ level, module, event, fields: fields ?? {} });
    },
    named: (event) => events.filter((entry) => entry.event === event),
  };
}

const SAMPLE_TS = '2026-11-15T02:10:00.000Z';

export function chatEvent(text: string, id = 'k3x9q0ab12cd-1a', from = 'codex-7f3k'): ChatEvent {
  return { kind: 'chat', change: null, id, from, to: 'room', ts: SAMPLE_TS, text, data: {} };
}

export function numberedChat(index: number, text = `message ${index}`): ChatEvent {
  return chatEvent(text, `k3x9q0ab12cd-${index.toString(36)}`);
}

export function testStoppedEvent(by = 'codex-7f3k'): TestEvent {
  return {
    kind: 'test',
    change: 'stopped',
    id: 'k3x9q0ab12cd-2',
    from: by,
    to: 'room',
    ts: SAMPLE_TS,
    text: `test stopped by ${by}`,
    data: {
      test_id: 'k3x9q0ab12cd-1',
      request: 'check the hand-raise flow',
      limits: { max_duration_min: 60, max_scenarios: 20 },
      reason: 'user',
      by,
    },
  };
}

export function systemEvent(code: SystemEvent['data']['code'], text = code): SystemEvent {
  return { kind: 'system', change: null, id: null, from: 'system', to: 'you', ts: SAMPLE_TS, text, data: { code } };
}
