// V-U2: signaling-core 의 규칙을 메모리 저장소와 함께 돌린다 (protocol.md 2.3, architecture.md 3.2 의 불변조건).
// 전송과 시계는 대역이다. 증거 수준은 대역이고, 실제 소켓으로 일으킨 것은 tests/wire 가 본다.
// "동시 처리" 묶음은 저장소와 전송의 호출을 하나씩 무작위 순서로 풀어, 공용 서버처럼 처리가 겹치고 뒤섞이는 상황을 만든다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ServerLogFields } from '../diagnostics/log-port.js';
import { LIMITS, encodeClientMessage, parseServerMessage } from '../protocol/index.js';
import type { ClientMessage, ErrorMessage, JoinMode, JoinedMessage, PongMessage, ServerMessage, SignalPayload } from '../protocol/index.js';
import { createSignalingCore } from '../signaling-core/index.js';
import type { ConnectionSink, PeerRecord, RoomStore } from '../signaling-core/index.js';
import { createMemoryRoomStore } from './memory-store.js';
import type { MemoryRoomStore } from './memory-store.js';

const T0 = Math.floor(1_800_000_000_000 / LIMITS.RATE_WINDOW_MS) * LIMITS.RATE_WINDOW_MS;
const STALE = LIMITS.PARTICIPANT_STALE_MS;
const MAX = LIMITS.ROOM_MAX_PEERS;
const ROOM = 'room0000aaaa1111';
const OTHER_ROOM = 'room0000bbbb2222';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const roomKeyOf = (room: string): string => sha256(room).slice(0, 32);
/** 이름이나 연결 이름에서 형식에 맞는 sid 와 key 를 만든다. 같은 입력이면 같은 값이다. */
const sidOf = (label: string): string => sha256(`sid:${label}`).replace(/[^a-z0-9]/g, '').slice(0, 12);
const keyOf = (label: string): string => Buffer.from(sha256(`key:${label}`), 'hex').toString('base64url').slice(0, 43);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 포트 호출을 하나씩 문 앞에 세워 두고 무작위로 하나씩 들여보낸다. 연산 하나는 원자적으로 끝난다. */
function createInterleaver(random: () => number) {
  const waiting: (() => void)[] = [];
  const gate = (): Promise<void> => new Promise((resolve) => waiting.push(resolve));
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  function gated<T extends object>(target: T, methods: readonly (keyof T)[]): T {
    const wrapped = { ...target };
    for (const name of methods) {
      const original = target[name] as unknown as (...args: unknown[]) => Promise<unknown>;
      (wrapped as Record<keyof T, unknown>)[name] = async (...args: unknown[]) => {
        await gate();
        return original.apply(target, args);
      };
    }
    return wrapped;
  }

  async function run(tasks: readonly (() => Promise<unknown>)[]): Promise<void> {
    let left = tasks.length;
    const failures: unknown[] = [];
    for (const task of tasks) {
      void task()
        .catch((error: unknown) => failures.push(error))
        .finally(() => {
          left -= 1;
        });
    }
    let idle = 0;
    while (left > 0) {
      await tick();
      if (waiting.length > 0) {
        idle = 0;
        const [release] = waiting.splice(Math.floor(random() * waiting.length), 1);
        release?.();
      } else {
        idle += 1;
        assert.ok(idle < 200, '처리가 포트 호출 없이 멈췄다');
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  return { gated, run };
}

const STORE_METHODS = ['hitRate', 'bind', 'unbind', 'getPeer', 'putPeer', 'listPeers', 'touchPeer', 'claimPeer', 'deletePeer', 'bumpJoinMiss'] as const;

interface JoinOptions {
  readonly room?: string;
  readonly peer: string;
  readonly mode: JoinMode;
  readonly seq?: number;
  /** key 와 sid 를 정하는 이름. 생략하면 연결 이름이다(연결마다 다른 프로세스). */
  readonly process?: string;
  readonly sid?: string;
  readonly id?: string;
}

interface World {
  readonly core: ReturnType<typeof createSignalingCore>;
  readonly store: MemoryRoomStore;
  /** 성공한 참가자 기록 쓰기(putPeer). `<연결>:<이름>` 의 순서다. */
  readonly writes: string[];
  readonly logs: { event: string; fields: ServerLogFields }[];
  /** sink.close 로 닫힌 연결(순서대로). */
  readonly closed: string[];
  now(): number;
  advance(ms: number): void;
  /** 연결을 연다. 이미 열려 있으면 그대로다. */
  open(connId: string): void;
  /** 소켓이 닫혔지만 종료 통지는 아직 처리되지 않은 상태로 만든다. */
  drop(connId: string): void;
  /** 소켓이 닫히고 종료 통지까지 처리된다. */
  disconnect(connId: string): Promise<void>;
  /** 여러 처리를 함께 돌린다. 뒤섞기를 켠 세계에서는 포트 호출 단위로 뒤섞인다. */
  all(tasks: readonly (() => Promise<unknown>)[]): Promise<void>;
  raw(connId: string, text: string): Promise<void>;
  send(connId: string, message: ClientMessage): Promise<void>;
  join(connId: string, options: JoinOptions): Promise<ServerMessage>;
  /** join 을 보내기만 한다. 같은 join 을 겹쳐 처리하면 답은 다른 처리가 할 수 있다(검토 2차 SERVER-R2-01 의 superseded). */
  sendJoin(connId: string, options: JoinOptions): Promise<void>;
  ping(connId: string): Promise<ServerMessage>;
  signal(connId: string, to: string, payload?: SignalPayload): Promise<ErrorMessage | null>;
  leave(connId: string): Promise<void>;
  /** 그 연결이 지금까지 받은 글. */
  inbox(connId: string): ServerMessage[];
  /** 받은 글을 꺼내고 비운다. */
  take(connId: string): ServerMessage[];
  replyTo(connId: string, id: string): ServerMessage | undefined;
  record(room: string, peer: string): Promise<PeerRecord | null>;
  live(room: string): Promise<PeerRecord[]>;
}

interface WorldOptions {
  readonly seed?: number;
  readonly sendFails?: (connId: string) => boolean;
  /** 이 연결들의 첫 bind 는 저장소 오류로 던진다(DynamoDB 5xx·스로틀·요청 기한. 검토 3차 SERVER-R3-01). */
  readonly bindFailsOnce?: readonly string[];
}

function createWorld(options: WorldOptions = {}): World {
  let at = T0;
  let serial = 0;
  const store = createMemoryRoomStore();
  const isOpen = new Set<string>();
  const inboxes = new Map<string, ServerMessage[]>();
  const closed: string[] = [];
  const logs: World['logs'] = [];
  const interleaver = options.seed === undefined ? null : createInterleaver(mulberry32(options.seed));

  const sink: ConnectionSink = {
    async send(connId, text) {
      if (!isOpen.has(connId)) return 'gone';
      if (options.sendFails?.(connId) === true) throw new Error('transport failure');
      const parsed = parseServerMessage(text);
      assert.ok(parsed.ok, `core 가 클라이언트가 버릴 글을 보냈다: ${parsed.ok ? '' : parsed.code}`);
      const inbox = inboxes.get(connId) ?? [];
      inbox.push(parsed.value);
      inboxes.set(connId, inbox);
      return 'ok';
    },
    async isOpen(connId) {
      return isOpen.has(connId);
    },
    async close(connId) {
      closed.push(connId);
      isOpen.delete(connId);
    },
  };

  const writes: string[] = [];
  const bindFails = new Set(options.bindFailsOnce ?? []);
  const observed: RoomStore = {
    ...store,
    async putPeer(record, condition) {
      const ok = await store.putPeer(record, condition);
      if (ok) writes.push(`${record.connId}:${record.peer}`);
      return ok;
    },
    async bind(connId, binding) {
      if (bindFails.delete(connId)) {
        const error = new Error('throttled');
        error.name = 'ProvisionedThroughputExceededException';
        throw error;
      }
      return store.bind(connId, binding);
    },
  };
  const storeForCore: RoomStore = interleaver === null ? observed : interleaver.gated<RoomStore>(observed, STORE_METHODS);
  const sinkForCore: ConnectionSink = interleaver === null ? sink : interleaver.gated(sink, ['send', 'isOpen', 'close']);
  const core = createSignalingCore({
    store: storeForCore,
    sink: sinkForCore,
    now: () => at,
    log: { event: (_level, _module, event, fields) => logs.push({ event, fields: fields ?? {} }) },
  });

  const all: World['all'] = async (tasks) => {
    if (interleaver === null) await Promise.all(tasks.map((task) => task()));
    else await interleaver.run(tasks);
  };
  const nextId = (): string => {
    serial += 1;
    return `r${serial}`;
  };
  const encode = (message: ClientMessage): string => {
    const encoded = encodeClientMessage(message);
    assert.ok(encoded.ok, `시험이 보낼 수 없는 글을 만들었다: ${encoded.ok ? '' : encoded.detail}`);
    return encoded.value;
  };
  const replyTo: World['replyTo'] = (connId, id) =>
    (inboxes.get(connId) ?? []).findLast((message) => message.type !== 'signal' && message.re === id);

  const world: World = {
    core,
    store,
    writes,
    logs,
    closed,
    now: () => at,
    advance(ms) {
      at += ms;
    },
    open(connId) {
      isOpen.add(connId);
    },
    drop(connId) {
      isOpen.delete(connId);
    },
    async disconnect(connId) {
      isOpen.delete(connId);
      await all([() => core.onDisconnect(connId)]);
    },
    all,
    async raw(connId, text) {
      isOpen.add(connId);
      await all([() => core.onMessage(connId, text)]);
    },
    async send(connId, message) {
      await world.raw(connId, encode(message));
    },
    async sendJoin(connId, o) {
      const process = o.process ?? connId;
      await world.send(connId, {
        action: 'join',
        v: 1,
        id: o.id ?? nextId(),
        room: o.room ?? ROOM,
        peer: o.peer,
        sid: o.sid ?? sidOf(process),
        key: keyOf(process),
        mode: o.mode,
        seq: o.seq ?? 1,
      });
    },
    async join(connId, o) {
      const id = o.id ?? nextId();
      const process = o.process ?? connId;
      await world.send(connId, {
        action: 'join',
        v: 1,
        id,
        room: o.room ?? ROOM,
        peer: o.peer,
        sid: o.sid ?? sidOf(process),
        key: keyOf(process),
        mode: o.mode,
        seq: o.seq ?? 1,
      });
      const reply = replyTo(connId, id);
      assert.ok(reply !== undefined, `join 에 응답이 없다: ${connId}`);
      return reply;
    },
    async ping(connId) {
      const id = nextId();
      await world.send(connId, { action: 'ping', id });
      const reply = replyTo(connId, id);
      assert.ok(reply !== undefined, `ping 에 응답이 없다: ${connId}`);
      return reply;
    },
    async signal(connId, to, payload = { kind: 'offer-request', data: {} }) {
      const id = nextId();
      await world.send(connId, { action: 'signal', id, to, ...payload });
      const reply = replyTo(connId, id);
      if (reply === undefined) return null;
      assert.equal(reply.type, 'error', 'signal 의 응답은 실패 때의 error 뿐이다');
      return reply as ErrorMessage;
    },
    async leave(connId) {
      await world.send(connId, { action: 'leave', id: nextId() });
    },
    inbox: (connId) => [...(inboxes.get(connId) ?? [])],
    take(connId) {
      const messages = inboxes.get(connId) ?? [];
      inboxes.set(connId, []);
      return messages;
    },
    replyTo,
    record: (room, peer) => store.getPeer(roomKeyOf(room), peer),
    async live(room) {
      const records = await store.listPeers(roomKeyOf(room));
      return records.filter((record) => at - record.lastSeenAt <= STALE);
    },
  };
  return world;
}

function expectJoined(message: ServerMessage): JoinedMessage {
  assert.equal(message.type, 'joined', `joined 를 기대했다: ${JSON.stringify(message)}`);
  return message as JoinedMessage;
}

function expectPong(message: ServerMessage): PongMessage {
  assert.equal(message.type, 'pong', `pong 을 기대했다: ${JSON.stringify(message)}`);
  return message as PongMessage;
}

function expectError(message: ServerMessage | null | undefined, code: string): ErrorMessage {
  assert.ok(message !== null && message !== undefined, `error ${code} 를 기대했는데 응답이 없다`);
  assert.equal(message.type, 'error', `error ${code} 를 기대했다: ${JSON.stringify(message)}`);
  assert.equal((message as ErrorMessage).code, code);
  return message as ErrorMessage;
}

const peersOf = (message: JoinedMessage | PongMessage): string[] => message.members.map((member) => member.peer);

/** 방에 n 명을 차례로 넣는다. 연결 이름은 `<prefix><번호>`, 참가자 이름은 `p<번호>` 다. */
async function fillRoom(world: World, count: number, room = ROOM, prefix = 'm'): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    expectJoined(await world.join(`${prefix}${i}`, { room, peer: `p${i}`, mode: i === 0 ? 'create' : 'join' }));
  }
}

describe('V-U2 join 의 세 모드', () => {
  it('create: 빈 방이면 등록하고 빈 목록과 서버 값을 돌려준다', async () => {
    const w = createWorld();
    const joined = expectJoined(await w.join('c1', { peer: 'alice', mode: 'create', id: 'req-1' }));
    assert.deepEqual(joined, {
      type: 'joined',
      re: 'req-1',
      members: [],
      max_peers: 8,
      ping_interval_ms: 30_000,
      stale_after_ms: 90_000,
    });
    const record = await w.record(ROOM, 'alice');
    assert.equal(record?.connId, 'c1');
    assert.equal(record?.sid, sidOf('c1'));
    assert.deepEqual(w.store.bindingOf('c1'), { roomKey: roomKeyOf(ROOM), peer: 'alice', sid: sidOf('c1') });
  });

  it('create: 다른 참가자가 있으면 ROOM_EXISTS 이고 자기 기록을 지운다', async () => {
    const w = createWorld();
    expectJoined(await w.join('c1', { peer: 'alice', mode: 'create' }));
    const before = await w.record(ROOM, 'alice');
    expectError(await w.join('c2', { peer: 'bob', mode: 'create', id: 'again' }), 'ROOM_EXISTS');
    assert.equal(w.replyTo('c2', 'again')?.type, 'error');
    assert.equal(await w.record(ROOM, 'bob'), null);
    assert.equal(w.store.bindingOf('c2'), null);
    assert.deepEqual(await w.record(ROOM, 'alice'), before, '있던 참가자의 기록은 그대로다');
    expectError(await w.ping('c2'), 'NOT_JOINED');
    assert.deepEqual(w.closed, [], '연결은 닫지 않는다');
  });

  it('join: 참가자가 있으면 자신을 뺀 목록을 sid 와 함께 받는다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'bob', mode: 'create' });
    await w.join('c2', { peer: 'alice', mode: 'join' });
    const joined = expectJoined(await w.join('c3', { peer: 'carol', mode: 'join' }));
    assert.deepEqual(joined.members, [
      { peer: 'alice', sid: sidOf('c2') },
      { peer: 'bob', sid: sidOf('c1') },
    ]);
  });

  it('join: 아무도 없으면 ROOM_NOT_FOUND 이고 기록이 남지 않는다', async () => {
    const w = createWorld();
    expectError(await w.join('c1', { peer: 'alice', mode: 'join' }), 'ROOM_NOT_FOUND');
    assert.equal(await w.record(ROOM, 'alice'), null);
    assert.equal(w.store.roomCount(), 0);
    assert.equal(w.store.bindingOf('c1'), null);
    // 실패한 입장이 방을 만들지 않았으므로 뒤이은 join 도 방을 못 찾는다.
    expectError(await w.join('c2', { peer: 'bob', mode: 'join' }), 'ROOM_NOT_FOUND');
  });

  it('resume: 방에 대한 조건이 없다. 비어 있으면 다시 만든 것과 같다', async () => {
    const w = createWorld();
    assert.deepEqual(expectJoined(await w.join('c1', { peer: 'alice', mode: 'resume', seq: 4 })).members, []);
    assert.deepEqual(peersOf(expectJoined(await w.join('c2', { peer: 'bob', mode: 'resume' }))), ['alice']);
    assert.deepEqual(peersOf(expectJoined(await w.join('c3', { peer: 'carol', mode: 'join' }))), ['alice', 'bob']);
  });

  it(`정원: ${MAX} 명까지 받고 그 다음은 모드와 무관하게 ROOM_FULL 이다. 자리가 나면 다시 받는다`, async () => {
    const w = createWorld();
    await fillRoom(w, MAX);
    assert.equal((await w.live(ROOM)).length, MAX);
    for (const mode of ['join', 'resume'] as const) {
      expectError(await w.join(`late-${mode}`, { peer: 'late', mode }), 'ROOM_FULL');
      assert.equal(await w.record(ROOM, 'late'), null, '거절된 쪽의 기록이 남지 않는다');
    }
    assert.equal((await w.live(ROOM)).length, MAX);
    await w.leave('m3');
    const joined = expectJoined(await w.join('late-join', { peer: 'late', mode: 'join' }));
    assert.equal(joined.members.length, MAX - 1);
    assert.deepEqual(w.closed, []);
  });

  it('지원하지 않는 v 는 UNSUPPORTED_VERSION 과 supported 목록이다. 다른 필드가 틀려도 같다', async () => {
    const w = createWorld();
    await w.raw('c1', JSON.stringify({ action: 'join', v: 99, id: 'v-1', room: ROOM, peer: 'alice', sid: sidOf('c1'), key: keyOf('c1'), mode: 'create', seq: 1 }));
    const refused = expectError(w.replyTo('c1', 'v-1'), 'UNSUPPORTED_VERSION');
    assert.deepEqual(refused.supported, [1]);
    await w.raw('c1', JSON.stringify({ action: 'join', v: 2, id: 'v-2', somethingNew: true }));
    assert.deepEqual(expectError(w.replyTo('c1', 'v-2'), 'UNSUPPORTED_VERSION').supported, [1]);
    assert.equal(w.store.roomCount(), 0);
    assert.deepEqual(w.closed, []);
  });

  it('예약 이름과 형식이 틀린 이름·방 ID·key·seq 는 BAD_MESSAGE 이고 아무 것도 쓰지 않는다', async () => {
    const w = createWorld();
    const good = { action: 'join', v: 1, room: ROOM, peer: 'alice', sid: sidOf('c1'), key: keyOf('c1'), mode: 'create', seq: 1 };
    const bad: Record<string, unknown>[] = [
      { peer: 'system' },
      { peer: 'Agent-Chat' },
      { peer: 'has space' },
      { peer: '' },
      { room: 'short' },
      { room: 'UPPERCASE0000000' },
      { key: 'too-short' },
      { sid: 'TOOLOUD12345' },
      { seq: 0 },
      { seq: 1.5 },
      { mode: 'takeover' },
    ];
    for (const [index, change] of bad.entries()) {
      await w.raw('c1', JSON.stringify({ ...good, id: `b-${index}`, ...change }));
      expectError(w.replyTo('c1', `b-${index}`), 'BAD_MESSAGE');
    }
    assert.equal(w.store.roomCount(), 0);
    assert.deepEqual(w.closed, []);
  });

  it('이미 다른 (방, 이름)으로 등록된 연결의 join 은 BAD_MESSAGE 이고 등록은 그대로다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    expectError(await w.join('c1', { peer: 'alice2', mode: 'resume' }), 'BAD_MESSAGE');
    expectError(await w.join('c1', { room: OTHER_ROOM, peer: 'alice', mode: 'create' }), 'BAD_MESSAGE');
    assert.equal(await w.record(ROOM, 'alice2'), null);
    assert.equal(await w.record(OTHER_ROOM, 'alice'), null);
    assert.equal((await w.record(ROOM, 'alice'))?.connId, 'c1');
    expectPong(await w.ping('c1'));
  });
});

