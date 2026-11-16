// 도메인 변화 계산. 한 번의 applyLocal·mergeRemote 앞뒤의 파생 판정을 견줘서 낸다.
// 기록이 온 순서가 아니라 앞뒤의 차이로 내므로, 묶음 안의 순서가 어떻든 같은 변화가 나온다.

import type { PresenceRecord } from '../protocol/index.js';
import type { PresenceBody, StateChange } from './contract.js';
import {
  claimView,
  compareText,
  scenarioView,
  statusOf,
  stopView,
  testView,
  verificationView,
  type Derived,
  type VerificationEntry,
} from './derive.js';

/** 한 번만 내기로 한 변화를 이미 냈는지. 복제본이 갖는다. */
export interface ChangeMemory {
  /** test_stopped 를 낸 테스트. */
  stoppedTestId: string | null;
  /** scenario_over_limit 을 낸 시나리오. */
  readonly overAnnounced: Set<string>;
}

export interface PresenceDelta {
  readonly previous: PresenceBody | null;
  readonly current: PresenceRecord;
}

interface Item {
  readonly lc: number;
  readonly rank: number;
  readonly author: string;
  readonly id: string;
  readonly change: StateChange;
}

/**
 * 변화는 바탕 기록의 `(lc, author)` 순으로 낸다. 본 뒤에 쓴 기록은 lc 가 더 크므로
 * 테스트 → 시나리오 → 주장 → 검증의 순서가 지켜진다. 한도 초과는 밀려난 시나리오의 자리에 둔다.
 */
function byRecordOrder(a: Item, b: Item): number {
  return a.lc - b.lc || a.rank - b.rank || compareText(a.author, b.author) || compareText(a.id, b.id);
}

export function diffChanges(
  before: Derived,
  after: Derived,
  presences: Iterable<PresenceDelta>,
  elapsedMs: number,
  memory: ChangeMemory,
): StateChange[] {
  const items: Item[] = [];

  for (const { previous, current } of presences) {
    items.push({
      lc: current.lc,
      rank: 1,
      author: current.author,
      id: current.key,
      change: { type: 'presence_changed', peer: current.author, previous, current: current.body },
    });
  }

  const test = after.test;
  if (test === null) return items.sort(byRecordOrder).map((item) => item.change);

  const testId = test.body.test_id;
  const sameTest = before.test !== null && before.test.body.test_id === testId;
  if (!sameTest) {
    memory.overAnnounced.clear();
    const view = testView({ ...after, test }, elapsedMs);
    items.push({
      lc: test.lc,
      rank: 0,
      author: test.author,
      id: testId,
      change:
        before.test === null
          ? { type: 'test_started', test: view }
          : { type: 'test_replaced', test: view, previous_test_id: before.test.body.test_id },
    });
  }

  // 테스트가 바뀌었으면 새 테스트의 기록은 모두 처음 보는 것이다.
  const known = sameTest ? before : null;

  for (const entry of after.scenarios) {
    const { record } = entry;
    const prior = known?.scenarioById.get(record.rid);
    if (entry.overLimit) {
      if (memory.overAnnounced.has(record.rid)) continue;
      memory.overAnnounced.add(record.rid);
      items.push({
        lc: record.lc,
        rank: 2,
        author: record.author,
        id: record.rid,
        change: { type: 'scenario_over_limit', scenario: scenarioView(entry) },
      });
    } else if (prior === undefined) {
      items.push({
        lc: record.lc,
        rank: 2,
        author: record.author,
        id: record.rid,
        change: { type: 'scenario_started', scenario: scenarioView(entry) },
      });
    }
  }

  for (const entry of after.claims) {
    const { record } = entry;
    const prior = known?.claimById.get(record.rid);
    if (prior === undefined) {
      items.push({
        lc: record.lc,
        rank: 3,
        author: record.author,
        id: record.rid,
        change: { type: 'claim_added', claim: claimView(entry) },
      });
    }
    const seen = new Set((prior?.verifications ?? []).map((verification) => verification.record.rid));
    if (entry.verifications.every((verification) => seen.has(verification.record.rid))) continue;
    // 함께 들어온 검증이 여럿이면 순서대로 하나씩 반영한 상태를 싣는다.
    const included: VerificationEntry[] = entry.verifications.filter((verification) => seen.has(verification.record.rid));
    for (const verification of entry.verifications) {
      if (seen.has(verification.record.rid)) continue;
      included.push(verification);
      items.push({
        lc: verification.record.lc,
        rank: 4,
        author: verification.record.author,
        id: verification.record.rid,
        change: {
          type: 'verification_added',
          claim_id: record.rid,
          claim_by: record.author,
          verification: verificationView(verification),
          claim_status: statusOf(included),
        },
      });
    }
  }

  if (after.stop !== null && memory.stoppedTestId !== testId && (known === null || known.stop === null)) {
    memory.stoppedTestId = testId;
    items.push({
      lc: after.stop.lc,
      rank: 5,
      author: after.stop.author,
      id: after.stop.rid,
      change: { type: 'test_stopped', test_id: testId, stop: stopView(after.stop) },
    });
  }

  return items.sort(byRecordOrder).map((item) => item.change);
}
