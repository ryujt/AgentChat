#!/usr/bin/env node
// 설정 전후 비교 도구 (architecture.md 3.13 "설치가 쓰는 곳과 전후 비교", V-S1·V-I1 이 쓴다).
//
// 설치 전후에 호스트 설정의 "권한에 관한 키의 고정 목록"이 뜻이 같은지 본다. 파일 전체를 비교하지 않는다.
// 호스트가 같은 파일을 스스로 고쳐 쓰기 때문이다. 목록은 설계 문서의 표와 같다.
//
// 설치 코드(src/setup)를 import 하지 않는다. 설정 파일을 읽는 코드를 설치와 따로 둬야 같은 결함을 함께 갖지 않는다.
// TOML 해석기 의존성을 더하지 않는다. 아래의 줄 단위 읽기로 (표 이름, 키)마다 값 원문을 얻고, 값 원문만 뜻으로 바꿔 견준다
// (따옴표 종류·수의 표기·배열 공백이 달라도 뜻이 같으면 같다. 읽지 못한 값은 원문으로 견준다).
//
// 사용법:
//   node tests/e2e/install/settings-snapshot.mjs take <사본 폴더> [--home <홈>] [--cwd <작업 폴더>] [--app <설치된 저장소>] [--codex-bin <codex>]
//   node tests/e2e/install/settings-snapshot.mjs compare <앞 사본 폴더> <뒤 사본 폴더>
//   node tests/e2e/install/settings-snapshot.mjs clean <사본 폴더>…
//
// - 사본은 0700 폴더에 0600 파일로 둔다. 다른 MCP 서버의 환경 변수 값이 들어 있을 수 있다. 비교가 끝나면 clean 으로 지운다.
// - 결과에는 달라진 키의 이름만 출력한다. 값은 출력하지 않는다.
// - compare 의 종료 코드: 0 = 같다, 1 = 다르다, 2 = 사용법 오류나 사본을 읽지 못함.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWN_SERVER = 'agent-chat';
const MANIFEST = 'manifest.json';
const CODEX_LIST = 'codex-mcp-list.json';

/** `~/.claude.json` 의 `projects.*` 항목마다 비교하는 키. mcpContextUris 는 A-MCP-10 확인에서 더했다. */
export const CLAUDE_PROJECT_KEYS = [
  'allowedTools',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'mcpContextUris',
];
/** 설정 파일(settings.json)에서 항상 비교하는 키와, 이름에 이 낱말이 들면 비교하는 최상위 키. */
export const SETTINGS_KEYS = ['permissions', 'hooks'];
export const SETTINGS_NAME_PATTERN = /permission|hook|mcp|sandbox/i;
/** Codex 설정에서 `mcp_servers` 밖의 표와 키 가운데 이름에 이 낱말이 들면 비교한다. */
export const CODEX_NAME_PATTERN = /approval|sandbox|trust|hook|permission/i;
/** `[mcp_servers.agent-chat]` 표에 있어도 되는 키. 승인 모드 키는 없어야 한다. */
export const CODEX_OWN_KEYS = ['command', 'args', 'env', 'tool_timeout_sec'];

/** 이 도구가 스스로 만든 오류. 글에 설정 값을 넣지 않는다. */
class SnapshotError extends Error {}

// ── 값 비교 ─────────────────────────────────────────────────────────────────

/** JSON 값의 뜻이 같은가. 객체의 키 순서는 보지 않는다. 배열의 순서는 본다. */
export function sameJson(left, right) {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameJson(left[key], right[key]));
}

