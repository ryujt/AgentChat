// V-U11: mesh 를 실제 node-datachannel 로 본다. 한 프로세스에 인스턴스를 둘 세우고 시험이 시그널링 서버 노릇을 한다.
// 실제 라이브러리를 쓰므로 증거 수준은 로컬 실물이다. 같은 PC 안의 연결이라 실제 NAT 의 증거는 아니다.
// 긴 기한(15초, 3초)은 시계를 건너뛰어 울린다. 라이브러리의 진행은 실제 시간으로 기다린다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, parseIceServers, type IceServers, type ServerSignalMessage } from '../protocol/index.js';
import type { AttemptFailed, LinkClosed, LinkOpen, Mesh, PeerFrame, PeerPing } from './contract.js';
import { createMesh } from './index.js';
import { DEAD_TIMER_LEAD_MS } from './mesh.js';
import {
  createMemoryLog,
  createRawPeers,
  createSignalHub,
  createTestClock,
  shutdownAll,
  sleep,
  startStunStub,
  toSignal,
  until,
  type Envelope,
  type MemoryLog,
  type RawConn,
  type RawItem,
  type RawPeers,
  type SignalHub,
  type StunStub,
  type TestClock,
} from './testing.js';

const ALICE = { peer: 'alice', sid: 'aaaaaaaaaaaa' };
const BOB = { peer: 'bob', sid: 'bbbbbbbbbbbb' };
const PING_INFO = { sc: 3, sf: '0123456789ab' };

interface Node {
  readonly self: { peer: string; sid: string };
  readonly mesh: Mesh;
  readonly log: MemoryLog;
  readonly opens: LinkOpen[];
  /** link-open 이 난 때의 시험 시계. */
  readonly openedAt: number[];
  readonly closes: LinkClosed[];
  readonly fails: AttemptFailed[];
  readonly frames: PeerFrame[];
  readonly pings: PeerPing[];
  /** 이벤트가 난 순서. */
  readonly order: string[];
  isOpen(peer: string): boolean;
}

interface Env {
  readonly clock: TestClock;
  readonly hub: SignalHub;
  node(self: { peer: string; sid: string }, iceServers?: IceServers): Promise<Node>;
  raws(): Promise<RawPeers>;
  stun(delayMs?: number): Promise<StunStub>;
}

/** 시험 하나의 환경을 만들고, 끝나면 날 pc → mesh → 시계 순으로 정리한다. 처리 중 예외가 로그에 있으면 실패다. */
function scenario(name: string, run: (env: Env) => Promise<void>): void {
  it(name, async () => {
    const clock = createTestClock();
    const hub = createSignalHub();
    const nodes: Node[] = [];
    const stubs: StunStub[] = [];
    let raw: RawPeers | null = null;
    const env: Env = {
      clock,
      hub,
      async node(self, iceServers = []): Promise<Node> {
        const log = createMemoryLog();
        const created = await createMesh({
          self,
          iceServers,
          sendSignal: hub.sender(self.peer, self.sid),
          pingInfo: () => PING_INFO,
          now: clock.now,
          timers: clock.timers,
          log,
        });
        assert.ok(created.ok, '네이티브 모듈을 불러왔다');
        const mesh = created.mesh;
        const node: Node = {
          self,
          mesh,
          log,
          opens: [],
          openedAt: [],
          closes: [],
          fails: [],
          frames: [],
          pings: [],
          order: [],
          isOpen: (peer) => mesh.links().some((link) => link.peer === peer && link.state === 'open'),
        };
        mesh.on('link-open', (link) => {
          node.opens.push(link);
          node.openedAt.push(clock.now());
          node.order.push(`open:${link.peer}:${link.cid}`);
        });
        mesh.on('link-closed', (link) => {
          node.closes.push(link);
          node.order.push(`closed:${link.peer}:${link.reason}`);
        });
        mesh.on('attempt-failed', (failure) => {
          node.fails.push(failure);
          node.order.push(`failed:${failure.peer}:${failure.stage}/${failure.reason}`);
        });
        mesh.on('frame', (frame) => node.frames.push(frame));
        mesh.on('peer-ping', (ping) => node.pings.push(ping));
        hub.attach(self.peer, (signal) => mesh.handleSignal(signal));
        nodes.push(node);
        return node;
      },
      async raws(): Promise<RawPeers> {
        raw ??= await createRawPeers();
        return raw;
      },
      async stun(delayMs = 0): Promise<StunStub> {
        const stub = await startStunStub(delayMs);
        stubs.push(stub);
        return stub;
      },
    };
    try {
      await run(env);
    } finally {
      (raw as RawPeers | null)?.closeAll();
      await shutdownAll(nodes.map((node) => node.mesh));
      clock.stop();
      for (const stub of stubs) await stub.close();
    }
    for (const node of nodes) {
      assert.deepEqual(node.log.named('mesh.callback_failed'), [], `${node.self.peer}: 콜백 처리 중 예외가 없다`);
      assert.deepEqual(node.log.named('mesh.cleanup'), [], `${node.self.peer}: 네이티브 정리가 실패하지 않았다`);
    }
  });
}

async function connected(env: Env): Promise<{ alice: Node; bob: Node }> {
  const alice = await env.node(ALICE);
  const bob = await env.node(BOB);
  alice.mesh.contact('bob');
  await until(() => alice.isOpen('bob') && bob.isOpen('alice'), '두 mesh 의 링크');
  return { alice, bob };
}

function kinds(envelopes: readonly Envelope[]): string[] {
  return envelopes.map((envelope) => `${envelope.from}>${envelope.to}:${envelope.payload.kind}`);
}

function cidOf(envelope: Envelope | undefined): string | null {
  return envelope !== undefined && envelope.payload.kind !== 'offer-request' ? envelope.payload.cid : null;
}

function sdpOf(envelope: Envelope | undefined): string {
  assert.ok(envelope !== undefined && (envelope.payload.kind === 'offer' || envelope.payload.kind === 'answer'));
  return envelope.payload.data.sdp;
}

function candidatesOf(envelopes: readonly Envelope[]): RawItem[] {
  return envelopes.flatMap((envelope) => (envelope.payload.kind === 'candidate' ? envelope.payload.data.list : []));
}

function signalFrom(from: { peer: string; sid: string }, payload: Envelope['payload']): ServerSignalMessage {
  return toSignal({ index: -1, from: from.peer, sid: from.sid, to: '', payload });
}

function hostCandidate(index: number): RawItem {
  return { candidate: `a=candidate:${index} 1 UDP 2114977791 192.0.2.${index} 5000 typ host`, mid: '0' };
}

/** mesh(offer 쪽)와 날 pc(answer 쪽)를 잇는다. 날 pc 는 ping 에 답하지 않는다. */
async function linkToRawAnswerer(env: Env, node: Node, remote: { peer: string; sid: string }): Promise<RawConn> {
  const raws = await env.raws();
  const before = env.hub.sentBy(node.self.peer, 'offer').length;
  node.mesh.contact(remote.peer);
  await until(() => env.hub.sentBy(node.self.peer, 'offer').length > before, 'mesh 의 offer');
  const offer = env.hub.sentBy(node.self.peer, 'offer').at(-1);
  const cid = cidOf(offer) ?? '';
  const raw = await raws.answer(sdpOf(offer));
  node.mesh.handleSignal(signalFrom(remote, { kind: 'answer', cid, data: { sdp: raw.sdp } }));
  node.mesh.handleSignal(signalFrom(remote, { kind: 'candidate', cid, data: { list: raw.candidates } }));
  // mesh 는 날 pc 의 후보를 알므로 자기 후보 묶음을 보내기 전에 열릴 수 있다. 열린 뒤에는 후보를 보내지 않는다.
  await until(() => node.isOpen(remote.peer) && raw.isOpen(), 'mesh 와 날 pc 의 링크');
  return raw;
}

/** 날 pc(offer 쪽)와 mesh(answer 쪽)를 잇는다. */
async function linkFromRawOfferer(env: Env, node: Node, remote: { peer: string; sid: string }, seq = 1): Promise<{ raw: RawConn; cid: string }> {
  const raws = await env.raws();
  const raw = await raws.offer();
  const cid = `${remote.sid}.${seq}`;
  node.mesh.handleSignal(signalFrom(remote, { kind: 'offer', cid, data: { sdp: raw.sdp } }));
  node.mesh.handleSignal(signalFrom(remote, { kind: 'candidate', cid, data: { list: raw.candidates } }));
  await completeWithRawOfferer(env, node, raw, cid);
  await until(() => node.isOpen(remote.peer) && raw.isOpen(), '날 pc 와 mesh 의 링크');
  return { raw, cid };
}

/** mesh 가 그 cid 로 보낸 answer 와 후보를 날 pc(offer 쪽)에 넣는다. */
async function completeWithRawOfferer(env: Env, node: Node, raw: RawConn, cid: string): Promise<void> {
  const mine = (kind: 'answer' | 'candidate'): Envelope[] => env.hub.sentBy(node.self.peer, kind).filter((envelope) => cidOf(envelope) === cid);
  await until(() => mine('answer').length > 0 && mine('candidate').length > 0, 'mesh 의 answer 와 후보');
  raw.setRemote(sdpOf(mine('answer')[0]), 'answer');
  raw.addCandidates(candidatesOf(mine('candidate')));
}

