// 파생 판정 (protocol.md 5.5). 복제본의 기록에서 계산하고 저장하지 않는다.
// 같은 기록 집합이면 모든 참가자가 같은 값을 얻어야 하므로, 여기서는 시각과 "나"를 보지 않는다.

import { TEST_KEY } from '../protocol/index.js';
import type {
  AppendRecord,
  ClaimRecord,
  KeyRecord,
  ScenarioRecord,
  StopRecord,
  TestRecord,
  VerificationRecord,
} from '../protocol/index.js';
import type {
  ClaimClass,
  ClaimStatus,
  ClaimView,
  ScenarioView,
  StopView,
  TestView,
  VerificationView,
} from './contract.js';

export interface ScenarioEntry {
  readonly record: ScenarioRecord;
  /** 현재 테스트 안의 순번. 1부터다. */
  readonly index: number;
  readonly overLimit: boolean;
}

export interface VerificationEntry {
  readonly record: VerificationRecord;
  readonly counted: boolean;
}

export interface ClaimEntry {
  readonly record: ClaimRecord;
  readonly verifications: readonly VerificationEntry[];
  readonly status: ClaimStatus;
  readonly late: boolean;
  readonly classification: ClaimClass;
}

export interface Derived {
  readonly test: TestRecord | null;
  /** 중단 시점의 stop 기록. */
  readonly stop: StopRecord | null;
  readonly scenarios: readonly ScenarioEntry[];
  readonly scenarioById: ReadonlyMap<string, ScenarioEntry>;
  readonly validScenarios: number;
  readonly claims: readonly ClaimEntry[];
  readonly claimById: ReadonlyMap<string, ClaimEntry>;
}

/** 이름과 rid 의 비교는 JavaScript 문자열 `<` 다. 허용 문자가 ASCII 라 참가자마다 같다. */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 추가 기록의 순서 `(lc, author, rid)`. 중단 시점, 시나리오 순번, 표시 순서가 모두 이것을 쓴다. */
export function compareAppend(a: AppendRecord, b: AppendRecord): number {
  return a.lc - b.lc || compareText(a.author, b.author) || compareText(a.rid, b.rid);
}

/** 판정에 넣는 검증(작성자 ≠ 주장 작성자)만으로 정한다. 반박이 하나라도 있으면 반박됨이다. */
export function statusOf(verifications: readonly VerificationEntry[]): ClaimStatus {
  let confirmed = false;
  for (const entry of verifications) {
    if (!entry.counted) continue;
    if (entry.record.body.result === 'refuted') return 'refuted';
    if (entry.record.body.result === 'confirmed') confirmed = true;
  }
  return confirmed ? 'confirmed' : 'unverified';
}

function classify(record: ClaimRecord, status: ClaimStatus, late: boolean, overLimit: boolean): ClaimClass {
  // 중단 뒤 기록은 확인을 받아도 성공·실패에 세지 않는다.
  if (late) return 'late';
  if (overLimit) return 'unverified';
  if (record.body.outcome === 'pass' && status === 'confirmed') return 'passed';
  if (record.body.outcome === 'fail' && status === 'confirmed') return 'failed';
  if (record.body.outcome === 'pass' && status === 'refuted') return 'failed';
  return 'unverified';
}

const NO_TEST: Derived = Object.freeze({
  test: null,
  stop: null,
  scenarios: Object.freeze([]),
  scenarioById: new Map<string, ScenarioEntry>(),
  validScenarios: 0,
  claims: Object.freeze([]),
  claimById: new Map<string, ClaimEntry>(),
});

