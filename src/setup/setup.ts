// 설치 단계 5~11 과 제거 (architecture.md 3.13). 1~4(Node, 위치, 의존성, 네이티브)는 scripts/install.mjs 가 한다.
// 하는 일은 MCP 등록과 그 확인, Channels 보고, 연결 점검, 안내다. 권한 설정은 읽지도 쓰지도 않는다.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { LogPort } from '../diagnostics/log-port.js';
import type { Now, RandomBytes, Timers } from '../protocol/index.js';
import {
  CHANNELS_LABEL,
  judgeChannels,
  managedSettingsPath,
  parseAuthStatus,
  parseVersion,
  readChannelCheck,
  readManagedSettings,
  type ChannelsResult,
} from './channels.js';
import { applyToolTimeout, backupCodexConfig, projectConfigPaths, userKeysInTable } from './codex-config.js';
import { runDoctor, type DoctorLimits } from './doctor.js';
import { backupGeminiSettings } from './gemini-config.js';
import { buildGuide } from './guide.js';
import { createHostCli, type HostCli, type HostCliResult } from './host-cli.js';
import type { EnvMap, InstallerEnv } from './installer-env.js';
import type { LaunchMcp } from './mcp-process.js';
import {
  CODEX_TOOL_TIMEOUT_SEC,
  WAIT_MAX_SEC,
  addArgs,
  expectedLaunch,
  extraEnvOf,
  isManagedEnv,
  lookupRegistration,
  manualAddCommand,
  matchesLaunch,
  pickName,
  pointsAtInstall,
  removeArgs,
  type LaunchCommand,
  type Lookup,
  type Registration,
} from './registration.js';
import { HOST_LABEL, SERVER_NAME, createReporter, type HostKind, type Reporter } from './types.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
/** 실패는 없지만 등록한 호스트가 없다. */
export const EXIT_NO_HOST = 2;

export interface SetupDeps {
  readonly env: InstallerEnv;
  /** 설치를 실행한 환경. 호스트 CLI 에 그대로 넘긴다. */
  readonly rawEnv: EnvMap;
  /** 이 CLI 가 든 패키지 뿌리. 등록하는 MCP 진입점이 이 아래에 있다. */
  readonly appRoot: string;
  /** 등록의 명령이 될 Node. 셸 진입점이 찾은 경로가 설치를 실행한 Node 와 같은 파일이고 일회용 링크가 아니면 그 경로, 아니면 `process.execPath` 다(chooseNodePath). */
  readonly nodePath: string;
  /** 셸이 찾은 경로를 그대로 쓰지 않았거나 링크를 그대로 썼을 때의 설명. 단계 8 에 싣는다. 없으면 null 이나 생략. */
  readonly nodeNote?: string | null;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
  readonly out: (line: string) => void;
  readonly launch: LaunchMcp;
  readonly makeHostCli?: (host: HostKind, bin: string) => HostCli;
  readonly randomBytes?: RandomBytes;
  /** 관리형 설정 파일의 위치. 생략하면 OS 의 기본 위치다. */
  readonly managedSettingsPath?: string;
  readonly doctorLimits?: Partial<DoctorLimits>;
}

interface FoundHost {
  readonly host: HostKind;
  readonly cli: HostCli;
  /** `--version` 의 첫 줄. */
  readonly versionText: string;
}

const ENV_NAME: Readonly<Record<HostKind, string>> = {
  claude: 'AGENT_CHAT_CLAUDE_BIN',
  codex: 'AGENT_CHAT_CODEX_BIN',
  gemini: 'AGENT_CHAT_GEMINI_BIN',
};

function succeeded(result: HostCliResult): boolean {
  return result.outcome === 'exit' && result.code === 0;
}

function failureOf(result: HostCliResult): string {
  if (result.outcome !== 'exit') return result.detail;
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).filter((line) => line.trim() !== '');
  return `exit code ${result.code}${lines[0] === undefined ? '' : `: ${lines[0].trim().slice(0, 200)}`}`;
}

/** MCP 등록에 넣을 AGENT_CHAT_HOME. 기본값이면 넣지 않는다(null). */
function registeredHome(deps: SetupDeps): string | null {
  return deps.env.homeIsDefault ? null : deps.env.home;
}

