// 자체 호스팅 조립의 RoomStore 구현 (architecture.md 3.3). 프로세스 메모리의 Map 이다.
// 판정은 넣지 않는다. 규칙은 signaling-core 에만 있다. 프로세스가 죽으면 사라지고, 복구는 클라이언트 재등록이다.
// 연산마다 await 사이에 다른 호출이 끼어들지 않으므로(동기 본문) 조건부 연산이 원자적이다.

import { LIMITS } from '../protocol/index.js';
import type { ConnBinding, ConnId, PeerRecord, RoomKey, RoomStore } from '../signaling-core/index.js';

interface ConnEntry {
  binding: ConnBinding | null;
  /** 건수를 센 고정 창의 번호(epoch 를 RATE_WINDOW_MS 로 나눈 몫). */
  window: number;
  count: number;
  joinMisses: number;
}

export interface MemoryRoomStore extends RoomStore {
  /** 이 연결의 등록을 건수 변화 없이 본다. 리스너가 미입장 기한을 판정할 때 쓴다. */
  bindingOf(connId: ConnId): ConnBinding | null;
  /** 참가자 기록이 하나라도 있는 방의 수. `/healthz` 와 server.stats 가 쓴다. */
  roomCount(): number;
  /** 연결 항목의 수. 닫힌 연결의 항목이 남지 않는지 시험이 본다. */
  connCount(): number;
}

export function createMemoryRoomStore(): MemoryRoomStore {
  const conns = new Map<ConnId, ConnEntry>();
  const rooms = new Map<RoomKey, Map<string, PeerRecord>>();
  /** claimPeer 로 차지된 기록의 자리(방 키 + 이름). putPeer 로 다시 쓰거나 지우면 없어진다. */
  const claimed = new Set<string>();
  const slotKey = (roomKey: RoomKey, peer: string): string => `${roomKey}\n${peer}`;

  const entryOf = (connId: ConnId): ConnEntry => {
    let entry = conns.get(connId);
    if (entry === undefined) {
      entry = { binding: null, window: -1, count: 0, joinMisses: 0 };
      conns.set(connId, entry);
    }
    return entry;
  };

  const ownedBy = (roomKey: RoomKey, peer: string, connId: ConnId): PeerRecord | null => {
    const found = rooms.get(roomKey)?.get(peer);
    return found !== undefined && found.connId === connId ? found : null;
  };

  /** 읽기 결과. 저장한 기록에는 차지 표시가 없고, 차지된 자리면 claimed 를 붙인다(검토 3차 SERVER-R3-01). */
  const withClaim = (record: PeerRecord): PeerRecord =>
    claimed.has(slotKey(record.roomKey, record.peer)) ? Object.freeze({ ...record, claimed: true }) : record;

  return {
    async hitRate(connId, now) {
      const entry = entryOf(connId);
      const window = Math.floor(now / LIMITS.RATE_WINDOW_MS);
      if (entry.window !== window) {
        entry.window = window;
        entry.count = 0;
      }
      entry.count += 1;
      return { count: entry.count, binding: entry.binding };
    },

    async bind(connId, binding) {
      const entry = entryOf(connId);
      entry.binding = { roomKey: binding.roomKey, peer: binding.peer, sid: binding.sid };
      entry.joinMisses = 0;
    },

    async unbind(connId) {
      const entry = conns.get(connId);
      conns.delete(connId);
      return entry?.binding ?? null;
    },

    async getPeer(roomKey, peer) {
      const found = rooms.get(roomKey)?.get(peer);
      return found === undefined ? null : withClaim(found);
    },

    async putPeer(record, condition) {
      const existing = rooms.get(record.roomKey)?.get(record.peer);
      if (condition.absent === true) {
        if (existing !== undefined) return false;
      } else if (existing === undefined || existing.connId !== condition.connId || existing.seq !== condition.seq) {
        return false;
      }
      let room = rooms.get(record.roomKey);
      if (room === undefined) {
        room = new Map();
        rooms.set(record.roomKey, room);
      }
      // 받은 객체를 그대로 두면 부른 쪽이 나중에 고쳐 저장된 값이 바뀔 수 있다. 차지 표시는 저장하지 않는다(읽을 때 붙인다).
      const { claimed: _ignored, ...stored } = record;
      room.set(record.peer, Object.freeze(stored));
      // 새 판이다. 앞 판의 차지 표시는 없어진다.
      claimed.delete(slotKey(record.roomKey, record.peer));
      return true;
    },

    async listPeers(roomKey) {
      return [...(rooms.get(roomKey)?.values() ?? [])].map(withClaim);
    },

    async touchPeer(roomKey, peer, condition, now) {
      const found = ownedBy(roomKey, peer, condition.connId);
      if (found === null || found.lastSeenAt < condition.seenSince) return false;
      rooms.get(roomKey)?.set(peer, Object.freeze({ ...found, lastSeenAt: now }));
      return true;
    },

    async claimPeer(roomKey, peer, condition) {
      const found = ownedBy(roomKey, peer, condition.connId);
      if (found === null || found.lastSeenAt !== condition.writtenAt) return false;
      claimed.add(slotKey(roomKey, peer));
      return true;
    },

    async deletePeer(roomKey, peer, condition) {
      const found = ownedBy(roomKey, peer, condition.connId);
      if (found === null) return false;
      if (condition.writtenAt !== undefined && (found.lastSeenAt !== condition.writtenAt || claimed.has(slotKey(roomKey, peer)))) return false;
      claimed.delete(slotKey(roomKey, peer));
      const room = rooms.get(roomKey);
      room?.delete(peer);
      // 빈 방의 Map 을 남기지 않는다. 방 ID 를 차례로 넣어 보는 접속이 메모리를 붙잡지 못하게 한다.
      if (room !== undefined && room.size === 0) rooms.delete(roomKey);
      return true;
    },

    async bumpJoinMiss(connId) {
      const entry = entryOf(connId);
      entry.joinMisses += 1;
      return entry.joinMisses;
    },

    bindingOf(connId) {
      return conns.get(connId)?.binding ?? null;
    },

    roomCount() {
      return rooms.size;
    },

    connCount() {
      return conns.size;
    },
  };
}
