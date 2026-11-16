// diagnostics 시험이 쓰는 가짜 시계와 메모리 파일. 제품 코드는 이 파일을 import 하지 않는다.

import type { Timers } from '../protocol/index.js';
import type { FileLoggerIo, StderrSink } from './file-logger.js';

interface FakeTimer {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
  dead: boolean;
}

export interface FakeClock {
  readonly now: () => number;
  readonly timers: Timers;
  /** 시각을 옮기며 그 사이에 걸린 타이머를 시각 순서대로 울린다. */
  advance(ms: number): void;
  set(ms: number): void;
  /** 아직 울리지 않았고 지우지도 않은 타이머 수. */
  pending(): number;
}

export function createFakeClock(startMs: number): FakeClock {
  let current = startMs;
  let order = 0;
  let queue: FakeTimer[] = [];
  const live = (): FakeTimer[] => queue.filter((timer) => !timer.dead);
  return {
    now: () => current,
    timers: {
      setTimeout(callback, delayMs) {
        const timer: FakeTimer = { at: current + Math.max(0, delayMs), order: (order += 1), callback, dead: false };
        queue.push(timer);
        return timer;
      },
      clearTimeout(handle) {
        if (typeof handle === 'object' && handle !== null) (handle as FakeTimer).dead = true;
      },
    },
    advance(ms) {
      const end = current + ms;
      for (;;) {
        const due = live()
          .filter((timer) => timer.at <= end)
          .sort((a, b) => a.at - b.at || a.order - b.order)[0];
        if (due === undefined) break;
        due.dead = true;
        current = Math.max(current, due.at);
        due.callback();
      }
      queue = live();
      current = end;
    },
    set(ms) {
      current = ms;
    },
    pending: () => live().length,
  };
}

export interface MemoryIo extends FileLoggerIo {
  readonly files: Map<string, string>;
  /** 이름에 이 글자가 든 파일의 삭제를 실패시킨다. */
  failRemove: string | null;
  failAppend: boolean;
  failList: boolean;
  /** 참이면 append 가 끝나지 않는다(느린 디스크). */
  hangAppend: boolean;
  /** 크기를 내용 길이 대신 이 값으로 준다(큰 파일 흉내). */
  readonly sizes: Map<string, number>;
  readonly removed: string[];
  appendCalls: number;
}

export function createMemoryIo(dir: string): MemoryIo {
  const files = new Map<string, string>();
  const sizes = new Map<string, number>();
  const base = (path: string): string => (path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path);
  const io: MemoryIo = {
    files,
    sizes,
    removed: [],
    failRemove: null,
    failAppend: false,
    failList: false,
    hangAppend: false,
    appendCalls: 0,
    prepareDir() {},
    append(path, text) {
      io.appendCalls += 1;
      if (io.hangAppend) return new Promise<void>(() => {});
      if (io.failAppend) return Promise.reject(new Error('disk full'));
      const name = base(path);
      files.set(name, (files.get(name) ?? '') + text);
      return Promise.resolve();
    },
    list() {
      return io.failList ? Promise.reject(new Error('EACCES')) : Promise.resolve([...files.keys()]);
    },
    size(path) {
      const name = base(path);
      const content = files.get(name);
      if (content === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(sizes.get(name) ?? Buffer.byteLength(content));
    },
    remove(path) {
      const name = base(path);
      if (io.failRemove !== null && name.includes(io.failRemove)) return Promise.reject(new Error('EPERM'));
      files.delete(name);
      io.removed.push(name);
      return Promise.resolve();
    },
  };
  return io;
}

export interface MemoryStderr extends StderrSink {
  readonly lines: string[];
  guards: number;
  failWrite: boolean;
}

export function createMemoryStderr(): MemoryStderr {
  const sink: MemoryStderr = {
    lines: [],
    guards: 0,
    failWrite: false,
    write(text) {
      if (sink.failWrite) throw new Error('EPIPE');
      sink.lines.push(text);
    },
    guard() {
      sink.guards += 1;
      return () => {
        sink.guards -= 1;
      };
    },
  };
  return sink;
}

/** 대기 중인 프라미스 연쇄가 끝까지 돌게 한다. 메모리 파일은 마이크로태스크만 쓴다. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

export function parseLines(content: string | undefined): Record<string, unknown>[] {
  if (content === undefined || content === '') return [];
  return content
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
