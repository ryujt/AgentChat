// V-U9: 스냅샷 교환과 재동기화 (verification-plan.md 3.1 의 고정 기준 1~7, 9, 10. protocol.md 5.4).
// 가짜 시계, 가짜 mesh, 가짜 복제본으로 본다. 경과 시간을 보는 8번과 11번은 elapsed.test.ts 에 있다(shared-state 실물).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../protocol/index.js';
import type { P2PFrame, StateRecord, SyncEndFrame } from '../protocol/index.js';
import type { ScriptedPeer, SessionUnderTest, TestBed } from './testing.js';
import {
  MIN,
  ROOM,
  SEC,
  createTestBed,
  enterRoom,
  presenceRecord,
  scenarioRecordOf,
  sidOf,
  stopRecordOf,
  testRecordOf,
} from './testing.js';

const PING = LIMITS.P2P_PING_INTERVAL_MS;
const GAP = LIMITS.RESYNC_MIN_GAP_MS;
/** 어느 복제본의 지문과도 같지 않은 값. */
const OTHER = 'ffffffffffff';

const syncEnds = (frames: readonly P2PFrame[]): SyncEndFrame[] =>
  frames.filter((frame): frame is SyncEndFrame => frame.t === 'sync_end');

/** 프레임 묶음에서 스냅샷으로 간 기록. */
const snapshotRecords = (frames: readonly P2PFrame[]): StateRecord[] =>
  frames.flatMap((frame) => (frame.t === 'state' && frame.snap === true ? frame.records : []));

/** 내 복제본과 같은 값을 실은 ping. */
function samePing(sut: SessionUnderTest, remote: ScriptedPeer): void {
  remote.ping(sut.replica().snapshot().length, sut.replica().fingerprint());
}

function differentPing(sut: SessionUnderTest, remote: ScriptedPeer): void {
  remote.ping(sut.replica().snapshot().length + 1, OTHER);
}

/** 지문이 다른 ping 을 5초마다 times 번 받는다. 시간이 times × 5초 간다. */
async function mismatchFor(bed: TestBed, sut: SessionUnderTest, remote: ScriptedPeer, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await bed.clock.advance(PING);
    differentPing(sut, remote);
  }
}

const warningCodes = (sut: SessionUnderTest): string[] => {
  const status = sut.session.status();
  assert.ok(status.ok);
  return status.warnings.map((warning) => warning.code);
};

const diverged = (sut: SessionUnderTest) =>
  sut.inbox.pushed.filter((event) => event.kind === 'system' && event.data.code === 'state_diverged');

