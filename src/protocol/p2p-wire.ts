// P2P DataChannel 메시지 계약 (protocol.md 4절).
// 텍스트 메시지 하나가 JSON 객체 하나다. 발신자는 봉투가 아니라 링크로 정하므로
// 여기에는 발신자 필드가 없다(hello 의 peer 는 신원 대조용이다).

import { z } from 'zod';
import { entryIdSchema, peerNameSchema, sidSchema } from './identifiers.js';
import { LIMITS } from './limits.js';
import { err, ok, type Result } from './result.js';
import {
  canonicalJson,
  parseStateRecord,
  stateFingerprintSchema,
  type StateRecord,
} from './state-records.js';
import { deepFreeze, describeIssues, isPlainObject, parseJson, utf8ByteLength } from './util.js';

export const P2P_FRAME_TYPES = deepFreeze(['hello', 'state', 'sync_end', 'chat', 'ack', 'ping', 'pong', 'bye'] as const);
export type P2PFrameType = (typeof P2P_FRAME_TYPES)[number];

export const BYE_REASONS = deepFreeze(['leave', 'shutdown', 'version', 'protocol_error'] as const);
export type ByeReason = (typeof BYE_REASONS)[number];

const versionField = z.literal(LIMITS.P2P_VERSION);
const countSchema = z.number().int().min(0);
const wallSchema = z.number().int().min(0);

export const helloFrameSchema = z.object({
  v: versionField,
  t: z.literal('hello'),
  peer: peerNameSchema,
  sid: sidSchema,
  /** 시계 차이 경고에만 쓴다. */
  wall: wallSchema,
  client: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  /**
   * 관전자 표시(protocol.md 4.6). 선택 필드라 v 는 그대로다. 새 구현은 늘 싣는다(참가자 false, 관전자 true).
   * 없으면 관전자를 모르는 구버전이다. 구버전은 모르는 필드를 버리므로 그대로 받는다.
   */
  observer: z.boolean().optional(),
});

/** state 의 봉투만 본다. 기록은 하나씩 따로 검증해 나쁜 것만 버린다. */
const stateEnvelopeSchema = z.object({
  v: versionField,
  t: z.literal('state'),
  records: z.array(z.unknown()),
  snap: z.boolean().optional(),
});

export const syncEndFrameSchema = z
  .object({
    v: versionField,
    t: z.literal('sync_end'),
    count: countSchema,
    test_id: entryIdSchema.optional(),
    test_elapsed_ms: countSchema.optional(),
    /** 답으로 보내는 sync_end 에만 싣는다. */
    sf: stateFingerprintSchema.optional(),
  })
  // 경과 시간은 어느 테스트의 것인지와 함께 와야 뜻이 있다(5.5).
  .refine((frame) => (frame.test_id === undefined) === (frame.test_elapsed_ms === undefined), {
    message: 'test_id and test_elapsed_ms must be sent together',
  });

export const chatFrameSchema = z.object({
  v: versionField,
  t: z.literal('chat'),
  id: entryIdSchema,
  /** null 이면 방 전체, 이름 배열이면 대상 지정. */
  to: z.array(peerNameSchema).min(1).nullable(),
  text: z.string().refine((text) => utf8ByteLength(text) <= LIMITS.CHAT_MAX_TEXT_BYTES, {
    message: `text exceeds ${LIMITS.CHAT_MAX_TEXT_BYTES} bytes`,
  }),
  /** 표시용. 순서 판정에 쓰지 않는다. */
  wall: wallSchema,
  /**
   * 읽음 확인 요청(ping_room. protocol.md 4.3). 선택 필드라 v 는 그대로다. 받는 쪽 에이전트가 이 글을 꺼내 가면
   * ack{read: true} 를 한 번 더 보낸다. 구버전은 모르는 필드를 버리고 보통 글로 받는다(읽음 확인이 오지 않는다).
   */
  rr: z.literal(true).optional(),
});

export const ackFrameSchema = z.object({
  v: versionField,
  t: z.literal('ack'),
  id: entryIdSchema,
  /**
   * 참이면 "수신함에 넣었다"가 아니라 "에이전트가 읽었다"는 확인이다(rr 을 단 글에만 보낸다). 선택 필드라 v 는 그대로다.
   * 구버전은 이 필드를 버리고 이미 받은 ack 로 본다(아무 일도 없다).
   */
  read: z.literal(true).optional(),
});

export const pingFrameSchema = z.object({
  v: versionField,
  t: z.literal('ping'),
  n: countSchema,
  /** 보내는 쪽 복제본의 기록 수. */
  sc: countSchema,
  /** 보내는 쪽 복제본의 지문. */
  sf: stateFingerprintSchema,
});

export const pongFrameSchema = z.object({ v: versionField, t: z.literal('pong'), n: countSchema });

