// Gemini CLI 의 MCP 등록 읽기 (architecture.md 3.13). Gemini CLI 에는 `mcp get` 이 없고 `mcp list` 는 환경 변수를 보이지 않는다.
// 그래서 등록은 설정 파일(사용자 `~/.gemini/settings.json`, 작업 폴더의 `.gemini/settings.json`)의 `mcpServers["agent-chat"]` 로 읽는다.
// 쓰기는 하지 않는다. 등록과 제거는 Gemini CLI(`mcp add`·`mcp remove --scope user`)가 하고, 설치는 그 전에 파일을 백업한다.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Now } from '../protocol/index.js';
import type { Lookup, Registration } from './registration.js';
import { SERVER_NAME } from './types.js';

export interface GeminiSettingsPaths {
  /** 사용자 설정. 설치가 등록하는 곳이다. */
  readonly user: string;
  /** 작업 폴더의 프로젝트 설정. 사용자 설정과 같은 파일이면 null. 여기에 등록이 있으면 Gemini CLI 가 그것을 먼저 쓴다. */
  readonly project: string | null;
}

export function geminiSettingsPaths(userHome: string, cwd: string): GeminiSettingsPaths {
  const user = join(userHome, '.gemini', 'settings.json');
  const project = join(cwd, '.gemini', 'settings.json');
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return { user, project: real(project) === real(user) ? null : project };
}

/** 설치가 정하는 칸. 그 밖의 칸(trust, timeout, includeTools, excludeTools, cwd 등)은 사용자가 더한 설정이다. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set(['command', 'args', 'env']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type FileRead = { readonly state: 'missing' } | { readonly state: 'bad'; readonly detail: string } | { readonly state: 'ok'; readonly entry: unknown };

function readEntry(path: string): FileRead {
  if (!existsSync(path)) return { state: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { state: 'bad', detail: `${path} 를 JSON 으로 읽지 못했다` };
  }
  if (!isRecord(parsed)) return { state: 'bad', detail: `${path} 가 JSON 객체가 아니다` };
  const servers = parsed['mcpServers'];
  if (servers === undefined) return { state: 'missing' };
  if (!isRecord(servers)) return { state: 'bad', detail: `${path} 의 mcpServers 가 객체가 아니다` };
  return Object.hasOwn(servers, SERVER_NAME) ? { state: 'ok', entry: servers[SERVER_NAME] } : { state: 'missing' };
}

function registrationOf(entry: unknown, scope: Registration['scope']): Registration {
  const record = isRecord(entry) ? entry : {};
  const command = typeof record['command'] === 'string' ? record['command'] : '';
  const args = Array.isArray(record['args']) ? record['args'].filter((arg): arg is string => typeof arg === 'string') : [];
  const env: Record<string, string> = {};
  if (isRecord(record['env'])) {
    for (const [key, value] of Object.entries(record['env'])) if (typeof value === 'string') env[key] = value;
  }
  const extraSettings = Object.keys(record)
    .filter((key) => !KNOWN_FIELDS.has(key))
    .sort();
  return { command, args, argsText: args.join(' '), env, scope, toolTimeoutSec: null, extraSettings };
}

/** 프로젝트 설정의 등록이 먼저다(Gemini CLI 가 그것을 쓴다). 그다음 사용자 설정이다. */
export function readGeminiRegistration(paths: GeminiSettingsPaths): Lookup {
  if (paths.project !== null) {
    const project = readEntry(paths.project);
    if (project.state === 'ok') return { state: 'present', registration: registrationOf(project.entry, 'project') };
    // 읽지 못하는 프로젝트 설정은 Gemini CLI 도 읽지 못한다고 보고 넘어간다.
  }
  const user = readEntry(paths.user);
  if (user.state === 'missing') return { state: 'absent' };
  if (user.state === 'bad') return { state: 'unreadable', detail: user.detail };
  return { state: 'present', registration: registrationOf(user.entry, 'user') };
}

/** Gemini CLI 가 고치기 전에 사용자 설정을 복사해 둔다. 파일이 없으면 할 일이 없다. */
export function backupGeminiSettings(
  path: string,
  backupDir: string,
  now: Now,
): { readonly ok: true; readonly backupPath: string | null } | { readonly ok: false; readonly reason: string } {
  if (!existsSync(path)) return { ok: true, backupPath: null };
  try {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const target = join(backupDir, `gemini-settings-${stamp}.json`);
    copyFileSync(path, target);
    return { ok: true, backupPath: target };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, reason: typeof code === 'string' ? code : 'copy failed' };
  }
}