export function derive(keyed: ReadonlyMap<string, KeyRecord>, appended: Iterable<AppendRecord>): Derived {
  const current = keyed.get(TEST_KEY);
  if (current === undefined || current.kind !== 'test') return NO_TEST;
  const testId = current.body.test_id;

  const stops: StopRecord[] = [];
  const scenarioRecords: ScenarioRecord[] = [];
  const claimRecords: ClaimRecord[] = [];
  const byClaim = new Map<string, VerificationRecord[]>();
  for (const record of appended) {
    // 진 테스트의 기록은 남아 있어도 판정에 들지 않는다.
    if (record.body.test_id !== testId) continue;
    if (record.kind === 'stop') stops.push(record);
    else if (record.kind === 'scenario') scenarioRecords.push(record);
    else if (record.kind === 'claim') claimRecords.push(record);
    else {
      const list = byClaim.get(record.body.claim);
      if (list === undefined) byClaim.set(record.body.claim, [record]);
      else list.push(record);
    }
  }

  stops.sort(compareAppend);
  const stop = stops[0] ?? null;

  scenarioRecords.sort(compareAppend);
  const max = current.body.max_scenarios;
  const scenarios = scenarioRecords.map(
    (record, i): ScenarioEntry => ({ record, index: i + 1, overLimit: i + 1 > max }),
  );
  const scenarioById = new Map(scenarios.map((entry) => [entry.record.rid, entry]));

  claimRecords.sort(compareAppend);
  const claims = claimRecords.map((record): ClaimEntry => {
    const verifications = (byClaim.get(record.rid) ?? [])
      .sort(compareAppend)
      // 자기 검증은 어떤 경로로 들어와도 판정에 넣지 않는다. 저장은 한다.
      .map((verification): VerificationEntry => ({ record: verification, counted: verification.author !== record.author }));
    const status = statusOf(verifications);
    const late = stop !== null && record.lc > stop.lc;
    const overLimit = scenarioById.get(record.body.scenario)?.overLimit ?? false;
    return { record, verifications, status, late, classification: classify(record, status, late, overLimit) };
  });

  return {
    test: current,
    stop,
    scenarios,
    scenarioById,
    validScenarios: Math.min(scenarios.length, max),
    claims,
    claimById: new Map(claims.map((entry) => [entry.record.rid, entry])),
  };
}

// ── view 로 옮기기 ──────────────────────────────────────────────────────────

export function stopView(record: StopRecord): StopView {
  return {
    stop_id: record.rid,
    reason: record.body.reason,
    detail: record.body.detail,
    by: record.author,
    lc: record.lc,
    wall: record.wall,
  };
}

export function testView(derived: Derived & { readonly test: TestRecord }, elapsedMs: number): TestView {
  const body = derived.test.body;
  return {
    test_id: body.test_id,
    request: body.request,
    by: derived.test.author,
    started_wall: body.started_wall,
    max_duration_min: body.max_duration_min,
    max_scenarios: body.max_scenarios,
    elapsed_ms: elapsedMs,
    remaining_ms: Math.max(0, body.max_duration_min * 60_000 - elapsedMs),
    scenarios_used: derived.validScenarios,
    stopped: derived.stop === null ? null : stopView(derived.stop),
  };
}

export function scenarioView(entry: ScenarioEntry): ScenarioView {
  const { record } = entry;
  return {
    scenario_id: record.rid,
    index: entry.index,
    title: record.body.title,
    plan: record.body.plan,
    actor: record.body.actor ?? null,
    verifier: record.body.verifier ?? null,
    by: record.author,
    lc: record.lc,
    wall: record.wall,
    over_limit: entry.overLimit,
  };
}

export function verificationView(entry: VerificationEntry): VerificationView {
  const { record } = entry;
  return {
    verification_id: record.rid,
    by: record.author,
    lc: record.lc,
    wall: record.wall,
    result: record.body.result,
    evidence: record.body.evidence,
    counted: entry.counted,
  };
}

export function claimView(entry: ClaimEntry): ClaimView {
  const { record } = entry;
  return {
    claim_id: record.rid,
    scenario_id: record.body.scenario,
    by: record.author,
    lc: record.lc,
    wall: record.wall,
    action: record.body.action,
    expected: record.body.expected,
    observed: record.body.observed,
    outcome: record.body.outcome,
    steps: record.body.steps,
    status: entry.status,
    late: entry.late,
    classification: entry.classification,
    verifications: entry.verifications.map(verificationView),
  };
}