describe('V-U2 같은 join 다시 보내기', () => {
  it('등록된 연결이 같은 join 을 다시 보내면 판정 없이 joined 를 다시 받는다(그 사이 들어온 참가자가 있어도 ROOM_EXISTS 가 아니다)', async () => {
    const w = createWorld();
    expectJoined(await w.join('c1', { peer: 'alice', mode: 'create', id: 'same-id' }));
    expectJoined(await w.join('c2', { peer: 'bob', mode: 'join' }));
    w.advance(5_000);
    const before = await w.record(ROOM, 'alice');
    w.take('c1');
    const again = expectJoined(await w.join('c1', { peer: 'alice', mode: 'create', id: 'same-id' }));
    assert.deepEqual(again.members, [{ peer: 'bob', sid: sidOf('c2') }]);
    assert.equal(again.re, 'same-id');
    assert.equal(w.take('c1').length, 1, 'joined 한 건만 온다');
    assert.deepEqual(await w.record(ROOM, 'alice'), before, '기록을 다시 쓰지 않는다');
    assert.equal(w.logs.filter((entry) => entry.event === 'conn.join').at(-1)?.fields.outcome, 'resent');
  });

  it('정원이 찬 뒤에 다시 보내도 ROOM_FULL 이 아니다', async () => {
    const w = createWorld();
    await fillRoom(w, MAX);
    const again = expectJoined(await w.join('m5', { peer: 'p5', mode: 'join' }));
    assert.equal(again.members.length, MAX - 1);
  });
});