function makeCli(deps: SetupDeps, host: HostKind): HostCli {
  const bin = deps.env.bins[host].value;
  return deps.makeHostCli?.(host, bin) ?? createHostCli({ host, bin, env: deps.rawEnv, timers: deps.timers });
}

/** 단계 5. 고른 호스트의 CLI 를 찾는다. 없는 호스트는 건너뛴다. */
async function findHosts(deps: SetupDeps, clients: readonly HostKind[], reporter: Reporter, stepId: string): Promise<FoundHost[]> {
  const found: FoundHost[] = [];
  for (const host of clients) {
    const cli = makeCli(deps, host);
    const result = await cli.run(['--version']);
    const explicit = deps.env.bins[host].explicit;
    if (succeeded(result)) {
      const versionText = (result.stdout.split(/\r?\n/)[0] ?? '').trim();
      found.push({ host, cli, versionText });
      reporter.step(stepId, '호스트 찾기', 'pass', { host, detail: versionText });
    } else if (result.outcome === 'not-found' && !explicit) {
      reporter.step(stepId, '호스트 찾기', 'skip', { host, detail: `${cli.bin} 실행 파일이 없다` });
    } else {
      const detail = explicit
        ? `${ENV_NAME[host]} 로 준 파일을 실행할 수 없다(${failureOf(result)})`
        : `${cli.bin} --version 이 실패했다(${failureOf(result)})`;
      reporter.step(stepId, '호스트 찾기', 'fail', { host, detail, errorCode: 'HOST_CLI_FAILED' });
    }
  }
  return found;
}

async function lookup(deps: SetupDeps, found: FoundHost): Promise<Lookup> {
  return lookupRegistration(found.cli, deps.env.geminiSettings);
}

interface Planned {
  readonly existing: Registration | null;
  readonly name: string;
  readonly extraEnv: Readonly<Record<string, string>>;
}

type RegisterResult = 'registered' | 'not-registered';

/** 기존 등록을 지우고 새로 등록한다. 문제가 있으면 그 설명을 돌려준다. */
async function replaceRegistration(found: FoundHost, hadExisting: boolean, launch: LaunchCommand): Promise<string | null> {
  if (hadExisting) {
    const removed = await found.cli.run(removeArgs(found.host));
    if (!succeeded(removed)) return `기존 등록을 지우지 못했다(${failureOf(removed)})`;
  }
  const added = await found.cli.run(addArgs(found.host, launch));
  return succeeded(added) ? null : `등록하지 못했다(${failureOf(added)})`;
}

/**
 * 작업 폴더에서 Codex 가 읽는 프로젝트 설정(`.codex/config.toml`) 가운데 이 서버의 정의가 있거나 이름이 보이는 파일. 없으면 null.
 * 신뢰한 프로젝트에서 Codex 는 그 등록을 사용자 설정의 것보다 먼저 쓰고(`mcp get` 도 그것을 낸다), `mcp remove`·`mcp add` 는 사용자 설정만 고친다.
 * 그대로 다시 등록하면 사용자 등록만 바뀌고 확인은 계속 어긋난다(검토 3차 BOUNDARY-R3-02, 실제 Codex 0.169.0 확인).
 * 사용자 설정 파일 자체(작업 폴더가 홈이면 `~/.codex/config.toml` 이 후보에 든다)는 뺀다.
 */
function codexProjectDefinition(deps: SetupDeps): string | null {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const userConfig = real(deps.env.codexConfigPath);
  for (const path of projectConfigPaths(deps.env.cwd, existsSync)) {
    if (!existsSync(path) || real(path) === userConfig) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // 설치가 읽지 못하는 파일은 Codex 도 읽지 못한다고 본다.
      continue;
    }
    const scanned = userKeysInTable(text);
    if ((scanned.ok && scanned.defined) || text.includes(SERVER_NAME)) return path;
  }
  return null;
}

