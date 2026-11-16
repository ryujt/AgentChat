// 시험용 시그널링 프록시(tests/support/signal-proxy.mjs)의 자체 시험.
// 실제 자체 호스팅 서버 프로세스 앞에 프록시를 세우고, 와이어 계약만 아는 클라이언트를 프록시에 붙인다.
// 확인하는 것: 지정한 쌍·종류·순번의 메시지를 버리고 늦춘다. 지정하지 않은 메시지는 그대로 지나간다.
//
//   node --test tests/wire/signal-proxy.test.mjs
//
// 빌드 결과는 dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 알려 준다.

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { REPO_ROOT, createProcTracker } from '../support/proc.mjs';
import { startSignalProxy } from '../support/signal-proxy.mjs';
import { createWireSession, delay, freshRoom, newIdentity, openWire, until } from './wire-client.mjs';

const procs = createProcTracker({ label: 'proxy-test' });
let server;
let serverUrl;
/** 시험마다 새로 띄운다. */
let proxy;
let session;

const candidate = (sid, label) => ({ kind: 'candidate', cid: `${sid}.1`, data: { list: [{ candidate: `candidate:${label} 1 udp 1 192.0.2.1 9 typ host`, mid: '0' }] } });
const offer = (sid, body = 'v=0\r\na=marker-sdp-secret\r\n') => ({ kind: 'offer', cid: `${sid}.1`, data: { sdp: body } });
const labels = (client, from) =>
  client
    .signals((message) => message.kind === 'candidate' && (from === undefined || message.from === from))
    .map((message) => message.data.list[0].candidate.split(' ')[0].slice('candidate:'.length));
const kinds = (client) => client.signals().map((message) => message.kind);

/** alice, bob, carol 이 프록시를 거쳐 한 방에 들어간다. */
async function trio() {
  const room = freshRoom();
  const alice = await session.joined(room, 'create', newIdentity('alice'), { label: 'alice' });
  const bob = await session.joined(room, 'join', newIdentity('bob'), { label: 'bob' });
  const carol = await session.joined(room, 'join', newIdentity('carol'), { label: 'carol' });
  return { room, alice, bob, carol };
}

