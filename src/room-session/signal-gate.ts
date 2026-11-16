// 시그널 전송 함수를 다루는 유일한 파일 (architecture.md 3.10, protocol.md 3.1).
// 세 가지 일만 한다: joined 전에 mesh 가 내보내려는 시그널을 들고 있기, signaling-client 로 보내기,
// 그 전송 함수를 넣어 mesh 를 만들고 서버가 준 시그널을 mesh 에 잇기.
// 이 파일은 P2P 프레임과 채팅을 모른다. 그래서 시그널에 글을 실을 길이 없다(V-U8).

import type { CreateMesh, CreateMeshResult, MeshDeps, SendSignal } from '../mesh/contract.js';
import { LIMITS } from '../protocol/index.js';
import type { SignalPayload, Unsubscribe } from '../protocol/index.js';
import type { SignalingClient } from '../signaling-client/contract.js';

export interface SignalGate {
  /** joined 를 받았다. 들고 있던 시그널을 받은 순서대로 보내고, 이후로는 바로 보낸다. */
  open(): void;
  /** 입장이 끝났거나 실패했다. 들고 있던 것을 버리고, 서버의 시그널을 mesh 에 더 넘기지 않는다. */
  discard(): void;
  /** 지금 들고 있는 시그널 수. */
  held(): number;
}

export interface GatedMesh {
  readonly gate: SignalGate;
  readonly result: CreateMeshResult;
}

export interface GatedMeshOptions {
  readonly client: SignalingClient;
  readonly createMesh: CreateMesh;
  readonly mesh: Omit<MeshDeps, 'sendSignal'>;
}

/**
 * mesh 를 만들고 시그널 처리기를 붙인다. 부르는 쪽은 이 함수가 끝난 뒤에 join 을 보낸다.
 * 그래야 joined 보다 먼저 온 offer 를 mesh 가 바로 받는다. 그 결과로 나가는 answer 와 후보는
 * 서버가 NOT_JOINED 로 거절하므로 open() 까지 들고 있는다.
 */
export async function createGatedMesh(options: GatedMeshOptions): Promise<GatedMesh> {
  const { client } = options;
  let state: 'holding' | 'open' | 'discarded' = 'holding';
  const held: { readonly to: string; readonly payload: SignalPayload }[] = [];
  const subscriptions: Unsubscribe[] = [];

  const send: SendSignal = (to, payload) => {
    if (state === 'open') return client.sendSignal(to, payload);
    if (state === 'discarded') return false;
    // 넘치면 받지 않는다. 시도 안의 주기 재전송이 메운다.
    if (held.length >= LIMITS.PRE_JOIN_SIGNAL_HOLD_MAX) return false;
    held.push({ to, payload });
    return true;
  };

  const result = await options.createMesh({ ...options.mesh, sendSignal: send });
  if (result.ok) {
    const { mesh } = result;
    subscriptions.push(
      client.on('signal', (signal) => mesh.handleSignal(signal)),
      client.on('relay-error', (error) => mesh.handleRelayError(error)),
      client.on('gateway-frame', () => mesh.resendPending()),
    );
  } else {
    state = 'discarded';
  }

  const gate: SignalGate = {
    open() {
      if (state !== 'holding') return;
      state = 'open';
      for (const item of held.splice(0)) client.sendSignal(item.to, item.payload);
    },
    discard() {
      state = 'discarded';
      held.length = 0;
      for (const off of subscriptions.splice(0)) off();
    },
    held: () => held.length,
  };
  return { gate, result };
}