export const byeFrameSchema = z.object({
  v: versionField,
  t: z.literal('bye'),
  reason: z.enum(BYE_REASONS),
});

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type SyncEndFrame = z.infer<typeof syncEndFrameSchema>;
export type ChatFrame = z.infer<typeof chatFrameSchema>;
export type AckFrame = z.infer<typeof ackFrameSchema>;
export type PingFrame = z.infer<typeof pingFrameSchema>;
export type PongFrame = z.infer<typeof pongFrameSchema>;
export type ByeFrame = z.infer<typeof byeFrameSchema>;

export interface StateFrame {
  v: typeof LIMITS.P2P_VERSION;
  t: 'state';
  records: StateRecord[];
  /** 참이면 스냅샷, 없으면 변경이다. */
  snap?: boolean | undefined;
}

export type P2PFrame =
  | HelloFrame
  | StateFrame
  | SyncEndFrame
  | ChatFrame
  | AckFrame
  | PingFrame
  | PongFrame
  | ByeFrame;

export type P2PFrameErrorCode = 'FRAME_TOO_LARGE' | 'BAD_FRAME' | 'UNKNOWN_TYPE' | 'VERSION_MISMATCH';

export type ParseP2PFrameResult =
  | {
      readonly ok: true;
      readonly value: P2PFrame;
      /** state 프레임에서 검증에 걸려 버린 기록 수. 다른 타입은 0 이다. */
      readonly invalidRecords: number;
    }
  | {
      readonly ok: false;
      readonly code: P2PFrameErrorCode;
      readonly detail: string;
      /** VERSION_MISMATCH 일 때 상대 프레임의 v. */
      readonly theirVersion?: number;
    };

function bad(code: P2PFrameErrorCode, detail: string): ParseP2PFrameResult {
  return { ok: false, code, detail };
}

const SIMPLE_SCHEMAS = {
  hello: helloFrameSchema,
  sync_end: syncEndFrameSchema,
  chat: chatFrameSchema,
  ack: ackFrameSchema,
  ping: pingFrameSchema,
  pong: pongFrameSchema,
  bye: byeFrameSchema,
} as const;

type SimpleFrame = Exclude<P2PFrame, StateFrame>;

/** state 를 뺀 타입의 프레임을 그 타입의 스키마로 본다. 모르는 타입이면 null. */
function checkSimpleFrame(type: unknown, raw: unknown): z.ZodSafeParseResult<SimpleFrame> | null {
  // 이름 목록이 아니라 스키마 표로 가른다. 둘이 어긋나도 없는 스키마를 부르지 않는다.
  if (typeof type !== 'string' || !Object.hasOwn(SIMPLE_SCHEMAS, type)) return null;
  return SIMPLE_SCHEMAS[type as keyof typeof SIMPLE_SCHEMAS].safeParse(raw);
}

/**
 * 받은 DataChannel 텍스트 하나를 해석한다.
 * - FRAME_TOO_LARGE, BAD_FRAME, UNKNOWN_TYPE: 버리고 잘못된 프레임으로 센다(4.4).
 * - VERSION_MISMATCH: v 가 정수인데 내 것과 다르다. bye{version} 뒤 링크를 닫는다(4.1).
 */
export function parseP2PFrame(text: string): ParseP2PFrameResult {
  const bytes = utf8ByteLength(text);
  if (bytes > LIMITS.P2P_MAX_FRAME_BYTES) {
    return bad('FRAME_TOO_LARGE', `frame is ${bytes} bytes; the limit is ${LIMITS.P2P_MAX_FRAME_BYTES}`);
  }
  const json = parseJson(text);
  if (!json.ok) return bad('BAD_FRAME', 'frame is not valid JSON');
  const raw = json.value;
  if (!isPlainObject(raw)) return bad('BAD_FRAME', 'frame is not a JSON object');

  // 버전을 타입보다 먼저 본다. 다른 버전의 프레임은 모양이 달라도 "버전 불일치"여야 한다.
  const version = raw['v'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return bad('BAD_FRAME', 'v: missing or not an integer');
  }
  if (version !== LIMITS.P2P_VERSION) {
    return {
      ok: false,
      code: 'VERSION_MISMATCH',
      detail: `peer uses P2P version ${version}; this side uses ${LIMITS.P2P_VERSION}`,
      theirVersion: version,
    };
  }

  const type = raw['t'];
  if (type === 'state') {
    const envelope = stateEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return bad('BAD_FRAME', describeIssues(envelope.error));
    const records: StateRecord[] = [];
    let invalidRecords = 0;
    for (const item of envelope.data.records) {
      const record = parseStateRecord(item);
      if (record.ok) records.push(record.value);
      else invalidRecords += 1;
    }
    const frame: StateFrame = { v: LIMITS.P2P_VERSION, t: 'state', records };
    if (envelope.data.snap !== undefined) frame.snap = envelope.data.snap;
    return { ok: true, value: frame, invalidRecords };
  }

  const parsed = checkSimpleFrame(type, raw);
  if (parsed === null) return bad('UNKNOWN_TYPE', 't: missing or unknown frame type');
  if (!parsed.success) return bad('BAD_FRAME', describeIssues(parsed.error));
  return { ok: true, value: parsed.data, invalidRecords: 0 };
}

