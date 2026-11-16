// 서버 진입점(dist/entry/server.js)을 프로세스로 띄워 실행 옵션, 준비 문구, 종료, 로그 출력을 본다 (deployment.md 3절).
// 규칙과 리스너의 동작은 다른 시험이 본다. 여기서는 조립만 본다.
//
//   node --test tests/wire/server-entry.test.mjs
//
// 빌드 결과는 dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 알려 준다.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createProcTracker } from '../support/proc.mjs';
import { createWireSession, freshRoom, newIdentity, openWire, until } from './wire-client.mjs';

const procs = createProcTracker({ label: 'entry' });
const READY = /^agent-chat-server 준비됨\. listening on (ws:\/\/\S+)$/m;

function start(args, opts = {}) {
  return procs.spawnDist('entry/server.js', args, { name: 'server', stdin: 'ignore', ...opts });
}

async function ready(server) {
  return (await server.waitForOutput(READY, { timeoutMs: 10_000 }))[1];
}

describe('서버 진입점', { concurrency: false }, () => {
  after(async () => {
    try {
      await procs.assertNoneLeft({ graceMs: 2_000 });
    } finally {
      await procs.dispose();
    }
  });

  it('--help 는 옵션 안내를 stdout 에 쓰고 종료 코드 0 으로 끝난다. 서버를 띄우지 않는다', async () => {
    const server = start(['--help']);
    const exit = await server.waitForExit({ timeoutMs: 10_000 });
    assert.equal(exit.code, 0);
    for (const option of ['--host', '--port', '--max-connections', '--max-connections-per-ip', '--join-deadline-ms', '--trust-proxy', '--log-dir']) {
      assert.ok(server.stdout().includes(option), `안내에 ${option} 이 없다`);
    }
    assert.equal(READY.test(server.stdout()), false);
    assert.equal(server.stderr(), '');
  });

  it('모르는 옵션, 값이 빠진 옵션, 범위를 벗어난 값은 사유와 안내를 stderr 에 쓰고 종료 코드 1 로 끝난다', async () => {
    const cases = [
      ['--no-such-option'],
      ['--port'],
      ['--port', 'abc'],
      ['--port', '70000'],
      ['--port', '-1'],
      ['--max-connections', '0'],
      ['--max-connections-per-ip', '1.5'],
      ['--join-deadline-ms', '0'],
      ['--host', ''],
      ['extra-positional'],
    ];
    for (const args of cases) {
      const server = start(args);
      const exit = await server.waitForExit({ timeoutMs: 10_000 });
      assert.equal(exit.code, 1, `${args.join(' ')}: 종료 코드 ${exit.code}`);
      assert.match(server.stderr(), /사용법: agent-chat-server/, args.join(' '));
      assert.equal(server.stdout(), '', `${args.join(' ')}: stdout 에 출력이 있다`);
    }
  });

  it('포트를 열 수 없으면 사유를 stderr 에 쓰고 종료 코드 1 로 끝난다', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    try {
      const server = start(['--host', '127.0.0.1', '--port', String(blocker.address().port)]);
      const exit = await server.waitForExit({ timeoutMs: 10_000 });
      assert.equal(exit.code, 1);
      assert.match(server.stderr(), /서버를 시작하지 못했다\(EADDRINUSE\)/);
      assert.equal(READY.test(server.stdout()), false, '준비 문구를 쓰면 안 된다');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('준비 문구에 실제 주소를 쓰고, 문구 직후의 SIGTERM·SIGINT·SIGHUP 에 종료 코드 0 으로 끝난다', async () => {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const server = start(['--host', '127.0.0.1', '--port', '0']);
      const url = await ready(server);
      assert.match(url, /^ws:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
      // 문구를 본 즉시 보낸다. 처리기가 문구보다 먼저 걸려 있어야 한다.
      const stopped = await server.stop({ signal, timeoutMs: 5_000 });
      assert.equal(stopped.forced, false, signal);
      assert.equal(stopped.code, 0, `${signal}: 코드 ${stopped.code}, 신호 ${stopped.signal}`);
      assert.equal(server.stderr(), '');
    }
  });

  it('stdout 에는 준비 문구 한 줄과 JSON 줄만 나온다. 방 ID, 이름, key 의 원문이 없다', async () => {
    const server = start(['--host', '127.0.0.1', '--port', '0']);
    const url = await ready(server);
    const session = createWireSession(url);
    const room = freshRoom();
    const alice = await session.joined(room, 'create', newIdentity('alice-entry-test'));
    const bob = await session.joined(room, 'join', newIdentity('bob-entry-test'));
    alice.signal('bob-entry-test', { kind: 'offer', cid: `${alice.identity.sid}.1`, data: { sdp: 'v=0\r\na=entry-test-sdp-marker\r\n' } });
    await bob.waitFor('signal', () => bob.signals().length === 1);
    alice.sendRaw('entry-test-garbage-marker');
    await alice.waitFor('BAD_MESSAGE', () => alice.errors().length === 1);
    await session.closeAll();
    await server.stop();

    const lines = server.stdout().split('\n').filter((line) => line !== '');
    const plain = lines.filter((line) => !line.startsWith('{'));
    assert.deepEqual(plain, [`agent-chat-server 준비됨. listening on ${url}`]);
    const entries = lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    assert.ok(entries.length >= 6);
    for (const entry of entries) {
      assert.equal(entry.svc, 'server');
      assert.equal(typeof entry.ts, 'string');
      assert.equal(typeof entry.proc, 'string');
      assert.equal(Object.hasOwn(entry, 'peer'), false, '서버 로그에 peer 칸이 있다');
    }
    const events = new Set(entries.map((entry) => entry.event));
    for (const expected of ['conn.join', 'relay', 'conn.rejected', 'conn.closed']) assert.ok(events.has(expected), `${expected} 사건이 없다`);
    const text = server.stdout();
    for (const secret of [room, 'alice-entry-test', 'bob-entry-test', alice.identity.key, bob.identity.key, 'entry-test-sdp-marker', 'entry-test-garbage-marker']) {
      assert.equal(text.includes(secret), false, `로그에 원문이 남았다: ${secret}`);
    }
  });

  it('--log-dir 를 주면 로그를 그 디렉터리의 파일에 쓰고 stdout 에는 준비 문구만 쓴다', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-chat-server-log-'));
    try {
      const server = start(['--host', '127.0.0.1', '--port', '0', '--log-dir', dir]);
      const url = await ready(server);
      const session = createWireSession(url);
      await session.joined(freshRoom(), 'create');
      await session.closeAll();
      const stopped = await server.stop();
      assert.equal(stopped.code, 0);
      assert.deepEqual(server.stdout().split('\n').filter((line) => line !== ''), [`agent-chat-server 준비됨. listening on ${url}`]);

      const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
      assert.equal(files.length, 1, `로그 파일: ${files.join(', ')}`);
      const entries = (await readFile(path.join(dir, files[0]), 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
      const events = entries.map((entry) => entry.event);
      assert.ok(events.includes('conn.join'), `파일의 사건: ${events.join(', ')}`);
      assert.ok(events.includes('conn.closed'), '종료 직전의 사건까지 파일에 쓴다');
      assert.equal(entries.every((entry) => entry.svc === 'server'), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('실행 옵션이 리스너에 닿는다: 주소별 연결 수, 미입장 기한, trust-proxy', async () => {
    const server = start(['--host', '127.0.0.1', '--port', '0', '--max-connections', '3', '--max-connections-per-ip', '2', '--join-deadline-ms', '400', '--trust-proxy']);
    const url = await ready(server);
    const headers = (ip) => ({ 'X-Forwarded-For': ip });
    const first = await openWire(url, { headers: headers('203.0.113.1') });
    const second = await openWire(url, { headers: headers('203.0.113.1') });
    await assert.rejects(openWire(url, { headers: headers('203.0.113.1') }), (error) => error.status === 429);
    const other = await openWire(url, { headers: headers('203.0.113.2') });
    await assert.rejects(openWire(url, { headers: headers('203.0.113.3') }), (error) => error.status === 503);

    const startedAt = Date.now();
    await Promise.all([first.closed({ timeoutMs: 5_000 }), second.closed({ timeoutMs: 5_000 }), other.closed({ timeoutMs: 5_000 })]);
    const took = Date.now() - startedAt;
    assert.ok(took < 3_000, `미입장 기한 400ms 가 듣지 않았다: ${took}ms`);
    await until('연결 0', async () => (await (await fetch(`${url.replace('ws://', 'http://')}/healthz`)).json()).connections === 0);
    const stopped = await server.stop();
    assert.equal(stopped.code, 0);
    assert.equal(server.stderr(), '');
  });
});
