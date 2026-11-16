// V-U3: 로컬 명령의 규칙 판정, 상한, 논리 시각의 끝, 만든 기록의 검증, 도메인 변화.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, STATE_CLOCK_MAX, packStateFrames, parseStateRecord, recordByteSize, stateFingerprint } from '../protocol/index.js';
import type { StateRecord } from '../protocol/index.js';
import { createReplica } from './index.js';
import {
  MIN,
  T0,
  apply,
  changeTypes,
  exchange,
  makePeer,
  recordClaim,
  recordVerification,
  refuse,
  sendChange,
  sendSnapshot,
  sidOf,
  startScenario,
  startTest,
} from './testing.js';

const OTHER_SID = 'zzzzzzzzzzzz';

function foreignScenario(n: number, testId: string, author = 'zed'): StateRecord {
  return {
    kind: 'scenario',
    rid: `${OTHER_SID}-${n.toString(36)}`,
    author,
    lc: T0 + n,
    wall: T0 + n,
    body: { test_id: testId, title: `s${n}`, plan: null },
  };
}

describe('shared-state: 로컬 명령과 기록', () => {
  it('index.ts 가 createReplica 를 내보내고 빈 복제본으로 시작한다', () => {
    const replica = createReplica({ self: { peer: 'alice', sid: sidOf('alice') }, selfNames: ['alice'] });
    assert.deepEqual(replica.snapshot(), []);
    assert.equal(replica.fingerprint(), stateFingerprint([]));
    assert.deepEqual(replica.view(T0), { presences: [], test: null, scenarios: [], claims: [] });
    assert.equal(replica.testElapsed(T0), null);
  });

  it('기록의 author 는 이름, ID 는 <sid>-<순번>, lc 는 max(본 값 + 1, 벽시계) 다', () => {
    const alice = makePeer('alice');
    const first = apply(alice, { type: 'set_presence', patch: { status: 'ready' } }, T0).record;
    assert.equal(first.author, 'alice');
    assert.equal(first.lc, T0);
    assert.equal(first.wall, T0);

    // 벽시계가 뒤로 가도 본 뒤에 쓴 기록은 더 크다.
    const second = apply(alice, { type: 'set_presence', patch: { status: 'working' } }, T0 - 5_000).record;
    assert.equal(second.lc, T0 + 1);
    assert.equal(second.wall, T0 - 5_000);

    const test = startTest(alice, T0 - 4_000);
    assert.equal(test.testId, `${alice.sid}-1`);
    assert.equal(test.record.lc, T0 + 2);
    const scenario = startScenario(alice, T0 + 10_000);
    assert.equal(scenario.scenarioId, `${alice.sid}-2`);
    assert.equal(scenario.record.lc, T0 + 10_000);
  });

  it('다른 참가자의 더 큰 lc 를 본 뒤에 쓰면 그 값보다 크다', () => {
    const alice = makePeer('alice');
    const fast = makePeer('fast');
    const ahead = apply(fast, { type: 'set_presence', patch: {} }, T0 + 70 * MIN);
    sendChange(fast, alice, ahead.records, T0);
    const mine = apply(alice, { type: 'set_presence', patch: {} }, T0).record;
    assert.equal(mine.lc, T0 + 70 * MIN + 1);
  });

  it('set_presence 는 준 필드만 바꾸고, 처음에는 빠진 필드를 기본값으로 채운다', () => {
    const alice = makePeer('alice');
    const first = apply(alice, { type: 'set_presence', patch: { role: '강사' } }, T0);
    assert.deepEqual(first.record.body, { client: 'unknown', tools: [], role: '강사', status: 'joined', listening: false, note: null });
    assert.deepEqual(first.changes, [
      { type: 'presence_changed', peer: 'alice', previous: null, current: first.record.body },
    ]);

    const second = apply(alice, { type: 'set_presence', patch: { client: 'claude-code', tools: ['browser'], status: 'ready', listening: true } }, T0 + 1);
    assert.deepEqual(second.record.body, { client: 'claude-code', tools: ['browser'], role: '강사', status: 'ready', listening: true, note: null });
    assert.deepEqual(second.changes, [
      { type: 'presence_changed', peer: 'alice', previous: first.record.body, current: second.record.body },
    ]);

    const third = apply(alice, { type: 'set_presence', patch: { role: null, note: '잠시 자리 비움' } }, T0 + 2);
    assert.equal(third.record.body && 'role' in third.record.body ? third.record.body.role : 'x', null);
    assert.equal(alice.replica.snapshot().length, 1, 'presence 는 이름마다 하나만 남는다');
    assert.deepEqual(alice.replica.view(T0).presences.map((p) => [p.peer, p.role, p.note, p.status]), [['alice', null, '잠시 자리 비움', 'ready']]);
  });

  it('start_test: 기록이 있으면 거절한다(진행 중 TEST_ALREADY_ACTIVE, 중단 뒤 TEST_ENDED)', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const started = startTest(alice, T0, { minutes: 30, scenarios: 3 });
    assert.deepEqual(changeTypes(started.changes), ['test_started']);
    sendChange(alice, bob, started.records, T0);

    const again = { type: 'start_test', request: '다시', max_duration_min: 480, max_scenarios: 100 } as const;
    assert.equal(refuse(alice, again, T0 + 1), 'TEST_ALREADY_ACTIVE');
    assert.equal(refuse(bob, again, T0 + 1), 'TEST_ALREADY_ACTIVE', '받은 쪽도 시작할 수 없다');

    const stopped = apply(bob, { type: 'stop_test', reason: 'user', detail: '사용자가 멈추라고 했다' }, T0 + 2);
    assert.deepEqual(changeTypes(stopped.changes), ['test_stopped']);
    sendChange(bob, alice, stopped.records, T0 + 2);
    assert.equal(refuse(alice, again, T0 + 3), 'TEST_ENDED');
    assert.equal(refuse(bob, again, T0 + 3), 'TEST_ENDED');

    const view = alice.replica.view(T0 + 3).test;
    assert.equal(view?.max_duration_min, 30, '제한은 처음 값 그대로다');
    assert.equal(view?.stopped?.by, 'bob');
    assert.equal(view?.stopped?.detail, '사용자가 멈추라고 했다');
  });

  it('stop_test: 테스트가 없으면 NO_ACTIVE_TEST, 이미 중단됐으면 기록 없이 성공한다', () => {
    const alice = makePeer('alice');
    assert.equal(refuse(alice, { type: 'stop_test', reason: 'user', detail: '' }, T0), 'NO_ACTIVE_TEST');
    startTest(alice, T0);
    apply(alice, { type: 'stop_test', reason: 'time_limit', detail: '' }, T0 + 1);
    const count = alice.replica.snapshot().length;
    const again = alice.replica.applyLocal({ type: 'stop_test', reason: 'user', detail: '한 번 더' }, T0 + 2);
    assert.deepEqual(again, { ok: true, records: [], changes: [] });
    assert.equal(alice.replica.snapshot().length, count);
    assert.equal(alice.replica.view(T0 + 2).test?.stopped?.reason, 'time_limit');
  });

  it('start_scenario: 관문의 거절 다섯 가지', () => {
    const alice = makePeer('alice');
    const scenario = { type: 'start_scenario', title: '손들기' } as const;
    assert.equal(refuse(alice, scenario, T0), 'NO_ACTIVE_TEST');

    startTest(alice, T0, { minutes: 1, scenarios: 2 });
    const first = startScenario(alice, T0 + 1);
    assert.deepEqual(changeTypes(first.changes), ['scenario_started']);
    assert.equal(first.changes[0]?.type === 'scenario_started' ? first.changes[0].scenario.index : 0, 1);
    startScenario(alice, T0 + 2);
    assert.equal(refuse(alice, scenario, T0 + 3), 'SCENARIO_LIMIT_REACHED');
    assert.equal(alice.replica.view(T0 + 3).test?.scenarios_used, 2);

    // 기한이 한도보다 먼저다. 닿은 순간(경과 = 제한)부터 거절한다.
    assert.equal(refuse(alice, scenario, T0 + MIN), 'TIME_LIMIT_REACHED');
    assert.equal(alice.replica.view(T0 + MIN).test?.stopped, null, 'TIME_LIMIT_REACHED 는 stop 을 쓰지 않는다. 부르는 쪽이 이어서 쓴다');
    apply(alice, { type: 'stop_test', reason: 'time_limit', detail: '' }, T0 + MIN);
    assert.equal(refuse(alice, scenario, T0 + MIN + 1), 'TEST_STOPPED');
  });

  it('start_scenario: 기한 직전까지는 받는다', () => {
    const alice = makePeer('alice');
    startTest(alice, T0, { minutes: 1 });
    startScenario(alice, T0 + MIN - 1);
    assert.equal(refuse(alice, { type: 'start_scenario', title: 'x' }, T0 + MIN), 'TIME_LIMIT_REACHED');
  });

  it('record_claim: 없는 시나리오, 다른 테스트의 시나리오, 테스트 없음', () => {
    const alice = makePeer('alice');
    const claim = { type: 'record_claim', scenario_id: `${OTHER_SID}-1`, action: 'a', observed: 'o', outcome: 'pass', steps: 's' } as const;
    assert.equal(refuse(alice, claim, T0), 'NO_ACTIVE_TEST');
    const { testId } = startTest(alice, T0);
    assert.equal(refuse(alice, claim, T0 + 1), 'UNKNOWN_SCENARIO');

    // 현재 테스트가 아닌 test_id 의 시나리오는 복제본에 있어도 현재 테스트의 시나리오가 아니다.
    alice.replica.mergeRemote([foreignScenario(1, `${OTHER_SID}-9`)], { from: 'zed', snapshot: true }, T0 + 2);
    assert.equal(refuse(alice, claim, T0 + 3), 'UNKNOWN_SCENARIO');

    alice.replica.mergeRemote([foreignScenario(2, testId)], { from: 'zed', snapshot: true }, T0 + 4);
    const made = apply(alice, { ...claim, scenario_id: `${OTHER_SID}-2`, expected: '손 표시' }, T0 + 5);
    assert.deepEqual(changeTypes(made.changes), ['claim_added']);
    const added = made.changes[0];
    assert.ok(added?.type === 'claim_added');
    assert.equal(added.claim.status, 'unverified');
    assert.equal(added.claim.classification, 'unverified');
    assert.equal(added.claim.expected, '손 표시');
    assert.equal(added.claim.late, false);
  });

  it('record_verification: 없는 주장은 UNKNOWN_CLAIM, 자기 주장은 SELF_VERIFY_FORBIDDEN', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const verify = { type: 'record_verification', claim_id: `${OTHER_SID}-1`, result: 'confirmed', evidence: 'e' } as const;
    assert.equal(refuse(bob, verify, T0), 'UNKNOWN_CLAIM', '테스트가 없으면 주장도 없다');

    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 2);
    sendSnapshot(alice, bob, T0 + 3);
    assert.equal(refuse(bob, verify, T0 + 4), 'UNKNOWN_CLAIM');
    assert.equal(refuse(alice, { ...verify, claim_id: claim.claimId }, T0 + 4), 'SELF_VERIFY_FORBIDDEN');

    const verified = recordVerification(bob, claim.claimId, T0 + 5);
    assert.deepEqual(changeTypes(verified.changes), ['verification_added']);
    const change = verified.changes[0];
    assert.ok(change?.type === 'verification_added');
    assert.equal(change.claim_id, claim.claimId);
    assert.equal(change.claim_by, 'alice');
    assert.equal(change.claim_status, 'confirmed');
    assert.equal(change.verification.counted, true);
  });

  it('자기 검증 거절은 이 프로세스가 이 방에서 쓴 이름 전부에 건다(이전 이름 포함)', () => {
    const alice = makePeer('alice');
    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 2);

    // 같은 프로세스가 나갔다가 다른 이름으로 들어왔다. 예전 이름을 기억한다.
    const renamed = makePeer('alice2', { selfNames: ['alice', 'alice2'] });
    sendSnapshot(alice, renamed, T0 + 3);
    assert.equal(
      refuse(renamed, { type: 'record_verification', claim_id: claim.claimId, result: 'confirmed', evidence: 'e' }, T0 + 4),
      'SELF_VERIFY_FORBIDDEN',
    );

    // selfNames 에 지금 이름이 빠져 있어도 지금 이름의 주장은 검증할 수 없다.
    const careless = makePeer('alice', { generation: 1, selfNames: [] });
    sendSnapshot(alice, careless, T0 + 3);
    assert.equal(
      refuse(careless, { type: 'record_verification', claim_id: claim.claimId, result: 'confirmed', evidence: 'e' }, T0 + 4),
      'SELF_VERIFY_FORBIDDEN',
    );

    // 이름을 기억하지 못하는 다른 프로세스는 막지 못한다(설계의 한계). 다른 참가자의 검증은 받는다.
    const bob = makePeer('bob');
    sendSnapshot(alice, bob, T0 + 3);
    recordVerification(bob, claim.claimId, T0 + 4);
  });

  it('병합으로 들어온 자기 검증은 저장하되 판정에서 뺀다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const { testId } = startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 2);
    sendSnapshot(alice, bob, T0 + 3);

    const selfVerification: StateRecord = {
      kind: 'verification',
      rid: `${alice.sid}-zz`,
      author: 'alice',
      lc: T0 + 10,
      wall: T0 + 10,
      body: { test_id: testId, claim: claim.claimId, result: 'confirmed', evidence: '내가 봤다' },
    };
    for (const [peer, origin] of [
      [bob, { from: 'alice', snapshot: false }],
      [alice, { from: 'bob', snapshot: true }],
    ] as const) {
      const merged = peer.replica.mergeRemote([selfVerification], origin, T0 + 11);
      assert.equal(merged.applied.length, 1, '저장은 한다');
      const change = merged.changes[0];
      assert.ok(change?.type === 'verification_added');
      assert.equal(change.verification.counted, false);
      assert.equal(change.claim_status, 'unverified');
      const view = peer.replica.view(T0 + 12).claims[0];
      assert.equal(view?.status, 'unverified');
      assert.equal(view?.classification, 'unverified');
      assert.deepEqual(view?.verifications.map((v) => [v.by, v.counted]), [['alice', false]]);
    }

    // 다른 참가자의 확인이 있어야 성공이다. 자기 검증이 섞여 있어도 결과는 그 확인으로 정해진다.
    const real = recordVerification(bob, claim.claimId, T0 + 20);
    sendChange(bob, alice, real.records, T0 + 21);
    for (const peer of [alice, bob]) {
      const view = peer.replica.view(T0 + 22).claims[0];
      assert.equal(view?.status, 'confirmed');
      assert.equal(view?.classification, 'passed');
      assert.deepEqual(view?.verifications.map((v) => [v.by, v.counted]), [['alice', false], ['bob', true]]);
    }
  });

  it('보고 분류: 성공, 확인된 실패, 반박된 성공, 미확인, unable, 반박된 실패 주장', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const pass = recordClaim(alice, scenario.scenarioId, T0 + 2, 'pass');
    const fail = recordClaim(alice, scenario.scenarioId, T0 + 3, 'fail');
    const refutedPass = recordClaim(alice, scenario.scenarioId, T0 + 4, 'pass');
    const none = recordClaim(alice, scenario.scenarioId, T0 + 5, 'pass');
    const unable = recordClaim(alice, scenario.scenarioId, T0 + 6, 'pass');
    const refutedFail = recordClaim(alice, scenario.scenarioId, T0 + 7, 'fail');
    sendSnapshot(alice, bob, T0 + 8);
    recordVerification(bob, pass.claimId, T0 + 10, 'confirmed');
    recordVerification(bob, fail.claimId, T0 + 11, 'confirmed');
    recordVerification(bob, refutedPass.claimId, T0 + 12, 'refuted');
    recordVerification(bob, unable.claimId, T0 + 13, 'unable');
    recordVerification(bob, refutedFail.claimId, T0 + 14, 'refuted');
    exchange(alice, bob, T0 + 15);

    for (const peer of [alice, bob]) {
      const byId = new Map(peer.replica.view(T0 + 16).claims.map((c) => [c.claim_id, c]));
      const row = (id: string) => [byId.get(id)?.status, byId.get(id)?.classification];
      assert.deepEqual(row(pass.claimId), ['confirmed', 'passed']);
      assert.deepEqual(row(fail.claimId), ['confirmed', 'failed']);
      assert.deepEqual(row(refutedPass.claimId), ['refuted', 'failed']);
      assert.deepEqual(row(none.claimId), ['unverified', 'unverified']);
      assert.deepEqual(row(unable.claimId), ['unverified', 'unverified']);
      assert.deepEqual(row(refutedFail.claimId), ['refuted', 'unverified']);
    }
  });

  it('만든 기록과 snapshot() 은 parseStateRecord 와 packStateFrames 를 통과한다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const made: StateRecord[] = [];
    made.push(...apply(alice, { type: 'set_presence', patch: { client: 'claude-code', tools: ['browser', 'shell'], status: 'ready' } }, T0).records);
    made.push(...startTest(alice, T0 + 1).records);
    const scenario = apply(alice, { type: 'start_scenario', title: '손들기', plan: '강사가 본다', actor: 'alice', verifier: 'bob' }, T0 + 2);
    made.push(...scenario.records);
    const claim = recordClaim(alice, scenario.record.kind === 'scenario' ? scenario.record.rid : '', T0 + 3);
    made.push(...claim.records);
    sendSnapshot(alice, bob, T0 + 4);
    made.push(...recordVerification(bob, claim.claimId, T0 + 5).records);
    made.push(...apply(bob, { type: 'stop_test', reason: 'user', detail: '끝' }, T0 + 6).records);
    sendSnapshot(bob, alice, T0 + 7);

    assert.deepEqual(made.map((record) => record.kind), ['presence', 'test', 'scenario', 'claim', 'verification', 'stop']);
    for (const record of made) {
      const parsed = parseStateRecord(record);
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.value, record, '검증을 통과한 값 그대로다');
      assert.ok(Object.isFrozen(record) && Object.isFrozen(record.body), '돌려준 기록은 고칠 수 없다');
    }
    assert.ok(packStateFrames(made, { snap: false }).ok);
    for (const peer of [alice, bob]) {
      const packed = packStateFrames(peer.replica.snapshot(), { snap: true });
      assert.ok(packed.ok);
      assert.equal(peer.replica.snapshot().length, 6);
      assert.equal(peer.replica.fingerprint(), stateFingerprint(peer.replica.snapshot()));
      assert.throws(() => (peer.replica.snapshot() as StateRecord[]).push(made[0] as StateRecord), TypeError, '스냅샷 배열은 고칠 수 없다');
    }
    assert.equal(alice.replica.fingerprint(), bob.replica.fingerprint());
  });

  it('INVALID_ARGUMENT: 글자 필드 4096바이트 초과, 기록 32768바이트 초과, 이름 형식, 시각', () => {
    const alice = makePeer('alice');
    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const big = 'a'.repeat(LIMITS.STATE_TEXT_FIELD_MAX_BYTES + 1);
    const full = 'a'.repeat(LIMITS.STATE_TEXT_FIELD_MAX_BYTES);

    assert.equal(refuse(alice, { type: 'start_scenario', title: big }, T0 + 2), 'INVALID_ARGUMENT');
    // 한글은 글자당 3바이트다. 글자 수가 아니라 바이트로 센다.
    assert.equal(refuse(alice, { type: 'start_scenario', title: '가'.repeat(1366) }, T0 + 2), 'INVALID_ARGUMENT');
    apply(alice, { type: 'start_scenario', title: '가'.repeat(1365) }, T0 + 2);
    assert.equal(refuse(alice, { type: 'record_claim', scenario_id: scenario.scenarioId, action: 'a', observed: big, outcome: 'pass', steps: 's' }, T0 + 3), 'INVALID_ARGUMENT');
    apply(alice, { type: 'record_claim', scenario_id: scenario.scenarioId, action: full, expected: full, observed: full, outcome: 'pass', steps: full }, T0 + 3);

    // 글자 필드는 모두 상한 안이지만 기록 전체가 32768바이트를 넘는다.
    const tooManyTools = Array.from({ length: 9 }, () => full);
    const rejected = alice.replica.applyLocal({ type: 'set_presence', patch: { tools: tooManyTools } }, T0 + 4);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? '' : rejected.code, 'INVALID_ARGUMENT');
    assert.match(rejected.ok ? '' : rejected.detail, /32768/);

    assert.equal(refuse(alice, { type: 'start_scenario', title: 't', actor: '../etc' }, T0 + 5), 'INVALID_ARGUMENT');
    assert.equal(refuse(alice, { type: 'start_scenario', title: 't', verifier: 'room' }, T0 + 5), 'INVALID_ARGUMENT', '예약 이름');
    assert.equal(refuse(alice, { type: 'set_presence', patch: {} }, Number.NaN), 'INVALID_ARGUMENT');
    assert.equal(refuse(alice, { type: 'set_presence', patch: {} }, -1), 'INVALID_ARGUMENT');

    const bad = makePeer('bob');
    assert.equal(refuse(bad, { type: 'start_test', request: 'r', max_duration_min: 0, max_scenarios: 1 }, T0), 'INVALID_ARGUMENT');
    assert.equal(refuse(bad, { type: 'start_test', request: 'r', max_duration_min: 1.5, max_scenarios: 1 }, T0), 'INVALID_ARGUMENT');
    assert.equal(bad.replica.testElapsed(T0), null, '거절한 시작은 경과 시간을 세지 않는다');
  });

  it('거절한 뒤의 기록 ID 는 건너뛰지 않는다', () => {
    const alice = makePeer('alice');
    refuse(alice, { type: 'start_scenario', title: 'x' }, T0);
    refuse(alice, { type: 'start_test', request: 'r', max_duration_min: 0, max_scenarios: 1 }, T0);
    assert.equal(startTest(alice, T0).testId, `${alice.sid}-1`);
  });

  it('같은 sid 의 ID 가 이미 복제본에 있으면 덮어쓰지 않고 다음 순번을 쓴다', () => {
    const alice = makePeer('alice');
    const { testId } = startTest(alice, T0);
    const squatter: StateRecord = {
      kind: 'scenario',
      rid: `${alice.sid}-2`,
      author: 'zed',
      lc: T0 + 1,
      wall: T0 + 1,
      body: { test_id: testId, title: '남이 쓴 것', plan: null },
    };
    alice.replica.mergeRemote([squatter], { from: 'zed', snapshot: true }, T0 + 2);
    const mine = startScenario(alice, T0 + 3);
    assert.equal(mine.scenarioId, `${alice.sid}-3`);
    assert.equal(alice.replica.view(T0 + 4).scenarios.length, 2);
  });
});

