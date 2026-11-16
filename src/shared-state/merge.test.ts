// V-U3: 병합의 수렴(무작위 순서·중복, 시드 기록), 받을 때의 검증, 병합 상한, 병합이 내는 도메인 변화.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LIMITS,
  canonicalJson,
  compareCanonical,
  isKeyRecord,
  packStateFrames,
  parseP2PFrame,
  recordIdentity,
  stateFingerprint,
} from '../protocol/index.js';
import type { StateRecord } from '../protocol/index.js';
import type { StateCommand } from './contract.js';
import {
  MIN,
  T0,
  apply,
  changeTypes,
  exchange,
  makePeer,
  recordClaim,
  recordVerification,
  seededRandom,
  seedsForRun,
  sendChange,
  sendSnapshot,
  signature,
  startScenario,
  startTest,
  type Peer,
} from './testing.js';

const OTHER_SID = 'zzzzzzzzzzzz';

function pick<T>(rand: () => number, items: readonly T[]): T | undefined {
  return items[Math.floor(rand() * items.length)];
}

function shuffled<T>(rand: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

interface Simulation {
  readonly peers: readonly Peer[];
  /** 방에서 만들어진 모든 기록과, 식별자가 같고 내용이 다른 위조 기록. */
  readonly pool: readonly StateRecord[];
  readonly refusals: ReadonlyMap<string, number>;
}

/**
 * 네 참가자가 시계가 서로 다른 채로 기록을 쓰고, 일부 링크로만 변경을 보내고, 가끔 스냅샷을 교환한다.
 * 동시 시작, 한도 초과, 자기 검증, 중단 뒤 기록이 섞여 나온다.
 */
function simulate(rand: () => number, steps: number): Simulation {
  const peers = [makePeer('alice'), makePeer('bob'), makePeer('carol'), makePeer('dave')];
  const offsets = [0, 70 * MIN, -5 * MIN, 3_000];
  const pool: StateRecord[] = [];
  const refusals = new Map<string, number>();
  let clock = T0;

  const act = (index: number, command: StateCommand): void => {
    const peer = peers[index] as Peer;
    const result = peer.replica.applyLocal(command, clock + (offsets[index] as number));
    if (!result.ok) {
      refusals.set(result.code, (refusals.get(result.code) ?? 0) + 1);
      return;
    }
    if (result.records.length === 0) return;
    const packed = packStateFrames(result.records, { snap: false });
    assert.ok(packed.ok, 'applyLocal 이 만든 기록은 packStateFrames 를 통과한다');
    pool.push(...result.records);
    // 변경은 작성자가 자기 링크로만 보낸다. 링크가 없는 참가자는 받지 못한다.
    peers.forEach((other, otherIndex) => {
      if (otherIndex === index || rand() < 0.4) return;
      const merged = other.replica.mergeRemote(result.records, { from: peer.name, snapshot: false }, clock + (offsets[otherIndex] as number));
      assert.equal(merged.anomalies, 0);
    });
  };

  // 서로 못 본 채 동시에 시작한 두 테스트.
  act(0, { type: 'start_test', request: 'alice 의 요청', max_duration_min: 60, max_scenarios: 5 });
  act(1, { type: 'start_test', request: 'bob 의 요청', max_duration_min: 30, max_scenarios: 4 });

  for (let step = 0; step < steps; step += 1) {
    clock += Math.floor(rand() * 3_000);
    if (step === Math.floor(steps * 0.75)) {
      // 중단이 한 번은 나오게 한다. 그 뒤의 주장은 중단 뒤 기록이 된다.
      exchange(peers[2] as Peer, peers[1] as Peer, clock);
      act(2, { type: 'stop_test', reason: 'user', detail: '사용자 중단' });
    }
    const index = Math.floor(rand() * peers.length);
    const peer = peers[index] as Peer;
    const view = peer.replica.view(clock);
    const roll = rand();
    if (roll < 0.15) {
      act(index, { type: 'set_presence', patch: { role: pick(rand, ['강사', '수강생', '관찰자', null]) ?? null, status: pick(rand, ['joined', 'ready', 'working', 'left'] as const) ?? 'ready' } });
    } else if (roll < 0.2) {
      act(index, { type: 'start_test', request: '또 시작', max_duration_min: 10, max_scenarios: 3 });
    } else if (roll < 0.4) {
      act(index, { type: 'start_scenario', title: `시나리오 ${step}` });
    } else if (roll < 0.65) {
      const scenario = pick(rand, view.scenarios);
      if (scenario !== undefined) {
        act(index, { type: 'record_claim', scenario_id: scenario.scenario_id, action: `행동 ${step}`, observed: '관찰', outcome: rand() < 0.7 ? 'pass' : 'fail', steps: '절차' });
      }
    } else if (roll < 0.85) {
      const claim = pick(rand, view.claims);
      if (claim !== undefined) {
        act(index, { type: 'record_verification', claim_id: claim.claim_id, result: pick(rand, ['confirmed', 'refuted', 'unable'] as const) ?? 'unable', evidence: `증거 ${step}` });
      }
    } else if (roll < 0.87) {
      if (step > steps * 0.6) act(index, { type: 'stop_test', reason: rand() < 0.5 ? 'user' : 'time_limit', detail: '' });
    } else {
      const otherIndex = (index + 1 + Math.floor(rand() * (peers.length - 1))) % peers.length;
      exchange(peer, peers[otherIndex] as Peer, clock);
    }
  }

  // 식별자가 같고 내용이 다른 기록(결함이나 위조). 어느 순서로 받아도 같은 쪽이 남아야 한다.
  const appendOnes = pool.filter((record) => !isKeyRecord(record));
  for (let i = 0; i < 6 && appendOnes.length > 0; i += 1) {
    const source = pick(rand, appendOnes) as StateRecord;
    const forged = structuredClone(source) as StateRecord;
    if (forged.kind === 'scenario') forged.body.title = `위조 ${i}`;
    else if (forged.kind === 'claim') forged.body.observed = `위조 ${i}`;
    else if (forged.kind === 'verification') forged.body.evidence = `위조 ${i}`;
    else if (forged.kind === 'stop') forged.body.detail = `위조 ${i}`;
    if (rand() < 0.5) forged.lc += 1;
    pool.push(forged);
  }
  for (const source of pool.filter(isKeyRecord).slice(0, 4)) {
    const forged = structuredClone(source);
    if (forged.kind === 'test') forged.body.request = '위조한 요청';
    else forged.body.note = '위조한 메모';
    pool.push(forged);
  }
  // 주장 작성자의 이름으로 쓴 자기 검증.
  const someClaim = pool.find((record) => record.kind === 'claim');
  if (someClaim !== undefined && someClaim.kind === 'claim') {
    pool.push({
      kind: 'verification',
      rid: `${OTHER_SID}-self`,
      author: someClaim.author,
      lc: someClaim.lc + 1,
      wall: someClaim.wall,
      body: { test_id: someClaim.body.test_id, claim: someClaim.rid, result: 'confirmed', evidence: '자기 검증' },
    });
  }
  return { peers, pool, refusals };
}

/** 병합 규칙(protocol.md 5.3)을 시험 쪽에서 따로 적은 것. 구현과 같은 코드를 쓰지 않는다. */
function expectedSurvivors(pool: readonly StateRecord[]): StateRecord[] {
  const winners = new Map<string, StateRecord>();
  for (const record of pool) {
    const id = isKeyRecord(record) ? `key ${record.key}` : `rid ${record.rid}`;
    const current = winners.get(id);
    if (current === undefined) {
      winners.set(id, record);
      continue;
    }
    let better: boolean;
    if (isKeyRecord(record) && (record.lc !== current.lc || record.author !== current.author)) {
      better = record.lc > current.lc || (record.lc === current.lc && record.author > current.author);
    } else {
      better = compareCanonical(record, current) < 0;
    }
    if (better) winners.set(id, record);
  }
  return [...winners.values()];
}

describe('shared-state: 병합의 수렴', () => {
  for (const seed of seedsForRun()) {
    it(`무작위 순서·중복·묶음 크기로 받아도 같은 복제본이 된다 (seed=${seed})`, (t) => {
      t.diagnostic(`seed=${seed} (다시 보려면 AGENT_CHAT_TEST_SEED=${seed})`);
      const rand = seededRandom(seed);
      const sim = simulate(rand, 260);
      const { pool } = sim;
      const kinds = new Set(pool.map((record) => record.kind));
      assert.deepEqual([...kinds].sort(), ['claim', 'presence', 'scenario', 'stop', 'test', 'verification'], `seed=${seed}: 여섯 종류가 모두 나와야 한다`);
      assert.ok(pool.length > 100, `seed=${seed}: 기록 ${pool.length}건`);

      const survivors = expectedSurvivors(pool);
      const expectedFingerprint = stateFingerprint(survivors);
      const expectedRecords = survivors.map((record) => canonicalJson(record)).sort();

      const signatures = new Set<string>();
      for (let trial = 0; trial < 8; trial += 1) {
        const zed = makePeer('zed', { generation: trial });
        // 30% 는 한 번 더, 그 가운데 일부는 두 번 더 넣는다.
        const stream = shuffled(rand, [...pool, ...pool.filter(() => rand() < 0.3), ...pool.filter(() => rand() < 0.1)]);
        const asChanges = trial % 4 === 3;
        for (let at = 0; at < stream.length; ) {
          const size = asChanges ? 1 : 1 + Math.floor(rand() * 40);
          const batch = stream.slice(at, at + size);
          at += size;
          const origin = asChanges ? { from: (batch[0] as StateRecord).author, snapshot: false } : { from: 'peer', snapshot: true };
          const merged = zed.replica.mergeRemote(batch, origin, T0 + trial);
          assert.equal(merged.overflow, false);
          assert.equal(merged.applied.length + merged.ignored, batch.length, `seed=${seed}: 반영한 수와 버린 수의 합이 받은 수다`);
        }
        assert.equal(zed.replica.fingerprint(), expectedFingerprint, `seed=${seed} trial=${trial}: 지문이 규칙에서 계산한 값과 같다`);
        assert.deepEqual(zed.replica.snapshot().map((record) => canonicalJson(record)).sort(), expectedRecords, `seed=${seed} trial=${trial}`);
        signatures.add(signature(zed.replica));

        // 멱등: 전부 한 번 더 받아도 바뀌지 않는다.
        const before = signature(zed.replica);
        const again = zed.replica.mergeRemote(shuffled(rand, pool), { from: 'peer', snapshot: true }, T0 + 99);
        assert.equal(again.applied.length, 0, `seed=${seed} trial=${trial}: 다시 받은 기록은 반영하지 않는다`);
        assert.deepEqual(again.changes, []);
        assert.equal(signature(zed.replica), before);

        const frames = packStateFrames(zed.replica.snapshot(), { snap: true });
        assert.ok(frames.ok, `seed=${seed}: 스냅샷이 packStateFrames 를 통과한다`);
        const received: StateRecord[] = [];
        for (const frame of frames.value) {
          const parsed = parseP2PFrame(frame);
          assert.ok(parsed.ok && parsed.value.t === 'state' && parsed.invalidRecords === 0);
          received.push(...parsed.value.records);
        }
        assert.equal(stateFingerprint(received), expectedFingerprint, `seed=${seed}: 프레임으로 건너가도 같은 지문이다`);
      }
      assert.equal(signatures.size, 1, `seed=${seed}: 여덟 번 모두 같은 기록·지문·판정이다`);

      // 표본이 규칙의 갈래를 실제로 지나갔는지 남긴다(동시 시작, 한도 초과, 중단 뒤 기록, 자기 검증, 내용 충돌).
      const probe = makePeer('zed', { generation: 99 });
      const whole = probe.replica.mergeRemote(pool, { from: 'peer', snapshot: true }, T0);
      const view = probe.replica.view(T0);
      const stats = {
        records: pool.length,
        survivors: survivors.length,
        tests: pool.filter((record) => record.kind === 'test').length,
        anomalies: whole.anomalies,
        scenarios: view.scenarios.length,
        overLimit: view.scenarios.filter((scenario) => scenario.over_limit).length,
        claims: view.claims.length,
        late: view.claims.filter((claim) => claim.late).length,
        uncounted: view.claims.flatMap((claim) => claim.verifications).filter((verification) => !verification.counted).length,
        classes: [...new Set(view.claims.map((claim) => claim.classification))].sort().join('/'),
        refusals: [...sim.refusals.entries()].map(([code, count]) => `${code}:${count}`).sort().join(' '),
      };
      t.diagnostic(`seed=${seed} ${JSON.stringify(stats)}`);
      assert.ok(stats.tests >= 2, `seed=${seed}: 동시에 시작한 테스트가 있어야 한다`);
      assert.ok(stats.anomalies >= 1, `seed=${seed}: 내용이 다른 같은 식별자의 기록이 있어야 한다`);
      assert.ok(view.test?.stopped !== null && view.test?.stopped !== undefined, `seed=${seed}: 중단이 있어야 한다`);

      // 방에 있던 참가자들도 서로 교환하고 위조 기록을 받으면 같은 복제본이 된다.
      for (const peer of sim.peers) peer.replica.mergeRemote(shuffled(rand, pool), { from: 'peer', snapshot: true }, T0);
      for (const peer of sim.peers) {
        assert.equal(signature(peer.replica), [...signatures][0], `seed=${seed}: ${peer.name} 의 복제본도 같다`);
      }
    });
  }

  it('교환·결합·멱등: 세 묶음을 어떤 순서와 묶음으로 받아도 같다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const x = [...startTest(alice, T0).records, ...apply(alice, { type: 'set_presence', patch: { role: '강사' } }, T0 + 1).records];
    sendChange(alice, bob, x, T0 + 2);
    const scenario = startScenario(bob, T0 + 3);
    const claim = recordClaim(bob, scenario.scenarioId, T0 + 4);
    const y = [...scenario.records, ...claim.records];
    sendChange(bob, alice, y, T0 + 5);
    const z = [...recordVerification(alice, claim.claimId, T0 + 6).records, ...apply(alice, { type: 'stop_test', reason: 'user', detail: '' }, T0 + 7).records];

    const orders: StateRecord[][][] = [
      [x, y, z],
      [z, y, x],
      [y, z, x],
      [[...y, ...z], x],
      [z, [...x, ...y]],
      [[...z, ...y, ...x]],
      [x, x, y, y, z, z, x],
    ];
    const results = orders.map((batches, i) => {
      const zed = makePeer('zed', { generation: i });
      for (const batch of batches) zed.replica.mergeRemote(batch, { from: 'peer', snapshot: true }, T0 + 10);
      return signature(zed.replica);
    });
    assert.equal(new Set(results).size, 1);
    assert.equal(results[0], signature(alice.replica), '기록을 쓴 쪽과도 같다');
  });
});

