// V-U3: 경과 시간 (protocol.md 5.5). 기한 판정에 PC 사이의 시계 차이를 쓰지 않는다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN,
  SEC,
  T0,
  apply,
  exchange,
  makePeer,
  refuse,
  seededRandom,
  seedsForRun,
  sendChange,
  sendSnapshot,
  startScenario,
  startTest,
} from './testing.js';

const NEW_SCENARIO = { type: 'start_scenario', title: '새 시나리오' } as const;

describe('shared-state: 경과 시간', () => {
  it('테스트가 없으면 null 이고 adoptElapsed 는 아무 것도 바꾸지 않는다', () => {
    const alice = makePeer('alice');
    assert.equal(alice.replica.testElapsed(T0), null);
    assert.equal(alice.replica.adoptElapsed('aaaaaaaaaaaa-1', 5 * MIN, T0), false);
    assert.equal(alice.replica.testElapsed(T0), null);
  });

  it('test 기록이 현재 테스트가 되는 호출의 now 부터 0 에서 센다(시작, 변경, 스냅샷 모두)', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const started = startTest(alice, T0);
    assert.equal(alice.replica.testElapsed(T0), 0);
    assert.equal(alice.replica.testElapsed(T0 + 90 * SEC), 90 * SEC);

    // 받은 쪽은 받은 순간부터 센다. started_wall 이나 기록의 lc 를 쓰지 않는다.
    sendChange(alice, bob, started.records, T0 + 4 * SEC);
    assert.equal(bob.replica.testElapsed(T0 + 4 * SEC), 0);
    sendSnapshot(alice, carol, T0 + 7 * MIN);
    assert.equal(carol.replica.testElapsed(T0 + 7 * MIN), 0);
    assert.equal(carol.replica.testElapsed(T0 + 8 * MIN), MIN);

    // 그 뒤의 기록(시나리오, presence, 같은 test 기록의 재수신)은 기준을 바꾸지 않는다.
    sendChange(alice, bob, startScenario(alice, T0 + 5 * SEC).records, T0 + 30 * SEC);
    sendSnapshot(alice, bob, T0 + 40 * SEC);
    apply(bob, { type: 'set_presence', patch: {} }, T0 + 50 * SEC);
    assert.equal(bob.replica.testElapsed(T0 + 64 * SEC), 60 * SEC);
  });

  it('adoptElapsed: 클 때만 두 값을 함께 바꾸고 true, 작거나 같은 값과 다른 test_id 는 false', () => {
    const alice = makePeer('alice');
    const started = startTest(alice, T0);
    const now = T0 + 10 * MIN;
    const readings = (): number[] => [now, now + 1, now + 5 * MIN].map((at) => alice.replica.testElapsed(at) as number);
    const before = readings();
    assert.deepEqual(before, [10 * MIN, 10 * MIN + 1, 15 * MIN]);

    assert.equal(alice.replica.adoptElapsed(started.testId, 10 * MIN, now), false, '같은 값');
    assert.equal(alice.replica.adoptElapsed(started.testId, 10 * MIN - 1, now), false, '작은 값');
    assert.equal(alice.replica.adoptElapsed(started.testId, 0, now), false);
    assert.equal(alice.replica.adoptElapsed('zzzzzzzzzzzz-1', 50 * MIN, now), false, '다른 test_id');
    assert.equal(alice.replica.adoptElapsed(started.testId, Number.NaN, now), false);
    assert.equal(alice.replica.adoptElapsed(started.testId, Number.POSITIVE_INFINITY, now), false);
    assert.deepEqual(readings(), before, 'false 를 돌려준 호출은 아무 것도 바꾸지 않는다');

    assert.equal(alice.replica.adoptElapsed(started.testId, 10 * MIN + 1, now), true, '1ms 라도 크면 따른다');
    assert.equal(alice.replica.testElapsed(now), 10 * MIN + 1);

    // 두 값을 함께 바꾼다. 기준 시각을 그대로 두면 (지금 − 기준 시각)이 한 번 더 더해져 12분이 22분이 된다.
    assert.equal(alice.replica.adoptElapsed(started.testId, 12 * MIN, now), true);
    assert.equal(alice.replica.testElapsed(now), 12 * MIN);
    assert.equal(alice.replica.testElapsed(now + 3 * MIN), 15 * MIN);
    assert.equal(alice.replica.view(now + 3 * MIN).test?.elapsed_ms, 15 * MIN);
    assert.equal(alice.replica.view(now + 3 * MIN).test?.remaining_ms, 45 * MIN);

    // 같은 값을 다시 받아도 늘지 않는다.
    for (let i = 0; i < 5; i += 1) assert.equal(alice.replica.adoptElapsed(started.testId, 12 * MIN, now), false);
    assert.equal(alice.replica.testElapsed(now), 12 * MIN);
  });

  it('테스트 10분째에 10분을 실은 값을 여러 번 넘겨받아도 10분에서 벗어나지 않는다', () => {
    const alice = makePeer('alice');
    const started = startTest(alice, T0);
    const now = T0 + 10 * MIN;
    for (let i = 0; i < 100; i += 1) {
      assert.equal(alice.replica.adoptElapsed(started.testId, 10 * MIN, now), false);
      // 전달 지연만큼 뒤진 값도 같다.
      assert.equal(alice.replica.adoptElapsed(started.testId, 10 * MIN - (i % 5) * SEC, now), false);
    }
    assert.equal(alice.replica.testElapsed(now), 10 * MIN);
    assert.equal(alice.replica.view(now).test?.remaining_ms, 50 * MIN);
  });

  it('0 에서 시작한 입장자는 받은 값 가운데 가장 큰 것을 따른다', () => {
    const alice = makePeer('alice');
    const started = startTest(alice, T0);
    const joinAt = T0 + 50 * MIN;
    const values = [49 * MIN + 58 * SEC, 50 * MIN, 49 * MIN + 59 * SEC, 12 * MIN];
    const orders = [
      [0, 1, 2, 3],
      [1, 0, 2, 3],
      [3, 2, 0, 1],
      [2, 3, 1, 0],
    ];
    for (const [i, order] of orders.entries()) {
      const joiner = makePeer('dave', { generation: i });
      sendSnapshot(alice, joiner, joinAt);
      assert.equal(joiner.replica.testElapsed(joinAt), 0);
      const adopted = order.map((k) => joiner.replica.adoptElapsed(started.testId, values[k] as number, joinAt));
      assert.equal(joiner.replica.testElapsed(joinAt), 50 * MIN, `순서 ${order.join(',')}`);
      // 바꿨을 때만 true 다. 지금 값보다 큰 값을 받은 때다.
      let best = 0;
      const expected = order.map((k) => {
        const larger = (values[k] as number) > best;
        if (larger) best = values[k] as number;
        return larger;
      });
      assert.deepEqual(adopted, expected);
      assert.equal(joiner.replica.view(joinAt + SEC).test?.remaining_ms, 10 * MIN - SEC, '기한 타이머는 남은 10분으로 건다');
      assert.equal(refuse(joiner, NEW_SCENARIO, joinAt + 10 * MIN), 'TIME_LIMIT_REACHED');
    }
  });

  for (const seed of seedsForRun()) {
    it(`두 복제본이 30초마다 서로의 값을 넘겨받으며 60분을 가도 실제로 흐른 시간을 넘지 않는다 (seed=${seed})`, (t) => {
      t.diagnostic(`seed=${seed} (다시 보려면 AGENT_CHAT_TEST_SEED=${seed})`);
      const rand = seededRandom(seed);
      const alice = makePeer('alice');
      const carol = makePeer('carol');
      // 두 PC 의 벽시계는 70분 다르고 빠르기는 같다. real 은 테스트를 시작한 뒤 실제로 흐른 시간이다.
      const clocks = new Map([[alice, T0], [carol, T0 + 70 * MIN]]);
      const nowOf = (peer: typeof alice, real: number): number => (clocks.get(peer) as number) + real;

      const started = startTest(carol, nowOf(carol, 0), { minutes: 60 });
      // alice 는 2초 뒤에 테스트를 받는다.
      const learnedAt = 2 * SEC;
      const inFlight: { readonly to: typeof alice; readonly ms: number; readonly dueAt: number }[] = [];
      let learned = false;
      let adoptedCount = 0;
      const last = new Map([[alice, 0], [carol, 0]]);

      for (let real = 0; real <= 60 * MIN; real += 250) {
        if (!learned && real >= learnedAt) {
          sendChange(carol, alice, started.records, nowOf(alice, real));
          learned = true;
        }
        // 30초마다 양쪽이 자기 값을 보낸다(sync_end). 건너오는 데 0~5초가 걸린다.
        if (learned && real % (30 * SEC) === 0) {
          for (const [from, to] of [[alice, carol], [carol, alice]] as const) {
            inFlight.push({ to, ms: from.replica.testElapsed(nowOf(from, real)) as number, dueAt: real + Math.floor(rand() * 5 * SEC) });
          }
        }
        for (let i = inFlight.length - 1; i >= 0; i -= 1) {
          const message = inFlight[i];
          if (message === undefined || message.dueAt > real) continue;
          inFlight.splice(i, 1);
          if (message.to.replica.adoptElapsed(started.testId, message.ms, nowOf(message.to, real))) adoptedCount += 1;
        }
        for (const peer of [alice, carol]) {
          if (peer === alice && !learned) continue;
          const elapsed = peer.replica.testElapsed(nowOf(peer, real)) as number;
          assert.ok(elapsed <= real, `seed=${seed} ${peer.name}: ${real}ms 에 경과 시간이 ${elapsed}ms 다. 실제보다 크다`);
          assert.ok(elapsed >= (last.get(peer) as number), `seed=${seed} ${peer.name}: 경과 시간이 줄었다`);
          last.set(peer, elapsed);
        }
      }
      // 시작한 쪽은 실제와 같고, 받은 쪽은 전달 지연(최대 5초)만큼만 뒤진다.
      assert.equal(carol.replica.testElapsed(nowOf(carol, 60 * MIN)), 60 * MIN);
      const lag = 60 * MIN - (alice.replica.testElapsed(nowOf(alice, 60 * MIN)) as number);
      assert.ok(lag >= 0 && lag <= 5 * SEC, `seed=${seed}: alice 가 ${lag}ms 뒤졌다`);
      assert.ok(adoptedCount >= 1, 'alice 는 처음 2초의 차이를 상대 값으로 메운다');
      t.diagnostic(`seed=${seed}: 넘겨받아 바꾼 횟수 ${adoptedCount}, alice 의 뒤짐 ${lag}ms`);

      // 기한은 60분에 닿는다. 그 전에는 닿지 않는다.
      startScenario(carol, nowOf(carol, 60 * MIN - 1));
      startScenario(alice, nowOf(alice, 60 * MIN - 1));
      assert.equal(refuse(carol, NEW_SCENARIO, nowOf(carol, 60 * MIN)), 'TIME_LIMIT_REACHED');
    });
  }

  it('시작한 참가자가 떠난 뒤 남은 둘이 30초마다 주고받으며 60분을 가도 실제로 흐른 시간을 넘지 않는다', () => {
    const rand = seededRandom(20261115);
    const bob = makePeer('bob');
    const alice = makePeer('alice');
    const carol = makePeer('carol');
    const started = startTest(bob, T0 + 33 * MIN, { minutes: 60 });
    // 둘 다 받은 쪽이다. alice 는 2초, carol 은 4초 뒤에 받았다. 벽시계는 서로 70분 다르다.
    const offsets = new Map([[alice, 0], [carol, -70 * MIN]]);
    const learnedAt = new Map([[alice, 2 * SEC], [carol, 4 * SEC]]);
    const nowOf = (peer: typeof alice, real: number): number => T0 + (offsets.get(peer) as number) + real;
    const inFlight: { readonly to: typeof alice; readonly ms: number; readonly dueAt: number }[] = [];

    for (let real = 0; real <= 60 * MIN; real += 500) {
      for (const peer of [alice, carol]) {
        if (real === learnedAt.get(peer)) sendChange(bob, peer, started.records, nowOf(peer, real));
      }
      if (real >= 4 * SEC && real % (30 * SEC) === 0) {
        for (const [from, to] of [[alice, carol], [carol, alice]] as const) {
          inFlight.push({ to, ms: from.replica.testElapsed(nowOf(from, real)) as number, dueAt: real + Math.floor(rand() * 5 * SEC) });
        }
      }
      for (let i = inFlight.length - 1; i >= 0; i -= 1) {
        const message = inFlight[i];
        if (message === undefined || message.dueAt > real) continue;
        inFlight.splice(i, 1);
        message.to.replica.adoptElapsed(started.testId, message.ms, nowOf(message.to, real));
      }
      for (const peer of [alice, carol]) {
        const elapsed = peer.replica.testElapsed(nowOf(peer, real));
        if (elapsed !== null) assert.ok(elapsed <= real, `${peer.name}: ${real}ms 에 ${elapsed}ms`);
      }
    }
    // 가장 먼저 안 쪽(2초 뒤짐)보다 앞서지 못하고, 늦게 안 쪽은 그 값을 따라간다.
    const end = 60 * MIN;
    assert.equal(alice.replica.testElapsed(nowOf(alice, end)), end - 2 * SEC);
    const carolLag = end - (carol.replica.testElapsed(nowOf(carol, end)) as number);
    assert.ok(carolLag >= 2 * SEC && carolLag <= 4 * SEC, `carol 이 ${carolLag}ms 뒤졌다`);
  });

  it('두 복제본이 번갈아 넘겨받아도 서로를 끌어올리지 않는다(지연 없이 주고받는 가장 불리한 경우)', () => {
    const alice = makePeer('alice');
    const carol = makePeer('carol');
    const started = startTest(carol, T0, { minutes: 60 });
    sendChange(carol, alice, started.records, T0 + 3 * SEC);
    let now = T0 + 3 * SEC;
    for (let round = 0; round < 2_000; round += 1) {
      now += round % 7;
      const fromCarol = carol.replica.testElapsed(now) as number;
      const fromAlice = alice.replica.testElapsed(now) as number;
      alice.replica.adoptElapsed(started.testId, fromCarol, now);
      carol.replica.adoptElapsed(started.testId, fromAlice, now);
      alice.replica.adoptElapsed(started.testId, carol.replica.testElapsed(now) as number, now);
      carol.replica.adoptElapsed(started.testId, alice.replica.testElapsed(now) as number, now);
      assert.equal(carol.replica.testElapsed(now), now - T0);
      assert.equal(alice.replica.testElapsed(now), now - T0, '따라잡은 뒤로는 같다');
    }
  });

  it('벽시계가 뒤로 가면 0 으로 세고, 받은 값 때문에 줄지 않는다', () => {
    const alice = makePeer('alice');
    const started = startTest(alice, T0 + 10 * MIN);
    assert.equal(alice.replica.testElapsed(T0), 0, '0 보다 작은 값은 0 으로 센다');
    assert.equal(alice.replica.view(T0).test?.remaining_ms, 60 * MIN);

    assert.equal(alice.replica.adoptElapsed(started.testId, 20 * MIN, T0 + 15 * MIN), true);
    const rand = seededRandom(7);
    let previous = alice.replica.testElapsed(T0 + 15 * MIN) as number;
    for (let i = 0; i < 500; i += 1) {
      alice.replica.adoptElapsed(started.testId, Math.floor(rand() * 40 * MIN), T0 + 15 * MIN);
      const current = alice.replica.testElapsed(T0 + 15 * MIN) as number;
      assert.ok(current >= previous, '어떤 값을 받아도 줄지 않는다');
      previous = current;
    }
  });

  it('한 PC 의 벽시계가 앞으로 바뀌면 그 값이 퍼진다(설계가 적은 한계)', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const started = startTest(alice, T0, { minutes: 60 });
    sendChange(alice, bob, started.records, T0);
    // 10분째에 alice 의 벽시계가 20분 앞으로 바뀌었다.
    const jumped = alice.replica.testElapsed(T0 + 10 * MIN + 20 * MIN) as number;
    assert.equal(jumped, 30 * MIN);
    assert.equal(bob.replica.adoptElapsed(started.testId, jumped, T0 + 10 * MIN), true);
    assert.equal(bob.replica.testElapsed(T0 + 10 * MIN), 30 * MIN);
  });

  it('동시에 시작한 둘 가운데 진 쪽이 이긴 테스트로 넘어가면 0 에서 다시 센다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    startTest(alice, T0);
    const b = startTest(bob, T0 + 1);
    assert.equal(alice.replica.testElapsed(T0 + 5 * MIN), 5 * MIN);
    const { toA } = exchange(alice, bob, T0 + 5 * MIN);
    const replaced = toA.changes[0];
    assert.ok(replaced?.type === 'test_replaced');
    assert.equal(replaced.test.elapsed_ms, 0);
    assert.equal(alice.replica.testElapsed(T0 + 5 * MIN), 0);
    assert.equal(alice.replica.testElapsed(T0 + 6 * MIN), MIN);
    assert.equal(bob.replica.testElapsed(T0 + 6 * MIN), 6 * MIN - 1, '이긴 쪽은 그대로다');
    assert.equal(alice.replica.adoptElapsed(b.testId, 6 * MIN - 1, T0 + 6 * MIN), true);
  });

  it('중단된 뒤에도 경과 시간은 계속 센다(표시용). 기한 거절보다 중단 거절이 먼저다', () => {
    const alice = makePeer('alice');
    startTest(alice, T0, { minutes: 1 });
    apply(alice, { type: 'stop_test', reason: 'user', detail: '' }, T0 + 10 * SEC);
    assert.equal(alice.replica.testElapsed(T0 + 5 * MIN), 5 * MIN);
    assert.equal(alice.replica.view(T0 + 5 * MIN).test?.remaining_ms, 0);
    assert.equal(refuse(alice, NEW_SCENARIO, T0 + 5 * MIN), 'TEST_STOPPED');
  });
});
