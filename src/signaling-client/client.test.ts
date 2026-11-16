// V-U10: signaling-client 를 가짜 소켓과 가짜 시계로 본다(대역).
// 서버의 동작은 시험이 만든다. 서버 쪽 규칙의 증거가 아니다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, parseClientMessage } from '../protocol/index.js';
import { defineSubscribableContractTests } from '../protocol/testing.js';
import type {
  MembersUpdate,
  RelayError,
  SignalingClient,
  SignalingJoinFailure,
  SignalingJoinRequest,
  SignalingJoined,
  SignalingStateChange,
} from './contract.js';
import { createSignalingClient } from './index.js';
import { createFakeClock, createFakeSocketHub, createMemoryLog, type FakeSocket } from './testing.js';

const ROOM = 'room0secret0id01';
const KEY = 'K'.repeat(43);
const REQUEST: SignalingJoinRequest = { room: ROOM, peer: 'alice', sid: 'aaaaaaaaaaaa', key: KEY, mode: 'join' };
const BOB = { peer: 'bob', sid: 'bbbbbbbbbbbb' };
const OFFER = { type: 'signal', from: 'bob', sid: 'bbbbbbbbbbbb', kind: 'offer', cid: 'bbbbbbbbbbbb.1', data: { sdp: 'v=0 secret-sdp' } };
const GATEWAY_FRAME = '{"message":"Too Many Requests"}';

type Settled = { ok: true; value: SignalingJoined } | { ok: false; failure: SignalingJoinFailure };

function setup(options: { closeNotifies?: boolean } = {}) {
  const clock = createFakeClock();
  const log = createMemoryLog();
  const hub = createFakeSocketHub(options);
  const control = { random: 0.5 };
  const client = createSignalingClient({
    url: 'ws://signal.test',
    now: clock.now,
    timers: clock.timers,
    log,
    random: () => control.random,
    openSocket: hub.open,
  });
  return { clock, log, hub, control, client };
}
type Ctx = ReturnType<typeof setup>;

function settle(promise: Promise<SignalingJoined>): Promise<Settled> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (failure: SignalingJoinFailure) => ({ ok: false as const, failure }),
  );
}

function lastOf(socket: FakeSocket, action: string): Record<string, unknown> {
  const all = socket.actions(action);
  const last = all[all.length - 1];
  assert.ok(last !== undefined, `${action} 를 보낸 적이 없다`);
  return last;
}

function joinedFrame(re: unknown, members: unknown[] = []): Record<string, unknown> {
  return { type: 'joined', re, members, max_peers: 8, ping_interval_ms: 30_000, stale_after_ms: 90_000 };
}

/** 소켓을 열고 가장 최근 join 에 joined 로 답한다. */
function accept(socket: FakeSocket, members: unknown[] = []): void {
  socket.open();
  socket.receive(joinedFrame(lastOf(socket, 'join')['id'], members));
}

/** join 을 끝낸(등록된) 클라이언트. */
async function online(ctx: Ctx, members: unknown[] = []): Promise<{ socket: FakeSocket; joined: SignalingJoined }> {
  const pending = ctx.client.join(REQUEST);
  const socket = ctx.hub.last();
  accept(socket, members);
  return { socket, joined: await pending };
}

function onlineSync(ctx: Ctx): FakeSocket {
  void settle(ctx.client.join(REQUEST));
  const socket = ctx.hub.last();
  accept(socket);
  return socket;
}

function collect(client: SignalingClient) {
  const seen = {
    signals: [] as unknown[],
    members: [] as MembersUpdate[],
    relayErrors: [] as RelayError[],
    gatewayFrames: 0,
    states: [] as SignalingStateChange[],
  };
  client.on('signal', (signal) => seen.signals.push(signal));
  client.on('members', (update) => seen.members.push(update));
  client.on('relay-error', (error) => seen.relayErrors.push(error));
  client.on('gateway-frame', () => {
    seen.gatewayFrames += 1;
  });
  client.on('state', (change) => seen.states.push(change));
  return seen;
}

/** 등록된 연결에서 ping 을 한 번 놓치게 한다(pong 기한을 넘긴다). */
function missPingByTimeout(ctx: Ctx): void {
  ctx.clock.advance(LIMITS.SIGNAL_PONG_TIMEOUT_MS);
}

