// 시그널링 WebSocket 와이어 계약 (protocol.md 2절).
// 서버 두 조립과 클라이언트가 이 파일의 스키마를 함께 쓴다. 스키마를 복사하지 않는다.
// 클라이언트 → 서버는 action, 서버 → 클라이언트는 type 으로 구분한다.

import { z } from 'zod';
import { isRelayCandidate } from './ice-config.js';
import {
  cidSchema,
  isRequestId,
  peerNameSchema,
  requestIdSchema,
  resumeKeySchema,
  roomIdSchema,
  sidSchema,
} from './identifiers.js';
import { LIMITS } from './limits.js';
import { err, ok, type Result } from './result.js';
import { deepFreeze, describeIssues, isPlainObject, parseJson, utf8ByteLength } from './util.js';

export const CLIENT_ACTIONS = deepFreeze(['join', 'signal', 'ping', 'leave'] as const);
export type ClientAction = (typeof CLIENT_ACTIONS)[number];

export const SERVER_MESSAGE_TYPES = deepFreeze(['joined', 'signal', 'pong', 'error'] as const);
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

export const JOIN_MODES = deepFreeze(['create', 'join', 'resume'] as const);
export type JoinMode = (typeof JOIN_MODES)[number];

export const SIGNAL_KINDS = deepFreeze(['offer-request', 'offer', 'answer', 'candidate'] as const);
export type SignalKind = (typeof SIGNAL_KINDS)[number];

// ── 오류 코드 (2.4) ─────────────────────────────────────────────────────────

/**
 * closes: 서버가 이 오류를 보낸 뒤 연결을 닫는가.
 * fatal: 클라이언트가 재접속을 멈춰야 하는가. 치명은 UNSUPPORTED_VERSION 하나다.
 * 종료 코드에는 의미를 두지 않는다. 닫기 전에 보내는 error 가 유일한 사유 전달 수단이다.
 */
export const SIGNAL_ERRORS = deepFreeze({
  /** JSON·스키마·상태 위반. */
  BAD_MESSAGE: { closes: false, fatal: false },
  /** 크기 상한 초과. */
  MESSAGE_TOO_LARGE: { closes: false, fatal: false },
  /** v 미지원. supported 목록이 함께 온다. */
  UNSUPPORTED_VERSION: { closes: false, fatal: true },
  /** 등록 없이 signal·ping. 클라이언트는 join(mode=resume) 을 다시 보낸다. */
  NOT_JOINED: { closes: false, fatal: false },
  /** mode=join 인데 방에 아무도 없음. 연속 JOIN_MISS_MAX 회면 RATE_LIMITED 로 닫는다. */
  ROOM_NOT_FOUND: { closes: false, fatal: false },
  /** mode=create 인데 이미 참가자가 있음. */
  ROOM_EXISTS: { closes: false, fatal: false },
  /** 정원 초과. */
  ROOM_FULL: { closes: false, fatal: false },
  /** 살아 있는 다른 연결이 같은 이름을 씀. */
  NAME_IN_USE: { closes: false, fatal: false },
  /** signal 대상이 없음. */
  PEER_NOT_FOUND: { closes: false, fatal: false },
  /** relay 후보가 든 signal. */
  RELAY_NOT_ALLOWED: { closes: false, fatal: false },
  /** 속도 제한 초과, 또는 없는 방 입장의 반복. */
  RATE_LIMITED: { closes: true, fatal: false },
  /** 같은 이름·같은 key 의 더 새로운 연결이 등록됨. 치명이 아니다. */
  REPLACED: { closes: true, fatal: false },
  /** 서버 내부 실패. */
  SERVER_ERROR: { closes: false, fatal: false },
} as const);

export type SignalErrorCode = keyof typeof SIGNAL_ERRORS;

export const SIGNAL_ERROR_CODES = Object.freeze(Object.keys(SIGNAL_ERRORS)) as readonly SignalErrorCode[];

export function isSignalErrorCode(value: unknown): value is SignalErrorCode {
  return typeof value === 'string' && Object.hasOwn(SIGNAL_ERRORS, value);
}

// ── 공통 조각 ───────────────────────────────────────────────────────────────

const sdpDataSchema = z.object({ sdp: z.string().min(1).max(LIMITS.SDP_MAX_CHARS) });

const candidateItemSchema = z.object({
  candidate: z.string().min(1).max(LIMITS.CANDIDATE_MAX_CHARS),
  mid: z.string().max(LIMITS.CANDIDATE_MID_MAX_CHARS),
});