describe('첫 동기화', () => {
  it('링크가 열리면 hello, 가진 모든 기록의 스냅샷, sf 없는 sync_end 를 먼저 보낸다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    await me.session.command({ type: 'set_status', status: 'ready' });
    room.client.emitMembers([{ peer: 'X', sid: sidOf('X') }]);
    const x = bed.remote('alpha', 'X').open();
    const frames = x.take();
    assert.deepEqual(frames.map((frame) => frame.t), ['hello', 'state', 'sync_end']);
    const hello = frames[0];
    assert.ok(hello?.t === 'hello');
    assert.deepEqual(
      { peer: hello.peer, sid: hello.sid, wall: hello.wall, client: hello.client },
      { peer: 'alpha', sid: bed.net.joins[0]?.sid, wall: bed.clock.now(), client: { name: 'agent-chat', version: '0.1.0' } },
    );
    assert.deepEqual(snapshotRecords(frames).map((record) => [record.kind, record.author]), [['presence', 'alpha']]);
    assert.deepEqual(frames[2], { v: 1, t: 'sync_end', count: 1 }, '테스트가 없으면 test_id 와 경과 시간을 싣지 않는다. 시작한 교환에는 sf 가 없다');

    // 상대의 sync_end 를 받기 전에는 동기화된 링크가 아니다.
    const linkOf = (): string | undefined => {
      const status = me.session.status();
      return status.ok ? status.participants.find((peer) => peer.name === 'X')?.link : undefined;
    };
    x.hello();
    assert.equal(linkOf(), 'connecting');
    x.state([presenceRecord('X', bed.clock.now() - SEC)], true).syncEnd({ count: 1 });
    assert.equal(linkOf(), 'open');
    assert.deepEqual(x.take(), [], '동시에 시작한 교환이다. 답하지 않는다');
    assert.deepEqual(me.log.named('state.resync').at(-1)?.fields, { peer: 'X', cause: 'link_open', gap_ms: GAP, records: 1, bytes: me.log.named('state.resync').at(-1)?.fields.bytes });
    assert.ok(room.mesh.alive.filter((peer) => peer === 'X').length >= 2, 'state 와 sync_end 는 링크의 생존 증거다');
  });

  it('hello 를 받기 전에 온 프레임은 받지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha');
    room.client.emitMembers([{ peer: 'X', sid: sidOf('X') }]);
    const x = bed.remote('alpha', 'X').open();
    x.state([presenceRecord('X', bed.clock.now() - SEC)], true).chat(`${sidOf('X')}-1`, '신원 확인 전의 글');
    assert.equal(me.fake().control.merges.length, 0);
    assert.deepEqual(me.inbox.events, []);
  });

  it('두 세션을 마주 이으면 스냅샷이 양쪽에서 한 번씩만 가고 둘 다 동기화된다', async () => {
    const bed = createTestBed();
    bed.net.autoConnect = true;
    const a = bed.session({ name: 'A' });
    const c = bed.session({ name: 'C' });
    assert.equal((await c.session.create({ room_id: ROOM, name: 'C' })).ok, true);
    await c.session.command({ type: 'start_test', request: 'x', max_duration_min: 60, max_scenarios: 20 });
    const joined = await bed.run(a.session.join({ room_id: ROOM, name: 'A' }));
    assert.ok(joined.ok);
    await bed.settle();
    const meshA = bed.net.meshOf('A');
    const meshC = bed.net.meshOf('C');
    assert.ok(meshA && meshC);
    for (const [mesh, peer] of [
      [meshA, 'C'],
      [meshC, 'A'],
    ] as const) {
      const ends = syncEnds(mesh.framesTo(peer));
      assert.equal(ends.length, 1, `${mesh.name} 의 스냅샷은 한 번만 갔다`);
      assert.equal(ends[0]?.sf, undefined, '답이 아니다');
    }
    assert.equal(joined.test?.by, 'C');
    assert.equal(a.replica().fingerprint(), c.replica().fingerprint());
    const status = c.session.status();
    assert.deepEqual(status.ok && status.participants.map((peer) => [peer.name, peer.link, peer.status]), [['A', 'open', 'joined']]);
    assert.deepEqual(c.inbox.pushed.map((event) => [event.kind, event.change, event.from]), [['peer', 'joined', 'A']]);
    bed.net.assertNoListenerErrors();
  });
});

describe('V-U9 1: 지문 비교', () => {
  it('상대의 ping 지문이 2회 연속 다르면 교환을 시작한다. 1회만 다르면 시작하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await bed.clock.advance(GAP);

    differentPing(me, a);
    assert.deepEqual(a.take(), [], '한 번 다른 것으로는 시작하지 않는다');
    samePing(me, a);
    differentPing(me, a);
    assert.deepEqual(a.take(), [], '사이에 같은 값이 왔다. 연속 2회가 아니다');
    // 기록 수만 달라도 다른 것이다.
    a.ping(me.replica().snapshot().length + 3, me.replica().fingerprint());
    const frames = a.take();
    assert.deepEqual(frames.map((frame) => frame.t), ['state', 'sync_end']);
    assert.deepEqual(snapshotRecords(frames).length, me.replica().snapshot().length, '가진 모든 기록을 보낸다');
    assert.equal(syncEnds(frames)[0]?.sf, undefined, '시작한 교환의 sync_end 에는 sf 가 없다');
    assert.equal(me.log.named('state.resync').at(-1)?.fields.cause, 'ping_mismatch');
    assert.deepEqual(room.mesh.closed, []);
  });
});

