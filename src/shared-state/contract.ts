// shared-state 의 공개 계약 (architecture.md 3.7). 병합과 판정의 규칙은 protocol.md 5절이 정한다.
// 복제본을 갖고, 로컬 명령을 검증해 기록을 만들고, 원격 기록을 병합하고, 파생 판정과 지문을 계산한다.
// 전송·파일·시계에 닿지 않는다(시각은 인자로 받는다). 수신함 사건을 만들지 않는다. 이 파일에는 타입만 있다.
// 데이터 필드의 이름은 기록과 tool 문서의 이름 그대로다.

import type {
  ClaimOutcome,
  PresenceRecord,
  PresenceStatus,
  StateRecord,
  StopReason,
  VerificationResult,
} from '../protocol/index.js';

// ── 만들기 ──────────────────────────────────────────────────────────────────

export interface ReplicaSelf {
  /** 이 입장에서 쓰는 이름. 로컬 기록의 author 가 된다. */
  readonly peer: string;
  /** 이 입장의 sid. 기록 ID(`<sid>-<순번>`)의 앞부분이 된다. */
  readonly sid: string;
}

export interface ReplicaDeps {
  readonly self: ReplicaSelf;
  /** 이 프로세스가 이 방에서 쓴 이름 전부(지금 이름 포함). 자기 검증 판정에 쓴다. */
  readonly selfNames: readonly string[];
}

// ── 명령 ────────────────────────────────────────────────────────────────────

export type PresenceBody = PresenceRecord['body'];

/**
 * 준 필드만 바꾼다. 자기 presence 가 아직 없으면 빠진 필드는
 * client 'unknown', tools [], role null, status 'joined', listening false, note null 로 채운다.
 */
export interface PresencePatch {
  readonly client?: string;
  readonly tools?: readonly string[];
  readonly role?: string | null;
  readonly status?: PresenceStatus;
  readonly listening?: boolean;
  readonly note?: string | null;
}

/**
 * 로컬에서 기록을 만드는 요청. tool 입력의 상한(글자 수, 개수, 범위)은 여기서 보지 않는다. 부르는 쪽이 건다.
 * 여기서 보는 것은 와이어 스키마(글자 필드 4096바이트, 기록 32768바이트)와 규칙이다.
 */
export type StateCommand =
  /** 자기 presence 를 쓴다. 상한과 무관하게 된다. */
  | { readonly type: 'set_presence'; readonly patch: PresencePatch }
  | {
      readonly type: 'start_test';
      readonly request: string;
      readonly max_duration_min: number;
      readonly max_scenarios: number;
    }
  /** reason 이 time_limit 이면 detail 은 빈 문자열이다. 상한과 무관하게 된다. */
  | { readonly type: 'stop_test'; readonly reason: StopReason; readonly detail: string }
  | {
      readonly type: 'start_scenario';
      readonly title: string;
      readonly plan?: string | null;
      readonly actor?: string;
      readonly verifier?: string;
    }
  | {
      readonly type: 'record_claim';
      readonly scenario_id: string;
      readonly action: string;
      readonly expected?: string | null;
      readonly observed: string;
      readonly outcome: ClaimOutcome;
      readonly steps: string;
    }
  | {
      readonly type: 'record_verification';
      readonly claim_id: string;
      readonly result: VerificationResult;
      readonly evidence: string;
    };

export type StateCommandType = StateCommand['type'];

// ── 규칙 오류 코드 ──────────────────────────────────────────────────────────

/**
 * 규칙으로 거절한 것. 기록 파일의 rule 줄과 보고서의 "거절된 호출"이 된다.
 *
 * | 코드 | 나오는 명령 | 뜻 |
 * |---|---|---|
 * | TEST_ALREADY_ACTIVE | start_test | 진행 중인 테스트가 있다 |
 * | TEST_ENDED | start_test | 이 방의 테스트가 이미 중단됐다. 방 하나에 테스트는 한 번이다 |
 * | NO_ACTIVE_TEST | stop_test, start_scenario, record_claim | test 기록이 없다 |
 * | TEST_STOPPED | start_scenario | 중단됐다 |
 * | TIME_LIMIT_REACHED | start_scenario | 경과 시간이 제한에 닿았다. 부르는 쪽이 이어서 stop_test{time_limit} 을 쓴다 |
 * | SCENARIO_LIMIT_REACHED | start_scenario | 유효 시나리오 수가 한도다 |
 * | UNKNOWN_SCENARIO | record_claim | 현재 테스트에 그 시나리오가 없다 |
 * | SCENARIO_OVER_LIMIT | record_claim | 그 시나리오가 한도 초과다 |
 * | UNKNOWN_CLAIM | record_verification | 현재 테스트에 그 주장이 없다 |
 * | SELF_VERIFY_FORBIDDEN | record_verification | 주장 작성자가 selfNames 에 있다 |
 * | STATE_FULL | start_scenario, record_claim, record_verification | 복제본이 로컬 쓰기 상한에 닿았다. 기록 수가 이미 STATE_MAX_RECORDS 이상이거나, 이 쓰기로 직렬화 크기 합이 STATE_MAX_BYTES 를 넘게 된다 |
 */
