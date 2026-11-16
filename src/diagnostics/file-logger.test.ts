// V-U6: 파일 로거의 버퍼, 수준, 닫기, 정리 주기 (architecture.md 3.12, 6.3). 가짜 시계와 메모리 파일로 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FileLoggerOptions, Logger } from './contract.js';
import { FLUSH_DELAY_MS, MAX_BUFFER_LINES, createFileLoggerWith } from './file-logger.js';
import type { FileLoggerLimits } from './file-logger.js';
import type { LogFields, LogLevel, LogService } from './log-port.js';
import { CLEANUP_INTERVAL_MS, HOUR_MS, RETENTION_MS } from './retention.js';
import { createFakeClock, createMemoryIo, createMemoryStderr, parseLines, settle } from './testing.js';
import type { FakeClock, MemoryIo, MemoryStderr } from './testing.js';

const DIR = '/home/logs';
const T0 = Date.UTC(2026, 10, 15, 9, 30, 0);

interface Rig {
  readonly logger: Logger;
  readonly clock: FakeClock;
  readonly io: MemoryIo;
  readonly stderr: MemoryStderr;
  readonly file: string;
  flush(): Promise<void>;
  lines(): Record<string, unknown>[];
}

function rig(
  overrides: { level?: LogLevel; service?: LogService; limits?: Partial<FileLoggerLimits>; io?: MemoryIo; clock?: FakeClock; seed?: number } = {},
): Rig {
  const clock = overrides.clock ?? createFakeClock(T0);
  const io = overrides.io ?? createMemoryIo(DIR);
  const stderr = createMemoryStderr();
  const seed = overrides.seed ?? 1;
  const options: FileLoggerOptions = {
    dir: DIR,
    service: overrides.service ?? 'mcp',
    level: overrides.level ?? 'info',
    now: clock.now,
    timers: clock.timers,
    randomBytes: (size) => new Uint8Array(size).fill(seed),
  };
  const logger = createFileLoggerWith(options, { io, stderr, ...(overrides.limits === undefined ? {} : { limits: overrides.limits }) });
  const file = `diag-20261115T09-${logger.proc}.jsonl`;
  return {
    logger,
    clock,
    io,
    stderr,
    file,
    async flush() {
      await settle();
      clock.advance(FLUSH_DELAY_MS);
      await settle();
    },
    lines: () => parseLines(io.files.get(file)),
  };
}

describe('V-U6 파일 로거: 줄과 파일', () => {
  it('모든 줄에 proc 이 있고 파일 이름의 proc 과 같다', async () => {
    const r = rig();
    assert.match(r.logger.proc, /^[0-9a-z]{6}$/);
    r.logger.event('info', 'mesh', 'link.open', { peer: 'alice', open_ms: 120 });
    r.logger.event('warn', 'room-session', 'join.end', { outcome: 'error', error_code: 'JOIN_TIMEOUT' });
    r.logger.event('error', 'inbox', 'x');
    await r.flush();
    assert.deepEqual([...r.io.files.keys()], [r.file]);
    const lines = r.lines();
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.equal(line['proc'], r.logger.proc);
      assert.equal(line['svc'], 'mcp');
      assert.equal(line['ts'], '2026-11-15T09:30:00.000Z');
    }
    assert.equal(lines[0]?.['peer'], 'alice');
  });

  it('프로세스마다 다른 파일에 쓴다', async () => {
    const io = createMemoryIo(DIR);
    const clock = createFakeClock(T0);
    const a = rig({ io, clock, seed: 1 });
    const b = rig({ io, clock, seed: 2 });
    assert.notEqual(a.logger.proc, b.logger.proc);
    a.logger.event('info', 'mesh', 'from.a');
    b.logger.event('info', 'mesh', 'from.b');
    await a.flush();
    assert.deepEqual(a.lines().map((line) => line['event']), ['from.a']);
    assert.deepEqual(b.lines().map((line) => line['event']), ['from.b']);
    assert.equal(b.lines()[0]?.['proc'], b.logger.proc);
  });

  it('시간이 바뀌면 새 시간 구간의 파일에 쓴다', async () => {
    const r = rig();
    r.logger.event('info', 'mesh', 'before');
    r.clock.set(T0 + 30 * 60_000);
    r.logger.event('info', 'mesh', 'after');
    await r.flush();
    assert.deepEqual(r.lines().map((line) => line['event']), ['before']);
    const next = parseLines(r.io.files.get(`diag-20261115T10-${r.logger.proc}.jsonl`));
    assert.deepEqual(next.map((line) => line['event']), ['after']);
    assert.equal(next[0]?.['ts'], '2026-11-15T10:00:00.000Z');
  });

  it('몰린 줄을 한 번에 덧붙인다', async () => {
    const r = rig();
    for (let i = 0; i < 50; i += 1) r.logger.event('info', 'mesh', 'burst', { seq: i });
    assert.equal(r.io.appendCalls, 0, '쓰기는 event 안에서 일어나지 않는다');
    await r.flush();
    assert.equal(r.io.appendCalls, 1);
    assert.equal(r.lines().length, 50);
  });

  it('서버용 파일 로거는 peer 를 쓰지 않는다', async () => {
    const r = rig({ service: 'server' });
    r.logger.event('info', 'signaling-core', 'room.join', { peer: 'alice', peer_ref: '0123456789ab' } as LogFields);
    await r.flush();
    const [line] = r.lines();
    assert.equal(line?.['svc'], 'server');
    assert.equal('peer' in (line ?? {}), false);
    assert.equal(line?.['peer_ref'], '0123456789ab');
  });
});

