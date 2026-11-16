// 공통 식별자의 형식, 검증, 생성 (protocol.md 1절).
// 서버와 클라이언트가 같은 정규식으로 거절해야 해서 한 곳에 둔다.

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { z } from 'zod';
import { err, ok, type Result } from './result.js';

/** 무작위 바이트 공급자. 시험에서 값을 고정할 수 있게 주입받는다. */
export type RandomBytes = (size: number) => Uint8Array;

export const ROOM_ID_PATTERN = /^[a-z0-9]{8,32}$/;
export const PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const SID_PATTERN = /^[a-z0-9]{12}$/;
/** base64url 43자 = 무작위 32바이트. */
export const RESUME_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** `<offer 쪽 sid>.<순번>` */
export const CID_PATTERN = /^[a-z0-9]{12}\.[0-9]{1,6}$/;
/** 메시지 ID 와 기록 ID. `<sid>-<순번>` 이고 순번은 36진수다. */
export const ENTRY_ID_PATTERN = /^[a-z0-9]{12}-[0-9a-z]{1,8}$/;
/** 시그널링 요청의 id 와 응답의 re. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const ROOM_ID_GENERATED_LENGTH = 16;
export const SID_LENGTH = 12;
export const RESUME_KEY_BYTES = 32;
export const CID_SEQ_MAX = 999_999;
export const ENTRY_SEQ_MAX = 36 ** 8 - 1;

/**
 * 채널 태그의 from 이나 사건의 to 값과 헷갈리지 않게 막는 이름.
 * 대소문자를 가리지 않는다. 클라이언트와 서버가 모두 거절한다.
 */
export const RESERVED_PEER_NAMES: readonly string[] = Object.freeze([
  'user',
  'system',
  'assistant',
  'room',
  'you',
  'all',
  'server',
  'agent-chat',
]);

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_PEER_NAMES);

export function isReservedPeerName(name: string): boolean {
  return RESERVED_SET.has(name.toLowerCase());
}

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

/** 형식이 맞고 예약 이름이 아닌 참가자 이름. */
export function isPeerName(value: unknown): value is string {
  return typeof value === 'string' && PEER_NAME_PATTERN.test(value) && !isReservedPeerName(value);
}

/** isPeerName 과 같은 판정이지만, 거절 사유(형식인지 예약 이름인지)를 함께 준다. */
export function checkPeerName(value: unknown): Result<string, 'INVALID_ARGUMENT'> {
  if (typeof value !== 'string' || !PEER_NAME_PATTERN.test(value)) {
    return err(
      'INVALID_ARGUMENT',
      'name must be 1-32 characters of letters, digits, "_" or "-", starting with a letter or digit',
    );
  }
  if (isReservedPeerName(value)) {
    return err('INVALID_ARGUMENT', `name is reserved (${RESERVED_PEER_NAMES.join(', ')})`);
  }
  return ok(value);
}

export function isSid(value: unknown): value is string {
  return typeof value === 'string' && SID_PATTERN.test(value);
}

export function isResumeKey(value: unknown): value is string {
  return typeof value === 'string' && RESUME_KEY_PATTERN.test(value);
}

export function isCid(value: unknown): value is string {
  return typeof value === 'string' && CID_PATTERN.test(value);
}

export function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && ENTRY_ID_PATTERN.test(value);
}

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

// ── 스키마 (와이어 스키마 파일들이 함께 쓴다) ────────────────────────────────

export const roomIdSchema = z.string().regex(ROOM_ID_PATTERN);
export const peerNameSchema = z
  .string()
  .regex(PEER_NAME_PATTERN)
  .refine((name) => !isReservedPeerName(name), { message: 'reserved name' });
export const sidSchema = z.string().regex(SID_PATTERN);
export const resumeKeySchema = z.string().regex(RESUME_KEY_PATTERN);
export const cidSchema = z.string().regex(CID_PATTERN);
export const entryIdSchema = z.string().regex(ENTRY_ID_PATTERN);
export const requestIdSchema = z.string().regex(REQUEST_ID_PATTERN);

// ── 생성 ────────────────────────────────────────────────────────────────────

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
// 256 을 36 으로 나눈 나머지 구간(252~255)을 버려야 글자마다 확률이 같다.
const UNBIASED_BYTE_LIMIT = 252;
const BARREN_ROUNDS_BEFORE_FALLBACK = 8;

