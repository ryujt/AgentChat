// mesh 의 규칙 가운데 실제 라이브러리로는 만들 수 없는 것을 가짜 네이티브로 본다(대역).
// relay 후보(TURN 없이는 생기지 않는다), pc 의 failed 상태, 네이티브 로드 실패, 콜백 순서, 이벤트의 Subscribable 적합성.
// 실제 라이브러리의 동작에 대한 증거가 아니다. 그것은 mesh.test.ts 가 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, parseIceServers, type ServerSignalMessage, type SignalPayload } from '../protocol/index.js';
import { defineSubscribableContractTests } from '../protocol/testing.js';
import type { AttemptFailed, LinkClosed, LinkOpen, Mesh, PeerFrame, PeerPing } from './contract.js';
import { buildMesh, createMeshWith } from './mesh.js';
import { createFakeNative, createMemoryLog, createTestClock, type FakeChannel, type FakeNative, type FakePeer } from './testing.js';

const SELF = { peer: 'mm', sid: 'mmmmmmmmmmmm' };
const SMALL = { peer: 'aa', sid: 'aaaaaaaaaaaa' };
const LARGE = { peer: 'zz', sid: 'zzzzzzzzzzzz' };
const HOST = 'a=candidate:1 1 UDP 2114977791 192.0.2.1 5000 typ host';
const SRFLX = 'a=candidate:2 1 UDP 1678769663 198.51.100.7 5000 typ srflx raddr 192.0.2.1 rport 5000';
const RELAYED = 'a=candidate:3 1 UDP 8331263 203.0.113.9 3478 typ relay raddr 198.51.100.7 rport 5000';

interface Sent {
  readonly to: string;
  readonly payload: SignalPayload;
}

function setup(options: { pingInfo?: () => { sc: number; sf: string }; iceInput?: string } = {}) {
  const clock = createTestClock({ realtime: false });
  const log = createMemoryLog();
  const fake: FakeNative = createFakeNative();
  const sent: Sent[] = [];
  const ice = parseIceServers(options.iceInput ?? 'none');
  assert.ok(ice.ok);
  const mesh: Mesh = buildMesh(
    {
      self: SELF,
      iceServers: ice.value,
      sendSignal: (to, payload) => {
        sent.push({ to, payload });
        return true;
      },
      pingInfo: options.pingInfo ?? (() => ({ sc: 0, sf: '000000000000' })),
      now: clock.now,
      timers: clock.timers,
      log,
    },
    fake.rtc,
  );
  const seen = {
    opens: [] as LinkOpen[],
    closes: [] as LinkClosed[],
    fails: [] as AttemptFailed[],
    frames: [] as PeerFrame[],
    pings: [] as PeerPing[],
  };
  mesh.on('link-open', (link) => seen.opens.push(link));
  mesh.on('link-closed', (link) => seen.closes.push(link));
  mesh.on('attempt-failed', (failure) => seen.fails.push(failure));
  mesh.on('frame', (frame) => seen.frames.push(frame));
  mesh.on('peer-ping', (ping) => seen.pings.push(ping));
  return { clock, log, fake, sent, mesh, seen, iceServers: ice.value };
}
type Ctx = ReturnType<typeof setup>;

function from(remote: { peer: string; sid: string }, payload: SignalPayload): ServerSignalMessage {
  return { type: 'signal', from: remote.peer, sid: remote.sid, ...payload } as ServerSignalMessage;
}

/** 내가 offer 쪽인 링크를 연다(상대 이름이 크다). */
function openAsOfferSide(ctx: Ctx, remote = LARGE): { pc: FakePeer; channel: FakeChannel; cid: string } {
  ctx.mesh.contact(remote.peer);
  const pc = ctx.fake.last();
  const channel = pc.channels[0];
  assert.ok(channel !== undefined);
  pc.fireLocalDescription('v=0 offer', 'offer');
  const offer = ctx.sent.findLast((entry) => entry.to === remote.peer && entry.payload.kind === 'offer');
  assert.ok(offer !== undefined && offer.payload.kind === 'offer');
  const cid = offer.payload.cid;
  ctx.mesh.handleSignal(from(remote, { kind: 'answer', cid, data: { sdp: 'v=0 answer' } }));
  channel.fireOpen();
  return { pc, channel, cid };
}