describe('V-U9 2: 답하기', () => {
  it('상대가 시작한 교환을 받으면 병합한 뒤 sf 를 실어 한 번 답한다. 답(sf 있음)에는 답하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await bed.clock.advance(GAP + SEC);

    const fresh = presenceRecord('ghost', bed.clock.now() - MIN, { status: 'left' });
    a.state([fresh], true);
    assert.deepEqual(a.take(), [], 'sync_end 를 받기 전에는 답하지 않는다');
    a.syncEnd({ count: 1 });
    const reply = a.take();
    assert.deepEqual(reply.map((frame) => frame.t), ['state', 'sync_end']);
    assert.ok(snapshotRecords(reply).some((record) => record.author === 'ghost'), '병합한 뒤의 스냅샷이다');
    assert.deepEqual(syncEnds(reply)[0], {
      v: 1,
      t: 'sync_end',
      count: me.replica().snapshot().length,
      sf: me.replica().fingerprint(),
    });
    assert.equal(me.log.named('state.resync').at(-1)?.fields.cause, 'reply');

    // 답을 받으면 어느 경우에도 답하지 않는다.
    a.syncEnd({ count: 3, sf: me.replica().fingerprint() });
    a.syncEnd({ count: 3, sf: OTHER });
    assert.deepEqual(a.take(), []);

    // 상대가 또 시작하면 그때마다 한 번 답한다. 간격을 따지지 않는다.
    a.syncEnd({ count: 0 });
    assert.equal(syncEnds(a.take()).length, 1);
  });

  it('내가 시작한 교환의 답을 받아도 답하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await bed.clock.advance(GAP);
    differentPing(me, a);
    differentPing(me, a);
    assert.equal(syncEnds(a.take()).length, 1);
    a.syncEnd({ count: 2, sf: me.replica().fingerprint() });
    assert.deepEqual(a.take(), []);
  });
});

describe('V-U9 3: 동시에 시작', () => {
  it('양쪽이 동시에 시작하면 스냅샷이 양쪽에서 한 번씩만 간다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await bed.clock.advance(GAP);
    differentPing(me, a);
    differentPing(me, a);
    assert.equal(syncEnds(a.take()).length, 1, '내가 시작했다');
    // 상대도 같은 때 시작했다. 그 스냅샷과 sf 없는 sync_end 가 내 것과 엇갈려 도착한다.
    a.state([presenceRecord('ghost', bed.clock.now() - MIN)], true).syncEnd({ count: 1 });
    assert.deepEqual(a.take(), [], '기다리는 중에 받은 sync_end 에는 답하지 않는다');
    assert.equal(me.fake().control.merges.at(-1)?.snapshot, true, '받은 스냅샷은 병합했다');
    assert.deepEqual(diverged(me), [], 'sf 없는 sync_end 로는 판정하지 않는다');
    // 기다림은 상대의 sync_end 하나로 끝났다. 다음에 상대가 시작하면 답한다.
    a.syncEnd({ count: 1 });
    assert.equal(syncEnds(a.take()).length, 1);
  });
});

describe('V-U9 4: 재동기화 간격', () => {
  it('교환 뒤 30초 안에 또 다르면 시작하지 않는다. 30초가 지난 뒤의 첫 ping 에 시작한다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await bed.clock.advance(GAP);
    differentPing(me, a);
    differentPing(me, a);
    const startedAt = bed.clock.now();
    assert.equal(syncEnds(a.take()).length, 1);
    a.syncEnd({ count: 0, sf: me.replica().fingerprint() });

    // 5초마다 다른 ping 이 온다. 25초째까지는 시작하지 않는다.
    await mismatchFor(bed, me, a, 5);
    assert.equal(bed.clock.now() - startedAt, 25 * SEC);
    assert.deepEqual(a.take(), []);
    await mismatchFor(bed, me, a, 1);
    assert.equal(syncEnds(a.take()).length, 1, '30초가 지난 뒤의 첫 ping 에 시작한다');
  });

  it('간격은 답으로 보낸 스냅샷부터도 잰다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await bed.clock.advance(GAP);
    a.syncEnd({ count: 0 });
    assert.equal(syncEnds(a.take()).length, 1, '답했다');
    await mismatchFor(bed, me, a, 5);
    assert.deepEqual(a.take(), [], '답한 지 30초가 안 됐다');
    await mismatchFor(bed, me, a, 1);
    assert.equal(syncEnds(a.take()).length, 1);
  });

  it('입장 때의 첫 동기화도 스냅샷을 보낸 것이다. 그때부터 30초 안에는 다시 시작하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await mismatchFor(bed, me, a, 5);
    assert.deepEqual(syncEnds(a.take()), []);
    await mismatchFor(bed, me, a, 1);
    assert.equal(syncEnds(a.take()).length, 1);
  });
});