describe('V-U6 파일 로거: 수준', () => {
  it('level 보다 낮은 사건은 쓰지 않는다', async () => {
    for (const [level, expected] of [
      ['debug', ['debug', 'info', 'warn', 'error']],
      ['info', ['info', 'warn', 'error']],
      ['warn', ['warn', 'error']],
      ['error', ['error']],
    ] as const) {
      const r = rig({ level });
      for (const each of ['debug', 'info', 'warn', 'error'] as const) r.logger.event(each, 'mesh', each);
      await r.flush();
      assert.deepEqual(r.lines().map((line) => line['level']), expected, level);
    }
  });

  it('warn 이상은 stderr 에도 쓰고 info 이하는 쓰지 않는다', async () => {
    const r = rig({ level: 'debug' });
    for (const each of ['debug', 'info', 'warn', 'error'] as const) r.logger.event(each, 'mesh', each);
    assert.deepEqual(r.stderr.lines.map((text) => (JSON.parse(text) as { level: string }).level), ['warn', 'error']);
    for (const text of r.stderr.lines) assert.ok(text.endsWith('\n'));
    await r.flush();
    assert.equal(r.lines().length, 4);
  });

  it('stderr 쓰기가 던져도 파일에는 남고 호출자는 계속 간다', async () => {
    const r = rig();
    r.stderr.failWrite = true;
    assert.doesNotThrow(() => r.logger.event('error', 'mesh', 'x'));
    await r.flush();
    assert.equal(r.lines().length, 1);
  });
});