/** 내가 answer 쪽인 시도를 시작한다(상대 이름이 작다). */
function offered(ctx: Ctx, cid = `${SMALL.sid}.1`, remote = SMALL): FakePeer {
  ctx.mesh.handleSignal(from(remote, { kind: 'offer', cid, data: { sdp: 'v=0 offer' } }));
  return ctx.fake.last();
}

describe('mesh: relay 후보 필터 (가짜 네이티브)', () => {
  it('받은 relay 후보는 pc 에 넣지 않는다. 시도 큐와 대기 큐에도 두지 않는다', () => {
    const ctx = setup();
    // 대기 큐: offer 보다 먼저 온 후보
    ctx.mesh.handleSignal(from(SMALL, { kind: 'candidate', cid: `${SMALL.sid}.1`, data: { list: [{ candidate: RELAYED, mid: '0' }, { candidate: HOST, mid: '0' }] } }));
    const pc = offered(ctx);
    assert.deepEqual(pc.remoteCandidates, [{ candidate: HOST, mid: '0' }]);
    // 현재 시도의 후보. 공백이 여러 칸이어도 relay 로 읽는다.
    const spaced = RELAYED.replace(' typ relay', ' typ   relay');
    ctx.mesh.handleSignal(from(SMALL, { kind: 'candidate', cid: `${SMALL.sid}.1`, data: { list: [{ candidate: spaced, mid: '0' }, { candidate: RELAYED, mid: '0' }, { candidate: SRFLX, mid: '0' }] } }));
    assert.deepEqual(pc.remoteCandidates.map((item) => item.candidate), [HOST, SRFLX]);

    // 시도 큐: answer 보다 먼저 온 후보
    ctx.mesh.contact(LARGE.peer);
    const offering = ctx.fake.last();
    const cid = `${SELF.sid}.1`;
    ctx.mesh.handleSignal(from(LARGE, { kind: 'candidate', cid, data: { list: [{ candidate: RELAYED, mid: '0' }, { candidate: HOST, mid: '0' }] } }));
    assert.deepEqual(offering.remoteCandidates, [], 'answer 전에는 넣지 않는다');
    ctx.mesh.handleSignal(from(LARGE, { kind: 'answer', cid, data: { sdp: 'v=0 answer' } }));
    assert.deepEqual(offering.remoteCandidates, [{ candidate: HOST, mid: '0' }]);

    ctx.mesh.expireAttempt(SMALL.peer);
    assert.deepEqual(ctx.seen.fails[0]?.diag.remote, { host: 1, srflx: 1 }, 'relay 후보는 세지도 않는다');
  });

  it('내 relay 후보는 보내지 않는다. host 와 srflx 는 100ms 동안 모아 한 메시지로 보낸다', () => {
    const ctx = setup();
    ctx.mesh.contact(LARGE.peer);
    const pc = ctx.fake.last();
    pc.fireLocalDescription('v=0 offer', 'offer');
    pc.fireLocalCandidate(HOST);
    pc.fireLocalCandidate(RELAYED);
    ctx.clock.jump(60);
    pc.fireLocalCandidate(SRFLX);
    ctx.clock.jump(LIMITS.CANDIDATE_BATCH_MS - 61);
    assert.deepEqual(ctx.sent.map((entry) => entry.payload.kind), ['offer'], '묶는 동안에는 보내지 않는다');
    ctx.clock.jump(1);
    assert.deepEqual(ctx.sent.map((entry) => entry.payload.kind), ['offer', 'candidate']);
    const batch = ctx.sent[1]?.payload;
    assert.ok(batch !== undefined && batch.kind === 'candidate');
    assert.deepEqual(batch.data.list, [{ candidate: HOST, mid: '0' }, { candidate: SRFLX, mid: '0' }]);
    assert.equal(batch.cid, `${SELF.sid}.1`);

    // 다시 보낼 때도 relay 후보는 들어가지 않는다.
    ctx.mesh.resendPending();
    const resent = ctx.sent.at(-1)?.payload;
    assert.ok(resent !== undefined && resent.kind === 'candidate');
    assert.equal(resent.data.list.some((item) => item.candidate.includes('relay')), false);
    ctx.mesh.expireAttempt(LARGE.peer);
    assert.deepEqual(ctx.seen.fails[0]?.diag.local, { host: 1, srflx: 1 });
    assert.deepEqual(ctx.mesh.netInfo(), { srflx_seen: true });
  });

  it('relay 후보가 든 offer 와 answer 는 적용하지 않는다', () => {
    const ctx = setup();
    ctx.mesh.handleSignal(from(SMALL, { kind: 'offer', cid: `${SMALL.sid}.1`, data: { sdp: `v=0\r\n${RELAYED}\r\n` } }));
    assert.equal(ctx.fake.peers.length, 0, 'pc 를 만들지 않았다');
    assert.deepEqual(ctx.mesh.links(), []);

    ctx.mesh.contact(LARGE.peer);
    const pc = ctx.fake.last();
    ctx.mesh.handleSignal(from(LARGE, { kind: 'answer', cid: `${SELF.sid}.1`, data: { sdp: `v=0\r\n${RELAYED}\r\n` } }));
    assert.deepEqual(pc.remoteDescriptions, []);
    assert.deepEqual(ctx.mesh.links(), [{ peer: LARGE.peer, sid: null, state: 'connecting' }]);
  });

  it('내 설명에 relay 후보가 들었으면 보내지 않고 ice/failed 로 끝낸다. 로그에 error_code 를 남긴다', () => {
    const ctx = setup();
    ctx.mesh.contact(LARGE.peer);
    const pc = ctx.fake.last();
    pc.fireLocalDescription(`v=0\r\n${RELAYED}\r\n`, 'offer');
    assert.deepEqual(ctx.sent, []);
    assert.deepEqual([ctx.seen.fails[0]?.stage, ctx.seen.fails[0]?.reason], ['ice', 'failed']);
    assert.equal(pc.closed, true);
    assert.equal(ctx.log.named('link.attempt_end')[0]?.fields.error_code, 'RELAY_NOT_ALLOWED');
    assert.equal(ctx.log.text().includes('203.0.113.9'), false, '후보 원문을 남기지 않는다');
  });
});