describe('V-U9 5: 진전 없음', () => {
  it('간격이 30 → 60 → 120 → 240 → 300초로 늘고, 300초에서도 교환은 계속된다. state_diverged 는 링크마다 한 번이다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    const a = room.remote('A');
    // A 는 내가 검증에서 버리는 기록을 갖고 있다. 주고받아도 지문이 같아지지 않는다.
    const refused = scenarioRecordOf('A', bed.clock.now(), `${sidOf('A')}-66`, `${sidOf('A')}-1`);
    me.fake().control.refuse = (record) => record.kind === 'scenario' && record.rid === refused.rid;

    const starts: number[] = [];
    // 30분 동안 5초마다 다른 ping 이 온다. 내가 교환을 시작할 때마다 A 는 자기 스냅샷과 sf 로 답한다.
    for (let tick = 0; tick < 360; tick += 1) {
      await bed.clock.advance(PING);
      differentPing(me, a);
      samePing(me, room.remote('B'));
      const frames = a.take();
      if (syncEnds(frames).length === 0) continue;
      assert.equal(syncEnds(frames).length, 1);
      starts.push(bed.clock.now());
      a.state([refused], true).syncEnd({ count: 1, sf: OTHER });
      assert.deepEqual(a.take(), [], '답에는 답하지 않는다');
    }
    const gaps = starts.slice(1).map((at, index) => (at - (starts[index] as number)) / SEC);
    assert.deepEqual(gaps.slice(0, 7), [60, 120, 240, 300, 300, 300, 300]);
    assert.equal(starts[0], bed.clock.now() - 360 * PING + GAP, '첫 교환은 입장 30초 뒤다(기본 간격)');
    assert.ok(gaps.length >= 7 && gaps.slice(4).every((gap) => gap === 300), '상한에서도 교환이 멈추지 않는다');
    assert.equal(diverged(me).length, 1, 'state_diverged 사건은 한 번만');
    assert.deepEqual(diverged(me)[0]?.data, { peer: 'A', code: 'state_diverged' });
    assert.deepEqual(warningCodes(me), ['state_diverged']);
    const status = me.session.status();
    assert.deepEqual(status.ok && status.warnings, [{ code: 'state_diverged', peer: 'A' }], 'B 의 링크에는 경고가 없다');
    assert.deepEqual(
      me.log.named('state.diverged').map((entry) => entry.fields.gap_ms).slice(0, 5),
      [60_000, 120_000, 240_000, 300_000, 300_000],
    );
    assert.equal(room.mesh.isOpen('A'), true, '링크를 닫지 않는다');
  });
});

