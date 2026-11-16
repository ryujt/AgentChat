// 소켓 서버 결함 주입 F-01~F-14 (verification-plan.md 6절). V-L1 의 일부다.
// 주입마다 자체 호스팅 서버 프로세스를 새로 띄우고, 실제 소켓으로 결함을 만든다. 시계는 실제 시계다.
// 서버가 지킬 것은 하나다: 한 연결의 잘못된 입력·단절·느림이 다른 연결을 멈추지 않는다.
//
// 쓰는 법:
//   node --test --test-concurrency=1 tests/wire/fault-injection.mjs
//   node --test --test-name-pattern="F-05" tests/wire/fault-injection.mjs     # 하나만
//
// 주입마다 여섯 가지를 확인한다(withServer 의 끝):
//   ① 프로세스가 살아 있고 /healthz 가 응답한다          ② 미처리 예외가 없다(stderr 가 비어 있다)
//   ③ 대조군 두 연결이 주입 내내 ping·signal 을 주고받는다  ④ 신규 접속이 된다(꽉 찬 경우의 거절은 F-08 이 본다)
//   ⑤ 문제 연결만 정한 사유로 처리된다(주입별 단언)        ⑥ 이후 SIGTERM 에 5초 안에 종료 코드 0 으로 끝난다
// 끝날 때 자기가 띄운 프로세스가 남지 않았는지 확인한다.
//
// 걸리는 시간: F-06 이 약 100초(오래됨 90초), F-03·F-09 가 각 12초쯤이다. 전체 3분 안팎.
// 빌드 결과는 dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 알려 준다.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, createProcTracker } from '../support/proc.mjs';
import { LIMITS, createWireSession, delay, freshName, freshRoom, newIdentity, openWire, refOf, until } from './wire-client.mjs';

const PEER_SCRIPT = path.join(REPO_ROOT, 'tests', 'wire', 'wire-peer.mjs');
const CONTROL_INTERVAL_MS = 500;
const codeOf = (message) => (message?.type === 'error' ? message.code : message?.type);

/** 그 프로세스의 상주 메모리(MB). 서버 밖에서 잰다. */
function rssMb(pid) {
  const kb = Number.parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10);
  return Math.round(kb / 1024);
}

/** 속도 제한의 고정 창(60초)을 걸치지 않게, 남은 창이 모자라면 다음 창까지 기다린다. */
async function alignRateWindow(needMs) {
  const left = LIMITS.RATE_WINDOW_MS - (Date.now() % LIMITS.RATE_WINDOW_MS);
  if (left < needMs) await delay(left + 1_000);
}

/**
 * 서버를 띄우고 대조군을 붙인 뒤 body 를 돌린다. 끝에 여섯 가지를 확인하고 프로세스를 정리한다.
 * @param {string[]} serverArgs 서버에 더할 실행 옵션.
 * @param {(env: object) => Promise<{keepConnections?: boolean} | void>} body
 */
