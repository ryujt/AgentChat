// V-U9: 입장과 입장 실패 (architecture.md S1~S3, S8. protocol.md 3.1, 3.3).
// 하위 모듈 다섯 개는 계약에 맞춘 가짜다(testing.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../protocol/index.js';
import type { SignalPayload } from '../protocol/index.js';
import type { RoomEntered, SessionResult } from './contract.js';
import {
  MIN,
  ROOM,
  SEC,
  T0,
  createTestBed,
  enterRoom,
  presenceRecord,
  sidOf,
  testRecordOf,
} from './testing.js';

const OFFER = { type: 'signal', from: 'A', sid: sidOf('A'), kind: 'offer', cid: `${sidOf('A')}.1`, data: { sdp: 'v=0' } } as const;

function failureOf(result: SessionResult<RoomEntered>) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  return result;
}

describe('방 생성', () => {
  it('create 는 등록하고 기록 파일을 열고 자기 presence 를 쓴다. 결과에 자신 한 명을 싣는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const result = await me.session.create({});
    assert.ok(result.ok);
    assert.match(result.room_id, /^[a-z0-9]{16}$/, 'room_id 를 생략하면 무작위 16자다');
    assert.equal(result.server, 'ws://127.0.0.1:8787');
    assert.equal(result.name, 'alpha');
    assert.equal(result.test, null);
    assert.deepEqual(result.participants, [
      { name: 'alpha', client: 'claude-code', tools: [], role: null, status: 'joined', link: 'none', listening: false, shown_as: 'not_ready' },
    ]);

    const request = bed.net.joins[0];
    assert.equal(request?.mode, 'create');
    assert.equal(request?.room, result.room_id);
    assert.match(request?.sid ?? '', /^[a-z0-9]{12}$/);
    assert.match(request?.key ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(bed.net.clients[0]?.url, 'ws://127.0.0.1:8787');
    assert.deepEqual(me.records.last.meta, {
      server_key: 'ws://127.0.0.1:8787',
      room_id: result.room_id,
      name: 'alpha',
      sid: request?.sid,
      package_version: '0.1.0',
    });
    const mine = me.replica().view(bed.clock.now()).presences;
    assert.deepEqual(mine.map((presence) => [presence.peer, presence.status, presence.client]), [['alpha', 'joined', 'claude-code']]);
    assert.equal(me.log.named('join.end')[0]?.fields.outcome, 'ok');
    assert.ok(!JSON.stringify(me.log.events).includes(result.room_id), '진단 로그에 방 ID 원문이 없다');
    bed.net.assertNoListenerErrors();
  });

  it('server 인자가 설정보다 먼저다. 정규화한 서버 키를 돌려준다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha', config: { defaultServer: 'not a valid address' } });
    const result = await me.session.create({ server: 'EXAMPLE.org' });
    assert.ok(result.ok);
    assert.equal(result.server, 'wss://example.org');
    assert.equal(bed.net.clients[0]?.url, 'wss://example.org');
  });

  it('인자 검증: 서버 주소, 이름, 예약 이름, 방 ID 가 틀리면 INVALID_ARGUMENT 이고 접속하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const cases = [
      me.session.create({ server: 'ftp://example.org' }),
      me.session.create({ name: 'has space' }),
      me.session.create({ name: 'System' }),
      me.session.create({ room_id: 'short' }),
      me.session.create({ room_id: 'UPPERCASE1234' }),
      me.session.join({ room_id: 'x' }),
    ];
    for (const result of await Promise.all(cases)) assert.equal(failureOf(result).code, 'INVALID_ARGUMENT');
    const broken = bed.session({ name: 'alpha', config: { defaultServer: 'ftp://example.org' } });
    assert.equal(failureOf(await broken.session.create({})).code, 'INVALID_ARGUMENT', '틀린 설정을 공용 서버로 바꿔 접속하지 않는다');
    assert.equal(bed.net.clients.length, 0);
    assert.equal(bed.net.allMeshes.length, 0);
  });

  it('(검토 1차 PRODUCT-R1-04) server 인자 없이 쓴 기본 주소(AGENT_CHAT_SERVER)가 틀리면 그 설정 이름과 할 일을 알린다. 인자로 준 주소가 틀리면 그 인자다', async () => {
    const bed = createTestBed();
    const broken = bed.session({ name: 'alpha', config: { defaultServer: 'ftp://bad' } });
    const fromSetting = failureOf(await broken.session.create({}));
    assert.equal(fromSetting.code, 'INVALID_ARGUMENT');
    const detail = 'detail' in fromSetting ? String(fromSetting.detail) : '';
    assert.match(detail, /AGENT_CHAT_SERVER/);
    assert.match(detail, /Ask your user to fix/);
    assert.match(detail, /server argument/);
    assert.match(detail, /scheme must be ws, wss, http or https/, '원인도 그대로 싣는다');
    const joinFromSetting = failureOf(await broken.session.join({ room_id: ROOM }));
    assert.match('detail' in joinFromSetting ? String(joinFromSetting.detail) : '', /AGENT_CHAT_SERVER/);

    const fromArgument = failureOf(await bed.session({ name: 'beta' }).session.create({ server: 'ftp://bad' }));
    assert.doesNotMatch('detail' in fromArgument ? String(fromArgument.detail) : '', /AGENT_CHAT_SERVER/, '인자로 준 주소의 오류에 설정 이름을 섞지 않는다');
    assert.equal(bed.net.clients.length, 0);
  });

  it('ICE 설정이 거절됐으면 접속하지 않고 ICE_CONFIG_REJECTED 다. 세션은 그대로 쓸 수 있다', async () => {
    const bed = createTestBed();
    const me = bed.session({
      name: 'alpha',
      config: { iceServers: { raw: 'turn:x', parsed: { ok: false, code: 'ICE_CONFIG_REJECTED', detail: 'entry 1 is a TURN server' } } },
    });
    assert.equal(failureOf(await me.session.create({})).code, 'ICE_CONFIG_REJECTED');
    assert.equal(failureOf(await me.session.join({ room_id: ROOM })).code, 'ICE_CONFIG_REJECTED');
    assert.equal(bed.net.clients.length, 0, '시그널링 클라이언트를 만들지 않았다');
    assert.equal(bed.net.allMeshes.length, 0);
    assert.deepEqual(me.session.status(), { ok: false, code: 'NOT_IN_ROOM', detail: 'not in a room' });
  });

  it('mesh 를 만들지 못하면 NATIVE_LOAD_FAILED 이고 join 을 보내지 않는다', async () => {
    const bed = createTestBed();
    bed.net.nativeLoadFails = true;
    const me = bed.session({ name: 'alpha' });
    assert.equal(failureOf(await me.session.create({})).code, 'NATIVE_LOAD_FAILED');
    assert.equal(bed.net.joins.length, 0);
    assert.equal(bed.net.clients[0]?.closed, true);
    assert.deepEqual(me.inbox.discards, [0]);
  });

  it('서버에 닿지 못하면 SERVER_UNREACHABLE, 서버가 거절하면 SIGNALING_ERROR 와 서버 코드다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    bed.net.rejectJoinWith = { code: 'SERVER_UNREACHABLE' };
    assert.equal(failureOf(await me.session.create({})).code, 'SERVER_UNREACHABLE');

    bed.net.rejectJoinWith = { code: 'ROOM_EXISTS' };
    const exists = failureOf(await me.session.create({ room_id: ROOM }));
    assert.deepEqual([exists.code, exists.code === 'SIGNALING_ERROR' && exists.details], ['SIGNALING_ERROR', { server_code: 'ROOM_EXISTS' }]);

    bed.net.rejectJoinWith = { code: 'RATE_LIMITED', retryAfterMs: 4000 };
    const limited = failureOf(await me.session.join({ room_id: ROOM }));
    assert.deepEqual(limited.code === 'SIGNALING_ERROR' && limited.details, { server_code: 'RATE_LIMITED', retry_after_ms: 4000 });

    // 실패한 뒤에는 방에 없다. 소켓과 mesh 가 정리됐고, 기록 파일은 열지 않았다.
    assert.equal(bed.net.clients.every((client) => client.closed), true);
    assert.equal(bed.net.allMeshes.every((mesh) => mesh.down), true);
    assert.equal(me.records.transcripts.length, 0);
    assert.deepEqual(me.inbox.discards, [0, 0, 0], '실패마다 수신함을 비웠다');

    bed.net.rejectJoinWith = null;
    assert.equal((await me.session.create({ room_id: ROOM })).ok, true, '다시 시도하면 된다');
  });

  it('방에 있거나 입장 중이면 create·join 은 ALREADY_IN_ROOM 이다. 입장 중의 다른 호출은 NOT_IN_ROOM 이다', async () => {
    const bed = createTestBed();
    bed.net.holdJoined = true;
    const me = bed.session({ name: 'alpha' });
    const entering = me.session.create({ room_id: ROOM });
    await bed.settle();
    assert.equal(failureOf(await me.session.join({ room_id: ROOM })).code, 'ALREADY_IN_ROOM');
    assert.equal(failureOf(await me.session.create({})).code, 'ALREADY_IN_ROOM');
    assert.equal(me.session.status().ok, false);
    assert.equal((await me.session.leave()).ok, false);
    assert.equal((await me.session.sendChat({ text: 'x' })).ok, false);
    assert.equal((await me.session.command({ type: 'set_status', status: 'ready' })).ok, false);
    assert.equal((await me.session.writeReport()).ok, false);
    assert.equal(me.session.notice(), null);

    bed.net.clientOf('alpha').releaseJoined();
    assert.equal((await entering).ok, true);
    assert.equal(failureOf(await me.session.create({})).code, 'ALREADY_IN_ROOM');
    assert.equal(bed.net.clients.length, 1, '거절한 호출은 접속하지 않았다');
  });
});