describe('V-U11 mesh: 접촉과 링크 (실제 라이브러리)', () => {
  scenario('이름이 작은 쪽이 offer 를 보내고 링크가 열린다. 상대 sid 는 시도의 시그널에 붙은 값이다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    assert.deepEqual(alice.mesh.links(), []);
    alice.mesh.contact('bob');
    assert.deepEqual(alice.mesh.links(), [{ peer: 'bob', sid: null, state: 'connecting' }], '시그널을 받기 전에는 상대 sid 를 모른다');
    await until(() => alice.opens.length === 1 && bob.opens.length === 1, '양쪽 link-open');

    const cid = `${ALICE.sid}.1`;
    assert.deepEqual(alice.opens, [{ peer: 'bob', sid: BOB.sid, cid }]);
    assert.deepEqual(bob.opens, [{ peer: 'alice', sid: ALICE.sid, cid }], '목록에 없던 피어의 offer 도 받는다');
    assert.deepEqual(alice.mesh.links(), [{ peer: 'bob', sid: BOB.sid, state: 'open' }]);
    assert.deepEqual(kinds(env.hub.sent).slice(0, 2), ['alice>bob:offer', 'bob>alice:answer']);
    assert.equal(env.hub.sentBy('bob', 'offer').length, 0, 'offer 는 이름이 작은 쪽만 만든다');
    assert.deepEqual([alice.fails, bob.fails, alice.closes, bob.closes], [[], [], [], []]);
    const end = alice.log.named('link.attempt_end')[0]?.fields;
    assert.equal(end?.outcome, 'ok');
    assert.equal(end?.cid, cid);
    assert.equal(end?.resends, 0);
    assert.equal(end?.queued_applied, 0);
  });

  scenario('이름이 큰 쪽은 cid 없는 offer-request 를 보내고 상대의 offer 를 기다린다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    bob.mesh.contact('alice');
    await until(() => alice.opens.length === 1 && bob.opens.length === 1, '양쪽 link-open');
    assert.deepEqual(kinds(env.hub.sent).slice(0, 3), ['bob>alice:offer-request', 'alice>bob:offer', 'bob>alice:answer']);
    assert.deepEqual(env.hub.sent[0]?.payload, { kind: 'offer-request', data: {} });
    assert.equal(bob.opens[0]?.cid, `${ALICE.sid}.1`);
  });

  scenario('양쪽이 동시에 접촉해도 연결은 하나다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    alice.mesh.contact('bob');
    bob.mesh.contact('alice');
    await until(() => alice.opens.length === 1 && bob.opens.length === 1, '양쪽 link-open');
    await env.hub.settle();
    await sleep(150);
    assert.equal(alice.opens.length, 1);
    assert.equal(bob.opens.length, 1);
    assert.equal(alice.mesh.links().length, 1);
    assert.equal(bob.mesh.links().length, 1);
    assert.equal(new Set(env.hub.sentBy('alice', 'offer').map(cidOf)).size, 1, 'offer-request 를 받아도 새 cid 를 만들지 않는다');
    assert.deepEqual([alice.fails, bob.fails, alice.closes, bob.closes], [[], [], [], []]);
  });

  scenario('열린 링크나 진행 중인 시도가 있으면 contact 는 아무 것도 하지 않는다', async (env) => {
    const alice = await env.node(ALICE);
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    alice.mesh.contact('bob');
    alice.mesh.contact('alice');
    await until(() => env.hub.sentBy('alice', 'offer').length > 0, 'offer');
    await sleep(150);
    assert.equal(env.hub.sentBy('alice', 'offer').length, 1);
    assert.equal(alice.mesh.links().length, 1, '자기 자신과는 시도하지 않는다');
  });

  scenario('열린 링크로 프레임을 그대로 주고받는다. ping·pong 은 올리지 않고 peer-ping 으로 알린다', async (env) => {
    const { alice, bob } = await connected(env);
    assert.equal(alice.mesh.send('bob', '{"v":1,"t":"chat","text":"안녕"}'), 'ok');
    assert.equal(bob.mesh.send('alice', 'not even json'), 'ok');
    await until(() => bob.frames.length === 1 && alice.frames.length === 1, '프레임');
    assert.deepEqual(bob.frames, [{ peer: 'alice', text: '{"v":1,"t":"chat","text":"안녕"}' }]);
    assert.deepEqual(alice.frames, [{ peer: 'bob', text: 'not even json' }], '해석과 검사는 받는 쪽이 한다');

    env.clock.jump(LIMITS.P2P_PING_INTERVAL_MS);
    await until(() => alice.pings.length === 1 && bob.pings.length === 1, 'peer-ping');
    assert.deepEqual(bob.pings, [{ peer: 'alice', ...PING_INFO }]);
    await sleep(30);
    assert.equal(alice.frames.length + bob.frames.length, 2, 'ping 과 pong 은 frame 으로 올리지 않는다');
  });

  scenario('send 는 링크가 없으면 not_open, 상한을 넘으면 too_large 다', async (env) => {
    const { alice, bob } = await connected(env);
    assert.equal(alice.mesh.send('nobody', 'x'), 'not_open');
    assert.equal(alice.mesh.send('bob', 'x'.repeat(LIMITS.P2P_MAX_FRAME_BYTES)), 'ok');
    assert.equal(alice.mesh.send('bob', 'x'.repeat(LIMITS.P2P_MAX_FRAME_BYTES + 1)), 'too_large');
    assert.equal(alice.mesh.send('bob', '가'.repeat(30_000)), 'too_large', '바이트로 센다');
    await until(() => bob.frames.length === 1, '상한 크기의 프레임');
    assert.equal(bob.frames[0]?.text.length, LIMITS.P2P_MAX_FRAME_BYTES);
    env.hub.route = () => 'drop';
    bob.mesh.contact('carol');
    assert.equal(bob.mesh.send('carol', 'x'), 'not_open', '시도 중인 피어에게는 보내지 못한다');
  });

  scenario('closeLink 는 준 사유로 link-closed 를 내고, 상대는 closed 로 본다. 직전에 보낸 프레임은 도착한다', async (env) => {
    const { alice, bob } = await connected(env);
    assert.equal(alice.mesh.send('bob', '{"v":1,"t":"bye","reason":"leave"}'), 'ok');
    alice.mesh.closeLink('bob', 'bye_sent');
    assert.deepEqual(alice.closes, [{ peer: 'bob', sid: BOB.sid, reason: 'bye_sent' }], '호출 안에서 낸다');
    assert.deepEqual(alice.mesh.links(), []);
    await until(() => bob.closes.length === 1, '상대의 link-closed');
    assert.deepEqual(bob.closes, [{ peer: 'alice', sid: ALICE.sid, reason: 'closed' }]);
    assert.deepEqual(bob.frames.map((frame) => frame.text), ['{"v":1,"t":"bye","reason":"leave"}']);
    alice.mesh.closeLink('bob', 'again');
    assert.equal(alice.closes.length, 1);
    const closed = alice.log.named('link.closed')[0]?.fields;
    assert.equal(closed?.reason, 'bye_sent');
    assert.equal(typeof closed?.open_ms, 'number');
    assert.equal(typeof closed?.last_alive_age_ms, 'number');
  });

  scenario('닫힘 통지가 마지막 프레임의 콜백과 한꺼번에 쌓여도 프레임을 먼저 올리고 링크를 닫는다', async (env) => {
    const { alice, bob } = await connected(env);
    const seen: string[] = [];
    bob.mesh.on('frame', (frame) => seen.push(`frame:${frame.text}`));
    bob.mesh.on('link-closed', (link) => seen.push(`closed:${link.reason}`));
    for (const text of ['one', 'two', '{"v":1,"t":"bye","reason":"leave"}']) assert.equal(alice.mesh.send('bob', text), 'ok');
    alice.mesh.closeLink('bob', 'bye_sent');
    // 이벤트 루프를 붙잡아 받는 쪽의 프레임 콜백과 닫힘 콜백이 한 박자에 쌓이게 한다.
    const busyUntil = Date.now() + 40;
    while (Date.now() < busyUntil) {
      // 기다린다.
    }
    await until(() => bob.closes.length === 1, '상대의 link-closed');
    assert.deepEqual(seen, ['frame:one', 'frame:two', 'frame:{"v":1,"t":"bye","reason":"leave"}', 'closed:closed']);
  });

  scenario('진행 중인 시도만 있으면 closeLink 는 아무 것도 하지 않는다', async (env) => {
    const alice = await env.node(ALICE);
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    alice.mesh.closeLink('bob', 'nope');
    assert.deepEqual(alice.order, []);
    assert.equal(alice.mesh.links()[0]?.state, 'connecting');
  });
});