describe('shared-state: 받을 때의 검증', () => {
  it('변경의 author 가 링크의 피어와 다르면 버리고 이상으로 센다. 스냅샷은 받는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const made = startTest(alice, T0).records;

    const viaBob = carol.replica.mergeRemote(made, { from: 'bob', snapshot: false }, T0 + 1);
    assert.deepEqual(
      { applied: viaBob.applied.length, ignored: viaBob.ignored, anomalies: viaBob.anomalies, changes: viaBob.changes.length, overflow: viaBob.overflow },
      { applied: 0, ignored: 1, anomalies: 1, changes: 0, overflow: false },
    );
    assert.equal(carol.replica.snapshot().length, 0);

    // 스냅샷에는 남이 쓴 기록이 들어 있다. 떠난 참가자의 기록까지 전하려면 필요하다.
    sendChange(alice, bob, made, T0 + 1);
    const snap = sendSnapshot(bob, carol, T0 + 2);
    assert.deepEqual({ applied: snap.applied.length, ignored: snap.ignored, anomalies: snap.anomalies }, { applied: 1, ignored: 0, anomalies: 0 });
    assert.deepEqual(changeTypes(snap.changes), ['test_started']);
  });

  it('스키마에 걸리는 기록은 버린다(남의 presence, 큰 글자 필드, 모르는 종류)', () => {
    const carol = makePeer('carol');
    const body = { client: 'x', tools: [], role: '강사', status: 'ready', listening: true, note: null };
    const bad = [
      // 남의 역할을 대신 쓸 수 없다. 키와 작성자가 맞아야 한다.
      { kind: 'presence', key: 'presence/alice', author: 'bob', lc: T0, wall: T0, body },
      { kind: 'scenario', rid: `${OTHER_SID}-1`, author: 'bob', lc: T0, wall: T0, body: { test_id: `${OTHER_SID}-9`, title: 'a'.repeat(4097), plan: null } },
      { kind: 'note', rid: `${OTHER_SID}-2`, author: 'bob', lc: T0, wall: T0, body: {} },
      { kind: 'stop', rid: `${OTHER_SID}-3`, author: 'bob', lc: 2 ** 53, wall: T0, body: { test_id: `${OTHER_SID}-9`, reason: 'user', detail: '' } },
    ] as unknown as StateRecord[];
    const good: StateRecord = { kind: 'presence', key: 'presence/bob', author: 'bob', lc: T0, wall: T0, body: { ...body, status: 'ready' } };

    for (const snapshot of [true, false]) {
      const peer = makePeer('carol', { generation: snapshot ? 1 : 2 });
      const merged = peer.replica.mergeRemote([...bad, good], { from: 'bob', snapshot }, T0 + 1);
      assert.equal(merged.applied.length, 1);
      assert.equal(merged.ignored, 4);
      assert.equal(merged.anomalies, 4);
      assert.deepEqual(peer.replica.snapshot(), [good]);
      assert.ok(packStateFrames(peer.replica.snapshot(), { snap: true }).ok, '걸리는 기록이 스냅샷에 섞이지 않는다');
      assert.deepEqual(peer.replica.view(T0).presences.map((p) => p.peer), ['bob']);
    }
    void carol;
  });

  it('모르는 필드는 버린 뒤에 넣는다. 지문과 내용 비교가 그 필드에 흔들리지 않는다', () => {
    const carol = makePeer('carol');
    const clean: StateRecord = { kind: 'stop', rid: `${OTHER_SID}-1`, author: 'bob', lc: T0, wall: T0, body: { test_id: `${OTHER_SID}-9`, reason: 'user', detail: '' } };
    const noisy = { ...clean, extra: 'x', body: { ...clean.body, more: 1 } } as unknown as StateRecord;
    const first = carol.replica.mergeRemote([noisy], { from: 'bob', snapshot: false }, T0);
    assert.deepEqual(first.applied, [clean]);
    const second = carol.replica.mergeRemote([clean], { from: 'bob', snapshot: false }, T0);
    assert.deepEqual({ applied: second.applied.length, ignored: second.ignored, anomalies: second.anomalies }, { applied: 0, ignored: 1, anomalies: 0 });
  });

  it('받은 기록 객체를 나중에 고쳐도 복제본은 바뀌지 않는다', () => {
    const carol = makePeer('carol');
    const record: StateRecord = { kind: 'stop', rid: `${OTHER_SID}-1`, author: 'bob', lc: T0, wall: T0, body: { test_id: `${OTHER_SID}-9`, reason: 'user', detail: '원래' } };
    carol.replica.mergeRemote([record], { from: 'bob', snapshot: false }, T0);
    const fingerprint = carol.replica.fingerprint();
    record.body.detail = '고침';
    record.lc += 1;
    const held = carol.replica.snapshot()[0];
    assert.equal(held?.kind === 'stop' ? held.body.detail : '', '원래');
    assert.equal(held?.lc, T0);
    assert.equal(carol.replica.fingerprint(), fingerprint);
  });
});