describe('V-U2 인계와 접속 순번', () => {
  it('같은 key 의 더 큰 seq 가 새 연결에서 오면 인계한다. 옛 연결은 REPLACED 를 받고 닫힌다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    await w.join('old', { peer: 'alice', mode: 'join', process: 'proc-a', seq: 1 });
    w.advance(1_000);
    const joined = expectJoined(await w.join('new', { peer: 'alice', mode: 'resume', process: 'proc-a', seq: 2, sid: 'newsid000001' }));
    assert.deepEqual(peersOf(joined), ['host']);

    const record = await w.record(ROOM, 'alice');
    assert.equal(record?.connId, 'new');
    assert.equal(record?.seq, 2);
    assert.equal(record?.sid, 'newsid000001');
    assert.equal(record?.lastSeenAt, w.now());
    assert.equal((await w.live(ROOM)).length, 2, '인계는 참가자 수를 늘리지 않는다');

    const replaced = w.inbox('old').at(-1);
    assert.equal(expectError(replaced, 'REPLACED').re, undefined, '옛 연결에 가는 REPLACED 는 요청의 응답이 아니다');
    assert.deepEqual(w.closed, ['old']);
    assert.equal(w.logs.filter((entry) => entry.event === 'conn.join').at(-1)?.fields.takeover, true);
  });

  it('인계 뒤 옛 연결의 ping 은 NOT_JOINED 이고, 옛 연결의 leave 와 종료 통지는 새 기록을 지우지 못한다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    await w.join('old', { peer: 'alice', mode: 'join', process: 'proc-a', seq: 1 });
    await w.join('new', { peer: 'alice', mode: 'resume', process: 'proc-a', seq: 2 });
    const after = await w.record(ROOM, 'alice');

    // 닫기는 최선이다. 닫히지 않은 옛 연결이 계속 보내는 경우를 본다.
    w.open('old');
    expectError(await w.ping('old'), 'NOT_JOINED');
    assert.deepEqual(await w.record(ROOM, 'alice'), after, '옛 연결의 ping 이 lastSeenAt 을 바꾸지 못한다');
    await w.leave('old');
    assert.deepEqual(await w.record(ROOM, 'alice'), after);
    await w.disconnect('old');
    await w.disconnect('old');
    assert.deepEqual(await w.record(ROOM, 'alice'), after);
    assert.deepEqual(peersOf(expectPong(await w.ping('host'))), ['alice']);
    expectPong(await w.ping('new'));
  });

  it('seq 가 저장된 값보다 작은 join 은 기록을 바꾸지 못하고 그 연결이 REPLACED 를 받고 닫힌다', async () => {
    const w = createWorld();
    await w.join('new', { peer: 'alice', mode: 'create', process: 'proc-a', seq: 5 });
    w.advance(2_000);
    const before = await w.record(ROOM, 'alice');
    const refused = expectError(await w.join('old', { peer: 'alice', mode: 'resume', process: 'proc-a', seq: 4, id: 'late-join' }), 'REPLACED');
    assert.equal(refused.re, 'late-join');
    assert.deepEqual(w.closed, ['old']);
    assert.deepEqual(await w.record(ROOM, 'alice'), before);
    assert.equal(w.store.bindingOf('old'), null);
    assert.equal(w.inbox('new').some((message) => message.type === 'error'), false, '새 연결은 아무 것도 받지 않는다');
    assert.equal(w.logs.filter((entry) => entry.event === 'conn.join').at(-1)?.fields.seq_stale, true);
  });

  it('seq 가 같은 다른 연결도 인계하지 못한다(더 큰 seq 일 때만 인계한다)', async () => {
    const w = createWorld();
    await w.join('first', { peer: 'alice', mode: 'create', process: 'proc-a', seq: 3 });
    const before = await w.record(ROOM, 'alice');
    expectError(await w.join('second', { peer: 'alice', mode: 'resume', process: 'proc-a', seq: 3 }), 'REPLACED');
    assert.deepEqual(await w.record(ROOM, 'alice'), before);
    assert.deepEqual(w.closed, ['second']);
  });

  it('정원이 찬 방에서도 인계는 된다', async () => {
    const w = createWorld();
    await fillRoom(w, MAX);
    const joined = expectJoined(await w.join('m2-new', { peer: 'p2', mode: 'resume', process: 'm2', seq: 2 }));
    assert.equal(joined.members.length, MAX - 1);
    assert.equal((await w.live(ROOM)).length, MAX);
    assert.deepEqual(w.closed, ['m2']);
  });

  it('인계된 연결이 보내는 signal 의 sid 는 새 등록의 값이다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    await w.join('old', { peer: 'alice', mode: 'join', process: 'proc-a', seq: 1, sid: 'oldsid000001' });
    await w.join('new', { peer: 'alice', mode: 'resume', process: 'proc-a', seq: 2, sid: 'newsid000002' });
    w.take('host');
    assert.equal(await w.signal('new', 'host'), null);
    assert.deepEqual(w.take('host'), [{ type: 'signal', from: 'alice', sid: 'newsid000002', kind: 'offer-request', data: {} }]);
  });

  it('앞선 처리가 등록 전에 끊겨 기록만 남은 연결이 같은 join 을 다시 보내면 등록을 마친다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    // 기록을 쓴 뒤 등록(bind) 전에 처리가 끊긴 상태를 만든다.
    const orphan: PeerRecord = {
      roomKey: roomKeyOf(ROOM),
      peer: 'alice',
      connId: 'c1',
      sid: sidOf('c1'),
      keyHash: sha256(keyOf('c1')),
      seq: 1,
      lastSeenAt: w.now(),
    };
    assert.equal(await w.store.putPeer(orphan, { absent: true }), true);
    w.advance(3_000);
    expectJoined(await w.join('c1', { peer: 'alice', mode: 'join' }));
    assert.deepEqual(await w.record(ROOM, 'alice'), { ...orphan, claimed: true }, '기록의 값은 그대로 두고 차지만 한다');
    assert.notEqual(w.store.bindingOf('c1'), null);
  });
});

describe('V-U2 이름 충돌', () => {
  it('key 가 다르고 이전 연결이 열려 있으면 NAME_IN_USE 이고 기록은 그대로다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    await w.join('c1', { peer: 'alice', mode: 'join' });
    const before = await w.record(ROOM, 'alice');
    expectError(await w.join('c2', { peer: 'alice', mode: 'join' }), 'NAME_IN_USE');
    assert.deepEqual(await w.record(ROOM, 'alice'), before);
    assert.equal(w.store.bindingOf('c2'), null);
    assert.deepEqual(w.closed, []);
    assert.equal(w.inbox('c1').some((message) => message.type === 'error'), false);
  });

  it('key 가 다르고 이전 연결이 닫혔으면 새로 쓴다. 늦게 온 옛 연결의 종료 통지는 새 기록을 지우지 못한다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    await w.join('c1', { peer: 'alice', mode: 'join' });
    // 소켓은 닫혔지만 종료 통지가 아직 처리되지 않았다.
    w.drop('c1');
    expectJoined(await w.join('c2', { peer: 'alice', mode: 'join' }));
    const fresh = await w.record(ROOM, 'alice');
    assert.equal(fresh?.connId, 'c2');
    assert.equal(fresh?.sid, sidOf('c2'));

    await w.disconnect('c1');
    assert.deepEqual(await w.record(ROOM, 'alice'), fresh);
    assert.deepEqual(peersOf(expectPong(await w.ping('host'))), ['alice']);
    assert.equal(w.logs.filter((entry) => entry.event === 'conn.closed').at(-1)?.fields.outcome, 'kept');
  });

  it('오래된 기록은 이전 연결이 열려 있어도 새로 쓴다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    await w.join('c1', { peer: 'alice', mode: 'join' });
    // host 는 오래되기 전에 ping 을 보내 살아 있고, alice 만 오래된다.
    w.advance(STALE);
    expectPong(await w.ping('host'));
    w.advance(1);
    expectJoined(await w.join('c2', { peer: 'alice', mode: 'join' }));
    assert.equal((await w.record(ROOM, 'alice'))?.connId, 'c2');
    // 자리를 잃은 옛 연결은 다음 ping 에서 알게 된다.
    expectError(await w.ping('c1'), 'NOT_JOINED');
  });
});

describe('V-U2 오래됨 필터', () => {
  it(`마지막 join·ping 뒤 ${STALE}ms 까지는 살아 있고, 1ms 더 지나면 목록에서 빠진다. 기록은 타이머로 지우지 않는다`, async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    w.advance(STALE);
    assert.deepEqual(peersOf(expectPong(await w.ping('c2'))), ['alice'], '경계에서는 아직 살아 있다');
    w.advance(1);
    assert.deepEqual(peersOf(expectPong(await w.ping('c2'))), []);
    assert.deepEqual(peersOf(expectJoined(await w.join('c3', { peer: 'carol', mode: 'join' }))), ['bob']);
    assert.notEqual(await w.record(ROOM, 'alice'), null, '읽을 때 걸러낼 뿐 지우지 않는다');
  });

  it('오래된 참가자에게 보낸 signal 은 PEER_NOT_FOUND 이고 전달되지 않는다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    w.advance(STALE + 1);
    await w.ping('c2');
    w.take('c1');
    expectError(await w.signal('c2', 'alice'), 'PEER_NOT_FOUND');
    assert.deepEqual(w.take('c1'), []);
  });

  it('오래된 참가자만 남은 방은 없는 방이다: join 은 ROOM_NOT_FOUND, create 는 성공', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    w.advance(STALE + 1);
    expectError(await w.join('c2', { peer: 'bob', mode: 'join' }), 'ROOM_NOT_FOUND');
    assert.deepEqual(expectJoined(await w.join('c3', { peer: 'carol', mode: 'create' })).members, []);
  });

  it('오래된 기록은 정원에 세지 않는다', async () => {
    const w = createWorld();
    await fillRoom(w, MAX);
    w.advance(STALE);
    for (let i = 0; i < MAX - 1; i += 1) expectPong(await w.ping(`m${i}`));
    // p7 만 ping 을 하지 않았다.
    w.advance(1);
    const joined = expectJoined(await w.join('late', { peer: 'late', mode: 'join' }));
    assert.equal(joined.members.length, MAX - 1);
    assert.equal(joined.members.some((member) => member.peer === `p${MAX - 1}`), false);
  });

  it('오래된 기록은 ping 으로 되살아나지 않는다. 그 연결은 NOT_JOINED 를 받고, 그 사이 자리가 찬 방은 정원을 넘지 않는다', async () => {
    const w = createWorld();
    await fillRoom(w, MAX);
    w.advance(STALE);
    for (let i = 0; i < MAX - 1; i += 1) expectPong(await w.ping(`m${i}`));
    w.advance(1);
    // p7 이 조용한 사이 다른 참가자가 그 자리에 들어온다.
    expectJoined(await w.join('late', { peer: 'late', mode: 'join' }));
    const before = await w.record(ROOM, `p${MAX - 1}`);

    expectError(await w.ping(`m${MAX - 1}`), 'NOT_JOINED');
    assert.deepEqual(await w.record(ROOM, `p${MAX - 1}`), before, 'lastSeenAt 을 올리지 않는다');
    assert.equal((await w.live(ROOM)).length, MAX, '살아 있는 참가자가 정원을 넘지 않는다');

    // 새 연결로 다시 등록하면 정원을 다시 판정받는다.
    expectError(await w.join('m7-again', { peer: `p${MAX - 1}`, process: `m${MAX - 1}`, mode: 'resume', seq: 2 }), 'ROOM_FULL');
    assert.equal((await w.live(ROOM)).length, MAX);
  });

  it('오래됨의 경계(정확히 PARTICIPANT_STALE_MS)에 온 ping 은 받아들인다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    w.advance(STALE);
    expectPong(await w.ping('c1'));
    assert.equal((await w.record(ROOM, 'alice'))?.lastSeenAt, w.now());
  });

  it('ping 이 lastSeenAt 을 올려 살아 있게 한다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    for (let i = 0; i < 6; i += 1) {
      w.advance(30_000);
      expectPong(await w.ping('c1'));
      assert.deepEqual(peersOf(expectPong(await w.ping('c2'))), ['alice']);
    }
    assert.equal((await w.record(ROOM, 'alice'))?.lastSeenAt, w.now());
  });
});

