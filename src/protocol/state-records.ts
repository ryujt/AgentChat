// 공유 상태 기록의 스키마, 정규 직렬화, 지문 (protocol.md 5.1, 5.3, 5.4).
// 모든 참가자가 같은 기록을 같은 바이트로 보고 같은 지문을 내야 복제본이 맞춰지므로,
// 직렬화와 지문의 정의를 이 파일 한 곳에 둔다. 병합 규칙과 판정은 shared-state 가 갖는다.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { entryIdSchema, peerNameSchema } from './identifiers.js';
import { LIMITS } from './limits.js';
import { err, ok, type Result } from './result.js';
import { deepFreeze, describeIssues, utf8ByteLength } from './util.js';

export const RECORD_KINDS = deepFreeze(['presence', 'test', 'stop', 'scenario', 'claim', 'verification'] as const);
export type RecordKind = (typeof RECORD_KINDS)[number];

/** 키 기록: 같은 키에 값이 하나만 남는다(last-writer-wins). */
export const KEY_RECORD_KINDS = deepFreeze(['presence', 'test'] as const);
/** 추가 기록: rid 로 식별하고 한 번 쓰면 바꾸지 않는다. */
export const APPEND_RECORD_KINDS = deepFreeze(['stop', 'scenario', 'claim', 'verification'] as const);

export const PRESENCE_STATUSES = deepFreeze(['joined', 'ready', 'working', 'left'] as const);
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const STOP_REASONS = deepFreeze(['user', 'time_limit'] as const);
export type StopReason = (typeof STOP_REASONS)[number];

export const CLAIM_OUTCOMES = deepFreeze(['pass', 'fail'] as const);
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

export const VERIFICATION_RESULTS = deepFreeze(['confirmed', 'refuted', 'unable'] as const);
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

/** 방에 하나뿐인 test 기록의 키. */
export const TEST_KEY = 'test';
export const PRESENCE_KEY_PREFIX = 'presence/';

/** presence 기록의 키. 그 이름 본인만 쓸 수 있다. */
export function presenceKey(peer: string): string {
  return `${PRESENCE_KEY_PREFIX}${peer}`;
}

/** 지문: SHA-256 앞 12자리(16진수). */
export const STATE_FINGERPRINT_PATTERN = /^[0-9a-f]{12}$/;
export const stateFingerprintSchema = z.string().regex(STATE_FINGERPRINT_PATTERN);

// ── 스키마 ──────────────────────────────────────────────────────────────────

const textField = z.string().refine((text) => utf8ByteLength(text) <= LIMITS.STATE_TEXT_FIELD_MAX_BYTES, {
  message: `text field exceeds ${LIMITS.STATE_TEXT_FIELD_MAX_BYTES} bytes`,
});

/**
 * 논리 시각(lc)과 벽시계(wall)의 상한. 안전 정수의 끝이다. 그 위에서는 `n + 1 === n` 이라
 * "본 뒤에 쓴 기록은 더 크다"(5.2)가 성립하지 않는다. 정상 시계(Date 의 최댓값 8.64e15)로는 닿지 않는다.
 * 본 값 + 1 이 이 값을 넘으면 shared-state 는 그 쓰기를 거절한다. 값을 접거나 낮춰 쓰지 않는다.
 */
export const STATE_CLOCK_MAX = Number.MAX_SAFE_INTEGER;

/**
 * 논리 시각과 벽시계는 ms 단위의 0 이상 정수다.
 * 위쪽 끝은 zod 의 int() 가 건다(안전 정수만 받는다). 그 끝이 STATE_CLOCK_MAX 와 같다는 것은 시험이 고정한다.
 */
const clockSchema = z.number().int().min(0);

const commonFields = {
  author: peerNameSchema,
  lc: clockSchema,
  wall: clockSchema,
};

export const presenceRecordSchema = z
  .object({
    kind: z.literal('presence'),
    key: z.string().startsWith(PRESENCE_KEY_PREFIX),
    ...commonFields,
    body: z.object({
      client: textField,
      tools: z.array(textField),
      role: textField.nullable(),
      status: z.enum(PRESENCE_STATUSES),
      listening: z.boolean(),
      note: textField.nullable(),
    }),
  })
  // 남의 presence 를 대신 쓸 수 없다. 스냅샷에 실려 와도 키와 작성자가 맞아야 한다.
  .refine((record) => record.key === presenceKey(record.author), {
    message: 'presence key must be presence/<author>',
    path: ['key'],
  });

export const testRecordSchema = z.object({
  kind: z.literal('test'),
  key: z.literal(TEST_KEY),
  ...commonFields,
  body: z.object({
    test_id: entryIdSchema,
    request: textField,
    /** 표시용. 판정에 쓰지 않는다. */
    started_wall: clockSchema,
    max_duration_min: z.number().int().min(1),
    max_scenarios: z.number().int().min(1),
  }),
});

export const stopRecordSchema = z.object({
  kind: z.literal('stop'),
  rid: entryIdSchema,
  ...commonFields,
  body: z.object({
    test_id: entryIdSchema,
    reason: z.enum(STOP_REASONS),
    detail: textField,
  }),
});

export const scenarioRecordSchema = z.object({
  kind: z.literal('scenario'),
  rid: entryIdSchema,
  ...commonFields,
  body: z.object({
    test_id: entryIdSchema,
    title: textField,
    plan: textField.nullable(),
    actor: peerNameSchema.optional(),
    verifier: peerNameSchema.optional(),
  }),
});

