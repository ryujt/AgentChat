// V-U9 8번과 11번: 경과 시간과 기한 (verification-plan.md 3.1 의 고정 기준. protocol.md 5.4, 5.5).
// 구성: room-session 둘(A, C)을 가짜 mesh 로 마주 잇는다. C 가 60분 제한의 테스트를 시작한다.
// 끊긴 쪽(B)의 기록은 C 에 변경으로 넣는다. 경과 시간은 room-session 에 넘긴 복제본의 testElapsed 로 읽는다.
// "실제로 흐른 시간"은 테스트를 시작한 뒤 가짜 시계가 간 시간이다.
//
// 판정에 쓰는 것은 shared-state 실물로 돌린 쪽이다. 가짜 복제본으로 돌린 쪽은 room-session 쪽 논리만 미리 보는 예비 실행이다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../protocol/index.js';
import type { StateRecord, SyncEndFrame } from '../protocol/index.js';
import type { CreateReplica } from '../shared-state/contract.js';
import type { ScriptedPeer, SessionUnderTest, TestBed } from './testing.js';
import { MIN, ROOM, SEC, createFakeReplica, createTestBed, presenceRecord, scenarioRecordOf, sidOf } from './testing.js';

const PING = LIMITS.P2P_PING_INTERVAL_MS;

/** shared-state 실물. 아직 없거나 불러올 수 없으면 null 이고, 그 시험은 "다음 단계에서 실행"으로 건너뛴다. */
async function loadRealReplica(): Promise<CreateReplica | null> {
  try {
    const module = (await import('../shared-state/index.js')) as { createReplica?: CreateReplica };
    return typeof module.createReplica === 'function' ? module.createReplica : null;
  } catch {
    return null;
  }
}

interface Scene {
  readonly bed: TestBed;
  readonly a: SessionUnderTest;
  readonly c: SessionUnderTest;
  /** C 와만 이어진 참가자. 시험이 손으로 연기한다. A 와는 링크가 없다. */
  readonly b: ScriptedPeer;
  readonly testId: string;
  /** C 가 테스트를 시작한 시각. */
  readonly startedAt: number;
  /** B 가 기록 하나를 쓴다(C 에 변경으로 들어간다). 주장과 presence 를 섞는다. */
  writeAsB(): void;
  /** 테스트를 시작한 뒤 실제로 흐른 시간. */
  actual(): number;
  elapsedOf(sut: SessionUnderTest): number;
}

async function arrange(createReplica: CreateReplica): Promise<Scene> {
  const bed = createTestBed();
  bed.net.autoConnect = true;
  bed.net.startPings();
  const c = bed.session({ name: 'C', createReplica });
  const a = bed.session({ name: 'A', createReplica });
  assert.equal((await c.session.create({ room_id: ROOM, name: 'C' })).ok, true);
  const b = bed.remote('C', 'B');
  b.sync([presenceRecord('B', bed.clock.now() - SEC)]);
  assert.equal((await bed.run(a.session.join({ room_id: ROOM, name: 'A' }))).ok, true);
  // 링크가 열린 지 1분이 지났다. 첫 동기화에서 잰 간격은 이미 지나 있다.
  await bed.clock.advance(MIN);

  const started = await c.session.command({ type: 'start_test', request: '수업 흐름을 함께 본다', max_duration_min: 60, max_scenarios: 50 });
  assert.ok(started.ok);
  const startedAt = bed.clock.now();
  await bed.settle();
  let seq = 1;
  let scenario: string | null = null;
  const writeAsB = (): void => {
    const now = bed.clock.now();
    const rid = `${sidOf('B')}-${seq.toString(36)}`;
    let record: StateRecord;
    if (scenario === null) {
      record = scenarioRecordOf('B', now, rid, started.test_id, 'B 의 시나리오');
      scenario = rid;
    } else if (seq % 3 === 0) {
      record = presenceRecord('B', now, { status: 'working', note: `기록 ${seq}` });
    } else {
      record = {
        kind: 'claim',
        rid,
        author: 'B',
        lc: now,
        wall: now,
        body: { test_id: started.test_id, scenario, action: `행동 ${seq}`, expected: null, observed: '관찰', outcome: 'pass', steps: '절차' },
      };
    }
    seq += 1;
    b.state([record]);
  };
  return {
    bed,
    a,
    c,
    b,
    testId: started.test_id,
    startedAt,
    writeAsB,
    actual: () => bed.clock.now() - startedAt,
    elapsedOf(sut) {
      const elapsed = sut.replica().testElapsed(bed.clock.now());
      assert.notEqual(elapsed, null, '테스트가 없다');
      return elapsed as number;
    },
  };
}