describe('V-U2 signal 전달', () => {
  const cid = `${sidOf('c1')}.1`;
  const payloads: SignalPayload[] = [
    { kind: 'offer-request', data: {} },
    { kind: 'offer', cid, data: { sdp: 'v=0 offer-body' } },
    { kind: 'answer', cid, data: { sdp: 'v=0 answer-body' } },
    {
      kind: 'candidate',
      cid,
      data: {
        list: [
          { candidate: 'candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host', mid: '0' },
          { candidate: 'candidate:2 1 udp 1686052607 198.51.100.7 50001 typ srflx raddr 192.0.2.10 rport 50000', mid: '0' },
        ],
      },
    },
  ];

  it('네 종류 모두 대상에게만, 보낸 연결의 등록에서 붙인 from 과 sid 와 함께 간다. 보낸 쪽에는 응답이 없다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    await w.join('c3', { peer: 'carol', mode: 'join' });
    for (const connId of ['c1', 'c2', 'c3']) w.take(connId);

    for (const payload of payloads) assert.equal(await w.signal('c1', 'bob', payload), null);
    assert.deepEqual(
      w.take('c2'),
      payloads.map((payload) => ({ type: 'signal', from: 'alice', sid: sidOf('c1'), ...payload })),
    );
    assert.deepEqual(w.take('c1'), []);
    assert.deepEqual(w.take('c3'), [], '같은 방의 다른 참가자에게 가지 않는다');
  });

  it('클라이언트가 보낸 from·sid 와 모르는 필드는 전달되지 않는다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    w.take('c2');
    await w.raw(
      'c1',
      JSON.stringify({ action: 'signal', id: 'x1', to: 'bob', kind: 'offer-request', data: { extra: 1 }, from: 'mallory', sid: 'forged000000', chat: 'hello' }),
    );
    assert.deepEqual(w.take('c2'), [{ type: 'signal', from: 'alice', sid: sidOf('c1'), kind: 'offer-request', data: {} }]);
  });

  it('등록 없이 보내면 NOT_JOINED, 자기 자신에게 보내면 BAD_MESSAGE, 없는 이름이면 PEER_NOT_FOUND 다. 모두 요청의 id 를 싣는다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    for (const [connId, to, code] of [
      ['stranger', 'alice', 'NOT_JOINED'],
      ['c1', 'alice', 'BAD_MESSAGE'],
      ['c1', 'nobody', 'PEER_NOT_FOUND'],
    ] as const) {
      w.take('c1');
      const refused = expectError(await w.signal(connId, to), code);
      assert.ok(typeof refused.re === 'string' && refused.re.length > 0);
      if (connId !== 'c1') assert.deepEqual(w.take('c1'), [], '등록 없는 연결의 signal 이 전달됐다');
    }
    assert.deepEqual(w.closed, []);
  });

  it('relay 후보가 든 offer·answer·candidate 는 전달하지 않고 RELAY_NOT_ALLOWED 다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    w.take('c2');
    const relayLine = 'candidate:3 1 udp 41885439 203.0.113.9 3478 typ relay raddr 198.51.100.7 rport 50001';
    const withRelay: SignalPayload[] = [
      { kind: 'offer', cid, data: { sdp: `v=0\r\na=${relayLine}\r\n` } },
      { kind: 'answer', cid, data: { sdp: `v=0\r\na=${relayLine}\r\n` } },
      { kind: 'candidate', cid, data: { list: [{ candidate: 'candidate:1 1 udp 1 192.0.2.10 50000 typ host', mid: '0' }, { candidate: relayLine, mid: '0' }] } },
    ];
    for (const payload of withRelay) expectError(await w.signal('c1', 'bob', payload), 'RELAY_NOT_ALLOWED');
    assert.deepEqual(w.take('c2'), []);
  });

  it('다른 방에는 전달하지 않는다. 다른 방에만 있는 이름은 PEER_NOT_FOUND 다', async () => {
    const w = createWorld();
    await w.join('a1', { room: ROOM, peer: 'alice', mode: 'create' });
    await w.join('a2', { room: ROOM, peer: 'bob', mode: 'join' });
    await w.join('b1', { room: OTHER_ROOM, peer: 'bob', mode: 'create' });
    await w.join('b2', { room: OTHER_ROOM, peer: 'dave', mode: 'join' });
    for (const connId of ['a1', 'a2', 'b1', 'b2']) w.take(connId);

    assert.equal(await w.signal('a1', 'bob'), null);
    assert.equal(w.take('a2').length, 1);
    assert.deepEqual(w.take('b1'), [], '같은 이름의 다른 방 참가자에게 갔다');
    expectError(await w.signal('a1', 'dave'), 'PEER_NOT_FOUND');
    assert.deepEqual(w.take('b2'), []);
  });

  it('대상의 연결이 없으면 그 기록을 지우고 PEER_NOT_FOUND 다(유령 참가자)', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    w.drop('c2');
    assert.deepEqual(peersOf(expectPong(await w.ping('c1'))), ['bob'], '종료 통지가 오기 전에는 목록에 남아 있다');
    expectError(await w.signal('c1', 'bob'), 'PEER_NOT_FOUND');
    assert.equal(await w.record(ROOM, 'bob'), null);
    assert.deepEqual(peersOf(expectPong(await w.ping('c1'))), []);
  });

  it('대상으로의 전송이 다른 이유로 실패하면 SERVER_ERROR 이고 기록은 남는다', async () => {
    const w = createWorld({ sendFails: (connId) => connId === 'c2' });
    await w.join('c1', { peer: 'alice', mode: 'create' });
    // 연결을 먼저 연다. 닫힌 연결이면 joined 가 "연결 없음"이 되어 등록을 지운다(검토 2차 SERVER-R2-02).
    w.open('c2');
    await w.all([() => w.core.onMessage('c2', JSON.stringify({ action: 'join', v: 1, id: 'j', room: ROOM, peer: 'bob', sid: sidOf('c2'), key: keyOf('c2'), mode: 'join', seq: 1 }))]);
    const failed = expectError(await w.signal('c1', 'bob'), 'SERVER_ERROR');
    assert.ok(failed.re !== undefined);
    assert.notEqual(await w.record(ROOM, 'bob'), null);
  });
});

describe('V-U2 ping, leave, 종료 통지', () => {
  it('등록 없는 ping 은 NOT_JOINED 다', async () => {
    const w = createWorld();
    expectError(await w.ping('c1'), 'NOT_JOINED');
    assert.deepEqual(w.closed, []);
  });

  it('leave 는 기록과 등록을 지우고 응답하지 않는다. 그 뒤의 ping 은 NOT_JOINED, 그 참가자에게 보낸 signal 은 PEER_NOT_FOUND 다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    w.take('c2');
    await w.leave('c2');
    assert.deepEqual(w.take('c2'), []);
    assert.equal(await w.record(ROOM, 'bob'), null);
    assert.equal(w.store.bindingOf('c2'), null);
    expectError(await w.ping('c2'), 'NOT_JOINED');
    expectError(await w.signal('c1', 'bob'), 'PEER_NOT_FOUND');
    assert.deepEqual(peersOf(expectPong(await w.ping('c1'))), []);
    assert.deepEqual(w.closed, [], '서버가 닫지 않는다. 클라이언트가 닫는다');
  });

  it('등록 없는 연결의 leave 는 아무 일도 없다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.leave('stranger');
    assert.deepEqual(w.inbox('stranger'), []);
    assert.notEqual(await w.record(ROOM, 'alice'), null);
  });

  it('종료 통지는 여러 번 와도 결과가 같다. 닫힌 연결의 항목이 저장소에 남지 않는다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    await w.disconnect('c2');
    await w.disconnect('c2');
    await w.disconnect('never-seen');
    assert.equal(await w.record(ROOM, 'bob'), null);
    assert.equal(w.store.connCount(), 1);
    assert.equal(w.logs.filter((entry) => entry.event === 'conn.closed' && entry.fields.outcome === 'removed').length, 1);
  });

  it('마지막 참가자가 나가면 방이 없어진다. 같은 ID 로 다시 만들 수 있다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.disconnect('c1');
    assert.equal(w.store.roomCount(), 0);
    expectError(await w.join('c2', { peer: 'bob', mode: 'join' }), 'ROOM_NOT_FOUND');
    expectJoined(await w.join('c3', { peer: 'carol', mode: 'create' }));
  });
});