describe('shared-state: 병합 상한 (STATE_MERGE_MAX_RECORDS)', () => {
  const filler = (from: number, count: number): StateRecord[] =>
    Array.from({ length: count }, (_, i) => ({
      kind: 'stop' as const,
      rid: `${OTHER_SID}-${(from + i).toString(36)}`,
      author: 'zed',
      lc: T0 + from + i,
      wall: T0,
      body: { test_id: `${OTHER_SID}-zz`, reason: 'user' as const, detail: '' },
    }));

  it('로컬 쓰기 상한(2000건)을 넘는 기록도 병합은 받는다', () => {
    const carol = makePeer('carol');
    const merged = carol.replica.mergeRemote(filler(0, LIMITS.STATE_MAX_RECORDS + 500), { from: 'zed', snapshot: true }, T0);
    assert.equal(merged.applied.length, LIMITS.STATE_MAX_RECORDS + 500);
    assert.equal(merged.overflow, false);
  });

  it('넘게 되는 묶음은 하나도 넣지 않고 overflow 를 알린다. 꼭 맞는 묶음과 이미 있는 기록은 받는다', () => {
    const carol = makePeer('carol');
    const presence = (lc: number): StateRecord => ({
      kind: 'presence',
      key: 'presence/zed',
      author: 'zed',
      lc,
      wall: T0,
      body: { client: 'x', tools: [], role: null, status: 'joined', listening: false, note: null },
    });
    carol.replica.mergeRemote([presence(T0), ...filler(0, LIMITS.STATE_MERGE_MAX_RECORDS - 7)], { from: 'zed', snapshot: true }, T0);
    assert.equal(carol.replica.snapshot().length, LIMITS.STATE_MERGE_MAX_RECORDS - 6);
    const before = signature(carol.replica);

    const tooMany = carol.replica.mergeRemote(filler(10_000, 7), { from: 'zed', snapshot: true }, T0 + 1);
    assert.deepEqual(
      { applied: tooMany.applied.length, ignored: tooMany.ignored, changes: tooMany.changes.length, overflow: tooMany.overflow },
      { applied: 0, ignored: 7, changes: 0, overflow: true },
    );
    assert.ok(tooMany.anomalies >= 1);
    assert.equal(signature(carol.replica), before, '묶음의 기록을 하나도 넣지 않는다');

    // 이미 있는 기록과 같은 묶음 안의 중복은 수를 늘리지 않는다.
    const fits = carol.replica.mergeRemote([...filler(0, 50), ...filler(10_000, 6), ...filler(10_000, 6)], { from: 'zed', snapshot: true }, T0 + 2);
    assert.equal(fits.overflow, false);
    assert.equal(fits.applied.length, 6);
    assert.equal(carol.replica.snapshot().length, LIMITS.STATE_MERGE_MAX_RECORDS);

    const one = carol.replica.mergeRemote(filler(20_000, 1), { from: 'zed', snapshot: false }, T0 + 3);
    assert.equal(one.overflow, true);
    assert.equal(carol.replica.snapshot().length, LIMITS.STATE_MERGE_MAX_RECORDS);

    // 키 기록의 갱신은 수를 늘리지 않는다. 꽉 찬 복제본에서도 presence 는 바뀐다.
    const updated = carol.replica.mergeRemote([presence(T0 + 50_000)], { from: 'zed', snapshot: false }, T0 + 4);
    assert.equal(updated.overflow, false);
    assert.equal(updated.applied.length, 1);
    assert.equal(carol.replica.snapshot().length, LIMITS.STATE_MERGE_MAX_RECORDS);
  });
});