describe('V-U9 6: 판정하지 않는 경우', () => {
  /** 교환을 시작해 답을 기다리는 상태로 만든다. */
  async function startWaiting(bed: TestBed, me: SessionUnderTest, a: ScriptedPeer): Promise<void> {
    await bed.clock.advance(GAP);
    differentPing(me, a);
    differentPing(me, a);
    assert.equal(syncEnds(a.take()).length, 1);
  }

  it('기다리는 동안 로컬 쓰기가 있었으면 지문이 달라도 판정하지 않는다. 간격 그대로, 경고 없음', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await startWaiting(bed, me, a);
    await me.session.command({ type: 'set_status', status: 'working' });
    a.take();
    a.syncEnd({ count: 1, sf: OTHER });
    assert.deepEqual(diverged(me), []);
    assert.deepEqual(warningCodes(me), []);
    await mismatchFor(bed, me, a, 5);
    assert.deepEqual(syncEnds(a.take()), []);
    await mismatchFor(bed, me, a, 1);
    assert.equal(syncEnds(a.take()).length, 1, '간격은 30초 그대로다');
  });

  it('기다리는 동안 다른 링크의 병합으로 기록이 들어왔으면 판정하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    const a = room.remote('A');
    await startWaiting(bed, me, a);
    room.remote('B').state([presenceRecord('B', bed.clock.now(), { status: 'working' })]);
    a.syncEnd({ count: 1, sf: OTHER });
    assert.deepEqual(diverged(me), []);
    await mismatchFor(bed, me, a, 6);
    assert.equal(syncEnds(a.take()).length, 1, '간격은 30초 그대로다');
  });

  it('같은 링크에서 온 변경은 "다른 곳에서 들어온 기록"이 아니다. 판정한다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await startWaiting(bed, me, a);
    a.state([presenceRecord('A', bed.clock.now(), { status: 'working' })]);
    a.syncEnd({ count: 1, sf: OTHER });
    assert.equal(diverged(me).length, 1);
  });

  it('다른 링크의 병합이 아무 것도 바꾸지 않았으면(이미 있는 기록) 다른 곳에서 들어온 것이 아니다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    const a = room.remote('A');
    const known = presenceRecord('B', bed.clock.now(), { status: 'working' });
    room.remote('B').state([known]);
    await startWaiting(bed, me, a);
    room.remote('B').state([known]);
    a.syncEnd({ count: 1, sf: OTHER });
    assert.equal(diverged(me).length, 1);
  });

  it('기다리는 중이 아닐 때 받은 답은 지문이 달라도 판정하지 않는다. 기다림은 30초가 지나면 끝난다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    a.syncEnd({ count: 1, sf: OTHER });
    assert.deepEqual(diverged(me), [], '시작한 적이 없다');

    await startWaiting(bed, me, a);
    await bed.clock.advance(GAP - 1);
    a.syncEnd({ count: 1, sf: OTHER });
    assert.equal(diverged(me).length, 1, '30초 안에 온 답은 판정한다');

    const other = createTestBed();
    const late = other.session({ name: 'alpha' });
    const lateRoom = await enterRoom(other, late, 'alpha', ['A']);
    await startWaiting(other, late, lateRoom.remote('A'));
    await other.clock.advance(GAP);
    lateRoom.remote('A').syncEnd({ count: 1, sf: OTHER });
    assert.deepEqual(diverged(late), [], '기다림이 끝난 뒤에 온 답이다');
  });

  it('답의 지문이 같으면 맞음이다. 경고가 없고 간격은 기본값이다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    await startWaiting(bed, me, a);
    const extra = presenceRecord('ghost', bed.clock.now() - MIN);
    a.state([extra], true);
    a.syncEnd({ count: 1, sf: me.replica().fingerprint() });
    assert.deepEqual(diverged(me), []);
    assert.equal(me.log.named('state.resync').at(-1)?.fields.outcome, 'same');
  });
});