/** 후보는 묶어 보낸다. 공용 서버의 호출 수와 순서 뒤바뀜이 함께 준다. */
const candidateDataSchema = z.object({
  list: z.array(candidateItemSchema).min(1).max(LIMITS.CANDIDATE_LIST_MAX),
});

const emptyDataSchema = z.object({});

export type SdpData = z.infer<typeof sdpDataSchema>;
export type CandidateItem = z.infer<typeof candidateItemSchema>;
export type CandidateData = z.infer<typeof candidateDataSchema>;

// kind 마다 cid 와 data 의 모양이 다르다. offer-request 에는 cid 가 없다.
const offerRequestPayload = { kind: z.literal('offer-request'), data: emptyDataSchema };
const offerPayload = { kind: z.literal('offer'), cid: cidSchema, data: sdpDataSchema };
const answerPayload = { kind: z.literal('answer'), cid: cidSchema, data: sdpDataSchema };
const candidatePayload = { kind: z.literal('candidate'), cid: cidSchema, data: candidateDataSchema };

export const signalPayloadSchema = z.discriminatedUnion('kind', [
  z.object(offerRequestPayload),
  z.object(offerPayload),
  z.object(answerPayload),
  z.object(candidatePayload),
]);

/** signal 의 kind·cid·data. 보내는 쪽과 받는 쪽 메시지가 함께 갖는 부분이다. */
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

/** 서버는 SDP 를 파싱하지 않는다. relay 후보 표시가 든 signal 만 전달하지 않는다(세 번째 방어선). */
export function signalCarriesRelay(payload: SignalPayload): boolean {
  switch (payload.kind) {
    case 'offer':
    case 'answer':
      return isRelayCandidate(payload.data.sdp);
    case 'candidate':
      return payload.data.list.some((item) => isRelayCandidate(item.candidate));
    case 'offer-request':
      return false;
  }
}

// ── 클라이언트 → 서버 ───────────────────────────────────────────────────────

export const joinMessageSchema = z.object({
  action: z.literal('join'),
  v: z.number().int(),
  id: requestIdSchema,
  room: roomIdSchema,
  peer: peerNameSchema,
  sid: sidSchema,
  key: resumeKeySchema,
  mode: z.enum(JOIN_MODES),
  /** 접속 순번. 새 연결에서 join 을 보낼 때마다 1씩 올린다. */
  seq: z.number().int().min(1),
});

const clientSignalBase = { action: z.literal('signal'), id: requestIdSchema, to: peerNameSchema };

export const clientSignalMessageSchema = z.discriminatedUnion('kind', [
  z.object({ ...clientSignalBase, ...offerRequestPayload }),
  z.object({ ...clientSignalBase, ...offerPayload }),
  z.object({ ...clientSignalBase, ...answerPayload }),
  z.object({ ...clientSignalBase, ...candidatePayload }),
]);

export const pingMessageSchema = z.object({ action: z.literal('ping'), id: requestIdSchema });
export const leaveMessageSchema = z.object({ action: z.literal('leave'), id: requestIdSchema });

export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type ClientSignalMessage = z.infer<typeof clientSignalMessageSchema>;
export type PingMessage = z.infer<typeof pingMessageSchema>;
export type LeaveMessage = z.infer<typeof leaveMessageSchema>;
export type ClientMessage = JoinMessage | ClientSignalMessage | PingMessage | LeaveMessage;

export type ClientMessageErrorCode = 'MESSAGE_TOO_LARGE' | 'BAD_MESSAGE' | 'UNSUPPORTED_VERSION';

export type ParseClientMessageResult =
  | { readonly ok: true; readonly value: ClientMessage }
  | {
      readonly ok: false;
      readonly code: ClientMessageErrorCode;
      readonly detail: string;
      /** 요청의 id 를 읽을 수 있었으면 그 값. 서버가 error.re 에 그대로 돌려준다. */
      readonly re?: string;
    };

function clientError(code: ClientMessageErrorCode, detail: string, re?: string): ParseClientMessageResult {
  return re === undefined ? { ok: false, code, detail } : { ok: false, code, detail, re };
}

/** 2.3 의 1번 규칙: 상한을 넘으면 JSON 을 파싱하지 않는다. 속도 제한보다 먼저 볼 수 있게 따로 낸다. */
export function isSignalMessageTooLarge(text: string): boolean {
  return utf8ByteLength(text) > LIMITS.SIGNAL_MAX_MESSAGE_BYTES;
}

function isSupportedVersion(version: number): boolean {
  return (LIMITS.SIGNAL_SUPPORTED_VERSIONS as readonly number[]).includes(version);
}

