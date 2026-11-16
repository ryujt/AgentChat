// Codex 설정 파일의 `[mcp_servers.agent-chat]` 표에 `tool_timeout_sec` 을 넣는다 (architecture.md 3.13 설치 단계 7).
// `codex mcp add` 에는 이 값을 주는 옵션이 없다. 그래서 등록 뒤에 그 표의 한 줄만 고친다.
// TOML 해석기가 아니다. 표 머리줄을 찾아 줄 하나를 넣거나 바꾼다. 표를 찾지 못하면 손대지 않고 실패로 돌려준다.
// 승인 모드 키(default_tools_approval_mode, enabled_tools, disabled_tools)는 쓰지 않는다. 있는지 읽기만 한다(다시 등록하면 Codex 가 지우므로).
// 큰따옴표 키의 이스케이프(`"agent\u002Dchat"`)는 풀어서 견준다. Codex 가 같은 이름으로 읽기 때문이다.
// 설치가 Codex 설정을 바꾸기 전(호스트 CLI 의 remove/add 포함)에 파일 전체를 백업한다. 백업은 가장 오래된 하나와 최근 BACKUP_KEEP 개만 남긴다.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Now } from '../protocol/index.js';
import { SERVER_NAME } from './types.js';

const TABLE_PATH: readonly string[] = ['mcp_servers', SERVER_NAME];
const KEY = 'tool_timeout_sec';
const KEY_LINE = /^\s*tool_timeout_sec\s*=/;
const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;
/** 남기는 최근 백업 수(가장 오래된 하나는 따로 남긴다). 백업에는 다른 MCP 서버의 환경 변수 값(비밀값)이 들 수 있어 끝없이 쌓지 않는다(검토 1차 BOUNDARY-R1-03). */
export const BACKUP_KEEP = 3;
const BACKUP_NAME = /^codex-config-\d{8}T\d{6}Z(?:-\d+)?\.toml$/;
/** 설치가 값을 정하는 키. `env` 는 하위 표(`[mcp_servers.agent-chat.env]`)로 적혀도 같다. */
const OWNED_KEYS: ReadonlySet<string> = new Set(['command', 'args', 'env', KEY]);

type MultiLineQuote = '"""' | "'''";
interface ScanState {
  /** 여러 줄 문자열 안이면 그 문자열을 닫는 따옴표. */
  multi: MultiLineQuote | null;
}

export type EditResult =
  | { readonly ok: true; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/**
 * 큰따옴표 문자열(따옴표 안쪽)의 TOML 이스케이프를 푼다: `\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX`.
 * TOML 1.0 에 없는 이스케이프, 모자란 자릿수, 유니코드 스칼라 값이 아닌 것(서로게이트, 0x10FFFF 초과)은 null 이다.
 * 키를 이스케이프로 적어도(`"agent\u002Dchat"`) Codex 는 같은 이름으로 읽는다. 풀지 않고 견주면 정의를 놓친다(검토 3차 BOUNDARY-R3-01).
 */
export function unescapeBasic(raw: string): string | null {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const kind = raw[index + 1] ?? '';
    const simple = SIMPLE_ESCAPES[kind];
    if (simple !== undefined) {
      out += simple;
      index += 1;
      continue;
    }
    const digits = kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
    const hex = raw.slice(index + 2, index + 2 + digits);
    if (digits === 0 || !new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) return null;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    index += 1 + digits;
  }
  return out;
}

/** `a."b c".d` 같은 표 이름을 마디로 나눈다. 큰따옴표 마디의 이스케이프는 푼다. 읽지 못하면 null. */
export function splitTablePath(text: string): string[] | null {
  const parts: string[] = [];
  let rest = text.trim();
  if (rest === '') return null;
  for (;;) {
    const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*/.exec(rest);
    if (match === null) return null;
    const part = match[1] !== undefined ? unescapeBasic(match[1]) : (match[2] ?? match[3] ?? '');
    if (part === null) return null;
    parts.push(part);
    rest = rest.slice(match[0].length);
    if (rest === '') return parts;
    if (!rest.startsWith('.')) return null;
    rest = rest.slice(1).trimStart();
  }
}

