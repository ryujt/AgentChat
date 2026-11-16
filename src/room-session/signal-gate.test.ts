// V-U9: joined 전의 시그널 보관 (protocol.md 3.1). 시그널 전송 함수를 다루는 유일한 파일의 단독 시험이다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateMesh } from '../mesh/contract.js';
import { LIMITS } from '../protocol/index.js';
import type { SignalPayload } from '../protocol/index.js';
import { createGatedMesh } from './signal-gate.js';
import { FakeClock, FakeLog, FakeNet, sidOf } from './testing.js';
import type { FakeMesh } from './testing.js';

const SID = sidOf('me');

function payload(n: number): SignalPayload {
  return { kind: 'candidate', cid: `${SID}.1`, data: { list: [{ candidate: `candidate:${n} 1 UDP 1 192.0.2.1 9 typ host`, mid: '0' }] } };
}

async function rig(options: { createMesh?: CreateMesh } = {}) {
  const clock = new FakeClock();
  const net = new FakeNet(clock);
  const client = net.createSignalingClient({ url: 'ws://127.0.0.1:1', now: clock.now, timers: clock.timers, log: new FakeLog().port });
  const gated = await createGatedMesh({
    client,
    createMesh: options.createMesh ?? net.createMesh,
    mesh: {
      self: { peer: 'me', sid: SID },
      iceServers: [],
      pingInfo: () => ({ sc: 0, sf: '000000000000' }),
      now: clock.now,
      timers: clock.timers,
      log: new FakeLog().port,
    },
  });
  const fake = net.clients[0];
  assert.ok(fake);
  const mesh = gated.result.ok ? (gated.result.mesh as FakeMesh) : null;
  return { net, client: fake, gate: gated.gate, result: gated.result, mesh };
}

describe('시그널 보관', () => {
  it('joined 전에는 mesh 가 내보내려는 시그널을 들고 있다가, open() 에서 받은 순서대로 보낸다', async () => {
    const { client, gate, mesh } = await rig();
    assert.ok(mesh);
    assert.equal(mesh.deps.sendSignal('A', payload(1)), true, '들고 있겠다고 받는다');
    assert.equal(mesh.deps.sendSignal('B', payload(2)), true);
    assert.equal(gate.held(), 2);
    assert.deepEqual([client.signals, client.refused], [[], []], '등록 전에는 서버로 아무 것도 보내지 않는다');

    client.registered = true;
    gate.open();
    assert.deepEqual(client.signals, [
      { to: 'A', payload: payload(1) },
      { to: 'B', payload: payload(2) },
    ]);
    assert.equal(gate.held(), 0);
    // 그 뒤로는 바로 보낸다. 결과는 클라이언트가 준 값 그대로다.
    assert.equal(mesh.deps.sendSignal('A', payload(3)), true);
    assert.equal(client.signals.length, 3);
    client.registered = false;
    assert.equal(mesh.deps.sendSignal('A', payload(4)), false, '재접속 중이면 보내지 못했다고 돌려준다(큐에 쌓지 않는다)');
    assert.equal(gate.held(), 0);
    gate.open();
    assert.equal(client.signals.length, 3, 'open 을 다시 불러도 되풀이하지 않는다');
  });

  it('들고 있는 것은 64건까지다. 넘는 것은 받지 않고 false 를 돌려준다', async () => {
    const { client, gate, mesh } = await rig();
    assert.ok(mesh);
    for (let n = 0; n < LIMITS.PRE_JOIN_SIGNAL_HOLD_MAX; n += 1) assert.equal(mesh.deps.sendSignal('A', payload(n)), true);
    assert.equal(mesh.deps.sendSignal('A', payload(999)), false);
    assert.equal(gate.held(), 64);
    client.registered = true;
    gate.open();
    assert.equal(client.signals.length, 64);
    assert.deepEqual(client.signals.at(-1), { to: 'A', payload: payload(63) }, '넘친 것은 나가지 않는다');
  });

  it('discard() 는 들고 있던 것을 버리고, 서버의 시그널을 mesh 에 더 넘기지 않는다', async () => {
    const { client, gate, mesh } = await rig();
    assert.ok(mesh);
    mesh.deps.sendSignal('A', payload(1));
    gate.discard();
    assert.equal(gate.held(), 0);
    assert.equal(mesh.deps.sendSignal('A', payload(2)), false);
    client.registered = true;
    gate.open();
    assert.deepEqual(client.signals, [], '버린 뒤에는 열어도 나가지 않는다');
    client.emitSignal({ type: 'signal', from: 'A', sid: sidOf('A'), kind: 'offer-request', data: {} });
    client.emitRelayError({ to: 'A', cid: null, code: 'SERVER_ERROR' });
    client.emitGatewayFrame();
    assert.deepEqual([mesh.signals, mesh.relayErrors, mesh.resendPendingCalls], [[], [], 0]);
  });
});

describe('시그널 처리기', () => {
  it('mesh 를 만든 직후(= join 을 보내기 전)부터 서버가 준 시그널, 전달 실패, 게이트웨이 프레임을 mesh 에 넘긴다', async () => {
    const { client, mesh } = await rig();
    assert.ok(mesh);
    const offer = { type: 'signal', from: 'A', sid: sidOf('A'), kind: 'offer', cid: `${sidOf('A')}.1`, data: { sdp: 'v=0' } } as const;
    client.emitSignal(offer);
    client.emitRelayError({ to: 'B', cid: `${SID}.2`, code: 'RELAY_NOT_ALLOWED' });
    client.emitGatewayFrame();
    assert.deepEqual(mesh.signals, [offer]);
    assert.deepEqual(mesh.relayErrors, [{ to: 'B', cid: `${SID}.2`, code: 'RELAY_NOT_ALLOWED' }]);
    assert.equal(mesh.resendPendingCalls, 1);
  });

  it('mesh 를 만들지 못하면 결과를 그대로 돌려주고 처리기를 붙이지 않는다', async () => {
    const { client, result, gate } = await rig({
      createMesh: async () => ({ ok: false, code: 'NATIVE_LOAD_FAILED', detail: 'cannot load the native module' }),
    });
    assert.deepEqual(result, { ok: false, code: 'NATIVE_LOAD_FAILED', detail: 'cannot load the native module' });
    assert.equal(client.listenerCount('signal'), 0);
    gate.open();
    gate.discard();
  });
});
