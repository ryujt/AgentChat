// V-U9: 입장 뒤의 mesh 보정과 참가자 표시 (protocol.md 3.1, 4.5. mcp-interface.md 3.4, 6.1).
// 접촉 대상 고르기, 연속 실패와 "닿지 않음", 링크 사건, 시그널링 상태, get_status.room.net 을 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../protocol/index.js';
import type { SessionStatus } from './contract.js';
import type { SessionUnderTest } from './testing.js';
import { ROOM, SEC, createTestBed, enterRoom, presenceRecord, sidOf } from './testing.js';

function statusOf(sut: SessionUnderTest): SessionStatus {
  const status = sut.session.status();
  assert.ok(status.ok);
  return status;
}

function shown(sut: SessionUnderTest): Record<string, string> {
  return Object.fromEntries(statusOf(sut).participants.map((peer) => [peer.name, `${peer.link}/${peer.shown_as}`]));
}

const peerEvents = (sut: SessionUnderTest) =>
  sut.inbox.pushed.filter((event) => event.kind === 'peer').map((event) => [event.from, event.change, event.data.reason]);

describe('mesh 보정: 접촉 대상', () => {
  it('pong 의 목록에 새로 나타난 피어에게 접촉한다. 열린 링크나 진행 중인 시도가 있으면 다시 하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const members = [
      { peer: 'A', sid: sidOf('A') },
      { peer: 'X', sid: sidOf('X') },
    ];
    room.client.emitMembers(members);
    assert.deepEqual(room.mesh.contacts, ['A', 'X'], 'A 는 입장 때 한 번, X 는 지금 한 번');
    room.client.emitMembers(members);
    assert.deepEqual(room.mesh.contacts, ['A', 'X'], '시도 중인 X 에게 다시 접촉하지 않는다');
    assert.deepEqual(shown(me), { A: 'open/ready', X: 'connecting/connecting' });
    // 목록에 없는 피어에게는 시도하지 않는다. 열린 링크의 상대가 목록에 없어도 링크는 유지한다.
    room.client.emitMembers([{ peer: 'X', sid: sidOf('X') }]);
    assert.equal(room.mesh.isOpen('A'), true);
    assert.equal(shown(me).A, 'open/ready');
  });

  it('목록의 sid 가 열린 링크와 다르면, 그 목록을 요청하기 전에 열린 링크만 교체 확인에 넘긴다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const openedAt = bed.clock.now();
    await bed.clock.advance(10 * SEC);
    const restarted = [{ peer: 'A', sid: sidOf('A', 1) }];
    // 링크가 열리기 전에 요청한 낡은 목록이다. 상대가 다시 시작했다고 볼 수 없다.
    room.client.emitMembers(restarted, 'pong', openedAt - 1);
    assert.deepEqual(room.mesh.probes, []);
    room.client.emitMembers(restarted, 'pong', openedAt + 5 * SEC);
    assert.deepEqual(room.mesh.probes, ['A']);
    assert.equal(room.mesh.isOpen('A'), true, '바로 닫지 않는다. 확인에 실패했을 때만 mesh 가 닫는다');
    assert.deepEqual(room.mesh.contacts, ['A'], '열린 링크가 있는 동안에는 새로 접촉하지 않는다');
  });

  it('시그널링 재접속 뒤의 joined 목록으로도 보정한다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    room.client.emitMembers([{ peer: 'J', sid: sidOf('J') }], 'joined');
    assert.deepEqual(room.mesh.contacts, ['J']);
  });
});

