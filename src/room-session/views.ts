// 복제본의 판정을 tool 결과와 보고서 입력으로 옮겨 담는 순수 함수들 (mcp-interface.md 3.4, 9절).
// 판정을 다시 계산하지 않는다. shared-state 의 view 가 준 값을 이름만 바꿔 싣는다.

import { utf8ByteLength } from '../protocol/index.js';
import type { ReportClaim, ReportInput, ReportParticipant } from '../records/contract.js';
import type { ClaimView, PresenceView, ReplicaView, ScenarioView, TestView } from '../shared-state/contract.js';
import type {
  ClaimCounts,
  LinkStatus,
  ObservedClaim,
  ObservedScenario,
  ParticipantView,
  ScenarioItem,
  TestStatus,
  WaitingClaim,
} from './contract.js';
import { selfShownAs, shownAs } from './participants.js';
import type { ShownAsInput } from './participants.js';

/**
 * get_status 의 claims.waiting_for_you 에 싣는 글자 필드(action, expected, observed, steps)의 합 상한(UTF-8 바이트).
 * 주장 하나의 글자 필드는 4096바이트 넷까지라, 대기 주장이 많으면 결과가 끝없이 커진다. 호스트는 tool 결과 크기를 제한한다.
 * wait_for_messages 의 한 번 상한(24000바이트)의 절반쯤으로 둔다. 첫 주장은 이 값을 넘어도 싣는다(검토 3차 PRODUCT-R3-01).
 */
export const WAITING_TEXT_BUDGET_BYTES = 12_000;
/** 입장 결과와 get_status 의 test.scenarios.items 에 싣는 유효 시나리오의 수(최근 것). 기본 시나리오 한도와 같다. */
export const SCENARIO_ITEMS_MAX = 20;