/** A–C 링크에서 스냅샷 교환이 시작된 시각(양쪽이 같은 때 시작한 것은 하나로 센다). */
function exchangeTimes(scene: Scene, marks: Map<number, number>): void {
  for (const [sut, peer] of [
    [scene.a, 'C'],
    [scene.c, 'A'],
  ] as const) {
    const count = sut.log.named('state.resync').filter((entry) => entry.fields.peer === peer && entry.fields.cause === 'ping_mismatch').length;
    const key = sut === scene.a ? -1 : -2;
    if (count > (marks.get(key) ?? 0)) {
      marks.set(key, count);
      marks.set(scene.bed.clock.now(), 1);
    }
  }
}

const stopsOf = (sut: SessionUnderTest) =>
  sut.replica().snapshot().filter((record): record is Extract<StateRecord, { kind: 'stop' }> => record.kind === 'stop');

const divergedOf = (sut: SessionUnderTest): number =>
  sut.inbox.pushed.filter((event) => event.kind === 'system' && event.data.code === 'state_diverged').length +
  sut.log.named('state.diverged').length;

/** 8번: 끊긴 쌍의 한쪽이 5초마다 기록을 쓰는 상태를 3분 돌린다. */
async function scenario8(createReplica: CreateReplica): Promise<void> {
  const scene = await arrange(createReplica);
  const { bed, a, c } = scene;
  const marks = new Map<number, number>();
  for (let tick = 0; tick < 36; tick += 1) {
    await bed.clock.advance(PING);
    exchangeTimes(scene, marks);
    // 교환이 끝날 때마다 5초 안에 새 기록이 온다.
    scene.writeAsB();
    await bed.settle();
    assert.ok(scene.elapsedOf(a) <= scene.actual(), `A 의 경과 시간이 실제보다 크다(${tick})`);
    assert.ok(scene.elapsedOf(c) <= scene.actual(), `C 의 경과 시간이 실제보다 크다(${tick})`);
  }
  assert.equal(scene.actual(), 3 * MIN);

  const times = [...marks.keys()].filter((at) => at > 0).sort((x, y) => x - y);
  const gaps = times.slice(1).map((at, index) => (at - (times[index] as number)) / SEC);
  assert.ok(times.length >= 5, `교환이 3분 동안 ${times.length}번뿐이다`);
  assert.ok(gaps.every((gap) => gap >= 30 && gap <= 35), `교환 사이가 30~35초가 아니다: ${gaps.join(', ')}`);
  assert.ok(((times[0] as number) - scene.startedAt) / SEC <= 35, '첫 교환이 늦다');
  assert.ok((bed.clock.now() - (times.at(-1) as number)) / SEC <= 35, '교환이 끝까지 이어지지 않았다');

  // 간격이 늘지 않는다. 경고와 사건이 없다.
  for (const sut of [a, c]) {
    const resyncs = sut.log.named('state.resync').filter((entry) => entry.fields.cause !== undefined);
    assert.ok(resyncs.every((entry) => entry.fields.gap_ms === LIMITS.RESYNC_MIN_GAP_MS), '간격이 늘었다');
    assert.equal(divergedOf(sut), 0, 'state_diverged 가 났다');
    const status = sut.session.status();
    assert.deepEqual(status.ok && status.warnings.filter((warning) => warning.code === 'state_diverged'), []);
  }

  // 끝났을 때 A 와 C 의 경과 시간이 실제로 흐른 3분과 1초 안에서 맞는다.
  assert.ok(Math.abs(scene.elapsedOf(a) - 3 * MIN) <= SEC, `A: ${scene.elapsedOf(a)}`);
  assert.ok(Math.abs(scene.elapsedOf(c) - 3 * MIN) <= SEC, `C: ${scene.elapsedOf(c)}`);
  // B 가 쓴 기록은 C 와의 재동기화로 A 에 닿는다. 마지막 교환 뒤의 것만 아직 없다.
  const fromB = (sut: SessionUnderTest): number => sut.replica().snapshot().filter((record) => record.author === 'B').length;
  assert.ok(fromB(a) >= fromB(c) - 8 && fromB(a) > 0, `A 가 받은 B 의 기록 ${fromB(a)} / C ${fromB(c)}`);
  bed.net.assertNoListenerErrors();
}