async function plan(deps: SetupDeps, found: FoundHost, reporter: Reporter, stepId: string, title: string): Promise<Planned | null> {
  const current = await lookup(deps, found);
  if (current.state === 'unreadable') {
    reporter.step(stepId, title, 'fail', { host: found.host, detail: `기존 등록을 읽지 못했다(${current.detail})`, errorCode: 'REGISTRATION_UNREADABLE' });
    return null;
  }
  const existing = current.state === 'present' ? current.registration : null;
  if (existing !== null && existing.scope !== 'user') {
    reporter.step(stepId, title, 'action', {
      host: found.host,
      detail: `user 가 아닌 scope(${existing.scope})에 같은 이름(${SERVER_NAME})의 등록이 있다. 그 등록을 직접 지운 뒤 다시 실행한다`,
    });
    return null;
  }
  // Codex 의 `mcp get` 은 범위를 내지 않는다. 등록이 보이면 그것이 프로젝트 설정의 것일 수 있는지 파일로 본다.
  const project = found.host === 'codex' && existing !== null ? codexProjectDefinition(deps) : null;
  if (project !== null) {
    reporter.step(stepId, title, 'action', {
      host: found.host,
      detail:
        `이 작업 폴더에서 Codex 가 읽는 프로젝트 설정(${project})에 같은 이름(${SERVER_NAME})의 등록이 있다. ` +
        '신뢰한 프로젝트에서는 Codex 가 그 등록을 사용자 설정의 것보다 먼저 쓰고, 설치는 사용자 설정만 고친다. ' +
        '그 등록을 직접 지우거나, 이 프로젝트 밖의 폴더에서 다시 실행한다',
    });
    return null;
  }
  return { existing, name: pickName(found.host, existing, deps.randomBytes), extraEnv: extraEnvOf(found.host, existing) };
}

/** 단계 6. */
async function registerClaude(deps: SetupDeps, found: FoundHost, reporter: Reporter): Promise<RegisterResult> {
  const title = 'MCP 등록';
  const planned = await plan(deps, found, reporter, '6', title);
  if (planned === null) return 'not-registered';
  const launch = expectedLaunch('claude', {
    nodePath: deps.nodePath,
    appRoot: deps.appRoot,
    name: planned.name,
    waitMaxSec: WAIT_MAX_SEC.claude,
    agentHome: registeredHome(deps),
    extraEnv: planned.extraEnv,
  });
  if (planned.existing !== null && matchesLaunch(planned.existing, launch, null)) {
    reporter.step('6', title, 'skip', { host: 'claude', detail: '이미 등록됨' });
    return 'registered';
  }
  const problem = await replaceRegistration(found, planned.existing !== null, launch);
  if (problem !== null) {
    reporter.step('6', title, 'fail', { host: 'claude', detail: problem, errorCode: 'REGISTER_FAILED' });
    return 'not-registered';
  }
  reporter.step('6', title, 'pass', { host: 'claude', detail: planned.existing === null ? '새로 등록' : '명령이나 환경이 달라 다시 등록' });
  return 'registered';
}

/**
 * 단계 7(Gemini CLI). `gemini mcp add --scope user` 로 사용자 설정(~/.gemini/settings.json)에 등록한다.
 * Gemini CLI 의 `mcp add` 는 같은 이름의 항목을 통째로 바꾼다. 사용자가 더한 칸(trust, timeout, includeTools 등)이 있으면
 * 지워지므로 다시 등록하지 않고 사용자에게 맡긴다. 파일을 고치기 전에 백업한다.
 * 채널이 없으므로 AGENT_CHAT_CHANNEL=off 를 넣는다. tool 호출 기본 한도(10분)가 대기 상한(100초)보다 길어 따로 넣지 않는다.
 */