async function withServer(t, serverArgs, body) {
  const procs = createProcTracker({ label: 'fault' });
  let failure = null;
  try {
    const server = procs.spawnDist('entry/server.js', ['--host', '127.0.0.1', '--port', '0', ...serverArgs], { name: 'server', stdin: 'ignore' });
    const ready = await server.waitForOutput(/listening on (ws:\/\/\S+)/, { timeoutMs: 10_000 });
    const url = ready[1];
    const port = Number.parseInt(new URL(url).port, 10);
    const session = createWireSession(url);

    const logs = () =>
      server
        .stdout()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    const events = (name, filter = () => true) => logs().filter((entry) => entry.event === name && filter(entry));
    const health = async () => {
      const response = await fetch(`${url.replace('ws://', 'http://')}/healthz`);
      assert.equal(response.status, 200, '/healthz 의 상태 코드');
      return response.json();
    };

    // 대조군: 주입과 무관한 방의 두 연결이 내내 ping 과 signal 을 주고받는다.
    const controlRoom = freshRoom();
    const a = await session.joined(controlRoom, 'create', newIdentity(freshName('ctl-a')), { label: 'control-a' });
    const b = await session.joined(controlRoom, 'join', newIdentity(freshName('ctl-b')), { label: 'control-b' });
    const control = { rounds: 0, sent: 0, failures: [], maxRttMs: 0 };
    let running = true;
    const loop = (async () => {
      while (running) {
        try {
          const startedAt = Date.now();
          const pongA = await a.ping({ timeoutMs: 5_000 });
          const pongB = await b.ping({ timeoutMs: 5_000 });
          control.maxRttMs = Math.max(control.maxRttMs, pongA.elapsedMs, pongB.elapsedMs);
          if (pongA.type !== 'pong' || pongB.type !== 'pong') control.failures.push(`ping 응답: ${codeOf(pongA)}, ${codeOf(pongB)}`);
          else if (pongA.members[0]?.peer !== b.identity.peer || pongB.members[0]?.peer !== a.identity.peer) control.failures.push('목록에 상대가 없다');
          const before = b.signals().length;
          a.signal(b.identity.peer);
          control.sent += 1;
          await b.waitFor('대조군 signal', () => b.signals().length > before, { timeoutMs: 5_000 });
          control.maxRttMs = Math.max(control.maxRttMs, Date.now() - startedAt);
          control.rounds += 1;
        } catch (error) {
          control.failures.push(error.message);
        }
        // 대조군 자신이 속도 제한(60초 300건)에 걸리지 않게 한다. 한 바퀴에 a 가 두 건, b 가 한 건을 보낸다.
        await delay(CONTROL_INTERVAL_MS);
      }
    })();

    const env = { t, procs, server, url, port, session, logs, events, health, control, rss: () => rssMb(server.pid) };
    let outcome;
    try {
      outcome = (await body(env)) ?? {};
      // 주입이 짧게 끝났어도 대조군이 몇 바퀴는 돈 뒤에 판정한다.
      await until('대조군 3회', () => control.rounds >= 3 || control.failures.length > 0, { timeoutMs: 15_000 });
    } finally {
      running = false;
      await loop;
    }

    // ③ 무관한 연결이 정상이다.
    assert.deepEqual(control.failures, [], '③ 대조군이 주입 중에 실패했다');
    assert.ok(control.rounds >= 3, `③ 대조군이 주입 동안 ${control.rounds}회만 돌았다`);
    assert.equal(b.signals().length, control.sent, '③ 대조군의 signal 이 빠지거나 겹쳤다');
    assert.equal(a.errors().length + b.errors().length, 0, '③ 대조군이 오류를 받았다');
    assert.equal(a.isOpen && b.isOpen, true, '③ 대조군의 연결이 닫혔다');
    // ① ② 프로세스가 살아 있고 미처리 예외가 없다.
    assert.equal(server.exit, null, '① 서버 프로세스가 끝났다');
    assert.equal((await health()).ok, true, '① /healthz');
    assert.equal(server.stderr().trim(), '', '② 서버의 stderr 에 출력이 있다');
    // ④ 신규 접속이 된다.
    const fresh = await session.joined(freshRoom(), 'create', undefined, { label: 'fresh' });
    assert.equal(fresh.joinedReply.type, 'joined', '④ 신규 입장');
    t.diagnostic(`대조군 ${control.rounds}회, 가장 긴 왕복 ${control.maxRttMs}ms`);

    if (outcome.keepConnections !== true) await session.closeAll();
    // ⑥ SIGTERM 에 5초 안에 끝난다.
    const openAtStop = session.clients.filter((client) => client.closeInfo === null).length;
    const stopped = await server.stop({ signal: 'SIGTERM', timeoutMs: 5_000 });
    assert.equal(stopped.forced, false, '⑥ 5초 안에 스스로 끝나지 않았다');
    assert.equal(stopped.code, 0, `⑥ 종료 코드 ${stopped.code}, 신호 ${stopped.signal}`);
    assert.equal(server.stderr().trim(), '', '② 종료 중 stderr 에 출력이 있다');
    t.diagnostic(`SIGTERM 뒤 ${stopped.stopMs}ms 에 종료 코드 0 (그때 열려 있던 시험 쪽 연결 ${openAtStop}개)`);
    if (outcome.keepConnections === true) {
      const deadline = Date.now() + 3_000;
      while (session.clients.some((client) => client.closeInfo === null) && Date.now() < deadline) await delay(20);
      assert.equal(session.clients.filter((client) => client.closeInfo === null).length, 0, '서버가 끝났는데 닫히지 않은 연결이 있다');
    }
    await procs.assertNoneLeft({ graceMs: 2_000 });
  } catch (error) {
    failure = error;
  } finally {
    const killed = await procs.dispose();
    if (failure === null && killed.length > 0) failure = new Error(`정리하면서 죽여야 했던 프로세스: ${killed.map((entry) => entry.name).join(', ')}`);
  }
  if (failure !== null) throw failure;
}

/** 마스크를 씌운 텍스트 프레임 하나(클라이언트 → 서버). 한 바이트씩 보내는 주입에 쓴다. */
function maskedTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

const HANDSHAKE = 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