describe('시험용 시그널링 프록시', { concurrency: false }, () => {
  before(async () => {
    server = procs.spawnDist('entry/server.js', ['--host', '127.0.0.1', '--port', '0'], { name: 'server', stdin: 'ignore' });
    serverUrl = (await server.waitForOutput(/listening on (ws:\/\/\S+)/, { timeoutMs: 10_000 }))[1];
  });

  after(async () => {
    const stopped = await server.stop({ signal: 'SIGTERM', timeoutMs: 5_000 });
    try {
      assert.equal(stopped.code, 0);
      assert.equal(server.stderr().trim(), '', '서버의 stderr 에 출력이 있다');
      await procs.assertNoneLeft({ graceMs: 2_000 });
    } finally {
      await procs.dispose();
    }
  });

  afterEach(async () => {
    await session?.closeAll();
    await proxy?.close();
    session = undefined;
    proxy = undefined;
  });

  async function setup(rules = []) {
    proxy = await startSignalProxy({ upstream: serverUrl, rules });
    session = createWireSession(proxy.url);
    return proxy;
  }

  it('규칙이 없으면 입장, ping, 네 종류의 signal, 오류가 그대로 지나간다', async () => {
    await setup();
    const { alice, bob, carol } = await trio();
    assert.deepEqual(carol.joinedReply.members.map((member) => member.peer), ['alice', 'bob']);
    assert.equal((await alice.ping()).type, 'pong');

    alice.signal('bob', { kind: 'offer-request', data: {} });
    alice.signal('bob', offer(alice.identity.sid));
    alice.signal('bob', { kind: 'answer', cid: `${alice.identity.sid}.1`, data: { sdp: 'v=0\r\n' } });
    alice.signal('bob', candidate(alice.identity.sid, 'c1'));
    await bob.waitFor('signal 4건', () => bob.signals().length === 4);
    assert.deepEqual(kinds(bob), ['offer-request', 'offer', 'answer', 'candidate'], '순서가 그대로다');
    assert.equal(bob.signals().every((message) => message.from === 'alice' && message.sid === alice.identity.sid), true);
    assert.equal((await alice.signalError('nobody', undefined, { waitMs: 3_000 }))?.code, 'PEER_NOT_FOUND', '서버의 오류도 지나간다');
    alice.sendRaw('not json at all');
    await alice.waitFor('BAD_MESSAGE', () => alice.errors((message) => message.code === 'BAD_MESSAGE')[0]);

    const stats = proxy.stats();
    assert.equal(stats.dropped + stats.delayed + stats.held + stats.duplicated, 0);
    assert.deepEqual(stats.signals, { 'alice>bob:offer-request': 1, 'alice>bob:offer': 1, 'alice>bob:answer': 1, 'alice>bob:candidate': 1, 'alice>nobody:offer-request': 1 });
    assert.ok(stats.maxSignalBytes > 0 && stats.maxSignalBytes < 16384);
    assert.deepEqual(proxy.connections().sort(), ['alice', 'bob', 'carol']);
    assert.deepEqual(proxy.events, []);
  });

  it('버리기: 지정한 보낸 쪽·받는 쪽·종류의 지정한 순번만 버린다', async () => {
    await setup();
    const rule = proxy.addRule({ from: 'alice', to: 'bob', kind: 'candidate', nth: [2, 3], op: 'drop' });
    const { alice, bob, carol } = await trio();

    for (const label of ['a1', 'a2', 'a3', 'a4']) alice.signal('bob', candidate(alice.identity.sid, label));
    // 같은 종류라도 다른 쌍과 반대 방향은 건드리지 않는다. 다른 종류도 그렇다.
    for (const label of ['c1', 'c2', 'c3']) carol.signal('bob', candidate(carol.identity.sid, label));
    for (const label of ['b1', 'b2', 'b3']) bob.signal('alice', candidate(bob.identity.sid, label));
    for (const label of ['x1', 'x2', 'x3']) alice.signal('carol', candidate(alice.identity.sid, label));
    alice.signal('bob', offer(alice.identity.sid));

    await bob.waitFor('bob 이 받을 것', () => bob.signals().length === 6);
    await alice.waitFor('alice 가 받을 것', () => alice.signals().length === 3);
    await carol.waitFor('carol 이 받을 것', () => carol.signals().length === 3);
    await delay(200);
    assert.deepEqual(labels(bob, 'alice'), ['a1', 'a4'], '두 번째와 세 번째만 버린다');
    assert.deepEqual(labels(bob, 'carol'), ['c1', 'c2', 'c3']);
    assert.deepEqual(labels(alice), ['b1', 'b2', 'b3']);
    assert.deepEqual(labels(carol), ['x1', 'x2', 'x3']);
    assert.equal(bob.signals((message) => message.kind === 'offer').length, 1);

    assert.equal(rule.seen, 4);
    assert.equal(rule.hits, 2);
    assert.equal(proxy.stats().dropped, 2);
    assert.deepEqual(proxy.events.map((event) => [event.op, event.dir, event.from, event.to, event.kind, event.nth]), [
      ['drop', 'c2s', 'alice', 'bob', 'candidate', 2],
      ['drop', 'c2s', 'alice', 'bob', 'candidate', 3],
    ]);
    // c2s 에서 버리면 서버에 닿지 않는다. 보낸 쪽은 오류를 받지 않는다.
    assert.equal(alice.errors().length, 0);
  });

  it('버리기: pair 는 두 참가자 사이의 양방향에 맞고, 순번을 주지 않으면 전부 버린다', async () => {
    await setup([{ pair: ['alice', 'bob'], kind: 'candidate', op: 'drop' }]);
    const { alice, bob, carol } = await trio();
    for (let i = 0; i < 5; i += 1) {
      alice.signal('bob', candidate(alice.identity.sid, `ab${i}`));
      bob.signal('alice', candidate(bob.identity.sid, `ba${i}`));
      alice.signal('carol', candidate(alice.identity.sid, `ac${i}`));
      carol.signal('bob', candidate(carol.identity.sid, `cb${i}`));
    }
    alice.signal('bob', offer(alice.identity.sid));
    bob.signal('alice', { kind: 'answer', cid: `${alice.identity.sid}.1`, data: { sdp: 'v=0\r\n' } });
    await carol.waitFor('carol', () => carol.signals().length === 5);
    await bob.waitFor('bob', () => bob.signals().length === 6);
    await alice.waitFor('alice', () => alice.signals().length === 1);
    await delay(200);
    assert.deepEqual(labels(bob), ['cb0', 'cb1', 'cb2', 'cb3', 'cb4'], 'alice 의 후보는 하나도 오지 않는다');
    assert.deepEqual(labels(alice), []);
    assert.deepEqual(kinds(alice), ['answer'], '같은 쌍의 다른 종류는 지나간다');
    assert.equal(proxy.stats().dropped, 10);
  });

  it('버리기: 순번을 {first, last} 로 주면 그 구간만 버린다(처음 두 번의 offer 를 버려 재전송을 일으키는 꼴)', async () => {
    await setup();
    const rule = proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', nth: { last: 2 }, op: 'drop' });
    const { alice, bob } = await trio();
    for (let i = 1; i <= 4; i += 1) alice.signal('bob', offer(alice.identity.sid, `v=0\r\na=try-${i}\r\n`));
    await bob.waitFor('offer 2건', () => bob.signals().length === 2);
    await delay(150);
    assert.deepEqual(bob.signals().map((message) => message.data.sdp), ['v=0\r\na=try-3\r\n', 'v=0\r\na=try-4\r\n']);
    assert.equal(rule.hits, 2);
  });

  it('늦추기: 늦춘 메시지는 지정한 시간 뒤에 도착하고, 그 사이의 메시지가 앞질러 간다(후보가 offer 보다 먼저)', async () => {
    await setup();
    const rule = proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', nth: 1, op: 'delay', delayMs: 400 });
    const { alice, bob } = await trio();
    const sentAt = Date.now();
    alice.signal('bob', offer(alice.identity.sid));
    alice.signal('bob', candidate(alice.identity.sid, 'early'));
    await bob.waitFor('candidate', () => bob.signals().length === 1);
    assert.deepEqual(kinds(bob), ['candidate'], 'offer 보다 먼저 왔다');
    const early = Date.now() - sentAt;

    await bob.waitFor('offer', () => bob.signals().length === 2, { timeoutMs: 3_000 });
    const late = bob.signals()[1].receivedAt - sentAt;
    assert.deepEqual(kinds(bob), ['candidate', 'offer']);
    assert.ok(early < 300, `앞지른 메시지가 ${early}ms 에 왔다`);
    assert.ok(late >= 380 && late < 1_500, `늦춘 메시지가 ${late}ms 에 왔다`);

    // 두 번째 offer 는 늦추지 않는다.
    alice.signal('bob', offer(alice.identity.sid, 'v=0\r\na=second\r\n'));
    const before = Date.now();
    await bob.waitFor('두 번째 offer', () => bob.signals().length === 3);
    assert.ok(Date.now() - before < 300);
    assert.equal(rule.hits, 1);
    assert.equal(proxy.stats().delayed, 1);
  });

  it('늦추기(서버 → 클라이언트): joined 를 늦추면 다른 참가자의 signal 이 joined 보다 먼저 도착한다', async () => {
    await setup();
    const room = freshRoom();
    const alice = await session.joined(room, 'create', newIdentity('alice'), { label: 'alice' });
    const rule = proxy.addRule({ dir: 's2c', type: 'joined', to: 'dave', op: 'delay', delayMs: 500 });

    const dave = await session.open({ label: 'dave' });
    const identity = newIdentity('dave');
    dave.send({ action: 'join', v: 1, id: 'dave-join', room, ...identity, mode: 'join', seq: 1 });
    // 서버에는 이미 등록됐다. alice 는 목록에서 dave 를 보고 시그널을 보낸다.
    await until('dave 가 목록에 보임', async () => (await alice.ping()).members.some((member) => member.peer === 'dave'), { timeoutMs: 3_000 });
    alice.signal('dave', offer(alice.identity.sid));
    await dave.waitFor('signal', () => dave.signals().length === 1);
    assert.equal(dave.messages.some((message) => message.type === 'joined'), false, 'joined 가 아직 오지 않았다');

    const joined = await dave.reply('dave-join');
    assert.equal(joined.type, 'joined');
    assert.deepEqual(dave.messages.map((message) => message.type), ['signal', 'joined']);
    assert.equal(rule.hits, 1);
    assert.deepEqual(proxy.events.map((event) => [event.op, event.dir, event.to, event.what]), [['delay', 's2c', 'dave', 'joined']]);
  });

  it('붙들기: release 를 부를 때까지 보내지 않고, 부르면 받은 순서대로 보낸다', async () => {
    await setup();
    const { alice, bob } = await trio();
    const hold = proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', op: 'hold' });
    alice.signal('bob', offer(alice.identity.sid, 'v=0\r\na=first\r\n'));
    alice.signal('bob', offer(alice.identity.sid, 'v=0\r\na=second\r\n'));
    alice.signal('bob', candidate(alice.identity.sid, 'passes'));
    await bob.waitFor('candidate', () => bob.signals().length === 1);
    await delay(300);
    assert.deepEqual(kinds(bob), ['candidate']);
    assert.equal(hold.holding, 2);

    assert.equal(hold.release(), 2);
    await bob.waitFor('붙든 offer 2건', () => bob.signals().length === 3);
    assert.deepEqual(bob.signals().slice(1).map((message) => message.data.sdp), ['v=0\r\na=first\r\n', 'v=0\r\na=second\r\n']);

    // 규칙을 지우면 그 뒤로는 그대로 지나간다.
    hold.remove();
    alice.signal('bob', offer(alice.identity.sid, 'v=0\r\na=third\r\n'));
    await bob.waitFor('규칙을 지운 뒤', () => bob.signals().length === 4);
  });

  it('겹쳐 보내기: 지정한 메시지가 두 번 도착한다', async () => {
    await setup([{ from: 'alice', to: 'bob', kind: 'offer', nth: 1, op: 'duplicate' }]);
    const { alice, bob } = await trio();
    alice.signal('bob', offer(alice.identity.sid));
    alice.signal('bob', offer(alice.identity.sid, 'v=0\r\na=once\r\n'));
    await bob.waitFor('offer 3건', () => bob.signals().length === 3);
    await delay(150);
    assert.equal(bob.signals().filter((message) => message.data.sdp.includes('marker-sdp-secret')).length, 2);
    assert.equal(bob.signals().filter((message) => message.data.sdp.includes('once')).length, 1);
  });

  it('서버 → 클라이언트 방향도 버린다: 한 참가자의 pong 을 버려도 다른 참가자는 받는다', async () => {
    await setup([{ dir: 's2c', type: 'pong', to: 'bob', op: 'drop' }]);
    const { alice, bob } = await trio();
    await assert.rejects(bob.ping({ timeoutMs: 500 }), /받지 못했다/);
    assert.equal((await alice.ping()).type, 'pong');
    proxy.clearRules();
    assert.equal((await bob.ping()).type, 'pong', '규칙을 지우면 다시 받는다');
  });

  it('match 로 메시지 내용을 더 거른다. 한 메시지에는 처음 적용된 규칙 하나만 적용된다', async () => {
    await setup();
    const first = proxy.addRule({ kind: 'candidate', match: (message) => message.data.list[0].candidate.includes('drop-me'), op: 'drop' });
    const second = proxy.addRule({ from: 'alice', kind: 'candidate', op: 'duplicate' });
    const { alice, bob } = await trio();
    alice.signal('bob', candidate(alice.identity.sid, 'drop-me'));
    alice.signal('bob', candidate(alice.identity.sid, 'keep'));
    await bob.waitFor('keep 두 번', () => bob.signals().length === 2);
    await delay(150);
    assert.deepEqual(labels(bob), ['keep', 'keep']);
    assert.equal(first.hits, 1);
    assert.equal(second.hits, 1, '버린 메시지는 뒤의 규칙에 닿지 않는다');
  });

  it('disconnect: 서버 쪽에서 끊긴 것처럼 그 참가자의 연결만 끊는다. 서버의 기록도 지워진다', async () => {
    await setup();
    const { alice, bob, carol } = await trio();
    assert.equal(proxy.disconnect({ peer: 'bob' }), 1);
    const closed = await bob.closed();
    assert.equal(closed.code, 1006, '닫기 핸드셰이크 없이 끊긴다');
    await until('서버 기록 삭제', async () => (await alice.ping()).members.map((member) => member.peer).join() === 'carol');
    assert.equal(alice.isOpen && carol.isOpen, true);
    assert.deepEqual(proxy.connections().sort(), ['alice', 'carol']);
  });

  it('block: 막힌 동안 그 참가자의 join 은 서버에 닿지 않고 끊긴다. 풀면 다시 들어간다', async () => {
    await setup();
    const { room, alice, bob } = await trio();
    assert.equal(proxy.block('bob'), 1);
    await bob.closed();
    await until('서버 기록 삭제', async () => !(await alice.ping()).members.some((member) => member.peer === 'bob'));

    const retry = await session.open({ label: 'bob-retry' });
    retry.send({ action: 'join', v: 1, id: 'retry-1', room, ...bob.identity, mode: 'resume', seq: 2 });
    await retry.closed();
    assert.equal(retry.messages.length, 0, '응답 없이 끊긴다');
    assert.equal((await alice.ping()).members.some((member) => member.peer === 'bob'), false, 'join 이 서버에 닿지 않았다');
    assert.equal(proxy.stats().blockedJoins, 1);

    proxy.unblock('bob');
    const back = await session.open({ label: 'bob-back' });
    const reply = await back.join({ room, ...bob.identity, mode: 'resume', seq: 3 });
    assert.equal(reply.type, 'joined');
    assert.equal((await alice.ping()).members.some((member) => member.peer === 'bob'), true);
  });

  it('기록(events, stats)에 본문이 남지 않는다', async () => {
    await setup([{ from: 'alice', to: 'bob', kind: 'offer', op: 'drop' }]);
    const { room, alice } = await trio();
    alice.signal('bob', offer(alice.identity.sid));
    await until('버림', () => proxy.stats().dropped === 1);
    const text = JSON.stringify({ events: proxy.events, stats: proxy.stats() });
    for (const secret of ['marker-sdp-secret', room, alice.identity.key]) assert.equal(text.includes(secret), false);
  });

  it('틀린 규칙은 더할 때 던진다', async () => {
    await setup();
    for (const bad of [
      { kind: 'offer' },
      { op: 'explode' },
      { op: 'delay' },
      { op: 'drop', dir: 'sideways' },
      { op: 'drop', nth: 0 },
      { op: 'drop', pair: ['alice'] },
      { op: 'drop', dir: 's2c', action: 'signal' },
      { op: 'drop', type: 'joined' },
      { op: 'drop', peer: 'alice' },
    ]) {
      assert.throws(() => proxy.addRule(bad), TypeError, JSON.stringify(bad));
    }
    await assert.rejects(startSignalProxy({ upstream: 'http://127.0.0.1:1' }), TypeError);
  });

  it('close: 열린 연결을 모두 끊고 포트를 놓는다. 늦춘 메시지는 버린다', async () => {
    await setup([{ from: 'alice', to: 'bob', kind: 'offer', op: 'delay', delayMs: 300 }]);
    const { alice, bob, carol } = await trio();
    alice.signal('bob', offer(alice.identity.sid));
    await until('늦춤', () => proxy.stats().delayed === 1);
    const url = proxy.url;
    await proxy.close();
    await proxy.close();
    await Promise.all([alice.closed(), bob.closed(), carol.closed()]);
    assert.equal(bob.signals().length, 0);
    await assert.rejects(openWire(url, { timeoutMs: 1_000 }), /ECONNREFUSED/);
    // 프록시가 닫히면 서버 쪽 연결도 닫혀 기록이 지워진다.
    const direct = createWireSession(serverUrl);
    try {
      await until('서버 연결 0', async () => {
        const response = await fetch(`${serverUrl.replace('ws://', 'http://')}/healthz`);
        return (await response.json()).connections === 0;
      });
    } finally {
      await direct.closeAll();
    }
  });

  it('혼자 띄우기: 준비 문구를 쓰고, 준 규칙대로 버리고, SIGTERM 에 끝난다', async () => {
    const script = path.join(REPO_ROOT, 'tests', 'support', 'signal-proxy.mjs');
    const rules = JSON.stringify([{ from: 'alice', to: 'bob', kind: 'candidate', nth: 1, op: 'drop' }]);
    const child = procs.spawnNode(script, ['--upstream', serverUrl, '--port', '0', '--rules', rules], { name: 'proxy-cli', stdin: 'ignore' });
    const url = (await child.waitForOutput(/signal-proxy listening on (ws:\/\/\S+)/, { timeoutMs: 10_000 }))[1];
    session = createWireSession(url);
    const { alice, bob } = await trio();
    alice.signal('bob', candidate(alice.identity.sid, 'one'));
    alice.signal('bob', candidate(alice.identity.sid, 'two'));
    await bob.waitFor('두 번째 후보', () => bob.signals().length === 1);
    assert.deepEqual(labels(bob), ['two']);
    await session.closeAll();
    session = undefined;
    const stopped = await child.stop({ signal: 'SIGTERM', timeoutMs: 5_000 });
    assert.equal(stopped.code, 0);
    assert.equal(stopped.forced, false);
    assert.match(child.stdout(), /"dropped":1/);
  });
});