async function registerGemini(deps: SetupDeps, found: FoundHost, reporter: Reporter): Promise<RegisterResult> {
  const title = 'MCP 등록';
  const planned = await plan(deps, found, reporter, '7', title);
  if (planned === null) return 'not-registered';
  const launch = expectedLaunch('gemini', {
    nodePath: deps.nodePath,
    appRoot: deps.appRoot,
    name: planned.name,
    waitMaxSec: WAIT_MAX_SEC.gemini,
    agentHome: registeredHome(deps),
    extraEnv: planned.extraEnv,
  });
  if (planned.existing !== null && matchesLaunch(planned.existing, launch, null) && planned.existing.extraSettings.length === 0) {
    reporter.step('7', title, 'skip', { host: 'gemini', detail: '이미 등록됨' });
    return 'registered';
  }
  if (planned.existing !== null && planned.existing.extraSettings.length > 0) {
    if (matchesLaunch(planned.existing, launch, null)) {
      reporter.step('7', title, 'skip', { host: 'gemini', detail: `이미 등록됨(사용자 설정 ${planned.existing.extraSettings.join(', ')} 은 그대로 둔다)` });
      return 'registered';
    }
    reporter.step('7', title, 'action', {
      host: 'gemini',
      detail:
        `기존 등록에 설치가 정하지 않는 설정(${planned.existing.extraSettings.join(', ')})이 있다. 다시 등록하면 Gemini CLI 가 그 설정을 지우므로 손대지 않았다. ` +
        `${deps.env.geminiSettings.user} 의 mcpServers["${SERVER_NAME}"] 에서 command 를 ${JSON.stringify(launch.command)}, args 를 ${JSON.stringify(launch.args)} 로 고친 뒤 다시 실행한다`,
    });
    return 'not-registered';
  }
  const backup = backupGeminiSettings(deps.env.geminiSettings.user, join(deps.env.home, 'backups'), deps.now);
  if (!backup.ok) {
    reporter.step('7', title, 'fail', { host: 'gemini', detail: `설정 파일을 백업하지 못해 등록하지 않았다(${backup.reason})`, errorCode: 'GEMINI_BACKUP_FAILED' });
    return 'not-registered';
  }
  // `mcp add` 가 같은 이름의 항목을 바꾼다. 지우고 다시 넣지 않아도 된다.
  const problem = await replaceRegistration(found, false, launch);
  if (problem !== null) {
    reporter.step('7', title, 'fail', { host: 'gemini', detail: problem, errorCode: 'REGISTER_FAILED' });
    return 'not-registered';
  }
  const backupNote = backup.backupPath === null ? '' : `. 바꾸기 전 설정 백업: ${backup.backupPath}`;
  reporter.step('7', title, 'pass', { host: 'gemini', detail: `${planned.existing === null ? '새로 등록' : '명령이나 환경이 달라 다시 등록'}${backupNote}` });
  return 'registered';
}

/** 기존 Codex 등록을 다시 등록해도 되는지. keys 면 사용자 설정이 있다. unknown 이면 이 서버의 정의를 다 읽지 못했다. */
type CodexUserSettings =
  | { readonly kind: 'none' }
  | { readonly kind: 'keys'; readonly names: readonly string[] }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * 기존 Codex 등록에서 설치가 정하지 않는 설정의 이름. `mcp get --json` 이 내는 것과 설정 파일의 그 정의에 적힌 것을 합친다.
 * `get --json` 은 승인 모드 키(default_tools_approval_mode, 도구별 approval_mode)를 내지 않는다(architecture.md 3.13).
 * 정의는 표준 머리줄 밖의 표기(점 키, 인라인 표)로도 읽는다. 파일을 끝까지 읽지 못했거나, 정의를 찾지 못했는데 이름은 보이면
 * 읽지 못한 곳에 사용자 설정이 있을 수 있어 unknown 이다(검토 2차 BOUNDARY-R2-01).
 */
function codexUserSettings(deps: SetupDeps, existing: Registration): CodexUserSettings {
  const names = new Set(existing.extraSettings);
  let text: string | null = null;
  try {
    if (existsSync(deps.env.codexConfigPath)) text = readFileSync(deps.env.codexConfigPath, 'utf8');
  } catch {
    // 읽지 못하면 get 의 결과만 쓴다. 고칠 때(applyToolTimeout)도 같은 파일을 읽지 못해 실패로 남는다.
  }
  if (text !== null) {
    const scanned = userKeysInTable(text);
    if (scanned.ok) {
      for (const key of scanned.keys) names.add(key);
      if (names.size === 0 && !scanned.defined && text.includes(SERVER_NAME)) {
        return { kind: 'unknown', reason: `${SERVER_NAME} 의 정의를 이 파일에서 찾지 못했다(이름은 보인다)` };
      }
    } else if (names.size === 0) {
      return { kind: 'unknown', reason: `이 파일을 끝까지 읽지 못했다(${scanned.reason})` };
    }
  }
  return names.size === 0 ? { kind: 'none' } : { kind: 'keys', names: [...names].sort() };
}