describe('shared-state: 상한 (로컬 쓰기에만 건다)', () => {
  it('기록 수 상한에서 scenario·claim·verification 은 STATE_FULL, stop·presence 는 된다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const { testId } = startTest(alice, T0, { scenarios: 100 });
    const scenario = startScenario(alice, T0 + 1);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 2);
    sendSnapshot(alice, bob, T0 + 3);

    // 상한까지 채운다. 병합은 상한과 무관하게 받는다.
    const fill = LIMITS.STATE_MAX_RECORDS - alice.replica.snapshot().length;
    const filler = Array.from({ length: fill }, (_, i) => foreignScenario(i + 10, `${OTHER_SID}-9`));
    for (const peer of [alice, bob]) {
      const merged = peer.replica.mergeRemote(filler, { from: 'zed', snapshot: true }, T0 + 4);
      assert.equal(merged.applied.length, fill);
      assert.equal(peer.replica.snapshot().length, LIMITS.STATE_MAX_RECORDS);
    }
    void testId;

    assert.equal(refuse(alice, { type: 'start_scenario', title: 'x' }, T0 + 5), 'STATE_FULL');
    assert.equal(refuse(alice, { type: 'record_claim', scenario_id: scenario.scenarioId, action: 'a', observed: 'o', outcome: 'pass', steps: 's' }, T0 + 5), 'STATE_FULL');
    assert.equal(refuse(bob, { type: 'record_verification', claim_id: claim.claimId, result: 'confirmed', evidence: 'e' }, T0 + 5), 'STATE_FULL');

    // 꽉 찼다고 입장 알림이나 중단 요청이 막히면 안 된다.
    apply(alice, { type: 'set_presence', patch: { status: 'ready' } }, T0 + 6);
    apply(bob, { type: 'set_presence', patch: { status: 'ready' } }, T0 + 6);
    const stopped = apply(bob, { type: 'stop_test', reason: 'user', detail: '상태가 꽉 찼다' }, T0 + 7);
    assert.deepEqual(changeTypes(stopped.changes), ['test_stopped']);
    assert.equal(bob.replica.snapshot().length, LIMITS.STATE_MAX_RECORDS + 2);
    assert.ok(packStateFrames(bob.replica.snapshot(), { snap: true }).ok);
  });

  it('기록 수 상한에서도 test 는 쓸 수 있다', () => {
    const alice = makePeer('alice');
    const filler = Array.from({ length: LIMITS.STATE_MAX_RECORDS }, (_, i) => foreignScenario(i, `${OTHER_SID}-9`));
    alice.replica.mergeRemote(filler, { from: 'zed', snapshot: true }, T0);
    assert.equal(alice.replica.snapshot().length, LIMITS.STATE_MAX_RECORDS);
    startTest(alice, T0 + LIMITS.STATE_MAX_RECORDS + 1);
    assert.equal(refuse(alice, { type: 'start_scenario', title: 'x' }, T0 + LIMITS.STATE_MAX_RECORDS + 2), 'STATE_FULL');
  });

  it('한 건 모자랄 때는 쓸 수 있고, 그 다음부터 STATE_FULL 이다', () => {
    const alice = makePeer('alice');
    startTest(alice, T0, { scenarios: 100 });
    const fill = LIMITS.STATE_MAX_RECORDS - 1 - alice.replica.snapshot().length;
    alice.replica.mergeRemote(Array.from({ length: fill }, (_, i) => foreignScenario(i + 10, `${OTHER_SID}-9`)), { from: 'zed', snapshot: true }, T0 + 1);
    assert.equal(alice.replica.snapshot().length, LIMITS.STATE_MAX_RECORDS - 1);
    startScenario(alice, T0 + 2);
    assert.equal(alice.replica.snapshot().length, LIMITS.STATE_MAX_RECORDS);
    assert.equal(refuse(alice, { type: 'start_scenario', title: 'x' }, T0 + 3), 'STATE_FULL');
  });

  it('바이트 상한: 넘게 되는 쓰기는 STATE_FULL, stop·presence 는 된다', () => {
    const alice = makePeer('alice');
    startTest(alice, T0, { scenarios: 100 });
    const scenario = startScenario(alice, T0 + 1);
    const full = 'a'.repeat(LIMITS.STATE_TEXT_FIELD_MAX_BYTES);
    const bigClaim = { type: 'record_claim', scenario_id: scenario.scenarioId, action: full, expected: full, observed: full, outcome: 'pass', steps: full } as const;

    let total = alice.replica.snapshot().reduce((sum, record) => sum + recordByteSize(record), 0);
    let written = 0;
    let lastSize = 0;
    for (;;) {
      const result = alice.replica.applyLocal(bigClaim, T0 + 2 + written);
      if (!result.ok) {
        assert.equal(result.code, 'STATE_FULL');
        break;
      }
      lastSize = recordByteSize(result.records[0] as StateRecord);
      total += lastSize;
      written += 1;
      assert.ok(written < 200, '상한에 닿아야 한다');
    }
    assert.ok(written > 50, `큰 주장을 ${written}건 썼다`);
    assert.ok(total <= LIMITS.STATE_MAX_BYTES, '로컬 쓰기로는 바이트 상한을 넘지 않는다');
    assert.ok(alice.replica.snapshot().length < LIMITS.STATE_MAX_RECORDS, '기록 수 상한이 아니라 바이트 상한에 걸렸다');
    assert.ok(total + lastSize > LIMITS.STATE_MAX_BYTES, '큰 주장 하나가 더 들어갈 자리는 없다');

    // 작은 기록이 들어갈 자리는 남아 있다. 상한은 "넘게 되는 쓰기"를 막는다.
    startScenario(alice, T0 + 1000);
    apply(alice, { type: 'set_presence', patch: { status: 'ready' } }, T0 + 1001);
    apply(alice, { type: 'stop_test', reason: 'user', detail: full }, T0 + 1002);
    assert.ok(packStateFrames(alice.replica.snapshot(), { snap: true }).ok);
  });
});