describe('V-U9 7: 지문이 같아지면', () => {
  it('간격이 늘어난 뒤 ping 의 지문이 같아지면 간격이 30초로 돌아오고 경고가 걷힌다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    const a = room.remote('A');
    // 진전 없음을 두 번 겪게 해 간격을 120초로 늘린다.
    let last = 0;
    for (let rounds = 0; rounds < 2; ) {
      await bed.clock.advance(PING);
      differentPing(me, a);
      if (syncEnds(a.take()).length === 0) continue;
      last = bed.clock.now();
      a.syncEnd({ count: 0, sf: OTHER });
      rounds += 1;
    }
    assert.deepEqual(warningCodes(me), ['state_diverged']);
    assert.equal(me.log.named('state.diverged').at(-1)?.fields.gap_ms, 120_000);

    await bed.clock.advance(PING);
    samePing(me, a);
    assert.deepEqual(warningCodes(me), [], '경고가 걷혔다');

    // 다시 달라진다. 늘어난 120초가 아니라 마지막 스냅샷에서 30초 뒤의 첫 ping 에 시작한다.
    const starts: number[] = [];
    for (let tick = 0; tick < 12 && starts.length === 0; tick += 1) {
      await bed.clock.advance(PING);
      differentPing(me, a);
      if (syncEnds(a.take()).length > 0) starts.push(bed.clock.now());
    }
    assert.deepEqual(starts.map((at) => (at - last) / SEC), [30]);
    assert.equal(me.log.named('state.resync').at(-1)?.fields.gap_ms, GAP);

    // 다시 진전 없음이면 경고를 다시 낸다(새로 생긴 차이다).
    a.syncEnd({ count: 0, sf: OTHER });
    assert.deepEqual(warningCodes(me), ['state_diverged']);
    assert.equal(me.log.named('state.diverged').at(-1)?.fields.gap_ms, 60_000, '30초에서 다시 늘기 시작한다');
  });
});

describe('V-U9 9: 중단을 병합으로 처음 받으면', () => {
  /**
   * alpha 가 A(중단을 전하는 링크), B(직전 교환 직후), C(간격이 300초로 늘어난 링크), D(답을 기다리는 중인 링크)와 이어져 있다.
   * 테스트는 A 가 시작했고 모두 받은 상태다.
   */
  async function arrange() {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const testId = `${sidOf('A')}-1`;
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B', 'C', 'D'], {
      records: (peer) => [presenceRecord(peer, bed.clock.now() - SEC), testRecordOf('A', bed.clock.now() - 2 * SEC, testId)],
    });
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((peer) => room.remote(peer)) as [ScriptedPeer, ScriptedPeer, ScriptedPeer, ScriptedPeer];
    // C: 진전 없음을 네 번 겪어 간격이 300초가 됐다.
    for (let rounds = 0; rounds < 4; ) {
      await bed.clock.advance(PING);
      differentPing(me, c);
      if (syncEnds(c.take()).length === 0) continue;
      c.syncEnd({ count: 0, sf: OTHER });
      rounds += 1;
    }
    assert.equal(me.log.named('state.diverged').at(-1)?.fields.gap_ms, 300_000);
    // D: 방금 교환을 시작했고 답이 아직 없다.
    differentPing(me, d);
    differentPing(me, d);
    assert.equal(syncEnds(d.take()).length, 1);
    // B: 방금 교환을 끝냈다.
    b.syncEnd({ count: 0 });
    assert.equal(syncEnds(b.take()).length, 1);
    for (const remote of [a, b, c, d]) remote.take();
    const stop = stopRecordOf('A', bed.clock.now() + 1, `${sidOf('A')}-2`, testId);
    return { bed, me, room, a, b, c, d, stop, testId };
  }

  it('변경으로 받았을 때: 받은 링크를 뺀 열린 모든 링크에 즉시 스냅샷을 보낸다(직전 교환 직후, 간격 300초, 답을 기다리는 중)', async () => {
    const { me, a, b, c, d, stop } = await arrange();
    a.state([stop]);
    for (const [name, remote] of [
      ['B', b],
      ['C', c],
      ['D', d],
    ] as const) {
      const frames = remote.take();
      assert.deepEqual(frames.map((frame) => frame.t), ['state', 'sync_end'], `${name} 에 바로 스냅샷을 보냈다`);
      assert.ok(snapshotRecords(frames).some((record) => record.kind === 'stop'), '스냅샷에 stop 이 들어 있다');
      assert.equal(syncEnds(frames)[0]?.sf, undefined, '답이 아니라 시작이다');
    }
    assert.deepEqual(a.take(), [], '받은 링크에는 보내지 않는다');
    assert.deepEqual(me.log.named('state.resync').slice(-3).map((entry) => [entry.fields.peer, entry.fields.cause]), [
      ['B', 'stop'],
      ['C', 'stop'],
      ['D', 'stop'],
    ]);
    assert.deepEqual(me.session.notice(), { test_stopped: { reason: 'user', by: 'A' } });
  });

  it('상대가 시작한 스냅샷으로 받았을 때: 다른 링크에는 시작으로, 그 링크에는 답으로 보낸다', async () => {
    const { a, b, c, d, stop, me } = await arrange();
    a.state([stop], true);
    for (const remote of [b, c, d]) {
      const ends = syncEnds(remote.take());
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.sf, undefined);
    }
    assert.deepEqual(a.take(), [], 'A 의 sync_end 가 오기 전이다');
    a.syncEnd({ count: 1 });
    const reply = syncEnds(a.take());
    assert.equal(reply.length, 1);
    assert.equal(reply[0]?.sf, me.replica().fingerprint(), '그 링크에는 답(sf 있음)으로 보낸다');
  });

  it('내가 시작한 교환의 답으로 받았을 때: 다른 링크에 시작하고, 그 링크에는 답하지 않는다', async () => {
    const { a, b, c, d, stop, me, bed } = await arrange();
    // A 와의 링크에서 교환을 시작해 둔다(간격이 지나 있다).
    await bed.clock.advance(GAP);
    for (const remote of [b, c, d]) samePing(me, remote);
    differentPing(me, a);
    differentPing(me, a);
    assert.equal(syncEnds(a.take()).length, 1);
    for (const remote of [b, c, d]) remote.take();
    a.state([stop], true).syncEnd({ count: 1, sf: OTHER });
    for (const remote of [b, c, d]) assert.equal(syncEnds(remote.take()).length, 1);
    assert.deepEqual(a.take(), []);
  });

  it('기다리는 중인 링크에 다시 보내도 기다림을 새로 시작하지 않는다', async () => {
    const { bed, a, d, stop } = await arrange();
    // D 는 방금(0초 전) 시작한 교환의 답을 기다리는 중이다. 20초 뒤에 중단이 온다.
    await bed.clock.advance(20 * SEC);
    a.state([stop]);
    assert.equal(syncEnds(d.take()).length, 1, '다시 보냈다');
    // 처음 기다리기 시작한 때부터 30초가 지나면 기다림이 끝난다. 다시 보낸 때부터 재면 아직 10초가 남았을 것이다.
    await bed.clock.advance(10 * SEC);
    d.syncEnd({ count: 0 });
    assert.equal(syncEnds(d.take()).length, 1, '기다리는 중이 아니므로 답한다');
  });
});