describe('shared-state: 병합이 내는 도메인 변화', () => {
  it('입장자가 스냅샷을 받으면 기록이 쓰인 순서대로 변화가 나온다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    apply(alice, { type: 'set_presence', patch: { role: '강사', status: 'ready' } }, T0);
    startTest(alice, T0 + 1, { scenarios: 2 });
    const scenario = startScenario(alice, T0 + 2);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 3);
    sendSnapshot(alice, bob, T0 + 4);
    recordVerification(bob, claim.claimId, T0 + 5, 'unable');
    recordVerification(bob, claim.claimId, T0 + 6, 'confirmed');
    apply(bob, { type: 'stop_test', reason: 'user', detail: '끝' }, T0 + 7);
    exchange(alice, bob, T0 + 8);

    // 순서를 뒤집어 줘도 변화의 순서는 같다.
    for (const records of [alice.replica.snapshot(), [...alice.replica.snapshot()].reverse()]) {
      const carol = makePeer('carol');
      const merged = carol.replica.mergeRemote(records, { from: 'alice', snapshot: true }, T0 + 9);
      assert.deepEqual(changeTypes(merged.changes), [
        'presence_changed',
        'test_started',
        'scenario_started',
        'claim_added',
        'verification_added',
        'verification_added',
        'test_stopped',
      ]);
      const statuses = merged.changes.flatMap((change) => (change.type === 'verification_added' ? [change.claim_status] : []));
      assert.deepEqual(statuses, ['unverified', 'confirmed'], '검증마다 그것을 반영한 뒤의 상태를 싣는다');
      const started = merged.changes[1];
      assert.ok(started?.type === 'test_started');
      assert.equal(started.test.elapsed_ms, 0, '처음 안 순간부터 0 에서 센다');
      assert.equal(started.test.by, 'alice');
      const claimAdded = merged.changes[3];
      assert.ok(claimAdded?.type === 'claim_added');
      assert.equal(claimAdded.claim.status, 'confirmed', '주장은 묶음을 다 반영한 뒤의 모습이다');
    }
  });

  it('여러 프레임으로 나뉘어 test 기록보다 먼저 온 기록은 test 가 올 때 변화가 된다', () => {
    const alice = makePeer('alice');
    const started = startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 2);

    const carol = makePeer('carol');
    const early = carol.replica.mergeRemote([...claim.records, ...scenario.records], { from: 'alice', snapshot: true }, T0 + 3);
    assert.equal(early.applied.length, 2);
    assert.deepEqual(early.changes, [], '현재 테스트가 아닌 test_id 의 기록은 변화를 만들지 않는다');
    assert.deepEqual(carol.replica.view(T0 + 3).scenarios, []);
    const late = carol.replica.mergeRemote(started.records, { from: 'alice', snapshot: true }, T0 + 4);
    assert.deepEqual(changeTypes(late.changes), ['test_started', 'scenario_started', 'claim_added']);
  });

  it('검증이 주장보다 먼저 와도 주장이 올 때 함께 반영된다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const started = startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 2);
    sendSnapshot(alice, bob, T0 + 3);
    const verification = recordVerification(bob, claim.claimId, T0 + 4);

    const carol = makePeer('carol');
    carol.replica.mergeRemote([...started.records, ...scenario.records], { from: 'alice', snapshot: true }, T0 + 5);
    const orphan = sendChange(bob, carol, verification.records, T0 + 6);
    assert.equal(orphan.applied.length, 1);
    assert.deepEqual(orphan.changes, []);
    const joined = sendChange(alice, carol, claim.records, T0 + 7);
    assert.deepEqual(changeTypes(joined.changes), ['claim_added', 'verification_added']);
    assert.equal(carol.replica.view(T0 + 8).claims[0]?.classification, 'passed');
  });

  it('이미 중단된 뒤에 온 다른 stop 은 변화를 만들지 않는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const started = startTest(alice, T0);
    sendChange(alice, bob, started.records, T0);
    sendChange(alice, carol, started.records, T0);
    // 서로 못 본 채 둘 다 중단했다.
    const byAlice = apply(alice, { type: 'stop_test', reason: 'user', detail: 'alice' }, T0 + 10);
    const byBob = apply(bob, { type: 'stop_test', reason: 'time_limit', detail: '' }, T0 + 5);

    const first = sendChange(alice, carol, byAlice.records, T0 + 11);
    assert.deepEqual(changeTypes(first.changes), ['test_stopped']);
    const second = sendChange(bob, carol, byBob.records, T0 + 12);
    assert.equal(second.applied.length, 1, '기록은 남는다');
    assert.deepEqual(second.changes, [], '중단됨은 테스트마다 한 번이다');
    // 중단 시점은 (lc, author, rid) 가 가장 작은 stop 이다. 받은 순서와 무관하다.
    assert.equal(carol.replica.view(T0 + 13).test?.stopped?.by, 'bob');
    assert.equal(carol.replica.view(T0 + 13).test?.stopped?.reason, 'time_limit');
    const again = sendChange(alice, bob, byAlice.records, T0 + 14);
    assert.deepEqual(again.changes, []);
  });

  it('presence 는 더 새 값만 반영하고 앞뒤 값을 함께 알린다', () => {
    const alice = makePeer('alice');
    const carol = makePeer('carol');
    const first = apply(alice, { type: 'set_presence', patch: { role: '강사' } }, T0);
    const second = apply(alice, { type: 'set_presence', patch: { role: '수강생' } }, T0 + 1);

    const newer = sendChange(alice, carol, second.records, T0 + 2);
    assert.deepEqual(newer.changes, [{ type: 'presence_changed', peer: 'alice', previous: null, current: second.record.body }]);
    const older = sendChange(alice, carol, first.records, T0 + 3);
    assert.deepEqual({ applied: older.applied.length, ignored: older.ignored, anomalies: older.anomalies, changes: older.changes }, { applied: 0, ignored: 1, anomalies: 0, changes: [] });

    // 한 묶음에 같은 이름이 두 번이면 변화는 묶음 전의 값에서 마지막 값으로 한 번이다.
    const third = apply(alice, { type: 'set_presence', patch: { status: 'ready' } }, T0 + 4);
    const fourth = apply(alice, { type: 'set_presence', patch: { status: 'working' } }, T0 + 5);
    const both = sendChange(alice, carol, [...third.records, ...fourth.records], T0 + 6);
    assert.equal(both.applied.length, 2);
    assert.deepEqual(both.changes, [{ type: 'presence_changed', peer: 'alice', previous: second.record.body, current: fourth.record.body }]);
    assert.equal(recordIdentity(carol.replica.snapshot()[0] as StateRecord), recordIdentity(fourth.record));
  });
});