/** 11번: 60분 제한의 테스트를 60분이 지날 때까지 돌린다. */
async function scenario11(createReplica: CreateReplica): Promise<void> {
  const scene = await arrange(createReplica);
  const { bed, c } = scene;
  let a = scene.a;
  const limit = 60 * MIN;
  const noStopYet = (): void => {
    assert.deepEqual(stopsOf(c), [], `C 에 stop 이 60분 전에 쓰였다(${scene.actual() / MIN}분)`);
    assert.deepEqual(stopsOf(a), [], `A 에 stop 이 60분 전에 쓰였다(${scene.actual() / MIN}분)`);
  };
  const neverAhead = (): void => {
    assert.ok(scene.elapsedOf(a) <= scene.actual(), `A 의 경과 시간 ${scene.elapsedOf(a)} 이 실제 ${scene.actual()} 보다 크다`);
    assert.ok(scene.elapsedOf(c) <= scene.actual(), `C 의 경과 시간 ${scene.elapsedOf(c)} 이 실제 ${scene.actual()} 보다 크다`);
  };

  // 10분 직전까지는 조용히 간다.
  await bed.clock.advance(10 * MIN - SEC);
  noStopYet();

  // (가) 10분째에 A–C 링크를 닫았다 다시 연다. 양쪽 sync_end 가 10분을 싣는다.
  const meshA = bed.net.meshOf('A');
  const meshC = bed.net.meshOf('C');
  assert.ok(meshA && meshC);
  const sentBefore = { a: meshA.framesTo('C').length, c: meshC.framesTo('A').length };
  meshA.dropLink('C', 'failed');
  meshC.dropLink('A', 'failed');
  await bed.clock.advance(LIMITS.RECONTACT_DELAY_MS);
  assert.equal(scene.actual(), 10 * MIN);
  assert.equal(meshA.isOpen('C'), true, '1초 뒤 다시 접촉해 링크가 열렸다');
  const firstSyncEnd = (frames: readonly unknown[]): SyncEndFrame | undefined =>
    frames.find((frame): frame is SyncEndFrame => (frame as { t?: string }).t === 'sync_end');
  const fromA = firstSyncEnd(meshA.framesTo('C').slice(sentBefore.a));
  const fromC = firstSyncEnd(meshC.framesTo('A').slice(sentBefore.c));
  assert.deepEqual([fromA?.test_id, fromA?.test_elapsed_ms], [scene.testId, 10 * MIN], 'A 의 sync_end 가 10분을 싣는다');
  assert.deepEqual([fromC?.test_id, fromC?.test_elapsed_ms], [scene.testId, 10 * MIN], 'C 의 sync_end 가 10분을 싣는다');
  for (const sut of [a, c]) {
    assert.ok(Math.abs(scene.elapsedOf(sut) - 10 * MIN) <= SEC, `다시 연 뒤 경과 시간이 10분에서 벗어났다: ${scene.elapsedOf(sut)}`);
  }
  neverAhead();

  // (나) 그 뒤 8번의 상태(B 가 5초마다 기록을 쓰고 A–C 가 30~35초마다 교환)를 50분째까지 유지한다.
  const marks = new Map<number, number>();
  while (scene.actual() < 50 * MIN) {
    await bed.clock.advance(PING);
    exchangeTimes(scene, marks);
    scene.writeAsB();
    await bed.settle();
    neverAhead();
    noStopYet();
  }
  const times = [...marks.keys()].filter((at) => at > 0).sort((x, y) => x - y);
  const gaps = times.slice(1).map((at, index) => (at - (times[index] as number)) / SEC);
  assert.ok(times.length >= 60, `40분 동안 교환이 ${times.length}번뿐이다`);
  assert.ok(gaps.every((gap) => gap >= 30 && gap <= 35), `교환 사이가 30~35초가 아니다: ${[...new Set(gaps)].join(', ')}`);
  assert.equal(divergedOf(a) + divergedOf(c), 0);
  for (const sut of [a, c]) {
    assert.ok(Math.abs(scene.elapsedOf(sut) - 50 * MIN) <= SEC, `50분째의 경과 시간: ${scene.elapsedOf(sut)}`);
  }

  // (다) 50분째에 A 가 나가고, 빈 복제본을 가진 새 room-session 이 같은 이름으로 들어온다.
  assert.equal((await bed.run(a.session.leave())).ok, true);
  const rejoined = bed.session({ name: 'A', createReplica });
  const entered = await bed.run(rejoined.session.join({ room_id: ROOM, name: 'A' }));
  assert.ok(entered.ok);
  a = rejoined;
  assert.equal(scene.actual(), 50 * MIN, '입장하는 동안 시간은 가지 않았다');
  assert.ok(Math.abs(scene.elapsedOf(a) - 50 * MIN) <= SEC, `들어온 직후의 경과 시간: ${scene.elapsedOf(a)}`);
  assert.equal(entered.test?.remaining_min, 10);
  // 기한 타이머가 남은 10분으로 걸려 있다. C 의 것과 새 A 의 것 둘이다.
  const deadlines = bed.clock.delays().filter((delay) => Math.abs(delay - 10 * MIN) <= SEC);
  assert.equal(deadlines.length, 2, `남은 10분짜리 타이머: ${bed.clock.delays().join(', ')}`);
  noStopYet();

  // 60분 직전까지 같은 상태를 유지한다.
  while (scene.actual() < limit - PING) {
    await bed.clock.advance(PING);
    scene.writeAsB();
    await bed.settle();
    neverAhead();
    noStopYet();
  }
  await bed.clock.advance(PING - 1);
  noStopYet();
  assert.equal(scene.actual(), limit - 1);

  // 전체: stop{time_limit} 이 60분 전에는 쓰이지 않고, 60분에서 5초 안에 쓰인다.
  await bed.clock.advance(1 + 5 * SEC);
  for (const sut of [a, c]) {
    const stops = stopsOf(sut);
    assert.ok(stops.length >= 1, 'stop 이 쓰이지 않았다');
    assert.ok(stops.every((stop) => stop.body.reason === 'time_limit' && stop.body.test_id === scene.testId));
    const first = Math.min(...stops.map((stop) => stop.wall));
    assert.ok(first >= scene.startedAt + limit && first <= scene.startedAt + limit + 5 * SEC, `stop 이 쓰인 때: ${(first - scene.startedAt) / SEC}초`);
    const status = sut.session.status();
    assert.deepEqual(status.ok && [status.test?.stopped?.reason, status.test?.remaining_min], ['time_limit', 0]);
  }
  bed.net.assertNoListenerErrors();
}