describe('입장: joined 전의 시그널', () => {
  it('offer 가 joined 보다 먼저 와도 입장한다. 그때 생긴 시그널은 joined 뒤에 받은 순서대로 나간다', async () => {
    const bed = createTestBed();
    bed.net.holdJoined = true;
    bed.net.register(ROOM, 'A', sidOf('A'));
    const answer: SignalPayload = { kind: 'answer', cid: OFFER.cid, data: { sdp: 'v=0 answer' } };
    const candidates: SignalPayload = {
      kind: 'candidate',
      cid: OFFER.cid,
      data: { list: [{ candidate: 'candidate:1 1 UDP 1 192.0.2.1 9 typ host', mid: '0' }] },
    };
    // 가짜 mesh 는 offer 를 받으면 실제 mesh 처럼 answer 와 후보를 주입받은 전송 함수로 내보낸다.
    bed.net.onSignal = (mesh, signal) => {
      if (signal.kind !== 'offer') return;
      assert.equal(mesh.deps.sendSignal(signal.from, answer), true, '들고 있겠다고 받았다');
      assert.equal(mesh.deps.sendSignal(signal.from, candidates), true);
    };

    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const client = bed.net.clientOf('J');
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh, 'join 을 보내기 전에 mesh 가 있다');
    assert.equal(client.listenerCount('signal'), 1, 'join 을 보내기 전에 시그널 처리기가 붙어 있다');

    // joined 보다 offer 가 먼저 온다(공용 서버의 순서).
    client.emitSignal(OFFER);
    assert.deepEqual(mesh.signals, [OFFER], '버리지 않고 mesh 에 넘겼다');
    assert.deepEqual(client.signals, [], 'joined 전에는 아무 것도 보내지 않는다');
    assert.deepEqual(client.refused, [], '서버가 NOT_JOINED 로 거절할 전송을 하지 않았다');
    assert.deepEqual(mesh.contacts, [], '접촉은 joined 뒤에 한다');

    client.releaseJoined();
    await bed.settle();
    assert.deepEqual(client.signals.slice(0, 2), [
      { to: 'A', payload: answer },
      { to: 'A', payload: candidates },
    ]);
    assert.deepEqual(mesh.contacts, ['A']);

    bed.remote('J', 'A').sync([presenceRecord('A', T0 - SEC)]);
    const result = await entering;
    assert.ok(result.ok);
    assert.deepEqual(result.participants.map((peer) => [peer.name, peer.link]), [['A', 'open']]);
    bed.net.assertNoListenerErrors();
  });

  it('서버의 전달 실패와 게이트웨이 프레임을 mesh 에 넘긴다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    room.client.emitRelayError({ to: 'B', cid: null, code: 'PEER_NOT_FOUND' });
    room.client.emitGatewayFrame();
    assert.deepEqual(room.mesh.relayErrors, [{ to: 'B', cid: null, code: 'PEER_NOT_FOUND' }]);
    assert.equal(room.mesh.resendPendingCalls, 1);
  });
});