describe('mesh 보정: 연속 실패와 닿지 않음', () => {
  it('연속 실패 2회에 unreachable 사건을 한 번 낸다. 첫 실패 뒤에만 1초 만에 다시 시도한다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const members = [
      { peer: 'A', sid: sidOf('A') },
      { peer: 'X', sid: sidOf('X') },
    ];
    room.client.emitMembers(members);
    const contactsToX = (): number => room.mesh.contacts.filter((peer) => peer === 'X').length;

    room.mesh.failAttempt('X', { stage: 'signaling', reason: 'no_answer' });
    assert.deepEqual(peerEvents(me), [], '한 번 실패로는 알리지 않는다');
    assert.equal(shown(me).X, 'none/connecting');
    await bed.clock.advance(LIMITS.RECONTACT_DELAY_MS - 1);
    assert.equal(contactsToX(), 1);
    await bed.clock.advance(1);
    assert.equal(contactsToX(), 2, '첫 실패 1초 뒤에 한 번 다시 접촉한다');

    room.mesh.failAttempt('X', { stage: 'signaling', reason: 'no_answer' });
    assert.deepEqual(peerEvents(me), [['X', 'unreachable', 'no_response']]);
    assert.equal(shown(me).X, 'none/unreachable');
    assert.deepEqual(statusOf(me).warnings, [{ code: 'unreachable', peer: 'X' }]);
    assert.deepEqual(me.session.notice(), { unreachable: ['X'] });
    await bed.clock.advance(5 * SEC);
    assert.equal(contactsToX(), 2, '두 번째 실패 뒤에는 바로 다시 하지 않는다');

    // 그 뒤로는 목록 갱신(pong) 주기로 계속 시도한다. 사건은 되풀이하지 않는다.
    room.client.emitMembers(members);
    assert.equal(contactsToX(), 3);
    room.mesh.failAttempt('X', { stage: 'signaling', reason: 'no_offer' });
    assert.equal(peerEvents(me).length, 1, '사건은 한 번만');
    assert.deepEqual(me.records.last.entries.filter((entry) => entry.kind === 'peer'), [
      { kind: 'peer', name: 'X', change: 'unreachable', reason: 'no_response' },
    ]);

    // 링크가 열리면 세던 것을 지운다. 다시 2회 연속 실패하면 다시 알린다.
    room.client.emitMembers(members);
    bed.remote('alpha', 'X').sync([presenceRecord('X', bed.clock.now() - SEC)]);
    assert.equal(shown(me).X, 'open/not_ready');
    assert.deepEqual(statusOf(me).warnings, []);
    room.mesh.dropLink('X', 'ping_timeout');
    room.mesh.failAttempt('X', { stage: 'ice', reason: 'ice_timeout' });
    room.mesh.failAttempt('X', { stage: 'ice', reason: 'ice_timeout' });
    assert.deepEqual(peerEvents(me).at(-1), ['X', 'unreachable', 'no_route']);
    bed.net.assertNoListenerErrors();
  });

  it('attempt-failed{ice, failed} 도 연속 실패로 센다. ICE 단계의 사유는 no_route 다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    room.client.emitMembers([{ peer: 'X', sid: sidOf('X') }]);
    // 서버의 RELAY_NOT_ALLOWED 로 끝난 시도도 이 모양으로 온다.
    room.mesh.failAttempt('X', { stage: 'ice', reason: 'failed' });
    room.mesh.failAttempt('X', { stage: 'ice', reason: 'failed' });
    assert.deepEqual(peerEvents(me), [['X', 'unreachable', 'no_route']]);
    assert.equal(shown(me).X, 'none/unreachable');
  });

  it('PEER_NOT_FOUND 로 끝난 시도는 세지 않는다. 다음 목록을 받을 때까지 접촉하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    room.client.emitMembers([{ peer: 'X', sid: sidOf('X') }]);
    for (let i = 0; i < 3; i += 1) room.mesh.failAttempt('X', { stage: 'signaling', reason: 'peer_gone' });
    await bed.clock.advance(5 * SEC);
    assert.deepEqual(peerEvents(me), []);
    assert.deepEqual(room.mesh.contacts, ['X'], '상대가 떠났다. 바로 다시 하지 않는다');
    assert.deepEqual(shown(me), {}, '서버에 없는 피어다. 참가자로 싣지 않는다');
    // 한 번 실패한 뒤 peer_gone 이 와도 연속 실패가 2가 되지 않는다.
    room.client.emitMembers([{ peer: 'Y', sid: sidOf('Y') }]);
    room.mesh.failAttempt('Y', { stage: 'signaling', reason: 'no_answer' });
    room.mesh.failAttempt('Y', { stage: 'signaling', reason: 'peer_gone' });
    assert.deepEqual(peerEvents(me), []);
  });
});

