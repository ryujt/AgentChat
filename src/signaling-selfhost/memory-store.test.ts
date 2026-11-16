// V-U7: RoomStore 계약 테스트 묶음을 메모리 구현에 돌린다. 같은 묶음을 공용 서버의 DynamoDB 구현이 통과해야 한다.
// 뒤의 시험은 메모리 구현에만 있는 것(리스너가 쓰는 조회, 메모리가 남지 않는지)이다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineRoomStoreContractTests } from '../signaling-core/testing.js';
import { createMemoryRoomStore } from './memory-store.js';

defineRoomStoreContractTests(() => createMemoryRoomStore(), { name: '메모리 저장소' });

describe('메모리 저장소: 리스너가 쓰는 조회', () => {
  const record = (roomKey: string, peer: string, connId: string) => ({
    roomKey,
    peer,
    connId,
    sid: 'abcdefghijkl',
    keyHash: 'k'.repeat(64),
    seq: 1,
    lastSeenAt: 1_800_000_000_000,
  });

  it('bindingOf 는 건수를 올리지 않고 등록만 본다', async () => {
    const store = createMemoryRoomStore();
    assert.equal(store.bindingOf('c1'), null);
    await store.hitRate('c1', 0);
    assert.equal(store.bindingOf('c1'), null);
    await store.bind('c1', { roomKey: 'r1', peer: 'alice', sid: 'abcdefghijkl' });
    assert.deepEqual(store.bindingOf('c1'), { roomKey: 'r1', peer: 'alice', sid: 'abcdefghijkl' });
    assert.equal((await store.hitRate('c1', 0)).count, 2);
    await store.unbind('c1');
    assert.equal(store.bindingOf('c1'), null);
  });

  it('참가자가 없어진 방과 닫힌 연결의 항목을 남기지 않는다', async () => {
    const store = createMemoryRoomStore();
    for (let i = 0; i < 100; i += 1) {
      await store.hitRate(`c${i}`, 0);
      await store.putPeer(record(`room-${i}`, 'alice', `c${i}`), { absent: true });
      await store.bind(`c${i}`, { roomKey: `room-${i}`, peer: 'alice', sid: 'abcdefghijkl' });
    }
    assert.equal(store.roomCount(), 100);
    assert.equal(store.connCount(), 100);
    for (let i = 0; i < 100; i += 1) {
      await store.unbind(`c${i}`);
      await store.deletePeer(`room-${i}`, 'alice', { connId: `c${i}` });
    }
    assert.equal(store.roomCount(), 0);
    assert.equal(store.connCount(), 0);
  });

  it('저장한 뒤 부른 쪽이 객체를 고쳐도 저장된 기록은 그대로다', async () => {
    const store = createMemoryRoomStore();
    const mine = record('r1', 'alice', 'c1');
    await store.putPeer(mine, { absent: true });
    (mine as { seq: number }).seq = 99;
    assert.equal((await store.getPeer('r1', 'alice'))?.seq, 1);
    const binding = { roomKey: 'r1', peer: 'alice', sid: 'abcdefghijkl' };
    await store.bind('c1', binding);
    binding.peer = 'mallory';
    assert.equal(store.bindingOf('c1')?.peer, 'alice');
  });
});