/** 한 줄에서 주석과 문자열 내용을 지운 글. 여러 줄 문자열의 열고 닫음을 state 에 이어 간다. */
function stripLine(line: string, state: ScanState): string {
  let out = '';
  let index = 0;
  while (index < line.length) {
    if (state.multi !== null) {
      const end = line.indexOf(state.multi, index);
      if (end < 0) return out;
      index = end + 3;
      state.multi = null;
      continue;
    }
    const three = line.slice(index, index + 3);
    if (three === '"""' || three === "'''") {
      state.multi = three;
      index += 3;
      continue;
    }
    const ch = line[index] as string;
    if (ch === '#') return out;
    if (ch === '"' || ch === "'") {
      index += 1;
      while (index < line.length && line[index] !== ch) index += ch === '"' && line[index] === '\\' ? 2 : 1;
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 표 머리줄(`[a.b]`, `[[a.b]]`)이면 표 이름의 마디를 준다. 배열 표와 읽지 못한 이름은 빈 배열이다.
 * 머리줄이 아니면 null 이다.
 */
function tableHeader(raw: string): string[] | null {
  const line = raw.trimStart();
  if (!line.startsWith('[')) return null;
  const array = line.startsWith('[[');
  const start = array ? 2 : 1;
  let index = start;
  while (index < line.length && line[index] !== ']') {
    const ch = line[index] as string;
    if (ch === '"' || ch === "'") {
      index += 1;
      while (index < line.length && line[index] !== ch) index += ch === '"' && line[index] === '\\' ? 2 : 1;
    }
    index += 1;
  }
  const close = array ? ']]' : ']';
  if (line.slice(index, index + close.length) !== close) return null;
  const rest = line.slice(index + close.length).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;
  return array ? [] : (splitTablePath(line.slice(start, index)) ?? []);
}

interface TableSpan {
  /** 표 머리줄의 줄 번호. */
  readonly header: number;
  /** 그 표의 `tool_timeout_sec` 줄. 없으면 -1. */
  readonly keyLine: number;
}

/** `[mcp_servers.agent-chat]` 표를 찾는다. 여러 줄에 걸친 값 안의 글은 표 머리줄로 보지 않는다. */
function findTable(lines: readonly string[]): TableSpan[] {
  const found: TableSpan[] = [];
  const state: ScanState = { multi: null };
  let depth = 0;
  let current: { header: number; keyLine: number } | null = null;
  for (const [index, raw] of lines.entries()) {
    if (state.multi === null && depth === 0) {
      const header = tableHeader(raw);
      if (header !== null) {
        if (current !== null) found.push(current);
        const own = header.length === TABLE_PATH.length && header.every((part, at) => part === TABLE_PATH[at]);
        current = own ? { header: index, keyLine: -1 } : null;
        continue;
      }
      if (current !== null && KEY_LINE.test(raw)) current.keyLine = index;
    }
    for (const ch of stripLine(raw, state)) {
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  if (current !== null) found.push(current);
  return found;
}

export type UserKeysResult =
  /** defined: 이 서버의 정의(어느 표기든)를 파일에서 찾았는가. */
  | { readonly ok: true; readonly keys: readonly string[]; readonly defined: boolean }
  | { readonly ok: false; readonly reason: string };

/** 읽다가 멈춘 곳. 줄 번호는 1부터다. 값의 원문은 싣지 않는다(비밀값이 들 수 있다). */
class TomlScanError extends Error {
  constructor(what: string, line: number) {
    super(`${what} near line ${line}`);
  }
}

/** 키 경로 하나에 값이 놓였다. 표 머리줄이면 header, 인라인 표 값이면 inline 이다. */
type KeySink = (path: readonly string[], kind: 'header' | 'key' | 'inline') => void;

/**
 * 설정 글 전체를 키 경로 단위로 훑는다. 표 머리줄의 경로, 점 키, 인라인 표를 이어 붙인 전체 경로를 sink 에 넘긴다.
 * TOML 해석기가 아니다. 키와 값의 경계, 문자열(네 가지), 배열, 인라인 표만 따라가고 값은 해석하지 않는다.
 * 닫히지 않은 문자열·배열·인라인 표나 읽지 못하는 키는 던진다(모르는 것을 아는 척 넘어가지 않는다).
 */
function scanTomlKeys(text: string, sink: KeySink): void {
  let i = 0;
  const lineAt = (at: number): number => text.slice(0, at).split('\n').length;
  const fail = (what: string): never => {
    throw new TomlScanError(what, lineAt(i));
  };
  const skipSpaces = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  };
  /** 공백, 줄바꿈, 주석을 건너뛴다(배열과 인라인 표 안). */
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces();
      const ch = text[i];
      if (ch === '\r' || ch === '\n') i += 1;
      else if (ch === '#') while (i < text.length && text[i] !== '\n') i += 1;
      else return;
    }
  };
  /** 한 줄짜리 문자열. 여는 따옴표에서 시작한다. */
  const skipLineString = (quote: '"' | "'"): void => {
    i += 1;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\n' || text[i] === '\r') fail('unterminated string');
      i += quote === '"' && text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) fail('unterminated string');
    i += 1;
  };
  /** 여러 줄 문자열. 여는 따옴표 셋에서 시작한다. 닫는 셋 뒤에 따옴표가 둘까지 더 붙을 수 있다. */
  const skipMultiString = (quote: '"' | "'"): void => {
    const close = quote.repeat(3);
    i += 3;
    for (;;) {
      if (i >= text.length) fail('unterminated multi-line string');
      if (quote === '"' && text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text.startsWith(close, i)) {
        i += 3;
        for (let extra = 0; extra < 2 && text[i] === quote; extra += 1) i += 1;
        return;
      }
      i += 1;
    }
  };
  /** 키 한 마디: 맨 이름, "큰따옴표"(이스케이프를 푼다), '작은따옴표'. */
  const keyPart = (): string => {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      skipLineString('"');
      const part = unescapeBasic(text.slice(start + 1, i - 1));
      return part === null ? fail('unreadable escape in key') : part;
    }
    if (ch === "'") {
      const start = i;
      skipLineString("'");
      return text.slice(start + 1, i - 1);
    }
    const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
    if (match === null) return fail('unreadable key');
    i += match[0].length;
    return match[0];
  };
  /** 점으로 이은 키(`a."b c".d`). 마디 사이 공백을 허용한다. */
  const dottedKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      parts.push(keyPart());
      skipSpaces();
      if (text[i] !== '.') return parts;
      i += 1;
    }
  };
  /** 값 하나를 건너뛴다. path 가 있으면(배열 안이 아니면) 인라인 표의 키를 sink 에 넘긴다. */
  const value = (path: readonly string[] | null): void => {
    skipSpaces();
    const ch = text[i];
    if (text.startsWith('"""', i)) return skipMultiString('"');
    if (text.startsWith("'''", i)) return skipMultiString("'");
    if (ch === '"' || ch === "'") return skipLineString(ch);
    if (ch === '[') {
      i += 1;
      for (;;) {
        skipBlank();
        if (i >= text.length) fail('unterminated array');
        if (text[i] === ']') {
          i += 1;
          return;
        }
        value(null);
        skipBlank();
        if (text[i] === ',') i += 1;
        else if (text[i] !== ']') fail('unterminated array');
      }
    }
    if (ch === '{') {
      if (path !== null) sink(path, 'inline');
      i += 1;
      for (;;) {
        skipBlank();
        if (i >= text.length) fail('unterminated inline table');
        if (text[i] === '}') {
          i += 1;
          return;
        }
        const key = dottedKey();
        if (text[i] !== '=') fail('expected = in inline table');
        i += 1;
        const full = path === null ? null : [...path, ...key];
        if (full !== null) sink(full, 'key');
        value(full);
        skipBlank();
        if (text[i] === ',') i += 1;
        else if (text[i] !== '}') fail('unterminated inline table');
      }
    }
    // 수, 참·거짓, 날짜·시각(공백이 들 수 있다). 구분 문자까지 간다.
    const start = i;
    while (i < text.length && !',]}#\r\n'.includes(text[i] as string)) i += 1;
    if (text.slice(start, i).trim() === '') fail('missing value');
  };

  /** 지금 표의 경로. 배열 표(`[[a]]`) 안이면 null 이다(그 키는 이 서버의 정의가 아니다). */
  let table: readonly string[] | null = [];
  for (;;) {
    skipBlank();
    if (i >= text.length) return;
    if (text[i] === '[') {
      const array = text.startsWith('[[', i);
      i += array ? 2 : 1;
      const path = dottedKey();
      if (!text.startsWith(array ? ']]' : ']', i)) fail('unreadable table header');
      i += array ? 2 : 1;
      table = array ? null : path;
      if (!array) sink(path, 'header');
    } else {
      const key = dottedKey();
      if (text[i] !== '=') fail('expected =');
      i += 1;
      const full = table === null ? null : [...table, ...key];
      if (full !== null) sink(full, 'key');
      value(full);
    }
    // 줄 끝까지는 공백과 주석만 온다.
    skipSpaces();
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i += 1;
    if (i < text.length && text[i] !== '\n' && text[i] !== '\r') fail('unexpected text after value');
  }
}