describe('링크 사건과 참가자 표시', () => {
  it('bye 없이 닫힌 링크는 disconnected 다. 목록에 있으면 1초 뒤 다시 접촉하고, 다시 동기화되면 reconnected 다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    room.mesh.dropLink('B', 'ping_timeout');
    assert.deepEqual(peerEvents(me), [['B', 'disconnected', 'ping_timeout']]);
    // B 의 presence 는 ready 그대로지만 연결되지 않은 참가자는 ready 로 보이지 않는다.
    assert.deepEqual(shown(me), { A: 'open/ready', B: 'none/disconnected' });
    assert.equal(statusOf(me).participants.find((peer) => peer.name === 'B')?.status, 'ready');
    await bed.clock.advance(LIMITS.RECONTACT_DELAY_MS);
    assert.deepEqual(room.mesh.contacts, ['A', 'B', 'B']);
    assert.equal(shown(me).B, 'connecting/disconnected');

    bed.remote('alpha', 'B').sync([presenceRecord('B', bed.clock.now() - SEC, { status: 'ready', listening: true })]);
    assert.deepEqual(peerEvents(me).at(-1), ['B', 'reconnected', undefined]);
    assert.equal(shown(me).B, 'open/ready');
  });

  it('bye{leave} 로 닫힌 링크는 left 다. 그 sid 와는 다시 시도하지 않고, 새 sid 로 오면 시도한다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    const b = room.remote('B');
    // 정상 퇴장은 presence{left} 를 변경으로 보낸 뒤 bye{leave} 를 보낸다.
    b.state([presenceRecord('B', bed.clock.now(), { status: 'left' })]).bye('leave');
    assert.deepEqual(room.mesh.closed, [{ peer: 'B', reason: 'bye_leave' }]);
    assert.deepEqual(peerEvents(me), [['B', 'left', undefined]], 'presence 가 알렸으므로 bye 로 되풀이하지 않는다');
    assert.equal(shown(me).B, 'none/left');

    await bed.clock.advance(5 * SEC);
    // 낡은 목록에 B 가 같은 sid 로 남아 있다.
    room.client.emitMembers([
      { peer: 'A', sid: sidOf('A') },
      { peer: 'B', sid: sidOf('B') },
    ]);
    assert.deepEqual(room.mesh.contacts, ['A', 'B'], '떠난 sid 에게는 접촉하지 않는다');
    assert.equal(shown(me).B, 'none/left');

    room.client.emitMembers([
      { peer: 'A', sid: sidOf('A') },
      { peer: 'B', sid: sidOf('B', 1) },
    ]);
    assert.deepEqual(room.mesh.contacts, ['A', 'B', 'B'], '새 sid 로 다시 들어왔다');
    // 5행은 "그 뒤 새 시도가 없다"가 조건이다. 한 번 링크가 열렸던 참가자라 8행으로 간다.
    assert.equal(shown(me).B, 'connecting/disconnected');
  });

  it('presence 를 쓴 적 없는 피어(입장에 실패한 참가자)의 bye{leave} 는 사건으로 알리지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    bed.remote('alpha', 'J').sync().bye('leave');
    assert.deepEqual(peerEvents(me), []);
    assert.deepEqual(shown(me), {}, 'presence 도, 링크도, 서버 목록에도 없다. 참가자로 싣지 않는다');
    assert.deepEqual(me.records.last.entries.filter((entry) => entry.kind === 'peer'), [
      { kind: 'peer', name: 'J', change: 'left', reason: 'leave' },
    ]);
    assert.deepEqual(room.mesh.closed, [{ peer: 'J', reason: 'bye_leave' }]);
  });

  it('입장 뒤에 만난 피어의 버전이 다르면 unreachable(version) 을 한 번 내고 그 sid 와는 다시 시도하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    const members = [{ peer: 'X', sid: sidOf('X') }];
    room.client.emitMembers(members);
    bed.remote('alpha', 'X').open().send({ v: 3, t: 'hello' });
    assert.deepEqual(room.mesh.closed, [{ peer: 'X', reason: 'version' }]);
    assert.deepEqual(peerEvents(me), [['X', 'unreachable', 'version']]);
    assert.equal(shown(me).X, 'none/unreachable');
    await bed.clock.advance(5 * SEC);
    room.client.emitMembers(members);
    assert.deepEqual(room.mesh.contacts, ['X'], '같은 sid 에게 다시 접촉하지 않는다');
    room.client.emitMembers([{ peer: 'X', sid: sidOf('X', 1) }]);
    assert.deepEqual(room.mesh.contacts, ['X', 'X'], '새 sid 로 들어오면 시도한다');
  });

  it('스냅샷으로 presence 만 받은 참가자(들어오기 전에 사라진 참가자)는 disconnected, presence 가 left 면 left 다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'J' });
    await enterRoom(bed, me, 'J', ['A'], {
      records: () => [
        presenceRecord('A', bed.clock.now() - 9 * SEC, { status: 'ready', listening: true }),
        presenceRecord('dead', bed.clock.now() - 8 * SEC, { status: 'working', role: '수강생', listening: true }),
        presenceRecord('gone', bed.clock.now() - 7 * SEC, { status: 'left' }),
      ],
    });
    assert.deepEqual(shown(me), { A: 'open/ready', dead: 'none/disconnected', gone: 'none/left' });
    const dead = statusOf(me).participants.find((peer) => peer.name === 'dead');
    assert.deepEqual([dead?.status, dead?.role], ['working', '수강생'], '기록은 그대로 싣되 살아 있는 역할로 보이지 않는다');
  });

  it('다른 참가자의 presence 변화를 사건으로 바꾼다: 입장, 역할, ready, 퇴장. working 은 알리지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    const at = (n: number): number => bed.clock.now() + n;
    const newcomer = bed.remote('alpha', 'N').sync();
    newcomer.state([presenceRecord('N', at(1), { status: 'joined', tools: ['browser'] })]);
    a.state([presenceRecord('A', at(2), { status: 'working', listening: true })]);
    a.state([presenceRecord('A', at(3), { status: 'working', role: '강사', listening: true })]);
    a.state([presenceRecord('A', at(4), { status: 'ready', role: '강사', listening: true })]);
    a.state([presenceRecord('A', at(5), { status: 'ready', role: '강사', listening: false })]);
    a.state([presenceRecord('A', at(6), { status: 'left', role: '강사' })]);
    const events = me.inbox.pushed.filter((event) => event.kind === 'peer');
    assert.deepEqual(events.map((event) => [event.from, event.change]), [
      ['N', 'joined'],
      ['A', 'role'],
      ['A', 'ready'],
      ['A', 'left'],
    ]);
    assert.deepEqual(events[0]?.data, { role: null, status: 'joined', tools: ['browser'] });
    assert.deepEqual([events[0]?.id, events[0]?.to], [null, 'room']);
  });

  it('(검토 1차 PRODUCT-R1-03) presence 로 판정한 입장과 재입장도 기록 파일에 peer 줄로 남긴다(보고서의 연결 사건)', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'C']);
    const at = (n: number): number => bed.clock.now() + n;
    const c = room.remote('C');
    // C 가 나갔다가(presence left) 같은 이름으로 다시 들어온다. N 은 처음 들어온다.
    c.state([presenceRecord('C', at(1), { status: 'left', role: '수강생2' })]);
    const rejoined = bed.remote('alpha', 'C').sync();
    rejoined.state([presenceRecord('C', at(2), { status: 'joined', role: '수강생2' })]);
    bed.remote('alpha', 'N').sync().state([presenceRecord('N', at(3), { status: 'joined' })]);
    const peers = me.records.last.entries.filter((entry) => entry.kind === 'peer').map((entry) => entry.kind === 'peer' && [entry.name, entry.change, entry.reason]);
    assert.deepEqual(
      peers.filter((entry) => entry !== false && entry[1] === 'joined'),
      [
        ['C', 'joined', 'rejoin'],
        ['N', 'joined', null],
      ],
    );
  });
});

