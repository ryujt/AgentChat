// 와이어 계약 테스트 (V-L1, V-P1). 시그널링 서버 하나에 붙어 protocol.md 2절의 계약을 확인한다.
// 자체 호스팅 서버와 공용 서버에 같은 파일을 쓴다. 대상은 --url 로 준다.
// 제품 클라이언트 코드를 쓰지 않는다. ws 와 빌드된 protocol 스키마만 쓴다(wire-client.mjs).
//
// 쓰는 법:
//   node tests/wire/wire-contract.mjs --url ws://127.0.0.1:8787
//   npm run test:wire -- --url wss://agent-chat.tools.camp
//
// 옵션:
//   --url <주소>               대상 서버(필수). 환경 변수 AGENT_CHAT_WIRE_URL 로도 준다.
//   --rounds <수>              동시 입장·동시 생성 반복 횟수(기본 10. deployment.md 2.11 의 12번).
//   --timeout-ms <ms>          요청 하나의 기한(기본 10000).
//   --flood-interval-ms <ms>   속도 제한 확인에서 메시지 사이의 간격(기본 0). 공용 서버에서는 스로틀 아래로 준다(예: 50).
//   --no-flood                 속도 제한 확인(301건 전송)을 건너뛴다. 건너뛴 항목은 통과로 세지 않는다.
//
// 항목 번호는 deployment.md 2.11 의 표(2~15번)다. 1번(도메인과 TLS)은 deployments/aws/verify.mjs 가 한다.
// 끝에 `WIRE-RESULT {…}` 한 줄로 측정값(걸린 시간, 둘 다 거절된 횟수, 여분 프레임 수)을 낸다.
// 빌드 결과는 dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 알려 준다.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { LIMITS, argValue, createWireSession, delay, freshName, freshRoom, hasFlag, newIdentity, openWire, protocol, until } from './wire-client.mjs';

const url = argValue('url') ?? process.env.AGENT_CHAT_WIRE_URL;
if (!url) {
  process.stderr.write('대상 서버를 --url <주소> 로 준다. 예: node tests/wire/wire-contract.mjs --url ws://127.0.0.1:8787\n');
  process.exit(2);
}
const rounds = Number.parseInt(argValue('rounds') ?? '10', 10);
const timeoutMs = Number.parseInt(argValue('timeout-ms') ?? String(LIMITS.SIGNAL_REQUEST_TIMEOUT_MS), 10);
const floodIntervalMs = Number.parseInt(argValue('flood-interval-ms') ?? '0', 10);
const skipFlood = hasFlag('no-flood');

/** 끝에 한 줄로 내는 측정값. 방 ID 와 이름은 넣지 않는다. */
const measured = { url_scheme: new URL(url).protocol, rounds, skipped: [] };
/** 모든 항목에 걸친 합계: 연 연결 수, 닫히지 않은 연결 수, 프로토콜 메시지가 아닌 프레임 수. */
const tally = { connections: 0, unclosed: 0, stray: { empty: 0, gateway: 0, unknown: 0, bad: 0, binary: 0 } };
if (skipFlood) measured.skipped.push('rate-limit');

/**
 * 항목마다 자기 연결을 열고, 끝나면 등록을 leave 로 지우고 닫는다.
 * 항목이 끝난 뒤 연결을 남기지 않아야 자체 호스팅 서버의 기본 주소별 한도(20) 안에서 돈다.
 */
function scoped(body) {
  return async (t) => {
    const session = createWireSession(url, { timeoutMs });
    try {
      await body(session, t);
    } finally {
      tally.unclosed += await session.closeAll({ timeoutMs });
      tally.connections += session.clients.length;
      const stray = session.strayTotals();
      for (const key of Object.keys(tally.stray)) tally.stray[key] += stray[key];
    }
  };
}

const codeOf = (message) => (message?.type === 'error' ? message.code : message?.type);
const peers = (message) => message.members.map((member) => member.peer).sort();

/** 방을 만들고 n 명을 채운다. 돌려주는 배열의 첫째가 만든 쪽이다. */
async function makeRoom(session, count) {
  const room = freshRoom();
  const members = [await session.joined(room, 'create')];
  for (let i = 1; i < count; i += 1) members.push(await session.joined(room, 'join'));
  return { room, members };
}

async function leaveAndClose(clients) {
  for (const client of clients) {
    client.leave();
    client.close();
  }
  await Promise.all(clients.map((client) => client.closed({ timeoutMs }).catch(() => null)));
}