describe('입장: 기존 참가자 전원과 동기화', () => {
  it('전원과 동기화되면 성공한다. 그 뒤에 자기 presence 를 쓰고 열린 링크 전부에 변경으로 보낸다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    bed.net.register(ROOM, 'B', sidOf('B'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    assert.deepEqual(mesh.contacts, ['A', 'B']);
    assert.equal(bed.net.joins[0]?.mode, 'join');

    const testId = `${sidOf('A')}-1`;
    const a = bed.remote('J', 'A').open();
    // 링크가 열리면 hello, 스냅샷(빈 복제본이라 프레임 없음), sync_end 를 먼저 보낸다.
    assert.deepEqual(a.take().map((frame) => frame.t), ['hello', 'sync_end']);
    a.hello()
      .state([presenceRecord('A', T0 - 5 * MIN, { status: 'working', role: '강사' }), testRecordOf('A', T0 - 4 * MIN, testId)], true)
      .syncEnd({ count: 2, test_id: testId, test_elapsed_ms: 4 * MIN });
    await bed.settle();
    let done = false;
    void entering.then(() => {
      done = true;
    });
    await bed.settle();
    assert.equal(done, false, 'B 와 동기화되기 전에는 끝나지 않는다');
    assert.equal(me.session.status().ok, false, '입장 중에는 NOT_IN_ROOM 이다');
    assert.equal(me.replica().view(bed.clock.now()).presences.some((presence) => presence.peer === 'J'), false, '동기화 전에는 presence 를 쓰지 않는다');

    const b = bed.remote('J', 'B');
    b.sync([presenceRecord('B', T0 - 3 * MIN, { status: 'ready', listening: true })]);
    const result = await entering;
    assert.ok(result.ok);
    assert.deepEqual(
      result.participants.map((peer) => [peer.name, peer.role, peer.status, peer.link, peer.shown_as]),
      [
        ['A', '강사', 'working', 'open', 'working'],
        ['B', null, 'ready', 'open', 'ready'],
      ],
    );
    assert.equal(result.test?.test_id, testId);
    assert.equal(result.test?.remaining_min, 56, '넘겨받은 경과 시간 4분으로 계산한다');
    assert.equal(result.test?.by, 'A');

    // 자기 presence 는 두 링크 모두에 변경(snap 없음)으로 갔다.
    for (const remote of [a, b]) {
      const last = remote.frames().at(-1);
      assert.ok(last?.t === 'state' && last.snap !== true);
      assert.deepEqual(last.records.map((record) => [record.kind, record.author]), [['presence', 'J']]);
    }
    // 입장 중에 스냅샷으로 받은 상태는 수신함 사건으로 만들지 않는다. 입장 결과가 싣는다.
    assert.deepEqual(me.inbox.events, []);
    assert.deepEqual(me.records.last.entries.filter((entry) => entry.kind === 'state').length, 4, '받은 기록 셋과 자기 presence 를 기록 파일에 썼다');
    bed.net.assertNoListenerErrors();
  });

  it('(검토 1차 PRODUCT-R1-01) 재입장하면 스냅샷의 자기 옛 presence 에서 역할과 도구를 이어받아 쓰고, 결과의 you 로 알린다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const a = bed.remote('J', 'A');
    // 옛 J 가 쓴 presence(역할 수강생2, 도구 browser, ready)가 A 의 복제본에 있다. 옛 J 는 나갔다(left).
    a.sync([
      presenceRecord('A', T0 - 5 * MIN, { status: 'working', role: '강사' }),
      presenceRecord('J', T0 - 4 * MIN, { status: 'left', role: '수강생2', tools: ['browser'], note: '로그인 화면을 보는 중' }),
    ]);
    const result = await entering;
    assert.ok(result.ok);
    assert.deepEqual(result.you, { role: '수강생2', tools: ['browser'], status: 'joined', note: null, rejoined: true });
    // 공유 상태의 자기 presence 도 역할과 도구를 이어받는다. 상태는 joined(다시 준비를 알려야 한다), 메모는 비운다.
    const mine = me.replica().view(bed.clock.now()).presences.find((presence) => presence.peer === 'J');
    assert.deepEqual([mine?.role, mine?.tools, mine?.status, mine?.note], ['수강생2', ['browser'], 'joined', null]);
    const sent = a.frames().at(-1);
    assert.ok(sent?.t === 'state');
    const body = sent.records.find((record) => record.kind === 'presence' && record.author === 'J')?.body as { role?: string } | undefined;
    assert.equal(body?.role, '수강생2', '다른 참가자에게도 역할이 지워지지 않는다');
    bed.net.assertNoListenerErrors();
  });

  it('(검토 1차 PRODUCT-R1-01) 처음 들어온 참가자의 you 는 빈 역할이고 rejoined 는 거짓이다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    bed.remote('J', 'A').sync([presenceRecord('A', T0 - 5 * MIN, { status: 'working', role: '강사' })]);
    const result = await entering;
    assert.ok(result.ok);
    assert.deepEqual(result.you, { role: null, tools: [], status: 'joined', note: null, rejoined: false });
  });

  it('입장 중에 받은 채팅은 기록하고 수신함에 넣고 ack 를 보낸다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    bed.net.register(ROOM, 'B', sidOf('B'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const a = bed.remote('J', 'A').sync();
    a.chat(`${sidOf('A')}-9`, '입장 중에 온 글');
    assert.deepEqual(me.inbox.events.map((event) => [event.kind, event.from, event.text]), [['chat', 'A', '입장 중에 온 글']]);
    assert.deepEqual(a.frames().at(-1), { v: 1, t: 'ack', id: `${sidOf('A')}-9` });
    bed.remote('J', 'B').sync();
    assert.equal((await entering).ok, true);
  });
});