describe('V-U2 속도 제한', () => {
  const limit = LIMITS.RATE_MAX_MESSAGES;

  it(`한 창에 ${limit}건까지 처리하고 그 다음 건에 RATE_LIMITED 를 보내고 연결을 닫는다`, async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    w.advance(1_234);
    for (let i = 1; i < limit; i += 1) expectPong(await w.ping('c1'));
    assert.deepEqual(w.closed, []);
    w.take('c1');

    await w.send('c1', { action: 'ping', id: 'over' });
    const [only, ...rest] = w.take('c1');
    const limited = expectError(only, 'RATE_LIMITED');
    assert.deepEqual(rest, [], '넘은 건은 처리하지 않는다');
    assert.equal(limited.retry_after_ms, LIMITS.RATE_WINDOW_MS - 1_234, '남은 창의 길이');
    assert.deepEqual(w.closed, ['c1']);
    assert.equal(w.logs.some((entry) => entry.event === 'rate.limited' && entry.fields.reason === 'rate'), true);
  });

  it('잘못된 글과 바이너리 프레임(빈 문자열)도 센다', async () => {
    const w = createWorld();
    for (let i = 0; i < limit; i += 1) await w.raw('c1', i % 2 === 0 ? '{broken' : '');
    const errors = w.take('c1');
    assert.equal(errors.length, limit);
    assert.equal(errors.every((message) => message.type === 'error' && message.code === 'BAD_MESSAGE'), true);
    assert.deepEqual(w.closed, []);
    await w.raw('c1', '{broken');
    expectError(w.take('c1')[0], 'RATE_LIMITED');
    assert.deepEqual(w.closed, ['c1']);
  });

  it('창이 바뀌면 다시 받는다. 다른 연결의 건수와 섞이지 않는다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    for (let i = 1; i < limit; i += 1) await w.send('c1', { action: 'ping', id: `p${i}` });
    expectPong(await w.ping('c2'));
    w.advance(LIMITS.RATE_WINDOW_MS);
    expectPong(await w.ping('c1'));
    assert.deepEqual(w.closed, []);
  });

  it('상한을 넘는 글도 센다: 한도까지는 MESSAGE_TOO_LARGE, 그 다음 건에 RATE_LIMITED 를 보내고 닫는다', async () => {
    const w = createWorld();
    const big = JSON.stringify({ action: 'ping', id: 'big', pad: 'x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES) });
    for (let i = 0; i < limit; i += 1) await w.raw('c1', big);
    const errors = w.take('c1');
    assert.equal(errors.length, limit);
    assert.equal(errors.every((message) => message.type === 'error' && message.code === 'MESSAGE_TOO_LARGE' && message.re === undefined), true);
    assert.deepEqual(w.closed, []);
    await w.raw('c1', big);
    expectError(w.take('c1')[0], 'RATE_LIMITED');
    assert.deepEqual(w.closed, ['c1']);
  });
});

describe('V-U2 없는 방 입장의 반복', () => {
  const max = LIMITS.JOIN_MISS_MAX;

  it(`한 연결의 연속 ROOM_NOT_FOUND 가 ${max}회에 닿으면 RATE_LIMITED 를 보내고 닫는다`, async () => {
    const w = createWorld();
    for (let i = 1; i < max; i += 1) {
      expectError(await w.join('c1', { room: `guess0000000000${i}`, peer: 'alice', mode: 'join' }), 'ROOM_NOT_FOUND');
    }
    assert.deepEqual(w.closed, []);
    const last = expectError(await w.join('c1', { room: 'guess00000000099', peer: 'alice', mode: 'join', id: 'fifth' }), 'RATE_LIMITED');
    assert.equal(last.re, 'fifth');
    assert.deepEqual(w.closed, ['c1']);
    assert.equal(w.store.roomCount(), 0);
    assert.equal(w.logs.some((entry) => entry.event === 'rate.limited' && entry.fields.reason === 'join_miss'), true);
  });

  it('다른 연결의 실패와 섞이지 않고, 입장에 성공하면 횟수가 0 으로 돌아간다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    for (let i = 1; i < max; i += 1) {
      expectError(await w.join('c1', { room: OTHER_ROOM, peer: 'alice', mode: 'join' }), 'ROOM_NOT_FOUND');
      expectError(await w.join('c2', { room: OTHER_ROOM, peer: 'bob', mode: 'join' }), 'ROOM_NOT_FOUND');
    }
    expectJoined(await w.join('c1', { room: ROOM, peer: 'alice', mode: 'join' }));
    await w.leave('c1');
    for (let i = 1; i < max; i += 1) {
      expectError(await w.join('c1', { room: OTHER_ROOM, peer: 'alice', mode: 'join' }), 'ROOM_NOT_FOUND');
    }
    assert.deepEqual(w.closed, []);
    expectError(await w.join('c1', { room: OTHER_ROOM, peer: 'alice', mode: 'join' }), 'RATE_LIMITED');
    assert.deepEqual(w.closed, ['c1']);
  });
});

describe('V-U2 잘못된 입력', () => {
  it('JSON 이 아니거나 스키마에 맞지 않으면 BAD_MESSAGE 로 답하고 연결을 유지한다. 읽을 수 있는 id 는 돌려준다', async () => {
    const w = createWorld();
    await w.join('c1', { peer: 'alice', mode: 'create' });
    await w.join('c2', { peer: 'bob', mode: 'join' });
    const before = [await w.record(ROOM, 'alice'), await w.record(ROOM, 'bob')];
    w.take('c1');
    w.take('c2');

    const cases: [text: string, re: string | undefined][] = [
      ['', undefined],
      ['not json', undefined],
      ['[]', undefined],
      ['null', undefined],
      ['{"action":"dance","id":"u1"}', 'u1'],
      ['{"id":"u2"}', 'u2'],
      ['{"action":"ping"}', undefined],
      ['{"action":"ping","id":"bad id with spaces"}', undefined],
      ['{"action":"signal","id":"u3","to":"bob","kind":"offer","data":{"sdp":"x"}}', 'u3'],
      ['{"action":"signal","id":"u4","to":"bob","kind":"candidate","cid":"aaaaaaaaaaaa.1","data":{"list":[]}}', 'u4'],
      ['{"action":"signal","id":"u5","to":"system","kind":"offer-request","data":{}}', 'u5'],
      ['{"action":"signal","id":"u6","to":"bob","kind":"chat","data":{"text":"hi"}}', 'u6'],
    ];
    for (const [text, re] of cases) {
      await w.raw('c2', text);
      const [reply, ...rest] = w.take('c2');
      assert.equal(expectError(reply, 'BAD_MESSAGE').re, re, text);
      assert.deepEqual(rest, []);
    }
    assert.deepEqual(w.take('c1'), [], '다른 연결에 아무 것도 가지 않는다');
    assert.deepEqual([await w.record(ROOM, 'alice'), await w.record(ROOM, 'bob')], before, '기록이 바뀌지 않는다');
    assert.deepEqual(w.closed, []);
    expectPong(await w.ping('c2'));
  });
});

