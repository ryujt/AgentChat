// records 의 공개 계약 (architecture.md 3.9). 위치와 형식은 mcp-interface.md 8절과 9절이 정한다.
// 대화와 실행 결과를 로컬 기록 파일에 덧붙이고, 받은 판정으로 최종 보고서를 만든다.
// 진단 로그와 섞지 않는다. 판정을 스스로 계산하지 않는다. shared-state 의 타입을 쓰지 않는다.
// 이 파일에는 타입만 있다.

import type { LogPort } from '../diagnostics/log-port.js';
import type {
  ClaimOutcome,
  Now,
  PresenceStatus,
  StateRecord,
  StopReason,
  VerificationResult,
} from '../protocol/index.js';

// ── 공통 ────────────────────────────────────────────────────────────────────

/**
 * 파일을 둘 자리를 정하는 값. 경로는 records 가 만든다:
 * `<dir>/rooms/<서버 키 슬러그>/<room_id>/<name>/`. 디렉터리 0700, 파일 0600.
 * room_id 와 name 은 형식 검증을 통과한 값만 받는다. 아니면 RECORD_FAILED 다.
 * 다른 참가자가 정한 문자열은 경로에 쓰지 않는다.
 */
export interface RecordsMeta {
  /** 정규화한 서버 키(protocol.normalizeServerAddress 의 serverKey). */
  readonly server_key: string;
  readonly room_id: string;
  /** 이 참가자의 이름. */
  readonly name: string;
  /** 이 입장의 sid. */
  readonly sid: string;
  readonly package_version: string;
}

/** 쓰기 실패는 결과로 알린다. 채팅을 멈추지 않는다. 부르는 쪽이 get_status 와 notice 로 드러낸다. */
export type RecordWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'RECORD_FAILED'; readonly detail: string };

// ── 기록 파일 ───────────────────────────────────────────────────────────────

/**
 * 기록 파일의 한 줄(mcp-interface.md 8.2). `ts` 는 records 가 붙인다.
 * 첫 줄 `session` 은 열 때 meta 로 records 가 쓴다.
 */
export type TranscriptEntry =
  /** 보낸 글. to 가 null 이면 방 전체. 수신자별 결과가 정해진 뒤에 한 줄로 쓴다. */
  | {
      readonly kind: 'chat_out';
      readonly id: string;
      readonly to: readonly string[] | null;
      readonly text: string;
      readonly delivered: readonly string[];
      readonly undelivered: readonly { readonly name: string; readonly reason: 'not_connected' | 'ack_timeout' }[];
    }
  /** 받은 글. */
  | {
      readonly kind: 'chat_in';
      readonly id: string;
      readonly from: string;
      readonly to: 'room' | 'you';
      readonly text: string;
    }
  /** 복제본에 반영한 기록 전체. origin 이 remote 면 from 은 그것을 준 링크의 피어다. */
  | {
      readonly kind: 'state';
      readonly origin: 'local' | 'remote';
      readonly from: string | null;
      readonly record: StateRecord;
    }
  /** 링크 사건. change 는 수신함 peer 사건의 change 와 같은 값이다. */
  | { readonly kind: 'peer'; readonly name: string; readonly change: string; readonly reason: string | null }
  /** 규칙으로 거절한 tool 호출. 보고서의 "거절된 호출"이 된다. */
  | { readonly kind: 'rule'; readonly tool: string; readonly code: string }
  /** 전달 모드 변화. */
  | {
      readonly kind: 'mode';
      readonly from: 'poll' | 'channel';
      readonly to: 'poll' | 'channel';
      readonly cause: string;
    }
  /** 마지막 줄. 종료 사유(leave, shutdown, join_failed 등). */
  | { readonly kind: 'end'; readonly reason: string };

export type TranscriptEntryKind = TranscriptEntry['kind'];

export interface OpenTranscriptOptions {
  /** AGENT_CHAT_HOME. */
  readonly dir: string;
  readonly meta: RecordsMeta;
  readonly now: Now;
  readonly log: LogPort;
}

/** 입장 한 번에 파일 하나. `transcript-<UTC 연월일T시분초Z>-<sid>.jsonl`. 덧붙이기만 한다. */
export interface Transcript {
  /** 기록 파일의 절대 경로. */
  readonly path: string;
  /** 한 줄을 덧붙인다. 부른 순서대로 쓴다. reject 하지 않는다. close() 뒤에는 실패 결과다. */
  append(entry: TranscriptEntry): Promise<RecordWriteResult>;
  /** 밀린 쓰기를 끝내고 닫는다. reject 하지 않는다. 여러 번 불러도 된다. */
  close(): Promise<void>;
}