describe('V-U6 파일 로거: 버퍼 넘침과 시간 파일 상한', () => {
  it('버퍼 1000줄을 넘은 줄은 버리고 버린 건수를 다음 줄에 남긴다', async () => {
    const r = rig();
    for (let i = 0; i < MAX_BUFFER_LINES + 7; i += 1) r.logger.event('info', 'mesh', 'flood', { seq: i });
    await r.flush();
    assert.equal(r.lines().length, MAX_BUFFER_LINES);
    assert.equal(r.lines().some((line) => 'dropped' in line), false);

    r.logger.event('info', 'mesh', 'after');
    r.logger.event('info', 'mesh', 'later');
    await r.flush();
    const lines = r.lines();
    assert.equal(lines.length, MAX_BUFFER_LINES + 2);
    assert.equal(lines[MAX_BUFFER_LINES]?.['event'], 'after');
    assert.equal(lines[MAX_BUFFER_LINES]?.['dropped'], 7);
    assert.equal('dropped' in (lines[MAX_BUFFER_LINES + 1] ?? {}), false, '건수는 한 번만 남긴다');
  });

  it('수준에 걸려 쓰지 않은 사건은 버린 건수에 들지 않는다', async () => {
    const r = rig({ limits: { maxBufferLines: 2 } });
    r.logger.event('info', 'mesh', 'a');
    r.logger.event('info', 'mesh', 'b');
    r.logger.event('debug', 'mesh', 'low');
    r.logger.event('info', 'mesh', 'c');
    await r.flush();
    r.logger.event('info', 'mesh', 'd');
    await r.flush();
    assert.deepEqual(r.lines().map((line) => [line['event'], line['dropped']]), [['a', undefined], ['b', undefined], ['d', 1]]);
  });

  it('시간 파일이 상한을 넘으면 그 시간의 나머지는 버리고 다음 시간에 건수를 남긴다', async () => {
    const r = rig({ limits: { maxHourFileBytes: 400 } });
    for (let i = 0; i < 20; i += 1) r.logger.event('info', 'mesh', 'fill', { seq: i });
    await r.flush();
    const written = r.lines().length;
    assert.ok(written > 0 && written < 20, `쓴 줄 ${written}`);
    assert.ok(Buffer.byteLength(r.io.files.get(r.file) ?? '') <= 400);

    // 같은 시간에는 버퍼가 비어도 더 쓰지 않는다.
    r.logger.event('error', 'mesh', 'same.hour');
    await r.flush();
    assert.equal(r.lines().length, written);

    r.clock.set(T0 + 30 * 60_000);
    r.logger.event('info', 'mesh', 'next.hour');
    await r.flush();
    const next = parseLines(r.io.files.get(`diag-20261115T10-${r.logger.proc}.jsonl`));
    assert.equal(next.length, 1);
    assert.equal(next[0]?.['dropped'], 20 - written + 1);
  });

  it('덧붙이기가 실패해도 던지지 않고 버린 건수로 센다', async () => {
    const r = rig();
    r.io.failAppend = true;
    r.logger.event('info', 'mesh', 'lost.1');
    r.logger.event('info', 'mesh', 'lost.2');
    await r.flush();
    assert.equal(r.io.files.size, 0);
    r.io.failAppend = false;
    r.logger.event('info', 'mesh', 'kept');
    await r.flush();
    assert.deepEqual(r.lines().map((line) => [line['event'], line['dropped']]), [['kept', 2]]);
    assert.equal(r.stderr.lines.length, 0, '자기 실패를 다시 로그로 쓰지 않는다');
  });
});

describe('V-U6 파일 로거: close(budgetMs)', () => {
  it('버퍼에 남은 줄을 쓰고 끝난다', async () => {
    const r = rig();
    r.logger.event('info', 'mesh', 'a');
    r.logger.event('info', 'mesh', 'b');
    await r.logger.close(1000);
    assert.deepEqual(r.lines().map((line) => line['event']), ['a', 'b']);
    assert.equal(r.clock.pending(), 0, '타이머가 남지 않는다');
    assert.equal(r.stderr.guards, 0, 'stderr 리스너를 뗀다');
  });

  it('닫은 뒤의 사건은 버린다', async () => {
    const r = rig();
    r.logger.event('info', 'mesh', 'before');
    const closing = r.logger.close(1000);
    r.logger.event('error', 'mesh', 'after.close.called');
    await closing;
    r.logger.event('error', 'mesh', 'after.close.done');
    r.clock.advance(HOUR_MS);
    await settle();
    assert.deepEqual(r.lines().map((line) => line['event']), ['before']);
    assert.equal(r.stderr.lines.length, 0);
    assert.equal(r.clock.pending(), 0);
  });

  it('쓰기가 끝나지 않으면 예산이 다한 때에 끝나고 남은 줄을 버린다', async () => {
    const r = rig();
    r.io.hangAppend = true;
    r.logger.event('info', 'mesh', 'stuck');
    let settled = false;
    const closing = r.logger.close(500).then(() => {
      settled = true;
    });
    await settle();
    r.clock.advance(499);
    await settle();
    assert.equal(settled, false, '예산 전에는 기다린다');
    r.clock.advance(1);
    await closing;
    assert.equal(settled, true);
    assert.equal(r.io.files.size, 0);
    assert.equal(r.clock.pending(), 0);
  });

  it('진행 중인 쓰기 뒤에 쌓인 줄도 예산이 다하면 버린다', async () => {
    const r = rig();
    r.logger.event('info', 'mesh', 'first');
    r.io.hangAppend = true;
    r.clock.advance(FLUSH_DELAY_MS);
    await settle();
    assert.equal(r.io.appendCalls, 1);
    r.logger.event('info', 'mesh', 'second');
    const closing = r.logger.close(300);
    r.clock.advance(300);
    await closing;
    r.io.hangAppend = false;
    r.clock.advance(HOUR_MS);
    await settle();
    assert.equal(r.io.appendCalls, 1, '버린 줄을 나중에 쓰지 않는다');
  });

  it('예산이 0 이하이거나 수가 아니면 바로 끝난다', async () => {
    for (const budget of [0, -5, Number.NaN]) {
      const r = rig();
      r.logger.event('info', 'mesh', 'x');
      await r.logger.close(budget);
      await settle();
      assert.equal(r.io.appendCalls, 0, String(budget));
      assert.equal(r.clock.pending(), 0);
    }
  });

  it('여러 번 불러도 되고 reject 하지 않는다', async () => {
    const r = rig();
    r.io.failAppend = true;
    r.logger.event('info', 'mesh', 'x');
    const first = r.logger.close(100);
    const second = r.logger.close(100);
    assert.equal(first, second);
    await first;
    await r.logger.close(100);
    assert.equal(r.clock.pending(), 0);
  });
});