describe('mesh: pc 상태와 콜백 (가짜 네이티브)', () => {
  it('시도 중에 pc 가 failed 나 closed 가 되면 기한을 기다리지 않고 ice/failed 로 끝낸다', () => {
    for (const state of ['failed', 'closed']) {
      const ctx = setup();
      const pc = offered(ctx);
      pc.fireState('connecting');
      pc.fireState('disconnected');
      assert.equal(ctx.seen.fails.length, 0, '다른 상태로는 끝내지 않는다');
      pc.fireState(state);
      pc.fireState(state);
      assert.equal(ctx.seen.fails.length, 1, state);
      assert.deepEqual([ctx.seen.fails[0]?.stage, ctx.seen.fails[0]?.reason], ['ice', 'failed']);
      assert.equal(ctx.seen.fails[0]?.diag.pc_state, state, '닫기 전에 읽은 상태 이름이다');
      assert.equal(pc.closed, true, '상대가 닫은 pc 도 close() 를 부른다');
      assert.equal(ctx.clock.pending(), 0);
    }
  });

  it('열린 링크의 pc 가 failed 나 closed 가 되거나 채널이 닫히면 그 사유로 한 번 닫는다', () => {
    for (const [trigger, reason] of [['failed', 'failed'], ['closed', 'closed'], ['channel', 'closed']] as const) {
      const ctx = setup();
      const { pc, channel } = openAsOfferSide(ctx);
      if (trigger === 'channel') channel.fireClosed();
      else pc.fireState(trigger);
      // 닫힘 통지보다 늦게 처리되는 마지막 프레임을 받는다.
      channel.fireMessage('last words');
      pc.fireState('closed');
      channel.fireClosed();
      assert.equal(ctx.seen.closes.length, 0, '한 박자 늦춘다');
      ctx.clock.jump(0);
      assert.deepEqual(ctx.seen.closes, [{ peer: LARGE.peer, sid: LARGE.sid, reason }], trigger);
      assert.deepEqual(ctx.seen.frames, [{ peer: LARGE.peer, text: 'last words' }]);
      assert.equal(pc.closed, true);
      assert.equal(channel.closed, true);
      ctx.clock.jump(60_000);
      assert.equal(ctx.seen.closes.length, 1);
      assert.equal(ctx.clock.pending(), 0);
    }
  });

  it('닫은 pc 의 늦은 콜백은 아무 것도 바꾸지 않는다', () => {
    const ctx = setup();
    const old = offered(ctx, `${SMALL.sid}.1`);
    const current = offered(ctx, `${SMALL.sid}.2`);
    assert.notEqual(old, current);
    assert.equal(old.closed, true, '바뀐 시도의 옛 pc 는 닫는다');
    const before = ctx.sent.length;
    old.fireLocalDescription('v=0 answer', 'answer');
    old.fireLocalCandidate(HOST);
    old.fireState('failed');
    const late = old.fireDataChannel();
    late.fireMessage('ghost');
    ctx.clock.jump(LIMITS.CANDIDATE_BATCH_MS);
    assert.equal(ctx.sent.length, before);
    assert.deepEqual([ctx.seen.opens, ctx.seen.closes, ctx.seen.fails, ctx.seen.frames], [[], [], [], []]);
    assert.deepEqual(ctx.mesh.links(), [{ peer: SMALL.peer, sid: SMALL.sid, state: 'connecting' }]);

    // 실패로 끝낸 시도의 pc 도 같다.
    ctx.mesh.expireAttempt(SMALL.peer);
    current.fireDataChannel();
    current.fireState('closed');
    assert.equal(ctx.seen.opens.length, 0);
    assert.equal(ctx.seen.fails.length, 1);
  });

  it('열림 콜백이 두 번 와도 link-open 은 한 번이다. 열림보다 먼저 온 프레임도 버리지 않는다', () => {
    const ctx = setup();
    const pc = offered(ctx);
    pc.fireLocalDescription('v=0 answer', 'answer');
    const channel = pc.fireDataChannel('agent-chat', true);
    channel.fireOpen();
    channel.fireOpen();
    assert.deepEqual(ctx.seen.opens, [{ peer: SMALL.peer, sid: SMALL.sid, cid: `${SMALL.sid}.1` }]);

    const other = setup();
    other.mesh.contact(LARGE.peer);
    const offering = other.fake.last();
    offering.fireLocalDescription('v=0 offer', 'offer');
    other.mesh.handleSignal(from(LARGE, { kind: 'answer', cid: `${SELF.sid}.1`, data: { sdp: 'v=0 answer' } }));
    const early = offering.channels[0];
    assert.ok(early !== undefined);
    // 열림 콜백보다 프레임 콜백이 먼저 처리된 경우.
    Object.assign(early, { isOpen: () => true });
    early.fireMessage('{"v":1,"t":"hello"}');
    assert.equal(other.seen.opens.length, 1);
    assert.deepEqual(other.seen.frames, [{ peer: LARGE.peer, text: '{"v":1,"t":"hello"}' }]);
  });

  it('라벨이 다른 채널과 두 번째 채널은 받지 않는다', () => {
    const ctx = setup();
    const pc = offered(ctx);
    const wrong = pc.fireDataChannel('something-else', true);
    assert.equal(wrong.closed, true);
    assert.equal(ctx.seen.opens.length, 0);
    const right = pc.fireDataChannel('agent-chat', true);
    const second = pc.fireDataChannel('agent-chat', true);
    assert.equal(ctx.seen.opens.length, 1);
    assert.equal(right.closed, false);
    assert.equal(second.closed, true, '쌍마다 채널은 하나다');
  });

  it('바이너리 메시지는 올리지 않는다. 형식이 틀린 ping 은 해석하지 않고 그대로 올린다', () => {
    const ctx = setup();
    const { channel } = openAsOfferSide(ctx);
    channel.fireMessage(Buffer.from('binary'));
    channel.fireMessage('{"v":1,"t":"ping"}');
    channel.fireMessage('{"v":2,"t":"ping","n":1,"sc":0,"sf":"000000000000"}');
    channel.fireMessage('{"v":1,"t":"ping","n":7,"sc":4,"sf":"abcdefabcdef"}');
    assert.deepEqual(ctx.seen.frames.map((frame) => frame.text), ['{"v":1,"t":"ping"}', '{"v":2,"t":"ping","n":1,"sc":0,"sf":"000000000000"}']);
    assert.deepEqual(ctx.seen.pings, [{ peer: LARGE.peer, sc: 4, sf: 'abcdefabcdef' }]);
    assert.deepEqual(channel.sent, ['{"v":1,"t":"pong","n":7}'], 'ping 을 받으면 같은 n 의 pong 을 바로 보낸다');
  });

  it('pingInfo 가 스키마에 맞지 않는 값을 주면 ping 을 보내지 않고 로그를 남긴다', () => {
    const ctx = setup({ pingInfo: () => ({ sc: -1, sf: 'not-a-fingerprint' }) });
    const { channel } = openAsOfferSide(ctx);
    ctx.clock.jump(LIMITS.P2P_PING_INTERVAL_MS);
    assert.deepEqual(channel.sent, []);
    assert.equal(ctx.log.named('link.ping')[0]?.fields.outcome, 'failed');
    ctx.clock.jump(LIMITS.P2P_DEAD_AFTER_MS);
    assert.deepEqual(ctx.seen.closes.map((closed) => closed.reason), ['ping_timeout']);
  });

  it('cid 는 <내 sid>.<순번> 이고 순번은 시도마다 커진다. pc 에는 받은 ICE 서버 값을 그대로 넘긴다', () => {
    const ctx = setup({ iceInput: 'stun:stun.example.org,stun:[2001:db8::1]:3479' });
    ctx.mesh.contact('nn');
    ctx.fake.last().fireLocalDescription('v=0 offer', 'offer');
    ctx.mesh.contact('oo');
    ctx.fake.last().fireLocalDescription('v=0 offer', 'offer');
    ctx.mesh.expireAttempt('nn');
    ctx.mesh.contact('nn');
    ctx.fake.last().fireLocalDescription('v=0 offer', 'offer');
    const cids = ctx.sent.map((entry) => (entry.payload.kind === 'offer' ? entry.payload.cid : null));
    assert.deepEqual(cids, [`${SELF.sid}.1`, `${SELF.sid}.2`, `${SELF.sid}.3`]);
    assert.deepEqual(ctx.fake.peers.map((pc) => pc.iceServers), [ctx.iceServers, ctx.iceServers, ctx.iceServers]);
    assert.deepEqual(ctx.iceServers.map((server) => [server.hostname, server.port]), [['stun.example.org', 3478], ['2001:db8::1', 3479]]);
  });

  it('pc 를 만들지 못하면 그 시도를 ice/failed 로 끝낸다', () => {
    const ctx = setup();
    ctx.fake.rtc.createPeer = () => {
      throw new Error('native failure');
    };
    ctx.mesh.contact(LARGE.peer);
    ctx.mesh.handleSignal(from(SMALL, { kind: 'offer', cid: `${SMALL.sid}.1`, data: { sdp: 'v=0 offer' } }));
    assert.deepEqual(ctx.seen.fails.map((failure) => [failure.peer, failure.stage, failure.reason]), [
      [LARGE.peer, 'ice', 'failed'],
      [SMALL.peer, 'ice', 'failed'],
    ]);
    assert.deepEqual(ctx.mesh.links(), []);
    assert.equal(ctx.clock.pending(), 0);
  });
});