/** JSON 으로 읽은 객체를 action 에 맞는 스키마로 본다. 해석과 직렬화가 같은 판정을 쓴다. */
function checkClientMessage(raw: Record<string, unknown>): ParseClientMessageResult {
  const re = isRequestId(raw['id']) ? raw['id'] : undefined;

  let parsed: z.ZodSafeParseResult<ClientMessage>;
  switch (raw['action']) {
    case 'join': {
      const version = raw['v'];
      if (typeof version !== 'number' || !Number.isInteger(version)) {
        return clientError('BAD_MESSAGE', 'v: missing or not an integer', re);
      }
      if (!isSupportedVersion(version)) {
        return clientError('UNSUPPORTED_VERSION', `version ${version} is not supported`, re);
      }
      parsed = joinMessageSchema.safeParse(raw);
      break;
    }
    case 'signal':
      parsed = clientSignalMessageSchema.safeParse(raw);
      break;
    case 'ping':
      parsed = pingMessageSchema.safeParse(raw);
      break;
    case 'leave':
      parsed = leaveMessageSchema.safeParse(raw);
      break;
    default:
      return clientError('BAD_MESSAGE', 'action: missing or unknown', re);
  }
  if (!parsed.success) return clientError('BAD_MESSAGE', describeIssues(parsed.error), re);
  return { ok: true, value: parsed.data };
}

/**
 * 서버가 받은 텍스트 프레임 하나를 해석한다.
 * - MESSAGE_TOO_LARGE: 크기 상한 초과. 파싱하지 않았다.
 * - UNSUPPORTED_VERSION: join 의 v 가 정수인데 지원 목록에 없다. 다른 필드는 보지 않는다.
 *   다른 버전의 join 은 필드 모양이 달라도 BAD_MESSAGE 가 아니라 이 코드로 답해야 협상이 된다.
 * - BAD_MESSAGE: 그 밖의 JSON·스키마 위반과 모르는 action. 연결은 유지한다.
 * 모르는 필드는 버린다.
 */
export function parseClientMessage(text: string): ParseClientMessageResult {
  if (isSignalMessageTooLarge(text)) {
    return clientError('MESSAGE_TOO_LARGE', `message exceeds ${LIMITS.SIGNAL_MAX_MESSAGE_BYTES} bytes`);
  }
  const json = parseJson(text);
  if (!json.ok) return clientError('BAD_MESSAGE', 'message is not valid JSON');
  if (!isPlainObject(json.value)) return clientError('BAD_MESSAGE', 'message is not a JSON object');
  return checkClientMessage(json.value);
}

/**
 * 클라이언트가 보낼 메시지를 검증하고 직렬화한다. 서버가 거절할 메시지는 만들지 않는다.
 * - BAD_MESSAGE: 서버와 같은 스키마에 걸린다(이 빌드가 지원하지 않는 v 포함).
 * - MESSAGE_TOO_LARGE: 직렬화한 뒤의 크기가 상한을 넘는다.
 * 모르는 필드는 싣지 않는다.
 */
export function encodeClientMessage(message: ClientMessage): Result<string, 'MESSAGE_TOO_LARGE' | 'BAD_MESSAGE'> {
  const raw: unknown = message;
  if (!isPlainObject(raw)) return err('BAD_MESSAGE', 'message is not an object');
  const checked = checkClientMessage(raw);
  if (!checked.ok) return err('BAD_MESSAGE', checked.detail);
  const text = JSON.stringify(checked.value);
  if (isSignalMessageTooLarge(text)) {
    return err('MESSAGE_TOO_LARGE', `message exceeds ${LIMITS.SIGNAL_MAX_MESSAGE_BYTES} bytes`);
  }
  return ok(text);
}

// ── 서버 → 클라이언트 ───────────────────────────────────────────────────────

/** 살아 있는 참가자 한 명. 목록에는 받는 쪽 자신이 없다. */
export const memberSchema = z.object({ peer: peerNameSchema, sid: sidSchema });
export type Member = z.infer<typeof memberSchema>;

export const joinedMessageSchema = z.object({
  type: z.literal('joined'),
  re: requestIdSchema,
  members: z.array(memberSchema),
  max_peers: z.number().int().min(1),
  ping_interval_ms: z.number().int().min(1),
  stale_after_ms: z.number().int().min(1),
});

/** from 과 sid 는 서버가 등록 기록에서 붙인다. 링크의 상대 sid 는 이 값이 기준이다. */
const serverSignalBase = { type: z.literal('signal'), from: peerNameSchema, sid: sidSchema };

export const serverSignalMessageSchema = z.discriminatedUnion('kind', [
  z.object({ ...serverSignalBase, ...offerRequestPayload }),
  z.object({ ...serverSignalBase, ...offerPayload }),
  z.object({ ...serverSignalBase, ...answerPayload }),
  z.object({ ...serverSignalBase, ...candidatePayload }),
]);