describe('V-U9 10: 이미 중단된 뒤와 로컬 중단', () => {
  it('이미 중단된 뒤 다른 stop 기록을 받으면 즉시 교환을 하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const testId = `${sidOf('A')}-1`;
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B'], {
      records: (peer) => [presenceRecord(peer, bed.clock.now() - SEC), testRecordOf('A', bed.clock.now() - 2 * SEC, testId)],
    });
    const a = room.remote('A');
    const b = room.remote('B');
    a.state([stopRecordOf('A', bed.clock.now() + 1, `${sidOf('A')}-2`, testId)]);
    assert.equal(syncEnds(b.take()).length, 1, '처음 중단됨이 된 순간에는 한다');
    // B 도 거의 동시에 중단을 썼다. 복제본은 이미 중단됨이다.
    b.state([stopRecordOf('B', bed.clock.now() + 2, `${sidOf('B')}-1`, testId, 'time_limit')]);
    assert.deepEqual(a.take(), []);
    assert.deepEqual(b.take(), []);
    assert.equal(me.replica().snapshot().filter((record) => record.kind === 'stop').length, 2, '기록은 둘 다 남는다');
    assert.equal(me.inbox.pushed.filter((event) => event.kind === 'test' && event.change === 'stopped').length, 1);
  });

  it('로컬에서 쓴 stop 은 변경으로 열린 링크 전부에 간다. 스냅샷 교환을 시작하지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    await me.session.command({ type: 'start_test', request: 'x', max_duration_min: 60, max_scenarios: 20 });
    for (const peer of ['A', 'B']) room.remote(peer).take();
    const stopped = await me.session.command({ type: 'stop_test', reason: '그만' });
    assert.deepEqual(stopped.ok && stopped.sent_to, ['A', 'B']);
    for (const peer of ['A', 'B']) {
      const frames = room.remote(peer).take();
      assert.deepEqual(frames.map((frame) => [frame.t, frame.t === 'state' && frame.snap]), [['state', undefined]], '변경 한 프레임뿐이다');
    }
    assert.equal(me.log.named('state.resync').filter((entry) => entry.fields.cause === 'stop').length, 0);
  });
});