describe('mesh: 만들기와 끝내기 (가짜 네이티브)', () => {
  it('네이티브 모듈을 불러오지 못하면 NATIVE_LOAD_FAILED 로 돌려준다. reject 하지 않는다', async () => {
    const ctx = setup();
    const result = await createMeshWith(
      { self: SELF, iceServers: [], sendSignal: () => true, pingInfo: () => ({ sc: 0, sf: '000000000000' }), now: ctx.clock.now, timers: ctx.clock.timers, log: ctx.log },
      async () => {
        throw new Error('Cannot load native addon for node-datachannel on darwin (arm64)');
      },
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.code, 'NATIVE_LOAD_FAILED');
    assert.match(result.detail, /Cannot load native addon/);
    assert.equal(ctx.log.named('mesh.native_load')[0]?.fields.error_code, 'NATIVE_LOAD_FAILED');
  });

  it('shutdown 은 모든 pc 와 채널을 닫고 네이티브 정리를 한 번 부른다. 타이머가 남지 않는다', async () => {
    const ctx = setup();
    const open = openAsOfferSide(ctx);
    const attempting = offered(ctx);
    ctx.mesh.contact('nn');
    ctx.mesh.handleSignal(from({ peer: 'bb', sid: 'bbbbbbbbbbbb' }, { kind: 'candidate', cid: 'bbbbbbbbbbbb.1', data: { list: [{ candidate: HOST, mid: '0' }] } }));
    assert.ok(ctx.clock.pending() > 0);

    const first = ctx.mesh.shutdown();
    assert.equal(ctx.fake.peers.every((pc) => pc.closed), true, '정리보다 먼저 모든 pc 의 close() 를 부른다');
    assert.equal(ctx.fake.cleanups, 0, '네이티브 정리는 같은 박자의 다른 close() 가 끝난 뒤다');
    assert.equal(open.channel.closed, true);
    const second = ctx.mesh.shutdown();
    await Promise.all([first, second]);
    assert.equal(ctx.fake.cleanups, 1);
    assert.equal(ctx.clock.pending(), 0);

    open.pc.fireState('closed');
    open.channel.fireMessage('after');
    attempting.fireDataChannel();
    ctx.mesh.contact('later');
    ctx.mesh.handleSignal(from(SMALL, { kind: 'offer', cid: `${SMALL.sid}.9`, data: { sdp: 'v=0 offer' } }));
    ctx.mesh.expireAttempt('later');
    assert.deepEqual(ctx.mesh.links(), []);
    ctx.clock.jump(60_000);
    assert.deepEqual([ctx.seen.closes, ctx.seen.frames, ctx.seen.fails], [[], [], []], 'shutdown 뒤에는 어떤 이벤트도 내지 않는다');
    assert.equal(ctx.seen.opens.length, 1);
    assert.equal(ctx.fake.peers.length, 3, '새 pc 를 만들지 않는다');
  });

  it('네이티브 정리가 던져도 shutdown 은 reject 하지 않고 로그를 남긴다', async () => {
    const ctx = setup();
    ctx.fake.rtc.cleanup = () => {
      throw new Error('libdatachannel error# cleanup timeout (possible deadlock)');
    };
    await ctx.mesh.shutdown();
    assert.equal(ctx.log.named('mesh.cleanup')[0]?.fields.outcome, 'failed');
  });
});