export const pongMessageSchema = z.object({
  type: z.literal('pong'),
  re: requestIdSchema,
  members: z.array(memberSchema),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.enum(Object.keys(SIGNAL_ERRORS) as [SignalErrorCode, ...SignalErrorCode[]]),
  message: z.string(),
  re: requestIdSchema.optional(),
  retry_after_ms: z.number().int().min(0).optional(),
  supported: z.array(z.number().int()).optional(),
});

export type JoinedMessage = z.infer<typeof joinedMessageSchema>;
export type ServerSignalMessage = z.infer<typeof serverSignalMessageSchema>;
export type PongMessage = z.infer<typeof pongMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ServerMessage = JoinedMessage | ServerSignalMessage | PongMessage | ErrorMessage;

/**
 * EMPTY_FRAME: 길이 0. 무시하고 건수만 센다.
 * GATEWAY_FRAME: type 필드가 없다. 프로토콜 메시지가 아니다(게이트웨이가 끼워 넣은 프레임).
 *   re 가 없어 어느 요청이 사라졌는지 알 수 없으므로 그때의 상태로 다룬다(2.4).
 * UNKNOWN_TYPE: 모르는 type. 무시하고 건수만 센다.
 * BAD_MESSAGE: 아는 type 인데 스키마에 맞지 않는다.
 */
export type ServerFrameErrorCode = 'EMPTY_FRAME' | 'GATEWAY_FRAME' | 'UNKNOWN_TYPE' | 'BAD_MESSAGE';

export type ParseServerMessageResult =
  | { readonly ok: true; readonly value: ServerMessage }
  | {
      readonly ok: false;
      readonly code: ServerFrameErrorCode;
      /** 프레임 본문을 싣지 않는다. 로그에는 길이와 건수만 남긴다. */
      readonly detail: string;
      readonly frameBytes: number;
    };

/** type 에 맞는 스키마로 본다. 모르는 type 이면 null. 해석과 직렬화가 같은 판정을 쓴다. */
function checkServerMessage(raw: Record<string, unknown>): z.ZodSafeParseResult<ServerMessage> | null {
  switch (raw['type']) {
    case 'joined':
      return joinedMessageSchema.safeParse(raw);
    case 'signal':
      return serverSignalMessageSchema.safeParse(raw);
    case 'pong':
      return pongMessageSchema.safeParse(raw);
    case 'error':
      return errorMessageSchema.safeParse(raw);
    default:
      return null;
  }
}

/** 클라이언트가 받은 텍스트 프레임 하나를 해석한다. 모르는 필드는 버린다. */
export function parseServerMessage(text: string): ParseServerMessageResult {
  const frameBytes = utf8ByteLength(text);
  const fail = (code: ServerFrameErrorCode, detail: string): ParseServerMessageResult => ({
    ok: false,
    code,
    detail,
    frameBytes,
  });
  if (text.length === 0) return fail('EMPTY_FRAME', 'empty frame');
  const json = parseJson(text);
  if (!json.ok || !isPlainObject(json.value) || !Object.hasOwn(json.value, 'type')) {
    return fail('GATEWAY_FRAME', 'frame has no type field');
  }
  const parsed = checkServerMessage(json.value);
  if (parsed === null) return fail('UNKNOWN_TYPE', 'unknown message type');
  if (!parsed.success) return fail('BAD_MESSAGE', describeIssues(parsed.error));
  return { ok: true, value: parsed.data };
}

/**
 * 서버가 보낼 메시지를 검증하고 직렬화한다. 클라이언트가 거절할 메시지는 만들지 않는다.
 * - BAD_MESSAGE: 클라이언트와 같은 스키마에 걸린다. 서버 규칙 코드의 결함이다.
 *   그대로 보내면 클라이언트는 버리고 요청 기한까지 기다린다. 부르는 쪽(signaling-core)이 SERVER_ERROR 로 바꿔 답한다.
 * 모르는 필드는 싣지 않는다. 서버 → 클라이언트 방향에는 크기 상한이 없다.
 */
export function encodeServerMessage(message: ServerMessage): Result<string, 'BAD_MESSAGE'> {
  const raw: unknown = message;
  if (!isPlainObject(raw)) return err('BAD_MESSAGE', 'message is not an object');
  const checked = checkServerMessage(raw);
  if (checked === null) return err('BAD_MESSAGE', 'type: missing or unknown');
  if (!checked.success) return err('BAD_MESSAGE', describeIssues(checked.error));
  return ok(JSON.stringify(checked.data));
}