/**
 * 손으로 맞출 값. env 는 설치가 정하는 변수의 값만 싣는다. 사용자가 넣은 변수는 이름만 적는다.
 * 그 값(토큰 등)이 설치 출력에 실리면 설치를 대신 실행한 에이전트의 맥락, CI 로그, 터미널 기록에 남는다(검토 2차 BOUNDARY-R2-03).
 */
function manualFixDetail(deps: SetupDeps, existing: Registration, launch: LaunchCommand): string {
  const managed = Object.entries(launch.env)
    .filter(([key]) => isManagedEnv('codex', key))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const dropped = Object.keys(existing.env).filter((key) => isManagedEnv('codex', key) && !(key in launch.env));
  const kept = Object.keys(launch.env).filter((key) => !isManagedEnv('codex', key));
  return (
    `${deps.env.codexConfigPath} 의 이 등록에서 command 를 ${JSON.stringify(launch.command)}, args 를 ${JSON.stringify(launch.args)} 로, ` +
    `env 의 ${managed} 로 고친다` +
    (dropped.length === 0 ? '' : `(${dropped.join(', ')} 는 뺀다)`) +
    (kept.length === 0 ? '' : `. 그 밖의 env 항목(${kept.join(', ')})은 그대로 둔다`) +
    '. 고친 뒤 다시 실행한다'
  );
}

/** 다시 등록하지 않고 사용자에게 맡길 때의 안내. 지워질 설정과, 손으로 맞출 값을 함께 준다. */
function keepUserSettingsDetail(deps: SetupDeps, settings: CodexUserSettings, existing: Registration, launch: LaunchCommand): string {
  const cause =
    settings.kind === 'keys'
      ? `기존 등록에 설치가 정하지 않는 설정(${settings.names.join(', ')})이 있다. 다시 등록하면 Codex 가 그 설정을 지우므로 손대지 않았다`
      : `기존 등록이 설정 파일에서 읽지 못하는 곳에 있다: ${settings.kind === 'unknown' ? settings.reason : ''}. 다시 등록하면 Codex 가 그 등록에 든 설정(승인 모드 등)을 지울 수 있어 손대지 않았다`;
  return (
    `${cause}. ${manualFixDetail(deps, existing, launch)}. ` +
    `또는 그 설정을 따로 적어 두고 등록을 지운 뒤(codex mcp remove agent-chat) 다시 실행하고 설정을 되살린다`
  );
}