describe('V-U2 동시 처리: 호출을 섞고 겹쳐도 지켜지는 것', () => {
  const ROUNDS = 150;

  it(`정원에서 하나 모자란 방에 4개 연결이 동시에 join 해도 통과는 1 이하이고 정원을 넘지 않는다 (${ROUNDS}회)`, async (t) => {
    const winnersPerRound = new Map<number, number>();
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed });
      await fillRoom(w, MAX - 1);
      const joiners = ['j0', 'j1', 'j2', 'j3'];
      for (const connId of joiners) w.open(connId);
      const text = (connId: string): string => {
        const encoded = encodeClientMessage({ action: 'join', v: 1, id: 'race', room: ROOM, peer: `n-${connId}`, sid: sidOf(connId), key: keyOf(connId), mode: 'join', seq: 1 });
        assert.ok(encoded.ok);
        return encoded.value;
      };
      await w.all(joiners.map((connId) => () => w.core.onMessage(connId, text(connId))));

      const replies = joiners.map((connId) => w.replyTo(connId, 'race'));
      const winners = replies.filter((reply) => reply?.type === 'joined').length;
      const full = replies.filter((reply) => reply?.type === 'error' && reply.code === 'ROOM_FULL').length;
      assert.ok(winners <= 1, `seed ${seed}: 통과 ${winners}`);
      assert.equal(winners + full, joiners.length, `seed ${seed}: 통과도 ROOM_FULL 도 아닌 응답이 있다`);
      const live = await w.live(ROOM);
      assert.ok(live.length <= MAX, `seed ${seed}: 정원 초과 ${live.length}`);
      assert.equal(live.length, MAX - 1 + winners, `seed ${seed}: 거절된 쪽의 기록이 남았다`);
      assert.equal(joiners.filter((connId) => w.store.bindingOf(connId) !== null).length, winners);
      winnersPerRound.set(winners, (winnersPerRound.get(winners) ?? 0) + 1);
    }
    t.diagnostic(`통과 0: ${winnersPerRound.get(0) ?? 0}회, 통과 1: ${winnersPerRound.get(1) ?? 0}회`);
    assert.ok((winnersPerRound.get(1) ?? 0) > 0, '한 번도 통과하지 못했다. 뒤섞기가 한쪽으로 쏠렸다');
    assert.ok((winnersPerRound.get(0) ?? 0) > 0, '둘 다 거절되는 경우가 한 번도 없었다. 처리가 겹치지 않았다');
  });

  it(`자리가 셋 남은 방에 6개 연결이 동시에 들어와도 정원을 넘지 않는다 (${ROUNDS}회)`, async (t) => {
    let fewest = 6;
    let most = 0;
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed: seed + 10_000 });
      await fillRoom(w, MAX - 3);
      const joiners = Array.from({ length: 6 }, (_, i) => `j${i}`);
      await w.all(joiners.map((connId) => () => w.join(connId, { peer: `n-${connId}`, mode: 'join' })));
      const winners = joiners.filter((connId) => w.store.bindingOf(connId) !== null).length;
      const live = await w.live(ROOM);
      assert.ok(live.length <= MAX, `seed ${seed}: 정원 초과 ${live.length}`);
      assert.equal(live.length, MAX - 3 + winners, `seed ${seed}`);
      fewest = Math.min(fewest, winners);
      most = Math.max(most, winners);
    }
    t.diagnostic(`통과한 수의 범위: ${fewest}~${most}`);
    assert.ok(most <= 3);
  });

  it(`같은 방 ID 로 4개 연결이 동시에 create 해도 성공은 1 이하다 (${ROUNDS}회)`, async (t) => {
    const winnersPerRound = new Map<number, number>();
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed: seed + 20_000 });
      const creators = ['k0', 'k1', 'k2', 'k3'];
      const replies: ServerMessage[] = [];
      await w.all(creators.map((connId) => async () => void replies.push(await w.join(connId, { peer: `n-${connId}`, mode: 'create' }))));
      const winners = replies.filter((reply) => reply.type === 'joined').length;
      assert.ok(winners <= 1, `seed ${seed}: 성공 ${winners}`);
      assert.equal(replies.filter((reply) => reply.type === 'error' && reply.code === 'ROOM_EXISTS').length, creators.length - winners);
      assert.equal((await w.live(ROOM)).length, winners, `seed ${seed}: 실패한 쪽의 기록이 남았다`);
      winnersPerRound.set(winners, (winnersPerRound.get(winners) ?? 0) + 1);
    }
    t.diagnostic(`성공 0: ${winnersPerRound.get(0) ?? 0}회, 성공 1: ${winnersPerRound.get(1) ?? 0}회`);
    assert.ok((winnersPerRound.get(1) ?? 0) > 0);
  });

  it(`create 하나와 join 셋이 없는 방에 동시에 들어와도 create 성공은 1 이하이고 기록이 어긋나지 않는다 (${ROUNDS}회)`, async () => {
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed: seed + 30_000 });
      const conns = ['x0', 'x1', 'x2', 'x3'];
      await w.all(conns.map((connId, i) => () => w.join(connId, { peer: `n-${connId}`, mode: i === 0 ? 'create' : 'join' })));
      const bound = conns.filter((connId) => w.store.bindingOf(connId) !== null);
      const live = await w.live(ROOM);
      assert.deepEqual(live.map((record) => record.connId).sort(), bound.sort(), `seed ${seed}: 기록과 등록이 어긋났다`);
    }
  });

  it(`같은 이름으로 10개 연결이 동시에 join 해도 등록은 하나다 (${ROUNDS}회)`, async () => {
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed: seed + 40_000 });
      await w.join('host', { peer: 'host', mode: 'create' });
      const conns = Array.from({ length: 10 }, (_, i) => `s${i}`);
      const replies: ServerMessage[] = [];
      await w.all(conns.map((connId) => async () => void replies.push(await w.join(connId, { peer: 'same', mode: 'join' }))));
      assert.equal(replies.filter((reply) => reply.type === 'joined').length, 1, `seed ${seed}`);
      assert.equal(replies.filter((reply) => reply.type === 'error' && reply.code === 'NAME_IN_USE').length, 9, `seed ${seed}`);
      const record = await w.record(ROOM, 'same');
      const bound = conns.filter((connId) => w.store.bindingOf(connId) !== null);
      assert.deepEqual(bound, [record?.connId], `seed ${seed}: 기록이 가리키는 연결만 등록돼 있어야 한다`);
      assert.equal((await w.live(ROOM)).length, 2);
    }
  });

  it(`옛 연결(seq 1)과 새 연결(seq 2)의 join 이 어느 순서로 겹쳐도 기록은 새 연결을 가리킨다 (${ROUNDS}회)`, async (t) => {
    let oldJoinedFirst = 0;
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed: seed + 50_000 });
      await w.join('host', { peer: 'host', mode: 'create' });
      let newReply: ServerMessage | undefined;
      await w.all([
        // 옛 연결은 응답을 받기 전에 닫힐 수 있다(먼저 쓰고, 등록 전에 인계된 경우). 그래서 응답을 요구하지 않는다.
        () => w.send('old', { action: 'join', v: 1, id: 'old-join', room: ROOM, peer: 'alice', sid: sidOf('proc-a'), key: keyOf('proc-a'), mode: 'resume', seq: 1 }),
        async () => {
          newReply = await w.join('new', { peer: 'alice', mode: 'resume', process: 'proc-a', seq: 2 });
        },
      ]);
      const oldReply = w.replyTo('old', 'old-join');
      assert.equal(newReply?.type, 'joined', `seed ${seed}`);
      const record = await w.record(ROOM, 'alice');
      assert.equal(record?.connId, 'new', `seed ${seed}`);
      assert.equal(record?.seq, 2, `seed ${seed}`);
      assert.deepEqual(w.closed, ['old'], `seed ${seed}: 옛 연결만 닫힌다`);
      assert.equal(w.inbox('old').some((message) => message.type === 'error' && message.code === 'REPLACED'), true, `seed ${seed}`);
      if (oldReply?.type === 'joined') oldJoinedFirst += 1;
      // 늦게 온 옛 연결의 종료 통지.
      await w.disconnect('old');
      assert.equal((await w.record(ROOM, 'alice'))?.connId, 'new', `seed ${seed}: 옛 연결의 종료 통지가 새 기록을 지웠다`);
      assert.equal((await w.live(ROOM)).length, 2);
    }
    t.diagnostic(`옛 연결이 먼저 등록된 뒤 인계된 경우: ${oldJoinedFirst}회`);
  });

  it(`옛 연결의 종료 통지와 새 연결의 join 이 겹쳐도 새 기록이 남는다 (${ROUNDS}회)`, async () => {
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed: seed + 60_000 });
      await w.join('host', { peer: 'host', mode: 'create' });
      await w.join('old', { peer: 'alice', mode: 'join', process: 'proc-a', seq: 1 });
      w.drop('old');
      await w.all([() => w.core.onDisconnect('old'), () => w.join('new', { peer: 'alice', mode: 'resume', process: 'proc-a', seq: 2 })]);
      const record = await w.record(ROOM, 'alice');
      assert.equal(record?.connId, 'new', `seed ${seed}`);
      assert.notEqual(w.store.bindingOf('new'), null, `seed ${seed}`);
      assert.equal(w.store.bindingOf('old'), null, `seed ${seed}`);
    }
  });

  it(`같은 연결이 같은 join 을 겹쳐 보내도 등록은 하나이고 오류로 답하지 않는다 (${ROUNDS}회)`, async () => {
    for (let seed = 1; seed <= ROUNDS; seed += 1) {
      const w = createWorld({ seed: seed + 70_000 });
      await w.join('host', { peer: 'host', mode: 'create' });
      await w.all([1, 2, 3].map(() => () => w.join('c1', { peer: 'alice', mode: 'join', id: 'dup' })));
      const replies = w.inbox('c1');
      assert.equal(replies.length, 3, `seed ${seed}`);
      assert.equal(replies.every((reply) => reply.type === 'joined'), true, `seed ${seed}: ${JSON.stringify(replies)}`);
      assert.equal((await w.record(ROOM, 'alice'))?.connId, 'c1');
      assert.equal((await w.live(ROOM)).length, 2);
    }
  });

  it('여러 방·여러 연결의 무작위 동작을 뒤섞어도 정원을 넘지 않고 다른 방으로 시그널이 가지 않는다 (60회 × 6라운드)', async () => {
    const rooms = [ROOM, OTHER_ROOM];
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = mulberry32(seed + 80_000);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const w = createWorld({ seed: seed + 90_000 });
      // 연결은 한 방에만 들어간다. 이름 앞머리로 방을 가린다(a-…, b-…).
      const conns = Array.from({ length: 22 }, (_, i) => ({ connId: `f${i}`, room: i % 2, peer: `${i % 2 === 0 ? 'a' : 'b'}-${Math.floor(i / 2) % 9}` }));
      let generation = 0;

      for (let round = 0; round < 6; round += 1) {
        const tasks: (() => Promise<unknown>)[] = [];
        for (const conn of conns) {
          const dice = random();
          const room = rooms[conn.room] as string;
          if (dice < 0.45) {
            tasks.push(() => w.join(conn.connId, { room, peer: conn.peer, mode: pick(['create', 'join', 'resume'] as const), seq: 1 + Math.floor(random() * 3) }));
          } else if (dice < 0.6) {
            tasks.push(() => w.send(conn.connId, { action: 'ping', id: `p${round}` }));
          } else if (dice < 0.8) {
            const target = pick(conns).peer;
            tasks.push(() => w.send(conn.connId, { action: 'signal', id: `s${round}`, to: target === conn.peer ? 'nobody' : target, kind: 'offer-request', data: {} }));
          } else if (dice < 0.9) {
            tasks.push(() => w.send(conn.connId, { action: 'leave', id: `l${round}` }));
          } else {
            // 끊기고, 다음 라운드부터는 새 연결로 다시 온다.
            const gone = conn.connId;
            generation += 1;
            conn.connId = `f${gone.slice(1).split('g')[0]}g${generation}`;
            tasks.push(() => w.disconnect(gone));
          }
        }
        await w.all(tasks);
        // 조립이 하듯, core 가 닫으라고 한 연결의 종료 통지를 처리한다.
        const toClose = w.closed.splice(0);
        await w.all(toClose.map((connId) => () => w.core.onDisconnect(connId)));
        // 닫힌 연결의 ID 는 다시 쓰이지 않는다. 다음 라운드부터는 새 연결이다.
        for (const conn of conns) {
          if (!toClose.includes(conn.connId)) continue;
          generation += 1;
          conn.connId = `f${conn.connId.slice(1).split('g')[0]}g${generation}`;
        }

        for (const [index, room] of rooms.entries()) {
          const live = await w.live(room);
          assert.ok(live.length <= MAX, `seed ${seed} round ${round}: ${index}번 방 정원 초과 ${live.length}`);
          const prefix = index === 0 ? 'a-' : 'b-';
          assert.equal(live.every((record) => record.peer.startsWith(prefix)), true, `seed ${seed}: 다른 방의 이름이 섞였다`);
        }
        for (const conn of conns) {
          const prefix = conn.room === 0 ? 'a-' : 'b-';
          for (const message of w.take(conn.connId)) {
            if (message.type === 'signal') assert.equal(message.from.startsWith(prefix), true, `seed ${seed}: 다른 방의 시그널이 도착했다`);
            if (message.type === 'joined' || message.type === 'pong') {
              assert.equal(message.members.every((member) => member.peer.startsWith(prefix) && member.peer !== conn.peer), true, `seed ${seed}: 목록에 다른 방이나 자신이 있다`);
            }
          }
        }
      }
    }
  });
});