describe('V-U6 파일 로거: 보존 정리 주기', () => {
  const OLD = 'diag-20261101T09-old000.jsonl';

  it('시작할 때 한 번 정리한다', async () => {
    const io = createMemoryIo(DIR);
    io.files.set(OLD, 'x\n');
    io.files.set('diag-20261114T09-new000.jsonl', 'x\n');
    const r = rig({ io });
    await settle();
    assert.deepEqual(io.removed, [OLD]);
    await r.logger.close(10);
  });

  it('그 뒤 1시간마다 정리하고 7일 경계를 파일 이름으로 판정한다', async () => {
    const start = Date.UTC(2026, 10, 1, 10) + RETENTION_MS - 30 * 60_000; // OLD 의 구간 끝에서 7일이 되기 30분 전
    const io = createMemoryIo(DIR);
    io.files.set(OLD, 'x\n');
    const r = rig({ io, clock: createFakeClock(start) });
    await settle();
    assert.deepEqual(io.removed, [], '7일 직전');

    r.clock.advance(CLEANUP_INTERVAL_MS - 1);
    await settle();
    assert.deepEqual(io.removed, [], '주기 전에는 돌지 않는다');
    r.clock.advance(1);
    await settle();
    assert.deepEqual(io.removed, [OLD], '7일을 넘긴 뒤의 주기');

    io.files.set('diag-20261101T10-old001.jsonl', 'x\n');
    r.clock.advance(CLEANUP_INTERVAL_MS);
    await settle();
    assert.deepEqual(io.removed, [OLD, 'diag-20261101T10-old001.jsonl'], '다음 주기에도 돈다');
    await r.logger.close(10);
    assert.equal(r.clock.pending(), 0);
  });

  it('삭제 실패 건수를 log.cleanup 사건으로 남기고 다음 주기에 다시 지운다', async () => {
    const io = createMemoryIo(DIR);
    io.files.set(OLD, 'x\n');
    io.files.set('diag-20261101T08-old001.jsonl', 'x\n');
    io.failRemove = 'old';
    const r = rig({ io });
    await r.flush();
    const [line] = r.lines();
    assert.equal(line?.['event'], 'log.cleanup');
    assert.equal(line?.['mod'], 'diagnostics');
    assert.equal(line?.['level'], 'warn');
    assert.equal(line?.['outcome'], 'error');
    assert.equal(line?.['failed'], 2);
    assert.equal(line?.['proc'], r.logger.proc);
    assert.equal(r.lines().length, 1);

    io.failRemove = null;
    r.clock.advance(CLEANUP_INTERVAL_MS);
    await settle();
    assert.deepEqual([...io.removed].sort(), ['diag-20261101T08-old001.jsonl', OLD]);
    await r.flush();
    assert.equal(r.lines().filter((each) => each['event'] === 'log.cleanup').length, 1, '성공한 주기는 사건을 남기지 않는다');
    await r.logger.close(10);
  });

  it('디렉터리 상한을 넘으면 오래된 파일부터 지우고 자기 파일은 남긴다', async () => {
    const io = createMemoryIo(DIR);
    const others = ['diag-20261114T07-aaaaaa.jsonl', 'diag-20261114T08-bbbbbb.jsonl', 'diag-20261115T08-cccccc.jsonl'];
    for (const name of others) {
      io.files.set(name, 'x');
      io.sizes.set(name, 100);
    }
    const r = rig({ io, limits: { maxDirBytes: 150 } });
    await settle();
    assert.deepEqual(io.removed, [others[0], others[1]]);

    // 다음 주기 직전에 쓴 자기 파일(그 시간 구간)이 상한을 넘겨도 자기 파일은 지우지 않는다.
    r.clock.advance(CLEANUP_INTERVAL_MS - 60_000);
    r.logger.event('info', 'mesh', 'mine');
    await r.flush();
    const mine = `diag-20261115T10-${r.logger.proc}.jsonl`;
    assert.ok(io.files.has(mine));
    io.sizes.set(mine, 1000);
    r.clock.advance(60_000);
    await settle();
    assert.deepEqual(io.removed, others);
    assert.ok(io.files.has(mine));
    await r.logger.close(10);
  });

  it('닫으면 정리 주기도 멈춘다', async () => {
    const io = createMemoryIo(DIR);
    const r = rig({ io });
    await settle();
    await r.logger.close(10);
    io.files.set(OLD, 'x\n');
    r.clock.advance(CLEANUP_INTERVAL_MS * 3);
    await settle();
    assert.deepEqual(io.removed, []);
  });
});