/** 단계 7. 등록한 뒤 설정 파일의 이 서버 항목에 tool_timeout_sec 을 넣는다. 못 넣으면 대기 상한을 낮춰 다시 등록한다. */
async function registerCodex(deps: SetupDeps, found: FoundHost, reporter: Reporter): Promise<RegisterResult> {
  const title = 'MCP 등록';
  const timeoutTitle = `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`;
  const planned = await plan(deps, found, reporter, '7', title);
  if (planned === null) return 'not-registered';
  const base = { nodePath: deps.nodePath, appRoot: deps.appRoot, name: planned.name, agentHome: registeredHome(deps), extraEnv: planned.extraEnv };
  const preferred = expectedLaunch('codex', { ...base, waitMaxSec: WAIT_MAX_SEC.codexWithTimeout });
  if (planned.existing !== null && matchesLaunch(planned.existing, preferred, CODEX_TOOL_TIMEOUT_SEC)) {
    reporter.step('7', title, 'skip', { host: 'codex', detail: '이미 등록됨' });
    return 'registered';
  }
  // 사용자가 이 등록에 건 제한(disabled_tools, 승인 모드 등)은 remove/add 로 지워진다. 설치가 권한을 넓히는 길이 되지 않게 멈춘다.
  if (planned.existing !== null) {
    const userSettings = codexUserSettings(deps, planned.existing);
    if (userSettings.kind !== 'none') {
      reporter.step('7', title, 'action', { host: 'codex', detail: keepUserSettingsDetail(deps, userSettings, planned.existing, preferred) });
      return 'not-registered';
    }
  }
  // Codex CLI 가 파일을 고치기 전에 백업한다. 이 실행의 백업은 이것 하나다.
  const backup = backupCodexConfig({ configPath: deps.env.codexConfigPath, backupDir: join(deps.env.home, 'backups'), now: deps.now });
  if (!backup.ok) {
    reporter.step('7', title, 'fail', { host: 'codex', detail: `설정 파일을 백업하지 못해 등록하지 않았다(${backup.reason})`, errorCode: 'CODEX_BACKUP_FAILED' });
    return 'not-registered';
  }
  const problem = await replaceRegistration(found, planned.existing !== null, preferred);
  if (problem !== null) {
    reporter.step('7', title, 'fail', { host: 'codex', detail: problem, errorCode: 'REGISTER_FAILED' });
    return 'not-registered';
  }
  const backupNote = backup.backupPath === null ? '' : `. 바꾸기 전 설정 백업: ${backup.backupPath}`;
  reporter.step('7', title, 'pass', { host: 'codex', detail: `${planned.existing === null ? '새로 등록' : '명령이나 환경이 달라 다시 등록'}${backupNote}` });

  const applied = applyToolTimeout({
    configPath: deps.env.codexConfigPath,
    backupDir: null,
    seconds: CODEX_TOOL_TIMEOUT_SEC,
    now: deps.now,
  });
  let reason = applied.ok ? null : applied.reason;
  if (applied.ok) {
    // 고친 파일을 Codex 가 그대로 읽는지 본다. 못 읽으면 고치기 전으로 되돌린다.
    const after = await lookup(deps, found);
    if (after.state !== 'present' || !matchesLaunch(after.registration, preferred, CODEX_TOOL_TIMEOUT_SEC)) {
      applied.restore();
      reason = 'Codex did not read the edited config file';
    } else {
      reporter.step('7', timeoutTitle, 'pass', { host: 'codex', detail: applied.changed ? '넣었다' : '이미 들어 있다' });
      return 'registered';
    }
  }
  const fallback = expectedLaunch('codex', { ...base, waitMaxSec: WAIT_MAX_SEC.fallback });
  const retried = await replaceRegistration(found, true, fallback);
  if (retried !== null) {
    reporter.step('7', timeoutTitle, 'fail', { host: 'codex', detail: retried, errorCode: 'REGISTER_FAILED' });
    return 'not-registered';
  }
  reporter.step('7', timeoutTitle, 'skip', {
    host: 'codex',
    detail: `설정 파일을 고치지 못했다(${reason}). 대기 상한을 ${WAIT_MAX_SEC.fallback}초로 등록했다`,
    errorCode: 'CODEX_CONFIG_EDIT_FAILED',
  });
  return 'registered';
}

/** 단계 8. 등록된 명령이 이 설치의 Node 와 MCP 진입점인지 다시 읽어 본다. */
async function verify(deps: SetupDeps, found: FoundHost, reporter: Reporter): Promise<boolean> {
  const current = await lookup(deps, found);
  const registration = current.state === 'present' ? current.registration : null;
  if (registration !== null && registration.command === deps.nodePath && pointsAtInstall(registration, deps.appRoot)) {
    // 등록한 Node 를 보여 준다. 셸이 찾은 경로를 쓰지 않았거나 링크를 그대로 썼으면 그 까닭도 싣는다(검토 2차 BOUNDARY-R2-02).
    const note = deps.nodeNote === undefined || deps.nodeNote === null ? '' : `. ${deps.nodeNote}`;
    reporter.step('8', '등록 확인', 'pass', { host: found.host, detail: `명령 ${deps.nodePath}${note}` });
    return true;
  }
  const detail =
    current.state === 'absent' ? '등록이 없다' : current.state === 'unreadable' ? `등록을 읽지 못했다(${current.detail})` : '등록된 명령이 이 설치와 다르다';
  reporter.step('8', '등록 확인', 'fail', { host: found.host, detail, errorCode: 'REGISTRATION_MISMATCH' });
  return false;
}