describe('V-U10 signaling-client: 등록', () => {
  it('join 은 접속한 뒤 v·id·seq 를 붙인 join 을 보내고 joined 로 resolve 한다', async () => {
    const ctx = setup();
    const before = ctx.clock.now();
    const pending = ctx.client.join(REQUEST);
    const socket = ctx.hub.last();
    assert.equal(socket.url, 'ws://signal.test');
    assert.deepEqual(socket.sent, [], '열리기 전에는 보내지 않는다');
    socket.open();
    const join = lastOf(socket, 'join');
    assert.deepEqual(
      { ...join, id: 'x' },
      { action: 'join', v: 1, id: 'x', room: ROOM, peer: 'alice', sid: 'aaaaaaaaaaaa', key: KEY, mode: 'join', seq: 1 },
    );
    assert.ok(parseClientMessage(socket.sent[0] ?? '').ok, '서버의 스키마를 통과하는 글이다');
    socket.receive(joinedFrame(join['id'], [BOB]));
    const joined = await pending;
    assert.deepEqual(joined.members, [BOB]);
    assert.equal(joined.requestedAt, before);
  });

  it('접속 URL 에 방 ID·이름·key 를 싣지 않는다', () => {
    const ctx = setup();
    void settle(ctx.client.join(REQUEST));
    const url = ctx.hub.last().url;
    for (const secret of [ROOM, 'alice', KEY]) assert.equal(url.includes(secret), false);
  });

  it('joined 전에도 signal 이벤트가 나온다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const pending = ctx.client.join(REQUEST);
    const socket = ctx.hub.last();
    socket.open();
    socket.receive(OFFER);
    assert.equal(seen.signals.length, 1, 'joined 를 기다리지 않는다');
    assert.deepEqual(seen.signals[0], OFFER);
    socket.receive(joinedFrame(lastOf(socket, 'join')['id']));
    await pending;
    socket.receive({ ...OFFER, kind: 'candidate', data: { list: [{ candidate: 'a=candidate:1 1 UDP 1 10.0.0.1 1 typ host', mid: '0' }] } });
    assert.equal(seen.signals.length, 2);
  });

  it('첫 joined 는 connected 상태를 한 번 내고, 목록은 join 의 결과로만 준다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    await online(ctx, [BOB]);
    assert.deepEqual(seen.states, [{ state: 'connected', reason: null }]);
    assert.deepEqual(seen.members, []);
  });

  it('다른 re 의 joined 는 응답으로 치지 않는다', async () => {
    const ctx = setup();
    const pending = settle(ctx.client.join(REQUEST));
    const socket = ctx.hub.last();
    socket.open();
    socket.receive(joinedFrame('someone-else'));
    ctx.clock.advance(LIMITS.SIGNAL_REQUEST_TIMEOUT_MS);
    const result = await pending;
    assert.deepEqual(result, { ok: false, failure: { code: 'SERVER_UNREACHABLE' } });
  });

  it('서버가 거절하면 그 오류 코드로 reject 하고 소켓을 닫는다. 재접속하지 않는다', async () => {
    for (const code of ['ROOM_NOT_FOUND', 'ROOM_EXISTS', 'ROOM_FULL', 'NAME_IN_USE', 'BAD_MESSAGE', 'REPLACED'] as const) {
      const ctx = setup();
      const seen = collect(ctx.client);
      const pending = settle(ctx.client.join(REQUEST));
      const socket = ctx.hub.last();
      socket.open();
      socket.receive({ type: 'error', code, message: 'no', re: lastOf(socket, 'join')['id'] });
      assert.deepEqual(await pending, { ok: false, failure: { code } }, code);
      assert.equal(socket.closedByClient, true, code);
      ctx.clock.advance(120_000);
      assert.equal(ctx.hub.sockets.length, 1, `${code}: 다시 접속하지 않는다`);
      assert.equal(ctx.clock.pending(), 0, `${code}: 타이머가 남지 않는다`);
      assert.deepEqual(seen.states, [], `${code}: 실패한 join 은 상태 이벤트를 내지 않는다`);
    }
  });

  it('RATE_LIMITED 의 retry_after_ms 와 UNSUPPORTED_VERSION 의 supported 를 함께 준다', async () => {
    const limited = setup();
    const first = settle(limited.client.join(REQUEST));
    limited.hub.last().open();
    limited.hub.last().receive({ type: 'error', code: 'RATE_LIMITED', message: 'slow down', retry_after_ms: 7000 });
    assert.deepEqual(await first, { ok: false, failure: { code: 'RATE_LIMITED', retryAfterMs: 7000 } });

    const version = setup();
    const second = settle(version.client.join(REQUEST));
    const socket = version.hub.last();
    socket.open();
    socket.receive({ type: 'error', code: 'UNSUPPORTED_VERSION', message: 'v', re: lastOf(socket, 'join')['id'], supported: [2, 3] });
    assert.deepEqual(await second, { ok: false, failure: { code: 'UNSUPPORTED_VERSION', supported: [2, 3] } });
  });

  it('접속 기한 안에 열리지 않으면 SERVER_UNREACHABLE', async () => {
    const ctx = setup();
    const pending = settle(ctx.client.join(REQUEST));
    ctx.clock.advance(LIMITS.SIGNAL_CONNECT_TIMEOUT_MS - 1);
    assert.equal(ctx.hub.last().closedByClient, false);
    ctx.clock.advance(1);
    assert.deepEqual(await pending, { ok: false, failure: { code: 'SERVER_UNREACHABLE' } });
    assert.equal(ctx.hub.last().closedByClient, true);
    assert.equal(ctx.clock.pending(), 0);
  });

  it('답 전에 끊기면 SERVER_UNREACHABLE. 접속에 실패한 경우도 같다', async () => {
    const refused = setup();
    const first = settle(refused.client.join(REQUEST));
    refused.hub.last().drop();
    assert.deepEqual(await first, { ok: false, failure: { code: 'SERVER_UNREACHABLE' } });

    const cut = setup();
    const second = settle(cut.client.join(REQUEST));
    cut.hub.last().open();
    cut.hub.last().drop();
    assert.deepEqual(await second, { ok: false, failure: { code: 'SERVER_UNREACHABLE' } });
    cut.clock.advance(120_000);
    assert.equal(cut.hub.sockets.length, 1);
  });

  it('형식이 틀린 요청은 접속하지 않고 BAD_MESSAGE 로 reject 한다', async () => {
    const ctx = setup();
    const result = await settle(ctx.client.join({ ...REQUEST, room: 'BAD ROOM' }));
    assert.deepEqual(result, { ok: false, failure: { code: 'BAD_MESSAGE' } });
    assert.equal(ctx.hub.sockets.length, 0);
  });

  it('join 을 두 번 부르면 두 번째는 CLOSED 로 reject 한다', async () => {
    const ctx = setup();
    await online(ctx);
    assert.deepEqual(await settle(ctx.client.join(REQUEST)), { ok: false, failure: { code: 'CLOSED' } });
    assert.equal(ctx.hub.sockets.length, 1);
  });

  it('기다리는 중에 close() 나 leave() 를 부르면 CLOSED', async () => {
    const closed = setup();
    const first = settle(closed.client.join(REQUEST));
    closed.hub.last().open();
    closed.client.close();
    assert.deepEqual(await first, { ok: false, failure: { code: 'CLOSED' } });

    const left = setup();
    const second = settle(left.client.join(REQUEST));
    left.hub.last().open();
    await left.client.leave();
    assert.deepEqual(await second, { ok: false, failure: { code: 'CLOSED' } });
    assert.equal(left.hub.last().actions('leave').length, 0, '등록 전에는 leave 를 보내지 않는다');
    assert.equal(left.hub.last().closedByClient, true);
  });
});