export type RuleErrorCode =
  | 'TEST_ALREADY_ACTIVE'
  | 'TEST_ENDED'
  | 'NO_ACTIVE_TEST'
  | 'TEST_STOPPED'
  | 'TIME_LIMIT_REACHED'
  | 'SCENARIO_LIMIT_REACHED'
  | 'UNKNOWN_SCENARIO'
  | 'SCENARIO_OVER_LIMIT'
  | 'UNKNOWN_CLAIM'
  | 'SELF_VERIFY_FORBIDDEN'
  | 'STATE_FULL';

/**
 * INVALID_ARGUMENT 는 만든 기록이 와이어 스키마나 크기 상한을 어긴 경우다. 규칙 거절로 세지 않는다.
 * 논리 시각이 끝에 닿은 경우도 이것이다. 지금까지 본 가장 큰 lc 가 protocol.STATE_CLOCK_MAX 이면
 * 다음 기록의 lc(본 값 + 1)를 만들 수 없다. 그 쓰기를 거절하고 detail 에 `lc: …` 로 사유를 적는다.
 * 값을 접거나 낮춰 쓰지 않는다. 그러면 "본 뒤에 쓴 기록은 더 크다"(protocol.md 5.2)가 깨진다.
 * 정상 시계로는 닿지 않는다. 결함이나 위조로 만든 기록 하나를 병합했을 때만 생기고,
 * 그 뒤로 그 방에서는 어떤 기록도(presence, stop 포함) 쓸 수 없다. 새 방에서 해야 한다.
 */
export type CommandErrorCode = RuleErrorCode | 'INVALID_ARGUMENT';

// ── 파생 판정 (view) ────────────────────────────────────────────────────────

export interface PresenceView extends PresenceBody {
  readonly peer: string;
  readonly lc: number;
  /** 작성자의 벽시계. 표시용이다. */
  readonly wall: number;
}

/** 중단 시점의 stop 기록. 현재 테스트의 stop 가운데 (lc, author, rid) 가 가장 작은 것이다. */
export interface StopView {
  readonly stop_id: string;
  readonly reason: StopReason;
  readonly detail: string;
  readonly by: string;
  readonly lc: number;
  readonly wall: number;
}

export interface TestView {
  readonly test_id: string;
  readonly request: string;
  /** test 기록을 쓴 참가자. */
  readonly by: string;
  /** 표시용. 판정에 쓰지 않는다. */
  readonly started_wall: number;
  readonly max_duration_min: number;
  readonly max_scenarios: number;
  /** view 를 부른 시각의 경과 시간. testElapsed(now) 와 같다. */
  readonly elapsed_ms: number;
  /** 제한 − 경과. 0 보다 작으면 0. */
  readonly remaining_ms: number;
  /** 유효 시나리오 수(한도 초과를 뺀 수). */
  readonly scenarios_used: number;
  readonly stopped: StopView | null;
}

export interface ScenarioView {
  readonly scenario_id: string;
  /** 현재 테스트 안의 순번. 1부터, (lc, author, rid) 순이다. */
  readonly index: number;
  readonly title: string;
  readonly plan: string | null;
  readonly actor: string | null;
  readonly verifier: string | null;
  readonly by: string;
  readonly lc: number;
  readonly wall: number;
  /** 순번이 max_scenarios 를 넘었다. 주장을 받을 수 없다. */
  readonly over_limit: boolean;
}

export type ClaimStatus = 'confirmed' | 'refuted' | 'unverified';