describe('mesh: 이벤트의 Subscribable 적합성 (가짜 네이티브)', () => {
  let serial = 0;
  const nextRemote = (): { peer: string; sid: string } => {
    serial += 1;
    return { peer: `zz${serial}`, sid: LARGE.sid };
  };

  defineSubscribableContractTests('link-open', () => {
    const ctx = setup();
    return { subscribe: (listener) => ctx.mesh.on('link-open', listener), emit: () => void openAsOfferSide(ctx, nextRemote()) };
  });

  defineSubscribableContractTests('link-closed', () => {
    const ctx = setup();
    return {
      subscribe: (listener) => ctx.mesh.on('link-closed', listener),
      emit: () => {
        const remote = nextRemote();
        openAsOfferSide(ctx, remote);
        ctx.mesh.closeLink(remote.peer, 'test');
      },
    };
  });

  defineSubscribableContractTests('attempt-failed', () => {
    const ctx = setup();
    return {
      subscribe: (listener) => ctx.mesh.on('attempt-failed', listener),
      emit: () => {
        const remote = nextRemote();
        ctx.mesh.contact(remote.peer);
        ctx.mesh.expireAttempt(remote.peer);
      },
    };
  });

  defineSubscribableContractTests('frame', () => {
    const ctx = setup();
    const { channel } = openAsOfferSide(ctx);
    return { subscribe: (listener) => ctx.mesh.on('frame', listener), emit: () => channel.fireMessage('text') };
  });

  defineSubscribableContractTests('peer-ping', () => {
    const ctx = setup();
    const { channel } = openAsOfferSide(ctx);
    return {
      subscribe: (listener) => ctx.mesh.on('peer-ping', listener),
      emit: () => channel.fireMessage('{"v":1,"t":"ping","n":1,"sc":0,"sf":"000000000000"}'),
    };
  });

  it('리스너가 던져도 mesh 의 상태가 지켜지고 로그에 사건 이름만 남는다', () => {
    const ctx = setup();
    ctx.mesh.on('link-open', () => {
      throw new Error('secret-from-listener');
    });
    const { channel } = openAsOfferSide(ctx);
    assert.deepEqual(ctx.mesh.links(), [{ peer: LARGE.peer, sid: LARGE.sid, state: 'open' }]);
    channel.fireMessage('still works');
    assert.equal(ctx.seen.frames.length, 1);
    assert.equal(ctx.log.named('listener.failed')[0]?.fields.kind, 'link-open');
    assert.equal(ctx.log.text().includes('secret-from-listener'), false);
  });
});