describe('V-U10 signaling-client: join 다시 보내기', () => {
  it('응답이 사라지면 같은 id 의 join 을 같은 연결에 다시 보낸다', async () => {
    const ctx = setup();
    const pending = ctx.client.join(REQUEST);
    const socket = ctx.hub.last();
    socket.open();
    assert.equal(socket.actions('join').length, 1);
    ctx.clock.advance(LIMITS.SIGNAL_RESEND_MS);
    assert.equal(socket.actions('join').length, 2);
    assert.equal(socket.sent[1], socket.sent[0], '같은 id, 같은 seq 의 같은 글이다');
    const resentAt = ctx.clock.now();
    socket.receive(joinedFrame(lastOf(socket, 'join')['id']));
    const joined = await pending;
    assert.equal(joined.requestedAt, resentAt, '목록을 요청한 시각은 마지막으로 보낸 때다');
    assert.equal(ctx.hub.sockets.length, 1);
    ctx.clock.advance(LIMITS.SIGNAL_RESEND_MS * 3);
    assert.equal(socket.actions('join').length, 2, '등록된 뒤에는 다시 보내지 않는다');
  });

  it('SERVER_ERROR 면 같은 연결에 같은 join 을 다시 보내고, 기한까지 풀리지 않으면 SERVER_ERROR 로 reject 한다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const pending = settle(ctx.client.join(REQUEST));
    const socket = ctx.hub.last();
    socket.open();
    const id = lastOf(socket, 'join')['id'];
    socket.receive({ type: 'error', code: 'SERVER_ERROR', message: 'oops', re: id });
    assert.equal(socket.actions('join').length, 1, '바로 보내지 않는다');
    ctx.clock.advance(LIMITS.GATEWAY_JOIN_RETRY_MIN_MS);
    assert.equal(socket.actions('join').length, 2);
    assert.equal(lastOf(socket, 'join')['id'], id);
    assert.equal(ctx.hub.sockets.length, 1, '같은 연결이다');
    ctx.clock.advance(LIMITS.SIGNAL_REQUEST_TIMEOUT_MS);
    assert.deepEqual(await pending, { ok: false, failure: { code: 'SERVER_ERROR' } });
    assert.equal(socket.closedByClient, true);
  });

  it('SERVER_ERROR 뒤 다시 보낸 join 에 joined 가 오면 성공한다', async () => {
    const ctx = setup();
    const pending = ctx.client.join(REQUEST);
    const socket = ctx.hub.last();
    socket.open();
    const id = lastOf(socket, 'join')['id'];
    socket.receive({ type: 'error', code: 'SERVER_ERROR', message: 'oops', re: id });
    ctx.clock.advance(LIMITS.GATEWAY_JOIN_RETRY_MAX_MS);
    socket.receive(joinedFrame(id, [BOB]));
    assert.deepEqual((await pending).members, [BOB]);
  });

  it('게이트웨이 프레임을 받으면 1~2초 뒤 같은 join 을 같은 연결에 다시 보낸다. 요청 기한까지만 한다', async () => {
    const ctx = setup();
    ctx.control.random = 0.5;
    const seen = collect(ctx.client);
    const pending = settle(ctx.client.join(REQUEST));
    const socket = ctx.hub.last();
    socket.open();
    const first = socket.sent[0];
    socket.receive(GATEWAY_FRAME);
    assert.equal(seen.gatewayFrames, 1);
    ctx.clock.advance(1499);
    assert.equal(socket.actions('join').length, 1);
    ctx.clock.advance(1);
    assert.equal(socket.actions('join').length, 2);
    assert.equal(socket.sent[1], first);

    // 프레임이 계속 와도 기한을 넘겨 보내지 않는다.
    for (let elapsed = 1500; elapsed < LIMITS.SIGNAL_REQUEST_TIMEOUT_MS; elapsed += 500) {
      socket.receive(GATEWAY_FRAME);
      ctx.clock.advance(500);
    }
    const sentByDeadline = socket.actions('join').length;
    assert.deepEqual(await pending, { ok: false, failure: { code: 'SERVER_UNREACHABLE' } });
    ctx.clock.advance(60_000);
    assert.equal(socket.actions('join').length, sentByDeadline);
    assert.equal(ctx.hub.sockets.length, 1);
  });

  it('무작위 값에 따라 게이트웨이 재전송 대기가 1초에서 2초 사이로 정해진다', () => {
    for (const [random, delay] of [[0, 1000], [0.999, 1999]] as const) {
      const ctx = setup();
      ctx.control.random = random;
      void settle(ctx.client.join(REQUEST));
      const socket = ctx.hub.last();
      socket.open();
      socket.receive(GATEWAY_FRAME);
      ctx.clock.advance(delay - 1);
      assert.equal(socket.actions('join').length, 1, `random=${random}`);
      ctx.clock.advance(1);
      assert.equal(socket.actions('join').length, 2, `random=${random}`);
    }
  });
});