/**
 * 보고 분류(protocol.md 5.5).
 * - late: 중단 뒤 기록. 확인을 받아도 성공·실패에 세지 않는다.
 * - passed: outcome=pass 이고 확인됨.
 * - failed: outcome=fail 이고 확인됨, 또는 outcome=pass 인데 반박됨.
 * - unverified: 나머지. 한도 초과 시나리오의 주장도 여기에 둔다.
 */
export type ClaimClass = 'passed' | 'failed' | 'unverified' | 'late';

export interface VerificationView {
  readonly verification_id: string;
  readonly by: string;
  readonly lc: number;
  readonly wall: number;
  readonly result: VerificationResult;
  readonly evidence: string;
  /** 판정에 넣는가. 주장 작성자가 쓴 검증은 저장은 하되 거짓이다. */
  readonly counted: boolean;
}

export interface ClaimView {
  readonly claim_id: string;
  readonly scenario_id: string;
  readonly by: string;
  readonly lc: number;
  readonly wall: number;
  readonly action: string;
  readonly expected: string | null;
  readonly observed: string;
  readonly outcome: ClaimOutcome;
  readonly steps: string;
  readonly status: ClaimStatus;
  /** 주장의 lc 가 중단 시점의 lc 보다 크다. */
  readonly late: boolean;
  readonly classification: ClaimClass;
  /** (lc, author, rid) 순. */
  readonly verifications: readonly VerificationView[];
}

/** 기한을 뺀 나머지는 같은 기록 집합이면 모든 참가자가 같은 값을 얻는다. */
export interface ReplicaView {
  /** 이름 순. 떠난 참가자의 것도 있다. */
  readonly presences: readonly PresenceView[];
  readonly test: TestView | null;
  /** 현재 테스트의 시나리오. 순번 순. 테스트가 없으면 비어 있다. */
  readonly scenarios: readonly ScenarioView[];
  /** 현재 테스트의 주장. (lc, author, rid) 순. */
  readonly claims: readonly ClaimView[];
}

// ── 도메인 변화 ─────────────────────────────────────────────────────────────

/**
 * 복제본이 바뀌면서 생긴 일. 수신함 사건으로 바꾸는 일은 room-session 이 한다.
 * 현재 테스트가 아닌 test_id 의 기록은 변화를 만들지 않는다.
 */
export type StateChange =
  /** 테스트가 없던 복제본에 현재 테스트가 생겼다. 경과 시간을 0 에서 세기 시작한 때다. */
  | { readonly type: 'test_started'; readonly test: TestView }
  /** 현재 테스트가 다른 것으로 바뀌었다(동시에 시작한 둘 가운데 진 쪽). 경과 시간을 0 에서 다시 센다. */
  | { readonly type: 'test_replaced'; readonly test: TestView; readonly previous_test_id: string }
  /** 복제본이 "중단됨"이 됐다. 테스트마다 한 번만 나온다. 뒤에 온 다른 stop 기록은 변화를 만들지 않는다. */
  | { readonly type: 'test_stopped'; readonly test_id: string; readonly stop: StopView }
  /** 새 시나리오가 유효 시나리오로 들어왔다. */
  | { readonly type: 'scenario_started'; readonly scenario: ScenarioView }
  /**
   * 시나리오가 한도 초과로 판정됐다. 들어올 때부터 초과였든, 병합으로 앞 순위가 끼어들어 밀려났든 같다.
   * 시나리오마다 한 번만 나온다.
   */
  | { readonly type: 'scenario_over_limit'; readonly scenario: ScenarioView }
  | { readonly type: 'claim_added'; readonly claim: ClaimView }
  | {
      readonly type: 'verification_added';
      readonly claim_id: string;
      /** 주장 작성자. */
      readonly claim_by: string;
      readonly verification: VerificationView;
      /** 이 검증을 반영한 뒤의 주장 상태. */
      readonly claim_status: ClaimStatus;
    }
  /** 그 이름의 presence 가 새로 생겼거나 더 새 값으로 바뀌었다. */
  | {
      readonly type: 'presence_changed';
      readonly peer: string;
      readonly previous: PresenceBody | null;
      readonly current: PresenceBody;
    };

// ── 결과 ────────────────────────────────────────────────────────────────────