describe('입장 실패', () => {
  it('필수 목록이 모두 빠진 join 은 SIGNALING_ERROR{ROOM_NOT_FOUND} 다 (PEER_NOT_FOUND)', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    bed.net.register(ROOM, 'B', sidOf('B'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    mesh.failAttempt('A', { stage: 'signaling', reason: 'peer_gone' });
    await bed.settle();
    mesh.failAttempt('B', { stage: 'signaling', reason: 'peer_gone' });
    const failure = failureOf(await entering);
    assert.equal(failure.code, 'SIGNALING_ERROR');
    assert.deepEqual(failure.code === 'SIGNALING_ERROR' && failure.details, { server_code: 'ROOM_NOT_FOUND' });
    assert.equal(bed.net.clientOf('J').left, true, '서버 등록을 지웠다');
    assert.deepEqual(bed.net.membersOf(ROOM).map((member) => member.peer), ['A', 'B']);
  });

  it('상대의 bye{leave|shutdown} 도 필수 목록에서 뺀다. 남은 피어와 동기화되면 성공한다', async () => {
    const bed = createTestBed();
    for (const peer of ['A', 'B', 'C']) bed.net.register(ROOM, peer, sidOf(peer));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    bed.remote('J', 'A').open().hello().bye('leave');
    bed.remote('J', 'B').open().hello().bye('shutdown');
    mesh.failAttempt('C', { stage: 'signaling', reason: 'peer_gone' });
    // 셋 다 빠졌고 열린 링크가 없다.
    assert.equal(failureOf(await entering).code, 'SIGNALING_ERROR');

    const again = bed.session({ name: 'K' });
    const second = again.session.join({ room_id: ROOM, name: 'K' });
    await bed.settle();
    bed.remote('K', 'A').open().hello().bye('leave');
    bed.net.meshOf('K')?.failAttempt('B', { stage: 'signaling', reason: 'peer_gone' });
    bed.remote('K', 'C').sync([presenceRecord('C', T0 - SEC)]);
    const result = await second;
    assert.ok(result.ok, 'A 와 B 가 빠져도 C 와 동기화되면 들어간다');
    assert.deepEqual(result.participants.map((peer) => [peer.name, peer.link, peer.shown_as]), [
      ['A', 'none', 'left'],
      ['C', 'open', 'not_ready'],
    ]);
  });

  it('attempt-failed{ice, failed} 는 필수 목록에서 빼지 않는다. 입장 실패로 싣는다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    // 서버의 RELAY_NOT_ALLOWED 로 끝난 시도도 mesh 는 ice / failed 로 알린다.
    bed.net.meshOf('J')?.failAttempt('A', { stage: 'ice', reason: 'failed' }, {
      ice_state: 'failed',
      pc_state: 'failed',
      local: { host: 2, srflx: 1 },
      remote: { host: 1, srflx: 0 },
      resends: 2,
      duration_ms: 800,
    });
    const failure = failureOf(await entering);
    assert.equal(failure.code, 'DIRECT_CONNECT_FAILED');
    assert.deepEqual(failure.code === 'DIRECT_CONNECT_FAILED' && failure.details, {
      timeout_ms: LIMITS.JOIN_MESH_TIMEOUT_MS,
      peers: [
        {
          name: 'A',
          stage: 'ice',
          reason: 'failed',
          ice_state: 'failed',
          candidates: { local: { host: 2, srflx: 1 }, remote: { host: 1, srflx: 0 } },
          resends: 2,
        },
      ],
    });
    const logged = me.log.named('join.end')[0]?.fields;
    assert.deepEqual([logged?.outcome, logged?.peer, logged?.stage, logged?.reason], ['failed', 'A', 'ice', 'failed']);
  });

  it('여러 피어가 서로 다른 단계에서 실패하면 모두 싣는다. 남은 피어가 정해질 때까지 기다린다', async () => {
    const bed = createTestBed();
    for (const peer of ['A', 'B', 'C']) bed.net.register(ROOM, peer, sidOf(peer));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    let done = false;
    void entering.then(() => {
      done = true;
    });
    bed.remote('J', 'C').sync();
    mesh.failAttempt('A', { stage: 'signaling', reason: 'no_answer' });
    await bed.settle();
    assert.equal(done, false, 'B 의 결과가 아직 없다');
    assert.equal(mesh.contacts.filter((peer) => peer === 'A').length, 1, '실패로 정해진 뒤에는 다시 접촉하지 않는다');
    await bed.clock.advance(2 * SEC);
    assert.equal(mesh.contacts.filter((peer) => peer === 'A').length, 1);
    mesh.failAttempt('B', { stage: 'ice', reason: 'ice_timeout' });
    const failure = failureOf(await entering);
    assert.ok(failure.code === 'DIRECT_CONNECT_FAILED');
    assert.deepEqual(failure.details.peers.map((peer) => [peer.name, peer.stage, peer.reason]), [
      ['A', 'signaling', 'no_answer'],
      ['B', 'ice', 'ice_timeout'],
    ]);
  });

  it('입장 기한에 아직 시도 중인 필수 피어는 mesh.expireAttempt 로 끝내고 그 단계와 사유를 싣는다', async () => {
    const bed = createTestBed();
    for (const peer of ['A', 'B', 'C', 'D']) bed.net.register(ROOM, peer, sidOf(peer));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    // A: 동기화됨. B: 도중에 바뀐 시도라 기한이 입장 기한보다 늦다. C: 채널은 열렸지만 hello 뒤 동기화가 안 끝남. D: 열렸지만 hello 가 4초째 없다.
    bed.remote('J', 'A').sync();
    mesh.expireAs.set('B', { stage: 'signaling', reason: 'no_offer' });
    bed.remote('J', 'C').open().hello();
    let done = false;
    void entering.then(() => {
      done = true;
    });
    await bed.clock.advance(LIMITS.JOIN_MESH_TIMEOUT_MS - 4 * SEC);
    bed.remote('J', 'D').open();
    await bed.clock.advance(4 * SEC - 1);
    assert.equal(done, false, '기한 전에는 끝나지 않는다');
    assert.deepEqual(mesh.expired, []);
    await bed.clock.advance(1);

    const failure = failureOf(await entering);
    assert.deepEqual(mesh.expired, ['B'], '아직 시도 중인 피어에만 불렀다');
    assert.ok(failure.code === 'DIRECT_CONNECT_FAILED');
    assert.equal(failure.details.timeout_ms, 20_000);
    assert.deepEqual(failure.details.peers.map((peer) => [peer.name, peer.stage, peer.reason, peer.ice_state, peer.candidates, peer.resends]), [
      ['B', 'signaling', 'no_offer', 'checking', { local: { host: 1, srflx: 1 }, remote: { host: 1, srflx: 0 } }, 4],
      ['C', 'session', 'sync_timeout', null, null, null],
      ['D', 'session', 'hello_timeout', null, null, null],
    ]);
    assert.equal(me.log.named('join.end').length, 3, '실패한 피어마다 한 줄');
  });

  it('hello 뒤에 링크가 bye 없이 닫히고 기한까지 다시 열리지 않으면 session / sync_timeout 이다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    bed.remote('J', 'A').open().hello();
    mesh.dropLink('A', 'ping_timeout');
    // 닫힌 뒤 1초 만에 한 번 다시 접촉한다. 그 시도는 기한까지 열리지 않는다.
    await bed.clock.advance(LIMITS.RECONTACT_DELAY_MS);
    assert.deepEqual(mesh.contacts, ['A', 'A']);
    mesh.expireAs.set('A', { stage: 'signaling', reason: 'no_answer' });
    await bed.clock.advance(LIMITS.JOIN_MESH_TIMEOUT_MS);
    const failure = failureOf(await entering);
    assert.ok(failure.code === 'DIRECT_CONNECT_FAILED');
    // 다시 건 시도가 진행 중이었으므로 mesh 가 준 단계와 사유를 싣는다.
    assert.deepEqual(failure.details.peers.map((peer) => [peer.stage, peer.reason]), [['signaling', 'no_answer']]);

    // 다시 접촉할 수 없는 경우(목록에서 빠짐)에는 시도가 없다. hello 까지 받았던 피어라 sync_timeout 이다.
    const other = createTestBed();
    other.net.register(ROOM, 'A', sidOf('A'));
    const second = other.session({ name: 'J' });
    const pending = second.session.join({ room_id: ROOM, name: 'J' });
    await other.settle();
    other.remote('J', 'A').open().hello();
    other.net.clientOf('J').emitMembers([], 'pong');
    other.net.meshOf('J')?.dropLink('A', 'ping_timeout');
    await other.clock.advance(LIMITS.JOIN_MESH_TIMEOUT_MS);
    const late = failureOf(await pending);
    assert.ok(late.code === 'DIRECT_CONNECT_FAILED');
    assert.deepEqual(late.details.peers.map((peer) => [peer.name, peer.stage, peer.reason]), [['A', 'session', 'sync_timeout']]);
  });

  it('hello 가 5초 안에 없으면 링크를 닫고 session / hello_timeout 이다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    bed.remote('J', 'A').open();
    await bed.clock.advance(LIMITS.HELLO_TIMEOUT_MS - 1);
    assert.equal(mesh.isOpen('A'), true);
    await bed.clock.advance(1);
    assert.deepEqual(mesh.closed, [{ peer: 'A', reason: 'hello_timeout' }]);
    const failure = failureOf(await entering);
    assert.ok(failure.code === 'DIRECT_CONNECT_FAILED');
    assert.deepEqual(failure.details.peers.map((peer) => [peer.stage, peer.reason]), [['session', 'hello_timeout']]);
  });

  it('hello 의 이름이나 sid 가 링크와 다르면 닫고 session / hello_mismatch 다', async () => {
    for (const overrides of [{ peer: 'Z' }, { sid: sidOf('other') }]) {
      const bed = createTestBed();
      bed.net.register(ROOM, 'A', sidOf('A'));
      const me = bed.session({ name: 'J' });
      const entering = me.session.join({ room_id: ROOM, name: 'J' });
      await bed.settle();
      const a = bed.remote('J', 'A').open().hello(overrides);
      const failure = failureOf(await entering);
      assert.ok(failure.code === 'DIRECT_CONNECT_FAILED');
      assert.deepEqual(failure.details.peers.map((peer) => [peer.name, peer.stage, peer.reason]), [['A', 'session', 'hello_mismatch']]);
      assert.deepEqual(a.frames().at(-1), { v: 1, t: 'bye', reason: 'protocol_error' });
      assert.deepEqual(bed.net.meshOf('J'), undefined);
    }
  });

  it('상대의 P2P 버전이 다르면 PEER_VERSION_MISMATCH 다. bye{version} 을 내 버전으로 보내고 닫는다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    bed.net.register(ROOM, 'B', sidOf('B'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    const a = bed.remote('J', 'A').open().send({ v: 2, t: 'hello', peer: 'A', sid: sidOf('A') });
    assert.deepEqual(a.frames().at(-1), { v: 1, t: 'bye', reason: 'version' });
    // B 는 자기 쪽에서 먼저 알고 bye{version} 만 보냈다. 상대의 버전은 모른다.
    bed.remote('J', 'B').open().bye('version');
    const failure = failureOf(await entering);
    assert.equal(failure.code, 'PEER_VERSION_MISMATCH');
    assert.deepEqual(failure.code === 'PEER_VERSION_MISMATCH' && failure.details, {
      peers: [
        { name: 'A', theirs: 2 },
        { name: 'B', theirs: null },
      ],
      mine: 1,
    });
    assert.deepEqual(mesh.closed, [
      { peer: 'A', reason: 'version' },
      { peer: 'B', reason: 'bye_version' },
    ]);
  });

  it('버전 불일치와 다른 실패가 섞이면 DIRECT_CONNECT_FAILED 에 모두 싣는다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    bed.net.register(ROOM, 'B', sidOf('B'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    bed.remote('J', 'A').open().bye('version');
    bed.net.meshOf('J')?.failAttempt('B', { stage: 'ice', reason: 'ice_timeout' });
    const failure = failureOf(await entering);
    assert.ok(failure.code === 'DIRECT_CONNECT_FAILED');
    assert.deepEqual(failure.details.peers.map((peer) => [peer.name, peer.stage, peer.reason]), [
      ['A', 'session', 'version'],
      ['B', 'ice', 'ice_timeout'],
    ]);
  });

  it('실패한 뒤에는 열린 링크와 서버 등록이 남지 않는다. 열린 링크에는 bye{leave} 를 보냈다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    bed.net.register(ROOM, 'B', sidOf('B'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    const client = bed.net.clientOf('J');
    assert.ok(mesh);
    const a = bed.remote('J', 'A').sync([presenceRecord('A', T0 - SEC)]);
    a.chat(`${sidOf('A')}-1`, '입장 도중에 온 글');
    assert.equal(me.inbox.events.length, 1);
    mesh.failAttempt('B', { stage: 'ice', reason: 'ice_timeout' });
    assert.equal(failureOf(await entering).code, 'DIRECT_CONNECT_FAILED');

    assert.deepEqual(a.frames().at(-1), { v: 1, t: 'bye', reason: 'leave' });
    assert.equal(client.left, true);
    assert.equal(client.closed, true);
    assert.equal(mesh.down, true);
    assert.deepEqual(bed.net.membersOf(ROOM).map((member) => member.peer), ['A', 'B'], '서버에 J 의 기록이 없다');
    assert.equal(client.listenerCount('signal'), 0, '시그널 처리기를 뗐다');
    assert.equal(me.inbox.listenerCount('listening-changed'), 0);
    // 입장 도중 수신함에 넣은 사건은 버린다. 본문은 기록 파일에 남는다.
    assert.deepEqual(me.inbox.discards, [1]);
    assert.deepEqual(me.inbox.events, []);
    const file = me.records.last;
    assert.equal(file.closed, true);
    assert.deepEqual(file.entries.at(-1), { kind: 'end', reason: 'join_failed' });
    assert.ok(file.entries.some((entry) => entry.kind === 'chat_in' && entry.text === '입장 도중에 온 글'));
    assert.deepEqual(me.session.status(), { ok: false, code: 'NOT_IN_ROOM', detail: 'not in a room' });
    assert.equal(bed.clock.timerCount, 0, '타이머가 남지 않았다');
  });

  it('필수 피어가 아닌 피어(목록에 없던 피어)의 실패는 입장을 막지 않는다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    const me = bed.session({ name: 'J' });
    const entering = me.session.join({ room_id: ROOM, name: 'J' });
    await bed.settle();
    const mesh = bed.net.meshOf('J');
    assert.ok(mesh);
    // 동시에 들어오는 K 가 J 를 보고 연결을 걸었다가 실패한다. K 는 J 의 목록에 없었다.
    mesh.failAttempt('K', { stage: 'ice', reason: 'ice_timeout' });
    bed.remote('J', 'A').sync();
    assert.equal((await entering).ok, true);
  });
});