describe('V-U10 signaling-client: ping 과 놓침', () => {
  it('등록된 동안 30초마다 ping 을 보내고, 같은 re 의 pong 으로 목록과 요청 시각을 낸다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS - 1);
    assert.equal(socket.actions('ping').length, 0);
    ctx.clock.advance(1);
    assert.equal(socket.actions('ping').length, 1);
    const sentAt = ctx.clock.now();
    ctx.clock.advance(40);
    socket.receive({ type: 'pong', re: lastOf(socket, 'ping')['id'], members: [BOB] });
    assert.deepEqual(seen.members, [{ members: [BOB], requestedAt: sentAt, source: 'pong' }]);

    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS - 41);
    assert.equal(socket.actions('ping').length, 1);
    ctx.clock.advance(1);
    assert.equal(socket.actions('ping').length, 2, '앞 ping 을 보낸 때부터 30초 뒤다');
    assert.notEqual(socket.actions('ping')[1]?.['id'], socket.actions('ping')[0]?.['id'], '요청마다 새 id 다');
  });

  it('다른 re 의 pong 과 다른 수신 활동은 응답으로 치지 않는다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    socket.receive({ type: 'pong', re: 'not-mine', members: [BOB] });
    socket.receive(OFFER);
    assert.deepEqual(seen.members, []);
    ctx.clock.advance(LIMITS.SIGNAL_PONG_TIMEOUT_MS);
    assert.equal(ctx.log.named('signal.ping_miss').length, 1);
  });

  it('1~2회 놓쳐서는 재접속하지 않고 5초 뒤 다시 보낸다. pong 을 받으면 횟수가 0 으로 돌아간다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    missPingByTimeout(ctx);
    assert.equal(socket.actions('ping').length, 1);
    ctx.clock.advance(LIMITS.SIGNAL_PING_RETRY_MS);
    assert.equal(socket.actions('ping').length, 2);
    missPingByTimeout(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_RETRY_MS);
    assert.equal(socket.actions('ping').length, 3);
    assert.equal(ctx.hub.sockets.length, 1, '두 번 놓쳐서는 연결을 버리지 않는다');
    assert.equal(socket.closedByClient, false);
    assert.deepEqual(seen.states, [{ state: 'connected', reason: null }]);

    socket.receive({ type: 'pong', re: lastOf(socket, 'ping')['id'], members: [] });
    // 횟수가 돌아갔으므로 다시 두 번 놓쳐도 버리지 않는다.
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    missPingByTimeout(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_RETRY_MS);
    missPingByTimeout(ctx);
    assert.equal(socket.closedByClient, false);
    assert.deepEqual(ctx.log.named('signal.ping_miss').map((entry) => entry.fields.misses), [1, 2, 1, 2]);
  });

  it('연속 3회 놓치면 연결을 버리고 재접속한다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    missPingByTimeout(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_RETRY_MS);
    missPingByTimeout(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_RETRY_MS);
    assert.equal(socket.closedByClient, false);
    missPingByTimeout(ctx);
    assert.equal(socket.closedByClient, true);
    assert.deepEqual(seen.states, [
      { state: 'connected', reason: null },
      { state: 'reconnecting', reason: null },
    ]);
    ctx.clock.advance(0);
    assert.equal(ctx.hub.sockets.length, 2, '새 소켓으로 다시 붙는다');
    // 죽은 연결을 아는 데 걸린 시간: 30 + 10 + 5 + 10 + 5 + 10 = 70초
    assert.equal(socket.actions('ping').length, 3);
  });

  it('ping 의 SERVER_ERROR 는 놓친 것으로 센다', async () => {
    const ctx = setup();
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    socket.receive({ type: 'error', code: 'SERVER_ERROR', message: 'x', re: lastOf(socket, 'ping')['id'] });
    assert.deepEqual(ctx.log.named('signal.ping_miss').map((entry) => entry.fields.misses), [1]);
    assert.equal(socket.closedByClient, false);
    ctx.clock.advance(LIMITS.SIGNAL_PING_RETRY_MS);
    assert.equal(socket.actions('ping').length, 2);
  });

  it('ping 응답을 기다리는 중의 게이트웨이 프레임은 놓친 것으로 세고 연결을 버리지 않는다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    socket.receive(GATEWAY_FRAME);
    assert.deepEqual(ctx.log.named('signal.ping_miss').map((entry) => entry.fields.misses), [1]);
    assert.equal(seen.gatewayFrames, 1);
    assert.equal(socket.closedByClient, false);
    assert.equal(ctx.hub.sockets.length, 1);
    ctx.clock.advance(LIMITS.SIGNAL_PING_RETRY_MS);
    assert.equal(socket.actions('ping').length, 2, '5초 뒤 다시 보낸다');
  });

  it('기다리는 요청이 없을 때의 게이트웨이 프레임은 이벤트만 낸다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    socket.receive(GATEWAY_FRAME);
    socket.receive('not json at all');
    assert.equal(seen.gatewayFrames, 2);
    assert.equal(ctx.log.named('signal.ping_miss').length, 0);
    assert.equal(socket.sent.length, 1, '다시 보낸 것이 없다');
  });

  it('길이 0 인 프레임, 모르는 type, 스키마에 맞지 않는 프레임은 무시하고 건수만 남긴다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    socket.receive('');
    socket.receive({ type: 'future-thing', anything: 1 });
    socket.receive({ type: 'pong', re: 'bad re!', members: 'nope' });
    assert.equal(seen.gatewayFrames, 0);
    assert.deepEqual(seen.signals, []);
    assert.deepEqual(seen.members, []);
    assert.equal(socket.closedByClient, false);
    const counted = ctx.log.events.filter((entry) => entry.fields.dup_ignored === 1);
    assert.equal(counted.length, 3);
  });
});