/** 값이 "비어 있거나 거짓"인가. 권한을 준 것이 없다는 뜻이다. */
function isEmptyOrFalse(value) {
  if (value === undefined || value === null || value === false || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

// ── TOML 줄 단위 읽기 ───────────────────────────────────────────────────────

/** 한 줄을 훑어 주석을 떼고, 문자열과 괄호가 열려 있는지를 state 에 이어 간다. 값의 원문은 그대로 둔다. */
function scanLine(line, state) {
  let out = '';
  let index = 0;
  while (index < line.length) {
    if (state.quote !== null) {
      const end = line.indexOf(state.quote, index);
      if (end < 0) return out + line.slice(index);
      out += line.slice(index, end + 3);
      index = end + 3;
      state.quote = null;
      continue;
    }
    const three = line.slice(index, index + 3);
    if (three === '"""' || three === "'''") {
      state.quote = three;
      out += three;
      index += 3;
      continue;
    }
    const ch = line[index];
    if (ch === '#') break;
    if (ch === '"' || ch === "'") {
      let end = index + 1;
      while (end < line.length && line[end] !== ch) end += ch === '"' && line[end] === '\\' ? 2 : 1;
      out += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (ch === '[' || ch === '{') state.depth += 1;
    else if (ch === ']' || ch === '}') state.depth = Math.max(0, state.depth - 1);
    out += ch;
    index += 1;
  }
  return out;
}

/** `a."b c".d` 같은 이름을 마디로 나눈다. 읽지 못하면 원문 한 마디로 둔다(이름이 달라지면 다르다고 나온다). */
function splitName(text) {
  const parts = [];
  let rest = text.trim();
  while (rest !== '') {
    const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.\s*)?/.exec(rest);
    if (match === null) return [text.trim()];
    parts.push(match[1] ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length);
  }
  return parts.length === 0 ? [text.trim()] : parts;
}

/** 값의 시작을 알리는 `=` 의 위치. 따옴표 안의 것은 세지 않는다. */
function findEquals(line) {
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '=') return index;
    if (ch === '"' || ch === "'") {
      index += 1;
      while (index < line.length && line[index] !== ch) index += ch === '"' && line[index] === '\\' ? 2 : 1;
    }
  }
  return -1;
}

/**
 * 설정 글을 `{ table: 마디[], key: 마디[], value: 값 원문 }` 의 목록으로 읽는다.
 * 줄 순서, 빈 줄, 주석이 달라져도 결과가 같다. 값은 원문 그대로 둔다(뜻으로 바꾸는 것은 tomlValueMeaning).
 */
export function readTomlEntries(text) {
  const entries = [];
  const arrayCounts = new Map();
  let table = [];
  let pending = null;
  const state = { quote: null, depth: 0 };
  for (const raw of text.split(/\r?\n/)) {
    if (pending !== null) {
      // 여러 줄에 걸친 값은 닫힐 때까지 잇는다.
      const inString = state.quote !== null;
      const piece = scanLine(raw, state);
      pending.value += inString ? `\n${piece}` : ` ${piece.trim()}`;
      if (state.quote === null && state.depth === 0) {
        entries.push({ table, key: pending.key, value: pending.value.trim() });
        pending = null;
      }
      continue;
    }
    const line = scanLine(raw, state).trim();
    if (line === '') continue;
    const equals = findEquals(line);
    if (line.startsWith('[') && (equals < 0 || line.indexOf(']') < equals)) {
      // 표 머리줄. 머리줄의 괄호는 값의 괄호가 아니다.
      state.depth = 0;
      const array = line.startsWith('[[');
      const name = splitName(line.slice(array ? 2 : 1, line.lastIndexOf(array ? ']]' : ']')));
      if (array) {
        const id = JSON.stringify(name);
        const count = arrayCounts.get(id) ?? 0;
        arrayCounts.set(id, count + 1);
        table = [...name, `#${count}`];
      } else table = name;
      continue;
    }
    if (equals < 0) {
      state.depth = 0;
      continue;
    }
    const key = splitName(line.slice(0, equals));
    const value = line.slice(equals + 1).trim();
    if (state.quote === null && state.depth === 0) entries.push({ table, key, value });
    else pending = { key, value };
  }
  if (pending !== null) entries.push({ table, key: pending.key, value: pending.value.trim() });
  return entries;
}