/**
 * 보낼 프레임을 검증하고 직렬화한다. 받는 쪽이 거절할 프레임은 만들지 않는다.
 * - BAD_FRAME: 받는 쪽과 같은 스키마에 걸린다(chat.text 16384바이트 초과 포함).
 *   받는 쪽은 그런 프레임을 잘못된 프레임으로 세고, 쌓이면 링크를 닫는다(4.4).
 *   state 는 받을 때와 달리 기록 하나만 틀려도 프레임 전체를 거절한다. 보내는 쪽의 결함이기 때문이다.
 * - FRAME_TOO_LARGE: 직렬화한 뒤의 크기가 상한을 넘는다.
 *   따옴표나 제어 문자가 많은 글은 직렬화하면서 길어지므로 글자 수만 봐서는 모자라다.
 * 모르는 필드는 싣지 않는다.
 */
export function encodeP2PFrame(frame: P2PFrame): Result<string, 'FRAME_TOO_LARGE' | 'BAD_FRAME'> {
  const raw: unknown = frame;
  if (!isPlainObject(raw)) return err('BAD_FRAME', 'frame is not an object');

  let checked: P2PFrame;
  if (raw['t'] === 'state') {
    const envelope = stateEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return err('BAD_FRAME', describeIssues(envelope.error));
    const records: StateRecord[] = [];
    for (let i = 0; i < envelope.data.records.length; i += 1) {
      const record = parseStateRecord(envelope.data.records[i]);
      if (!record.ok) return err('BAD_FRAME', `records.${i}: ${record.detail}`);
      records.push(record.value);
    }
    const state: StateFrame = { v: LIMITS.P2P_VERSION, t: 'state', records };
    if (envelope.data.snap !== undefined) state.snap = envelope.data.snap;
    checked = state;
  } else {
    const parsed = checkSimpleFrame(raw['t'], raw);
    if (parsed === null) return err('BAD_FRAME', 't: missing or unknown frame type');
    if (!parsed.success) return err('BAD_FRAME', describeIssues(parsed.error));
    checked = parsed.data;
  }

  const text = JSON.stringify(checked);
  const bytes = utf8ByteLength(text);
  if (bytes > LIMITS.P2P_MAX_FRAME_BYTES) {
    return err('FRAME_TOO_LARGE', `frame is ${bytes} bytes; the limit is ${LIMITS.P2P_MAX_FRAME_BYTES}`);
  }
  return ok(text);
}

/**
 * 기록 묶음을 state 프레임들로 나눠 담는다. 스냅샷과 변경은 encodeP2PFrame 이 아니라 이 함수로 나간다.
 * - BAD_FRAME: 기록 하나라도 받는 쪽과 같은 검증(parseStateRecord)에 걸린다. detail 은 `records.<순번>: …` 이다.
 *   프레임을 하나도 만들지 않는다. 받는 쪽은 그런 기록만 버리므로, 그대로 보내면 보낸 쪽만 성공으로 알고 지문이 계속 어긋난다.
 * 검증을 통과한 값을 싣는다. 모르는 필드는 실리지 않는다.
 * 프레임 하나는 STATE_FRAME_TARGET_BYTES 를 목표로 한다. 통과한 기록은 STATE_RECORD_MAX_BYTES 이하라 항상 한 프레임에 든다.
 * 기록이 없으면 프레임도 없다(스냅샷이면 sync_end 만 보내면 된다).
 */
export function packStateFrames(
  records: readonly StateRecord[],
  options: { readonly snap: boolean },
): Result<string[], 'BAD_FRAME'> {
  const head = `{"v":${LIMITS.P2P_VERSION},"t":"state","records":[`;
  const tail = options.snap ? '],"snap":true}' : ']}';
  const envelopeBytes = utf8ByteLength(head) + utf8ByteLength(tail);

  // 나누기 전에 전부 본다. 뒤쪽 기록이 걸렸을 때 앞쪽 프레임만 나가지 않게 한다.
  const checked: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = parseStateRecord(records[i]);
    if (!record.ok) return err('BAD_FRAME', `records.${i}: ${record.detail}`);
    checked.push(canonicalJson(record.value));
  }

  const frames: string[] = [];
  let parts: string[] = [];
  let bytes = envelopeBytes;
  const flush = (): void => {
    if (parts.length === 0) return;
    frames.push(`${head}${parts.join(',')}${tail}`);
    parts = [];
    bytes = envelopeBytes;
  };

  for (const part of checked) {
    const partBytes = utf8ByteLength(part);
    const separator = parts.length > 0 ? 1 : 0;
    if (parts.length > 0 && bytes + separator + partBytes > LIMITS.STATE_FRAME_TARGET_BYTES) flush();
    bytes += (parts.length > 0 ? 1 : 0) + partBytes;
    parts.push(part);
  }
  flush();
  return ok(frames);
}