describe('입장 취소', () => {
  it('이미 취소된 호출은 접속하지 않고 CANCELLED 다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'J' });
    const controller = new AbortController();
    controller.abort();
    assert.equal(failureOf(await me.session.join({ room_id: ROOM, signal: controller.signal })).code, 'CANCELLED');
    assert.equal(bed.net.clients.length, 0);
  });

  it('join 의 답을 기다리는 중에 취소되면 소켓을 닫고 CANCELLED 다. 수신함을 비운다', async () => {
    const bed = createTestBed();
    bed.net.holdJoined = true;
    const me = bed.session({ name: 'J' });
    const controller = new AbortController();
    const entering = me.session.join({ room_id: ROOM, name: 'J', signal: controller.signal });
    await bed.settle();
    controller.abort();
    assert.equal(failureOf(await entering).code, 'CANCELLED');
    assert.equal(bed.net.clients[0]?.closed, true);
    assert.equal(bed.net.allMeshes[0]?.down, true);
    assert.deepEqual(me.inbox.discards, [0]);
    assert.deepEqual(me.session.status(), { ok: false, code: 'NOT_IN_ROOM', detail: 'not in a room' });
  });

  it('피어와 연결하는 중에 취소되면 입장 실패와 같이 정리하고 CANCELLED 다', async () => {
    const bed = createTestBed();
    bed.net.register(ROOM, 'A', sidOf('A'));
    bed.net.register(ROOM, 'B', sidOf('B'));
    const me = bed.session({ name: 'J' });
    const controller = new AbortController();
    const entering = me.session.join({ room_id: ROOM, name: 'J', signal: controller.signal });
    await bed.settle();
    const a = bed.remote('J', 'A').sync();
    a.chat(`${sidOf('A')}-1`, '취소 전에 온 글');
    controller.abort();
    assert.equal(failureOf(await entering).code, 'CANCELLED');
    assert.deepEqual(a.frames().at(-1), { v: 1, t: 'bye', reason: 'leave' });
    assert.equal(bed.net.clientOf('J').left, true);
    assert.equal(bed.net.allMeshes[0]?.down, true);
    assert.deepEqual(me.inbox.discards, [1]);
    assert.deepEqual(me.records.last.entries.at(-1), { kind: 'end', reason: 'join_cancelled' });
    assert.equal(bed.clock.timerCount, 0);
    assert.equal(me.log.named('join.end')[0]?.fields.outcome, 'cancelled');
  });
});
