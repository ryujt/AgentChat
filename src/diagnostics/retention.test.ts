// V-U6: 파일 이름의 시간 구간으로 판정하는 보존 정리 (architecture.md 6.3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HOUR_MS, RETENTION_MS, cleanupLogDir, hourKeyOf, isExpired, logFileName, parseLogFileName } from './retention.js';
import { createMemoryIo } from './testing.js';

const DIR = '/logs';
const START = Date.UTC(2026, 10, 1, 9); // 구간 [09:00, 10:00)
const END = START + HOUR_MS;
const NAME = 'diag-20261101T09-abc123.jsonl';

const run = (io: ReturnType<typeof createMemoryIo>, nowMs: number, extra: { keep?: string; maxDirBytes?: number; stopped?: () => boolean } = {}) =>
  cleanupLogDir({
    dir: DIR,
    nowMs,
    io,
    keep: extra.keep ?? null,
    maxDirBytes: extra.maxDirBytes ?? Number.MAX_SAFE_INTEGER,
    stopped: extra.stopped ?? (() => false),
  });

describe('V-U6 로그 파일 이름', () => {
  it('시간 구간과 proc 으로 이름을 만들고 되읽는다', () => {
    assert.equal(hourKeyOf(START + 59 * 60_000), '20261101T09');
    assert.equal(logFileName('20261101T09', 'abc123'), NAME);
    assert.deepEqual(parseLogFileName(NAME), { startMs: START, proc: 'abc123' });
  });

  it('UTC 로 센다', () => {
    assert.equal(hourKeyOf(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), '20261231T23');
    assert.equal(hourKeyOf(Date.UTC(2027, 0, 1, 0, 0, 0, 0)), '20270101T00');
  });

  it('이 모듈이 만든 이름이 아니면 읽지 않는다', () => {
    for (const name of [
      'diag-20261101T09-abc123.jsonl.bak',
      'diag-20261101T09-ABC123.jsonl',
      'diag-20261101T09-abc12.jsonl',
      'diag-20261101-abc123.jsonl',
      'diag-20261301T09-abc123.jsonl',
      'diag-20261132T09-abc123.jsonl',
      'diag-20261101T24-abc123.jsonl',
      'transcript.jsonl',
      'x-diag-20261101T09-abc123.jsonl',
    ]) {
      assert.equal(parseLogFileName(name), null, name);
    }
  });

  it('표현할 수 없는 시각에는 구간 이름이 없다', () => {
    assert.equal(hourKeyOf(Number.NaN), null);
    assert.equal(hourKeyOf(9e15), null);
    assert.equal(hourKeyOf(Date.UTC(10000, 0, 1)), null);
  });
});

describe('V-U6 7일 보존의 경계', () => {
  it('구간의 끝에서 7일 직전·정확히 7일·직후', () => {
    assert.equal(isExpired(START, END + RETENTION_MS - 1), false, '직전');
    assert.equal(isExpired(START, END + RETENTION_MS), false, '경계');
    assert.equal(isExpired(START, END + RETENTION_MS + 1), true, '직후');
  });

  it('직전과 경계에는 남기고 직후에는 지운다', async () => {
    for (const [offset, removed] of [[-1, false], [0, false], [1, true]] as const) {
      const io = createMemoryIo(DIR);
      io.files.set(NAME, 'x\n');
      const result = await run(io, END + RETENTION_MS + offset);
      assert.equal(io.files.has(NAME), !removed, `offset ${offset}`);
      assert.deepEqual(result, { removed: removed ? 1 : 0, failed: 0 });
    }
  });

  it('미래 구간의 파일과 남의 파일은 건드리지 않는다', async () => {
    const io = createMemoryIo(DIR);
    io.files.set('diag-20991231T23-abc123.jsonl', 'x\n');
    io.files.set('notes.txt', 'x');
    io.files.set('diag-20200101T00-abc123.jsonl.bak', 'x');
    io.files.set('diag-20200101T00-abc123.jsonl', 'x');
    const result = await run(io, END + RETENTION_MS * 2);
    assert.deepEqual(io.removed, ['diag-20200101T00-abc123.jsonl']);
    assert.deepEqual(result, { removed: 1, failed: 0 });
  });
});