// ── TOML 값의 뜻 ────────────────────────────────────────────────────────────
//
// 값 원문을 뜻으로 바꿔 견준다. Codex CLI 가 `mcp add`·`remove` 로 파일을 다시 쓰면서 다른 서버 표의 표기를 바꾸기 때문이다
// (2026-11-16 실제 홈 V-S1 S-FI-01, Codex 0.169.0: `30` → `30.0`, `[ "a", "b" ]` → `["a", "b"]`, `args = []` 지움.
// Codex 가 읽는 값은 같았다). 문자열은 "s:", 수는 "n:", 날짜·시각은 "d:" 를 앞에 붙여 종류가 다르면 다르게 한다.
// 정수와 소수는 수의 값이 같으면 같다(Codex 가 시간 값을 스스로 정수에서 소수로 바꿔 쓴다). 읽지 못하면 undefined 다.

const BASIC_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

class TomlValueReader {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }

  fail() {
    throw new SnapshotError('TOML 값을 읽지 못했다');
  }

  skip() {
    while (this.at < this.text.length && /[ \t\r\n]/.test(this.text[this.at])) this.at += 1;
  }

  startsWith(token) {
    return this.text.startsWith(token, this.at);
  }

  value() {
    this.skip();
    if (this.startsWith('"""')) return `s:${this.basic('"""', true)}`;
    if (this.startsWith("'''")) return `s:${this.literal("'''", true)}`;
    if (this.startsWith('"')) return `s:${this.basic('"', false)}`;
    if (this.startsWith("'")) return `s:${this.literal("'", false)}`;
    if (this.startsWith('[')) return this.array();
    if (this.startsWith('{')) return this.inlineTable();
    return this.bare();
  }

  basic(quote, multi) {
    this.at += quote.length;
    if (multi && this.startsWith('\r\n')) this.at += 2;
    else if (multi && this.startsWith('\n')) this.at += 1;
    let out = '';
    for (;;) {
      if (this.at >= this.text.length) this.fail();
      if (this.startsWith(quote)) {
        // 여러 줄 문자열은 닫는 따옴표 앞에 따옴표 두 개까지 더 올 수 있다(따옴표 넷이면 내용 끝의 따옴표 하나).
        const run = multi ? Math.min(/^"*/.exec(this.text.slice(this.at))[0].length, 5) : 1;
        out += '"'.repeat(run - quote.length);
        this.at += run;
        return out;
      }
      const ch = this.text[this.at];
      if (!multi && ch === '\n') this.fail();
      if (ch !== '\\') {
        out += ch;
        this.at += 1;
        continue;
      }
      const next = this.text[this.at + 1];
      if (next in BASIC_ESCAPES) {
        out += BASIC_ESCAPES[next];
        this.at += 2;
      } else if (next === 'u' || next === 'U') {
        const size = next === 'u' ? 4 : 8;
        const hex = this.text.slice(this.at + 2, this.at + 2 + size);
        if (!new RegExp(`^[0-9A-Fa-f]{${size}}$`).test(hex)) this.fail();
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail();
        out += String.fromCodePoint(code);
        this.at += 2 + size;
      } else if (multi && /^\\[ \t]*\r?\n/.test(this.text.slice(this.at))) {
        // 줄 끝의 역빗금: 다음 공백 아닌 글자까지 버린다.
        this.at += 1;
        this.skip();
      } else this.fail();
    }
  }

  literal(quote, multi) {
    this.at += quote.length;
    if (multi && this.startsWith('\r\n')) this.at += 2;
    else if (multi && this.startsWith('\n')) this.at += 1;
    const end = this.text.indexOf(quote, this.at);
    if (end < 0) this.fail();
    // 여러 줄 리터럴도 닫는 따옴표 앞에 따옴표 두 개까지 올 수 있다.
    const close = multi ? end + Math.min(/^'*/.exec(this.text.slice(end))[0].length, 5) - quote.length : end;
    const out = this.text.slice(this.at, close);
    if (!multi && out.includes('\n')) this.fail();
    this.at = close + quote.length;
    return out;
  }

  array() {
    this.at += 1;
    const items = [];
    for (;;) {
      this.skip();
      if (this.startsWith(']')) {
        this.at += 1;
        return items;
      }
      items.push(this.value());
      this.skip();
      if (this.startsWith(',')) this.at += 1;
      else if (!this.startsWith(']')) this.fail();
    }
  }

  key() {
    const parts = [];
    for (;;) {
      this.skip();
      if (this.startsWith('"')) parts.push(this.basic('"', false));
      else if (this.startsWith("'")) parts.push(this.literal("'", false));
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.at));
        if (match === null) this.fail();
        parts.push(match[0]);
        this.at += match[0].length;
      }
      this.skip();
      if (!this.startsWith('.')) return parts;
      this.at += 1;
    }
  }

  inlineTable() {
    this.at += 1;
    const table = {};
    this.skip();
    if (this.startsWith('}')) {
      this.at += 1;
      return table;
    }
    for (;;) {
      const parts = this.key();
      if (!this.startsWith('=')) this.fail();
      this.at += 1;
      let target = table;
      for (const part of parts.slice(0, -1)) {
        if (target[part] === undefined) target[part] = {};
        if (typeof target[part] !== 'object' || Array.isArray(target[part])) this.fail();
        target = target[part];
      }
      const last = parts[parts.length - 1];
      if (Object.prototype.hasOwnProperty.call(target, last)) this.fail();
      target[last] = this.value();
      this.skip();
      if (this.startsWith('}')) {
        this.at += 1;
        return table;
      }
      if (!this.startsWith(',')) this.fail();
      this.at += 1;
    }
  }

  bare() {
    const rest = this.text.slice(this.at);
    const date = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/.exec(rest);
    if (date !== null) {
      this.at += date[0].length;
      return `d:${date[0].toUpperCase().replace(' ', 'T')}`;
    }
    const token = /^[A-Za-z0-9_+.-]+/.exec(rest);
    if (token === null) this.fail();
    this.at += token[0].length;
    const word = token[0];
    if (word === 'true' || word === 'false') return word === 'true';
    if (/^[+-]?(?:inf|nan)$/.test(word)) return `n:${word.replace(/^\+/, '')}`;
    const radix = /^0([xob])([0-9A-Fa-f](?:_?[0-9A-Fa-f])*)$/.exec(word);
    if (radix !== null) {
      const digits = radix[2].replaceAll('_', '');
      const pattern = { x: /^[0-9A-Fa-f]+$/, o: /^[0-7]+$/, b: /^[01]+$/ }[radix[1]];
      if (!pattern.test(digits)) this.fail();
      return `n:${BigInt(`0${radix[1]}${digits}`).toString()}`;
    }
    if (/^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(word)) return `n:${BigInt(word.replaceAll('_', '')).toString()}`;
    if (/^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/.test(word)) {
      const number = Number(word.replaceAll('_', ''));
      if (!Number.isFinite(number)) this.fail();
      // 정수와 같은 값의 소수는 정수와 같게 적는다(`30.0` 과 `30`).
      return `n:${Number.isInteger(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? BigInt(number).toString() : String(number)}`;
    }
    return this.fail();
  }
}

