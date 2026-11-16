// get_status 와 입장 결과의 크기 상한 (검토 3차 PRODUCT-R3-01, mcp-interface.md 3.4).
// 나를 기다리는 주장의 글자 필드와 시나리오 목록을 싣되, 결과가 끝없이 커지지 않게 한다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { utf8ByteLength } from '../protocol/index.js';
import type { ClaimView, ScenarioView, TestView } from '../shared-state/contract.js';
import { SCENARIO_ITEMS_MAX, WAITING_TEXT_BUDGET_BYTES, claimCounts, testStatus } from './views.js';

const T0 = 1_800_000_000_000;

function claim(id: string, by: string, text: string, more: Partial<ClaimView> = {}): ClaimView {
  return {
    claim_id: id,
    scenario_id: 'sc-1',
    by,
    lc: T0,
    wall: T0,
    action: `${text}-action`,
    expected: null,
    observed: `${text}-observed`,
    outcome: 'pass',
    steps: `${text}-steps`,
    status: 'unverified',
    late: false,
    classification: 'unverified',
    verifications: [],
    ...more,
  };
}

function scenario(index: number, more: Partial<ScenarioView> = {}): ScenarioView {
  return {
    scenario_id: `sc-${index}`,
    index,
    title: `시나리오 ${index}`,
    plan: '계획은 싣지 않는다',
    actor: null,
    verifier: null,
    by: 'A',
    lc: T0 + index,
    wall: T0 + index,
    over_limit: false,
    ...more,
  };
}

const TEST: TestView = {
  test_id: 't-1',
  request: '요청',
  by: 'A',
  started_wall: T0,
  max_duration_min: 60,
  max_scenarios: 100,
  elapsed_ms: 0,
  remaining_ms: 60 * 60_000,
  scenarios_used: 0,
  stopped: null,
};

describe('views: 나를 기다리는 주장 (검토 3차 PRODUCT-R3-01)', () => {
  it('내 것, 내가 이미 검증한 것, 중단 뒤 기록, 확인·반박된 것은 빼고 나머지를 내용과 함께 싣는다', () => {
    const counts = claimCounts(
      [
        claim('c1', 'A', 'one', { expected: '기대' }),
        claim('c2', 'me', 'mine'),
        claim('c3', 'A', 'verified', { verifications: [{ verification_id: 'v', by: 'me', lc: T0, wall: T0, result: 'unable', evidence: 'e', counted: true }] }),
        claim('c4', 'A', 'late', { late: true }),
        claim('c5', 'B', 'confirmed', { status: 'confirmed' }),
      ],
      new Set(['me']),
    );
    assert.deepEqual(counts.waiting_for_you, [
      { claim_id: 'c1', scenario_id: 'sc-1', by: 'A', outcome: 'pass', action: 'one-action', expected: '기대', observed: 'one-observed', steps: 'one-steps', text_omitted: false },
    ]);
    assert.deepEqual([counts.confirmed, counts.unverified, counts.late], [1, 3, 1]);
  });

  it(`글자 필드의 합이 ${WAITING_TEXT_BUDGET_BYTES}바이트를 넘는 뒤쪽 주장은 글자 필드를 싣지 않고 text_omitted 로 알린다. 첫 주장은 늘 싣는다`, () => {
    const big = 'x'.repeat(4096);
    const claims = [0, 1, 2, 3].map((i) => claim(`c${i}`, 'A', `${i}`, { action: big, observed: big, steps: big, expected: big }));
    const waiting = claimCounts(claims, new Set(['me'])).waiting_for_you;
    assert.equal(waiting.length, 4, '대기 주장은 모두 싣는다(ID 와 작성자는 빠지지 않는다)');
    assert.equal(waiting[0]?.text_omitted, false, '하나만으로 상한을 넘어도 첫 주장은 싣는다');
    assert.equal(waiting[0]?.observed, big);
    for (const item of waiting.slice(1)) {
      assert.deepEqual([item.text_omitted, item.action, item.expected, item.observed, item.steps], [true, null, null, null, null]);
      assert.equal(item.by, 'A');
    }

    // 작은 주장은 상한 안에서 모두 싣는다.
    const small = claimCounts([claim('a', 'A', 'a'), claim('b', 'B', 'b')], new Set(['me'])).waiting_for_you;
    assert.deepEqual(small.map((item) => item.text_omitted), [false, false]);

    // 상한에 걸리면 그 뒤로는 작은 주장도 싣지 않는다(순서를 지킨다. 앞의 주장을 검증하면 다음 get_status 에 실린다).
    const half = 'y'.repeat(Math.floor(WAITING_TEXT_BUDGET_BYTES / 2));
    const mixed = claimCounts([claim('h1', 'A', 'h', { observed: half }), claim('h2', 'A', 'h', { observed: half }), claim('s', 'A', 's')], new Set(['me'])).waiting_for_you;
    assert.deepEqual(mixed.map((item) => item.text_omitted), [false, true, true]);
    const carried = mixed.filter((item) => !item.text_omitted).reduce((sum, item) => sum + [item.action, item.expected, item.observed, item.steps].reduce((s, t) => s + utf8ByteLength(t ?? ''), 0), 0);
    assert.ok(carried <= WAITING_TEXT_BUDGET_BYTES, `${carried}`);
  });
});

describe('views: 시나리오 목록 (검토 3차 PRODUCT-R3-01)', () => {
  it('한도 안의 유효 시나리오를 순번 순으로 ID·제목·시작한 참가자·행동자·검증자와 함께 싣는다. 계획과 한도 초과 시나리오는 싣지 않는다', () => {
    const status = testStatus({ ...TEST, scenarios_used: 2, max_scenarios: 2 }, [scenario(1, { actor: 'A', verifier: 'B' }), scenario(2), scenario(3, { over_limit: true })], T0);
    assert.deepEqual(status?.scenarios, {
      used: 2,
      max: 2,
      items: [
        { scenario_id: 'sc-1', index: 1, title: '시나리오 1', by: 'A', actor: 'A', verifier: 'B' },
        { scenario_id: 'sc-2', index: 2, title: '시나리오 2', by: 'A', actor: null, verifier: null },
      ],
      items_omitted: 0,
    });
    assert.equal(testStatus(null, [], T0), null);
  });

  it(`${SCENARIO_ITEMS_MAX}개를 넘으면 최근 ${SCENARIO_ITEMS_MAX}개만 싣고 뺀 수를 items_omitted 로 알린다`, () => {
    const all = Array.from({ length: SCENARIO_ITEMS_MAX + 5 }, (_, i) => scenario(i + 1));
    const status = testStatus({ ...TEST, scenarios_used: all.length }, all, T0);
    assert.equal(status?.scenarios.items.length, SCENARIO_ITEMS_MAX);
    assert.equal(status?.scenarios.items[0]?.index, 6);
    assert.equal(status?.scenarios.items.at(-1)?.index, SCENARIO_ITEMS_MAX + 5);
    assert.equal(status?.scenarios.items_omitted, 5);
  });
});
