// 로그 파일 이름과 보존 정리 (architecture.md 6.3).
// 보존은 파일 이름의 시간 구간으로만 판정한다. mtime 은 복사·백업·시계 변경으로 바뀌어 믿을 수 없다.

import { join } from 'node:path';

export const HOUR_MS = 3_600_000;
export const RETENTION_MS = 7 * 24 * HOUR_MS;
export const CLEANUP_INTERVAL_MS = HOUR_MS;
export const MAX_DIR_BYTES = 200 * 1024 * 1024;

const FILE_NAME = /^diag-(\d{4})(\d{2})(\d{2})T(\d{2})-([0-9a-z]{6})\.jsonl$/;

const two = (value: number): string => String(value).padStart(2, '0');

/** 그 시각이 드는 시간 구간의 이름. 예: `20261115T09`. 표현할 수 없는 시각이면 null. */
export function hourKeyOf(tsMs: number): string | null {
  if (!Number.isFinite(tsMs)) return null;
  const date = new Date(tsMs);
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 1000 || year > 9999) return null;
  return `${year}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}T${two(date.getUTCHours())}`;
}

export function logFileName(hourKey: string, proc: string): string {
  return `diag-${hourKey}-${proc}.jsonl`;
}

export interface ParsedLogFile {
  /** 시간 구간의 시작(epoch ms). 구간은 [startMs, startMs + 1시간) 이다. */
  readonly startMs: number;
  readonly proc: string;
}

/** 이 모듈이 만든 이름만 읽는다. 다른 파일은 정리가 건드리지 않는다. */
export function parseLogFileName(name: string): ParsedLogFile | null {
  const match = FILE_NAME.exec(name);
  if (match === null) return null;
  const [year, month, day, hour] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  const startMs = Date.UTC(year, month - 1, day, hour);
  // 13월, 32일, 25시 같은 값은 다른 시각으로 넘어간다. 되돌려 같은 이름이 나올 때만 받는다.
  if (hourKeyOf(startMs) !== `${match[1]}${match[2]}${match[3]}T${match[4]}`) return null;
  return { startMs, proc: match[5] as string };
}

/**
 * 그 구간의 마지막 줄까지 7일을 넘겼는가. 구간의 끝을 기준으로 해서 어떤 줄도 7일 전에 지워지지 않는다.
 * 정확히 7일인 순간은 아직 넘기지 않았다.
 */
export function isExpired(startMs: number, nowMs: number): boolean {
  return nowMs - (startMs + HOUR_MS) > RETENTION_MS;
}

export interface CleanupIo {
  list(dir: string): Promise<readonly string[]>;
  /** 보통 파일의 크기. 보통 파일이 아니면 0. */
  size(path: string): Promise<number>;
  /** 이미 없는 파일이면 성공으로 친다(다른 프로세스가 먼저 지웠다). */
  remove(path: string): Promise<void>;
}

export interface CleanupInput {
  readonly dir: string;
  readonly nowMs: number;
  readonly io: CleanupIo;
  /** 지금 쓰고 있는 자기 파일. 상한 정리에서 지우지 않는다. */
  readonly keep: string | null;
  readonly maxDirBytes: number;
  /** 참이 되면 남은 삭제를 그만둔다(로거를 닫았다). */
  readonly stopped: () => boolean;
}

export interface CleanupResult {
  readonly removed: number;
  readonly failed: number;
}

/** 7일 지난 파일을 지우고, 디렉터리가 상한을 넘으면 오래된 파일부터 더 지운다. 던지지 않는다. */
export async function cleanupLogDir(input: CleanupInput): Promise<CleanupResult> {
  const { dir, nowMs, io, keep, maxDirBytes, stopped } = input;
  let removed = 0;
  let failed = 0;
  let names: readonly string[];
  try {
    names = await io.list(dir);
  } catch {
    return { removed, failed: 1 };
  }

  const tryRemove = async (name: string): Promise<boolean> => {
    try {
      await io.remove(join(dir, name));
      removed += 1;
      return true;
    } catch {
      failed += 1;
      return false;
    }
  };

  // startMs 가 null 이면 상한 정리의 삭제 대상이 아니다(남의 파일이거나 이번 주기에 이미 삭제에 실패했다).
  const kept: { name: string; startMs: number | null }[] = [];
  for (const name of names) {
    if (stopped()) return { removed, failed };
    const parsed = parseLogFileName(name);
    if (parsed !== null && isExpired(parsed.startMs, nowMs)) {
      if (!(await tryRemove(name))) kept.push({ name, startMs: null });
    } else {
      kept.push({ name, startMs: parsed === null ? null : parsed.startMs });
    }
  }

  // 상한은 디렉터리 전체로 재지만 지우는 것은 이 모듈이 만든 이름뿐이다.
  let total = 0;
  const sized: { name: string; startMs: number; bytes: number }[] = [];
  for (const entry of kept) {
    if (stopped()) return { removed, failed };
    let bytes = 0;
    try {
      bytes = await io.size(join(dir, entry.name));
    } catch {
      // 재는 사이에 다른 프로세스가 지웠을 수 있다. 없는 것으로 친다.
      continue;
    }
    total += bytes;
    if (entry.startMs !== null && entry.name !== keep) sized.push({ name: entry.name, startMs: entry.startMs, bytes });
  }
  if (total <= maxDirBytes) return { removed, failed };

  sized.sort((a, b) => a.startMs - b.startMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sized) {
    if (total <= maxDirBytes || stopped()) break;
    if (await tryRemove(entry.name)) total -= entry.bytes;
  }
  return { removed, failed };
}