/** 값 원문의 뜻. 읽지 못하면 undefined 다(그때는 원문으로 견준다). */
export function tomlValueMeaning(raw) {
  try {
    const reader = new TomlValueReader(raw);
    const value = reader.value();
    reader.skip();
    return reader.at === raw.length ? value : undefined;
  } catch (error) {
    if (error instanceof SnapshotError) return undefined;
    throw error;
  }
}

function showName(parts) {
  return parts.map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part))).join('.');
}

function entryName(entry) {
  return entry.table.length === 0 ? showName(entry.key) : `[${showName(entry.table)}] ${showName(entry.key)}`;
}

// ── 파일별로 비교할 값을 고른다 ─────────────────────────────────────────────

/** `~/.claude.json` 에서 비교할 (이름 → 값). */
function pickClaudeJson(config) {
  const picked = new Map();
  const servers = config !== null && typeof config.mcpServers === 'object' && config.mcpServers !== null ? config.mcpServers : {};
  for (const [name, server] of Object.entries(servers)) {
    if (name !== OWN_SERVER) picked.set(`mcpServers.${name}`, server);
  }
  const projects = config !== null && typeof config.projects === 'object' && config.projects !== null ? config.projects : {};
  for (const [project, value] of Object.entries(projects)) {
    for (const key of CLAUDE_PROJECT_KEYS) {
      const found = value === null || typeof value !== 'object' ? undefined : value[key];
      // 비어 있거나 거짓인 값은 키가 없는 것과 뜻이 같다. 호스트가 빈 기본값을 채워 넣어도 다르다고 하지 않는다.
      // 그래서 설치 전에 없던 projects 항목도 이 키들이 비어 있거나 거짓이면 같다고 나온다.
      picked.set(`projects.${JSON.stringify(project)}.${key}`, isEmptyOrFalse(found) ? undefined : found);
    }
  }
  return picked;
}