export type ApplyLocalResult =
  | {
      readonly ok: true;
      /** 이번에 만들어 복제본에 넣은 기록. 열린 링크에 변경으로 보낼 것이다. 이미 중단된 테스트의 stop_test 처럼 비어 있을 수 있다. */
      readonly records: readonly StateRecord[];
      readonly changes: readonly StateChange[];
    }
  | { readonly ok: false; readonly code: CommandErrorCode; readonly detail: string };

export interface MergeOrigin {
  /** 기록을 받은 링크의 피어 이름. */
  readonly from: string;
  /** 스냅샷이면 참. 변경(거짓)은 author 가 from 과 같은 기록만 받는다. */
  readonly snapshot: boolean;
}

/** `applied.length + ignored` 는 항상 받은 기록 수다. overflow 일 때도 그렇다(applied 는 비고 ignored 가 받은 수다). */
export interface MergeRemoteResult {
  /** 복제본을 바꾼 기록. 비어 있지 않으면 "다른 곳에서 기록이 들어왔다". */
  readonly applied: readonly StateRecord[];
  /** 이미 있거나 진 기록, 검증에서 버린 기록의 수. */
  readonly ignored: number;
  /**
   * 이상의 수. 세는 것은 셋이다: 스키마 위반, 변경(snapshot 이 거짓)의 author 가 from 과 다른 기록,
   * 식별자가 같은데 내용이 다른 기록. overflow 면 1 이상이다.
   */
  readonly anomalies: number;
  /** 바탕 기록의 (lc, author) 순이다. 받은 묶음 안의 순서와 무관하다. */
  readonly changes: readonly StateChange[];
  /**
   * 이 묶음을 넣으면 복제본이 STATE_MERGE_MAX_RECORDS 를 넘는다. 이때는 묶음의 기록을 하나도 넣지 않는다.
   * 부르는 쪽이 bye{protocol_error} 로 그 링크를 닫는다.
   */
  readonly overflow: boolean;
}

// ── 복제본 ──────────────────────────────────────────────────────────────────

/**
 * 동기 함수뿐이다. 한 이벤트 루프 안에서 순서대로 불린다.
 * 병합은 교환·결합·멱등이고 로컬 쓰기 상한과 무관하게 유효한 기록을 받는다.
 */
export interface Replica {
  /**
   * 명령을 검증해 기록을 만들고 복제본에 넣는다. 거절하면 아무 것도 바꾸지 않는다.
   * 만든 기록은 protocol.parseStateRecord 를 통과한 값이다. 그대로 protocol.packStateFrames 에 넘길 수 있다.
   */
  applyLocal(command: StateCommand, now: number): ApplyLocalResult;

  /** 받은 기록 묶음을 병합한다. 기록은 protocol.parseP2PFrame 을 통과한 것이다. */
  mergeRemote(records: readonly StateRecord[], origin: MergeOrigin, now: number): MergeRemoteResult;

  /**
   * 가진 모든 기록. 길이가 ping 의 sc 다. 돌려받은 배열을 고치지 않는다.
   * 모두 protocol.parseStateRecord 를 통과한 값이다. 스냅샷은 protocol.packStateFrames 로 나간다.
   * 그 함수가 기록마다 다시 검증하고, 걸리면 BAD_FRAME 으로 프레임을 만들지 않는다.
   */
  snapshot(): readonly StateRecord[];

  view(now: number): ReplicaView;

  /** protocol.stateFingerprint 와 같은 값. ping 의 sf, 답하는 sync_end 의 sf, 보고서의 상태 지문이다. */
  fingerprint(): string;

  /** 현재 테스트의 경과 시간(ms, 0 이상). 테스트가 없으면 null. */
  testElapsed(now: number): number | null;

  /**
   * sync_end 로 받은 경과 시간을 넘겨받는다. testId 가 현재 테스트이고 ms 가 testElapsed(now) 보다 클 때만
   * 이미 흐른 시간을 ms 로, 기준 시각을 now 로 함께 바꾸고 true. 그 밖에는 아무 것도 바꾸지 않고 false.
   * 받은 값과 자기 값을 견주는 일은 이 함수만 한다.
   */
  adoptElapsed(testId: string, ms: number, now: number): boolean;
}

/** `shared-state/index.ts` 가 `createReplica` 라는 이름으로 내보낸다. 빈 복제본으로 시작한다. */
export type CreateReplica = (deps: ReplicaDeps) => Replica;