/** 단계 9. */
async function reportChannels(deps: SetupDeps, found: FoundHost, reporter: Reporter): Promise<ChannelsResult> {
  const verdict =
    found.host !== 'claude'
      ? judgeChannels({ host: found.host, version: null, providerFlags: [], auth: { kind: 'unreadable' }, managed: { kind: 'absent' }, check: null })
      : judgeChannels({
          host: 'claude',
          version: parseVersion(found.versionText),
          providerFlags: deps.env.providerFlags,
          auth: parseAuthStatus(await found.cli.run(['auth', 'status'])),
          managed: readManagedSettings(deps.managedSettingsPath ?? managedSettingsPath(deps.platform)),
          check: readChannelCheck(deps.env.home),
        });
  const row = verdict.row === null ? '' : `판정표 ${verdict.row}행. `;
  reporter.line(`[9] Channels (${HOST_LABEL[found.host]}): ${CHANNELS_LABEL[verdict.result]} — ${row}${verdict.reason}. ${verdict.guidance}`);
  deps.log.event('info', 'setup', 'setup.step', { step: '9', outcome: verdict.result, host: found.host, reason: verdict.row === null ? 'no_channel' : `row_${verdict.row}` });
  return verdict.result;
}

function printManualCommands(deps: SetupDeps, clients: readonly HostKind[], reporter: Reporter): void {
  reporter.line('호스트 CLI 를 찾지 못했다. 호스트를 설치한 뒤 다시 실행하거나, 아래 명령으로 직접 등록한다.');
  for (const host of clients) {
    const waitMaxSec = host === 'claude' ? WAIT_MAX_SEC.claude : host === 'gemini' ? WAIT_MAX_SEC.gemini : WAIT_MAX_SEC.fallback;
    const launch = expectedLaunch(host, {
      nodePath: deps.nodePath,
      appRoot: deps.appRoot,
      name: pickName(host, null, deps.randomBytes),
      waitMaxSec,
      agentHome: registeredHome(deps),
    });
    reporter.line(`  ${manualAddCommand(host, launch)}`);
  }
  reporter.line('  (CLI 가 PATH 밖에 있으면 AGENT_CHAT_CLAUDE_BIN, AGENT_CHAT_CODEX_BIN, AGENT_CHAT_GEMINI_BIN 으로 실행 파일을 알려 준다.)');
}

function summarize(reporter: Reporter, code: number): number {
  reporter.line(
    `결과: 통과 ${reporter.count('pass')}, 실패 ${reporter.count('fail')}, 건너뜀 ${reporter.count('skip')}, ` +
      `사용자 조치 필요 ${reporter.count('action')}, 경고 ${reporter.count('warn')} (종료 코드 ${code})`,
  );
  return code;
}

/** 설치 단계 5~11. 종료 코드를 돌려준다. */
export async function runSetup(deps: SetupDeps, clients: readonly HostKind[]): Promise<number> {
  const reporter = createReporter(deps.out, deps.log);
  const found = await findHosts(deps, clients, reporter, '5');
  if (found.length === 0) {
    if (reporter.count('fail') > 0) return summarize(reporter, EXIT_FAILED);
    printManualCommands(deps, clients, reporter);
    return summarize(reporter, EXIT_NO_HOST);
  }

  const registered: FoundHost[] = [];
  for (const host of found) {
    const result =
      host.host === 'claude'
        ? await registerClaude(deps, host, reporter)
        : host.host === 'codex'
          ? await registerCodex(deps, host, reporter)
          : await registerGemini(deps, host, reporter);
    if (result === 'registered') registered.push(host);
  }
  const verified: FoundHost[] = [];
  for (const host of registered) {
    if (await verify(deps, host, reporter)) verified.push(host);
  }

  let claudeChannels: ChannelsResult | null = null;
  for (const host of found) {
    const result = await reportChannels(deps, host, reporter);
    if (host.host === 'claude') claudeChannels = result;
  }

  if (verified.length === 0) {
    reporter.step('10', '연결 점검', 'skip', { detail: '등록을 확인한 호스트가 없다' });
  } else {
    reporter.line('[10] 연결 점검 (등록된 명령 그대로 MCP 프로세스 둘을 띄운다)');
    const startedAt = deps.now();
    const doctor = await runDoctor({
      appRoot: deps.appRoot,
      nodeVersion: deps.nodeVersion,
      hosts: verified.map((host) => host.cli),
      geminiSettings: deps.env.geminiSettings,
      server: deps.env.server,
      launch: deps.launch,
      now: deps.now,
      timers: deps.timers,
      reporter,
      randomBytes: deps.randomBytes,
      limits: deps.doctorLimits,
    });
    reporter.step('10', '연결 점검', doctor.ok ? 'pass' : 'fail', { durationMs: deps.now() - startedAt, errorCode: doctor.ok ? undefined : 'DOCTOR_FAILED' });
  }

  const guide = buildGuide({ registered: verified.map((host) => host.host), claudeChannels, appRoot: deps.appRoot });
  for (const action of guide.actions) reporter.step('11', '안내', 'action', { detail: action });
  for (const note of guide.notes) reporter.line(`  ${note}`);

  if (reporter.count('fail') > 0) return summarize(reporter, EXIT_FAILED);
  return summarize(reporter, verified.length === 0 ? EXIT_NO_HOST : EXIT_OK);
}

