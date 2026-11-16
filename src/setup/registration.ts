// MCP 등록의 기대값을 만들고, 호스트 CLI 의 `mcp get` 출력을 읽어 견준다 (architecture.md 3.13 설치 단계 6~8).
// 호스트 CLI 를 실행하지 않는다. 실행은 host-cli.ts 가 하고 여기서는 인자와 출력만 다룬다.

import { join } from 'node:path';
import { isPeerName, randomLowerAlnum, type RandomBytes } from '../protocol/index.js';
import { readGeminiRegistration, type GeminiSettingsPaths } from './gemini-config.js';
import type { HostCli, HostCliResult } from './host-cli.js';
import { MCP_ENTRY_SEGMENTS, SERVER_NAME, type HostKind } from './types.js';

/** `presence.client` 에 쓰이는 값. */
export const CLIENT_ID: Readonly<Record<HostKind, string>> = { claude: 'claude-code', codex: 'codex', gemini: 'gemini-cli' };

/** 등록하는 이름의 앞부분. 뒤에 무작위 4자가 붙는다. */
const NAME_PREFIX: Readonly<Record<HostKind, string>> = { claude: 'claude', codex: 'codex', gemini: 'gemini' };
const NAME_SUFFIX_LENGTH = 4;

/** `wait_for_messages` 한 번의 최대 대기(architecture.md 5절). */
export const WAIT_MAX_SEC = { claude: 30, codexWithTimeout: 540, gemini: 30, fallback: 50 } as const;
/** Codex 설정에 넣는 tool 호출 한도. 대기 상한 540초보다 길어야 한다. */
export const CODEX_TOOL_TIMEOUT_SEC = 600;

const ENV_NAME = 'AGENT_CHAT_NAME';
const ENV_CLIENT = 'AGENT_CHAT_CLIENT';
const ENV_WAIT = 'AGENT_CHAT_WAIT_MAX_SEC';
const ENV_CHANNEL = 'AGENT_CHAT_CHANNEL';
const ENV_HOME = 'AGENT_CHAT_HOME';

/**
 * 설치가 값을 정하는 변수. 그 밖의 변수는 사용자가 더한 것으로 보고 그대로 둔다.
 * AGENT_CHAT_HOME 은 기본값이 아닌 설치 뿌리로 설치할 때만 넣는다. 기본값으로 다시 설치하면 등록에서 뺀다.
 */
const MANAGED_ENV: Readonly<Record<HostKind, readonly string[]>> = {
  claude: [ENV_CLIENT, ENV_NAME, ENV_WAIT, ENV_HOME],
  codex: [ENV_CLIENT, ENV_NAME, ENV_WAIT, ENV_CHANNEL, ENV_HOME],
  gemini: [ENV_CLIENT, ENV_NAME, ENV_WAIT, ENV_CHANNEL, ENV_HOME],
};

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface Registration {
  readonly command: string;
  /** Codex 는 인자 배열을 준다. Claude Code 는 공백으로 이은 글만 주므로 null 이다. */
  readonly args: readonly string[] | null;
  /** 인자를 공백으로 이은 글. 두 호스트 모두 있다. */
  readonly argsText: string;
  readonly env: Readonly<Record<string, string>>;
  /** Claude Code 의 등록 범위. Codex 는 범위가 없어 user 로 둔다. */
  readonly scope: 'user' | 'local' | 'project' | 'other';
  /** Codex 설정의 `tool_timeout_sec`. 없거나 Claude Code 면 null. */
  readonly toolTimeoutSec: number | null;
  /**
   * 설치가 정하지 않는 설정 가운데 기본값이 아닌 것의 이름(Codex `mcp get --json` 이 내는 것).
   * 예: `disabled_tools`, `enabled_tools`, `startup_timeout_sec`, `enabled`(false), `env_vars`, `cwd`.
   * 다시 등록(`mcp remove` → `mcp add`)하면 Codex 가 이것을 지운다(검토 1차 BOUNDARY-R1-01). Claude Code 는 늘 빈 배열이다.
   */
  readonly extraSettings: readonly string[];
}