describe('V-U6 디렉터리 상한', () => {
  const names = ['diag-20261114T07-aaaaaa.jsonl', 'diag-20261114T08-bbbbbb.jsonl', 'diag-20261114T09-cccccc.jsonl', 'diag-20261114T10-dddddd.jsonl'];
  const now = Date.UTC(2026, 10, 14, 10, 30);

  it('상한을 넘으면 오래된 파일부터 상한 아래가 될 때까지 지운다', async () => {
    const io = createMemoryIo(DIR);
    for (const name of names) {
      io.files.set(name, 'x');
      io.sizes.set(name, 100);
    }
    const result = await run(io, now, { maxDirBytes: 250 });
    assert.deepEqual(io.removed, [names[0], names[1]]);
    assert.deepEqual(result, { removed: 2, failed: 0 });
  });

  it('정확히 상한이면 지우지 않는다', async () => {
    const io = createMemoryIo(DIR);
    for (const name of names) {
      io.files.set(name, 'x');
      io.sizes.set(name, 100);
    }
    await run(io, now, { maxDirBytes: 400 });
    assert.deepEqual(io.removed, []);
  });

  it('지금 쓰는 자기 파일은 가장 오래됐어도 지우지 않는다', async () => {
    const io = createMemoryIo(DIR);
    for (const name of names) {
      io.files.set(name, 'x');
      io.sizes.set(name, 100);
    }
    await run(io, now, { maxDirBytes: 250, keep: names[0] as string });
    assert.deepEqual(io.removed, [names[1], names[2]]);
  });

  it('남의 파일은 크기로만 세고 지우지 않는다', async () => {
    const io = createMemoryIo(DIR);
    io.files.set('big.bin', 'x');
    io.sizes.set('big.bin', 1000);
    io.files.set(names[3] as string, 'x');
    io.sizes.set(names[3] as string, 10);
    await run(io, now, { maxDirBytes: 500 });
    assert.deepEqual(io.removed, [names[3]]);
    assert.ok(io.files.has('big.bin'));
  });
});

describe('V-U6 정리 실패', () => {
  it('지우지 못한 건수를 세고 나머지는 계속 지운다', async () => {
    const io = createMemoryIo(DIR);
    io.files.set('diag-20200101T00-aaaaaa.jsonl', 'x');
    io.files.set('diag-20200101T01-locked.jsonl', 'x');
    io.files.set('diag-20200101T02-cccccc.jsonl', 'x');
    io.failRemove = 'locked';
    const result = await run(io, END);
    assert.deepEqual(result, { removed: 2, failed: 1 });
    assert.ok(io.files.has('diag-20200101T01-locked.jsonl'));

    // 다음 주기에 다시 지운다.
    io.failRemove = null;
    assert.deepEqual(await run(io, END), { removed: 1, failed: 0 });
    assert.equal(io.files.size, 0);
  });

  it('7일 정리에서 실패한 파일을 상한 정리에서 다시 세지 않는다', async () => {
    const io = createMemoryIo(DIR);
    io.files.set('diag-20200101T01-locked.jsonl', 'x');
    io.sizes.set('diag-20200101T01-locked.jsonl', 1000);
    io.failRemove = 'locked';
    assert.deepEqual(await run(io, END, { maxDirBytes: 10 }), { removed: 0, failed: 1 });
  });

  it('목록을 읽지 못하면 실패 1건이고 던지지 않는다', async () => {
    const io = createMemoryIo(DIR);
    io.failList = true;
    assert.deepEqual(await run(io, END), { removed: 0, failed: 1 });
  });

  it('닫히면 남은 삭제를 그만둔다', async () => {
    const io = createMemoryIo(DIR);
    io.files.set('diag-20200101T00-aaaaaa.jsonl', 'x');
    io.files.set('diag-20200101T01-bbbbbb.jsonl', 'x');
    let calls = 0;
    const result = await run(io, END, { stopped: () => (calls += 1) > 1 });
    assert.deepEqual(result, { removed: 1, failed: 0 });
    assert.equal(io.files.size, 1);
  });
});