describe('V-U9 8번과 11번 (shared-state 실물)', async () => {
  const real = await loadRealReplica();
  const skip = real === null ? 'shared-state 실물(src/shared-state/index.ts)을 불러올 수 없다. 다음 단계에서 실행한다' : false;

  it('8: 끊긴 쌍의 한쪽이 5초마다 기록을 쓰는 3분 동안 교환이 30~35초마다 이어지고 경과 시간이 불어나지 않는다', { skip }, async () => {
    await scenario8(real as CreateReplica);
  });

  it('11: 60분 제한의 테스트에서 경과 시간이 실제를 넘지 않고, 재입장자가 50분을 넘겨받고, stop{time_limit} 이 60분에 쓰인다', { skip }, async () => {
    await scenario11(real as CreateReplica);
  });
});

describe('V-U9 8번과 11번의 예비 실행 (가짜 복제본. 판정에 쓰지 않는다)', () => {
  it('8 예비: room-session 이 받은 경과 시간을 그대로 넘기고 교환 간격을 지킨다', async () => {
    await scenario8(createFakeReplica);
  });

  it('11 예비: 링크를 다시 열 때와 재입장 때 경과 시간을 넘기고 기한 타이머를 건다', async () => {
    await scenario11(createFakeReplica);
  });
});