export type Lookup =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly registration: Registration }
  /** 출력을 읽지 못했다. 등록이 있는지 알 수 없다. */
  | { readonly state: 'unreadable'; readonly detail: string };

export function mcpEntryPath(appRoot: string): string {
  return join(appRoot, ...MCP_ENTRY_SEGMENTS);
}

/** `mcp get` 의 인자. Gemini CLI 에는 없다(설정 파일로 읽는다. lookupRegistration). */
export function getArgs(host: Exclude<HostKind, 'gemini'>): readonly string[] {
  return host === 'claude' ? ['mcp', 'get', SERVER_NAME] : ['mcp', 'get', SERVER_NAME, '--json'];
}

export function removeArgs(host: HostKind): readonly string[] {
  return host === 'codex' ? ['mcp', 'remove', SERVER_NAME] : ['mcp', 'remove', '--scope', 'user', SERVER_NAME];
}

export function addArgs(host: HostKind, launch: LaunchCommand): readonly string[] {
  if (host === 'gemini') {
    // Gemini CLI 는 `--` 를 받지 않는다. 이름, 명령, 인자를 위치 인자로 준다.
    const env = Object.entries(launch.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return ['mcp', 'add', '--scope', 'user', ...env, SERVER_NAME, launch.command, ...launch.args];
  }
  const flag = host === 'claude' ? '-e' : '--env';
  const head = host === 'claude' ? ['mcp', 'add', '--scope', 'user', SERVER_NAME] : ['mcp', 'add', SERVER_NAME];
  const env = Object.entries(launch.env).flatMap(([key, value]) => [flag, `${key}=${value}`]);
  return [...head, ...env, '--', launch.command, ...launch.args];
}

/**
 * 등록할 이름. 기존 등록에 쓸 수 있는 이름이 있으면 그대로 쓴다.
 * 다시 설치해도 같은 이름으로 방에 들어가게 하려는 것이다.
 */
export function pickName(host: HostKind, existing: Registration | null, random?: RandomBytes): string {
  const kept = existing?.env[ENV_NAME];
  if (kept !== undefined && isPeerName(kept)) return kept;
  return `${NAME_PREFIX[host]}-${randomLowerAlnum(NAME_SUFFIX_LENGTH, random)}`;
}

export interface ExpectedOptions {
  readonly nodePath: string;
  readonly appRoot: string;
  readonly name: string;
  readonly waitMaxSec: number;
  /**
   * 기본값이 아닌 설치 뿌리(AGENT_CHAT_HOME). null 이거나 생략하면 넣지 않는다(기본값 ~/.agent-chat).
   * 넣지 않으면 MCP 프로세스가 기본 위치에 기록·로그·channel-check.json 을 쓰고, 설치 점검은 다른 곳을 읽는다.
   */
  readonly agentHome?: string | null;
  /** 기존 등록에서 사용자가 더한 변수. 다시 등록할 때 잃지 않게 옮긴다. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export function expectedLaunch(host: HostKind, options: ExpectedOptions): LaunchCommand {
  const env: Record<string, string> = {
    [ENV_CLIENT]: CLIENT_ID[host],
    [ENV_NAME]: options.name,
    [ENV_WAIT]: String(options.waitMaxSec),
  };
  // Codex 와 Gemini CLI 에는 채널 알림이 없다. 점검 알림을 보내지 않고 confirm_channel 도 등록하지 않는다.
  if (host !== 'claude') env[ENV_CHANNEL] = 'off';
  if (options.agentHome !== undefined && options.agentHome !== null) env[ENV_HOME] = options.agentHome;
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (!(key in env)) env[key] = value;
  }
  return { command: options.nodePath, args: [mcpEntryPath(options.appRoot)], env };
}

/** 설치가 값을 정하는 변수인가. 안내에 값을 실어도 되는 것은 이 변수뿐이다(사용자 변수에는 토큰 같은 비밀값이 들 수 있다). */
export function isManagedEnv(host: HostKind, name: string): boolean {
  return MANAGED_ENV[host].includes(name);
}

/** 기존 등록에서 설치가 정하지 않는 변수만 고른다. */
export function extraEnvOf(host: HostKind, registration: Registration | null): Readonly<Record<string, string>> {
  if (registration === null) return {};
  return Object.fromEntries(Object.entries(registration.env).filter(([key]) => !MANAGED_ENV[host].includes(key)));
}

/** 등록이 기대한 명령·인자·환경과 같은가. Codex 는 tool 호출 한도도 본다. */
export function matchesLaunch(registration: Registration, launch: LaunchCommand, toolTimeoutSec: number | null): boolean {
  if (registration.scope !== 'user') return false;
  if (registration.command !== launch.command) return false;
  if (registration.argsText !== launch.args.join(' ')) return false;
  if (registration.args !== null && registration.args.length !== launch.args.length) return false;
  const keys = Object.keys(launch.env);
  if (Object.keys(registration.env).length !== keys.length) return false;
  if (!keys.every((key) => registration.env[key] === launch.env[key])) return false;
  return toolTimeoutSec === null || registration.toolTimeoutSec === toolTimeoutSec;
}

/** 등록이 이 설치의 MCP 진입점을 가리키는가(단계 8, doctor D2). */
export function pointsAtInstall(registration: Registration, appRoot: string): boolean {
  const entry = mcpEntryPath(appRoot);
  return registration.args === null ? registration.argsText === entry : registration.args.length === 1 && registration.args[0] === entry;
}

/**
 * 등록을 그대로 띄울 실행 정보. 이 설치를 가리키는 등록에만 쓴다.
 * Claude Code 는 인자를 공백으로 이어 보여 주므로, 글이 이 설치의 진입점과 같을 때 그 경로 하나로 본다.
 */
export function launchOf(registration: Registration, appRoot: string): LaunchCommand | null {
  if (!pointsAtInstall(registration, appRoot)) return null;
  return { command: registration.command, args: registration.args ?? [mcpEntryPath(appRoot)], env: registration.env };
}

// ── `mcp get` 출력 읽기 ──────────────────────────────────────────────────────

const ABSENT = /No MCP server named/i;

function scopeOf(text: string): Registration['scope'] {
  if (/^User config\b/i.test(text)) return 'user';
  if (/^Local config\b/i.test(text)) return 'local';
  if (/^Project config\b/i.test(text)) return 'project';
  return 'other';
}

/**
 * `claude mcp get agent-chat` 의 글 출력을 읽는다. JSON 출력 옵션이 없다.
 * 줄 형식은 `  Scope: …`, `  Type: stdio`, `  Command: …`, `  Args: …`, `  Environment:` 와 그 아래의 `KEY=value` 줄이다.
 */
export function parseClaudeGet(result: HostCliResult): Lookup {
  if (result.outcome !== 'exit') return { state: 'unreadable', detail: result.detail };
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    return ABSENT.test(text) ? { state: 'absent' } : { state: 'unreadable', detail: `exit code ${result.code}` };
  }
  const lines = result.stdout.split(/\r?\n/);
  const field = (name: string): string | null => {
    const prefix = `${name}:`;
    const line = lines.find((candidate) => candidate.trimStart().startsWith(prefix));
    return line === undefined ? null : line.trimStart().slice(prefix.length).trim();
  };
  const command = field('Command');
  const scope = field('Scope');
  if (scope === null) return { state: 'unreadable', detail: 'no Scope line' };
  if (command === null) {
    // stdio 가 아닌 등록(URL)이다. 이 설치의 등록이 아니므로 다시 등록할 대상이다.
    return { state: 'present', registration: { command: '', args: null, argsText: '', env: {}, scope: scopeOf(scope), toolTimeoutSec: null, extraSettings: [] } };
  }
  const env: Record<string, string> = {};
  const start = lines.findIndex((line) => line.trim() === 'Environment:');
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const match = /^\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (match === null) break;
      env[match[1] as string] = match[2] as string;
    }
  }
  return {
    state: 'present',
    registration: { command, args: null, argsText: field('Args') ?? '', env, scope: scopeOf(scope), toolTimeoutSec: null, extraSettings: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `get --json` 의 최상위 칸 가운데 설치가 정하거나 상태를 알리는 것. 나머지 칸은 값이 있으면 사용자 설정으로 본다. */
const CODEX_KNOWN_FIELDS: ReadonlySet<string> = new Set(['name', 'enabled', 'disabled_reason', 'transport', 'tool_timeout_sec']);
/** transport 안의 칸 가운데 설치가 정하는 것. */
const CODEX_TRANSPORT_FIELDS: ReadonlySet<string> = new Set(['type', 'command', 'args', 'env']);

/** 값이 "설정하지 않음"과 같은가(null, 빈 배열, 빈 객체). */
function isUnset(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/** 설치가 정하지 않는 설정 가운데 기본값이 아닌 것의 이름. */
function codexExtraSettings(parsed: Record<string, unknown>, transport: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (parsed['enabled'] === false) names.push('enabled');
  for (const [key, value] of Object.entries(parsed)) {
    if (!CODEX_KNOWN_FIELDS.has(key) && !isUnset(value)) names.push(key);
  }
  for (const [key, value] of Object.entries(transport)) {
    if (!CODEX_TRANSPORT_FIELDS.has(key) && !isUnset(value)) names.push(key);
  }
  return names;
}

/** `codex mcp get agent-chat --json` 의 출력을 읽는다. */
export function parseCodexGet(result: HostCliResult): Lookup {
  if (result.outcome !== 'exit') return { state: 'unreadable', detail: result.detail };
  if (result.code !== 0) {
    return ABSENT.test(`${result.stdout}\n${result.stderr}`) ? { state: 'absent' } : { state: 'unreadable', detail: `exit code ${result.code}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { state: 'unreadable', detail: 'output is not JSON' };
  }
  if (!isRecord(parsed) || !isRecord(parsed['transport'])) return { state: 'unreadable', detail: 'no transport in output' };
  const transport = parsed['transport'];
  const command = typeof transport['command'] === 'string' ? transport['command'] : '';
  const args = Array.isArray(transport['args']) ? transport['args'].filter((arg): arg is string => typeof arg === 'string') : [];
  const env: Record<string, string> = {};
  if (isRecord(transport['env'])) {
    for (const [key, value] of Object.entries(transport['env'])) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  const timeout = parsed['tool_timeout_sec'];
  return {
    state: 'present',
    registration: {
      command,
      args,
      argsText: args.join(' '),
      env,
      scope: 'user',
      // 실제 CLI 는 실수로 낸다(600.0).
      toolTimeoutSec: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null,
      extraSettings: codexExtraSettings(parsed, transport),
    },
  };
}

export function parseGet(host: Exclude<HostKind, 'gemini'>, result: HostCliResult): Lookup {
  return host === 'claude' ? parseClaudeGet(result) : parseCodexGet(result);
}

/** 호스트의 등록을 읽는다. Claude Code·Codex 는 `mcp get`, Gemini CLI 는 설정 파일이다. */
export async function lookupRegistration(cli: HostCli, gemini: GeminiSettingsPaths): Promise<Lookup> {
  if (cli.host === 'gemini') return readGeminiRegistration(gemini);
  return parseGet(cli.host, await cli.run(getArgs(cli.host)));
}

// ── 사람이 손으로 실행할 명령 ────────────────────────────────────────────────

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_\-./=:@]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** 안내에 싣는 등록 명령 한 줄. */
export function manualAddCommand(host: HostKind, launch: LaunchCommand): string {
  return [host, ...addArgs(host, launch)].map(shellQuote).join(' ');
}