describe('V-U6 파일 로거: 로그 실패가 호출자를 멈추지 않는다', () => {
  it('디렉터리를 쓸 수 없으면 아무 것도 쓰지 않는 로거를 준다', async () => {
    const io = createMemoryIo(DIR);
    io.prepareDir = () => {
      throw new Error('EACCES');
    };
    const clock = createFakeClock(T0);
    const stderr = createMemoryStderr();
    const logger = createFileLoggerWith({ dir: DIR, service: 'mcp', level: 'debug', now: clock.now, timers: clock.timers }, { io, stderr });
    assert.match(logger.proc, /^[0-9a-z]{6}$/);
    assert.doesNotThrow(() => logger.event('error', 'mesh', 'x'));
    await logger.close(100);
    assert.equal(io.appendCalls, 0);
    assert.equal(stderr.lines.length, 0);
    assert.equal(clock.pending(), 0);
    assert.equal(stderr.guards, 0);
  });

  it('시계나 타이머가 던져도 event 와 close 는 던지지 않는다', async () => {
    const io = createMemoryIo(DIR);
    const stderr = createMemoryStderr();
    const broken = {
      setTimeout: (): never => {
        throw new Error('timer');
      },
      clearTimeout: (): never => {
        throw new Error('timer');
      },
    };
    const logger = createFileLoggerWith(
      {
        dir: DIR,
        service: 'mcp',
        level: 'debug',
        now: () => {
          throw new Error('clock');
        },
        timers: broken,
      },
      { io, stderr },
    );
    assert.doesNotThrow(() => logger.event('error', 'mesh', 'x'));
    await logger.close(100);
  });

  it('필드를 읽다 던지는 사건은 그 줄만 버린다', async () => {
    const r = rig();
    const bad = {
      get outcome(): string {
        throw new Error('getter');
      },
    };
    assert.doesNotThrow(() => r.logger.event('info', 'mesh', 'bad', bad));
    r.logger.event('info', 'mesh', 'good');
    await r.flush();
    assert.deepEqual(r.lines().map((line) => line['event']), ['good']);
  });
});