describe('V-U10 signaling-client: 재접속', () => {
  it('끊기면 reconnecting 을 내고 join(mode=resume, 같은 peer·sid·key) 을 보낸다. 접속 순번이 커진다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket: first } = await online(ctx);
    assert.equal(lastOf(first, 'join')['seq'], 1);

    first.drop();
    assert.deepEqual(seen.states.at(-1), { state: 'reconnecting', reason: null });
    ctx.clock.advance(0);
    const second = ctx.hub.last();
    assert.notEqual(second, first);
    second.open();
    const resume = lastOf(second, 'join');
    assert.deepEqual(
      { ...resume, id: 'x' },
      { action: 'join', v: 1, id: 'x', room: ROOM, peer: 'alice', sid: 'aaaaaaaaaaaa', key: KEY, mode: 'resume', seq: 2 },
    );
    assert.notEqual(resume['id'], lastOf(first, 'join')['id'], '새 요청이라 id 가 다르다');
    const requestedAt = ctx.clock.now();
    second.receive(joinedFrame(resume['id'], [BOB]));
    assert.deepEqual(seen.states.at(-1), { state: 'connected', reason: null });
    assert.deepEqual(seen.members, [{ members: [BOB], requestedAt, source: 'joined' }]);

    second.drop();
    ctx.clock.advance(0);
    const third = ctx.hub.last();
    third.open();
    assert.equal(lastOf(third, 'join')['seq'], 3);
    assert.equal(lastOf(third, 'join')['mode'], 'resume');
  });

  it('nextSeq 를 받으면 새 소켓마다 그 값을 접속 순번으로 쓴다. 같은 소켓의 다시 보내기에는 부르지 않는다', async () => {
    const clock = createFakeClock();
    const hub = createFakeSocketHub();
    // 같은 프로세스의 앞선 입장이 7까지 썼다고 친다.
    let processSeq = 7;
    let calls = 0;
    const client = createSignalingClient({
      url: 'ws://signal.test',
      now: clock.now,
      timers: clock.timers,
      log: createMemoryLog(),
      random: () => 0,
      openSocket: hub.open,
      nextSeq: () => {
        calls += 1;
        processSeq += 1;
        return processSeq;
      },
    });
    const pending = settle(client.join(REQUEST));
    const first = hub.last();
    first.open();
    assert.equal(lastOf(first, 'join')['seq'], 8);
    // 응답이 사라져 같은 소켓에 다시 보낸 join 은 같은 순번이다.
    clock.advance(3_000);
    assert.deepEqual(first.actions('join').map((join) => join['seq']), [8, 8]);
    assert.equal(calls, 1);
    first.receive(joinedFrame(lastOf(first, 'join')['id']));
    assert.equal((await pending).ok, true);

    first.drop();
    clock.advance(0);
    const second = hub.last();
    second.open();
    assert.equal(lastOf(second, 'join')['seq'], 9);
    assert.equal(calls, 2);
    client.close();
  });

  it('재접속 대기는 1초부터 2배로 늘고 상한이 30초이며 전 구간 무작위다', async () => {
    const ctx = setup();
    ctx.control.random = 0.999999;
    const { socket } = await online(ctx);
    socket.drop();
    const caps = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const cap of caps) {
      const before = ctx.hub.sockets.length;
      ctx.clock.advance(cap - 2);
      assert.equal(ctx.hub.sockets.length, before, `상한 ${cap}ms 직전에는 접속하지 않는다`);
      ctx.clock.advance(2);
      assert.equal(ctx.hub.sockets.length, before + 1, `상한 ${cap}ms 안에 접속한다`);
      ctx.hub.last().drop();
    }
    const backoffs = ctx.log.named('signal.state').map((entry) => entry.fields.backoff_ms).filter((value) => value !== undefined);
    assert.deepEqual(backoffs, [999, 1999, 3999, 7999, 15999, 29999, 29999, 29999]);

    // 무작위 값이 0 이면 바로 붙는다(full jitter 의 아래 끝).
    ctx.control.random = 0;
    const before = ctx.hub.sockets.length;
    ctx.clock.advance(30_000);
    ctx.hub.last().drop();
    ctx.clock.advance(0);
    assert.equal(ctx.hub.sockets.length, before + 2);
  });

  it('다시 등록되면 대기가 1초부터 다시 시작한다', async () => {
    const ctx = setup();
    ctx.control.random = 0.999999;
    const { socket } = await online(ctx);
    socket.drop();
    ctx.clock.advance(1000);
    ctx.hub.last().drop();
    ctx.clock.advance(2000);
    accept(ctx.hub.last());
    const before = ctx.hub.sockets.length;
    ctx.hub.last().drop();
    ctx.clock.advance(1000);
    assert.equal(ctx.hub.sockets.length, before + 1);
  });

  it('재접속 중 접속 기한과 요청 기한을 넘기면 그 소켓을 버리고 다시 시도한다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    socket.drop();
    ctx.clock.advance(0);
    const second = ctx.hub.last();
    ctx.clock.advance(LIMITS.SIGNAL_CONNECT_TIMEOUT_MS);
    assert.equal(second.closedByClient, true, '접속 기한');
    ctx.clock.advance(0);
    const third = ctx.hub.last();
    assert.notEqual(third, second);
    third.open();
    ctx.clock.advance(LIMITS.SIGNAL_REQUEST_TIMEOUT_MS);
    assert.equal(third.closedByClient, true, '요청 기한');
    assert.equal(third.actions('join').length, 4, '기한까지 3초마다 같은 join 을 다시 보냈다');
    ctx.clock.advance(0);
    assert.equal(ctx.hub.sockets.length, 4);
    assert.deepEqual(seen.states.at(-1), { state: 'reconnecting', reason: null });
    assert.equal(seen.states.length, 2, '같은 상태를 되풀이해 내지 않는다');
  });

  it('재접속 중 ROOM_FULL·NAME_IN_USE 에 멈추지 않고 상한 간격으로 계속 시도한다. 이유는 한 번만 알린다', async () => {
    for (const code of ['ROOM_FULL', 'NAME_IN_USE'] as const) {
      const ctx = setup();
      ctx.control.random = 0;
      const seen = collect(ctx.client);
      const { socket } = await online(ctx);
      socket.drop();
      ctx.clock.advance(0);

      for (let round = 0; round < 3; round += 1) {
        const current = ctx.hub.last();
        current.open();
        current.receive({ type: 'error', code, message: 'taken', re: lastOf(current, 'join')['id'] });
        assert.equal(current.closedByClient, true, `${code}: 거절된 소켓은 닫는다`);
        const before = ctx.hub.sockets.length;
        ctx.clock.advance(LIMITS.RECONNECT_BACKOFF_MAX_MS - 1);
        assert.equal(ctx.hub.sockets.length, before, `${code}: 상한 간격보다 먼저 시도하지 않는다`);
        ctx.clock.advance(1);
        assert.equal(ctx.hub.sockets.length, before + 1, `${code}: 멈추지 않는다`);
      }
      assert.deepEqual(seen.states, [
        { state: 'connected', reason: null },
        { state: 'reconnecting', reason: null },
        { state: 'reconnecting', reason: code },
      ]);

      // 자리가 나면 다시 붙고 이유가 사라진다.
      const freed = ctx.hub.last();
      freed.open();
      assert.equal(lastOf(freed, 'join')['seq'], 5, `${code}: 새 연결마다 순번이 오른다`);
      freed.receive(joinedFrame(lastOf(freed, 'join')['id']));
      assert.deepEqual(seen.states.at(-1), { state: 'connected', reason: null });
    }
  });

  it('재접속 중 UNSUPPORTED_VERSION 이면 detached 로 멈춘다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    socket.drop();
    ctx.clock.advance(0);
    const second = ctx.hub.last();
    second.open();
    second.receive({ type: 'error', code: 'UNSUPPORTED_VERSION', message: 'v', re: lastOf(second, 'join')['id'], supported: [2] });
    assert.deepEqual(seen.states.at(-1), { state: 'detached', reason: 'UNSUPPORTED_VERSION' });
    assert.equal(second.closedByClient, true);
    ctx.clock.advance(600_000);
    assert.equal(ctx.hub.sockets.length, 2, '다시 접속하지 않는다');
    assert.equal(ctx.clock.pending(), 0);
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), false);
  });

  it('재접속 중의 SERVER_ERROR 와 게이트웨이 프레임은 같은 연결에 같은 join 을 다시 보낸다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const { socket } = await online(ctx);
    socket.drop();
    ctx.clock.advance(0);
    const second = ctx.hub.last();
    second.open();
    const id = lastOf(second, 'join')['id'];
    second.receive({ type: 'error', code: 'SERVER_ERROR', message: 'x', re: id });
    ctx.clock.advance(1000);
    second.receive(GATEWAY_FRAME);
    ctx.clock.advance(1000);
    assert.deepEqual(second.actions('join').map((join) => [join['id'], join['seq']]), [[id, 2], [id, 2], [id, 2]]);
    assert.equal(ctx.hub.sockets.length, 2);
  });

  it('지금 쓰는 소켓의 REPLACED 는 끊김과 똑같이 다뤄 재접속한다. 치명이 아니다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    socket.receive({ type: 'error', code: 'REPLACED', message: 'newer connection' });
    assert.equal(socket.closedByClient, true);
    assert.deepEqual(seen.states.at(-1), { state: 'reconnecting', reason: null });
    ctx.clock.advance(0);
    const second = ctx.hub.last();
    accept(second);
    assert.equal(lastOf(second, 'join')['mode'], 'resume');
    assert.deepEqual(seen.states.at(-1), { state: 'connected', reason: null });
  });

  it('이미 버린 소켓의 REPLACED 와 늦은 이벤트는 무시한다', async () => {
    const ctx = setup({ closeNotifies: false });
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket: first } = await online(ctx);
    // 3회 놓쳐 버린 소켓. 서버 쪽에서는 아직 닫히지 않았다.
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    for (let miss = 0; miss < 3; miss += 1) {
      missPingByTimeout(ctx);
      ctx.clock.advance(miss < 2 ? LIMITS.SIGNAL_PING_RETRY_MS : 0);
    }
    assert.equal(first.closedByClient, true);
    const second = ctx.hub.last();
    assert.notEqual(second, first);
    accept(second);
    const statesBefore = seen.states.length;

    first.receive({ type: 'error', code: 'REPLACED', message: 'old' });
    first.receive(OFFER);
    first.receive(GATEWAY_FRAME);
    first.drop();
    ctx.clock.advance(60_000);
    assert.equal(seen.states.length, statesBefore, '상태가 바뀌지 않는다');
    assert.deepEqual(seen.signals, []);
    assert.equal(seen.gatewayFrames, 0);
    assert.equal(ctx.hub.sockets.length, 2, '새 소켓을 버리지 않는다');
    assert.equal(second.closedByClient, false);
  });

  it('등록된 뒤의 RATE_LIMITED 는 retry_after_ms 뒤에 재접속한다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const { socket } = await online(ctx);
    socket.receive({ type: 'error', code: 'RATE_LIMITED', message: 'slow', retry_after_ms: 12_000 });
    assert.equal(socket.closedByClient, true);
    ctx.clock.advance(11_999);
    assert.equal(ctx.hub.sockets.length, 1);
    ctx.clock.advance(1);
    assert.equal(ctx.hub.sockets.length, 2);
  });

  it('signal 의 NOT_JOINED 면(등록이 없다) 같은 연결에 join(mode=resume) 을 다시 보낸다. 또 받으면 연결을 버린다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), true);
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'who', re: lastOf(socket, 'signal')['id'] });
    assert.equal(socket.closedByClient, false, '연결은 그대로다');
    const resume = lastOf(socket, 'join');
    assert.equal(resume['mode'], 'resume');
    assert.equal(resume['seq'], 1, '같은 연결이라 순번이 그대로다');
    assert.deepEqual(seen.states.at(-1), { state: 'reconnecting', reason: null });
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), false, '등록될 때까지 보내지 않는다');

    socket.receive(joinedFrame(resume['id'], [BOB]));
    assert.deepEqual(seen.states.at(-1), { state: 'connected', reason: null });
    assert.equal(seen.members.at(-1)?.source, 'joined');
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), true);

    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'again', re: lastOf(socket, 'signal')['id'] });
    assert.equal(socket.closedByClient, true, '같은 연결에서 두 번째면 버린다');
    ctx.clock.advance(0);
    assert.equal(ctx.hub.sockets.length, 2);
  });

  it('(검토 1차 CONNECT-R1-02) 다시 등록하기 전에 보낸 signal 의 NOT_JOINED 가 늦게 와도 등록된 연결을 버리지 않는다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    // 서버에서 등록이 사라진 동안 signal 두 건이 나갔다.
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), true);
    const sigA = lastOf(socket, 'signal')['id'];
    const candidate = { candidate: 'a=candidate:1 1 UDP 2114977791 192.0.2.1 5000 typ host', mid: '0' };
    assert.equal(ctx.client.sendSignal('bob', { kind: 'candidate', cid: 'aaaaaaaaaaaa.1', data: { list: [candidate] } }), true);
    const sigB = lastOf(socket, 'signal')['id'];
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'who', re: sigA });
    const resume = lastOf(socket, 'join');
    socket.receive(joinedFrame(resume['id'], [BOB]));
    assert.deepEqual(seen.states.map((change) => change.state), ['connected', 'reconnecting', 'connected']);

    // 공용 서버는 메시지마다 다른 실행이 처리해 응답 순서가 바뀐다. 등록 전에 처리된 sigB 의 NOT_JOINED 가 늦게 온다.
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'late', re: sigB });
    assert.equal(socket.closedByClient, false, '모르는 요청(재등록 전의 signal)의 NOT_JOINED 는 버린다');
    assert.deepEqual(seen.states.map((change) => change.state), ['connected', 'reconnecting', 'connected']);
    assert.equal(ctx.hub.sockets.length, 1);
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), true, '계속 보낸다');
    assert.equal(ctx.log.named('signal.error').some((entry) => entry.fields.reason === 'stale_not_joined'), true, '로그는 남긴다');

    // 재등록 뒤에 보낸 요청의 NOT_JOINED 는 지금처럼 연결을 버린다.
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'again', re: lastOf(socket, 'signal')['id'] });
    assert.equal(socket.closedByClient, true);
  });

  it('(검토 1차 CONNECT-R1-02) re 가 없는 NOT_JOINED 와 지금 ping 의 NOT_JOINED 는 처리한다. 버린 ping 의 늦은 NOT_JOINED 는 버린다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    const oldPing = lastOf(socket, 'ping')['id'];
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'no re' });
    const resume = lastOf(socket, 'join');
    assert.equal(resume['mode'], 'resume', 're 가 없어도 다시 등록한다');
    socket.receive(joinedFrame(resume['id']));
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'old ping', re: oldPing });
    assert.equal(socket.closedByClient, false, '재등록 전에 보낸 ping 의 NOT_JOINED 는 버린다');
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    const ping = lastOf(socket, 'ping')['id'];
    assert.notEqual(ping, oldPing);
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'ping', re: ping });
    assert.equal(socket.closedByClient, true, '지금 ping 의 NOT_JOINED 는 새 연결로 다시 등록한다');
  });

  it('(검토 2차 CONNECT-R2-01) ping 의 NOT_JOINED 는 같은 연결에 다시 등록하지 않고 곧바로 새 연결로 다시 등록한다. 그때까지 connected 라고 알리지 않는다', async () => {
    const ctx = setup();
    ctx.control.random = 0.5;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    const joinsBefore = socket.actions('join').length;
    // 서버의 참가자 기록이 오래됐다(멈췄다 깨어난 프로세스). 이 연결의 등록은 남아 있어 같은 연결의 join 은 판정 없이 joined 만 다시 받는다.
    socket.receive({ type: 'error', code: 'NOT_JOINED', message: 'stale', re: lastOf(socket, 'ping')['id'] });
    assert.equal(socket.actions('join').length, joinsBefore, '같은 연결에 join 을 다시 보내지 않는다');
    assert.equal(socket.closedByClient, true, '그 연결을 버린다');
    assert.deepEqual(seen.states.at(-1), { state: 'reconnecting', reason: null });
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), false, '등록될 때까지 보내지 않는다');

    // 재접속 대기는 첫 회의 상한(RECONNECT_BACKOFF_BASE_MS) 안이다. 다음 ping 주기(30초)를 기다리지 않는다.
    ctx.clock.advance(LIMITS.RECONNECT_BACKOFF_BASE_MS);
    assert.equal(ctx.hub.sockets.length, 2, '새 연결을 연다');
    const next = ctx.hub.last();
    next.open();
    const resume = lastOf(next, 'join');
    assert.equal(resume['mode'], 'resume');
    assert.equal(resume['seq'], 2, '새 연결이라 순번이 오른다(서버가 다시 판정한다)');
    assert.equal(seen.states.filter((change) => change.state === 'connected').length, 1, '다시 등록되기 전에는 connected 라고 알리지 않는다');
    next.receive(joinedFrame(resume['id'], [BOB]));
    assert.deepEqual(seen.states.at(-1), { state: 'connected', reason: null });
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), true);
  });

  it('재접속 루프는 하나뿐이다. 겹친 끊김 통지로 소켓이 둘 열리지 않는다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const { socket } = await online(ctx);
    socket.receive({ type: 'error', code: 'REPLACED', message: 'x' });
    socket.drop();
    socket.drop();
    ctx.clock.advance(0);
    assert.equal(ctx.hub.sockets.length, 2);
    ctx.clock.advance(100);
    assert.equal(ctx.hub.sockets.length, 2);
  });
});