/** 표시용 시각(UTC ISO 8601). 날짜로 바꿀 수 없는 수면 fallback 을 쓴다. 피어가 준 벽시계는 믿을 수 없다. */
export function toIso(wall: number, fallback: number): string {
  const date = new Date(wall);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

/** 한도 안의 유효 시나리오 가운데 최근 SCENARIO_ITEMS_MAX 개와, 싣지 못한 앞쪽의 수. */
function scenarioItems(scenarios: readonly ScenarioView[]): { items: ScenarioItem[]; omitted: number } {
  const valid = scenarios.filter((scenario) => !scenario.over_limit);
  const shown = valid.slice(Math.max(0, valid.length - SCENARIO_ITEMS_MAX));
  return {
    items: shown.map((scenario) => ({
      scenario_id: scenario.scenario_id,
      index: scenario.index,
      title: scenario.title,
      by: scenario.by,
      actor: scenario.actor,
      verifier: scenario.verifier,
    })),
    omitted: valid.length - shown.length,
  };
}

export function testStatus(test: TestView | null, scenarios: readonly ScenarioView[], now: number): TestStatus | null {
  if (test === null) return null;
  const listed = scenarioItems(scenarios);
  return {
    test_id: test.test_id,
    request: test.request,
    by: test.by,
    started: toIso(test.started_wall, now),
    max_duration_min: test.max_duration_min,
    // 이 프로세스가 잰 경과 시간으로 계산한 값이다. 분으로 올림한다.
    remaining_min: test.remaining_ms <= 0 ? 0 : Math.ceil(test.remaining_ms / 60_000),
    stopped:
      test.stopped === null
        ? null
        : {
            reason: test.stopped.reason,
            by: test.stopped.by,
            at: toIso(test.stopped.wall, now),
            detail: test.stopped.detail,
          },
    scenarios: { used: test.scenarios_used, max: test.max_scenarios, items: listed.items, items_omitted: listed.omitted },
  };
}

/** 관전 요약의 시나리오. 한도 초과를 포함해 전부 싣는다(architecture.md 3.10 의 관전 모드). */
export function observedScenarios(scenarios: readonly ScenarioView[], now: number): ObservedScenario[] {
  return scenarios.map((scenario) => ({
    scenario_id: scenario.scenario_id,
    index: scenario.index,
    title: scenario.title,
    by: scenario.by,
    plan: scenario.plan,
    actor: scenario.actor,
    verifier: scenario.verifier,
    over_limit: scenario.over_limit,
    wall: toIso(scenario.wall, now),
  }));
}

/** 관전 요약의 주장. 전부 싣는다. 검증은 판정에서 뺀 것(counted 거짓)도 싣는다. */
export function observedClaims(claims: readonly ClaimView[], now: number): ObservedClaim[] {
  return claims.map((claim) => ({
    claim_id: claim.claim_id,
    scenario_id: claim.scenario_id,
    by: claim.by,
    outcome: claim.outcome,
    action: claim.action,
    expected: claim.expected,
    observed: claim.observed,
    steps: claim.steps,
    status: claim.status,
    late: claim.late,
    wall: toIso(claim.wall, now),
    verifications: claim.verifications.map((verification) => ({
      by: verification.by,
      result: verification.result,
      evidence: verification.evidence,
      counted: verification.counted,
      wall: toIso(verification.wall, now),
    })),
  }));
}

function textBytes(claim: ClaimView): number {
  return utf8ByteLength(claim.action) + utf8ByteLength(claim.expected ?? '') + utf8ByteLength(claim.observed) + utf8ByteLength(claim.steps);
}

export function claimCounts(claims: readonly ClaimView[], selfNames: ReadonlySet<string>): ClaimCounts {
  let confirmed = 0;
  let refuted = 0;
  let unverified = 0;
  let late = 0;
  const waiting: WaitingClaim[] = [];
  let budget = WAITING_TEXT_BUDGET_BYTES;
  let full = true;
  for (const claim of claims) {
    if (claim.late) {
      late += 1;
      continue;
    }
    if (claim.status === 'confirmed') confirmed += 1;
    else if (claim.status === 'refuted') refuted += 1;
    else {
      unverified += 1;
      // 내가 쓴 주장과, 내가 이미 검증을 남긴 주장(unable 포함)은 나를 기다리는 것이 아니다.
      const mine = selfNames.has(claim.by) || claim.verifications.some((verification) => selfNames.has(verification.by));
      if (mine) continue;
      // 순서를 지킨다. 한 번 상한에 걸리면 그 뒤의 주장은 작아도 글자 필드를 싣지 않는다(앞의 것부터 검증하게 한다).
      const bytes = textBytes(claim);
      const withText = waiting.length === 0 || (full && bytes <= budget);
      if (withText) budget -= bytes;
      else full = false;
      waiting.push({
        claim_id: claim.claim_id,
        scenario_id: claim.scenario_id,
        by: claim.by,
        outcome: claim.outcome,
        action: withText ? claim.action : null,
        expected: withText ? claim.expected : null,
        observed: withText ? claim.observed : null,
        steps: withText ? claim.steps : null,
        text_omitted: !withText,
      });
    }
  }
  return { confirmed, refuted, unverified, late, waiting_for_you: waiting };
}

/** 참가자 한 명의 연결 쪽 사실. presence 를 뺀 shown_as 의 입력이다. */
export interface PeerFacts extends Omit<ShownAsInput, 'linkOpen' | 'status' | 'listening'> {
  readonly link: LinkStatus;
}

export function participantView(name: string, presence: PresenceView | undefined, facts: PeerFacts): ParticipantView {
  const status = presence?.status ?? null;
  const listening = presence?.listening ?? null;
  return {
    name,
    client: presence?.client ?? null,
    tools: presence === undefined ? null : [...presence.tools],
    role: presence?.role ?? null,
    status,
    link: facts.link,
    listening,
    shown_as: shownAs({
      linkOpen: facts.link === 'open',
      status,
      listening,
      inServerList: facts.inServerList,
      failedRepeatedly: facts.failedRepeatedly,
      versionMismatch: facts.versionMismatch,
      leftByBye: facts.leftByBye,
      everLinked: facts.everLinked,
    }),
  };
}

/** create 결과에 싣는 자기 행. 링크는 none 이고 표시는 자기 status 로만 정한다. */
export function selfParticipant(name: string, presence: PresenceView | undefined, fallbackClient: string): ParticipantView {
  const status = presence?.status ?? 'joined';
  return {
    name,
    client: presence?.client ?? fallbackClient,
    tools: presence === undefined ? [] : [...presence.tools],
    role: presence?.role ?? null,
    status,
    link: 'none',
    listening: presence?.listening ?? false,
    shown_as: selfShownAs(status),
  };
}

const GONE: ReadonlySet<string> = new Set(['disconnected', 'left', 'unreachable']);

function reportClaim(
  claim: ClaimView,
  scenario: ScenarioView,
  shownAsOf: ReadonlyMap<string, string>,
): ReportClaim {
  let reason: ReportClaim['unverified_reason'] = null;
  if (claim.classification === 'unverified') {
    const counted = claim.verifications.filter((verification) => verification.counted);
    if (scenario.over_limit) reason = 'over_limit';
    else if (counted.some((verification) => verification.result === 'unable')) reason = 'unable';
    else if (scenario.verifier !== null && GONE.has(shownAsOf.get(scenario.verifier) ?? '')) reason = 'verifier_disconnected';
    else reason = 'no_verification';
  }
  return {
    claim_id: claim.claim_id,
    by: claim.by,
    wall: claim.wall,
    action: claim.action,
    expected: claim.expected,
    observed: claim.observed,
    outcome: claim.outcome,
    steps: claim.steps,
    classification: claim.classification,
    unverified_reason: reason,
    verifications: claim.verifications.map((verification) => ({
      by: verification.by,
      wall: verification.wall,
      result: verification.result,
      evidence: verification.evidence,
      counted: verification.counted,
    })),
  };
}

/** 복제본의 view 를 보고서 입력으로 옮긴다. 작성자 자신도 참가자에 넣는다(shown_as 는 null). */
export function reportInput(
  view: ReplicaView,
  test: TestView,
  fingerprint: string,
  self: string,
  others: readonly ParticipantView[],
): ReportInput {
  const mine = view.presences.find((presence) => presence.peer === self);
  const participants: ReportParticipant[] = [
    {
      name: self,
      client: mine?.client ?? null,
      tools: mine === undefined ? null : [...mine.tools],
      role: mine?.role ?? null,
      status: mine?.status ?? null,
      shown_as: null,
    },
    ...others.map((other) => ({
      name: other.name,
      client: other.client,
      tools: other.tools,
      role: other.role,
      status: other.status,
      shown_as: other.shown_as,
    })),
  ];
  const shownAsOf = new Map(others.map((other) => [other.name, other.shown_as as string]));
  return {
    fingerprint,
    test: {
      test_id: test.test_id,
      request: test.request,
      requested_by: test.by,
      started_wall: test.started_wall,
      max_duration_min: test.max_duration_min,
      max_scenarios: test.max_scenarios,
      scenarios_used: test.scenarios_used,
      stop:
        test.stopped === null
          ? null
          : { by: test.stopped.by, wall: test.stopped.wall, reason: test.stopped.reason, detail: test.stopped.detail },
    },
    participants,
    scenarios: view.scenarios.map((scenario) => ({
      scenario_id: scenario.scenario_id,
      index: scenario.index,
      title: scenario.title,
      by: scenario.by,
      wall: scenario.wall,
      over_limit: scenario.over_limit,
      claims: view.claims
        .filter((claim) => claim.scenario_id === scenario.scenario_id)
        .map((claim) => reportClaim(claim, scenario, shownAsOf)),
    })),
  };
}