/** 설정 파일에서 비교할 (이름 → 값). */
function pickSettings(config) {
  const picked = new Map();
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return picked;
  for (const [key, value] of Object.entries(config)) {
    if (SETTINGS_KEYS.includes(key) || SETTINGS_NAME_PATTERN.test(key)) picked.set(key, value);
  }
  return picked;
}

/** Codex 설정에서 비교할 (이름 → 값 원문)과, agent-chat 표에 있으면 안 되는 키의 이름. */
function pickCodexToml(text) {
  const picked = new Map();
  const unexpected = [];
  for (const entry of readTomlEntries(text)) {
    const names = [...entry.table, ...entry.key];
    const inServers = names[0] === 'mcp_servers';
    if (inServers && names[1] === OWN_SERVER) {
      // 표 바로 아래의 키는 정해진 넷뿐이다. env 는 하위 표나 점 키로 적혀도 된다.
      if (!CODEX_OWN_KEYS.includes(names[2])) unexpected.push(entryName(entry));
      continue;
    }
    const listed =
      inServers || names.some((name) => CODEX_NAME_PATTERN.test(name)) || (entry.table.length === 0 && entry.key.length === 1 && entry.key[0] === 'notify');
    if (!listed) continue;
    const meaning = tomlValueMeaning(entry.value);
    // 다른 서버의 빈 `args` 는 없는 키와 같다. Codex 의 기본값이 빈 인자 목록이고, Codex 가 다시 쓸 때 이 줄을 지운다(S-FI-01).
    // 다른 빈 목록(`enabled_tools = []` 등)은 "아무 것도 허용하지 않음"일 수 있어 그대로 견준다.
    if (inServers && names.length === 3 && names[2] === 'args' && Array.isArray(meaning) && meaning.length === 0) continue;
    // 읽지 못한 값은 원문으로 견준다. 원문과 뜻이 섞이지 않게 표시를 붙인다.
    picked.set(entryName(entry), meaning === undefined ? { raw: entry.value } : meaning);
  }
  return { picked, unexpected };
}

/** `codex mcp list --json` 에서 비교할 (이름 → 값). */
function pickCodexList(list) {
  const picked = new Map();
  if (!Array.isArray(list)) return picked;
  for (const server of list) {
    if (server !== null && typeof server === 'object' && server.name !== OWN_SERVER) picked.set(`codex mcp list: ${String(server.name)}`, server);
  }
  return picked;
}

// ── 사본 뜨기 ───────────────────────────────────────────────────────────────

function managedFiles(platform) {
  const dir =
    platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
  return [path.join(dir, 'managed-settings.json'), path.join(dir, 'managed-mcp.json')];
}

/** 비교 대상 파일의 목록. label 은 결과에 출력하는 이름이다. */
export function targetFiles({ home, cwd, app, platform = process.platform, managed }) {
  const targets = [
    { label: '~/.claude.json', file: path.join(home, '.claude.json'), kind: 'claude-json' },
    { label: '~/.claude/settings.json', file: path.join(home, '.claude', 'settings.json'), kind: 'settings' },
    { label: '~/.claude/settings.local.json', file: path.join(home, '.claude', 'settings.local.json'), kind: 'settings' },
  ];
  const folders = [['<작업 폴더>', cwd], ['<설치된 저장소>', app]].filter(([, dir], index, all) => dir && all.findIndex(([, other]) => other === dir) === index);
  for (const [name, dir] of folders) {
    targets.push({ label: `${name}/.claude/settings.json`, file: path.join(dir, '.claude', 'settings.json'), kind: 'settings' });
    targets.push({ label: `${name}/.claude/settings.local.json`, file: path.join(dir, '.claude', 'settings.local.json'), kind: 'settings' });
    targets.push({ label: `${name}/.mcp.json`, file: path.join(dir, '.mcp.json'), kind: 'bytes' });
  }
  for (const file of managed ?? managedFiles(platform)) targets.push({ label: `관리형 설정 ${path.basename(file)}`, file, kind: 'bytes' });
  targets.push({ label: '~/.codex/config.toml', file: path.join(home, '.codex', 'config.toml'), kind: 'codex-toml' });
  return targets;
}