describe('V-L1 결함 주입 (자체 호스팅 서버, 실제 소켓)', { concurrency: false }, () => {
  it('F-01 깨진 JSON 과 스키마 위반을 초당 수십 건: BAD_MESSAGE 로 답하고 연결을 유지한다. 한도를 넘으면 RATE_LIMITED 뒤 닫는다', async (t) => {
    await withServer(t, [], async (env) => {
      await alignRateWindow(15_000);
      const bad = await env.session.open({ label: 'bad' });
      const samples = ['{broken', '{"action":"join","v":1}', '{"action":"signal","id":"x","to":"??","kind":"offer"}', '[1,2,3]', ''];
      // 초당 50건으로 3초.
      for (let i = 0; i < 150; i += 1) {
        bad.sendRaw(samples[i % samples.length]);
        await delay(20);
      }
      await bad.waitFor('BAD_MESSAGE 150건', () => bad.errors((message) => message.code === 'BAD_MESSAGE').length === 150);
      assert.equal(bad.isOpen, true, '한도 안에서는 연결을 유지한다');
      assert.equal(codeOf(await bad.ping()), 'NOT_JOINED', '같은 연결이 계속 쓸 수 있다');

      for (let i = 0; i < 200; i += 1) bad.sendRaw('{broken');
      const limited = await bad.waitFor('RATE_LIMITED', () => bad.errors((message) => message.code === 'RATE_LIMITED')[0], { closeOk: true });
      assert.ok(limited.retry_after_ms > 0);
      await bad.closed();
      // ping 한 건을 뺀 299건이 BAD_MESSAGE 로 처리됐다.
      assert.equal(bad.errors((message) => message.code === 'BAD_MESSAGE').length, LIMITS.RATE_MAX_MESSAGES - 1);
      await until('rate.limited 로그', () => env.events('rate.limited', (entry) => entry.reason === 'rate').length === 1);
      assert.equal(env.events('conn.rejected', (entry) => entry.error_code === 'BAD_MESSAGE').length, LIMITS.RATE_MAX_MESSAGES - 1);
    });
  });

  it('F-02 16KB+1 프레임은 MESSAGE_TOO_LARGE, 1MB 프레임은 ws 가 받지 않고 그 연결만 닫는다', async (t) => {
    await withServer(t, [], async (env) => {
      const big = await env.session.open({ label: 'big' });
      for (let i = 0; i < 20; i += 1) big.sendRaw('x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES + 1));
      await big.waitFor('MESSAGE_TOO_LARGE 20건', () => big.errors((message) => message.code === 'MESSAGE_TOO_LARGE').length === 20);
      assert.equal(big.isOpen, true);
      assert.equal(codeOf(await big.ping()), 'NOT_JOINED');

      const before = env.rss();
      for (let i = 0; i < 20; i += 1) {
        const huge = await env.session.open({ label: 'huge' });
        huge.sendRaw('x'.repeat(1024 * 1024));
        const closed = await huge.closed();
        assert.equal(closed.code, 1009, '1MB 프레임을 보낸 연결의 종료 코드');
        assert.equal(huge.messages.length, 0, '해석하지 않고 닫는다');
      }
      const after = env.rss();
      t.diagnostic(`서버 RSS: 1MB 프레임 20건 전 ${before}MB, 뒤 ${after}MB`);
      assert.ok(after - before < 64, `메모리가 ${after - before}MB 늘었다`);
      await until('frame_too_large 로그', () => env.events('conn.drop', (entry) => entry.reason === 'frame_too_large').length === 20);
    });
  });

  it('F-03 접속만 하고 join 을 보내지 않는 연결 50개: 10초 뒤 닫는다. 그동안 신규 접속과 대조군은 정상이다', async (t) => {
    await withServer(t, ['--max-connections-per-ip', '200'], async (env) => {
      const idle = [];
      for (let i = 0; i < 50; i += 1) idle.push(await env.session.open({ label: `idle-${i}` }));
      const openedAt = Date.now();
      await delay(8_000);
      assert.equal(idle.filter((client) => client.isOpen).length, 50, '기한 전에 닫힌 연결이 있다');
      const during = await env.session.joined(freshRoom(), 'create');
      assert.equal(during.joinedReply.type, 'joined', '그동안 신규 입장이 된다');

      await Promise.all(idle.map((client) => client.closed({ timeoutMs: 8_000 })));
      const took = idle.map((client) => client.closeInfo.at - client.connectStartedAt);
      t.diagnostic(`닫힐 때까지: 최소 ${Math.min(...took)}ms, 최대 ${Math.max(...took)}ms (첫 연결부터 ${Date.now() - openedAt}ms)`);
      assert.ok(Math.min(...took) >= 9_500, `10초 전에 닫혔다: ${Math.min(...took)}ms`);
      assert.ok(Math.max(...took) <= 13_000, `너무 늦게 닫혔다: ${Math.max(...took)}ms`);
      await until('join_deadline 로그 50건', () => env.events('conn.drop', (entry) => entry.reason === 'join_deadline').length === 50);
      assert.equal(during.isOpen, true, '등록된 연결은 닫지 않는다');
    });
  });

  it('F-04 등록 뒤 signal 을 초당 수백 건: RATE_LIMITED 뒤 닫는다. 대상이 받는 건수는 한도 이하이고 대상의 다른 통신은 정상이다', async (t) => {
    await withServer(t, [], async (env) => {
      await alignRateWindow(10_000);
      const room = freshRoom();
      const target = await env.session.joined(room, 'create', undefined, { label: 'target' });
      const flooder = await env.session.joined(room, 'join', undefined, { label: 'flooder' });
      for (let i = 0; i < 600; i += 1) flooder.signal(target.identity.peer);
      await flooder.waitFor('RATE_LIMITED', () => flooder.errors((message) => message.code === 'RATE_LIMITED')[0], { closeOk: true });
      await flooder.closed();
      await delay(300);
      const delivered = target.signals().length;
      t.diagnostic(`600건 가운데 대상에 도착한 건수: ${delivered}`);
      // join 한 건을 뺀 299건까지만 전달된다.
      assert.equal(delivered, LIMITS.RATE_MAX_MESSAGES - 1);
      assert.equal(target.errors().length, 0);
      assert.deepEqual((await target.ping()).members, [], '끊긴 쪽의 기록이 지워졌다');
      assert.equal(env.events('rate.limited').length, 1);
    });
  });

  it('F-05 받지 않는 피어(소켓은 열어 두고 읽지 않음)에게 시그널을 계속 전달: 보낼 버퍼가 1MiB 를 넘으면 그 연결만 닫는다', async (t) => {
    await withServer(t, [], async (env) => {
      const room = freshRoom();
      const stuck = await env.session.joined(room, 'create', undefined, { label: 'stuck' });
      const senders = [];
      for (let i = 0; i < 6; i += 1) senders.push(await env.session.joined(room, 'join', undefined, { label: `sender-${i}` }));
      const before = env.rss();
      stuck.socket.pause();

      const sdp = `v=0\r\n${'a=filler:0123456789abcdef0123456789abcdef\r\n'.repeat(260)}`;
      assert.ok(sdp.length <= LIMITS.SDP_MAX_CHARS);
      let sent = 0;
      let peak = before;
      const dropped = () => env.events('conn.drop', (entry) => entry.reason === 'slow_consumer').length > 0;
      // 보내는 쪽마다 속도 제한(300) 아래로만 보낸다.
      for (let round = 0; round < 280 && !dropped(); round += 1) {
        for (const sender of senders) {
          sender.signal(stuck.identity.peer, { kind: 'offer', cid: `${sender.identity.sid}.1`, data: { sdp } });
          sent += 1;
        }
        await delay(10);
        if (round % 20 === 0) peak = Math.max(peak, env.rss());
      }
      await until('slow_consumer 로 끊김', dropped, { timeoutMs: 10_000 });
      const sentMb = Math.round((sent * sdp.length) / (1024 * 1024));
      peak = Math.max(peak, env.rss());

      // 보내는 쪽 연결과 대조군은 그대로다.
      for (const sender of senders) {
        assert.equal(sender.isOpen, true, '보내는 쪽 연결이 닫혔다');
        const pong = await sender.ping();
        assert.equal(pong.type, 'pong');
        assert.equal(pong.members.some((member) => member.peer === stuck.identity.peer), false, '끊긴 피어가 목록에 남았다');
        assert.equal(sender.errors((message) => message.code !== 'PEER_NOT_FOUND').length, 0, '보내는 쪽이 PEER_NOT_FOUND 밖의 오류를 받았다');
      }
      assert.equal(env.events('conn.drop', (entry) => entry.reason === 'slow_consumer').length, 1, '그 연결만 닫는다');
      assert.equal(env.events('rate.limited').length, 0);
      await delay(1_000);
      const after = env.rss();
      t.diagnostic(`보낸 시그널 ${sent}건(약 ${sentMb}MB). 서버 RSS: 전 ${before}MB, 주입 중 최대 ${peak}MB, 끊은 뒤 ${after}MB`);
      assert.ok(peak - before < 64, `주입 중 메모리가 ${peak - before}MB 늘었다. 보낼 버퍼 상한이 듣지 않는다`);
      stuck.socket.resume();
      await stuck.closed();
    });
  });

  it('F-06 클라이언트 프로세스 SIGSTOP: 90초 뒤 목록에서 빠지고 소켓이 닫힌다. 같은 방의 다른 참가자는 정상이다', async (t) => {
    await withServer(t, [], async (env) => {
      const room = freshRoom();
      const name = freshName('stopped');
      const watcher = await env.session.joined(room, 'create', undefined, { label: 'watcher' });
      const child = env.procs.spawnNode(PEER_SCRIPT, ['--url', env.url, '--room', room, '--peer', name, '--mode', 'join', '--ping-ms', '2000'], { name: 'peer', stdin: 'ignore' });
      await child.waitForOutput(/joined/, { timeoutMs: 10_000 });
      const listed = async () => (await watcher.ping()).members.some((member) => member.peer === name);
      assert.equal(await listed(), true);
      await delay(2_500);

      process.kill(child.pid, 'SIGSTOP');
      const stoppedAt = Date.now();
      await delay(80_000);
      assert.equal(await listed(), true, '80초에는 아직 목록에 있다');
      assert.equal(env.events('conn.drop', (entry) => entry.reason === 'stale').length, 0);

      await until('목록에서 빠짐', async () => !(await listed()), { timeoutMs: 15_000, pollMs: 250 });
      const goneMs = Date.now() - stoppedAt;
      await until('stale 로 끊김', () => env.events('conn.drop', (entry) => entry.reason === 'stale').length === 1, { timeoutMs: 15_000, pollMs: 100 });
      const dropMs = Date.now() - stoppedAt;
      await until('기록 삭제', () => env.events('conn.closed', (entry) => entry.peer_ref === refOf(name)).length === 1, { timeoutMs: 5_000, pollMs: 50 });
      const closedMs = Date.now() - stoppedAt;
      t.diagnostic(`멈춘 뒤: 목록에서 빠짐 ${goneMs}ms, 서버가 끊기 시작 ${dropMs}ms, 종료 처리 ${closedMs}ms`);
      // 마지막 ping 은 멈추기 2초 전까지일 수 있다. 오래됨 90초, 정리 주기 5초, 닫기 유예 2초.
      assert.ok(goneMs >= 87_000 && goneMs <= 92_000, `목록에서 빠진 시각: ${goneMs}ms`);
      assert.ok(closedMs <= 99_000, `소켓이 닫힌 시각: ${closedMs}ms`);
      assert.equal(env.events('conn.closed', (entry) => entry.peer_ref === refOf(name))[0].outcome, 'removed');
      assert.equal((await env.health()).connections, 3, '멈춘 참가자의 연결만 줄었다(대조군 2 + watcher 1)');
      assert.equal(watcher.errors().length, 0);

      // 이 주입은 60초를 넘으므로 server.stats 가 한 번 이상 남는다.
      const stats = env.events('server.stats');
      assert.ok(stats.length >= 1, 'server.stats 가 없다');
      for (const field of ['connections', 'rooms', 'rejected', 'loop_lag_ms', 'rss_mb']) assert.equal(typeof stats[0][field], 'number', `server.stats.${field}`);
      t.diagnostic(`server.stats ${stats.length}건. 마지막: ${JSON.stringify(Object.fromEntries(['connections', 'rooms', 'rejected', 'loop_lag_ms', 'rss_mb'].map((field) => [field, stats.at(-1)[field]])))}`);

      child.killTree('SIGKILL');
      await child.waitForExit({ timeoutMs: 5_000 });
    });
  });

  it('F-07 클라이언트 SIGKILL: 기록이 바로 지워진다. 종료 처리가 한 번만 반영된다', async (t) => {
    await withServer(t, [], async (env) => {
      const room = freshRoom();
      const name = freshName('killed');
      const watcher = await env.session.joined(room, 'create', undefined, { label: 'watcher' });
      const child = env.procs.spawnNode(PEER_SCRIPT, ['--url', env.url, '--room', room, '--peer', name, '--mode', 'join', '--ping-ms', '1000'], { name: 'peer', stdin: 'ignore' });
      await child.waitForOutput(/joined/, { timeoutMs: 10_000 });
      assert.equal((await watcher.ping()).members[0]?.peer, name);

      const killedAt = Date.now();
      child.kill('SIGKILL');
      await until('목록에서 빠짐', async () => (await watcher.ping()).members.length === 0, { timeoutMs: 5_000, pollMs: 5 });
      const goneMs = Date.now() - killedAt;
      t.diagnostic(`SIGKILL 뒤 ${goneMs}ms 에 목록에서 빠졌다`);
      assert.ok(goneMs < 1_000, `바로 지워지지 않았다: ${goneMs}ms`);
      assert.equal(codeOf(await watcher.signalError(name, undefined, { waitMs: 2_000 })), 'PEER_NOT_FOUND');
      await delay(1_000);
      const closedLines = env.events('conn.closed', (entry) => entry.peer_ref === refOf(name));
      assert.equal(closedLines.length, 1, 'conn.closed 는 한 건이다');
      assert.equal(closedLines[0].outcome, 'removed');
      assert.equal(watcher.errors((message) => message.code !== 'PEER_NOT_FOUND').length, 0);
      await child.waitForExit({ timeoutMs: 5_000 });
    });
  });

  it('F-08 총 연결 한도를 넘는 접속: 초과분은 503, /healthz 는 응답하고 기존 연결은 유지된다. 접속이 줄면 바로 받는다', async (t) => {
    await withServer(t, ['--max-connections', '12', '--max-connections-per-ip', '100'], async (env) => {
      const holders = [];
      for (let i = 0; i < 10; i += 1) holders.push(await env.session.joined(freshRoom(), 'create', undefined, { label: `holder-${i}` }));
      assert.equal((await env.health()).connections, 12);

      const statuses = [];
      for (let i = 0; i < 5; i += 1) {
        await assert.rejects(openWire(env.url, { label: 'over' }), (error) => {
          statuses.push(error.status);
          return true;
        });
      }
      assert.deepEqual(statuses, [503, 503, 503, 503, 503]);
      assert.deepEqual(await env.health(), { ok: true, connections: 12, rooms: 11 }, '꽉 찬 동안에도 /healthz 가 응답한다');
      for (const holder of holders) assert.equal((await holder.ping()).type, 'pong', '기존 연결이 끊겼다');
      assert.equal(env.events('conn.refused', (entry) => entry.reason === 'max_connections').length, 5);

      for (const holder of holders.slice(0, 3)) {
        holder.leave();
        holder.close();
      }
      await until('연결 수 감소', async () => (await env.health()).connections === 9);
      const again = await env.session.joined(freshRoom(), 'create');
      assert.equal(again.joinedReply.type, 'joined', '접속이 줄면 바로 받는다');
    });
  });

  it('F-09 핸드셰이크와 프레임을 1바이트씩 천천히 보냄: 핸드셰이크 기한과 미입장 기한으로 닫는다', async (t) => {
    await withServer(t, [], async (env) => {
      const trickle = (label, prefix, bytes) =>
        new Promise((resolve, reject) => {
          const startedAt = Date.now();
          const socket = net.connect({ host: '127.0.0.1', port: env.port }, () => {
            if (prefix.length > 0) socket.write(prefix);
            let offset = 0;
            const timer = setInterval(() => {
              if (offset < bytes.length && !socket.destroyed) socket.write(bytes.subarray(offset, offset + 1));
              offset += 1;
            }, 250);
            socket.on('close', () => {
              clearInterval(timer);
              resolve({ label, closedMs: Date.now() - startedAt, sentBytes: Math.min(offset, bytes.length), total: bytes.length });
            });
          });
          socket.on('data', () => undefined);
          socket.on('error', (error) => {
            if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error);
          });
        });

      const join = JSON.stringify({ action: 'join', v: 1, id: 'slow', room: freshRoom(), ...newIdentity(), mode: 'create', seq: 1 });
      const [handshake, frame] = await Promise.all([
        trickle('handshake', Buffer.alloc(0), Buffer.from(HANDSHAKE)),
        trickle('frame', Buffer.from(HANDSHAKE), maskedTextFrame(join)),
      ]);
      t.diagnostic(`핸드셰이크를 흘린 소켓: ${handshake.closedMs}ms 에 닫힘(${handshake.sentBytes}/${handshake.total}바이트 보냄)`);
      t.diagnostic(`프레임을 흘린 소켓: ${frame.closedMs}ms 에 닫힘(${frame.sentBytes}/${frame.total}바이트 보냄)`);
      assert.ok(handshake.sentBytes < handshake.total && frame.sentBytes < frame.total, '다 보내기 전에 닫혀야 한다');
      assert.ok(handshake.closedMs >= 9_500 && handshake.closedMs <= 11_500, `핸드셰이크 기한: ${handshake.closedMs}ms`);
      // 미입장 기한 10초 뒤 닫기 프레임을 보내고, 답이 없으면 2초 뒤 끊는다.
      assert.ok(frame.closedMs >= 9_500 && frame.closedMs <= 13_500, `미입장 기한: ${frame.closedMs}ms`);
      assert.equal(env.events('conn.refused', (entry) => entry.reason === 'handshake_timeout').length, 1);
      assert.equal(env.events('conn.drop', (entry) => entry.reason === 'join_deadline').length, 1);
    });
  });

  it('F-10 다른 방의 이름, 자기 자신, 없는 이름으로 signal. 등록 없이 signal: PEER_NOT_FOUND, BAD_MESSAGE, NOT_JOINED. 다른 방에 도착하지 않는다', async (t) => {
    await withServer(t, [], async (env) => {
      const roomA = freshRoom();
      const roomB = freshRoom();
      const alice = await env.session.joined(roomA, 'create', undefined, { label: 'alice' });
      const bob = await env.session.joined(roomA, 'join', undefined, { label: 'bob' });
      const dave = await env.session.joined(roomB, 'create', undefined, { label: 'dave' });
      // 다른 방에 alice 와 같은 방의 bob 과 이름이 같은 참가자를 둔다.
      const twin = await env.session.joined(roomB, 'join', newIdentity(bob.identity.peer), { label: 'twin' });
      const stranger = await env.session.open({ label: 'stranger' });

      assert.equal(codeOf(await alice.signalError(dave.identity.peer, undefined, { waitMs: 3_000 })), 'PEER_NOT_FOUND', '다른 방에만 있는 이름');
      assert.equal(codeOf(await alice.signalError(alice.identity.peer, undefined, { waitMs: 3_000 })), 'BAD_MESSAGE', '자기 자신');
      assert.equal(codeOf(await alice.signalError(freshName('ghost'), undefined, { waitMs: 3_000 })), 'PEER_NOT_FOUND', '없는 이름');
      assert.equal(codeOf(await stranger.signalError(alice.identity.peer, undefined, { waitMs: 3_000 })), 'NOT_JOINED', '등록 없이');
      assert.equal(await alice.signalError(bob.identity.peer), null, '같은 방의 이름은 전달된다');
      await bob.waitFor('전달', () => bob.signals().length === 1);
      await delay(300);
      assert.equal(dave.signals().length + twin.signals().length + alice.signals().length, 0, '다른 방이나 엉뚱한 연결에 도착했다');

      const relays = env.events('relay');
      const byCode = (code) => relays.filter((entry) => entry.outcome === 'rejected' && entry.error_code === code).length;
      assert.deepEqual(
        { PEER_NOT_FOUND: byCode('PEER_NOT_FOUND'), BAD_MESSAGE: byCode('BAD_MESSAGE'), NOT_JOINED: byCode('NOT_JOINED') },
        { PEER_NOT_FOUND: 2, BAD_MESSAGE: 1, NOT_JOINED: 1 },
      );
      t.diagnostic(`relay 사건: 거절 ${relays.filter((entry) => entry.outcome === 'rejected').length}건, 전달 ${relays.filter((entry) => entry.outcome === 'ok').length}건(대조군 포함)`);
    });
  });

  it('F-11 같은 이름으로 10개 연결이 동시에 join, 인계 직후 옛 연결의 ping·leave: 등록은 하나이고 옛 연결이 새 기록을 지우지 못한다', async (t) => {
    await withServer(t, [], async (env) => {
      const room = freshRoom();
      const name = freshName('same');
      const host = await env.session.joined(room, 'create', undefined, { label: 'host' });
      const clients = await Promise.all(Array.from({ length: 10 }, (_, i) => env.session.open({ label: `same-${i}` })));
      const identities = clients.map(() => newIdentity(name));
      const replies = await Promise.all(clients.map((client, i) => client.join({ room, ...identities[i], mode: 'join' })));
      assert.equal(replies.filter((reply) => reply.type === 'joined').length, 1, `응답: ${replies.map(codeOf).join(',')}`);
      assert.equal(replies.filter((reply) => codeOf(reply) === 'NAME_IN_USE').length, 9);
      const winnerIndex = replies.findIndex((reply) => reply.type === 'joined');
      const old = clients[winnerIndex];
      const identity = identities[winnerIndex];
      assert.deepEqual((await host.ping()).members, [{ peer: name, sid: identity.sid }]);

      // 같은 프로세스가 새 연결로 다시 등록하고, 옛 연결은 그 직후에 ping 과 leave 를 보낸다.
      const fresh = await env.session.open({ label: 'fresh' });
      fresh.send({ action: 'join', v: 1, id: 'takeover', room, ...identity, mode: 'resume', seq: 2 });
      const joined = await fresh.reply('takeover');
      old.send({ action: 'ping', id: 'old-ping' });
      old.leave();
      assert.equal(joined.type, 'joined', `응답: ${codeOf(joined)}`);
      await old.closed();
      assert.equal(old.errors((message) => message.code === 'REPLACED').length, 1, '옛 연결이 REPLACED 를 받았다');
      await delay(300);

      assert.deepEqual((await host.ping()).members, [{ peer: name, sid: identity.sid }], '새 기록이 남아 있다');
      host.signal(name);
      await fresh.waitFor('새 연결에 도착', () => fresh.signals().length === 1);
      assert.equal(old.signals().length, 0);
      assert.equal((await fresh.ping()).type, 'pong');
      assert.equal(env.events('conn.join', (entry) => entry.takeover === true && entry.outcome === 'joined').length, 1);
      const releases = env.events('conn.closed', (entry) => entry.peer_ref === refOf(name));
      t.diagnostic(`옛 연결의 종료 처리: ${releases.map((entry) => `${entry.reason}/${entry.outcome}`).join(', ')}`);
      assert.equal(releases.some((entry) => entry.outcome === 'removed'), false, '옛 연결의 종료 처리가 기록을 지웠다');
    });
  });

  it('F-12 연결 수백 개가 열린 채 SIGTERM: 5초 안에 종료 코드 0 으로 끝나고 남은 프로세스가 없다', async (t) => {
    await withServer(t, ['--max-connections-per-ip', '1000'], async (env) => {
      const startedAt = Date.now();
      // 등록된 연결 100개(방 20개에 5명씩)와 등록 없는 연결 200개.
      for (let r = 0; r < 20; r += 1) {
        const room = freshRoom();
        await env.session.joined(room, 'create');
        await Promise.all([1, 2, 3, 4].map(() => env.session.joined(room, 'join')));
      }
      for (let i = 0; i < 20; i += 1) await Promise.all(Array.from({ length: 10 }, () => env.session.open()));
      const health = await env.health();
      t.diagnostic(`열린 연결 ${health.connections}개, 방 ${health.rooms}개 (여는 데 ${Date.now() - startedAt}ms)`);
      assert.equal(health.connections, 302);
      assert.equal(health.rooms, 21);
      // 미입장 기한(10초)이 지나기 전에 끝낸다. 연결을 닫지 않은 채 SIGTERM 을 보낸다.
      assert.ok(Date.now() - startedAt < 8_000, '연결을 여는 데 너무 오래 걸렸다');
      return { keepConnections: true };
    });
  });

  it('F-13 WebSocket 제어 프레임(ping) 폭주와 바이너리 프레임: 바이너리는 그 연결만 1003 으로 닫고, 제어 프레임은 ws 가 처리한다. 프로세스는 살아 있다', async (t) => {
    await withServer(t, [], async (env) => {
      const binary = await env.session.joined(freshRoom(), 'create', undefined, { label: 'binary' });
      for (let i = 0; i < 10; i += 1) binary.sendRaw(randomBytes(64));
      const closed = await binary.waitFor('종료', () => binary.closeInfo, { closeOk: true });
      assert.equal(closed.code, 1003);
      assert.equal(binary.errors().length, 0);
      const bystander = await env.session.joined(freshRoom(), 'create', undefined, { label: 'bystander' });

      // 한꺼번에 몰아 보내는 연결과, 읽으면서 꾸준히 보내는 연결.
      const burst = await env.session.joined(freshRoom(), 'create', undefined, { label: 'burst' });
      const steady = await env.session.joined(freshRoom(), 'create', undefined, { label: 'steady' });
      let steadyPongs = 0;
      steady.socket.on('pong', () => (steadyPongs += 1));
      env.control.maxRttMs = 0;
      for (let i = 0; i < 20_000 && burst.isOpen; i += 1) burst.socket.ping();
      let steadySent = 0;
      for (let chunk = 0; chunk < 100 && steady.isOpen; chunk += 1) {
        for (let i = 0; i < 50; i += 1) steady.socket.ping();
        steadySent += 50;
        await delay(10);
      }
      await delay(500);
      const burstState = burst.closeInfo === null ? '열려 있음' : `닫힘(code ${burst.closeInfo.code})`;
      t.diagnostic(`몰아 보낸 연결(20000건): ${burstState}. 꾸준히 보낸 연결(${steadySent}건): pong ${steadyPongs}건, ${steady.isOpen ? '열려 있음' : '닫힘'}`);
      t.diagnostic(`폭주 동안 대조군의 가장 긴 왕복: ${env.control.maxRttMs}ms`);
      assert.ok(env.control.maxRttMs < 1_000, `이벤트 루프 지연이 눈에 띈다: 대조군 왕복 ${env.control.maxRttMs}ms`);
      assert.equal(env.events('rate.limited').length, 0, '제어 프레임은 연결별 속도 제한에 들어가지 않는다');
      assert.equal((await bystander.ping()).type, 'pong', '무관한 연결은 정상이다');
    });
  });

  it('F-14 Origin 헤더가 있는 핸드셰이크: HTTP 403', async (t) => {
    await withServer(t, [], async (env) => {
      for (const origin of ['https://example.com', 'null', 'http://127.0.0.1']) {
        await assert.rejects(openWire(env.url, { headers: { Origin: origin } }), (error) => {
          assert.equal(error.status, 403, `Origin ${origin}`);
          return true;
        });
      }
      assert.equal(env.events('conn.refused', (entry) => entry.reason === 'origin' && entry.error_code === '403').length, 3);
      assert.equal((await env.health()).connections, 2, '대조군만 연결돼 있다');
      await delay(500);
    });
  });
});