/**
 * 이 서버의 정의에 설치가 정하지 않는 키가 있으면 그 이름을 준다.
 * 예: `disabled_tools`, `default_tools_approval_mode`, `startup_timeout_sec`, 하위 표 `tools`.
 * `codex mcp get --json` 은 승인 모드 키를 내지 않으므로 파일도 읽는다(architecture.md 3.13).
 * 정의는 표기가 여럿이다(검토 2차 BOUNDARY-R2-01). 표 머리줄 `[mcp_servers.agent-chat]` 과 하위 표, `[mcp_servers]` 안의 점 키
 * `agent-chat.<키>` 와 인라인 표 `agent-chat = { … }`, 최상위 점 키 `mcp_servers.agent-chat.<키>`, 최상위 인라인 표 모두 같은 경로로 읽는다.
 * 정의가 없으면 빈 목록이고 defined 는 거짓이다. 읽지 못하면 ok 가 거짓이다.
 */
export function userKeysInTable(text: string): UserKeysResult {
  const keys = new Set<string>();
  let defined = false;
  let headers = 0;
  try {
    scanTomlKeys(text, (path, kind) => {
      const inside = path.length >= TABLE_PATH.length && TABLE_PATH.every((part, at) => path[at] === part);
      if (!inside) return;
      defined = true;
      if (path.length === TABLE_PATH.length) {
        if (kind === 'header') headers += 1;
        return;
      }
      const name = path[TABLE_PATH.length] as string;
      // 설치가 정하는 키 아래(env.<변수>)는 사용자 설정이 아니다. 하위 표 머리줄이 더 깊으면(env.x) 이상한 꼴이라 알린다.
      if (!OWNED_KEYS.has(name) || (kind === 'header' && path.length > TABLE_PATH.length + 1)) keys.add(name);
    });
  } catch (error) {
    if (error instanceof TomlScanError) return { ok: false, reason: error.message };
    throw error;
  }
  if (headers > 1) return { ok: false, reason: `[${TABLE_PATH.join('.')}] table appears more than once` };
  return { ok: true, keys: [...keys], defined };
}

