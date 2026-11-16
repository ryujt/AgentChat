// V-U6: 실제 파일 시스템과 실제 프로세스로 보는 부분(로컬 실물). 권한, mtime, 디렉터리 상한, stdout 분리.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { FLUSH_DELAY_MS } from './file-logger.js';
import { createFileLogger, createStdoutLogger } from './index.js';
import { HOUR_MS, RETENTION_MS } from './retention.js';
import { createFakeClock, parseLines } from './testing.js';

const T0 = Date.UTC(2026, 10, 15, 9, 30, 0);
const root = mkdtempSync(join(tmpdir(), 'agent-chat-w7-'));
after(() => rmSync(root, { recursive: true, force: true }));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`기다린 상태가 오지 않았다: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('V-U6 실제 파일: 프로세스별 파일과 권한', () => {
  it('디렉터리를 0700, 파일을 0600 으로 만든다', async () => {
    const dir = join(root, 'perm', 'logs');
    const clock = createFakeClock(T0);
    const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    assert.equal(modeOf(dir), 0o700);
    logger.event('info', 'mesh', 'link.open', { peer: 'alice' });
    await logger.close(2000);
    const file = join(dir, `diag-20261115T09-${logger.proc}.jsonl`);
    assert.deepEqual(readdirSync(dir), [`diag-20261115T09-${logger.proc}.jsonl`]);
    assert.equal(modeOf(file), 0o600);
    const lines = parseLines(readFileSync(file, 'utf8'));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.['proc'], logger.proc);
    assert.equal(lines[0]?.['peer'], 'alice');
  });

  it('같은 디렉터리의 두 로거가 서로 다른 파일에 쓴다', async () => {
    const dir = join(root, 'two');
    const clock = createFakeClock(T0);
    const a = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    const b = createFileLogger({ dir, service: 'cli', level: 'info', now: clock.now, timers: clock.timers });
    assert.notEqual(a.proc, b.proc);
    for (let i = 0; i < 20; i += 1) {
      a.event('info', 'mesh', 'a', { seq: i });
      b.event('info', 'setup', 'b', { seq: i });
    }
    await Promise.all([a.close(2000), b.close(2000)]);
    assert.equal(readdirSync(dir).length, 2);
    for (const logger of [a, b]) {
      const lines = parseLines(readFileSync(join(dir, `diag-20261115T09-${logger.proc}.jsonl`), 'utf8'));
      assert.equal(lines.length, 20);
      for (const line of lines) assert.equal(line['proc'], logger.proc);
    }
  });

  it('타이머로 비동기 덧붙이기를 하고 이어 쓴다', async () => {
    const dir = join(root, 'append');
    const clock = createFakeClock(T0);
    const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    const file = join(dir, `diag-20261115T09-${logger.proc}.jsonl`);
    logger.event('info', 'mesh', 'one');
    assert.equal(existsSync(file), false, 'event 안에서 쓰지 않는다');
    clock.advance(FLUSH_DELAY_MS);
    await waitFor(() => existsSync(file) && parseLines(readFileSync(file, 'utf8')).length === 1, '첫 줄');
    logger.event('info', 'mesh', 'two');
    await logger.close(2000);
    assert.deepEqual(parseLines(readFileSync(file, 'utf8')).map((line) => line['event']), ['one', 'two']);
  });

  it('디렉터리를 만들 수 없으면 던지지 않고 아무 것도 쓰지 않는다', async () => {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const clock = createFakeClock(T0);
    const logger = createFileLogger({ dir: join(blocker, 'logs'), service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    assert.doesNotThrow(() => logger.event('error', 'mesh', 'x'));
    await logger.close(100);
    assert.equal(readFileSync(blocker, 'utf8'), 'x');
    assert.equal(clock.pending(), 0);
  });

  it('쓰기 권한이 없는 디렉터리면 던지지 않고 아무 것도 쓰지 않는다', async () => {
    const dir = join(root, 'readonly');
    mkdirSync(dir, { mode: 0o500 });
    const clock = createFakeClock(T0);
    const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    logger.event('error', 'mesh', 'x');
    await logger.close(100);
    assert.deepEqual(readdirSync(dir), []);
  });
});

describe('V-U6 실제 파일: 보존 정리', () => {
  const END = Date.UTC(2026, 10, 1, 10); // diag-20261101T09 구간의 끝

  it('7일 직전·경계에는 남기고 직후에는 지운다. mtime 을 바꿔도 판정이 같다', async () => {
    for (const [label, offset, removed] of [['직전', -1, false], ['경계', 0, false], ['직후', 1, true]] as const) {
      for (const mtime of ['fresh', 'ancient'] as const) {
        const dir = join(root, `keep-${offset}-${mtime}`);
        mkdirSync(dir);
        const old = join(dir, 'diag-20261101T09-old000.jsonl');
        writeFileSync(old, '{}\n');
        const nowMs = END + RETENTION_MS + offset;
        // 이름으로는 오래된 파일의 mtime 을 지금으로, 또는 아주 옛날로 바꾼다.
        const stamp = mtime === 'fresh' ? nowMs / 1000 : 0;
        utimesSync(old, stamp, stamp);
        const clock = createFakeClock(nowMs);
        const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
        if (removed) await waitFor(() => !existsSync(old), `${label} ${mtime}`);
        else await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(existsSync(old), !removed, `${label} ${mtime}`);
        await logger.close(100);
      }
    }
  });

  it('이름으로는 새 파일이면 mtime 이 아주 오래돼도 남긴다', async () => {
    const dir = join(root, 'new-name-old-mtime');
    mkdirSync(dir);
    const recent = join(dir, 'diag-20261115T08-new000.jsonl');
    const stale = join(dir, 'diag-20261101T09-old000.jsonl');
    writeFileSync(recent, '{}\n');
    writeFileSync(stale, '{}\n');
    utimesSync(recent, 0, 0);
    utimesSync(stale, T0 / 1000, T0 / 1000);
    const clock = createFakeClock(T0);
    const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    await waitFor(() => !existsSync(stale), '오래된 이름의 파일 삭제');
    assert.equal(existsSync(recent), true);
    await logger.close(100);
  });

  it('남의 파일과 하위 디렉터리는 지우지 않는다', async () => {
    const dir = join(root, 'others');
    mkdirSync(join(dir, 'diag-20200101T00-subdir.jsonl.d'), { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'diag-20200101T00-abc123.jsonl.bak'), 'x');
    writeFileSync(join(dir, 'diag-20200101T00-abc123.jsonl'), 'x');
    const clock = createFakeClock(T0);
    const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    await waitFor(() => !existsSync(join(dir, 'diag-20200101T00-abc123.jsonl')), '오래된 로그 삭제');
    await logger.close(100);
    assert.deepEqual(readdirSync(dir).sort(), ['diag-20200101T00-abc123.jsonl.bak', 'diag-20200101T00-subdir.jsonl.d', 'notes.txt']);
  });

  it('디렉터리가 200MB 를 넘으면 오래된 파일부터 지운다(기본 상한)', async () => {
    const dir = join(root, 'cap');
    mkdirSync(dir);
    const names = ['diag-20261114T07-aaaaaa.jsonl', 'diag-20261114T08-bbbbbb.jsonl', 'diag-20261114T09-cccccc.jsonl'];
    for (const name of names) {
      writeFileSync(join(dir, name), '');
      // 내용 없이 길이만 늘린다. 디스크를 실제로 채우지 않는다.
      truncateSync(join(dir, name), 90 * 1024 * 1024);
    }
    const clock = createFakeClock(T0);
    const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    await waitFor(() => !existsSync(join(dir, names[0] as string)), '가장 오래된 파일 삭제');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(readdirSync(dir).sort(), [names[1], names[2]]);
    await logger.close(100);
  });

  it('지울 수 없는 파일이 있으면 log.cleanup 을 남기고 다음 주기에 다시 지운다', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root 는 권한 없는 디렉터리에서도 지울 수 있다');
      return;
    }
    const dir = join(root, 'locked');
    mkdirSync(dir);
    const old = join(dir, 'diag-20261101T09-old000.jsonl');
    writeFileSync(old, '{}\n');
    const clock = createFakeClock(T0);
    // 쓸 수 있는지 확인한 뒤에 디렉터리의 쓰기 권한을 뺀다. 삭제와 덧붙이기가 함께 실패한다.
    const logger = createFileLogger({ dir, service: 'mcp', level: 'info', now: clock.now, timers: clock.timers });
    // 정리가 이미 지웠을 수 있으므로 파일을 다시 두고 다음 주기를 본다.
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(old, '{}\n');
    chmodSync(dir, 0o500);
    try {
      clock.advance(HOUR_MS);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(existsSync(old), true, '권한이 없어 지우지 못한다');
    } finally {
      chmodSync(dir, 0o700);
    }
    clock.advance(FLUSH_DELAY_MS);
    const mine = join(dir, `diag-20261115T10-${logger.proc}.jsonl`);
    await waitFor(() => existsSync(mine), 'log.cleanup 줄');
    const [line] = parseLines(readFileSync(mine, 'utf8'));
    assert.equal(line?.['event'], 'log.cleanup');
    assert.equal(line?.['failed'], 1);
    clock.advance(HOUR_MS);
    await waitFor(() => !existsSync(old), '다음 주기의 삭제');
    await logger.close(1000);
  });
});

describe('V-U6 실제 프로세스: stdout 과 stderr', () => {
  const indexUrl = new URL('./index.js', import.meta.url).href;

  function runChild(body: string, dir: string): { stdout: string; stderr: string; status: number | null } {
    const script = `
      import { createFileLogger, createStdoutLogger } from ${JSON.stringify(indexUrl)};
      const timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
      const now = () => ${T0};
      const dir = ${JSON.stringify(dir)};
      ${body}
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  it('파일 로거는 stdout 에 아무 것도 쓰지 않고 warn 이상만 stderr 에 쓴다', () => {
    const dir = join(root, 'child-file');
    const out = runChild(
      `const log = createFileLogger({ dir, service: 'mcp', level: 'debug', now, timers });
       log.event('debug', 'mesh', 'd'); log.event('info', 'mesh', 'i', { peer: 'alice' });
       log.event('warn', 'mesh', 'w'); log.event('error', 'mesh', 'e');
       await log.close(3000);`,
      dir,
    );
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, '', 'MCP 프로세스의 stdout 에는 MCP 메시지만 나간다');
    assert.deepEqual(parseLines(out.stderr).map((line) => line['event']), ['w', 'e']);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(parseLines(readFileSync(join(dir, files[0] as string), 'utf8')).map((line) => line['event']), ['d', 'i', 'w', 'e']);
  });

  it('stdout 로거는 stdout 에 JSON 한 줄씩 쓰고 서버 로그에 peer 가 없다', () => {
    const out = runChild(
      `const log = createStdoutLogger({ service: 'server', level: 'info', now });
       log.event('debug', 'signaling-core', 'low');
       log.event('info', 'signaling-core', 'room.join', { peer: 'alice', peer_ref: '0123456789ab', sdp: 'v=0' });
       log.event('warn', 'signaling-core', 'conn.reject', { reason: 'a\\nb' });
       await log.close(100);
       log.event('error', 'signaling-core', 'after.close');`,
      join(root, 'unused'),
    );
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, '');
    const lines = parseLines(out.stdout);
    assert.deepEqual(lines.map((line) => line['event']), ['room.join', 'conn.reject']);
    assert.equal('peer' in (lines[0] ?? {}), false);
    assert.equal('sdp' in (lines[0] ?? {}), false);
    assert.equal(lines[0]?.['peer_ref'], '0123456789ab');
    assert.equal(lines[1]?.['reason'], 'a b');
    assert.equal(lines[0]?.['proc'], lines[1]?.['proc']);
  });

  it('Lambda 로거는 console.log 로 JSON 한 줄씩 쓴다', () => {
    const out = runChild(
      `const seen = [];
       const original = console.log;
       console.log = (...args) => { seen.push(args); original(...args); };
       const log = createStdoutLogger({ service: 'lambda', level: 'info', now });
       log.event('info', 'signaling-aws', 'conn.open', { peer: 'alice', conn_ref: '0123456789ab' });
       await log.close(100);
       if (seen.length !== 1 || seen[0].length !== 1 || typeof seen[0][0] !== 'string') process.exit(3);`,
      join(root, 'unused'),
    );
    assert.equal(out.status, 0, out.stderr);
    const lines = parseLines(out.stdout);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.['svc'], 'lambda');
    assert.equal('peer' in (lines[0] ?? {}), false);
    assert.equal(lines[0]?.['conn_ref'], '0123456789ab');
  });

  it('이 프로세스에서도 로거를 만들고 닫을 수 있다(리스너가 남지 않는다)', async () => {
    const before = { out: process.stdout.listenerCount('error'), err: process.stderr.listenerCount('error') };
    const clock = createFakeClock(T0);
    const file = createFileLogger({ dir: join(root, 'listeners'), service: 'cli', level: 'error', now: clock.now, timers: clock.timers });
    const std = createStdoutLogger({ service: 'server', level: 'error', now: clock.now });
    assert.equal(process.stderr.listenerCount('error'), before.err + 1);
    assert.equal(process.stdout.listenerCount('error'), before.out + 1);
    await file.close(100);
    await std.close(100);
    assert.equal(process.stderr.listenerCount('error'), before.err);
    assert.equal(process.stdout.listenerCount('error'), before.out);
    assert.equal(clock.pending(), 0);
  });
});