export type OpenTranscriptResult =
  | { readonly ok: true; readonly transcript: Transcript }
  | { readonly ok: false; readonly code: 'RECORD_FAILED'; readonly detail: string };

/** `records/index.ts` 가 `openTranscript` 라는 이름으로 내보낸다. reject 하지 않는다. */
export type OpenTranscript = (options: OpenTranscriptOptions) => Promise<OpenTranscriptResult>;

// ── 보고서 ──────────────────────────────────────────────────────────────────

export interface ReportVerification {
  readonly by: string;
  readonly wall: number;
  readonly result: VerificationResult;
  readonly evidence: string;
  /** 판정에 넣은 검증인가(자기 검증은 거짓). */
  readonly counted: boolean;
}

export interface ReportClaim {
  readonly claim_id: string;
  readonly by: string;
  readonly wall: number;
  readonly action: string;
  readonly expected: string | null;
  readonly observed: string;
  readonly outcome: ClaimOutcome;
  readonly steps: string;
  /** 부르는 쪽이 정한 분류. records 는 다시 판정하지 않고 이 값으로 구역을 나누고 센다. */
  readonly classification: 'passed' | 'failed' | 'unverified' | 'late';
  /** classification 이 unverified 일 때의 이유. 그 밖에는 null. */
  readonly unverified_reason: 'no_verification' | 'unable' | 'verifier_disconnected' | 'over_limit' | null;
  readonly verifications: readonly ReportVerification[];
}

export interface ReportScenario {
  readonly scenario_id: string;
  readonly index: number;
  readonly title: string;
  readonly by: string;
  readonly wall: number;
  readonly over_limit: boolean;
  readonly claims: readonly ReportClaim[];
}

export interface ReportParticipant {
  readonly name: string;
  readonly client: string | null;
  readonly tools: readonly string[] | null;
  /** 지금 역할. 역할 변화 이력은 records 가 기록 파일의 state(presence) 줄에서 뽑는다. */
  readonly role: string | null;
  readonly status: PresenceStatus | null;
  /** 표시용 판정(get_status 의 shown_as). 작성자 자신은 null. */
  readonly shown_as: string | null;
}

export interface ReportTest {
  readonly test_id: string;
  readonly request: string;
  readonly requested_by: string;
  readonly started_wall: number;
  readonly max_duration_min: number;
  readonly max_scenarios: number;
  /** 유효 시나리오 수. */
  readonly scenarios_used: number;
  /** 중단됐으면 중단 시점의 기록. 진행 중(중간 보고)이면 null. */
  readonly stop: {
    readonly by: string;
    readonly wall: number;
    readonly reason: StopReason;
    readonly detail: string;
  } | null;
}

/**
 * 보고서의 재료. room-session 이 복제본의 view 를 옮겨 담는다.
 * 거절된 호출, 연결 사건, 역할 변화 이력은 여기에 없다. records 가 같은 디렉터리의 기록 파일에서 뽑는다.
 */
export interface ReportInput {
  /** 복제본의 지문 12자리. */
  readonly fingerprint: string;
  readonly test: ReportTest;
  /** 작성자 자신을 포함한다. */
  readonly participants: readonly ReportParticipant[];
  /** 순번 순. 한도 초과 시나리오도 넣는다. */
  readonly scenarios: readonly ReportScenario[];
}

export interface ReportSummary {
  /** 시나리오 수(한도 초과 포함). */
  readonly scenarios: number;
  readonly passed: number;
  readonly failed: number;
  readonly unverified: number;
  readonly late: number;
}

export interface WriteReportOptions {
  /** AGENT_CHAT_HOME. openTranscript 에 준 것과 같다. */
  readonly dir: string;
  readonly input: ReportInput;
  /** openTranscript 에 준 것과 같다. 보고서에는 room_id 의 앞 4자와 room_ref 만 적는다. */
  readonly meta: RecordsMeta;
  readonly now: Now;
  readonly log: LogPort;
}

export type WriteReportResult =
  /** path 는 `report-<test_id>-<UTC 연월일T시분초Z>.md` 의 절대 경로다. */
  | { readonly ok: true; readonly path: string; readonly summary: ReportSummary }
  | { readonly ok: false; readonly code: 'RECORD_FAILED'; readonly detail: string };

/** `records/index.ts` 가 `writeReport` 라는 이름으로 내보낸다. reject 하지 않는다. 한 번 부를 때마다 파일 하나다. */
export type WriteReport = (options: WriteReportOptions) => Promise<WriteReportResult>;