describe('shared-state: 논리 시각의 끝 (protocol.md 5.2)', () => {
  function poisoned(lc: number): StateRecord {
    return { kind: 'presence', key: 'presence/zed', author: 'zed', lc, wall: T0, body: { client: 'x', tools: [], role: null, status: 'joined', listening: false, note: null } };
  }

  it('lc 가 2^53 − 1 인 기록을 병합한 뒤의 쓰기는 INVALID_ARGUMENT 이고 복제본과 지문이 그대로다', () => {
    const alice = makePeer('alice');
    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const merged = alice.replica.mergeRemote([poisoned(STATE_CLOCK_MAX)], { from: 'zed', snapshot: false }, T0 + 2);
    assert.equal(merged.applied.length, 1, '끝 값의 기록도 유효한 기록이라 받는다');

    const snapshot = alice.replica.snapshot();
    for (const command of [
      { type: 'set_presence', patch: { status: 'ready' } },
      { type: 'stop_test', reason: 'user', detail: '멈춘다' },
      { type: 'record_claim', scenario_id: scenario.scenarioId, action: 'a', observed: 'o', outcome: 'pass', steps: 's' },
      { type: 'start_scenario', title: 'x' },
    ] as const) {
      const result = alice.replica.applyLocal(command, T0 + 3);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.code, 'INVALID_ARGUMENT', command.type);
      assert.match(result.ok ? '' : result.detail, /^lc: /, 'detail 에 lc 로 사유를 적는다');
      assert.equal(refuse(alice, command, T0 + 3), 'INVALID_ARGUMENT');
    }
    assert.deepEqual(alice.replica.snapshot(), snapshot);
    assert.equal(alice.replica.view(T0 + 4).test?.stopped, null, '중단도 쓸 수 없다');

    // 규칙 거절이 먼저다. 쓸 기록이 없는 명령은 시각의 끝과 무관하다.
    assert.equal(refuse(alice, { type: 'start_test', request: 'r', max_duration_min: 1, max_scenarios: 1 }, T0 + 5), 'TEST_ALREADY_ACTIVE');
  });

  it('그보다 1 작은 값을 본 뒤에는 한 번 쓸 수 있고 그 기록의 lc 가 2^53 − 1 이다', () => {
    const alice = makePeer('alice');
    alice.replica.mergeRemote([poisoned(STATE_CLOCK_MAX - 1)], { from: 'zed', snapshot: false }, T0);
    const once = apply(alice, { type: 'set_presence', patch: { status: 'ready' } }, T0 + 1);
    assert.equal(once.record.lc, STATE_CLOCK_MAX);
    assert.equal(once.record.lc, 2 ** 53 - 1);
    assert.ok(packStateFrames(alice.replica.snapshot(), { snap: true }).ok);
    assert.equal(refuse(alice, { type: 'set_presence', patch: { status: 'working' } }, T0 + 2), 'INVALID_ARGUMENT');
  });

  it('진 기록의 lc 도 본 값이다', () => {
    const alice = makePeer('alice');
    const { testId } = startTest(alice, T0);
    const rid = `${OTHER_SID}-1`;
    const small: StateRecord = { kind: 'scenario', rid, author: 'zed', lc: T0, wall: T0, body: { test_id: testId, title: 'a', plan: null } };
    const large: StateRecord = { kind: 'scenario', rid, author: 'zed', lc: T0 + 500_000, wall: T0, body: { test_id: testId, title: 'b', plan: null } };
    alice.replica.mergeRemote([small], { from: 'zed', snapshot: true }, T0 + 1);
    const lost = alice.replica.mergeRemote([large], { from: 'zed', snapshot: true }, T0 + 2);
    assert.equal(lost.applied.length, 0, '바이트가 큰 쪽이라 남지 않는다');
    const next = apply(alice, { type: 'set_presence', patch: {} }, T0 + 3).record;
    assert.equal(next.lc, T0 + 500_001);
  });
});