describe('V-U10 signaling-client: signal 보내기와 서버 오류', () => {
  it('등록 전과 재접속 중에는 보내지 않고 false 다. 큐에 쌓지 않는다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), false, 'join 전');
    const pending = ctx.client.join(REQUEST);
    const socket = ctx.hub.last();
    socket.open();
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), false, 'joined 전');
    socket.receive(joinedFrame(lastOf(socket, 'join')['id']));
    await pending;
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), true);
    socket.drop();
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), false, '재접속 중');
    ctx.clock.advance(0);
    accept(ctx.hub.last());
    assert.equal(ctx.hub.last().actions('signal').length, 0, '끊긴 동안의 것을 나중에 보내지 않는다');
  });

  it('보낸 signal 은 서버의 스키마를 통과한다', async () => {
    const ctx = setup();
    const { socket } = await online(ctx);
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer', cid: 'aaaaaaaaaaaa.1', data: { sdp: 'v=0' } }), true);
    assert.equal(
      ctx.client.sendSignal('bob', { kind: 'candidate', cid: 'aaaaaaaaaaaa.1', data: { list: [{ candidate: 'a=candidate:1 1 UDP 1 10.0.0.1 9 typ host', mid: '0' }] } }),
      true,
    );
    const texts = socket.sent.slice(1);
    assert.equal(texts.length, 2);
    for (const text of texts) assert.equal(parseClientMessage(text).ok, true);
    const offer = lastOf(socket, 'signal');
    assert.equal(socket.actions('signal')[0]?.['to'], 'bob');
    assert.equal(offer['kind'], 'candidate');
  });

  it('크기 상한을 넘거나 형식이 틀리거나 자신에게 보내는 signal 은 보내지 않고 false 다', async () => {
    const ctx = setup();
    const { socket } = await online(ctx);
    const big = { kind: 'offer' as const, cid: 'aaaaaaaaaaaa.1', data: { sdp: 'x'.repeat(LIMITS.SDP_MAX_CHARS + 1) } };
    assert.equal(ctx.client.sendSignal('bob', big), false);
    const manyBytes = { kind: 'offer' as const, cid: 'aaaaaaaaaaaa.1', data: { sdp: '가'.repeat(6000) } };
    assert.equal(ctx.client.sendSignal('bob', manyBytes), false, '글자 수는 안이어도 바이트가 넘는다');
    assert.equal(ctx.client.sendSignal('not a name', { kind: 'offer-request', data: {} }), false);
    assert.equal(ctx.client.sendSignal('alice', { kind: 'offer-request', data: {} }), false);
    assert.equal(socket.actions('signal').length, 0);
  });

  it('내 signal 의 서버 오류를 to·cid·code 로 알린다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.client.sendSignal('bob', { kind: 'offer', cid: 'aaaaaaaaaaaa.7', data: { sdp: 'v=0' } });
    const offerId = lastOf(socket, 'signal')['id'];
    ctx.client.sendSignal('carol', { kind: 'offer-request', data: {} });
    const requestId = lastOf(socket, 'signal')['id'];

    socket.receive({ type: 'error', code: 'SERVER_ERROR', message: 'x', re: offerId });
    socket.receive({ type: 'error', code: 'PEER_NOT_FOUND', message: 'x', re: requestId });
    socket.receive({ type: 'error', code: 'RELAY_NOT_ALLOWED', message: 'x', re: offerId });
    assert.deepEqual(seen.relayErrors, [
      { to: 'bob', cid: 'aaaaaaaaaaaa.7', code: 'SERVER_ERROR' },
      { to: 'carol', cid: null, code: 'PEER_NOT_FOUND' },
      { to: 'bob', cid: 'aaaaaaaaaaaa.7', code: 'RELAY_NOT_ALLOWED' },
    ]);
    assert.equal(socket.closedByClient, false);
  });

  it('모르는 re 의 오류와 signal 에 대한 다른 코드는 relay-error 로 내지 않는다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} });
    socket.receive({ type: 'error', code: 'PEER_NOT_FOUND', message: 'x', re: 'unknown-id' });
    socket.receive({ type: 'error', code: 'BAD_MESSAGE', message: 'x', re: lastOf(socket, 'signal')['id'] });
    socket.receive({ type: 'error', code: 'PEER_NOT_FOUND', message: 'x' });
    assert.deepEqual(seen.relayErrors, []);
    assert.equal(socket.closedByClient, false);
  });

  it('앞 연결에서 보낸 signal 의 오류는 새 연결에서 되짚지 않는다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} });
    const oldId = lastOf(socket, 'signal')['id'];
    socket.drop();
    ctx.clock.advance(0);
    const second = ctx.hub.last();
    accept(second);
    second.receive({ type: 'error', code: 'PEER_NOT_FOUND', message: 'x', re: oldId });
    assert.deepEqual(seen.relayErrors, []);
  });
});