/**
 * 작업 폴더에서 Codex 가 읽을 수 있는 프로젝트 설정 파일(`.codex/config.toml`)의 자리. 저장소 뿌리 쪽부터 작업 폴더 쪽 순서다.
 * Codex 는 git 저장소 안이면 저장소 뿌리부터 작업 폴더까지의 것을, 밖이면 작업 폴더의 것만 읽고, 신뢰한 프로젝트일 때만 쓴다
 * (실제 Codex 0.169.0 으로 확인. 검토 3차 BOUNDARY-R3-02). 신뢰 여부는 보지 않는다(보수 쪽). hasGit 은 그 자리에 `.git` 이 있는지 본다.
 */
export function projectConfigPaths(cwd: string, hasGit: (path: string) => boolean): string[] {
  const start = resolve(cwd);
  const configIn = (dir: string): string => join(dir, '.codex', 'config.toml');
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (hasGit(join(dir, '.git'))) return dirs.reverse().map(configIn);
    if (dirname(dir) === dir) return [configIn(start)];
  }
}

/** 설정 글에 `tool_timeout_sec = <초>` 를 넣거나 바꾼다. 파일을 읽고 쓰지 않는다. */
export function setToolTimeout(text: string, seconds: number): EditResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const tables = findTable(lines);
  const name = `[${TABLE_PATH.join('.')}]`;
  if (tables.length === 0) return { ok: false, reason: `${name} table not found` };
  if (tables.length > 1) return { ok: false, reason: `${name} table appears more than once` };
  const table = tables[0] as TableSpan;
  const wanted = `${KEY} = ${seconds}`;
  if (table.keyLine >= 0) {
    if ((lines[table.keyLine] as string).trim() === wanted) return { ok: true, text, changed: false };
    lines[table.keyLine] = wanted;
  } else {
    lines.splice(table.header + 1, 0, wanted);
  }
  return { ok: true, text: lines.join(eol), changed: true };
}

export interface ApplyOptions {
  readonly configPath: string;
  /** 백업을 둘 폴더(`<AGENT_CHAT_HOME>/backups`). null 이면 백업하지 않는다(부른 쪽이 바꾸기 전에 이미 떴다). */
  readonly backupDir: string | null;
  readonly seconds: number;
  readonly now: Now;
}