export const claimRecordSchema = z.object({
  kind: z.literal('claim'),
  rid: entryIdSchema,
  ...commonFields,
  body: z.object({
    test_id: entryIdSchema,
    /** 대상 scenario 기록의 rid. */
    scenario: entryIdSchema,
    action: textField,
    expected: textField.nullable(),
    observed: textField,
    outcome: z.enum(CLAIM_OUTCOMES),
    steps: textField,
  }),
});

export const verificationRecordSchema = z.object({
  kind: z.literal('verification'),
  rid: entryIdSchema,
  ...commonFields,
  body: z.object({
    test_id: entryIdSchema,
    /** 대상 claim 기록의 rid. */
    claim: entryIdSchema,
    result: z.enum(VERIFICATION_RESULTS),
    evidence: textField,
  }),
});

/** 기록 하나의 스키마. 크기 상한까지 보려면 parseStateRecord 를 쓴다. */
export const stateRecordSchema = z.discriminatedUnion('kind', [
  presenceRecordSchema,
  testRecordSchema,
  stopRecordSchema,
  scenarioRecordSchema,
  claimRecordSchema,
  verificationRecordSchema,
]);

export type PresenceRecord = z.infer<typeof presenceRecordSchema>;
export type TestRecord = z.infer<typeof testRecordSchema>;
export type StopRecord = z.infer<typeof stopRecordSchema>;
export type ScenarioRecord = z.infer<typeof scenarioRecordSchema>;
export type ClaimRecord = z.infer<typeof claimRecordSchema>;
export type VerificationRecord = z.infer<typeof verificationRecordSchema>;

export type KeyRecord = PresenceRecord | TestRecord;
export type AppendRecord = StopRecord | ScenarioRecord | ClaimRecord | VerificationRecord;
export type StateRecord = KeyRecord | AppendRecord;

export function isKeyRecord(record: StateRecord): record is KeyRecord {
  return record.kind === 'presence' || record.kind === 'test';
}

export function isAppendRecord(record: StateRecord): record is AppendRecord {
  return !isKeyRecord(record);
}

// ── 정규 직렬화 ─────────────────────────────────────────────────────────────

/**
 * 키를 정렬한 JSON 문자열. 공백이 없고, 배열 순서는 그대로 둔다.
 * 식별자가 같은데 내용이 다른 기록을 가를 때 모든 참가자가 같은 바이트를 견줘야 한다.
 * JSON 에서 온 값(순환 없음)만 넣는다.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === 'function') {
    return canonicalJson((withToJson.toJSON as () => unknown)());
  }
  const source = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/** 정규 직렬화의 UTF-8 바이트. */
export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), 'utf8');
}

/** 정규 직렬화한 바이트의 사전식 비교. 작은 쪽을 남기는 규칙(5.3)에 쓴다. */
export function compareCanonical(a: unknown, b: unknown): -1 | 0 | 1 {
  return Buffer.compare(canonicalBytes(a), canonicalBytes(b));
}

/** 기록 하나의 직렬화 크기. STATE_RECORD_MAX_BYTES 와 STATE_MAX_BYTES 가 이 값을 센다. */
export function recordByteSize(record: StateRecord): number {
  return utf8ByteLength(canonicalJson(record));
}

// ── 검증 ────────────────────────────────────────────────────────────────────

export type StateRecordErrorCode = 'BAD_RECORD' | 'RECORD_TOO_LARGE';

/**
 * 기록 하나를 검증한다. 받은 기록과 로컬에서 만든 기록에 같은 함수를 쓴다.
 * 모르는 필드는 버린다. 크기는 버린 뒤의 정규 직렬화로 재므로 참가자마다 같은 답이 나온다.
 */
export function parseStateRecord(input: unknown): Result<StateRecord, StateRecordErrorCode> {
  const parsed = stateRecordSchema.safeParse(input);
  if (!parsed.success) return err('BAD_RECORD', describeIssues(parsed.error));
  const size = recordByteSize(parsed.data);
  if (size > LIMITS.STATE_RECORD_MAX_BYTES) {
    return err('RECORD_TOO_LARGE', `record is ${size} bytes; the limit is ${LIMITS.STATE_RECORD_MAX_BYTES}`);
  }
  return ok(parsed.data);
}

// ── 지문 ────────────────────────────────────────────────────────────────────

/**
 * 지문에 넣는 기록별 식별 문자열. 추가 기록은 rid, 키 기록은 key·lc·author 다.
 * 구분자 `|` 는 키, 숫자, 이름, rid 어디에도 나올 수 없는 글자다.
 */
export function recordIdentity(record: StateRecord): string {
  return isKeyRecord(record) ? `${record.key}|${record.lc}|${record.author}` : record.rid;
}

/**
 * 복제본의 지문. 식별 문자열을 정렬해 줄바꿈으로 이은 것의 SHA-256 앞 12자리다.
 * ping 의 sf, 답하는 sync_end 의 sf, 보고서의 "상태 지문"이 모두 이 값이다.
 */
export function stateFingerprint(records: Iterable<StateRecord>): string {
  const identities = Array.from(records, recordIdentity).sort();
  return createHash('sha256').update(identities.join('\n'), 'utf8').digest('hex').slice(0, 12);
}