/**
 * 설정 파일의 사본을 뜬다. 폴더는 0700, 파일은 0600 이다.
 * @returns {{ dir: string, files: number }}
 */
export function takeSnapshot({ outDir, home = os.homedir(), cwd = process.cwd(), app, codexBin = 'codex', platform, managed, env = process.env }) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const put = (name, content) => {
    writeFileSync(path.join(outDir, name), content, { mode: 0o600 });
    chmodSync(path.join(outDir, name), 0o600);
  };
  const entries = targetFiles({ home, cwd, app, platform, managed }).map((target, index) => {
    const copy = `file-${String(index).padStart(2, '0')}`;
    let present = false;
    try {
      put(copy, readFileSync(target.file));
      present = true;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw new SnapshotError(`${target.label} 을(를) 읽지 못했다(${error?.code ?? 'error'})`);
    }
    return { label: target.label, kind: target.kind, present, copy: present ? copy : null };
  });
  // Codex 의 다른 서버 항목은 CLI 의 출력으로도 비교한다. 설정 파일 밖(플러그인)에서 오는 서버가 여기에 든다.
  const listed = spawnSync(codexBin, ['mcp', 'list', '--json'], { env: { ...env, HOME: home }, encoding: 'utf8', timeout: 60_000 });
  let codexList = false;
  if (!listed.error && listed.status === 0) {
    try {
      JSON.parse(listed.stdout);
      put(CODEX_LIST, listed.stdout);
      codexList = true;
    } catch {
      // JSON 이 아니면 읽지 못한 것으로 둔다.
    }
  }
  put(MANIFEST, JSON.stringify({ v: 1, entries, codexList }, null, 2));
  return { dir: outDir, files: entries.filter((entry) => entry.present).length };
}

export function removeSnapshot(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── 비교 ────────────────────────────────────────────────────────────────────

function loadSnapshot(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    throw new SnapshotError(`사본을 읽지 못했다: ${dir}`);
  }
  const read = (entry) => (entry.present ? readFileSync(path.join(dir, entry.copy)) : null);
  return { manifest, read, codexList: manifest.codexList ? readFileSync(path.join(dir, CODEX_LIST), 'utf8') : null };
}

function parseJsonOrNull(buffer) {
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 두 (이름 → 값) 묶음에서 뜻이 다른 이름. */
function diffPicked(before, after) {
  const names = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (!sameJson(before.get(name), after.get(name))) names.push(name);
  }
  return names;
}

/**
 * 두 사본을 비교한다. 값은 돌려주지 않는다.
 * @returns {{ same: boolean, compared: number, differences: { file: string, key: string }[] }}
 */
