// signaling-core 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다(V-U8 의 import-testing).
// RoomStore 계약 테스트 묶음(V-U7)을 내보낸다. 두 조립의 시험이 자기 저장소 구현에 돌린다:
// 메모리 구현은 `npm test`, DynamoDB 구현은 배포한 테이블에 `npm run test:store`.
// 판정 규칙(오래됨, 정원, 인계)은 core 의 것이라 여기서 보지 않는다. 포트가 약속한 것만 본다.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { LIMITS } from '../protocol/index.js';
import type { DefineRoomStoreContractTests, RoomStore } from './contract.js';
import type { ConnBinding, ConnId, PeerRecord, RoomKey } from './ports.js';

const WINDOW = LIMITS.RATE_WINDOW_MS;
/** 창의 경계에 맞춘 기준 시각. 고정 창은 epoch 에서 RATE_WINDOW_MS 씩 끊는다(deployment.md 2.4 의 분 번호). */
const T0 = Math.floor(1_800_000_000_000 / WINDOW) * WINDOW;
const CONCURRENCY = 20;

export const defineRoomStoreContractTests: DefineRoomStoreContractTests = (makeStore, options = {}) => {
  const name = options.name ?? 'RoomStore';
  const prefix = options.idPrefix ?? `t${randomBytes(6).toString('hex')}-`;

  describe(`V-U7 RoomStore 계약: ${name}`, () => {
    // 시험마다 만든 항목을 적어 두었다가 포트 연산으로 지운다. 운영 테이블에 돌려도 항목이 남지 않게 한다.
    let serial = 0;
    let store: RoomStore | null = null;
    const touchedPeers = new Map<string, { roomKey: RoomKey; peer: string }>();
    const touchedConns = new Set<ConnId>();

    const open = async (): Promise<RoomStore> => {
      store = await makeStore();
      return store;
    };
    const room = (label = 'room'): RoomKey => {
      serial += 1;
      return `${prefix}${label}-${serial}`;
    };
    const conn = (label = 'conn'): ConnId => {
      serial += 1;
      const id = `${prefix}${label}-${serial}`;
      touchedConns.add(id);
      return id;
    };
    const record = (roomKey: RoomKey, peer: string, connId: ConnId, more: Partial<PeerRecord> = {}): PeerRecord => {
      touchedPeers.set(`${roomKey}\n${peer}`, { roomKey, peer });
      touchedConns.add(connId);
      return { roomKey, peer, connId, sid: 'abcdefghijkl', keyHash: 'k'.repeat(64), seq: 1, lastSeenAt: T0, ...more };
    };
    const binding = (roomKey: RoomKey, peer: string, sid = 'abcdefghijkl'): ConnBinding => ({ roomKey, peer, sid });

    afterEach(async () => {
      const used = store;
      store = null;
      if (used === null) return;
      for (const { roomKey, peer } of touchedPeers.values()) {
        const left = await used.getPeer(roomKey, peer);
        if (left !== null) await used.deletePeer(roomKey, peer, { connId: left.connId });
      }
      for (const connId of touchedConns) await used.unbind(connId);
      for (const { roomKey, peer } of touchedPeers.values()) {
        assert.equal(await used.getPeer(roomKey, peer), null, '시험이 만든 참가자 기록이 남았다');
      }
      touchedPeers.clear();
      touchedConns.clear();
    });

    describe('참가자 기록 읽기', () => {
      it('없는 기록은 null, 빈 방은 빈 목록이다', async () => {
        const s = await open();
        const roomKey = room();
        assert.equal(await s.getPeer(roomKey, 'alice'), null);
        assert.deepEqual([...(await s.listPeers(roomKey))], []);
      });

      it('쓴 직후의 읽기가 그 쓰기를 본다(강한 일관성)', async () => {
        const s = await open();
        const roomKey = room();
        for (let i = 0; i < 12; i += 1) {
          const peer = `peer-${i}`;
          const written = record(roomKey, peer, conn(), { seq: i + 1, lastSeenAt: T0 + i });
          assert.equal(await s.putPeer(written, { absent: true }), true);
          assert.deepEqual(await s.getPeer(roomKey, peer), written);
          assert.equal((await s.listPeers(roomKey)).length, i + 1, '목록이 방금 쓴 기록을 본다');
        }
        const last = await s.getPeer(roomKey, 'peer-11');
        assert.ok(last !== null);
        assert.equal(await s.deletePeer(roomKey, 'peer-11', { connId: last.connId }), true);
        assert.equal(await s.getPeer(roomKey, 'peer-11'), null, '지운 직후의 읽기가 삭제를 본다');
        assert.equal((await s.listPeers(roomKey)).length, 11);
      });

      it('목록은 그 방의 기록만, 오래된 것도 거르지 않고 돌려준다', async () => {
        const s = await open();
        const roomA = room('a');
        const roomB = room('b');
        const old = record(roomA, 'old', conn(), { lastSeenAt: 0 });
        const fresh = record(roomA, 'fresh', conn(), { lastSeenAt: T0 });
        const other = record(roomB, 'old', conn(), { sid: 'zzzzzzzzzzzz' });
        for (const item of [old, fresh, other]) assert.equal(await s.putPeer(item, { absent: true }), true);

        const listedA = [...(await s.listPeers(roomA))].sort((x, y) => (x.peer < y.peer ? -1 : 1));
        assert.deepEqual(listedA, [fresh, old]);
        assert.deepEqual([...(await s.listPeers(roomB))], [other]);
        assert.deepEqual(await s.getPeer(roomA, 'old'), old, '타이머로 지우지 않는다. 오래됨 판정은 core 가 한다');
      });

      it('같은 이름이라도 방이 다르면 다른 기록이다', async () => {
        const s = await open();
        const roomA = room('a');
        const roomB = room('b');
        const inA = record(roomA, 'same', conn(), { seq: 3 });
        const inB = record(roomB, 'same', conn(), { seq: 7 });
        assert.equal(await s.putPeer(inA, { absent: true }), true);
        assert.equal(await s.putPeer(inB, { absent: true }), true);
        assert.equal(await s.deletePeer(roomA, 'same', { connId: inA.connId }), true);
        assert.equal(await s.getPeer(roomA, 'same'), null);
        assert.deepEqual(await s.getPeer(roomB, 'same'), inB);
      });
    });

    describe('putPeer 의 조건', () => {
      it('absent 는 기록이 없을 때만 쓴다. 지면 아무 것도 바꾸지 않는다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        const second = record(roomKey, 'alice', conn(), { sid: 'bbbbbbbbbbbb', seq: 9, lastSeenAt: T0 + 5 });
        assert.equal(await s.putPeer(first, { absent: true }), true);
        assert.equal(await s.putPeer(second, { absent: true }), false);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first);
      });

      it('{connId, seq} 는 저장된 값이 둘 다 그대로일 때만 기록 전체를 덮어쓴다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn(), { seq: 2 });
        assert.equal(await s.putPeer(first, { absent: true }), true);

        const next = record(roomKey, 'alice', conn(), { sid: 'cccccccccccc', keyHash: 'n'.repeat(64), seq: 5, lastSeenAt: T0 + 9 });
        assert.equal(await s.putPeer(next, { connId: 'someone-else', seq: 2 }), false, '연결 ID 가 다르면 쓰지 않는다');
        assert.equal(await s.putPeer(next, { connId: first.connId, seq: 1 }), false, 'seq 가 다르면 쓰지 않는다');
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first);

        assert.equal(await s.putPeer(next, { connId: first.connId, seq: 2 }), true);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), next);
        assert.equal(await s.putPeer(first, { connId: first.connId, seq: 2 }), false, '이미 바뀐 기록에는 옛 조건이 맞지 않는다');
      });

      it('{connId, seq} 조건은 기록이 없으면 쓰지 않는다', async () => {
        const s = await open();
        const roomKey = room();
        const fresh = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(fresh, { connId: fresh.connId, seq: fresh.seq }), false);
        assert.equal(await s.getPeer(roomKey, 'alice'), null);
      });
    });

    describe('touchPeer 와 deletePeer 의 조건', () => {
      it('touchPeer 는 연결 ID 가 같을 때만 lastSeenAt 만 바꾼다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(first, { absent: true }), true);

        assert.equal(await s.touchPeer(roomKey, 'alice', { connId: 'someone-else', seenSince: 0 }, T0 + 500), false);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first);

        assert.equal(await s.touchPeer(roomKey, 'alice', { connId: first.connId, seenSince: 0 }, T0 + 500), true);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), { ...first, lastSeenAt: T0 + 500 });
      });

      it('touchPeer 는 저장된 lastSeenAt 이 seenSince 보다 작으면(오래된 기록) 바꾸지 않는다. 같으면 바꾼다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(first, { absent: true }), true);

        assert.equal(await s.touchPeer(roomKey, 'alice', { connId: first.connId, seenSince: first.lastSeenAt + 1 }, T0 + 500), false);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first, '오래된 기록은 그대로다');

        assert.equal(await s.touchPeer(roomKey, 'alice', { connId: first.connId, seenSince: first.lastSeenAt }, T0 + 500), true);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), { ...first, lastSeenAt: T0 + 500 });
      });

      it('touchPeer 는 없는 기록을 만들지 않는다', async () => {
        const s = await open();
        const roomKey = room();
        touchedPeers.set(`${roomKey}\nghost`, { roomKey, peer: 'ghost' });
        assert.equal(await s.touchPeer(roomKey, 'ghost', { connId: conn(), seenSince: 0 }, T0), false);
        assert.equal(await s.getPeer(roomKey, 'ghost'), null);
        assert.deepEqual([...(await s.listPeers(roomKey))], []);
      });

      it('deletePeer 는 연결 ID 가 같을 때만 지운다. 없는 기록은 false 다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: first.connId }), false, '없는 기록');
        assert.equal(await s.putPeer(first, { absent: true }), true);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: 'someone-else' }), false, '늦게 온 옛 연결의 통지');
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: first.connId }), true);
        assert.equal(await s.getPeer(roomKey, 'alice'), null);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: first.connId }), false, '두 번째 삭제');
      });

      it('claimPeer 는 연결 ID 와 lastSeenAt(판)이 같을 때만 차지한다. 같은 판은 여러 번 차지해도 된다. 기록의 값은 바뀌지 않는다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        touchedPeers.set(`${roomKey}\nalice`, { roomKey, peer: 'alice' });
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt }), false, '없는 기록');
        assert.equal(await s.getPeer(roomKey, 'alice'), null, '없는 기록을 만들지 않는다');
        assert.equal(await s.putPeer(first, { absent: true }), true);
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: 'someone-else', writtenAt: first.lastSeenAt }), false);
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt + 1 }), false, '다른 판');
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first, '차지하지 못했으면 표시가 없다');
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt }), true);
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt }), true, '같은 판을 판정한 다른 처리');
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), { ...first, claimed: true }, '값은 그대로이고 차지 표시만 더해진다');
        assert.deepEqual([...(await s.listPeers(roomKey))], [{ ...first, claimed: true }]);
      });

      it('(검토 3차 SERVER-R3-01) 읽기는 차지 표시(claimed: true)를 싣는다. putPeer 로 다시 쓰거나 지웠다가 쓰면 없고, touchPeer 뒤에는 남는다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(first, { absent: true }), true);
        assert.equal(Object.hasOwn((await s.getPeer(roomKey, 'alice')) ?? {}, 'claimed'), false, 'putPeer 뒤에는 표시가 없다');
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt }), true);
        assert.equal((await s.getPeer(roomKey, 'alice'))?.claimed, true);
        assert.equal(await s.touchPeer(roomKey, 'alice', { connId: first.connId, seenSince: 0 }, T0 + 500), true);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), { ...first, lastSeenAt: T0 + 500, claimed: true }, 'ping 은 표시를 지우지 않는다');

        // 같은 자리를 새 판으로 다시 쓰면(인계) 표시는 없어진다.
        const next = { ...first, seq: first.seq + 1, lastSeenAt: T0 + 900 };
        assert.equal(await s.putPeer(next, { connId: first.connId, seq: first.seq }), true);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), next);
        assert.deepEqual([...(await s.listPeers(roomKey))], [next]);

        // 지운 자리에 다시 써도 앞의 표시가 되살아나지 않는다.
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: next.connId, writtenAt: next.lastSeenAt }), true);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: next.connId }), true);
        assert.equal(await s.putPeer(first, { absent: true }), true);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first);
      });

      it('deletePeer 의 writtenAt 조건: 같은 판이고 차지되지 않았을 때만 지운다. 다시 쓴 판은 차지 표시가 없다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(first, { absent: true }), true);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt + 1 }), false, '다른 판');
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt }), true);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: first.connId, writtenAt: first.lastSeenAt }), false, '차지된 판');
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), { ...first, claimed: true });

        // 같은 자리를 새 판으로 다시 쓰면(인계) 차지 표시는 없어진다.
        const next = { ...first, seq: first.seq + 1, lastSeenAt: first.lastSeenAt + 10 };
        assert.equal(await s.putPeer(next, { connId: first.connId, seq: first.seq }), true);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: first.connId, writtenAt: next.lastSeenAt }), true);
        assert.equal(await s.getPeer(roomKey, 'alice'), null);

        // writtenAt 이 없는 삭제(퇴장·종료 통지)는 차지 여부와 상관없이 연결 ID 만 본다.
        const third = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(third, { absent: true }), true);
        assert.equal(await s.claimPeer(roomKey, 'alice', { connId: third.connId, writtenAt: third.lastSeenAt }), true);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: third.connId }), true);
        assert.equal(await s.getPeer(roomKey, 'alice'), null);

        // 지운 자리에 같은 판 값으로 다시 써도 앞의 차지 표시가 되살아나지 않는다.
        assert.equal(await s.putPeer(third, { absent: true }), true);
        assert.equal(await s.deletePeer(roomKey, 'alice', { connId: third.connId, writtenAt: third.lastSeenAt }), true);
      });
    });

    describe('연결 항목: 건수, 등록, 입장 실패 횟수', () => {
      it('hitRate 는 호출을 포함한 창 안 건수를 돌려준다. 등록이 없으면 binding 은 null 이다', async () => {
        const s = await open();
        const connId = conn();
        assert.deepEqual(await s.hitRate(connId, T0), { count: 1, binding: null });
        assert.deepEqual(await s.hitRate(connId, T0 + 1), { count: 2, binding: null });
        assert.deepEqual(await s.hitRate(connId, T0 + WINDOW - 1), { count: 3, binding: null });
      });

      it('창이 바뀌면 건수를 처음부터 센다(고정 창)', async () => {
        const s = await open();
        const connId = conn();
        for (let i = 0; i < 5; i += 1) await s.hitRate(connId, T0 + WINDOW - 1);
        assert.equal((await s.hitRate(connId, T0 + WINDOW)).count, 1, '경계를 1ms 넘으면 새 창이다');
        assert.equal((await s.hitRate(connId, T0 + WINDOW + 10)).count, 2);
        assert.equal((await s.hitRate(connId, T0 + 3 * WINDOW)).count, 1);
      });

      it('연결마다 따로 센다', async () => {
        const s = await open();
        const a = conn('a');
        const b = conn('b');
        await s.hitRate(a, T0);
        await s.hitRate(a, T0);
        assert.equal((await s.hitRate(b, T0)).count, 1);
        assert.equal((await s.hitRate(a, T0)).count, 3);
      });

      it('bind 한 등록을 hitRate 가 sid 까지 돌려주고, 다시 bind 하면 덮어쓴다', async () => {
        const s = await open();
        const connId = conn();
        const roomKey = room();
        await s.hitRate(connId, T0);
        await s.bind(connId, binding(roomKey, 'alice', 'aaaaaaaaaaaa'));
        assert.deepEqual(await s.hitRate(connId, T0), { count: 2, binding: binding(roomKey, 'alice', 'aaaaaaaaaaaa') });
        await s.bind(connId, binding(roomKey, 'bob', 'bbbbbbbbbbbb'));
        assert.deepEqual((await s.hitRate(connId, T0)).binding, binding(roomKey, 'bob', 'bbbbbbbbbbbb'));
      });

      it('hitRate 를 부른 적 없는 연결도 bind 할 수 있다', async () => {
        const s = await open();
        const connId = conn();
        const roomKey = room();
        await s.bind(connId, binding(roomKey, 'alice'));
        assert.deepEqual(await s.hitRate(connId, T0), { count: 1, binding: binding(roomKey, 'alice') });
      });

      it('bind 는 건수를 그대로 두고 연속 입장 실패 횟수만 0 으로 돌린다', async () => {
        const s = await open();
        const connId = conn();
        for (let i = 0; i < 3; i += 1) await s.hitRate(connId, T0);
        assert.equal(await s.bumpJoinMiss(connId), 1);
        assert.equal(await s.bumpJoinMiss(connId), 2);
        await s.bind(connId, binding(room(), 'alice'));
        assert.equal((await s.hitRate(connId, T0)).count, 4);
        assert.equal(await s.bumpJoinMiss(connId), 1);
      });

      it('bumpJoinMiss 는 연결마다 1씩 올리고 올린 값을 돌려준다. 연결 항목이 없으면 만든다', async () => {
        const s = await open();
        const a = conn('a');
        const b = conn('b');
        assert.equal(await s.bumpJoinMiss(a), 1);
        assert.equal(await s.bumpJoinMiss(a), 2);
        assert.equal(await s.bumpJoinMiss(b), 1);
        assert.equal(await s.bumpJoinMiss(a), 3);
        assert.deepEqual(await s.hitRate(a, T0), { count: 1, binding: null }, '실패 횟수만 있던 연결의 건수는 0 에서 시작한다');
      });

      it('unbind 는 지우기 전의 등록을 돌려주고 건수와 실패 횟수까지 지운다. 여러 번 불러도 된다', async () => {
        const s = await open();
        const connId = conn();
        const roomKey = room();
        assert.equal(await s.unbind(connId), null, '본 적 없는 연결');
        for (let i = 0; i < 4; i += 1) await s.hitRate(connId, T0);
        await s.bumpJoinMiss(connId);
        assert.equal(await s.unbind(connId), null, '등록 없이 건수만 있던 연결');
        assert.deepEqual(await s.hitRate(connId, T0), { count: 1, binding: null });

        await s.bind(connId, binding(roomKey, 'alice', 'aaaaaaaaaaaa'));
        await s.bumpJoinMiss(connId);
        assert.deepEqual(await s.unbind(connId), binding(roomKey, 'alice', 'aaaaaaaaaaaa'));
        assert.equal(await s.unbind(connId), null);
        assert.deepEqual(await s.hitRate(connId, T0), { count: 1, binding: null });
        assert.equal(await s.bumpJoinMiss(connId), 1);
      });

      it('unbind 는 참가자 기록을 건드리지 않는다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(first, { absent: true }), true);
        await s.bind(first.connId, binding(roomKey, 'alice'));
        await s.unbind(first.connId);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), first);
      });
    });

    describe('동시에 들어온 호출의 원자성', () => {
      it(`hitRate ${CONCURRENCY * 2}건을 동시에 불러도 건수가 하나도 겹치거나 빠지지 않는다`, async () => {
        const s = await open();
        const connId = conn();
        const total = CONCURRENCY * 2;
        const hits = await Promise.all(Array.from({ length: total }, () => s.hitRate(connId, T0 + 7)));
        const counts = hits.map((hit) => hit.count).sort((x, y) => x - y);
        assert.deepEqual(counts, Array.from({ length: total }, (_, i) => i + 1));
        assert.equal((await s.hitRate(connId, T0 + 7)).count, total + 1);
      });

      it(`bumpJoinMiss ${CONCURRENCY}건을 동시에 불러도 값이 1부터 하나씩 나온다`, async () => {
        const s = await open();
        const connId = conn();
        const values = await Promise.all(Array.from({ length: CONCURRENCY }, () => s.bumpJoinMiss(connId)));
        assert.deepEqual(values.sort((x, y) => x - y), Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
      });

      it('같은 이름의 absent 쓰기가 동시에 들어오면 하나만 성공하고 그 기록이 남는다', async () => {
        const s = await open();
        const roomKey = room();
        const attempts = Array.from({ length: CONCURRENCY }, (_, i) => record(roomKey, 'alice', conn(), { seq: i + 1 }));
        const results = await Promise.all(attempts.map((attempt) => s.putPeer(attempt, { absent: true })));
        assert.equal(results.filter(Boolean).length, 1);
        const winner = attempts[results.indexOf(true)];
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), winner);
        assert.equal((await s.listPeers(roomKey)).length, 1);
      });

      it('같은 조건의 덮어쓰기가 동시에 들어오면 하나만 성공한다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn(), { seq: 1 });
        assert.equal(await s.putPeer(first, { absent: true }), true);
        const attempts = Array.from({ length: CONCURRENCY }, (_, i) => record(roomKey, 'alice', conn(), { seq: i + 2 }));
        const results = await Promise.all(attempts.map((attempt) => s.putPeer(attempt, { connId: first.connId, seq: 1 })));
        assert.equal(results.filter(Boolean).length, 1);
        assert.deepEqual(await s.getPeer(roomKey, 'alice'), attempts[results.indexOf(true)]);
      });

      it('같은 조건의 삭제가 동시에 들어오면 하나만 true 다', async () => {
        const s = await open();
        const roomKey = room();
        const first = record(roomKey, 'alice', conn());
        assert.equal(await s.putPeer(first, { absent: true }), true);
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () => s.deletePeer(roomKey, 'alice', { connId: first.connId })),
        );
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal(await s.getPeer(roomKey, 'alice'), null);
      });

      it('서로 다른 이름의 쓰기가 동시에 들어오면 모두 남고, 뒤이은 목록이 전부 본다', async () => {
        const s = await open();
        const roomKey = room();
        const attempts = Array.from({ length: CONCURRENCY }, (_, i) => record(roomKey, `peer-${i}`, conn()));
        const results = await Promise.all(attempts.map((attempt) => s.putPeer(attempt, { absent: true })));
        assert.equal(results.filter(Boolean).length, CONCURRENCY);
        const listed = [...(await s.listPeers(roomKey))].map((item) => item.peer).sort();
        assert.deepEqual(listed, attempts.map((item) => item.peer).sort());
      });
    });
  });
};