describe('mesh: 검토 1차 반영 — 다시 시작한 상대, 늦은 중복 offer, answer 재전송 (가짜 네이티브)', () => {
  it('(CONNECT-R1-01) answer 를 받은 시도에 다른 sid 의 offer-request 가 오면 상대가 다시 시작한 것이다. 이벤트 없이 새 cid 로 offer 한다', () => {
    const ctx = setup();
    ctx.mesh.contact(LARGE.peer);
    const old = ctx.fake.last();
    old.fireLocalDescription('v=0 offer', 'offer');
    old.fireLocalCandidate(HOST);
    ctx.clock.jump(LIMITS.CANDIDATE_BATCH_MS);
    const firstCid = `${SELF.sid}.1`;
    // 옛 상대(sid z…)가 answer 를 보냈다. 채널은 아직 열리지 않았다.
    ctx.mesh.handleSignal(from(LARGE, { kind: 'answer', cid: firstCid, data: { sdp: 'v=0 answer' } }));
    ctx.clock.jump(1_000);

    // 같은 sid 의 offer-request 는 지금처럼 후보 묶음만 다시 보낸다.
    const beforeSame = ctx.sent.length;
    ctx.mesh.handleSignal(from(LARGE, { kind: 'offer-request', data: {} }));
    assert.deepEqual(ctx.sent.slice(beforeSame).map((entry) => entry.payload.kind), ['candidate']);
    assert.equal(old.closed, false);

    // 같은 이름의 새 프로세스(sid 가 다르다)가 offer-request 를 보낸다.
    const restarted = { peer: LARGE.peer, sid: 'z2z2z2z2z2z2' };
    const before = ctx.sent.length;
    ctx.mesh.handleSignal(from(restarted, { kind: 'offer-request', data: {} }));
    assert.equal(old.closed, true, '옛 상대와의 pc 를 닫는다');
    const fresh = ctx.fake.last();
    assert.notEqual(fresh, old);
    fresh.fireLocalDescription('v=0 offer 2', 'offer');
    const offers = ctx.sent.slice(before).filter((entry) => entry.payload.kind === 'offer');
    assert.equal(offers.length, 1, '새 offer 를 바로 보낸다');
    const second = offers[0]?.payload;
    assert.ok(second !== undefined && second.kind === 'offer');
    assert.equal(second.cid, `${SELF.sid}.2`, '새 cid 다');
    assert.deepEqual(ctx.seen.fails, [], '시도의 끝이 아니다. attempt-failed 를 내지 않는다');
    assert.deepEqual(ctx.mesh.links(), [{ peer: LARGE.peer, sid: null, state: 'connecting' }]);
    assert.equal(ctx.log.named('link.attempt_swap').length, 1);

    // 새 상대의 answer 로 열린다. 기한은 바뀐 때부터 새로 잰다.
    ctx.mesh.handleSignal(from(restarted, { kind: 'answer', cid: second.cid, data: { sdp: 'v=0 answer 2' } }));
    ctx.clock.jump(LIMITS.PEER_CONNECT_TIMEOUT_MS - 1_001);
    assert.deepEqual(ctx.seen.fails, [], '처음 시도의 기한(15초)에 끝내지 않는다');
    fresh.channels[0]?.fireOpen();
    assert.deepEqual(ctx.seen.opens, [{ peer: LARGE.peer, sid: restarted.sid, cid: second.cid }]);
  });

  it('(CONNECT-R1-01) answer 를 받기 전(상대 sid 를 모른다)의 offer-request 는 sid 와 상관없이 같은 offer 를 다시 보낸다', () => {
    const ctx = setup();
    ctx.mesh.contact(LARGE.peer);
    const pc = ctx.fake.last();
    pc.fireLocalDescription('v=0 offer', 'offer');
    const before = ctx.sent.length;
    ctx.mesh.handleSignal(from({ peer: LARGE.peer, sid: 'z2z2z2z2z2z2' }, { kind: 'offer-request', data: {} }));
    const resent = ctx.sent.slice(before);
    assert.deepEqual(resent.map((entry) => entry.payload.kind), ['offer']);
    assert.equal(pc.closed, false);
    const payload = resent[0]?.payload;
    assert.ok(payload !== undefined && payload.kind === 'offer');
    assert.equal(payload.cid, `${SELF.sid}.1`);
  });

  it('(CONNECT-R1-03) 열린 링크와 같은 cid 의 늦은 offer 는 중복이다. 교체 확인을 하지 않고 링크를 유지한다', () => {
    const ctx = setup();
    const cid = `${SMALL.sid}.1`;
    const pc = offered(ctx, cid);
    pc.fireLocalDescription('v=0 answer', 'answer');
    const channel = pc.fireDataChannel('agent-chat', true);
    assert.equal(ctx.seen.opens.length, 1);
    const framesBefore = channel.sent.length;
    const peersBefore = ctx.fake.peers.length;

    // 상대가 answer 를 받기 전에 다시 보낸 같은 cid 의 offer 가 늦게 도착한다.
    ctx.mesh.handleSignal(from(SMALL, { kind: 'offer', cid, data: { sdp: 'v=0 offer' } }));
    assert.equal(channel.sent.length, framesBefore, '교체 확인 ping 을 보내지 않는다');
    ctx.clock.jump(LIMITS.REPLACE_PROBE_MS + 100);
    assert.deepEqual(ctx.seen.closes, [], '링크를 닫지 않는다');
    assert.equal(ctx.fake.peers.length, peersBefore, '옛 cid 로 새 pc 를 만들지 않는다');
    assert.deepEqual(ctx.mesh.links(), [{ peer: SMALL.peer, sid: SMALL.sid, state: 'open' }]);
    assert.equal(ctx.log.named('signal.ignored').some((entry) => entry.fields.reason === 'dup_offer_open_link'), true);

    // cid 가 다른 offer 는 여전히 교체 확인을 한다.
    ctx.mesh.handleSignal(from(SMALL, { kind: 'offer', cid: `${SMALL.sid}.2`, data: { sdp: 'v=0 offer' } }));
    assert.equal(channel.sent.length, framesBefore + 1, '교체 확인 ping');
  });

  it('(총괄 결정 2-가) answer 를 보낸 쪽도 채널이 열리기 전까지 주기마다 같은 answer 와 후보 묶음을 다시 보낸다', () => {
    const ctx = setup();
    const cid = `${SMALL.sid}.1`;
    const pc = offered(ctx, cid);
    pc.fireLocalDescription('v=0 answer', 'answer');
    pc.fireLocalCandidate(HOST);
    ctx.clock.jump(LIMITS.CANDIDATE_BATCH_MS);
    assert.deepEqual(ctx.sent.map((entry) => entry.payload.kind), ['answer', 'candidate']);
    const first = ctx.sent[0]?.payload;

    for (let round = 1; round <= LIMITS.SIGNAL_RESEND_MAX; round += 1) {
      const before = ctx.sent.length;
      ctx.clock.jump(LIMITS.SIGNAL_RESEND_MS);
      const resent = ctx.sent.slice(before);
      assert.deepEqual(resent.map((entry) => entry.payload.kind), ['answer', 'candidate'], `${round}번째 주기`);
      assert.deepEqual(resent[0]?.payload, first, '처음 만든 answer 그대로다(같은 cid)');
    }
    assert.deepEqual(
      ctx.log.named('signal.resend').map((entry) => [entry.fields.kind, entry.fields.cause]),
      Array.from({ length: LIMITS.SIGNAL_RESEND_MAX }, () => ['answer', 'periodic']),
    );
    // 열린 뒤에는 다시 보내지 않는다.
    const opened = setup();
    const other = offered(opened, cid);
    other.fireLocalDescription('v=0 answer', 'answer');
    other.fireDataChannel('agent-chat', true);
    const sentBefore = opened.sent.length;
    opened.clock.jump(LIMITS.SIGNAL_RESEND_MS * 2);
    assert.equal(opened.sent.length, sentBefore);
  });

  it('(총괄 결정 2-가) offer 쪽은 같은 cid 의 중복 answer 를 무시한다(원격 설명을 다시 적용하지 않는다)', () => {
    const ctx = setup();
    ctx.mesh.contact(LARGE.peer);
    const pc = ctx.fake.last();
    pc.fireLocalDescription('v=0 offer', 'offer');
    const cid = `${SELF.sid}.1`;
    ctx.mesh.handleSignal(from(LARGE, { kind: 'answer', cid, data: { sdp: 'v=0 answer' } }));
    ctx.mesh.handleSignal(from(LARGE, { kind: 'answer', cid, data: { sdp: 'v=0 answer' } }));
    ctx.mesh.handleSignal(from(LARGE, { kind: 'answer', cid, data: { sdp: 'v=0 answer' } }));
    assert.equal(pc.remoteDescriptions.length, 1);
    pc.channels[0]?.fireOpen();
    // 열린 뒤에 온 늦은 answer 도 아무 것도 바꾸지 않는다.
    ctx.mesh.handleSignal(from(LARGE, { kind: 'answer', cid, data: { sdp: 'v=0 answer' } }));
    assert.equal(pc.remoteDescriptions.length, 1);
    assert.deepEqual(ctx.seen.closes, []);
    assert.equal(ctx.log.named('link.attempt_end')[0]?.fields.dup_ignored, 2);
  });
});