export function compareSnapshots(beforeDir, afterDir) {
  const before = loadSnapshot(beforeDir);
  const after = loadSnapshot(afterDir);
  const differences = [];
  let compared = 0;
  const report = (file, key) => differences.push({ file, key });

  for (const entry of before.manifest.entries) {
    const other = after.manifest.entries.find((candidate) => candidate.label === entry.label);
    if (other === undefined) {
      report(entry.label, '(뒤 사본에 이 파일의 기록이 없다)');
      continue;
    }
    compared += 1;
    const left = before.read(entry);
    const right = after.read(other);
    if (left === null && right === null) continue;
    if (entry.kind === 'bytes' || entry.kind === 'settings') {
      // 없던 파일은 설치 뒤에도 없어야 한다.
      if (left === null) report(entry.label, '(없던 파일이 생겼다)');
      else if (right === null) report(entry.label, '(있던 파일이 없어졌다)');
      if (left === null || right === null) continue;
    }
    if (entry.kind === 'bytes') {
      if (digest(left) !== digest(right)) report(entry.label, '(파일 내용)');
      continue;
    }
    if (entry.kind === 'codex-toml') {
      const a = pickCodexToml(left === null ? '' : left.toString('utf8'));
      const b = pickCodexToml(right === null ? '' : right.toString('utf8'));
      for (const name of diffPicked(a.picked, b.picked)) report(entry.label, name);
      for (const name of b.unexpected) report(entry.label, `${name} (agent-chat 표에 있으면 안 되는 키)`);
      continue;
    }
    const a = left === null ? { ok: true, value: null } : parseJsonOrNull(left);
    const b = right === null ? { ok: true, value: null } : parseJsonOrNull(right);
    if (!a.ok || !b.ok) {
      // JSON 으로 읽지 못하면 뜻을 견줄 수 없다. 바이트가 같을 때만 같다고 한다.
      if (left === null || right === null || digest(left) !== digest(right)) report(entry.label, '(JSON 으로 읽지 못했다)');
      continue;
    }
    if (entry.kind === 'settings') {
      for (const name of diffPicked(pickSettings(a.value), pickSettings(b.value))) report(entry.label, name);
      continue;
    }
    // claude-json
    for (const name of diffPicked(pickClaudeJson(a.value), pickClaudeJson(b.value))) report(entry.label, name);
  }

  compared += 1;
  if ((before.codexList === null) !== (after.codexList === null)) report('codex mcp list --json', '(한쪽 사본에서만 읽었다)');
  else if (before.codexList !== null) {
    for (const name of diffPicked(pickCodexList(JSON.parse(before.codexList)), pickCodexList(JSON.parse(after.codexList)))) report('codex mcp list --json', name);
  }
  return { same: differences.length === 0, compared, differences };
}

// ── 명령줄 ──────────────────────────────────────────────────────────────────

const USAGE = [
  '사용법:',
  '  settings-snapshot.mjs take <사본 폴더> [--home <홈>] [--cwd <작업 폴더>] [--app <설치된 저장소>] [--codex-bin <codex>]',
  '  settings-snapshot.mjs compare <앞 사본 폴더> <뒤 사본 폴더>',
  '  settings-snapshot.mjs clean <사본 폴더>…',
].join('\n');

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'take' && rest.length >= 1) {
    const options = { outDir: path.resolve(rest[0]) };
    const names = { '--home': 'home', '--cwd': 'cwd', '--app': 'app', '--codex-bin': 'codexBin' };
    for (let index = 1; index < rest.length; index += 2) {
      const name = names[rest[index]];
      if (name === undefined || rest[index + 1] === undefined) return usage();
      options[name] = name === 'codexBin' ? rest[index + 1] : path.resolve(rest[index + 1]);
    }
    const taken = takeSnapshot(options);
    console.log(`사본을 떴다: 파일 ${taken.files}개 → ${taken.dir} (비교가 끝나면 clean 으로 지운다)`);
    return 0;
  }
  if (command === 'compare' && rest.length === 2) {
    const result = compareSnapshots(path.resolve(rest[0]), path.resolve(rest[1]));
    if (result.same) {
      console.log(`같다: 비교한 대상 ${result.compared}개에서 목록의 키가 모두 뜻이 같다.`);
      return 0;
    }
    console.log(`다르다: ${result.differences.length}개 (값은 출력하지 않는다)`);
    for (const difference of result.differences) console.log(`  ${difference.file}: ${difference.key}`);
    return 1;
  }
  if (command === 'clean' && rest.length >= 1) {
    for (const dir of rest) removeSnapshot(path.resolve(dir));
    console.log(`사본을 지웠다: ${rest.length}개`);
    return 0;
  }
  return usage();
}

function usage() {
  console.error(USAGE);
  return 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // 이 도구가 만든 오류만 글을 보여 준다. 그 밖의 오류 글에는 설정 값이 섞일 수 있어 이름만 낸다.
    console.error(`실패: ${error instanceof SnapshotError ? error.message : `예상하지 못한 오류(${error instanceof Error ? error.name : 'error'})`}`);
    process.exitCode = 2;
  }
}