describe('V-U10 signaling-client: 끝내기', () => {
  it('leave 는 leave 를 보낸 뒤 소켓을 닫고 타이머를 남기지 않는다', async () => {
    const ctx = setup();
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    await ctx.client.leave();
    const last = socket.messages().at(-1);
    assert.equal(last?.['action'], 'leave');
    assert.equal(socket.closedByClient, true);
    assert.equal(ctx.clock.pending(), 0);
    ctx.clock.advance(120_000);
    assert.equal(ctx.hub.sockets.length, 1, '다시 접속하지 않는다');
    assert.equal(seen.states.length, 1, '이후 이벤트를 내지 않는다');
    assert.equal(ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} }), false);
    await ctx.client.leave();
  });

  it('leave 는 소켓이 닫히지 않아도 정해진 시간 안에 끝난다', async () => {
    const ctx = setup({ closeNotifies: false });
    const { socket } = await online(ctx);
    let done = false;
    const leaving = ctx.client.leave().then(() => {
      done = true;
    });
    await Promise.resolve();
    assert.equal(done, false, '닫힘을 기다린다');
    assert.equal(socket.closedByClient, true);
    ctx.clock.advance(300);
    await leaving;
    assert.equal(done, true);
    assert.equal(ctx.clock.pending(), 0);
  });

  it('재접속 중의 leave 는 보낼 연결이 없으므로 정리만 한다', async () => {
    const ctx = setup();
    const { socket } = await online(ctx);
    socket.drop();
    await ctx.client.leave();
    assert.equal(ctx.clock.pending(), 0);
    ctx.clock.advance(120_000);
    assert.equal(ctx.hub.sockets.length, 1);
  });

  it('close 는 타이머와 소켓을 모두 정리하고 이후 이벤트를 내지 않는다. 여러 번 불러도 된다', async () => {
    const ctx = setup({ closeNotifies: false });
    const seen = collect(ctx.client);
    const { socket } = await online(ctx);
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
    ctx.client.close();
    ctx.client.close();
    assert.equal(socket.closedByClient, true);
    assert.equal(socket.actions('leave').length, 0, '보내지 못한 것은 버린다');
    assert.equal(ctx.clock.pending(), 0);
    socket.receive(OFFER);
    socket.receive(GATEWAY_FRAME);
    socket.drop();
    ctx.clock.advance(600_000);
    assert.deepEqual(seen.signals, []);
    assert.equal(seen.gatewayFrames, 0);
    assert.equal(seen.states.length, 1);
    assert.equal(ctx.hub.sockets.length, 1);
  });

  it('join 전에 close 한 클라이언트는 다시 쓰지 못한다', async () => {
    const ctx = setup();
    ctx.client.close();
    assert.deepEqual(await settle(ctx.client.join(REQUEST)), { ok: false, failure: { code: 'CLOSED' } });
    assert.equal(ctx.hub.sockets.length, 0);
  });
});