describe(`와이어 계약: ${new URL(url).protocol}//…`, { concurrency: false }, () => {
  after(() => {
    measured.stray = tally.stray;
    measured.connections = tally.connections;
    measured.unclosed = tally.unclosed;
    process.stdout.write(`WIRE-RESULT ${JSON.stringify(measured)}\n`);
  });

  it('2. 방 생성: 무작위 방에 join(create) → joined{members: []} 와 서버 값', scoped(async (session) => {
    const room = freshRoom();
    const client = await session.open();
    const identity = newIdentity();
    const reply = await client.join({ room, ...identity, mode: 'create', id: 'create-1' });
    assert.equal(reply.type, 'joined', `응답: ${codeOf(reply)}`);
    assert.equal(reply.re, 'create-1');
    assert.deepEqual(reply.members, []);
    assert.equal(reply.max_peers, LIMITS.ROOM_MAX_PEERS);
    assert.equal(reply.ping_interval_ms, LIMITS.SIGNAL_PING_INTERVAL_MS);
    assert.equal(reply.stale_after_ms, LIMITS.PARTICIPANT_STALE_MS);
    measured.connect_ms = client.connectMs;
    measured.join_ms = reply.elapsedMs;
  }));

  it('2. 방 생성: 참가자가 있는 방에 create → ROOM_EXISTS. 연결은 유지된다', scoped(async (session) => {
    const { room } = await makeRoom(session, 1);
    const late = await session.open();
    const reply = await late.join({ room, ...newIdentity(), mode: 'create' });
    assert.equal(codeOf(reply), 'ROOM_EXISTS');
    assert.equal(codeOf(await late.ping()), 'NOT_JOINED', '거절된 연결은 등록되지 않았다');
    assert.equal(late.isOpen, true);
  }));

  it('3. 입장과 목록: 두 번째 연결의 join(join) 결과에 첫 참가자가 sid 와 함께 있다. 자신은 없다', scoped(async (session) => {
    const { room, members } = await makeRoom(session, 1);
    const [first] = members;
    const second = await session.joined(room, 'join');
    assert.deepEqual(second.joinedReply.members, [{ peer: first.identity.peer, sid: first.identity.sid }]);
    const third = await session.joined(room, 'join');
    assert.deepEqual(peers(third.joinedReply), [first.identity.peer, second.identity.peer].sort());
  }));

  it('4. heartbeat: ping → 같은 re 의 pong 과 자신을 뺀 목록', scoped(async (session) => {
    const { members } = await makeRoom(session, 2);
    const [first, second] = members;
    const pong = await first.request({ action: 'ping', id: 'ping-77' });
    assert.equal(pong.type, 'pong');
    assert.equal(pong.re, 'ping-77');
    assert.deepEqual(pong.members, [{ peer: second.identity.peer, sid: second.identity.sid }]);
    measured.ping_ms = pong.elapsedMs;
  }));

  it('5. 시그널 전달: 네 종류가 대상에게만, 서버가 붙인 from·sid 와 함께 도착한다. 다른 방에는 가지 않는다', scoped(async (session) => {
    const { members } = await makeRoom(session, 3);
    const [alice, bob, carol] = members;
    // 같은 이름의 참가자가 있는 다른 방.
    const otherRoom = freshRoom();
    const twin = await session.joined(otherRoom, 'create', newIdentity(bob.identity.peer));

    const cid = `${alice.identity.sid}.1`;
    const payloads = [
      { kind: 'offer-request', data: {} },
      { kind: 'offer', cid, data: { sdp: 'v=0\r\na=wire-test-offer\r\n' } },
      { kind: 'answer', cid, data: { sdp: 'v=0\r\na=wire-test-answer\r\n' } },
      { kind: 'candidate', cid, data: { list: [{ candidate: 'candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host', mid: '0' }] } },
    ];
    for (const payload of payloads) alice.signal(bob.identity.peer, payload);
    await bob.waitFor('시그널 4건', () => bob.signals().length >= payloads.length);

    // 공용 서버는 순서를 보장하지 않는다. 종류별로 맞춰 본다.
    for (const payload of payloads) {
      const got = bob.signals((message) => message.kind === payload.kind);
      assert.equal(got.length, 1, `${payload.kind} 가 ${got.length}건 도착했다`);
      const { receivedAt: _receivedAt, ...message } = got[0];
      assert.deepEqual(message, { type: 'signal', from: alice.identity.peer, sid: alice.identity.sid, ...payload });
    }
    await delay(300);
    assert.equal(carol.signals().length, 0, '같은 방의 다른 참가자에게 갔다');
    assert.equal(twin.signals().length, 0, '다른 방의 같은 이름에게 갔다');
    assert.equal(alice.errors().length, 0, '성공한 signal 에는 응답이 없다');
  }));

  it('6. 오류: 없는 방 join → ROOM_NOT_FOUND', scoped(async (session) => {
    const client = await session.open();
    const reply = await client.join({ room: freshRoom(), ...newIdentity(), mode: 'join', id: 'nf-1' });
    assert.equal(codeOf(reply), 'ROOM_NOT_FOUND');
    assert.equal(reply.re, 'nf-1');
    assert.equal(client.isOpen, true);
  }));

  it('6. 오류: 상한을 넘는 메시지 → MESSAGE_TOO_LARGE. 상한과 같은 크기는 받는다. 연결은 유지된다', scoped(async (session) => {
    const client = await session.open();
    const head = '{"action":"ping","id":"big-ok","pad":"';
    const fits = `${head}${'x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES - head.length - 2)}"}`;
    assert.equal(Buffer.byteLength(fits), LIMITS.SIGNAL_MAX_MESSAGE_BYTES);
    client.sendRaw(fits);
    assert.equal(codeOf(await client.reply('big-ok')), 'NOT_JOINED', '상한과 같은 크기는 해석된다');

    client.sendRaw(`${fits} `);
    const refused = await client.waitFor('MESSAGE_TOO_LARGE', () => client.errors((message) => message.code === 'MESSAGE_TOO_LARGE')[0]);
    assert.equal(refused.re, undefined, '파싱하지 않으므로 re 가 없다');
    assert.equal(codeOf(await client.ping()), 'NOT_JOINED', '연결이 살아 있다');
  }));

  it('6. 오류: 없는 대상 → PEER_NOT_FOUND, 등록 없이 signal·ping → NOT_JOINED, 자기 자신 → BAD_MESSAGE. 모두 요청의 id 를 싣는다', scoped(async (session) => {
    const { members } = await makeRoom(session, 1);
    const [alice] = members;
    const stranger = await session.open();

    const missing = await alice.signalError(freshName('nobody'), undefined, { waitMs: timeoutMs });
    assert.equal(codeOf(missing), 'PEER_NOT_FOUND');
    const self = await alice.signalError(alice.identity.peer, undefined, { waitMs: timeoutMs });
    assert.equal(codeOf(self), 'BAD_MESSAGE');
    const unjoined = await stranger.signalError(alice.identity.peer, undefined, { waitMs: timeoutMs });
    assert.equal(codeOf(unjoined), 'NOT_JOINED');
    assert.equal(codeOf(await stranger.ping()), 'NOT_JOINED');
    await delay(200);
    assert.equal(alice.signals().length, 0, '등록 없는 연결의 signal 이 전달됐다');
    for (const reply of [missing, self, unjoined]) assert.ok(typeof reply.re === 'string' && reply.re.length > 0);
  }));

  it('6. 오류: v 가 99 인 join → UNSUPPORTED_VERSION 과 supported 목록', scoped(async (session) => {
    const client = await session.open();
    client.sendRaw(JSON.stringify({ action: 'join', v: 99, id: 'v99', room: freshRoom(), ...newIdentity(), mode: 'create', seq: 1 }));
    const reply = await client.reply('v99');
    assert.equal(codeOf(reply), 'UNSUPPORTED_VERSION');
    assert.deepEqual(reply.supported, [...LIMITS.SIGNAL_SUPPORTED_VERSIONS]);
    assert.equal(client.isOpen, true);
  }));

  it('6. 오류: relay 후보가 든 signal → RELAY_NOT_ALLOWED 이고 전달되지 않는다', scoped(async (session) => {
    const { members } = await makeRoom(session, 2);
    const [alice, bob] = members;
    const relayLine = 'candidate:9 1 udp 41885439 203.0.113.9 3478 typ relay raddr 198.51.100.7 rport 50001';
    const cid = `${alice.identity.sid}.1`;
    const inCandidate = await alice.signalError(bob.identity.peer, { kind: 'candidate', cid, data: { list: [{ candidate: relayLine, mid: '0' }] } }, { waitMs: timeoutMs });
    assert.equal(codeOf(inCandidate), 'RELAY_NOT_ALLOWED');
    const inSdp = await alice.signalError(bob.identity.peer, { kind: 'offer', cid, data: { sdp: `v=0\r\na=${relayLine}\r\n` } }, { waitMs: timeoutMs });
    assert.equal(codeOf(inSdp), 'RELAY_NOT_ALLOWED');
    await delay(300);
    assert.equal(bob.signals().length, 0);
  }));

  it('6. 오류: 예약 이름, 깨진 JSON, 모르는 action → BAD_MESSAGE. 연결은 유지된다', scoped(async (session) => {
    const client = await session.open();
    for (const [index, name] of ['system', 'Agent-Chat', 'ALL'].entries()) {
      client.sendRaw(JSON.stringify({ action: 'join', v: 1, id: `rsv-${index}`, room: freshRoom(), ...newIdentity(), peer: name, mode: 'create', seq: 1 }));
      assert.equal(codeOf(await client.reply(`rsv-${index}`)), 'BAD_MESSAGE', name);
    }
    client.sendRaw('{"action":"dance","id":"unknown-1"}');
    assert.equal(codeOf(await client.reply('unknown-1')), 'BAD_MESSAGE');

    client.sendRaw('{not json');
    await client.waitFor('BAD_MESSAGE', () => client.errors((message) => message.code === 'BAD_MESSAGE' && message.re === undefined)[0]);

    const joined = await client.join({ room: freshRoom(), ...newIdentity(), mode: 'create' });
    assert.equal(joined.type, 'joined', '잘못된 입력 뒤에도 같은 연결로 입장할 수 있다');
  }));

  it('6. 오류: 바이너리 프레임 → 응답 없이 종료 코드 1003 으로 닫힌다. 다른 연결은 그대로다 (protocol.md 2.1)', scoped(async (session) => {
    const { members } = await makeRoom(session, 2);
    const [host, sender] = members;
    sender.sendRaw(Buffer.from([0, 1, 2, 3]));
    const closed = await sender.waitFor('종료', () => sender.closeInfo, { closeOk: true });
    assert.equal(closed.code, 1003);
    assert.equal(sender.errors().length, 0, '바이너리 프레임에는 오류 응답을 보내지 않는다');
    // 닫힌 연결의 기록은 종료 처리로 지워진다(공용 서버는 $disconnect 가 비동기라 기다린다).
    await until('닫힌 참가자가 목록에서 빠짐', async () => (await host.ping()).members.length === 0, { timeoutMs, pollMs: 200 });
  }));

  it('7. 이름 충돌: 다른 key 로 같은 이름 → NAME_IN_USE. 있던 참가자는 그대로다', scoped(async (session) => {
    const { room, members } = await makeRoom(session, 2);
    const [host, alice] = members;
    const intruder = await session.open();
    const reply = await intruder.join({ room, ...newIdentity(alice.identity.peer), mode: 'join' });
    assert.equal(codeOf(reply), 'NAME_IN_USE');
    assert.equal(intruder.isOpen, true);
    const pong = await host.ping();
    assert.deepEqual(pong.members, [{ peer: alice.identity.peer, sid: alice.identity.sid }]);
    assert.equal(alice.errors().length, 0);
  }));

  it('7. 인계: 같은 key, 더 큰 seq 의 새 연결 → 인계되고 옛 연결이 REPLACED 를 받고 닫힌다', scoped(async (session) => {
    const { room, members } = await makeRoom(session, 2);
    const [host, old] = members;
    const fresh = await session.open();
    const reply = await fresh.join({ room, peer: old.identity.peer, sid: old.identity.sid, key: old.identity.key, mode: 'resume', seq: 2 });
    assert.equal(reply.type, 'joined', `응답: ${codeOf(reply)}`);
    assert.deepEqual(peers(reply), [host.identity.peer]);

    const replaced = await old.waitFor('REPLACED', () => old.errors((message) => message.code === 'REPLACED')[0], { closeOk: true });
    assert.equal(replaced.re, undefined);
    await old.closed({ timeoutMs });

    // 그 이름으로 가는 시그널은 새 연결에 도착한다.
    host.signal(old.identity.peer);
    await fresh.waitFor('인계 뒤의 시그널', () => fresh.signals()[0]);
    assert.equal(old.signals().length, 0);
    assert.equal((await host.ping()).members.length, 1, '인계는 참가자 수를 늘리지 않는다');
  }));

  it('7. 인계: 같은 key, 더 작은 seq 의 join → 기록이 바뀌지 않고 그 연결이 REPLACED 를 받고 닫힌다', scoped(async (session) => {
    const room = freshRoom();
    const identity = newIdentity();
    const host = await session.joined(room, 'create');
    const current = await session.open();
    assert.equal((await current.join({ room, ...identity, mode: 'join', seq: 5 })).type, 'joined');

    const stale = await session.open();
    const reply = await stale.join({ room, ...identity, sid: protocol.newSid(), mode: 'resume', seq: 4, id: 'stale-join' });
    assert.equal(codeOf(reply), 'REPLACED');
    assert.equal(reply.re, 'stale-join');
    await stale.closed({ timeoutMs });

    const pong = await host.ping();
    assert.deepEqual(pong.members, [{ peer: identity.peer, sid: identity.sid }], '기록의 sid 가 그대로다');
    host.signal(identity.peer);
    await current.waitFor('시그널', () => current.signals()[0]);
    assert.equal(current.errors().length, 0, '지금 연결은 아무 오류도 받지 않는다');
    assert.equal(current.isOpen, true);
  }));

  it('8. join 다시 보내기: 등록된 연결이 같은 join 을 다시 보내면 joined 가 다시 온다. 그 사이 다른 참가자가 들어왔어도 ROOM_EXISTS 가 아니다', scoped(async (session) => {
    const room = freshRoom();
    const identity = newIdentity();
    const creator = await session.open();
    const join = { action: 'join', v: 1, id: 'same-join', room, ...identity, mode: 'create', seq: 1 };
    assert.equal((await creator.request(join)).type, 'joined');
    const second = await session.joined(room, 'join');

    creator.send(join);
    await creator.waitFor('두 번째 joined', () => creator.messages.filter((message) => message.type === 'joined' && message.re === 'same-join').length >= 2);
    const again = creator.messages.filter((message) => message.type === 'joined').at(-1);
    assert.deepEqual(again.members, [{ peer: second.identity.peer, sid: second.identity.sid }]);
    assert.equal(creator.errors().length, 0);
  }));

  it('9. 퇴장: leave 뒤 그 참가자에게 보낸 signal → PEER_NOT_FOUND. 목록에서도 빠진다', scoped(async (session) => {
    const { members } = await makeRoom(session, 2);
    const [alice, bob] = members;
    bob.leave();
    const refused = await until('퇴장 반영', async () => {
      const error = await alice.signalError(bob.identity.peer, undefined, { waitMs: 500 });
      return codeOf(error) === 'PEER_NOT_FOUND' ? error : null;
    }, { timeoutMs });
    assert.ok(refused.re);
    assert.deepEqual((await alice.ping()).members, []);
    assert.equal(bob.errors().length, 0, 'leave 에는 응답이 없다');
    assert.equal(codeOf(await bob.ping()), 'NOT_JOINED');
  }));

  it('10. 갑작스러운 종료: 소켓을 강제로 끊은 참가자에게 보낸 signal → PEER_NOT_FOUND (걸린 시간 기록)', scoped(async (session, t) => {
    const { members } = await makeRoom(session, 2);
    const [alice, bob] = members;
    const cutAt = Date.now();
    bob.terminate();
    await until('종료 반영', async () => codeOf(await alice.signalError(bob.identity.peer, undefined, { waitMs: 500 })) === 'PEER_NOT_FOUND', { timeoutMs: LIMITS.PARTICIPANT_STALE_MS + timeoutMs, pollMs: 50 });
    measured.abrupt_close_ms = Date.now() - cutAt;
    t.diagnostic(`소켓을 끊은 뒤 PEER_NOT_FOUND 까지 ${measured.abrupt_close_ms}ms`);
    assert.deepEqual((await alice.ping()).members, []);
  }));

  it(`11. 정원(순차): ${LIMITS.ROOM_MAX_PEERS} 명까지 받고 그 다음 join → ROOM_FULL. 자리가 나면 받는다`, scoped(async (session) => {
    const { room, members } = await makeRoom(session, LIMITS.ROOM_MAX_PEERS);
    const late = await session.open();
    const identity = newIdentity();
    assert.equal(codeOf(await late.join({ room, ...identity, mode: 'join' })), 'ROOM_FULL');
    assert.equal(codeOf(await late.join({ room, ...identity, mode: 'resume' })), 'ROOM_FULL');
    assert.equal((await members[0].ping()).members.length, LIMITS.ROOM_MAX_PEERS - 1, '거절된 쪽의 기록이 남지 않는다');

    await leaveAndClose([members[3]]);
    const reply = await until('자리 남', async () => {
      const attempt = await late.join({ room, ...identity, mode: 'join' });
      return attempt.type === 'joined' ? attempt : null;
    }, { timeoutMs, pollMs: 100 });
    assert.equal(reply.members.length, LIMITS.ROOM_MAX_PEERS - 1);
  }));

  it(`12. 정원(동시): 정원에서 하나 모자란 방에 4개 연결이 동시에 join 해도 통과는 매번 1 이하다 (${rounds}회)`, scoped(async (session, t) => {
    const { room, members } = await makeRoom(session, LIMITS.ROOM_MAX_PEERS - 1);
    let zero = 0;
    for (let round = 0; round < rounds; round += 1) {
      const joiners = await Promise.all([0, 1, 2, 3].map(() => session.open()));
      const replies = await Promise.all(joiners.map((client) => client.join({ room, ...newIdentity(), mode: 'join' })));
      const passed = replies.filter((reply) => reply.type === 'joined').length;
      const full = replies.filter((reply) => codeOf(reply) === 'ROOM_FULL').length;
      assert.ok(passed <= 1, `${round + 1}회차: 통과 ${passed}`);
      assert.equal(passed + full, joiners.length, `${round + 1}회차: joined 도 ROOM_FULL 도 아닌 응답이 있다(${replies.map(codeOf).join(',')})`);
      if (passed === 0) zero += 1;
      await leaveAndClose(joiners);
      // 다음 회차 전에 방이 다시 정원에서 하나 모자란 상태인지 본다.
      await until('방 원상태', async () => (await members[0].ping()).members.length === LIMITS.ROOM_MAX_PEERS - 2, { timeoutMs, pollMs: 50 });
    }
    measured.concurrent_join_zero = zero;
    t.diagnostic(`통과 0 인 회차: ${zero}/${rounds}`);
  }));

  it(`12. 생성(동시): 같은 방 ID 로 4개 연결이 동시에 create 해도 성공은 매번 1 이하다 (${rounds}회)`, scoped(async (session, t) => {
    let zero = 0;
    for (let round = 0; round < rounds; round += 1) {
      const room = freshRoom();
      const creators = await Promise.all([0, 1, 2, 3].map(() => session.open()));
      const replies = await Promise.all(creators.map((client) => client.join({ room, ...newIdentity(), mode: 'create' })));
      const passed = replies.filter((reply) => reply.type === 'joined').length;
      const exists = replies.filter((reply) => codeOf(reply) === 'ROOM_EXISTS').length;
      assert.ok(passed <= 1, `${round + 1}회차: 성공 ${passed}`);
      assert.equal(passed + exists, creators.length, `${round + 1}회차: joined 도 ROOM_EXISTS 도 아닌 응답이 있다(${replies.map(codeOf).join(',')})`);
      if (passed === 0) zero += 1;
      await leaveAndClose(creators);
    }
    measured.concurrent_create_zero = zero;
    t.diagnostic(`성공 0 인 회차: ${zero}/${rounds}`);
  }));

  it('12. 같은 이름(동시): 같은 이름으로 10개 연결이 동시에 join 해도 등록은 하나다', scoped(async (session) => {
    const { room, members } = await makeRoom(session, 1);
    const name = freshName('same');
    const clients = await Promise.all(Array.from({ length: 10 }, () => session.open()));
    const identities = clients.map(() => newIdentity(name));
    const replies = await Promise.all(clients.map((client, index) => client.join({ room, ...identities[index], mode: 'join' })));
    const passed = replies.filter((reply) => reply.type === 'joined');
    assert.equal(passed.length, 1, `응답: ${replies.map(codeOf).join(',')}`);
    assert.equal(replies.filter((reply) => codeOf(reply) === 'NAME_IN_USE').length, 9);
    const winner = identities[replies.findIndex((reply) => reply.type === 'joined')];
    assert.deepEqual((await members[0].ping()).members, [{ peer: name, sid: winner.sid }]);
  }));

  it(`13. 없는 방 반복: 한 연결이 없는 방에 ${LIMITS.JOIN_MISS_MAX}번 join → 마지막에 RATE_LIMITED 뒤 닫힌다`, scoped(async (session) => {
    const client = await session.open();
    const identity = newIdentity();
    const codes = [];
    for (let i = 0; i < LIMITS.JOIN_MISS_MAX; i += 1) {
      const reply = await client.join({ room: freshRoom(), ...identity, mode: 'join' }, { closeOk: false });
      codes.push(codeOf(reply));
    }
    assert.deepEqual(codes, [...Array.from({ length: LIMITS.JOIN_MISS_MAX - 1 }, () => 'ROOM_NOT_FOUND'), 'RATE_LIMITED']);
    await client.closed({ timeoutMs });
  }));

  it(`속도 제한(F-01, F-04): 한 창에 ${LIMITS.RATE_MAX_MESSAGES}건을 넘기면 RATE_LIMITED 를 받고 닫힌다. 다른 연결은 영향받지 않는다`, { skip: skipFlood ? '--no-flood' : false }, scoped(async (session, t) => {
    const { members } = await makeRoom(session, 2);
    const [flooder, witness] = members;
    // 고정 창은 60초 단위로 끊긴다. 창의 경계를 걸치지 않게 시작을 맞춘다.
    const total = LIMITS.RATE_MAX_MESSAGES + 20;
    const needMs = total * Math.max(floodIntervalMs, 1) + 5_000;
    const leftInWindow = () => LIMITS.RATE_WINDOW_MS - (Date.now() % LIMITS.RATE_WINDOW_MS);
    if (leftInWindow() < needMs) await delay(leftInWindow() + 1_500);

    let sent = 0;
    for (; sent < total && flooder.isOpen && flooder.errors((message) => message.code === 'RATE_LIMITED').length === 0; sent += 1) {
      // 절반은 깨진 입력, 절반은 정상 ping 이다. 둘 다 건수에 든다.
      if (sent % 2 === 0) flooder.sendRaw('{broken');
      else flooder.send({ action: 'ping', id: `f${sent}` });
      if (floodIntervalMs > 0) await delay(floodIntervalMs);
    }
    const limited = await flooder.waitFor('RATE_LIMITED', () => flooder.errors((message) => message.code === 'RATE_LIMITED')[0], { closeOk: true, timeoutMs: timeoutMs * 2 });
    assert.ok(Number.isInteger(limited.retry_after_ms) && limited.retry_after_ms > 0 && limited.retry_after_ms <= LIMITS.RATE_WINDOW_MS);
    await flooder.closed({ timeoutMs });

    const answered = flooder.messages.filter((message) => message.type === 'pong' || (message.type === 'error' && message.code === 'BAD_MESSAGE')).length;
    // 입장 때의 join 한 건이 같은 창에 들었을 수 있다.
    assert.ok(answered <= LIMITS.RATE_MAX_MESSAGES && answered >= LIMITS.RATE_MAX_MESSAGES - 1, `한도까지 처리한 건수: ${answered}`);
    t.diagnostic(`처리 ${answered}건 뒤 RATE_LIMITED (보낸 건수 ${sent})`);
    assert.equal((await witness.ping()).type, 'pong', '다른 연결은 그대로다');
    assert.equal(witness.errors().length, 0);
  }));

  it('14. Origin 거절: Origin 헤더를 붙인 핸드셰이크가 실패한다', scoped(async (session) => {
    await assert.rejects(
      openWire(url, { headers: { Origin: 'https://example.com' }, timeoutMs }),
      (error) => {
        measured.origin_status = error.status ?? null;
        return true;
      },
    );
    assert.equal(measured.origin_status, 403, 'HTTP 403 으로 거절해야 한다');
  }));

  it('15. 여분 프레임과 정리: 검증 내내 type 없는 프레임·빈 프레임·스키마에 맞지 않는 프레임이 0건이고, 만든 등록을 모두 leave 로 지우고 닫았다', () => {
    assert.ok(tally.connections > 0, '연결을 하나도 열지 않았다');
    assert.deepEqual(tally.stray, { empty: 0, gateway: 0, unknown: 0, bad: 0, binary: 0 });
    assert.equal(tally.unclosed, 0, '닫히지 않은 연결이 있다');
  });
});