/** `[0-9a-z]` 에서 고르게 뽑은 무작위 문자열. */
export function randomLowerAlnum(length: number, random: RandomBytes = nodeRandomBytes): string {
  if (!Number.isInteger(length) || length <= 0) return '';
  let out = '';
  let source = random;
  let barren = 0;
  while (out.length < length) {
    const before = out.length;
    for (const byte of source(length - out.length + 4)) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      out += BASE36[byte % 36];
      if (out.length === length) break;
    }
    if (out.length === before) {
      // 주입받은 공급자가 쓸 수 있는 바이트를 계속 주지 않으면 끝나지 않는다.
      barren += 1;
      if (barren >= BARREN_ROUNDS_BEFORE_FALLBACK) source = nodeRandomBytes;
    } else {
      barren = 0;
    }
  }
  return out;
}

/** 무작위 방 ID 16자(약 80비트). 방 ID 가 유일한 접근 수단이라 추측할 수 없어야 한다. */
export function newRoomId(random: RandomBytes = nodeRandomBytes): string {
  return randomLowerAlnum(ROOM_ID_GENERATED_LENGTH, random);
}

/** MCP 프로세스가 입장할 때마다 새로 만드는 세션 ID. */
export function newSid(random: RandomBytes = nodeRandomBytes): string {
  return randomLowerAlnum(SID_LENGTH, random);
}

/** 프로세스 시작 때 한 번 만드는 resume key. 파일에 저장하지 않는다. */
export function newResumeKey(random: RandomBytes = nodeRandomBytes): string {
  return Buffer.from(random(RESUME_KEY_BYTES)).toString('base64url');
}

export interface CidParts {
  /** offer 를 만든 쪽의 sid. */
  readonly sid: string;
  readonly seq: number;
}

/** 연결 시도 ID 를 만든다. 순번은 0~999999 의 정수다. */
export function makeCid(sid: string, seq: number): Result<string, 'INVALID_ARGUMENT'> {
  if (!isSid(sid)) return err('INVALID_ARGUMENT', 'sid has an invalid format');
  if (!Number.isInteger(seq) || seq < 0 || seq > CID_SEQ_MAX) {
    return err('INVALID_ARGUMENT', `cid sequence must be an integer from 0 to ${CID_SEQ_MAX}`);
  }
  return ok(`${sid}.${seq}`);
}

export function parseCid(cid: unknown): Result<CidParts, 'INVALID_ARGUMENT'> {
  if (!isCid(cid)) return err('INVALID_ARGUMENT', 'cid has an invalid format');
  const dot = cid.indexOf('.');
  return ok({ sid: cid.slice(0, dot), seq: Number.parseInt(cid.slice(dot + 1), 10) });
}

export interface EntryIdParts {
  /** 작성자의 sid. */
  readonly sid: string;
  readonly seq: number;
}

/** 메시지 ID 또는 기록 ID 를 만든다. 순번은 0~36^8-1 의 정수이고 36진수로 적는다. */
export function makeEntryId(sid: string, seq: number): Result<string, 'INVALID_ARGUMENT'> {
  if (!isSid(sid)) return err('INVALID_ARGUMENT', 'sid has an invalid format');
  if (!Number.isInteger(seq) || seq < 0 || seq > ENTRY_SEQ_MAX) {
    return err('INVALID_ARGUMENT', `id sequence must be an integer from 0 to ${ENTRY_SEQ_MAX}`);
  }
  return ok(`${sid}-${seq.toString(36)}`);
}

export function parseEntryId(id: unknown): Result<EntryIdParts, 'INVALID_ARGUMENT'> {
  if (!isEntryId(id)) return err('INVALID_ARGUMENT', 'id has an invalid format');
  const dash = id.indexOf('-');
  return ok({ sid: id.slice(0, dash), seq: Number.parseInt(id.slice(dash + 1), 36) });
}

// ── 비교와 참조 ─────────────────────────────────────────────────────────────

/** 이름 비교는 JavaScript 문자열 `<` (UTF-16 코드 단위)다. 허용 문자가 ASCII 뿐이라 구현마다 같다. */
export function comparePeerNames(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** offer 는 항상 이름이 작은 쪽만 만든다. 큰 쪽은 offer-request 를 보낸다. */
export function isOfferSide(self: string, other: string): boolean {
  return self < other;
}

/**
 * 로그와 보고서에 원문 대신 남기는 참조 값(SHA-256 앞 12자리, 16진수).
 * room_ref, conn_ref, peer_ref, ip_ref 가 모두 이 방식이라 여러 모듈이 같은 함수를 쓴다.
 */
export function refOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}