describe('시그널링 상태', () => {
  it('재접속이 막히면 사건을 한 번 내고 경고와 notice 로 알린다. 열린 링크는 그대로다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    assert.equal(statusOf(me).room.signaling, 'connected');

    room.client.emitState('reconnecting');
    assert.equal(statusOf(me).room.signaling, 'reconnecting');
    assert.deepEqual(statusOf(me).warnings, [{ code: 'signaling', state: 'reconnecting', reason: null }]);
    assert.deepEqual(me.session.notice(), { signaling: { state: 'reconnecting' } });
    assert.deepEqual(me.inbox.pushed.filter((event) => event.kind === 'system'), [], '끊김은 정상 사건이다. 알리지 않는다');

    room.client.emitState('reconnecting', 'NAME_IN_USE');
    room.client.emitState('reconnecting', 'NAME_IN_USE');
    const codes = (): unknown[] => me.inbox.pushed.filter((event) => event.kind === 'system').map((event) => event.data.code);
    assert.deepEqual(codes(), ['signaling_blocked', 'name_conflict']);
    assert.deepEqual(statusOf(me).warnings, [
      { code: 'name_conflict' },
      { code: 'signaling', state: 'reconnecting', reason: 'NAME_IN_USE' },
    ]);
    assert.deepEqual(me.session.notice(), { signaling: { state: 'reconnecting', reason: 'NAME_IN_USE' } });
    assert.equal(room.mesh.isOpen('A'), true);
    assert.deepEqual(room.mesh.closed, []);

    room.client.emitState('connected');
    assert.deepEqual(statusOf(me).warnings, []);
    assert.deepEqual(me.session.notice(), {});

    room.client.emitState('detached', 'UNSUPPORTED_VERSION');
    assert.deepEqual(codes().at(-1), 'signaling_detached');
    assert.deepEqual(me.session.notice(), { signaling: { state: 'detached', reason: 'UNSUPPORTED_VERSION' } });
    assert.equal(room.mesh.isOpen('A'), true, '링크는 유지된다');
  });
});

describe('get_status.room.net', () => {
  it('srflx_seen 은 mesh.netInfo() 의 값을 그대로 싣는다. stun 은 ICE 설정에 STUN 서버가 있는가다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    assert.deepEqual(statusOf(me).room, {
      room_id: ROOM,
      server: 'ws://127.0.0.1:8787',
      name: 'alpha',
      signaling: 'connected',
      net: { stun: true, srflx_seen: false },
    });
    room.mesh.srflxSeen = true;
    assert.deepEqual(statusOf(me).room.net, { stun: true, srflx_seen: true });

    const hostOnly = bed.session({ name: 'beta', config: { iceServers: { raw: 'none', parsed: { ok: true, value: [] } } } });
    const other = await enterRoom(bed, hostOnly, 'beta', [], { room: 'room0000test0002' });
    other.mesh.srflxSeen = true;
    assert.deepEqual(statusOf(hostOnly).room.net, { stun: false, srflx_seen: true });
    assert.deepEqual(other.mesh.deps.iceServers, []);
    assert.deepEqual(room.mesh.deps.iceServers.map((server) => [server.hostname, server.port]), [['stun.example.org', 3478]]);
  });
});
