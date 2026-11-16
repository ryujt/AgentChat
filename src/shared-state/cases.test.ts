// V-U3: protocol.md 5.6 의 사례 전부. 표의 행 순서대로 둔다.
// 스냅샷 교환을 언제 시작하는지(지문 비교 횟수, 재동기화 간격, 중단의 즉시 교환)는 room-session 의 일이다(V-U9).
// 여기서는 교환이 일어났을 때 복제본이 어떻게 되는지와, room-session 이 판단에 쓰는 값(지문, applied, changes)을 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, canonicalJson, compareCanonical, stateFingerprint } from '../protocol/index.js';
import type { StateRecord } from '../protocol/index.js';
import {
  MIN,
  SEC,
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
  signature,
  startScenario,
  startTest,
} from './testing.js';

const OTHER_SID = 'zzzzzzzzzzzz';
const NEW_TEST = { type: 'start_test', request: '다시 시작', max_duration_min: 480, max_scenarios: 100 } as const;
const NEW_SCENARIO = { type: 'start_scenario', title: '새 시나리오' } as const;

describe('shared-state: protocol.md 5.6 사례', () => {
  it('두 참가자가 동시에 start_test: (lc, author) 가 큰 쪽이 남고 진 쪽의 기록은 판정에서 빠진다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const a = startTest(alice, T0, { minutes: 10 });
    const b = startTest(bob, T0, { minutes: 20 });
    const lost = startScenario(alice, T0 + 1, '진 테스트의 시나리오');

    const { toA, toB } = exchange(alice, bob, T0 + 2);
    // lc 가 같으면 author 문자열이 큰 쪽이다.
    for (const peer of [alice, bob]) {
      const view = peer.replica.view(T0 + 3);
      assert.equal(view.test?.test_id, b.testId);
      assert.equal(view.test?.by, 'bob');
      assert.equal(view.test?.max_duration_min, 20);
      assert.deepEqual(view.scenarios, [], '진 쪽의 test_id 로 쓴 기록은 현재 테스트가 아니다');
      assert.equal(view.test?.scenarios_used, 0);
      assert.equal(peer.replica.snapshot().length, 2, '진 test 기록은 사라지고 그 시나리오는 기록으로 남는다');
    }
    assert.equal(alice.replica.fingerprint(), bob.replica.fingerprint());

    // 진 쪽은 "테스트가 바뀌었다"를 받는다. 이긴 쪽에는 변화가 없다.
    assert.deepEqual(changeTypes(toA.changes), ['test_replaced']);
    const replaced = toA.changes[0];
    assert.ok(replaced?.type === 'test_replaced');
    assert.equal(replaced.previous_test_id, a.testId);
    assert.equal(replaced.test.test_id, b.testId);
    assert.deepEqual(toB.changes, []);

    assert.equal(refuse(alice, { type: 'record_claim', scenario_id: lost.scenarioId, action: 'a', observed: 'o', outcome: 'pass', steps: 's' }, T0 + 4), 'UNKNOWN_SCENARIO');
    assert.equal(refuse(alice, NEW_TEST, T0 + 4), 'TEST_ALREADY_ACTIVE', '동시에 시작한 둘은 하나만 남고, 그 뒤로는 시작할 수 없다');
  });

  it('두 참가자가 동시에 start_test: lc 가 다르면 이름과 무관하게 lc 가 큰 쪽이 남는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const a = startTest(alice, T0 + 5);
    startTest(bob, T0);
    const { toA, toB } = exchange(alice, bob, T0 + 6);
    assert.equal(alice.replica.view(T0).test?.test_id, a.testId);
    assert.equal(bob.replica.view(T0).test?.test_id, a.testId);
    assert.deepEqual(toA.changes, []);
    assert.deepEqual(changeTypes(toB.changes), ['test_replaced']);
  });

  it('중단 뒤 start_test: test 기록이 이미 있으므로 거절한다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    sendChange(alice, bob, startTest(alice, T0, { minutes: 5, scenarios: 1 }).records, T0);
    sendChange(alice, bob, apply(alice, { type: 'stop_test', reason: 'user', detail: '그만' }, T0 + 1).records, T0 + 1);
    sendSnapshot(bob, carol, T0 + 2);
    for (const peer of [alice, bob, carol]) {
      assert.equal(refuse(peer, NEW_TEST, T0 + 3), 'TEST_ENDED', `${peer.name}: 제한을 다시 정하려면 새 방에서 시작해야 한다`);
      assert.equal(peer.replica.view(T0 + 3).test?.max_duration_min, 5);
    }
  });

  it('한도 직전에 두 참가자가 동시에 start_scenario: 정렬 순서가 뒤인 시나리오가 한도 초과가 된다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    sendChange(alice, bob, startTest(alice, T0, { scenarios: 2 }).records, T0);
    sendChange(alice, bob, startScenario(alice, T0 + 1, '첫째').records, T0 + 1);

    // 둘 다 자기 복제본에서는 한도 안이라 성공한다.
    const byAlice = startScenario(alice, T0 + 10, 'alice 의 둘째');
    const byBob = startScenario(bob, T0 + 10, 'bob 의 둘째');
    const early = recordClaim(bob, byBob.scenarioId, T0 + 11);
    assert.equal(early.changes[0]?.type === 'claim_added' ? early.changes[0].claim.classification : '', 'unverified');

    const toBob = sendChange(alice, bob, byAlice.records, T0 + 12);
    const toAlice = sendChange(bob, alice, [...byBob.records, ...early.records], T0 + 12);
    // lc 가 같고 alice < bob 이므로 bob 의 시나리오가 셋째다.
    assert.deepEqual(changeTypes(toBob.changes), ['scenario_started', 'scenario_over_limit'], '작성자는 자기 시나리오가 밀려났다는 변화를 받는다');
    const pushed = toBob.changes[1];
    assert.ok(pushed?.type === 'scenario_over_limit');
    assert.equal(pushed.scenario.scenario_id, byBob.scenarioId);
    assert.equal(pushed.scenario.by, 'bob');
    assert.equal(pushed.scenario.index, 3);
    assert.deepEqual(changeTypes(toAlice.changes), ['scenario_over_limit', 'claim_added'], '들어올 때부터 초과인 시나리오는 시작됨이 아니라 한도 초과로 온다');

    for (const peer of [alice, bob]) {
      const view = peer.replica.view(T0 + 13);
      assert.deepEqual(view.scenarios.map((s) => [s.index, s.title, s.over_limit]), [[1, '첫째', false], [2, 'alice 의 둘째', false], [3, 'bob 의 둘째', true]]);
      assert.equal(view.test?.scenarios_used, 2, '유효 시나리오만 센다');
      assert.equal(view.test?.stopped, null, '테스트는 중단되지 않는다');
      assert.equal(refuse(peer, { type: 'record_claim', scenario_id: byBob.scenarioId, action: 'a', observed: 'o', outcome: 'pass', steps: 's' }, T0 + 14), 'SCENARIO_OVER_LIMIT');
      assert.equal(refuse(peer, NEW_SCENARIO, T0 + 14), 'SCENARIO_LIMIT_REACHED');
    }
    recordClaim(bob, byAlice.scenarioId, T0 + 15);

    // 밀려나기 전에 쓴 주장은 확인을 받아도 성공으로 세지 않는다.
    const verified = recordVerification(alice, early.claimId, T0 + 16);
    sendChange(alice, bob, verified.records, T0 + 16);
    for (const peer of [alice, bob]) {
      const claim = peer.replica.view(T0 + 17).claims.find((c) => c.claim_id === early.claimId);
      assert.equal(claim?.status, 'confirmed');
      assert.equal(claim?.classification, 'unverified');
    }
    // 한도 초과는 시나리오마다 한 번만 알린다. 그 뒤에 다른 기록이 들어와도 다시 알리지 않는다.
    const again = sendSnapshot(alice, bob, T0 + 18);
    assert.deepEqual(changeTypes(again.changes).filter((type) => type === 'scenario_over_limit'), []);
    const more = recordClaim(alice, byAlice.scenarioId, T0 + 19);
    assert.deepEqual(changeTypes(more.changes), ['claim_added']);
    assert.deepEqual(changeTypes(sendChange(alice, bob, more.records, T0 + 20).changes), ['claim_added']);
    assert.deepEqual(changeTypes(apply(bob, { type: 'set_presence', patch: { status: 'ready' } }, T0 + 21).changes), ['presence_changed']);
  });

  it('한 주장에 확인과 반박이 함께: 반박됨으로 분류하고 두 증거를 모두 갖는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const claim = recordClaim(alice, scenario.scenarioId, T0 + 2, 'pass');
    sendSnapshot(alice, bob, T0 + 3);
    sendSnapshot(alice, carol, T0 + 3);
    const confirmed = apply(bob, { type: 'record_verification', claim_id: claim.claimId, result: 'confirmed', evidence: 'bob 의 화면에서 봤다' }, T0 + 4);
    const refuted = apply(carol, { type: 'record_verification', claim_id: claim.claimId, result: 'refuted', evidence: 'carol 의 화면에는 없었다' }, T0 + 5);
    assert.equal(confirmed.changes[0]?.type === 'verification_added' ? confirmed.changes[0].claim_status : '', 'confirmed');
    assert.equal(refuted.changes[0]?.type === 'verification_added' ? refuted.changes[0].claim_status : '', 'refuted');

    // 어느 쪽을 먼저 받아도 같다.
    sendChange(bob, alice, confirmed.records, T0 + 6);
    const late = sendChange(carol, alice, refuted.records, T0 + 7);
    assert.equal(late.changes[0]?.type === 'verification_added' ? late.changes[0].claim_status : '', 'refuted');
    sendChange(carol, bob, refuted.records, T0 + 6);
    sendChange(bob, carol, confirmed.records, T0 + 7);

    for (const peer of [alice, bob, carol]) {
      const view = peer.replica.view(T0 + 8).claims[0];
      assert.equal(view?.status, 'refuted');
      assert.equal(view?.classification, 'failed', '성공이라고 주장했는데 반박됐다');
      assert.deepEqual(view?.verifications.map((v) => [v.by, v.result, v.evidence, v.counted]), [
        ['bob', 'confirmed', 'bob 의 화면에서 봤다', true],
        ['carol', 'refuted', 'carol 의 화면에는 없었다', true],
      ]);
    }
  });

  it('중단과 새 시나리오가 동시에: 둘 다 남고 중단됨이 이긴다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    sendChange(alice, bob, startTest(alice, T0).records, T0);
    const stop = apply(alice, { type: 'stop_test', reason: 'user', detail: '그만' }, T0 + 10);
    const scenario = startScenario(bob, T0 + 10, '동시에 시작한 시나리오');
    const toBob = sendChange(alice, bob, stop.records, T0 + 11);
    const toAlice = sendChange(bob, alice, scenario.records, T0 + 11);
    assert.deepEqual(changeTypes(toBob.changes), ['test_stopped']);
    assert.deepEqual(changeTypes(toAlice.changes), ['scenario_started']);

    for (const peer of [alice, bob]) {
      const view = peer.replica.view(T0 + 12);
      assert.equal(view.test?.stopped?.by, 'alice');
      assert.deepEqual(view.scenarios.map((s) => s.title), ['동시에 시작한 시나리오'], '시나리오는 기록에 남는다');
      assert.equal(refuse(peer, NEW_SCENARIO, T0 + 13), 'TEST_STOPPED', '이후 새 시나리오는 모두 거절된다');
    }
    assert.equal(alice.replica.fingerprint(), bob.replica.fingerprint());
  });

  it('중단 뒤에 쓴 주장: 받되 "중단 뒤 기록"으로 분류하고 확인을 받아도 성공·실패에 세지 않는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    const before = recordClaim(alice, scenario.scenarioId, T0 + 2, 'pass');
    sendSnapshot(alice, bob, T0 + 3);
    const stop = apply(bob, { type: 'stop_test', reason: 'user', detail: '그만' }, T0 + 100);
    sendChange(bob, alice, stop.records, T0 + 101);

    // 중단을 본 뒤에 쓴 주장은 시계가 어떻든 중단 뒤 기록이다(작성자의 벽시계가 뒤로 가 있어도).
    const after = recordClaim(alice, scenario.scenarioId, T0 + 50, 'pass');
    const added = after.changes[0];
    assert.ok(added?.type === 'claim_added');
    assert.equal(added.claim.late, true);
    assert.equal(added.claim.classification, 'late');
    assert.ok(after.record.lc > stop.record.lc);
    const afterFail = recordClaim(alice, scenario.scenarioId, T0 + 51, 'fail');
    sendChange(alice, bob, [...after.records, ...afterFail.records], T0 + 102);

    // 검증은 중단 뒤에도 받는다. 이미 한 행동을 확인하는 일이다.
    const verifications = [
      ...recordVerification(bob, before.claimId, T0 + 103).records,
      ...recordVerification(bob, after.claimId, T0 + 104).records,
      ...recordVerification(bob, afterFail.claimId, T0 + 105).records,
    ];
    sendChange(bob, alice, verifications, T0 + 106);

    for (const peer of [alice, bob]) {
      const byId = new Map(peer.replica.view(T0 + 107).claims.map((c) => [c.claim_id, c]));
      assert.deepEqual([byId.get(before.claimId)?.late, byId.get(before.claimId)?.classification], [false, 'passed'], '중단 전의 주장은 중단 뒤에 확인받아도 성공이다');
      assert.deepEqual([byId.get(after.claimId)?.late, byId.get(after.claimId)?.status, byId.get(after.claimId)?.classification], [true, 'confirmed', 'late']);
      assert.deepEqual([byId.get(afterFail.claimId)?.late, byId.get(afterFail.claimId)?.classification], [true, 'late']);
    }
  });

  it('중단 뒤에 쓴 주장: 중단을 못 본 채 쓴 주장은 lc 로 갈리고, 판정은 모든 복제본에서 같다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    startTest(alice, T0);
    const scenario = startScenario(alice, T0 + 1);
    sendSnapshot(alice, bob, T0 + 2);
    sendSnapshot(alice, carol, T0 + 2);
    const stop = apply(alice, { type: 'stop_test', reason: 'user', detail: '' }, T0 + 100);
    const earlier = recordClaim(bob, scenario.scenarioId, T0 + 99);
    const same = recordClaim(bob, scenario.scenarioId, T0 + 100);
    const later = recordClaim(carol, scenario.scenarioId, T0 + 101);
    for (const peer of [alice, bob, carol]) {
      peer.replica.mergeRemote([...stop.records, ...earlier.records, ...same.records, ...later.records], { from: 'peer', snapshot: true }, T0 + 200);
      const late = new Map(peer.replica.view(T0 + 201).claims.map((c) => [c.claim_id, c.late]));
      assert.deepEqual([late.get(earlier.claimId), late.get(same.claimId), late.get(later.claimId)], [false, false, true], '주장의 lc 가 중단 시점의 lc 보다 클 때만 중단 뒤 기록이다');
    }
    assert.equal(signature(alice.replica), signature(bob.replica));
    assert.equal(signature(bob.replica), signature(carol.replica));
  });

  it('재입장: 빈 복제본으로 시작해 스냅샷으로 test, stop, 시나리오, 주장, 검증, 모든 presence 를 받는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const peers = [alice, bob, carol];
    const share = (from: typeof alice, records: readonly StateRecord[], now: number): void => {
      for (const peer of peers) if (peer !== from) sendChange(from, peer, records, now);
    };
    share(alice, apply(alice, { type: 'set_presence', patch: { client: 'claude-code', role: '강사', status: 'ready' } }, T0).records, T0);
    share(bob, apply(bob, { type: 'set_presence', patch: { client: 'codex', role: '수강생', status: 'ready' } }, T0).records, T0);
    share(carol, apply(carol, { type: 'set_presence', patch: { role: '관찰자', status: 'working' } }, T0).records, T0);
    share(alice, startTest(alice, T0 + 1, { minutes: 45, scenarios: 7 }).records, T0 + 1);
    const scenario = startScenario(alice, T0 + 2);
    share(alice, scenario.records, T0 + 2);
    const claim = recordClaim(bob, scenario.scenarioId, T0 + 3);
    share(bob, claim.records, T0 + 3);
    share(carol, recordVerification(carol, claim.claimId, T0 + 4).records, T0 + 4);
    share(bob, apply(bob, { type: 'set_presence', patch: { status: 'left' } }, T0 + 5).records, T0 + 5);
    share(carol, apply(carol, { type: 'stop_test', reason: 'user', detail: '끝' }, T0 + 6).records, T0 + 6);

    // 새 프로세스의 bob. 이 방에서 쓴 이름을 기억하지 못하지만 이름이 같다.
    const rejoined = makePeer('bob', { generation: 1 });
    const merged = sendSnapshot(alice, rejoined, T0 + 10 * MIN);
    assert.deepEqual(merged.applied.map((record) => record.kind).sort(), ['claim', 'presence', 'presence', 'presence', 'scenario', 'stop', 'test', 'verification']);

    const view = rejoined.replica.view(T0 + 10 * MIN);
    assert.equal(signature(rejoined.replica), signature(alice.replica), '기존 참가자와 같은 기록·판정을 갖는다');
    assert.equal(view.test?.request, '손들기 기능을 강사와 수강생 역할로 확인한다');
    assert.deepEqual([view.test?.max_duration_min, view.test?.max_scenarios, view.test?.scenarios_used, view.test?.stopped?.by], [45, 7, 1, 'carol']);
    assert.deepEqual(view.presences.map((p) => [p.peer, p.role, p.status]), [['alice', '강사', 'ready'], ['bob', '수강생', 'left'], ['carol', '관찰자', 'working']]);
    assert.equal(view.claims[0]?.classification, 'passed');
    // 이름이 같으므로 자기 예전 주장을 검증할 수 없다.
    assert.equal(refuse(rejoined, { type: 'record_verification', claim_id: claim.claimId, result: 'confirmed', evidence: 'e' }, T0 + 10 * MIN), 'SELF_VERIFY_FORBIDDEN');
  });

  it('재입장자의 옛 presence: 동기화 뒤에 쓰면 시계가 뒤로 간 PC 에서도 옛 값을 이긴다', () => {
    const alice = makePeer('alice');
    const old = makePeer('bob');
    const left = apply(old, { type: 'set_presence', patch: { role: '수강생', status: 'left' } }, T0);
    sendChange(old, alice, left.records, T0);

    // 새 PC 의 시계가 10분 뒤져 있다. 동기화를 먼저 했으므로 옛 값을 본 뒤에 쓴다.
    const rejoined = makePeer('bob', { generation: 1 });
    sendSnapshot(alice, rejoined, T0 - 10 * MIN);
    const fresh = apply(rejoined, { type: 'set_presence', patch: { status: 'ready' } }, T0 - 10 * MIN);
    assert.equal(fresh.record.lc, left.record.lc + 1);
    assert.deepEqual(fresh.record.body, { client: 'unknown', tools: [], role: '수강생', status: 'ready', listening: false, note: null }, '옛 값 위에 준 필드만 바꾼다');
    const toAlice = sendChange(rejoined, alice, fresh.records, T0 + 1);
    assert.equal(toAlice.applied.length, 1);
    assert.equal(alice.replica.view(T0).presences[0]?.status, 'ready');

    // 동기화 전에 먼저 쓰면 옛 값에 진다. 그래서 입장자는 첫 동기화가 끝난 뒤에 쓴다.
    const hasty = makePeer('bob', { generation: 2 });
    const tooEarly = apply(hasty, { type: 'set_presence', patch: { status: 'working' } }, T0 - 10 * MIN);
    const carol = makePeer('carol');
    sendChange(old, carol, left.records, T0);
    const lost = sendChange(hasty, carol, tooEarly.records, T0 + 1);
    assert.equal(lost.applied.length, 0);
    assert.equal(carol.replica.view(T0).presences[0]?.status, 'left');
  });

  it('떠난 참가자의 기록: 작성자가 방에 없어도 다른 참가자의 스냅샷으로 받는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    sendChange(alice, bob, startTest(alice, T0).records, T0);
    const scenario = startScenario(bob, T0 + 1, 'bob 이 시작하고 떠났다');
    const claim = recordClaim(bob, scenario.scenarioId, T0 + 2);
    const left = apply(bob, { type: 'set_presence', patch: { status: 'left' } }, T0 + 3);
    sendChange(bob, alice, [...scenario.records, ...claim.records, ...left.records], T0 + 3);
    // bob 은 떠났다. 그 복제본은 없다.

    const dave = makePeer('dave');
    const merged = sendSnapshot(alice, dave, T0 + MIN);
    assert.equal(merged.anomalies, 0, '스냅샷의 author 는 링크 피어와 달라도 받는다');
    const view = dave.replica.view(T0 + MIN);
    assert.deepEqual(view.scenarios.map((s) => [s.title, s.by]), [['bob 이 시작하고 떠났다', 'bob']]);
    assert.deepEqual(view.claims.map((c) => c.by), ['bob']);
    assert.deepEqual(view.presences.map((p) => [p.peer, p.status]), [['bob', 'left']]);
    // 신규 입장자는 떠난 참가자의 주장을 검증할 수 있다.
    recordVerification(dave, claim.claimId, T0 + MIN + 1);
    assert.equal(dave.replica.view(T0 + MIN + 2).claims[0]?.classification, 'passed');
  });

  it('작성자가 떠난 경우: stop 은 C 의 병합이 중단됨을 알리고, A–C 교환으로 A 에 닿는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const started = startTest(alice, T0);
    sendChange(alice, bob, started.records, T0);
    sendChange(alice, carol, started.records, T0);

    // A–B 링크가 끊긴 사이 B 가 stop 을 쓰고 떠난다. stop 은 C 에만 갔다.
    const stop = apply(bob, { type: 'stop_test', reason: 'user', detail: '사용자가 멈췄다' }, T0 + 10);
    const atCarol = sendChange(bob, carol, stop.records, T0 + 10);
    // 병합으로 "중단됨"이 됐다는 변화가 room-session 이 다른 링크에서 교환을 바로 시작하는 계기다(5.4 의 6번).
    assert.deepEqual(changeTypes(atCarol.changes), ['test_stopped']);
    assert.notEqual(alice.replica.fingerprint(), carol.replica.fingerprint());
    startScenario(alice, T0 + 11, 'A 는 아직 모른다');

    const { toA } = exchange(alice, carol, T0 + 12);
    assert.deepEqual(changeTypes(toA.changes), ['test_stopped'], 'A 도 같은 규칙으로 자기의 다른 링크에 교환을 시작할 수 있다');
    assert.equal(toA.changes[0]?.type === 'test_stopped' ? toA.changes[0].stop.by : '', 'bob');
    assert.equal(refuse(alice, NEW_SCENARIO, T0 + 13), 'TEST_STOPPED');
    assert.equal(alice.replica.fingerprint(), carol.replica.fingerprint());
  });

  it('작성자가 떠난 경우: stop 이 아닌 기록은 지문이 달라 교환으로 맞춰진다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const started = startTest(alice, T0);
    sendChange(alice, bob, started.records, T0);
    sendChange(alice, carol, started.records, T0);
    assert.equal(alice.replica.fingerprint(), carol.replica.fingerprint());

    const scenario = startScenario(bob, T0 + 10, 'B 가 쓰고 떠났다');
    sendChange(bob, carol, scenario.records, T0 + 10);
    // 멀쩡한 A–C 링크의 ping 이 싣는 값이 다르다. 이것이 재동기화의 계기다(5.4 의 5번).
    assert.notEqual(alice.replica.fingerprint(), carol.replica.fingerprint());
    assert.notEqual(alice.replica.snapshot().length, carol.replica.snapshot().length);

    const { toA, toB } = exchange(alice, carol, T0 + 20);
    assert.equal(toA.applied.length, 1);
    assert.equal(toB.applied.length, 0);
    assert.equal(alice.replica.fingerprint(), carol.replica.fingerprint());
    assert.equal(signature(alice.replica), signature(carol.replica));
  });

  it('한 쌍만 끊긴 경우: A 와 B 의 기록이 C 와의 교환으로 서로에게 닿는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const started = startTest(carol, T0);
    sendChange(carol, alice, started.records, T0);
    sendChange(carol, bob, started.records, T0);

    // A–B 는 서로 닿지 않는다. 둘 다 C 와는 이어져 있다. 변경은 C 에만 간다.
    const byAlice = startScenario(alice, T0 + 1, 'A 의 시나리오');
    sendChange(alice, carol, byAlice.records, T0 + 1);
    const byBob = startScenario(bob, T0 + 2, 'B 의 시나리오');
    sendChange(bob, carol, byBob.records, T0 + 2);
    assert.equal(new Set([alice, bob, carol].map((p) => p.replica.fingerprint())).size, 3);

    // 받은 쪽은 변경을 다른 링크로 넘기지 않는다. 맞추는 것은 스냅샷 교환이다.
    exchange(alice, carol, T0 + 10);
    exchange(bob, carol, T0 + 11);
    assert.equal(new Set([alice, bob, carol].map((p) => signature(p.replica))).size, 1);
    assert.deepEqual(alice.replica.view(T0 + 12).scenarios.map((s) => s.by), ['alice', 'bob']);

    // stop 도 같은 길로 닿는다.
    const stop = apply(bob, { type: 'stop_test', reason: 'user', detail: '' }, T0 + 20);
    const atCarol = sendChange(bob, carol, stop.records, T0 + 20);
    assert.deepEqual(changeTypes(atCarol.changes), ['test_stopped']);
    const { toA } = exchange(alice, carol, T0 + 21);
    assert.deepEqual(changeTypes(toA.changes), ['test_stopped']);
    assert.equal(refuse(alice, NEW_SCENARIO, T0 + 22), 'TEST_STOPPED');
  });

  it('끊긴 쌍의 한쪽이 계속 기록을 쓴다: 교환할 때마다 그때까지의 차이가 없어진다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const carol = makePeer('carol');
    const started = startTest(carol, T0, { scenarios: 100 });
    sendChange(carol, alice, started.records, T0);
    sendChange(carol, bob, started.records, T0);
    const scenario = startScenario(bob, T0 + 1);
    sendChange(bob, carol, scenario.records, T0 + 1);

    for (let round = 0; round < 12; round += 1) {
      const now = T0 + round * 30 * SEC;
      const { toA, toB } = exchange(alice, carol, now);
      // 교환이 끝나면 양쪽 지문이 같다. 답의 sf 가 내 지문과 같으므로 "진전 없음"으로 세지 않는다.
      assert.equal(alice.replica.fingerprint(), carol.replica.fingerprint(), `${round}번째 교환 뒤`);
      assert.ok(toA.applied.length >= 1, 'A 는 교환마다 B 의 새 기록을 받는다');
      assert.equal(toB.applied.length, 0);

      // 교환 직후 B 의 새 기록이 C 에 도착한다. 교환 뒤에 생긴 새 차이다.
      const next = recordClaim(bob, scenario.scenarioId, now + 5 * SEC);
      const atCarol = sendChange(bob, carol, next.records, now + 5 * SEC);
      assert.equal(atCarol.applied.length, 1, '다른 곳에서 들어온 기록이 있다는 것을 room-session 이 안다');
      assert.notEqual(alice.replica.fingerprint(), carol.replica.fingerprint());
    }

    const stop = apply(bob, { type: 'stop_test', reason: 'user', detail: '' }, T0 + 400 * SEC);
    sendChange(bob, carol, stop.records, T0 + 400 * SEC);
    const { toA } = exchange(alice, carol, T0 + 400 * SEC);
    assert.ok(changeTypes(toA.changes).includes('test_stopped'));
    assert.equal(alice.replica.view(T0 + 401 * SEC).claims.length, 12);
  });

  it('맞출 수 없는 차이: 검증에서 버리는 기록은 몇 번을 받아도 들어오지 않고, 받을 수 있는 기록은 계속 받는다', () => {
    const alice = makePeer('alice');
    const started = startTest(alice, T0);
    // 결함이 있는 상대. 남의 presence 를 대신 쓴 기록을 갖고 있다. 우리 검증은 그것을 버린다.
    const bogus = { kind: 'presence', key: 'presence/alice', author: 'mallory', lc: T0 + 5, wall: T0, body: { client: 'x', tools: [], role: '지휘자', status: 'ready', listening: true, note: null } } as unknown as StateRecord;
    const theirs: StateRecord[] = [...started.records, bogus];
    const theirFingerprint = (): string => stateFingerprint(theirs);

    const first = alice.replica.mergeRemote(theirs, { from: 'mallory', snapshot: true }, T0 + 10);
    assert.deepEqual({ applied: first.applied.length, ignored: first.ignored, anomalies: first.anomalies }, { applied: 0, ignored: 2, anomalies: 1 });
    assert.notEqual(alice.replica.fingerprint(), theirFingerprint(), '주고받아도 없어지지 않는 차이다');
    assert.deepEqual(alice.replica.view(T0 + 10).presences, [], '남이 쓴 presence 는 버린다');

    // 다시 받아도 같다. 받은 기록이 없고 지문이 계속 다르다는 것이 "진전 없음"의 재료다.
    for (let round = 0; round < 5; round += 1) {
      const again = alice.replica.mergeRemote(theirs, { from: 'mallory', snapshot: true }, T0 + 20 + round);
      assert.equal(again.applied.length, 0);
      assert.deepEqual(again.changes, []);
      assert.notEqual(alice.replica.fingerprint(), theirFingerprint());
    }

    // 재동기화는 멈추지 않으므로 그 링크로 오는 유효한 기록은 계속 받는다. stop 도 받는다.
    const testId = started.testId;
    theirs.push({ kind: 'scenario', rid: `${OTHER_SID}-1`, author: 'mallory', lc: T0 + 30, wall: T0 + 30, body: { test_id: testId, title: '유효한 기록', plan: null } });
    const more = alice.replica.mergeRemote(theirs, { from: 'mallory', snapshot: true }, T0 + 31);
    assert.deepEqual(changeTypes(more.changes), ['scenario_started']);
    theirs.push({ kind: 'stop', rid: `${OTHER_SID}-2`, author: 'mallory', lc: T0 + 40, wall: T0 + 40, body: { test_id: testId, reason: 'user', detail: '' } });
    const stopped = alice.replica.mergeRemote(theirs, { from: 'mallory', snapshot: true }, T0 + 41);
    assert.deepEqual(changeTypes(stopped.changes), ['test_stopped']);
    assert.notEqual(alice.replica.fingerprint(), theirFingerprint(), '차이는 그대로 남는다');
  });

  it('상한 직전의 동시 쓰기: 둘 다 받아 2001건으로 같아지고, 이후 로컬 쓰기는 STATE_FULL 이다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    sendChange(alice, bob, startTest(alice, T0, { scenarios: 100 }).records, T0);
    const scenario = startScenario(alice, T0 + 1);
    sendChange(alice, bob, scenario.records, T0 + 1);
    const fill = LIMITS.STATE_MAX_RECORDS - 1 - alice.replica.snapshot().length;
    const filler: StateRecord[] = Array.from({ length: fill }, (_, i) => ({
      kind: 'scenario',
      rid: `${OTHER_SID}-${i.toString(36)}`,
      author: 'zed',
      lc: T0 + 2,
      wall: T0 + 2,
      body: { test_id: `${OTHER_SID}-zz`, title: `채움 ${i}`, plan: null },
    }));
    for (const peer of [alice, bob]) peer.replica.mergeRemote(filler, { from: 'zed', snapshot: true }, T0 + 2);
    assert.equal(alice.replica.snapshot().length, LIMITS.STATE_MAX_RECORDS - 1);
    assert.equal(bob.replica.snapshot().length, 1999);

    // 둘 다 자기 복제본에서는 상한 안이다.
    const byAlice = recordClaim(alice, scenario.scenarioId, T0 + 10);
    const byBob = recordClaim(bob, scenario.scenarioId, T0 + 10);
    const toBob = sendChange(alice, bob, byAlice.records, T0 + 11);
    const toAlice = sendChange(bob, alice, byBob.records, T0 + 11);
    assert.equal(toBob.applied.length, 1, '병합은 상한과 무관하게 받는다');
    assert.equal(toAlice.applied.length, 1);
    for (const peer of [alice, bob]) assert.equal(peer.replica.snapshot().length, LIMITS.STATE_MAX_RECORDS + 1);
    assert.equal(signature(alice.replica), signature(bob.replica));

    for (const peer of [alice, bob]) {
      assert.equal(refuse(peer, NEW_SCENARIO, T0 + 12), 'STATE_FULL');
      assert.equal(refuse(peer, { type: 'record_claim', scenario_id: scenario.scenarioId, action: 'a', observed: 'o', outcome: 'pass', steps: 's' }, T0 + 12), 'STATE_FULL');
    }
    assert.equal(refuse(bob, { type: 'record_verification', claim_id: byAlice.claimId, result: 'confirmed', evidence: 'e' }, T0 + 12), 'STATE_FULL');
    // stop 은 계속 쓸 수 있다.
    const stop = apply(bob, { type: 'stop_test', reason: 'user', detail: '' }, T0 + 13);
    sendChange(bob, alice, stop.records, T0 + 13);
    assert.equal(alice.replica.view(T0 + 14).test?.stopped?.by, 'bob');
    assert.equal(signature(alice.replica), signature(bob.replica));
  });

  it('식별자는 같고 내용이 다른 기록: 어느 순서로 받아도 직렬화 바이트가 작은 쪽이 남고 이상으로 센다', () => {
    const testId = `${OTHER_SID}-zz`;
    const pairs: [StateRecord, StateRecord][] = [
      // 추가 기록: rid 가 같다.
      [
        { kind: 'claim', rid: `${OTHER_SID}-1`, author: 'zed', lc: T0, wall: T0, body: { test_id: testId, scenario: `${OTHER_SID}-s`, action: 'a', expected: null, observed: '봤다', outcome: 'pass', steps: 's' } },
        { kind: 'claim', rid: `${OTHER_SID}-1`, author: 'zed', lc: T0, wall: T0, body: { test_id: testId, scenario: `${OTHER_SID}-s`, action: 'a', expected: null, observed: '못 봤다', outcome: 'fail', steps: 's' } },
      ],
      // 추가 기록: rid 가 같고 종류와 작성자까지 다르다.
      [
        { kind: 'stop', rid: `${OTHER_SID}-2`, author: 'zed', lc: T0 + 9, wall: T0, body: { test_id: testId, reason: 'user', detail: '' } },
        { kind: 'scenario', rid: `${OTHER_SID}-2`, author: 'amy', lc: T0, wall: T0, body: { test_id: testId, title: 't', plan: null } },
      ],
      // 키 기록: (lc, author) 까지 같다.
      [
        { kind: 'test', key: 'test', author: 'zed', lc: T0, wall: T0, body: { test_id: testId, request: '요청 가', started_wall: T0, max_duration_min: 60, max_scenarios: 20 } },
        { kind: 'test', key: 'test', author: 'zed', lc: T0, wall: T0, body: { test_id: testId, request: '요청 나', started_wall: T0, max_duration_min: 480, max_scenarios: 100 } },
      ],
      [
        { kind: 'presence', key: 'presence/zed', author: 'zed', lc: T0, wall: T0, body: { client: 'x', tools: [], role: '강사', status: 'ready', listening: true, note: null } },
        { kind: 'presence', key: 'presence/zed', author: 'zed', lc: T0, wall: T0, body: { client: 'x', tools: [], role: '수강생', status: 'ready', listening: true, note: null } },
      ],
    ];

    for (const [one, two] of pairs) {
      const expected = compareCanonical(one, two) < 0 ? one : two;
      const results = [[one, two], [two, one]].map((order, i) => {
        const peer = makePeer('carol', { generation: i });
        const first = peer.replica.mergeRemote([order[0] as StateRecord], { from: 'peer', snapshot: true }, T0 + 1);
        const second = peer.replica.mergeRemote([order[1] as StateRecord], { from: 'peer', snapshot: true }, T0 + 2);
        assert.equal(first.anomalies, 0);
        assert.equal(second.anomalies, 1, '이상으로 기록한다');
        assert.equal(second.applied.length + second.ignored, 1);
        // 한 묶음으로 받아도 같다.
        const batch = makePeer('carol', { generation: 10 + i });
        const together = batch.replica.mergeRemote(order as StateRecord[], { from: 'peer', snapshot: true }, T0 + 1);
        assert.equal(together.anomalies, 1);
        assert.equal(signature(batch.replica), signature(peer.replica));
        return peer.replica.snapshot();
      });
      assert.deepEqual(results[0], [expected], `${one.kind}: 작은 쪽이 남는다`);
      assert.deepEqual(results[1], [expected], `${one.kind}: 순서를 바꿔도 같은 쪽이 남는다`);
    }
    // 두 순서를 모두 봤으므로 "먼저 온 것을 남기는" 구현은 한쪽 순서에서 걸린다. 표본의 두 기록은 실제로 다르다.
    assert.ok(pairs.every(([one, two]) => canonicalJson(one) !== canonicalJson(two)));
  });

  it('시계가 앞선 PC: 동시 쓰기에서는 이기지만, 그 값을 본 뒤에 쓴 기록이 다시 이긴다', () => {
    const fast = makePeer('amy'); // 시계가 70분 앞섰다.
    const slow = makePeer('zoe');
    const AHEAD = 70 * MIN;

    // 동시에 시작하면 이름이 작아도 시계가 앞선 쪽이 이긴다.
    const fastTest = startTest(fast, T0 + AHEAD);
    startTest(slow, T0 + 1);
    exchange(fast, slow, T0 + 2);
    assert.equal(slow.replica.view(T0).test?.test_id, fastTest.testId);

    // 같은 이름이 두 PC 를 오간다. 앞선 PC 에서 쓴 presence 를 본 뒤 정상 PC 에서 쓰면 lc+1 이라 이긴다.
    const onFast = makePeer('bob');
    const ahead = apply(onFast, { type: 'set_presence', patch: { status: 'working' } }, T0 + AHEAD);
    sendChange(onFast, slow, ahead.records, T0 + 3);
    const onNormal = makePeer('bob', { generation: 1 });
    sendSnapshot(slow, onNormal, T0 + 4);
    const after = apply(onNormal, { type: 'set_presence', patch: { status: 'ready' } }, T0 + 5);
    assert.equal(after.record.lc, T0 + AHEAD + 1);
    const merged = sendChange(onNormal, slow, after.records, T0 + 6);
    assert.equal(merged.applied.length, 1, '영구히 덮어쓰지 못하는 일은 없다');
    assert.equal(slow.replica.view(T0).presences.find((p) => p.peer === 'bob')?.status, 'ready');

    // 앞선 PC 의 stop 을 본 뒤에 쓴 주장은 벽시계가 70분 작아도 중단 뒤 기록이다.
    const scenario = startScenario(slow, T0 + 7);
    sendChange(slow, fast, scenario.records, T0 + 7);
    const stop = apply(fast, { type: 'stop_test', reason: 'user', detail: '' }, T0 + AHEAD + 8);
    sendChange(fast, slow, stop.records, T0 + 9);
    const claim = recordClaim(slow, scenario.scenarioId, T0 + 10);
    assert.ok(claim.record.wall < stop.record.wall);
    assert.equal(claim.changes[0]?.type === 'claim_added' ? claim.changes[0].claim.late : false, true);
  });

  it('시계가 크게 다른 PC 와 시간 제한: 70분 앞선 PC 가 60분 제한의 테스트를 받아도 바로 중단되지 않는다', () => {
    const alice = makePeer('alice');
    const fast = makePeer('fast');
    const AHEAD = 70 * MIN;
    const started = startTest(alice, T0, { minutes: 60 });

    // fast 의 벽시계는 started_wall + 제한을 이미 지났다. 기한은 각자의 경과 시간으로 잰다.
    const merged = sendChange(alice, fast, started.records, T0 + AHEAD);
    assert.equal(merged.changes[0]?.type === 'test_started' ? merged.changes[0].test.elapsed_ms : -1, 0);
    assert.equal(fast.replica.testElapsed(T0 + AHEAD), 0);
    const view = fast.replica.view(T0 + AHEAD + SEC).test;
    assert.ok(view !== null && view !== undefined);
    assert.equal(view.started_wall, T0, 'started_wall 은 표시용으로 그대로 둔다');
    assert.equal(view.elapsed_ms, SEC);
    assert.equal(view.remaining_ms, 60 * MIN - SEC);
    startScenario(fast, T0 + AHEAD + 2 * SEC);

    // 59분 59초까지는 새 시나리오를 시작할 수 있고, 60분에 닿으면 거절한다. 자기 벽시계로 잰 시간이다.
    startScenario(fast, T0 + AHEAD + 60 * MIN - 1);
    assert.equal(refuse(fast, NEW_SCENARIO, T0 + AHEAD + 60 * MIN), 'TIME_LIMIT_REACHED');

    // 반대 방향: 시계가 뒤진 PC 가 앞선 PC 의 테스트를 받아도 60분을 다 쓴다.
    const slow = makePeer('slow');
    const byFast = startTest(makePeer('zed'), T0 + AHEAD, { minutes: 60 });
    slow.replica.mergeRemote(byFast.records, { from: 'zed', snapshot: false }, T0);
    assert.equal(slow.replica.view(T0 + 59 * MIN).test?.remaining_ms, MIN);
    assert.equal(refuse(slow, NEW_SCENARIO, T0 + 60 * MIN), 'TIME_LIMIT_REACHED');
  });

  it('테스트 도중에 경과 시간을 다시 받는다: 10분째에 10분을 몇 번 받아도 불어나지 않고 60분에 끝난다', () => {
    const alice = makePeer('alice');
    const carol = makePeer('carol');
    const started = startTest(carol, T0, { minutes: 60 });
    sendChange(carol, alice, started.records, T0);
    const at = T0 + 10 * MIN;

    // A–C 링크가 닫혔다 다시 열린다. 양쪽 sync_end 가 10분을 싣는다. 부분 mesh 에서는 30~35초마다 되풀이된다.
    for (let round = 0; round < 40; round += 1) {
      const now = at + round * 30 * SEC;
      const fromCarol = carol.replica.testElapsed(now) as number;
      const fromAlice = alice.replica.testElapsed(now) as number;
      exchange(alice, carol, now);
      // 건너오는 데 200ms 가 걸렸다.
      assert.equal(alice.replica.adoptElapsed(started.testId, fromCarol, now + 200), false);
      assert.equal(carol.replica.adoptElapsed(started.testId, fromAlice, now + 200), false);
      assert.equal(alice.replica.testElapsed(now + 200), 10 * MIN + round * 30 * SEC + 200);
      assert.equal(carol.replica.testElapsed(now + 200), 10 * MIN + round * 30 * SEC + 200);
    }
    assert.equal(alice.replica.testElapsed(T0 + 30 * MIN), 30 * MIN, '몇 번을 주고받아도 불어나지 않는다');
    startScenario(alice, T0 + 60 * MIN - 1);
    assert.equal(refuse(alice, NEW_SCENARIO, T0 + 60 * MIN), 'TIME_LIMIT_REACHED');
    assert.equal(refuse(carol, NEW_SCENARIO, T0 + 60 * MIN), 'TIME_LIMIT_REACHED');
  });

  it('서로 닿지 않는 동안 각자 시작한 테스트: 진 테스트의 경과 시간이 남은 테스트에 섞이지 않는다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    const a = startTest(alice, T0, { minutes: 60 });
    const b = startTest(bob, T0 + 30 * MIN, { minutes: 60 });

    // 31분에 A–B 링크가 열린다. 양쪽이 받기 전에 자기 스냅샷과 sync_end 를 보낸다.
    const now = T0 + 31 * MIN;
    const fromAlice = { testId: a.testId, ms: alice.replica.testElapsed(now) as number };
    const fromBob = { testId: b.testId, ms: bob.replica.testElapsed(now) as number };
    assert.deepEqual([fromAlice.ms, fromBob.ms], [31 * MIN, MIN]);
    const { toA, toB } = exchange(alice, bob, now);
    assert.deepEqual(changeTypes(toA.changes), ['test_replaced'], 'lc 가 큰 bob 의 테스트가 남는다');
    assert.deepEqual(toB.changes, []);

    // 진 쪽이 보낸 sync_end 는 test_id 가 달라 무시된다.
    assert.equal(bob.replica.adoptElapsed(fromAlice.testId, fromAlice.ms, now), false);
    assert.equal(bob.replica.testElapsed(now), MIN, '진 테스트의 31분이 섞이지 않는다');
    // 진 쪽은 남은 테스트를 처음 안 것으로 0 에서 시작하고, 상대의 값이 더 크면 따른다.
    assert.equal(alice.replica.testElapsed(now), 0);
    assert.equal(alice.replica.adoptElapsed(fromBob.testId, fromBob.ms, now), true);
    assert.equal(alice.replica.testElapsed(now), MIN);
    assert.equal(alice.replica.view(now).test?.remaining_ms, 59 * MIN);
    // 예전 테스트의 값은 이제 내 테스트의 것이 아니다.
    assert.equal(alice.replica.adoptElapsed(a.testId, 31 * MIN, now), false);
  });

  it('서로 닿지 않는 동안 각자 시작한 테스트: 먼저 시작한 쪽이 남으면 늦게 시작한 쪽이 그 값을 따른다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    // bob 의 시계가 40분 뒤져 있어, 30분 늦게 시작했는데도 lc 가 작다.
    const a = startTest(alice, T0, { minutes: 60 });
    const b = startTest(bob, T0 + 30 * MIN - 40 * MIN, { minutes: 60 });
    const real = 31 * MIN;
    const aliceNow = T0 + real;
    const bobNow = T0 + real - 40 * MIN;
    const fromAlice = alice.replica.testElapsed(aliceNow) as number;
    const fromBob = bob.replica.testElapsed(bobNow) as number;
    const toB = bob.replica.mergeRemote(alice.replica.snapshot(), { from: 'alice', snapshot: true }, bobNow);
    alice.replica.mergeRemote([...b.records], { from: 'bob', snapshot: true }, aliceNow);
    assert.deepEqual(changeTypes(toB.changes), ['test_replaced']);
    assert.equal(alice.replica.view(aliceNow).test?.test_id, a.testId);

    assert.equal(alice.replica.adoptElapsed(b.testId, fromBob, aliceNow), false);
    assert.equal(alice.replica.testElapsed(aliceNow), 31 * MIN);
    assert.equal(bob.replica.testElapsed(bobNow), 0);
    assert.equal(bob.replica.adoptElapsed(a.testId, fromAlice, bobNow), true);
    assert.equal(bob.replica.testElapsed(bobNow), 31 * MIN);
  });

  it('링크가 끊긴 동안 생긴 기록: 링크가 다시 열리면 전체 동기화로 채운다', () => {
    const alice = makePeer('alice');
    const bob = makePeer('bob');
    sendChange(alice, bob, startTest(alice, T0).records, T0);
    const shared = startScenario(alice, T0 + 1);
    sendChange(alice, bob, shared.records, T0 + 1);

    // 끊긴 동안 양쪽이 쓴 변경은 서로 가지 않는다.
    apply(alice, { type: 'set_presence', patch: { role: '강사' } }, T0 + 10);
    const claimA = recordClaim(alice, shared.scenarioId, T0 + 11);
    startScenario(bob, T0 + 12, '끊긴 동안 bob 이 시작');
    const claimB = recordClaim(bob, shared.scenarioId, T0 + 13, 'fail');
    apply(bob, { type: 'set_presence', patch: { role: '수강생' } }, T0 + 14);
    assert.notEqual(alice.replica.fingerprint(), bob.replica.fingerprint());

    const { toA, toB } = exchange(alice, bob, T0 + 60 * SEC);
    assert.equal(toA.applied.length, 3);
    assert.equal(toB.applied.length, 2);
    assert.equal(signature(alice.replica), signature(bob.replica));
    assert.deepEqual(alice.replica.view(T0 + 61 * SEC).claims.map((c) => c.claim_id), [claimA.claimId, claimB.claimId]);
    // 양쪽이 서로의 주장을 검증할 수 있다.
    recordVerification(alice, claimB.claimId, T0 + 62 * SEC);
    recordVerification(bob, claimA.claimId, T0 + 62 * SEC);
  });
});