describe('V-U2 동시 처리: 같은 연결의 같은 join 두 처리 + 다른 연결의 입장 (검토 1차 SERVER-R1-01)', () => {
  /**
   * 처리(실행)마다 따로 core 를 만들고, 같은 메모리 저장소를 쓰되 그 처리의 다음 포트 호출을 시험이 고른 순서로 들여보낸다.
   * 공용 서버에서 같은 연결의 같은 join 이 두 Lambda 에서 겹치는 경우를 그대로 만든다.
   */
  function scripted() {
    const at = T0;
    const store = createMemoryRoomStore();
    const open = new Set<string>();
    const inboxes = new Map<string, ServerMessage[]>();
    const pending: { tag: string; op: string; go: () => void }[] = [];
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const sink: ConnectionSink = {
      async send(connId, text) {
        if (!open.has(connId)) return 'gone';
        const parsed = parseServerMessage(text);
        assert.ok(parsed.ok);
        inboxes.set(connId, [...(inboxes.get(connId) ?? []), parsed.value]);
        return 'ok';
      },
      async isOpen(connId) {
        return open.has(connId);
      },
      async close(connId) {
        open.delete(connId);
      },
    };
    /** failBind: 이 처리의 bind 는 저장소 오류로 던진다(검토 3차 SERVER-R3-01). */
    const coreFor = (tag: string, options: { failBind?: boolean } = {}) => {
      const gatedStore = { ...store } as RoomStore;
      for (const name of STORE_METHODS) {
        const original = store[name] as unknown as (...args: unknown[]) => Promise<unknown>;
        (gatedStore as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
          await new Promise<void>((go) => pending.push({ tag, op: name, go }));
          if (name === 'bind' && options.failBind === true) throw Object.assign(new Error('internal'), { name: 'InternalServerError' });
          return original.apply(store, args);
        };
      }
      return createSignalingCore({ store: gatedStore, sink, now: () => at, log: { event: () => {} } });
    };
    const joinText = (peer: string, mode: JoinMode, id: string): string => {
      const encoded = encodeClientMessage({ action: 'join', v: 1, id, room: ROOM, peer, sid: sidOf(peer), key: keyOf(peer), mode, seq: 1 });
      assert.ok(encoded.ok);
      return encoded.value;
    };
    /** 그 처리의 다음 포트 호출 하나를 들여보낸다. 어떤 호출인지 돌려준다. */
    const step = async (tag: string): Promise<string> => {
      for (let i = 0; i < 100; i += 1) {
        const index = pending.findIndex((entry) => entry.tag === tag);
        if (index >= 0) {
          const [entry] = pending.splice(index, 1);
          entry?.go();
          await tick();
          await tick();
          return entry?.op ?? '';
        }
        await tick();
      }
      return 'done';
    };
    /** 남은 호출을 모두 들여보낸다. */
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 400; i += 1) {
        const next = pending.shift();
        if (next !== undefined) next.go();
        await tick();
      }
    };
    const kinds = (connId: string): string[] =>
      (inboxes.get(connId) ?? []).map((message) => (message.type === 'error' ? `error:${message.code}` : message.type));
    return { store, open, coreFor, joinText, step, drain, kinds };
  }

  /** joined 를 받은 연결은 모두 기록과 등록이 있어야 한다. 기록 없이 등록만 남은 반쪽 참가자가 없어야 한다. */
  async function expectWhole(w: ReturnType<typeof scripted>, joinedConns: readonly [string, string][]): Promise<void> {
    for (const [connId, peer] of joinedConns) {
      const record = await w.store.getPeer(roomKeyOf(ROOM), peer);
      assert.equal(record?.connId, connId, `${connId}: joined 를 받았는데 기록이 없다`);
      assert.notEqual(w.store.bindingOf(connId), null, `${connId}: joined 를 받았는데 등록이 없다`);
    }
  }

  it('create 경쟁: 판정에 실패한 처리가 기록을 지우기 전에 다른 처리가 통과했다(검토자 실험 2의 순서). 생성 성공은 한 명이다', async () => {
    const w = scripted();
    w.open.add('Y');
    w.open.add('Zc');
    const L1 = w.coreFor('L1');
    const L2 = w.coreFor('L2');
    const Z = w.coreFor('Z');
    const tasks = [L1.onMessage('Y', w.joinText('yuna', 'create', 'jy')), L2.onMessage('Y', w.joinText('yuna', 'create', 'jy')), Z.onMessage('Zc', w.joinText('zed', 'create', 'jz'))];
    for (const tag of ['L1', 'L2', 'Z']) assert.equal(await w.step(tag), 'hitRate');
    assert.equal(await w.step('L1'), 'getPeer');
    assert.equal(await w.step('L1'), 'putPeer');
    assert.equal(await w.step('L2'), 'getPeer'); // 자기 기록을 본다(쓰지 않고 판정으로 간다)
    assert.equal(await w.step('L2'), 'listPeers'); // 아무도 없다 → 통과
    assert.equal(await w.step('Z'), 'getPeer');
    assert.equal(await w.step('Z'), 'putPeer');
    await w.step('L2'); // 고치기 전: bind. 고친 뒤: 판정에 쓴 기록을 차지(claimPeer)
    assert.equal(await w.step('L1'), 'listPeers'); // zed 가 보인다 → ROOM_EXISTS
    assert.equal(await w.step('L1'), 'deletePeer');
    assert.equal(await w.step('Z'), 'listPeers');
    await w.drain();
    await Promise.all(tasks);
    const created = [['Y', 'yuna'], ['Zc', 'zed']].filter(([connId]) => w.kinds(connId as string).includes('joined')) as [string, string][];
    assert.equal(created.length, 1, `생성 성공이 둘이다: Y ${w.kinds('Y').join(',')} / Zc ${w.kinds('Zc').join(',')}`);
    await expectWhole(w, created);
    // (검토 2차 SERVER-R2-01) L1 은 차지된 기록이라 지우지 못했다. 같은 요청에 joined 와 반대인 답(ROOM_EXISTS)을 함께 보내지 않는다.
    // 그 답이 먼저 닿으면 클라이언트는 등록된 채로 "거절됐다"고 처리한다.
    // (검토 3차 SERVER-R3-01) L1 은 차지된 판을 보고 L2 와 같이 등록해 joined 로 답한다(L2 가 등록 전에 실패해도 답이 간다).
    // 같은 요청에 joined 가 둘 가고, 클라이언트는 두 번째를 버린다.
    assert.deepEqual(w.kinds('Y'), ['joined', 'joined'], `Y 가 받은 답: ${w.kinds('Y').join(',')}`);
  });

  it('create 경쟁: 판정에 실패한 처리가 먼저 지웠으면, 그 기록으로 통과한 처리는 joined 대신 SERVER_ERROR 로 답한다(클라이언트가 다시 보낸다)', async () => {
    const w = scripted();
    w.open.add('Y');
    w.open.add('Zc');
    const L1 = w.coreFor('L1');
    const L2 = w.coreFor('L2');
    const Z = w.coreFor('Z');
    const tasks = [L1.onMessage('Y', w.joinText('yuna', 'create', 'jy')), L2.onMessage('Y', w.joinText('yuna', 'create', 'jy')), Z.onMessage('Zc', w.joinText('zed', 'create', 'jz'))];
    for (const tag of ['L1', 'L2', 'Z']) await w.step(tag);
    await w.step('L1');
    await w.step('L1'); // putPeer
    await w.step('L2'); // getPeer: 자기 기록
    await w.step('L2'); // listPeers: 통과
    await w.step('Z');
    await w.step('Z'); // putPeer
    await w.step('L1'); // listPeers: zed → 실패
    await w.step('L1'); // deletePeer: 지움
    await w.step('Z'); // listPeers: yuna 없음 → 통과
    await w.drain();
    await Promise.all(tasks);
    assert.equal(w.kinds('Zc').includes('joined'), true);
    assert.equal(w.kinds('Y').includes('joined'), false, `기록이 지워진 처리가 joined 를 보냈다: ${w.kinds('Y').join(',')}`);
    assert.equal(w.kinds('Y').includes('error:SERVER_ERROR'), true);
    assert.equal(w.store.bindingOf('Y'), null, '등록을 남기지 않는다');
    assert.equal(await w.store.getPeer(roomKeyOf(ROOM), 'yuna'), null, '기록을 남기지 않는다');
    await expectWhole(w, [['Zc', 'zed']]);
  });

  /**
   * 같은 요청에 실패(SERVER_ERROR 밖)와 joined 를 함께 보냈는가, 첫 답이 실패인데 기록·등록이 남았는가.
   * 같은 판(판정에 쓴 기록)을 판정한 처리끼리는 반대 답을 내지 않는다(검토 2차 SERVER-R2-01).
   * 남은 틈: 한 처리가 판정에 실패해 그 판을 지운 뒤, 같은 join 의 나중 처리가 빈 자리에 기록을 **새로 써서** 다시 판정하면 통과할 수 있다
   * (그 사이 다른 입장자도 실패해 나갔다). 그 경우는 그 연결의 기록 쓰기가 두 번 이상이다. 이것은 세지 않는다(protocol.md 2.3 6번 "남는 틈").
   */
  async function contradictions(w: World, conns: readonly [string, string][]): Promise<string[]> {
    const found: string[] = [];
    for (const [connId, peer] of conns) {
      if (w.writes.filter((entry) => entry === `${connId}:${peer}`).length >= 2) continue;
      const replies = w.inbox(connId).filter((message) => message.type !== 'signal');
      const failed = replies.filter((message) => message.type === 'error' && message.code !== 'SERVER_ERROR');
      if (failed.length > 0 && replies.some((message) => message.type === 'joined')) found.push(`${connId}: joined 와 실패를 함께 받았다`);
      const first = replies[0];
      if (first !== undefined && first.type === 'error' && first.code !== 'SERVER_ERROR') {
        if ((await w.record(ROOM, peer))?.connId === connId) found.push(`${connId}: 첫 답이 ${first.code} 인데 기록이 남았다`);
        if (w.store.bindingOf(connId) !== null) found.push(`${connId}: 첫 답이 ${first.code} 인데 등록이 남았다`);
      }
    }
    return found;
  }

  it(`정원 경쟁(정원 ${MAX}, ${MAX - 1}명이 있다): 같은 연결의 같은 join 두 처리 + 다른 연결의 join 을 무작위로 섞어도 joined 를 받은 연결은 모두 기록이 있고 정원을 넘지 않는다 (300회)`, async () => {
    let bothRejected = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const w = createWorld({ seed: seed + 110_000 });
      await w.join('host', { peer: 'host', mode: 'create' });
      for (let i = 1; i < MAX - 1; i += 1) await w.join(`m${i}`, { peer: `p${i}`, mode: 'join' });
      await w.all([
        () => w.sendJoin('Y', { peer: 'yuna', mode: 'join', id: 'jy' }),
        () => w.sendJoin('Y', { peer: 'yuna', mode: 'join', id: 'jy' }),
        () => w.sendJoin('W', { peer: 'wade', mode: 'join', id: 'jw' }),
      ]);
      const joined = [['Y', 'yuna'], ['W', 'wade']].filter(([connId]) => w.inbox(connId as string).some((message) => message.type === 'joined'));
      if (joined.length === 0) bothRejected += 1;
      assert.ok(joined.length <= 1, `seed ${seed}: 정원을 넘겨 둘 다 joined`);
      for (const [connId, peer] of joined) {
        assert.equal((await w.record(ROOM, peer as string))?.connId, connId, `seed ${seed}: ${connId} 는 joined 를 받았는데 기록이 없다`);
        assert.notEqual(w.store.bindingOf(connId as string), null, `seed ${seed}`);
      }
      assert.ok((await w.live(ROOM)).length <= MAX, `seed ${seed}`);
      // (검토 2차 SERVER-R2-01) 같은 요청에 반대인 답 두 개를 보내지 않고, 첫 답이 실패면 그 연결은 등록되지 않았다.
      assert.deepEqual(await contradictions(w, [['Y', 'yuna'], ['W', 'wade']]), [], `seed ${seed}: Y ${JSON.stringify(w.inbox('Y'))}`);
    }
    assert.ok(bothRejected < 300);
  });

  it('create 경쟁을 무작위로 섞어도(300회) 생성 성공은 많아야 한 명이고, joined 를 받은 연결은 모두 기록이 있다', async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const w = createWorld({ seed: seed + 120_000 });
      await w.all([
        () => w.sendJoin('Y', { peer: 'yuna', mode: 'create', id: 'jy' }),
        () => w.sendJoin('Y', { peer: 'yuna', mode: 'create', id: 'jy' }),
        () => w.sendJoin('Zc', { peer: 'zed', mode: 'create', id: 'jz' }),
      ]);
      const joined = [['Y', 'yuna'], ['Zc', 'zed']].filter(([connId]) => w.inbox(connId as string).some((message) => message.type === 'joined'));
      assert.ok(joined.length <= 1, `seed ${seed}: 생성 성공이 둘이다`);
      for (const [connId, peer] of joined) {
        assert.equal((await w.record(ROOM, peer as string))?.connId, connId, `seed ${seed}: ${connId} 는 joined 를 받았는데 기록이 없다`);
      }
      assert.deepEqual(await contradictions(w, [['Y', 'yuna'], ['Zc', 'zed']]), [], `seed ${seed}: Y ${JSON.stringify(w.inbox('Y'))}`);
    }
  });

  it('(검토 2차 SERVER-R2-01) 앞선 처리가 쓰고 등록 전에 끊긴 자기 기록으로 판정에 실패하면 그 기록을 지운다(실패를 받은 연결이 정원에 남지 않는다)', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    const orphan: PeerRecord = {
      roomKey: roomKeyOf(ROOM),
      peer: 'alice',
      connId: 'c1',
      sid: sidOf('c1'),
      keyHash: sha256(keyOf('c1')),
      seq: 1,
      lastSeenAt: w.now(),
    };
    assert.equal(await w.store.putPeer(orphan, { absent: true }), true);
    w.advance(3_000);
    // 같은 join 을 다시 보냈는데 그 사이 방이 생겼다(create 는 ROOM_EXISTS).
    expectError(await w.join('c1', { peer: 'alice', mode: 'create' }), 'ROOM_EXISTS');
    assert.equal(await w.record(ROOM, 'alice'), null, '실패를 받은 연결의 기록이 남았다');
    assert.deepEqual((await w.live(ROOM)).map((record) => record.peer), ['host']);
  });

  it('(검토 2차 SERVER-R2-02) 종료 통지가 join 의 건수 세기와 등록 사이에 끝나면 기록·등록·연결 항목이 남지 않는다', async () => {
    const w = scripted();
    w.open.add('host');
    w.open.add('Y');
    const host = w.coreFor('H');
    const hostJoin = host.onMessage('host', w.joinText('host', 'create', 'h'));
    await w.drain();
    await hostJoin;
    const Y = w.coreFor('Y');
    const D = w.coreFor('D');
    const task = Y.onMessage('Y', w.joinText('yuna', 'join', 'jy'));
    assert.equal(await w.step('Y'), 'hitRate');
    // 소켓이 닫히고, 다른 실행의 종료 통지가 이 join 의 등록보다 먼저 끝난다(공용 서버의 $disconnect).
    w.open.delete('Y');
    const disconnect = D.onDisconnect('Y');
    assert.equal(await w.step('D'), 'unbind');
    await disconnect;
    await w.drain();
    await task;
    assert.equal(await w.store.getPeer(roomKeyOf(ROOM), 'yuna'), null, '닫힌 연결을 가리키는 참가자 기록이 남았다');
    assert.equal(w.store.bindingOf('Y'), null, '닫힌 연결의 등록이 남았다');
    assert.equal(w.store.connCount(), 1, '연결 항목은 host 것 하나뿐이다');
  });

  it('(검토 3차 SERVER-R3-01) 같은 join 의 다른 처리가 판정을 통과해 차지했는데 등록하지 못했으면, 판정에 실패한 이 처리가 등록하고 joined 로 답한다', async () => {
    const w = scripted();
    w.open.add('host');
    w.open.add('Y');
    const host = w.coreFor('H');
    const hostJoin = host.onMessage('host', w.joinText('host', 'create', 'h'));
    await w.drain();
    await hostJoin;
    const L1 = w.coreFor('L1', { failBind: true });
    const L2 = w.coreFor('L2');
    const tasks = [L1.onMessage('Y', w.joinText('yuna', 'join', 'jy')), L2.onMessage('Y', w.joinText('yuna', 'join', 'jy'))];
    assert.equal(await w.step('L1'), 'hitRate');
    assert.equal(await w.step('L2'), 'hitRate');
    assert.equal(await w.step('L1'), 'getPeer');
    assert.equal(await w.step('L1'), 'putPeer');
    assert.equal(await w.step('L2'), 'getPeer'); // 자기 기록(아직 차지되지 않음) → 판정으로 간다
    assert.equal(await w.step('L1'), 'listPeers'); // host 가 있다 → 통과
    assert.equal(await w.step('L1'), 'claimPeer');
    assert.equal(await w.step('L1'), 'bind'); // 저장소 오류 → SERVER_ERROR
    // host 가 나간다. 그 뒤에 L2 가 판정한다.
    const leave = w.coreFor('HL').onMessage('host', JSON.stringify({ action: 'leave', id: 'hl' }));
    assert.equal(await w.step('HL'), 'hitRate');
    assert.equal(await w.step('HL'), 'unbind');
    assert.equal(await w.step('HL'), 'deletePeer');
    await leave;
    assert.equal(await w.step('L2'), 'listPeers'); // 아무도 없다 → ROOM_NOT_FOUND
    assert.equal(await w.step('L2'), 'deletePeer'); // 차지된 판이라 지우지 못한다
    assert.equal(await w.step('L2'), 'getPeer'); // 아직 이 연결·이 join 이고 차지돼 있다
    await w.drain();
    await Promise.all(tasks);
    // L2 는 빈 방을 보고 ROOM_NOT_FOUND 로 판정했지만 차지된 판이라 지우지 못했다. 이 join 은 이미 판정을 통과했다.
    assert.deepEqual(w.kinds('Y'), ['error:SERVER_ERROR', 'joined'], `Y 가 받은 답: ${w.kinds('Y').join(',')}`);
    assert.notEqual(w.store.bindingOf('Y'), null, '등록이 있다');
    assert.equal((await w.store.getPeer(roomKeyOf(ROOM), 'yuna'))?.connId, 'Y');
  });
});