export type ApplyResult =
  | { readonly ok: true; readonly changed: boolean; readonly backupPath: string | null; restore(): void }
  | { readonly ok: false; readonly reason: string };

function stamp(now: Now): string {
  return new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** 백업을 쓴다. 같은 시각의 백업이 있으면 덮어쓰지 않고 다른 이름으로 둔다. 남은 백업은 가장 오래된 하나와 최근 BACKUP_KEEP 개로 줄인다. */
function writeBackup(backupDir: string, content: string, now: Now): string {
  mkdirSync(backupDir, { recursive: true, mode: BACKUP_DIR_MODE });
  const base = join(backupDir, `codex-config-${stamp(now)}`);
  let backupPath = `${base}.toml`;
  for (let suffix = 2; existsSync(backupPath); suffix += 1) backupPath = `${base}-${suffix}.toml`;
  // 다른 MCP 서버의 환경 변수 값이 들어 있을 수 있다. 소유자만 읽게 둔다.
  writeFileSync(backupPath, content, { mode: BACKUP_FILE_MODE, flag: 'wx' });
  pruneBackups(backupDir, backupPath);
  return backupPath;
}

/**
 * 설치가 만든 이름의 백업 가운데 가장 오래된 하나와 최근 BACKUP_KEEP 개만 남긴다. 방금 쓴 것은 지우지 않는다. 다른 이름의 파일은 건드리지 않는다.
 * 가장 오래된 것은 설치가 처음 고치기 전의 원래 파일이다. Codex CLI 의 `mcp add`·`remove` 는 다른 서버 표의 표기까지 다시 쓰므로
 * (뜻은 같다. 2026-11-16-final-install 관찰 1), 회전만 하면 원래 표기가 든 유일한 사본을 네 번째 설치에서 잃는다.
 */
function pruneBackups(backupDir: string, keepPath: string): void {
  const all = readdirSync(backupDir)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => join(backupDir, name))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    // 새 것부터(수정 시각). 같으면 이름 순서로 정한다.
    .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? 1 : -1));
  const oldest = all[all.length - 1];
  const others = all.filter((entry) => entry.path !== keepPath && entry !== oldest);
  for (const entry of others.slice(BACKUP_KEEP - 1)) rmSync(entry.path, { force: true });
}

export interface BackupOptions {
  readonly configPath: string;
  readonly backupDir: string;
  readonly now: Now;
}

export type BackupResult = { readonly ok: true; readonly backupPath: string | null } | { readonly ok: false; readonly reason: string };

/** 설정 파일 전체를 백업한다. 파일이 없으면 아무 것도 쓰지 않고 backupPath 는 null 이다. 호스트 CLI 가 파일을 고치기 전에 부른다. */
export function backupCodexConfig(options: BackupOptions): BackupResult {
  try {
    if (!existsSync(options.configPath)) return { ok: true, backupPath: null };
    const original = readFileSync(realpathSync(options.configPath), 'utf8');
    return { ok: true, backupPath: writeBackup(options.backupDir, original, options.now) };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'error';
    return { ok: false, reason: `could not back up the Codex config file (${code})` };
  }
}

/**
 * 설정 파일을 백업한 뒤 고친다. 임시 파일에 쓰고 이름을 바꾼다.
 * 돌려준 restore() 는 고치기 전 내용으로 되돌린다(고친 파일을 Codex 가 읽지 못할 때 쓴다).
 */
export function applyToolTimeout(options: ApplyOptions): ApplyResult {
  const { backupDir, seconds, now } = options;
  try {
    // 설정 파일이 링크면 링크가 가리키는 파일을 고친다. 링크를 보통 파일로 바꿔 놓지 않는다.
    const configPath = realpathSync(options.configPath);
    const original = readFileSync(configPath, 'utf8');
    const edited = setToolTimeout(original, seconds);
    if (!edited.ok) return edited;
    if (!edited.changed) return { ok: true, changed: false, backupPath: null, restore: () => undefined };

    const backupPath = backupDir === null ? null : writeBackup(backupDir, original, now);

    const mode = statSync(configPath).mode & 0o777;
    const replace = (content: string): void => {
      const temporary = join(dirname(configPath), `.config.toml.agent-chat-${process.pid}.tmp`);
      writeFileSync(temporary, content, { mode });
      chmodSync(temporary, mode);
      renameSync(temporary, configPath);
    };
    replace(edited.text);
    return { ok: true, changed: true, backupPath, restore: () => replace(original) };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'error';
    return { ok: false, reason: `could not edit the Codex config file (${code})` };
  }
}