describe('부분 mesh 에서의 전파 (가짜 망으로 이은 세 세션)', () => {
  it('A–B 링크가 없어도 B 가 쓴 stop 은 C 를 거쳐 바로 A 에 닿는다. 채팅은 가지 않는다', async () => {
    const bed = createTestBed();
    bed.net.autoConnect = true;
    bed.net.block('A', 'B');
    const c = bed.session({ name: 'C' });
    const a = bed.session({ name: 'A' });
    const b = bed.session({ name: 'B' });
    assert.equal((await c.session.create({ room_id: ROOM, name: 'C' })).ok, true);
    assert.equal((await bed.run(a.session.join({ room_id: ROOM, name: 'A' }))).ok, true);
    // B 가 들어올 때 A 는 서버 목록에 없다(시그널링이 끊긴 사이). 그래서 B 는 A 없이 입장한다.
    bed.net.unregister(ROOM, 'A');
    assert.equal((await bed.run(b.session.join({ room_id: ROOM, name: 'B' }))).ok, true);
    bed.net.register(ROOM, 'A', bed.net.joins.find((request) => request.peer === 'A')?.sid ?? '');
    bed.net.clientOf('B').emitMembers(bed.net.membersOf(ROOM).filter((member) => member.peer !== 'B'));
    bed.net.clientOf('A').emitMembers(bed.net.membersOf(ROOM).filter((member) => member.peer !== 'A'));
    await bed.settle();
    assert.equal(bed.net.meshOf('A')?.isOpen('B'), false);

    const test = await b.session.command({ type: 'start_test', request: 'x', max_duration_min: 60, max_scenarios: 20 });
    assert.deepEqual(test.ok && [test.sent_to, test.not_connected], [['C'], ['A']]);
    await bed.settle();
    const testOf = (sut: SessionUnderTest) => {
      const status = sut.session.status();
      assert.ok(status.ok);
      return status.test;
    };
    assert.equal(testOf(a), null, '변경은 작성자의 링크로만 간다. A 는 아직 모른다');

    const stopped = await b.session.command({ type: 'stop_test', reason: '그만' });
    assert.deepEqual(stopped.ok && [stopped.sent_to, stopped.not_connected], [['C'], ['A']]);
    await bed.settle();
    // 시간은 흐르지 않았다. C 가 병합한 순간 A 와의 링크에서 교환을 시작했다.
    assert.deepEqual([testOf(a)?.stopped?.reason, testOf(a)?.stopped?.by], ['user', 'B']);
    assert.equal(a.replica().fingerprint(), b.replica().fingerprint());
    assert.equal(c.log.named('state.resync').filter((entry) => entry.fields.cause === 'stop' && entry.fields.peer === 'A').length, 1);
    assert.ok(a.inbox.pushed.some((event) => event.kind === 'test' && event.change === 'stopped' && event.from === 'B'));

    // 채팅은 작성자와 수신자를 잇는 링크로만 간다. 스냅샷에도 들어 있지 않다.
    const sent = await bed.run(b.session.sendChat({ text: 'A 에게는 가지 않는 글' }));
    assert.deepEqual(sent.ok && [sent.delivered, sent.undelivered], [['C'], [{ name: 'A', reason: 'not_connected' }]]);
    assert.equal(a.inbox.pushed.some((event) => event.kind === 'chat'), false);
    assert.equal(c.inbox.pushed.filter((event) => event.kind === 'chat').length, 1);
    bed.net.assertNoListenerErrors();
  });
});