/** 제거. 고른 호스트에서 user scope 의 등록을 지운다. 기록, 저장소, 로그, 백업은 지우지 않고 위치를 알린다. */
export async function runRemove(deps: SetupDeps, clients: readonly HostKind[]): Promise<number> {
  const reporter = createReporter(deps.out, deps.log);
  const found = await findHosts(deps, clients, reporter, '제거 1');
  let remaining = 0;
  for (const host of found) {
    const title = 'MCP 등록 제거';
    const current = await lookup(deps, host);
    if (current.state === 'absent') {
      reporter.step('제거 2', title, 'pass', { host: host.host, detail: '등록이 없다' });
      continue;
    }
    if (current.state === 'unreadable') {
      remaining += 1;
      reporter.step('제거 2', title, 'fail', { host: host.host, detail: `등록을 읽지 못했다(${current.detail})`, errorCode: 'REGISTRATION_UNREADABLE' });
      continue;
    }
    if (current.registration.scope !== 'user') {
      remaining += 1;
      reporter.step('제거 2', title, 'action', {
        host: host.host,
        detail: `user 가 아닌 scope(${current.registration.scope})의 등록은 설치가 만든 것이 아니다. 직접 지운다`,
      });
      continue;
    }
    const project = host.host === 'codex' ? codexProjectDefinition(deps) : null;
    if (project !== null) {
      remaining += 1;
      reporter.step('제거 2', title, 'action', {
        host: host.host,
        detail:
          `이 작업 폴더에서 Codex 가 읽는 프로젝트 설정(${project})에 같은 이름(${SERVER_NAME})의 등록이 있다. 그 등록은 설치가 만든 것이 아니라 지우지 않았다. ` +
          '직접 지우거나, 사용자 설정의 등록을 지우려면 이 프로젝트 밖의 폴더에서 다시 실행한다',
      });
      continue;
    }
    const removed = await host.cli.run(removeArgs(host.host));
    const after = succeeded(removed) ? await lookup(deps, host) : null;
    if (after !== null && after.state === 'absent') {
      reporter.step('제거 2', title, 'pass', { host: host.host, detail: '등록을 지웠다' });
    } else {
      remaining += 1;
      const detail = after === null ? failureOf(removed) : '지운 뒤에도 등록이 남아 있다';
      reporter.step('제거 2', title, 'fail', { host: host.host, detail, errorCode: 'REMOVE_FAILED' });
    }
  }
  reporter.line(
    `기록(${join(deps.env.home, 'rooms')}), 저장소(${deps.appRoot}), 진단 로그(${join(deps.env.home, 'logs')}), ` +
      `Codex·Gemini CLI 설정 백업(${join(deps.env.home, 'backups')})은 지우지 않았다. 필요 없으면 직접 지운다.`,
  );
  reporter.line('  설정 백업에는 다른 MCP 서버의 환경 변수 값(토큰 등)이 들어 있을 수 있다. 그 값을 바꿨거나 필요 없으면 백업도 지운다.');
  reporter.line('열려 있는 세션은 다시 시작해야 tool 이 사라진다.');
  return summarize(reporter, reporter.count('fail') > 0 || remaining > 0 ? EXIT_FAILED : EXIT_OK);
}