describe('V-U2 판정을 통과해 차지한 뒤 등록 전에 실패한 join 의 재전송 (검토 3차 SERVER-R3-01)', () => {
  const kind = (message: ServerMessage): string => (message.type === 'error' ? `error:${message.code}` : message.type);

  it('join: bind 가 한 번 실패한 뒤 상대가 나가도 같은 join 의 재전송은 joined 를 받는다. 연결이 끝나면 기록·등록이 남지 않고 그 방 ID 로 다시 만들 수 있다', async () => {
    // 검토자 실험 exp-claim-orphan.mjs 의 순서.
    const w = createWorld({ bindFailsOnce: ['G'] });
    expectJoined(await w.join('H', { peer: 'host', mode: 'create' }));
    expectError(await w.join('G', { peer: 'guest', mode: 'join', id: 'cd-1' }), 'SERVER_ERROR');
    assert.equal(w.store.bindingOf('G'), null);
    await w.leave('H');
    for (let i = 0; i < 3; i += 1) {
      w.advance(1_500);
      assert.deepEqual(peersOf(expectJoined(await w.join('G', { peer: 'guest', mode: 'join', id: 'cd-1' }))), []);
    }
    assert.deepEqual(w.inbox('G').map(kind), ['error:SERVER_ERROR', 'joined', 'joined', 'joined']);
    assert.notEqual(w.store.bindingOf('G'), null);
    await w.disconnect('G');
    assert.equal(await w.record(ROOM, 'guest'), null, '종료 통지가 기록을 지운다');
    assert.equal(w.store.bindingOf('G'), null);
    w.advance(30_000);
    expectJoined(await w.join('X', { peer: 'xavier', mode: 'create' }));
  });

  it('create: bind 가 한 번 실패한 뒤 상대가 들어와도, 만든 쪽의 재전송은 ROOM_EXISTS 가 아니라 상대를 담은 joined 다', async () => {
    // 검토자 실험 exp-claim-orphan-create.mjs 의 순서.
    const w = createWorld({ bindFailsOnce: ['H'] });
    expectError(await w.join('H', { peer: 'host', mode: 'create', id: 'ab-1' }), 'SERVER_ERROR');
    w.advance(500);
    assert.deepEqual(peersOf(expectJoined(await w.join('G', { peer: 'guest', mode: 'join' }))), ['host']);
    for (let i = 0; i < 2; i += 1) {
      w.advance(1_500);
      assert.deepEqual(peersOf(expectJoined(await w.join('H', { peer: 'host', mode: 'create', id: 'ab-1' }))), ['guest']);
    }
    assert.deepEqual(w.inbox('H').map(kind), ['error:SERVER_ERROR', 'joined', 'joined']);
    assert.notEqual(w.store.bindingOf('H'), null);
    const outcomes = w.logs.filter((entry) => entry.event === 'conn.join' && entry.fields.mode === 'create').map((entry) => `${entry.fields.outcome}${entry.fields.cause === undefined ? '' : `/${entry.fields.cause}`}`);
    assert.deepEqual(outcomes, ['joined/claimed', 'resent'], `create 처리의 로그: ${outcomes.join(',')}`);
  });

  it('차지되지 않은 자기 기록(앞선 처리가 판정 전에 끊김)은 지금처럼 다시 판정한다', async () => {
    const w = createWorld();
    await w.join('host', { peer: 'host', mode: 'create' });
    const orphan: PeerRecord = { roomKey: roomKeyOf(ROOM), peer: 'alice', connId: 'c1', sid: sidOf('c1'), keyHash: sha256(keyOf('c1')), seq: 1, lastSeenAt: w.now() };
    assert.equal(await w.store.putPeer(orphan, { absent: true }), true);
    expectError(await w.join('c1', { peer: 'alice', mode: 'create' }), 'ROOM_EXISTS');
    assert.equal(await w.record(ROOM, 'alice'), null);
  });
});

describe('V-U2 진단 로그', () => {
  it('규칙을 한 바퀴 돌린 뒤의 로그에 방 ID, 이름, key, sid 밖의 원문이 없다', async () => {
    const w = createWorld();
    await w.join('conn-one', { peer: 'alice', mode: 'create' });
    await w.join('conn-two', { peer: 'bob', mode: 'join' });
    await w.join('conn-three', { peer: 'bob', mode: 'join' });
    await w.signal('conn-one', 'bob', { kind: 'offer', cid: `${sidOf('conn-one')}.1`, data: { sdp: 'v=0 very-secret-sdp' } });
    await w.signal('conn-one', 'ghost');
    await w.raw('conn-two', 'garbage-body-text');
    await w.ping('conn-two');
    await w.leave('conn-two');
    await w.disconnect('conn-one');

    const text = JSON.stringify(w.logs);
    for (const secret of [ROOM, 'alice', 'bob', 'ghost', keyOf('conn-one'), keyOf('conn-two'), 'very-secret-sdp', 'garbage-body-text', 'conn-one', 'conn-two', 'conn-three']) {
      assert.equal(text.includes(secret), false, `로그에 원문이 남았다: ${secret}`);
    }
    const events = new Set(w.logs.map((entry) => entry.event));
    for (const expected of ['conn.join', 'relay', 'conn.rejected', 'conn.closed']) assert.equal(events.has(expected), true, expected);
    assert.equal(w.logs.every((entry) => !Object.hasOwn(entry.fields, 'peer')), true, '서버 로그에 peer 칸이 없다');
  });
});