describe('V-U11 mesh: 후보 처리의 세 갈래 (실제 라이브러리)', () => {
  scenario('offer 보다 먼저 온 후보는 대기 큐에 두었다가 offer 뒤에 넣는다. answer 쪽 후보를 모두 버려도 그것만으로 연결된다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    let passed = 0;
    env.hub.route = (envelope) => {
      if (envelope.from === 'alice' && envelope.payload.kind === 'offer') return 'hold';
      if (envelope.from === 'bob' && envelope.payload.kind === 'candidate') return 'drop';
      if (envelope.from === 'alice' && envelope.payload.kind === 'candidate') {
        passed += 1;
        return passed === 1 ? 'pass' : 'drop';
      }
      return 'pass';
    };
    alice.mesh.contact('bob');
    await until(() => passed >= 1, 'offer 쪽의 첫 후보 묶음');
    await env.hub.settle();
    assert.deepEqual(bob.mesh.links(), [], 'offer 가 오기 전에는 시도가 없다');
    // 후보가 먼저 도착한 뒤에 offer 를 한 번만 전달한다.
    const offer = env.hub.held[0];
    assert.ok(offer !== undefined);
    env.hub.deliver(offer);
    await until(() => alice.isOpen('bob') && bob.isOpen('alice'), '링크');
    const end = bob.log.named('link.attempt_end')[0]?.fields;
    assert.equal(end?.outcome, 'ok');
    assert.ok(Number(end?.queued_applied) >= 1, `대기 큐에서 꺼내 넣은 후보 수: ${String(end?.queued_applied)}`);
    assert.equal(end?.queued_applied, end?.cand_remote_host, '받은 후보는 모두 대기 큐를 거쳤다');
    assert.equal(alice.log.named('link.attempt_end')[0]?.fields.cand_remote_host, 0, 'answer 쪽 후보는 하나도 받지 못했다');
  });

  scenario('answer 보다 먼저 온 후보는 시도 큐에 두었다가 answer 뒤에 넣는다. offer 쪽 후보를 모두 버려도 그것만으로 연결된다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    let passed = 0;
    env.hub.route = (envelope) => {
      if (envelope.from === 'bob' && envelope.payload.kind === 'answer') return 'hold';
      if (envelope.from === 'alice' && envelope.payload.kind === 'candidate') return 'drop';
      if (envelope.from === 'bob' && envelope.payload.kind === 'candidate') {
        passed += 1;
        return passed === 1 ? 'pass' : 'drop';
      }
      return 'pass';
    };
    alice.mesh.contact('bob');
    await until(() => passed >= 1 && env.hub.held.length >= 1, 'answer 쪽의 첫 후보 묶음과 붙잡은 answer');
    await env.hub.settle();
    await sleep(50);
    assert.equal(alice.isOpen('bob'), false, 'answer 없이는 열리지 않는다');
    const answer = env.hub.held[0];
    assert.ok(answer !== undefined);
    env.hub.deliver(answer);
    await until(() => alice.isOpen('bob') && bob.isOpen('alice'), '링크');
    const end = alice.log.named('link.attempt_end')[0]?.fields;
    assert.ok(Number(end?.cand_remote_host) >= 1, 'answer 전에 받은 후보를 셌다');
    assert.equal(end?.queued_applied, 0, '시도 큐는 대기 큐가 아니다');
    assert.equal(bob.log.named('link.attempt_end')[0]?.fields.cand_remote_host, 0, 'offer 쪽 후보는 하나도 받지 못했다');
  });

  scenario('옛 시도의 후보는 버리고, 현재 시도의 후보는 넣고, 더 큰 순번의 후보는 대기 큐에 둔다', async (env) => {
    const bob = await env.node(BOB);
    const raws = await env.raws();
    const raw = await raws.offer();
    const candidate = (cid: string, items: RawItem[]): ServerSignalMessage => signalFrom(ALICE, { kind: 'candidate', cid, data: { list: items } });

    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.2`, data: { sdp: raw.sdp } }));
    bob.mesh.handleSignal(candidate(`${ALICE.sid}.1`, [hostCandidate(1), hostCandidate(2)]));
    bob.mesh.handleSignal(candidate(`${ALICE.sid}.2`, [hostCandidate(3)]));
    bob.mesh.handleSignal(candidate(`${ALICE.sid}.2`, [hostCandidate(3), hostCandidate(4)]));
    bob.mesh.handleSignal(candidate(`${ALICE.sid}.3`, [hostCandidate(5), hostCandidate(6), hostCandidate(7)]));
    // cid 의 앞부분이 offer 쪽 sid 가 아니면 버린다.
    bob.mesh.handleSignal(candidate('zzzzzzzzzzzz.2', [hostCandidate(8)]));

    // 더 큰 순번의 offer 가 오면 시도가 그 cid 로 바뀌고, 대기 큐의 후보를 넣는다.
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.3`, data: { sdp: raw.sdp } }));
    bob.mesh.expireAttempt('alice');
    assert.equal(bob.fails.length, 1);
    assert.deepEqual(bob.fails[0]?.diag.remote, { host: 3, srflx: 0 }, '바뀐 뒤의 시도는 대기 큐의 셋만 받았다');
    const end = bob.log.named('link.attempt_end')[0]?.fields;
    assert.equal(end?.queued_applied, 3);
    assert.equal(end?.cid, `${ALICE.sid}.3`);
  });

  scenario('현재 시도의 후보 수와 중복 무시를 센다(같은 후보 문자열은 한 번만 넣는다)', async (env) => {
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    const cid = `${ALICE.sid}.1`;
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid, data: { sdp: raw.sdp } }));
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid: `${ALICE.sid}.0`, data: { list: [hostCandidate(1)] } }));
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid, data: { list: [hostCandidate(3)] } }));
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid, data: { list: [hostCandidate(3), hostCandidate(4)] } }));
    bob.mesh.expireAttempt('alice');
    assert.deepEqual(bob.fails[0]?.diag.remote, { host: 2, srflx: 0 }, '옛 cid 의 후보는 세지 않는다');
    assert.equal(bob.log.named('link.attempt_end')[0]?.fields.dup_ignored, 1);
  });

  scenario('대기 큐는 가장 큰 순번의 것만 담는다. 더 큰 순번이 오면 비우고, 더 작은 순번은 버린다', async (env) => {
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    const candidate = (seq: number, items: RawItem[]): ServerSignalMessage =>
      signalFrom(ALICE, { kind: 'candidate', cid: `${ALICE.sid}.${seq}`, data: { list: items } });
    bob.mesh.handleSignal(candidate(5, [hostCandidate(1), hostCandidate(2)]));
    bob.mesh.handleSignal(candidate(6, [hostCandidate(3)]));
    bob.mesh.handleSignal(candidate(5, [hostCandidate(4)]));
    bob.mesh.handleSignal(candidate(6, [hostCandidate(3), hostCandidate(5)]));
    assert.deepEqual(bob.mesh.links(), [], '후보만으로는 시도가 생기지 않는다');

    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.6`, data: { sdp: raw.sdp } }));
    bob.mesh.expireAttempt('alice');
    assert.deepEqual(bob.fails[0]?.diag.remote, { host: 2, srflx: 0 });
    assert.equal(bob.log.named('link.attempt_end')[0]?.fields.queued_applied, 2);
  });

  scenario('대기 큐는 첫 후보를 넣고 연결 기한이 지나면 비운다. 큐는 32건까지다', async (env) => {
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    env.clock.setRealtime(false);
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid: `${ALICE.sid}.1`, data: { list: [hostCandidate(1)] } }));
    env.clock.jump(LIMITS.PEER_CONNECT_TIMEOUT_MS);
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.1`, data: { sdp: raw.sdp } }));
    bob.mesh.expireAttempt('alice');
    assert.equal(bob.log.named('link.attempt_end')[0]?.fields.queued_applied, 0, '기한이 지난 대기 큐는 비었다');

    const many = Array.from({ length: 30 }, (_, index) => hostCandidate(index + 10));
    const more = Array.from({ length: 30 }, (_, index) => hostCandidate(index + 100));
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid: `${ALICE.sid}.2`, data: { list: many } }));
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid: `${ALICE.sid}.2`, data: { list: more } }));
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.2`, data: { sdp: raw.sdp } }));
    bob.mesh.expireAttempt('alice');
    assert.equal(bob.log.named('link.attempt_end')[1]?.fields.queued_applied, LIMITS.CANDIDATE_QUEUE_MAX);
  });

  scenario('offer 쪽의 시도 큐도 32건까지다', async (env) => {
    const alice = await env.node(ALICE);
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    const cid = `${ALICE.sid}.1`;
    const many = Array.from({ length: 30 }, (_, index) => hostCandidate(index + 10));
    const more = Array.from({ length: 30 }, (_, index) => hostCandidate(index + 100));
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'candidate', cid, data: { list: many } }));
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'candidate', cid, data: { list: more } }));
    alice.mesh.expireAttempt('bob');
    assert.deepEqual(alice.fails[0]?.diag.remote, { host: LIMITS.CANDIDATE_QUEUE_MAX, srflx: 0 });
    assert.equal(alice.fails[0]?.reason, 'no_answer');
  });
});

describe('V-U11 mesh: 재전송 표 (실제 라이브러리)', () => {
  scenario('offer-request 를 보냈고 offer 를 못 받았으면 3초마다 offer-request 를 다시 보낸다. 최대 4회이고 15초에 no_offer 다', async (env) => {
    const bob = await env.node(BOB);
    env.clock.setRealtime(false);
    bob.mesh.contact('alice');
    assert.deepEqual(kinds(env.hub.sent), ['bob>alice:offer-request']);
    for (let round = 1; round <= 4; round += 1) {
      env.clock.jump(LIMITS.SIGNAL_RESEND_MS - 1);
      assert.equal(env.hub.sent.length, round, `${round}번째 주기 직전`);
      env.clock.jump(1);
      assert.equal(env.hub.sent.length, round + 1, `${round}번째 재전송`);
    }
    assert.ok(env.hub.sent.every((envelope) => envelope.payload.kind === 'offer-request'));
    env.clock.jump(LIMITS.SIGNAL_RESEND_MS - 1);
    assert.equal(bob.fails.length, 0, '기한 전에는 끝내지 않는다');
    env.clock.jump(1);
    assert.equal(env.hub.sent.length, 5, '주기 재전송은 한 시도에 4회까지다');
    assert.equal(bob.fails.length, 1);
    const failure = bob.fails[0];
    assert.deepEqual([failure?.peer, failure?.stage, failure?.reason], ['alice', 'signaling', 'no_offer']);
    assert.deepEqual(failure?.diag, {
      ice_state: 'none',
      pc_state: 'none',
      local: { host: 0, srflx: 0 },
      remote: { host: 0, srflx: 0 },
      resends: 4,
      duration_ms: LIMITS.PEER_CONNECT_TIMEOUT_MS,
    });
    assert.deepEqual(bob.mesh.links(), []);
    assert.deepEqual(bob.log.named('signal.resend').map((entry) => [entry.fields.kind, entry.fields.cause, entry.fields.resends]), [
      ['offer-request', 'periodic', 1],
      ['offer-request', 'periodic', 2],
      ['offer-request', 'periodic', 3],
      ['offer-request', 'periodic', 4],
    ]);
    env.clock.jump(60_000);
    assert.equal(env.hub.sent.length, 5, '끝난 시도는 다시 보내지 않는다');
    assert.equal(bob.fails.length, 1);
  });

  scenario('offer 를 보냈고 answer 를 못 받았으면 같은 cid 의 offer 와 지금까지 모은 후보 묶음을 다시 보낸다. 15초에 no_answer 다', async (env) => {
    const alice = await env.node(ALICE);
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('alice', 'offer').length === 1 && env.hub.sentBy('alice', 'candidate').length >= 1, 'offer 와 첫 후보 묶음');
    await sleep(150);
    env.clock.setRealtime(false);
    const firstOffer = env.hub.sentBy('alice', 'offer')[0];
    const gathered = candidatesOf(env.hub.sentBy('alice', 'candidate'));
    const batches = env.hub.sentBy('alice', 'candidate').length;

    for (let round = 1; round <= 4; round += 1) {
      env.clock.jump(LIMITS.SIGNAL_RESEND_MS);
      const offers = env.hub.sentBy('alice', 'offer');
      assert.equal(offers.length, 1 + round, `${round}번째 재전송`);
      assert.deepEqual(offers.at(-1)?.payload, firstOffer?.payload, '같은 cid, 같은 SDP 다');
      const resent = env.hub.sentBy('alice', 'candidate').at(-1);
      assert.equal(env.hub.sentBy('alice', 'candidate').length, batches + round);
      assert.deepEqual(candidatesOf(resent === undefined ? [] : [resent]), gathered, '지금까지 모은 후보 전부다');
      assert.equal(cidOf(resent), cidOf(firstOffer));
    }
    env.clock.jump(LIMITS.SIGNAL_RESEND_MS);
    assert.equal(env.hub.sentBy('alice', 'offer').length, 5);
    assert.equal(alice.fails.length, 1);
    const failure = alice.fails[0];
    assert.deepEqual([failure?.stage, failure?.reason, failure?.diag.resends], ['signaling', 'no_answer', 4]);
    assert.equal(failure?.diag.local.host, gathered.length);
    assert.notEqual(failure?.diag.pc_state, 'none', '라이브러리가 준 상태 이름이다');
    assert.deepEqual(alice.mesh.links(), []);
  });

  scenario('answer 를 주고받았고 채널이 아직 안 열렸으면 offer 쪽은 후보 묶음만, 답한 쪽은 같은 answer 와 후보 묶음을 다시 보낸다. 15초에 ice_timeout 이다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    // 양방향 후보를 모두 버리면 같은 PC 에서도 직접 경로가 생기지 않는다.
    env.hub.route = (envelope) => (envelope.payload.kind === 'candidate' ? 'drop' : 'pass');
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('bob', 'answer').length === 1 && env.hub.sentBy('bob', 'candidate').length >= 1, 'answer 와 후보');
    await env.hub.settle();
    await sleep(150);
    env.clock.setRealtime(false);
    const before = env.hub.sent.length;
    env.clock.jump(LIMITS.SIGNAL_RESEND_MS);
    const resent = env.hub.sent.slice(before);
    assert.deepEqual(
      kinds(resent).sort(),
      ['alice>bob:candidate', 'bob>alice:answer', 'bob>alice:candidate'],
      'offer 쪽은 후보 묶음만, 답한 쪽은 answer 와 후보 묶음을 다시 보낸다(검토 1차 총괄 결정 2-가)',
    );
    assert.ok(resent.every((envelope) => cidOf(envelope) === `${ALICE.sid}.1`));
    const answers = env.hub.sentBy('bob', 'answer');
    assert.deepEqual(answers.at(-1)?.payload, answers[0]?.payload, '처음 만든 answer 그대로다');

    // 다시 보낸 answer 가 offer 쪽에 닿도록 주기마다 전달을 기다린다(전달은 다음 박자다).
    await env.hub.settle();
    for (let elapsed = LIMITS.SIGNAL_RESEND_MS; elapsed < LIMITS.PEER_CONNECT_TIMEOUT_MS + LIMITS.SIGNAL_RESEND_MS; elapsed += LIMITS.SIGNAL_RESEND_MS) {
      env.clock.jump(LIMITS.SIGNAL_RESEND_MS);
      await env.hub.settle();
    }
    assert.equal(env.hub.sentBy('alice', 'offer').length, 1, 'answer 를 받은 뒤에는 offer 를 다시 보내지 않는다');
    assert.equal(env.hub.sentBy('bob', 'answer').length, 1 + LIMITS.SIGNAL_RESEND_MAX, '주기 재전송은 한 시도에 4회까지다');
    assert.equal(alice.log.named('link.attempt_end')[0]?.fields.dup_ignored, LIMITS.SIGNAL_RESEND_MAX, 'offer 쪽은 중복 answer 를 무시한다');
    for (const node of [alice, bob]) {
      assert.equal(node.fails.length, 1, node.self.peer);
      assert.deepEqual([node.fails[0]?.stage, node.fails[0]?.reason, node.fails[0]?.diag.resends], ['ice', 'ice_timeout', 4]);
      assert.deepEqual(node.fails[0]?.diag.remote, { host: 0, srflx: 0 });
      assert.deepEqual([node.opens, node.closes], [[], []], '열리지 못한 시도는 link-open 도 link-closed 도 내지 않는다');
    }
  });

  scenario('answer 만 계속 사라지면 답한 쪽도 signaling/no_answer 로 끝난다(ICE 는 연결됐으므로 ice 로 나누지 않는다)', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    // 답한 쪽의 answer 만 버린다. 후보와 다시 보낸 offer 는 지나간다(W9 공용 서버 P-W9P-08 의 모양).
    env.hub.route = (envelope) => (envelope.payload.kind === 'answer' ? 'drop' : 'pass');
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('bob', 'answer').length >= 1 && env.hub.sentBy('bob', 'candidate').length >= 1, '버려진 answer 와 후보');
    // ICE 검사가 끝날 시간을 실제 시간으로 준다. 같은 PC 에서는 수십 ms 다.
    await sleep(1_500);
    env.clock.setRealtime(false);
    for (let elapsed = 0; elapsed < LIMITS.PEER_CONNECT_TIMEOUT_MS; elapsed += LIMITS.SIGNAL_RESEND_MS) {
      env.clock.jump(LIMITS.SIGNAL_RESEND_MS);
      await env.hub.settle();
    }
    assert.equal(alice.fails.length, 1);
    assert.deepEqual([alice.fails[0]?.stage, alice.fails[0]?.reason], ['signaling', 'no_answer'], 'offer 쪽은 answer 를 받지 못했다');
    assert.equal(bob.fails.length, 1);
    const bobFail = bob.fails[0];
    assert.deepEqual(
      [bobFail?.stage, bobFail?.reason, bobFail?.diag.ice_state],
      ['signaling', 'no_answer', 'connected'],
      '답한 쪽: ICE 는 연결됐으니 직접 경로 없음(ice)으로 나누지 않는다',
    );
    assert.ok(env.hub.sentBy('bob', 'answer').length >= 2, '중복 offer 에 같은 answer 를 다시 보냈다');
  });

  scenario('게이트웨이 프레임(resendPending)과 SERVER_ERROR 는 바로 다시 보내되 한 시도에서 1초보다 자주 하지 않는다', async (env) => {
    const alice = await env.node(ALICE);
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('alice', 'offer').length === 1 && env.hub.sentBy('alice', 'candidate').length >= 1, 'offer 와 후보');
    await sleep(150);
    env.clock.setRealtime(false);
    const cid = `${ALICE.sid}.1`;
    const offers = (): number => env.hub.sentBy('alice', 'offer').length;

    alice.mesh.resendPending();
    assert.equal(offers(), 2, '바로 다시 보낸다');
    alice.mesh.resendPending();
    alice.mesh.handleRelayError({ to: 'bob', cid, code: 'SERVER_ERROR' });
    assert.equal(offers(), 2, '1초 안에는 다시 보내지 않는다');
    env.clock.jump(LIMITS.SIGNAL_RESEND_MIN_GAP_MS - 1);
    alice.mesh.handleRelayError({ to: 'bob', cid, code: 'SERVER_ERROR' });
    assert.equal(offers(), 2);
    env.clock.jump(1);
    alice.mesh.handleRelayError({ to: 'bob', cid, code: 'SERVER_ERROR' });
    assert.equal(offers(), 3);
    assert.equal(alice.fails.length, 0, '시도는 이어진다');
    assert.deepEqual(alice.log.named('signal.resend').map((entry) => entry.fields.cause), ['gateway_frame', 'server_error']);
    assert.ok(env.hub.sentBy('alice', 'offer').every((envelope) => cidOf(envelope) === cid), '새 cid 를 만들지 않는다');

    alice.mesh.expireAttempt('bob');
    assert.equal(alice.fails[0]?.diag.resends, 2, '재전송 횟수는 주기와 즉시를 합친 값이다');
  });

  scenario('같은 offer 를 또 받으면 처음 만든 answer 와 후보 묶음을 다시 보낸다. answer 를 새로 만들지 않는다', async (env) => {
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    const cid = `${ALICE.sid}.1`;
    const offer = signalFrom(ALICE, { kind: 'offer', cid, data: { sdp: raw.sdp } });
    bob.mesh.handleSignal(offer);
    await until(() => env.hub.sentBy('bob', 'answer').length === 1 && env.hub.sentBy('bob', 'candidate').length >= 1, 'answer 와 후보');
    await sleep(150);
    const first = env.hub.sentBy('bob', 'answer')[0];
    const batches = env.hub.sentBy('bob', 'candidate').length;

    bob.mesh.handleSignal(offer);
    bob.mesh.handleSignal(offer);
    await sleep(100);
    const answers = env.hub.sentBy('bob', 'answer');
    assert.equal(answers.length, 3);
    assert.deepEqual(answers[1]?.payload, first?.payload, '처음 만든 answer 그대로다');
    assert.deepEqual(answers[2]?.payload, first?.payload);
    assert.equal(env.hub.sentBy('bob', 'candidate').length, batches + 2);
    assert.equal(bob.fails.length, 0);
    assert.equal(bob.mesh.links().length, 1, '시도는 하나다');

    // 중복 offer 로 pc 를 새로 만들지 않았으므로 처음 만든 answer 로 열린다.
    await completeWithRawOfferer(env, bob, raw, cid);
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid, data: { list: raw.candidates } }));
    await until(() => bob.isOpen('alice') && raw.isOpen(), '링크');
    const end = bob.log.named('link.attempt_end')[0]?.fields;
    assert.equal(end?.dup_ignored, 2);
    assert.equal(end?.resends, 2);
  });

  scenario('진행 중인 시도에 offer-request 가 오면 answer 전에는 offer 와 후보 묶음을, answer 뒤에는 후보 묶음만 다시 보낸다', async (env) => {
    const alice = await env.node(ALICE);
    const raws = await env.raws();
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('alice', 'offer').length === 1 && env.hub.sentBy('alice', 'candidate').length >= 1, 'offer 와 후보');
    await sleep(150);
    const request = signalFrom(BOB, { kind: 'offer-request', data: {} });
    let before = env.hub.sent.length;
    alice.mesh.handleSignal(request);
    assert.deepEqual(kinds(env.hub.sent.slice(before)), ['alice>bob:offer', 'alice>bob:candidate']);
    assert.equal(cidOf(env.hub.sent.at(-1)), `${ALICE.sid}.1`, '새 시도를 만들지 않는다');

    // answer 는 받았지만 후보를 받지 못해 아직 열리지 않은 상태.
    const raw = await raws.answer(sdpOf(env.hub.sentBy('alice', 'offer')[0]));
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'answer', cid: `${ALICE.sid}.1`, data: { sdp: raw.sdp } }));
    before = env.hub.sent.length;
    alice.mesh.handleSignal(request);
    assert.deepEqual(kinds(env.hub.sent.slice(before)), ['alice>bob:candidate']);
    assert.deepEqual(alice.mesh.links(), [{ peer: 'bob', sid: BOB.sid, state: 'connecting' }]);
  });

  scenario('이름이 큰 쪽이 받은 offer-request, 이름이 작은 쪽이 받은 offer 는 무시한다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer-request', data: {} }));
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'offer', cid: `${BOB.sid}.1`, data: { sdp: raw.sdp } }));
    alice.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer-request', data: {} }));
    await sleep(50);
    assert.deepEqual(env.hub.sent, []);
    assert.deepEqual([alice.mesh.links(), bob.mesh.links()], [[], []]);
  });

  scenario('전송 함수가 false 를 돌려줘도 시도는 이어지고 주기 재전송이 메운다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    env.hub.setOnline('alice', false);
    alice.mesh.contact('bob');
    await sleep(200);
    assert.deepEqual(env.hub.sent, [], '등록 전이라 아무 것도 나가지 않았다');
    assert.equal(alice.mesh.links()[0]?.state, 'connecting');
    env.hub.setOnline('alice', true);
    env.clock.jump(LIMITS.SIGNAL_RESEND_MS);
    await until(() => alice.isOpen('bob') && bob.isOpen('alice'), '링크');
    assert.equal(alice.log.named('link.attempt_end')[0]?.fields.resends, 1);
  });
});

describe('V-U11 mesh: 시도의 끝과 바뀜 (실제 라이브러리)', () => {
  scenario('열린 시도는 link-open 한 번과 link-closed 한 번, 열리지 못한 시도는 attempt-failed 한 번으로 끝난다', async (env) => {
    const { alice, bob } = await connected(env);
    alice.mesh.closeLink('bob', 'done');
    await until(() => bob.closes.length === 1, '상대의 닫힘');
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    alice.mesh.expireAttempt('bob');
    alice.mesh.expireAttempt('bob');
    await sleep(100);
    assert.deepEqual(alice.order, [`open:bob:${ALICE.sid}.1`, 'closed:bob:done', 'failed:bob:signaling/no_answer']);
    assert.deepEqual(bob.order, [`open:alice:${ALICE.sid}.1`, 'closed:alice:closed']);
    assert.deepEqual(alice.mesh.links(), []);
  });

  const swaps: readonly { title: string; next: { peer: string; sid: string }; seq: number }[] = [
    { title: '다른 sid 의 offer(다시 시작한 상대)', next: { peer: 'alice', sid: 'a2a2a2a2a2a2' }, seq: 1 },
    { title: '같은 sid 의 더 큰 순번(먼저 포기하고 다시 건 상대)', next: { peer: 'alice', sid: ALICE.sid }, seq: 2 },
  ];
  for (const { title, next, seq } of swaps) {
    scenario(`진행 중인 시도가 ${title}로 바뀌어도 attempt-failed 가 없고, 기한을 바뀐 때부터 새로 재며, 새 pc 로 열리면 link-open 이 한 번 난다`, async (env) => {
      const bob = await env.node(BOB);
      const raws = await env.raws();
      const first = await raws.offer();
      const second = await raws.offer();
      const firstCid = `${ALICE.sid}.1`;
      const nextCid = `${next.sid}.${seq}`;
      env.clock.setRealtime(false);

      bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: firstCid, data: { sdp: first.sdp } }));
      bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid: firstCid, data: { list: [hostCandidate(1)] } }));
      env.clock.jump(10_000);
      assert.deepEqual(bob.mesh.links(), [{ peer: 'alice', sid: ALICE.sid, state: 'connecting' }]);
      const resendsBefore = bob.log.named('signal.resend').length;

      bob.mesh.handleSignal(signalFrom(next, { kind: 'offer', cid: nextCid, data: { sdp: second.sdp } }));
      assert.deepEqual(bob.mesh.links(), [{ peer: 'alice', sid: next.sid, state: 'connecting' }]);
      assert.equal(first.isOpen(), false);
      // 처음 시작한 때부터는 16초로 기한을 넘겼다. 바뀐 때부터는 6초다.
      env.clock.jump(6_000);
      assert.equal(bob.fails.length, 0, '바뀜은 실패가 아니고 기한은 바뀐 때부터다');
      assert.deepEqual(bob.order, []);

      // 옛 시도의 늦은 시그널과 서버 오류는 아무 것도 바꾸지 않는다.
      bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'candidate', cid: firstCid, data: { list: [hostCandidate(2)] } }));
      bob.mesh.handleRelayError({ to: 'alice', cid: firstCid, code: 'PEER_NOT_FOUND' });
      bob.mesh.handleRelayError({ to: 'alice', cid: firstCid, code: 'RELAY_NOT_ALLOWED' });
      assert.deepEqual(bob.order, []);

      env.clock.setRealtime(true);
      bob.mesh.handleSignal(signalFrom(next, { kind: 'candidate', cid: nextCid, data: { list: second.candidates } }));
      await completeWithRawOfferer(env, bob, second, nextCid);
      await until(() => bob.isOpen('alice') && second.isOpen(), '새 pc 의 링크');
      assert.deepEqual(bob.opens, [{ peer: 'alice', sid: next.sid, cid: nextCid }]);
      assert.deepEqual(bob.order, [`open:alice:${nextCid}`]);
      assert.equal(first.isOpen(), false, '옛 pc 로는 열리지 않았다');
      const end = bob.log.named('link.attempt_end');
      assert.equal(end.length, 1, '시도의 끝은 하나다');
      assert.equal(end[0]?.fields.cid, nextCid);
      const resendsAfter = bob.log.named('signal.resend').length - resendsBefore;
      assert.equal(end[0]?.fields.resends, resendsAfter, '재전송 횟수는 바뀐 뒤의 것만 센다');
      assert.equal(end[0]?.fields.cand_remote_host, second.candidates.filter((item) => / typ host/.test(item.candidate)).length, '후보 수도 바뀐 뒤의 것만 센다');
    });
  }

  scenario('바뀐 시도가 열리지 못하면 바뀐 때부터 15초에 ice_timeout 한 번으로 끝난다. 걸린 시간도 바뀐 때부터다', async (env) => {
    const bob = await env.node(BOB);
    const raws = await env.raws();
    const first = await raws.offer();
    const second = await raws.offer();
    env.clock.setRealtime(false);
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.1`, data: { sdp: first.sdp } }));
    env.clock.jump(12_000);
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.2`, data: { sdp: second.sdp } }));
    const swappedAt = env.clock.now();
    // 새 pc 가 answer 와 후보를 낼 시간을 준다. 그래야 주기 재전송에 보낼 것이 있다.
    env.clock.setRealtime(true);
    await until(() => env.hub.sentBy('bob', 'candidate').some((envelope) => cidOf(envelope) === `${ALICE.sid}.2`), '새 pc 의 후보');
    env.clock.setRealtime(false);
    env.clock.jump(swappedAt + LIMITS.PEER_CONNECT_TIMEOUT_MS - 1 - env.clock.now());
    assert.equal(bob.fails.length, 0);
    env.clock.jump(1);
    assert.equal(bob.fails.length, 1);
    assert.deepEqual([bob.fails[0]?.stage, bob.fails[0]?.reason], ['ice', 'ice_timeout']);
    assert.equal(bob.fails[0]?.diag.duration_ms, LIMITS.PEER_CONNECT_TIMEOUT_MS);
    assert.equal(bob.fails[0]?.diag.resends, 4);
    assert.equal(bob.log.named('link.attempt_end')[0]?.fields.cid, `${ALICE.sid}.2`);
  });

  scenario('같은 sid 에서 이미 본 것보다 작은 순번의 offer 는 무시한다(늦게 온 옛 offer)', async (env) => {
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.5`, data: { sdp: raw.sdp } }));
    await until(() => env.hub.sentBy('bob', 'answer').length === 1, 'answer');
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.4`, data: { sdp: raw.sdp } }));
    await sleep(100);
    assert.deepEqual(env.hub.sentBy('bob', 'answer').map(cidOf), [`${ALICE.sid}.5`]);
    bob.mesh.expireAttempt('alice');
    assert.equal(bob.log.named('link.attempt_end')[0]?.fields.cid, `${ALICE.sid}.5`);
    // 시도가 끝난 뒤에도 옛 순번은 받지 않는다.
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.4`, data: { sdp: raw.sdp } }));
    assert.deepEqual(bob.mesh.links(), []);
  });

  scenario('offer-request 를 보내고 기다리던 시도가 첫 offer 를 받는 것은 바뀜이 아니다. 기한을 새로 재지 않는다', async (env) => {
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    env.clock.setRealtime(false);
    bob.mesh.contact('alice');
    env.clock.jump(10_000);
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.1`, data: { sdp: raw.sdp } }));
    assert.deepEqual(bob.mesh.links(), [{ peer: 'alice', sid: ALICE.sid, state: 'connecting' }]);
    env.clock.jump(4_999);
    assert.equal(bob.fails.length, 0);
    env.clock.jump(1);
    assert.equal(bob.fails.length, 1, '처음 시작한 때부터 15초다');
    assert.deepEqual([bob.fails[0]?.stage, bob.fails[0]?.reason], ['ice', 'ice_timeout']);
    assert.equal(bob.fails[0]?.diag.duration_ms, LIMITS.PEER_CONNECT_TIMEOUT_MS);
    assert.ok((bob.fails[0]?.diag.resends ?? 0) >= 3, 'offer-request 재전송도 같은 시도의 것이다');
  });

  scenario('현재 시도와 cid 가 다르거나 이미 적용한 answer 는 무시한다. 받아들일 수 없는 answer 로 시도를 끝내지 않는다', async (env) => {
    const alice = await env.node(ALICE);
    const raws = await env.raws();
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('alice', 'offer').length === 1, 'offer');
    const cid = `${ALICE.sid}.1`;
    const raw = await raws.answer(sdpOf(env.hub.sentBy('alice', 'offer')[0]));
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'answer', cid: `${ALICE.sid}.9`, data: { sdp: raw.sdp } }));
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'answer', cid: `${BOB.sid}.1`, data: { sdp: raw.sdp } }));
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'answer', cid, data: { sdp: 'v=0 not a real description' } }));
    assert.deepEqual(alice.mesh.links(), [{ peer: 'bob', sid: null, state: 'connecting' }], '아직 answer 를 받지 못한 상태다');
    assert.equal(alice.fails.length, 0);

    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'answer', cid, data: { sdp: raw.sdp } }));
    alice.mesh.handleSignal(signalFrom({ peer: 'bob', sid: 'b2b2b2b2b2b2' }, { kind: 'answer', cid, data: { sdp: raw.sdp } }));
    assert.deepEqual(alice.mesh.links(), [{ peer: 'bob', sid: BOB.sid, state: 'connecting' }], '처음 적용한 answer 의 sid 다');
    alice.mesh.handleSignal(signalFrom(BOB, { kind: 'candidate', cid, data: { list: raw.candidates } }));
    await until(() => alice.isOpen('bob'), '링크');
    assert.deepEqual(alice.opens, [{ peer: 'bob', sid: BOB.sid, cid }]);
  });
});

describe('V-U11 mesh: handleRelayError 와 expireAttempt (실제 라이브러리)', () => {
  scenario('RELAY_NOT_ALLOWED 는 attempt-failed{ice, failed} 한 번으로 끝내고 pc 를 닫는다. 원인은 로그의 error_code 로 남긴다', async (env) => {
    const alice = await env.node(ALICE);
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('alice', 'offer').length === 1, 'offer');
    const cid = `${ALICE.sid}.1`;
    alice.mesh.handleRelayError({ to: 'bob', cid, code: 'RELAY_NOT_ALLOWED' });
    alice.mesh.handleRelayError({ to: 'bob', cid, code: 'RELAY_NOT_ALLOWED' });
    assert.equal(alice.fails.length, 1);
    assert.deepEqual([alice.fails[0]?.peer, alice.fails[0]?.stage, alice.fails[0]?.reason], ['bob', 'ice', 'failed']);
    assert.deepEqual(alice.mesh.links(), []);
    const end = alice.log.named('link.attempt_end')[0];
    assert.equal(end?.level, 'error');
    assert.equal(end?.fields.error_code, 'RELAY_NOT_ALLOWED');
    env.clock.jump(60_000);
    assert.equal(alice.fails.length, 1);
  });

  scenario('PEER_NOT_FOUND 는 attempt-failed{signaling, peer_gone} 한 번으로 바로 끝낸다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    bob.mesh.contact('alice');
    alice.mesh.handleRelayError({ to: 'bob', cid: `${ALICE.sid}.1`, code: 'PEER_NOT_FOUND' });
    bob.mesh.handleRelayError({ to: 'alice', cid: null, code: 'PEER_NOT_FOUND' });
    for (const node of [alice, bob]) {
      assert.equal(node.fails.length, 1, node.self.peer);
      assert.deepEqual([node.fails[0]?.stage, node.fails[0]?.reason], ['signaling', 'peer_gone']);
      assert.deepEqual(node.mesh.links(), []);
    }
    alice.mesh.handleRelayError({ to: 'bob', cid: `${ALICE.sid}.1`, code: 'PEER_NOT_FOUND' });
    assert.equal(alice.fails.length, 1, '시도가 없으면 아무 것도 하지 않는다');
  });

  scenario('옛 cid 의 오류, cid 없는 오류(offer 를 기다리지 않을 때), 다른 피어의 오류는 아무 것도 바꾸지 않는다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    const raw = await (await env.raws()).offer();
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    for (const code of ['PEER_NOT_FOUND', 'SERVER_ERROR', 'RELAY_NOT_ALLOWED'] as const) {
      alice.mesh.handleRelayError({ to: 'bob', cid: `${ALICE.sid}.9`, code });
      alice.mesh.handleRelayError({ to: 'bob', cid: null, code });
      alice.mesh.handleRelayError({ to: 'carol', cid: `${ALICE.sid}.1`, code });
    }
    assert.deepEqual(alice.order, []);
    assert.equal(alice.mesh.links()[0]?.state, 'connecting');
    assert.equal(alice.log.named('signal.resend').length, 0);

    // offer 를 받은 뒤의 시도에는 offer-request 의 오류를 적용하지 않는다.
    bob.mesh.contact('alice');
    bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.1`, data: { sdp: raw.sdp } }));
    bob.mesh.handleRelayError({ to: 'alice', cid: null, code: 'PEER_NOT_FOUND' });
    assert.deepEqual(bob.order, []);
    bob.mesh.handleRelayError({ to: 'alice', cid: `${ALICE.sid}.1`, code: 'PEER_NOT_FOUND' });
    assert.deepEqual(bob.order, ['failed:alice:signaling/peer_gone']);
  });

  scenario('expireAttempt 는 진행 중인 시도를 상태에 맞는 분류로 그 호출 안에서 한 번 끝낸다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    const carol = await env.node({ peer: 'carol', sid: 'cccccccccccc' });
    const raw = await (await env.raws()).offer();
    env.hub.route = () => 'drop';

    bob.mesh.contact('alice');
    bob.mesh.expireAttempt('alice');
    assert.deepEqual(bob.order, ['failed:alice:signaling/no_offer']);

    alice.mesh.contact('bob');
    alice.mesh.expireAttempt('bob');
    assert.deepEqual(alice.order, ['failed:bob:signaling/no_answer']);

    carol.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.1`, data: { sdp: raw.sdp } }));
    carol.mesh.expireAttempt('alice');
    assert.deepEqual(carol.order, ['failed:alice:ice/ice_timeout']);

    for (const node of [alice, bob, carol]) {
      node.mesh.expireAttempt('alice');
      node.mesh.expireAttempt('bob');
      node.mesh.expireAttempt('nobody');
      assert.equal(node.fails.length, 1, `${node.self.peer}: 시도가 없으면 아무 것도 하지 않는다`);
      assert.deepEqual(node.mesh.links(), []);
    }
    env.clock.jump(60_000);
    assert.equal(alice.fails.length + bob.fails.length + carol.fails.length, 3, '끝낸 시도의 기한 타이머는 남지 않는다');
  });

  scenario('열린 링크만 있으면 expireAttempt 와 handleRelayError 는 아무 것도 하지 않는다', async (env) => {
    const { alice, bob } = await connected(env);
    alice.mesh.expireAttempt('bob');
    bob.mesh.expireAttempt('alice');
    alice.mesh.handleRelayError({ to: 'bob', cid: `${ALICE.sid}.1`, code: 'PEER_NOT_FOUND' });
    alice.mesh.resendPending();
    await sleep(50);
    assert.deepEqual([alice.fails, alice.closes, bob.fails, bob.closes], [[], [], [], []]);
    assert.equal(alice.isOpen('bob'), true);
  });
});

describe('V-U11 mesh: 교체 확인 (실제 라이브러리)', () => {
  scenario('살아 있는 링크에 offer-request 와 새 cid 의 offer 가 거듭 와도 링크를 유지하고 요청을 버린다', async (env) => {
    const { alice, bob } = await connected(env);
    const raw = await (await env.raws()).offer();
    const sentBefore = env.hub.sent.length;
    for (let round = 0; round < 20; round += 1) {
      alice.mesh.handleSignal(signalFrom(BOB, { kind: 'offer-request', data: {} }));
      bob.mesh.handleSignal(signalFrom({ peer: 'alice', sid: 'a2a2a2a2a2a2' }, { kind: 'offer', cid: `a2a2a2a2a2a2.${round + 1}`, data: { sdp: raw.sdp } }));
      await until(
        () => alice.log.named('link.replace_probe').length === round + 1 && bob.log.named('link.replace_probe').length === round + 1,
        `${round + 1}번째 확인의 결과`,
      );
    }
    env.clock.jump(LIMITS.REPLACE_PROBE_MS);
    await sleep(50);
    for (const node of [alice, bob]) {
      assert.ok(node.log.named('link.replace_probe').every((entry) => entry.fields.outcome === 'kept'), node.self.peer);
      assert.deepEqual([node.closes, node.fails], [[], []], `${node.self.peer}: 교체 0회`);
      assert.equal(node.opens.length, 1);
    }
    assert.equal(env.hub.sent.length, sentBefore, '버린 요청에는 offer 도 answer 도 보내지 않는다');
    assert.equal(alice.mesh.send('bob', 'still here'), 'ok');
    await until(() => bob.frames.some((frame) => frame.text === 'still here'), '링크가 그대로다');
  });

  scenario('상대가 답하지 않으면 2초 뒤 링크를 replaced 로 닫고 들고 있던 offer 를 처리한다', async (env) => {
    const bob = await env.node(BOB);
    const raws = await env.raws();
    const { raw: dead } = await linkFromRawOfferer(env, bob, ALICE);
    const restarted = { peer: 'alice', sid: 'a2a2a2a2a2a2' };
    const fresh = await raws.offer();
    fresh.answerPings = true;
    const cid = `${restarted.sid}.1`;
    env.clock.setRealtime(false);

    bob.mesh.handleSignal(signalFrom(restarted, { kind: 'offer', cid, data: { sdp: fresh.sdp } }));
    bob.mesh.handleSignal(signalFrom(restarted, { kind: 'candidate', cid, data: { list: fresh.candidates } }));
    env.clock.jump(LIMITS.REPLACE_PROBE_MS - 1);
    assert.equal(bob.closes.length, 0, '확인에 실패하기 전에는 닫지 않는다');
    assert.equal(bob.isOpen('alice'), true);
    assert.equal(env.hub.sentBy('bob', 'answer').filter((envelope) => cidOf(envelope) === cid).length, 0, '확인하는 동안에는 요청을 들고만 있는다');
    env.clock.jump(1);
    assert.deepEqual(bob.closes, [{ peer: 'alice', sid: ALICE.sid, reason: 'replaced' }]);
    assert.deepEqual(bob.mesh.links(), [{ peer: 'alice', sid: restarted.sid, state: 'connecting' }], '들고 있던 offer 로 새 시도를 시작했다');

    env.clock.setRealtime(true);
    await completeWithRawOfferer(env, bob, fresh, cid);
    await until(() => bob.isOpen('alice') && fresh.isOpen(), '새 링크');
    assert.deepEqual(bob.order, [`open:alice:${ALICE.sid}.1`, 'closed:alice:replaced', `open:alice:${cid}`]);
    assert.equal(bob.fails.length, 0);
    const end = bob.log.named('link.attempt_end').at(-1)?.fields;
    assert.ok(Number(end?.queued_applied) >= 1, '확인하는 동안 온 후보는 대기 큐에 있다가 들어갔다');
    assert.deepEqual(bob.log.named('link.replace_probe').map((entry) => entry.fields.outcome), ['replaced']);
    assert.ok(dead.messages.some((message) => message.includes('"t":"ping"')), '옛 링크로 ping 을 보냈다');
  });

  scenario('offer 쪽도 같다. 답하지 않는 상대의 offer-request 는 2초 뒤 교체되고 새 offer 가 나간다', async (env) => {
    const alice = await env.node(ALICE);
    await linkToRawAnswerer(env, alice, BOB);
    env.clock.setRealtime(false);
    alice.mesh.handleSignal(signalFrom({ peer: 'bob', sid: 'b2b2b2b2b2b2' }, { kind: 'offer-request', data: {} }));
    env.clock.jump(LIMITS.REPLACE_PROBE_MS - 1);
    assert.equal(env.hub.sentBy('alice', 'offer').length, 1);
    env.clock.jump(1);
    assert.deepEqual(alice.closes, [{ peer: 'bob', sid: BOB.sid, reason: 'replaced' }]);
    env.clock.setRealtime(true);
    await until(() => env.hub.sentBy('alice', 'offer').length === 2, '새 offer');
    assert.equal(cidOf(env.hub.sentBy('alice', 'offer')[1]), `${ALICE.sid}.2`, '새 시도는 새 cid 다');
  });

  scenario('확인하는 동안 온 요청은 가장 새 것 하나만 처리한다', async (env) => {
    const bob = await env.node(BOB);
    const raws = await env.raws();
    await linkFromRawOfferer(env, bob, ALICE);
    const one = await raws.offer();
    const two = await raws.offer();
    env.clock.setRealtime(false);
    bob.mesh.handleSignal(signalFrom({ peer: 'alice', sid: 'a2a2a2a2a2a2' }, { kind: 'offer', cid: 'a2a2a2a2a2a2.1', data: { sdp: one.sdp } }));
    env.clock.jump(1000);
    bob.mesh.handleSignal(signalFrom({ peer: 'alice', sid: 'a3a3a3a3a3a3' }, { kind: 'offer', cid: 'a3a3a3a3a3a3.1', data: { sdp: two.sdp } }));
    env.clock.jump(1000);
    assert.equal(bob.closes.length, 1, '확인 기한은 첫 요청부터 잰다');
    assert.deepEqual(bob.mesh.links(), [{ peer: 'alice', sid: 'a3a3a3a3a3a3', state: 'connecting' }]);
    env.clock.setRealtime(true);
    await until(() => env.hub.sentBy('bob', 'answer').length === 2, '새 answer');
    await sleep(100);
    assert.deepEqual(env.hub.sentBy('bob', 'answer').map(cidOf), [`${ALICE.sid}.1`, 'a3a3a3a3a3a3.1']);
  });

  scenario('probe 는 교체 확인을 밖에서 시작한다. 살아 있으면 유지하고, 답이 없으면 닫기만 한다', async (env) => {
    const { alice, bob } = await connected(env);
    alice.mesh.probe('bob');
    alice.mesh.probe('nobody');
    await until(() => alice.log.named('link.replace_probe').length === 1, '확인 결과');
    env.clock.jump(LIMITS.REPLACE_PROBE_MS);
    assert.equal(alice.log.named('link.replace_probe')[0]?.fields.outcome, 'kept');
    assert.deepEqual([alice.closes, bob.closes], [[], []]);

    const ann = { peer: 'ann', sid: 'a9a9a9a9a9a9' };
    const carol = await env.node({ peer: 'carol', sid: 'cccccccccccc' });
    await linkFromRawOfferer(env, carol, ann);
    env.clock.setRealtime(false);
    carol.mesh.probe('ann');
    env.clock.jump(LIMITS.REPLACE_PROBE_MS);
    assert.deepEqual(carol.closes, [{ peer: 'ann', sid: ann.sid, reason: 'replaced' }]);
    assert.deepEqual(carol.mesh.links(), [], '들고 있던 요청이 없으면 새 시도를 하지 않는다');
  });
});

describe('V-U11 mesh: 링크 생존 판정 (실제 라이브러리)', () => {
  scenario('5초마다 ping 을 보내고, pong 이 오는 동안에는 링크를 유지한다', async (env) => {
    const { alice, bob } = await connected(env);
    for (let round = 0; round < 8; round += 1) {
      env.clock.jump(LIMITS.P2P_PING_INTERVAL_MS);
      await until(() => alice.pings.length === round + 1 && bob.pings.length === round + 1, `${round + 1}번째 ping`);
      await sleep(20);
    }
    assert.deepEqual([alice.closes, bob.closes], [[], []], '40초가 지나도 닫히지 않는다');
    assert.equal(alice.isOpen('bob'), true);
  });

  scenario('마지막 생존 증거 뒤 15초 동안 pong 이 없으면 ping_timeout 으로 닫는다', async (env) => {
    const bob = await env.node(BOB);
    const { raw } = await linkFromRawOfferer(env, bob, ALICE);
    env.clock.setRealtime(false);
    // 판정 타이머는 15초 기한보다 DEAD_TIMER_LEAD_MS 먼저 건다(타이머가 늦게 깨도 15초를 넘기지 않게).
    const deadAt = LIMITS.P2P_DEAD_AFTER_MS - DEAD_TIMER_LEAD_MS;
    env.clock.jump((bob.openedAt[0] ?? 0) + deadAt - 1 - env.clock.now());
    assert.equal(bob.closes.length, 0, '열린 때부터 14.899초');
    env.clock.jump(1);
    assert.deepEqual(bob.closes, [{ peer: 'alice', sid: ALICE.sid, reason: 'ping_timeout' }]);
    assert.deepEqual(bob.mesh.links(), []);
    const closed = bob.log.named('link.closed')[0]?.fields;
    assert.equal(closed?.last_alive_age_ms, deadAt);
    assert.ok(deadAt < LIMITS.P2P_DEAD_AFTER_MS);
    env.clock.setRealtime(true);
    await until(() => raw.messages.filter((message) => message.includes('"t":"ping"')).length >= 2, '날 pc 가 받은 ping');
    const ping = JSON.parse(raw.messages.find((message) => message.includes('"t":"ping"')) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(ping, { v: 1, t: 'ping', n: 1, ...PING_INFO }, 'ping 에 복제본의 기록 수와 지문을 싣는다');
  });

  scenario('markAlive 는 생존 증거로 친다', async (env) => {
    const bob = await env.node(BOB);
    await linkFromRawOfferer(env, bob, ALICE);
    env.clock.setRealtime(false);
    env.clock.jump(10_000);
    bob.mesh.markAlive('alice');
    bob.mesh.markAlive('nobody');
    env.clock.jump(LIMITS.P2P_DEAD_AFTER_MS - DEAD_TIMER_LEAD_MS - 1);
    assert.equal(bob.closes.length, 0, 'markAlive 뒤로 판정 시각(15초 − 앞당김)이 지나지 않았다');
    env.clock.jump(1);
    assert.deepEqual(bob.closes.map((closed) => closed.reason), ['ping_timeout']);
  });

  scenario('chat 같은 다른 프레임과 상대의 ping 은 생존 증거로 치지 않는다', async (env) => {
    const bob = await env.node(BOB);
    const { raw } = await linkFromRawOfferer(env, bob, ALICE);
    env.clock.setRealtime(false);
    env.clock.jump(10_000);
    env.clock.setRealtime(true);
    raw.send('{"v":1,"t":"chat","id":"aaaaaaaaaaaa-1","to":null,"text":"hi","wall":1}');
    raw.send('{"v":1,"t":"ping","n":1,"sc":0,"sf":"000000000000"}');
    await until(() => bob.frames.length === 1 && bob.pings.length === 1, '받은 chat 과 ping');
    env.clock.setRealtime(false);
    env.clock.jump((bob.openedAt[0] ?? 0) + LIMITS.P2P_DEAD_AFTER_MS - env.clock.now());
    assert.deepEqual(bob.closes.map((closed) => closed.reason), ['ping_timeout'], '열린 때부터 15초에 닫힌다');
  });

  scenario('상대의 pong 은 생존 증거이고, 내가 보내지 않은 번호의 pong 은 증거가 아니다', async (env) => {
    const bob = await env.node(BOB);
    const { raw } = await linkFromRawOfferer(env, bob, ALICE);
    env.clock.setRealtime(false);
    env.clock.jump(12_000);
    env.clock.setRealtime(true);
    await until(() => raw.messages.filter((message) => message.includes('"t":"ping"')).length === 2, 'ping 두 번');
    raw.send('{"v":1,"t":"pong","n":99}');
    await sleep(50);
    env.clock.setRealtime(false);
    env.clock.jump(3_000);
    assert.deepEqual(bob.closes.map((closed) => closed.reason), ['ping_timeout'], '모르는 번호의 pong 으로는 살아나지 않는다');
    assert.deepEqual(bob.frames, [], 'pong 은 frame 으로 올리지 않는다');
  });

  scenario('상대 pc 가 닫히면 기한을 기다리지 않고 closed 로 닫는다', async (env) => {
    const bob = await env.node(BOB);
    const { raw } = await linkFromRawOfferer(env, bob, ALICE);
    raw.close();
    await until(() => bob.closes.length === 1, 'link-closed');
    assert.deepEqual(bob.closes, [{ peer: 'alice', sid: ALICE.sid, reason: 'closed' }]);
    await sleep(100);
    assert.equal(bob.closes.length, 1, '채널 닫힘과 pc 닫힘이 함께 와도 한 번만 낸다');
  });
});

describe('V-U11 mesh: netInfo 와 ICE 서버 (실제 라이브러리)', () => {
  scenario('srflx_seen 은 pc 를 만들기 전과 STUN 없는 구성에서 거짓이다', async (env) => {
    const alice = await env.node(ALICE);
    const bob = await env.node(BOB);
    assert.deepEqual(alice.mesh.netInfo(), { srflx_seen: false });
    alice.mesh.contact('bob');
    await until(() => alice.isOpen('bob') && bob.isOpen('alice'), '링크');
    await sleep(300);
    assert.deepEqual(alice.mesh.netInfo(), { srflx_seen: false });
    assert.deepEqual(bob.mesh.netInfo(), { srflx_seen: false });
  });

  scenario('링크가 열린 뒤에 나온 srflx 후보도 센다. 한 번 참이 되면 링크가 닫혀도 참이다 (로컬 STUN 대역)', async (env) => {
    const stun = await env.stun(400);
    const servers = parseIceServers(`stun:127.0.0.1:${stun.port}`);
    assert.ok(servers.ok);
    const alice = await env.node(ALICE, servers.value);
    const bob = await env.node(BOB);
    alice.mesh.contact('bob');
    await until(() => alice.isOpen('bob') && bob.isOpen('alice'), '링크');
    assert.deepEqual(alice.mesh.netInfo(), { srflx_seen: false }, '링크가 host 후보로 먼저 열렸다');
    await until(() => alice.mesh.netInfo().srflx_seen, '링크가 열린 뒤의 srflx 후보', 3000);
    assert.equal(stun.requests() >= 1, true);
    assert.deepEqual(bob.mesh.netInfo(), { srflx_seen: false }, 'STUN 이 없는 쪽은 거짓이다');
    assert.equal(alice.log.named('link.attempt_end')[0]?.fields.cand_local_srflx, 0, '시도가 끝날 때의 후보 수로는 알 수 없다');
    alice.mesh.closeLink('bob', 'done');
    assert.deepEqual(alice.mesh.netInfo(), { srflx_seen: true });
  });

  scenario('실패한 시도에서 얻은 srflx 후보도 센다. 실패 진단에 종류별 수가 실린다 (로컬 STUN 대역)', async (env) => {
    const stun = await env.stun();
    const servers = parseIceServers(`stun:127.0.0.1:${stun.port}`);
    assert.ok(servers.ok);
    const alice = await env.node(ALICE, servers.value);
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    await until(() => alice.mesh.netInfo().srflx_seen, 'srflx 후보', 3000);
    await sleep(150);
    alice.mesh.expireAttempt('bob');
    assert.equal(alice.fails[0]?.diag.local.srflx, 1);
    assert.ok((alice.fails[0]?.diag.local.host ?? 0) >= 1);
    assert.deepEqual(alice.mesh.netInfo(), { srflx_seen: true });
    const sent = candidatesOf(env.hub.sentBy('alice', 'candidate'));
    assert.ok(sent.some((item) => / typ srflx/.test(item.candidate)), 'srflx 후보도 묶음에 넣어 보낸다');
  });

  for (const [title, input] of [
    ['호스트 이름', 'stun:stun.agent-chat-test.invalid:3478'],
    ['IPv4', 'stun:192.0.2.10:19302'],
    ['IPv6', 'stun:[2001:db8::1]:3478'],
    ['포트 생략', 'stun:192.0.2.11'],
    ['포트를 생략한 IPv6', 'stun:[::1]'],
    ['여러 개', 'stun:stun.agent-chat-test.invalid,stun:192.0.2.12:3478,stun:[2001:db8::2]:5349'],
    ['없음(none)', 'none'],
  ] as const) {
    scenario(`parseIceServers 를 통과한 값(${title})으로 pc 가 예외 없이 만들어진다`, async (env) => {
      const servers = parseIceServers(input);
      assert.ok(servers.ok, input);
      const alice = await env.node(ALICE, servers.value);
      const bob = await env.node(BOB, servers.value);
      env.hub.route = () => 'drop';
      const raw = await (await env.raws()).offer();
      alice.mesh.contact('bob');
      bob.mesh.handleSignal(signalFrom(ALICE, { kind: 'offer', cid: `${ALICE.sid}.1`, data: { sdp: raw.sdp } }));
      assert.deepEqual([alice.fails, bob.fails], [[], []], 'pc 를 만들다 실패하지 않았다');
      await until(() => env.hub.sentBy('alice', 'offer').length === 1 && env.hub.sentBy('bob', 'answer').length === 1, 'offer 와 answer');
      for (const node of [alice, bob]) {
        assert.deepEqual(node.log.named('mesh.pc_create'), []);
        assert.equal(node.mesh.links()[0]?.state, 'connecting');
      }
    });
  }
});

describe('V-U11 mesh: 끝내기 (실제 라이브러리)', () => {
  scenario('shutdown 은 모든 pc 를 닫고, 이후 어떤 이벤트도 내지 않는다. 여러 번 불러도 된다', async (env) => {
    const { alice, bob } = await connected(env);
    const carol = await env.node({ peer: 'carol', sid: 'cccccccccccc' });
    env.hub.route = () => 'drop';
    carol.mesh.contact('alice');
    const raw = await (await env.raws()).offer();

    const done = shutdownAll([alice.mesh, bob.mesh, carol.mesh]);
    const again = alice.mesh.shutdown();
    await done;
    await again;
    for (const node of [alice, bob, carol]) {
      assert.deepEqual(node.mesh.links(), []);
      node.mesh.contact('zed');
      node.mesh.handleSignal(signalFrom({ peer: 'aaa', sid: 'a0a0a0a0a0a0' }, { kind: 'offer', cid: 'a0a0a0a0a0a0.1', data: { sdp: raw.sdp } }));
      node.mesh.expireAttempt('alice');
      node.mesh.closeLink('bob', 'x');
      node.mesh.probe('bob');
      node.mesh.resendPending();
      assert.equal(node.mesh.send('bob', 'x'), 'not_open');
      assert.deepEqual(node.mesh.links(), []);
    }
    env.clock.jump(120_000);
    await sleep(100);
    assert.deepEqual(alice.order, [`open:bob:${ALICE.sid}.1`], 'shutdown 뒤에는 link-closed 도 내지 않는다');
    assert.deepEqual(bob.order, [`open:alice:${ALICE.sid}.1`]);
    assert.deepEqual(carol.order, []);
    assert.equal(env.clock.pending(), 0, '타이머가 남지 않는다');
  });

  scenario('앞 mesh 를 shutdown 한 뒤에도 새 mesh 를 만들어 다시 연결할 수 있다', async (env) => {
    for (let round = 0; round < 3; round += 1) {
      const alice = await env.node(ALICE);
      const bob = await env.node(BOB);
      const before = env.hub.sentBy('alice', 'offer').length;
      bob.mesh.contact('alice');
      await until(() => alice.isOpen('bob') && bob.isOpen('alice'), `${round + 1}번째 링크`);
      assert.equal(alice.mesh.send('bob', `round ${round}`), 'ok');
      await until(() => bob.frames.length === 1, '프레임');
      assert.equal(env.hub.sentBy('alice', 'offer').length, before + 1);
      await shutdownAll([alice.mesh, bob.mesh]);
    }
  });

  scenario('진단 로그에 SDP 와 candidate 원문을 남기지 않는다', async (env) => {
    const { alice, bob } = await connected(env);
    alice.mesh.probe('bob');
    await until(() => alice.log.named('link.replace_probe').length === 1, '교체 확인의 결과');
    env.clock.jump(LIMITS.P2P_PING_INTERVAL_MS);
    await sleep(50);
    alice.mesh.closeLink('bob', 'done');
    await until(() => bob.closes.length === 1, '닫힘');
    env.hub.route = () => 'drop';
    alice.mesh.contact('bob');
    await until(() => env.hub.sentBy('alice', 'candidate').length >= 2, '후보');
    alice.mesh.resendPending();
    alice.mesh.expireAttempt('bob');
    const sdp = sdpOf(env.hub.sentBy('alice', 'offer')[0]);
    const ufrag = /a=ice-ufrag:(\S+)/.exec(sdp)?.[1] ?? '';
    const address = /(\d+\.\d+\.\d+\.\d+) \d+ typ host/.exec(candidatesOf(env.hub.sentBy('alice', 'candidate'))[0]?.candidate ?? '')?.[1] ?? '';
    assert.ok(ufrag.length > 0 && address.length > 0, '시험이 찾을 값을 얻었다');
    for (const node of [alice, bob]) {
      const text = node.log.text();
      assert.ok(node.log.events.length >= 2);
      for (const secret of ['v=0', 'a=candidate', 'typ host', ufrag, address]) {
        assert.equal(text.includes(secret), false, `${node.self.peer} 의 로그에 ${secret} 이(가) 없다`);
      }
    }
    const logged = new Set(alice.log.events.map((entry) => entry.event));
    for (const name of ['link.attempt_end', 'link.closed', 'link.replace_probe', 'signal.resend']) {
      assert.ok(logged.has(name), `${name} 사건을 남겼다`);
    }
  });
});