describe('V-U10 signaling-client: 진단 로그', () => {
  it('방 ID 원문, key, SDP, candidate, 게이트웨이 프레임 본문을 남기지 않는다', async () => {
    const ctx = setup();
    ctx.control.random = 0;
    const { socket } = await online(ctx);
    socket.receive(OFFER);
    socket.receive(GATEWAY_FRAME);
    ctx.client.sendSignal('bob', { kind: 'offer', cid: 'aaaaaaaaaaaa.1', data: { sdp: 'v=0 secret-sdp' } });
    socket.receive({ type: 'error', code: 'PEER_NOT_FOUND', message: 'Too Many secret-message', re: lastOf(socket, 'signal')['id'] });
    ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS + LIMITS.SIGNAL_PONG_TIMEOUT_MS);
    socket.drop();
    ctx.clock.advance(0);
    accept(ctx.hub.last());

    const text = ctx.log.text();
    assert.ok(ctx.log.events.length >= 5, '사건을 남겼다');
    for (const secret of [ROOM, KEY, 'secret-sdp', 'Too Many', 'secret-message']) {
      assert.equal(text.includes(secret), false, `로그에 ${secret} 이(가) 없다`);
    }
    assert.ok(ctx.log.named('signal.gateway_frame').some((entry) => entry.fields.frame_len === GATEWAY_FRAME.length));
    assert.ok(ctx.log.named('signal.state').every((entry) => typeof entry.fields.room_ref === 'string' && entry.fields.room_ref !== ROOM));
  });
});

describe('V-U10 signaling-client: 이벤트의 Subscribable 적합성', () => {
  defineSubscribableContractTests('signal', () => {
    const ctx = setup();
    const socket = onlineSync(ctx);
    return { subscribe: (listener) => ctx.client.on('signal', listener), emit: () => socket.receive(OFFER) };
  });

  defineSubscribableContractTests('members', () => {
    const ctx = setup();
    const socket = onlineSync(ctx);
    return {
      subscribe: (listener) => ctx.client.on('members', listener),
      emit: () => {
        ctx.clock.advance(LIMITS.SIGNAL_PING_INTERVAL_MS);
        socket.receive({ type: 'pong', re: lastOf(socket, 'ping')['id'], members: [BOB] });
      },
    };
  });

  defineSubscribableContractTests('relay-error', () => {
    const ctx = setup();
    const socket = onlineSync(ctx);
    return {
      subscribe: (listener) => ctx.client.on('relay-error', listener),
      emit: () => {
        ctx.client.sendSignal('bob', { kind: 'offer-request', data: {} });
        socket.receive({ type: 'error', code: 'PEER_NOT_FOUND', message: 'x', re: lastOf(socket, 'signal')['id'] });
      },
    };
  });

  defineSubscribableContractTests('gateway-frame', () => {
    const ctx = setup();
    const socket = onlineSync(ctx);
    return { subscribe: (listener) => ctx.client.on('gateway-frame', listener), emit: () => socket.receive(GATEWAY_FRAME) };
  });

  defineSubscribableContractTests('state', () => {
    const ctx = setup();
    ctx.control.random = 0;
    onlineSync(ctx);
    let connected = true;
    return {
      subscribe: (listener) => ctx.client.on('state', listener),
      emit: () => {
        if (connected) {
          ctx.hub.last().drop();
        } else {
          ctx.clock.advance(0);
          accept(ctx.hub.last());
        }
        connected = !connected;
      },
    };
  });

  it('리스너가 던지면 로그에 사건 이름만 남긴다', async () => {
    const ctx = setup();
    const { socket } = await online(ctx);
    ctx.client.on('signal', () => {
      throw new Error('secret-from-listener');
    });
    socket.receive(OFFER);
    const failed = ctx.log.named('listener.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.fields.kind, 'signal');
    assert.equal(ctx.log.text().includes('secret-from-listener'), false);
  });
});
