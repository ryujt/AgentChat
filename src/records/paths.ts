// 기록 파일을 둘 자리 (mcp-interface.md 8.1). 경로는 이 파일만 만든다.
// 경로에 쓰는 값은 형식 검증을 통과한 것뿐이다. 다른 참가자가 정한 문자열은 경로에 쓰지 않는다.

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isPeerName, isRoomId, isSid, refOf } from '../protocol/index.js';
import type { RecordsMeta } from './contract.js';

/** 방 ID 는 접근 수단이다. 기록 디렉터리와 파일은 소유자만 읽고 쓴다. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export interface RecordFailure {
  readonly ok: false;
  readonly code: 'RECORD_FAILED';
  readonly detail: string;
}

export function failure(detail: string): RecordFailure {
  return { ok: false, code: 'RECORD_FAILED', detail };
}

/** 기록 자리를 정하지 못한 사유. reason 은 진단 로그에 남기는 짧은 이름이다. */
export interface LocationFailure {
  readonly ok: false;
  readonly reason: 'invalid_meta' | 'no_dir' | 'not_a_directory' | 'dir_failed';
  readonly detail: string;
  readonly errorCode?: string;
}

function invalidMeta(detail: string): LocationFailure {
  return { ok: false, reason: 'invalid_meta', detail };
}

/**
 * 실패 사유를 짧은 이름으로 줄인다. Node 의 오류 문구에는 경로가 들어 있고 경로에는 방 ID 가 들어 있다.
 * 결과와 진단 로그에는 오류 코드만 남긴다.
 */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name)) return name;
  }
  return 'UNKNOWN';
}

/**
 * 서버 키에서 `[A-Za-z0-9._-]` 밖의 글자를 `_` 로 바꾼다. 이어진 글자는 `_` 하나가 된다
 * (`wss://agent-chat.tools.camp` → `wss_agent-chat.tools.camp`. 8.1 의 예와 같다).
 * 점만으로 된 이름은 상위 디렉터리를 가리킬 수 있어 받지 않는다.
 */
export function serverKeySlug(serverKey: unknown): string | null {
  if (typeof serverKey !== 'string' || serverKey === '') return null;
  const slug = serverKey.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (/^\.*$/.test(slug)) return null;
  return slug;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** 파일 이름에 넣는 `연월일T시분초Z`(UTC). 시각이 날짜로 바뀌지 않으면 null. */
export function utcStamp(ms: number): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) return null;
  return (
    `${pad(year, 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** UTC ISO 8601. 기록 파일의 ts 다. 시각이 날짜로 바뀌지 않으면 null. */
export function isoTime(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface RoomDir {
  readonly ok: true;
  /** `<dir>/rooms/<서버 키 슬러그>/<room_id>/<name>` 의 절대 경로. */
  readonly dir: string;
  /** 진단 로그에 방 ID 원문 대신 남기는 값. */
  readonly roomRef: string;
}

/** 경로에 쓸 값을 본다. 통과한 값은 경로 구분자와 `..` 을 담을 수 없다. */
export function checkMeta(meta: RecordsMeta): { readonly ok: true; readonly segments: readonly string[] } | LocationFailure {
  if (typeof meta !== 'object' || meta === null) return invalidMeta('meta is missing');
  const slug = serverKeySlug(meta.server_key);
  if (slug === null) return invalidMeta('server_key cannot be used as a directory name');
  if (!isRoomId(meta.room_id)) return invalidMeta('room_id has an invalid format');
  if (!isPeerName(meta.name)) return invalidMeta('name has an invalid format');
  if (!isSid(meta.sid)) return invalidMeta('sid has an invalid format');
  return { ok: true, segments: ['rooms', slug, meta.room_id, meta.name] };
}

/**
 * 기록 디렉터리를 만들고 권한을 0700 으로 맞춘다. 이미 있으면 그대로 쓴다.
 * 단계마다 심볼릭 링크가 아닌 디렉터리인지 본다. 링크를 따라가면 AGENT_CHAT_HOME 밖에 쓰게 된다.
 */
export async function ensureRoomDir(home: unknown, meta: RecordsMeta): Promise<RoomDir | LocationFailure> {
  if (typeof home !== 'string' || home === '') return { ok: false, reason: 'no_dir', detail: 'the records directory is not set' };
  const checked = checkMeta(meta);
  if (!checked.ok) return checked;

  let current = path.resolve(home);
  try {
    // AGENT_CHAT_HOME 자체는 다른 모듈도 쓴다. 없을 때만 만들고 권한은 건드리지 않는다.
    await mkdir(current, { recursive: true, mode: DIR_MODE });
    for (const segment of checked.segments) {
      current = path.join(current, segment);
      try {
        await mkdir(current, { mode: DIR_MODE });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const stat = await lstat(current);
      if (!stat.isDirectory()) return { ok: false, reason: 'not_a_directory', detail: 'a records path component is not a directory' };
      if ((stat.mode & 0o777) !== DIR_MODE) await chmod(current, DIR_MODE);
    }
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, reason: 'dir_failed', detail: `cannot prepare the records directory: ${code}`, errorCode: code };
  }
  return { ok: true, dir: current, roomRef: refOf(meta.room_id) };
}

/** 링크를 따라가지 않는다. 그 자리에 심볼릭 링크가 있으면 여는 데 실패한다. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** 덧붙이기 전용으로 연다. 없으면 0600 으로 만든다. */
export async function openForAppend(file: string): Promise<FileHandle> {
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW, FILE_MODE);
  try {
    // 만들 때의 권한은 umask 에 깎이고, 이미 있던 파일은 다른 권한일 수 있다.
    await handle.chmod(FILE_MODE);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

/** 새로 쓴다. 같은 이름이 있으면 내용을 바꾼다. */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW, FILE_MODE);
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close();
  }
}

export async function openForRead(file: string): Promise<FileHandle> {
  return open(file, constants.O_RDONLY | NO_FOLLOW);
}
