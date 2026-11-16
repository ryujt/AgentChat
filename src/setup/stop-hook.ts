// 선택형 Claude Code Stop hook (개선안 P5, mcp-interface.md 7.4).
// poll 모드의 에이전트가 방에 있는 채로 턴을 끝내면 아무도 깨울 수 없다. 사용자가 이 hook 을 켜면, 끝낼 조건이 오기 전의
// 턴 종료를 막고 "wait_for_messages 를 이어 부르라"는 이유를 돌려준다. 기본은 끔이다. 켜고 끄는 것은 사람이 명령으로 한다.
//
// - check: Claude Code 가 턴을 끝내려 할 때 부른다. `<home>/listen/<pid>.json`(mcp-server 가 쓴다) 가운데
//   ppid 가 이 hook 의 부모(= 호스트 프로세스)와 같은 것을 이 세션의 상태로 본다. 확실하지 않으면 언제나 막지 않는다.
// - on / off / status: `~/.claude/settings.json` 의 hooks.Stop 에 이 hook 을 넣고 빼고 본다. 다른 설정은 건드리지 않는다.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LISTEN_STATE_DIR_NAME, parseListenState } from '../protocol/index.js';
import type { ListenState } from '../protocol/index.js';

/** 상한의 기본값(분). 방에 들어간 뒤 이 시간이 지나면 막지 않는다. */
export const STOP_HOOK_DEFAULT_MAX_MIN = 60;
export const STOP_HOOK_MAX_MIN_LIMIT = 24 * 60;
/** settings.json 의 hook 항목을 알아보는 표시. 명령 줄에 든다. */
export const STOP_HOOK_MARKER = 'stop-hook check';
/** hook 하나의 실행 상한(초). Claude Code 의 hook timeout 이다. */
const HOOK_TIMEOUT_SEC = 10;

// ── 판정 ────────────────────────────────────────────────────────────────────

export type StopDecision =
  | { readonly block: false; readonly why: string }
  | { readonly block: true; readonly reason: string };

export interface DecideStopInput {
  /** `<home>/listen` 의 파일들. 읽지 못한 것은 빼고 준다. */
  readonly states: readonly ListenState[];
  /** 이 hook 의 부모 프로세스(= 호스트). */
  readonly hostPid: number;
  /** 그 MCP 프로세스가 살아 있는가. */
  readonly alive: (pid: number) => boolean;
  readonly now: number;
  readonly maxMin: number;
}

/** 에이전트에게 돌려주는 이유. 여러 회사의 에이전트가 읽으므로 영어로 쓴다. */
export function blockReason(maxMin: number): string {
  return (
    'You are still in an Agent Chat room, so do not end this turn yet. ' +
    'Call wait_for_messages with your last next_cursor and keep working with the others on your user\'s request. ' +
    'Stay until your user explicitly tells you to leave the room (then call leave_room); finishing a task or write_report is not a reason to stop. ' +
    'If your user explicitly gave you other work, call set_status with listening=false first and tell your user how to resume. ' +
    `(Agent Chat Stop hook, turned on by your user. It stops blocking ${maxMin} minutes after you entered the room.)`
  );
}

export function decideStop(input: DecideStopInput): StopDecision {
  const mine = input.states.filter((state) => state.ppid === input.hostPid && input.alive(state.pid));
  if (mine.length === 0) return { block: false, why: 'no_session' };
  // 같은 호스트에 MCP 프로세스가 여럿이면(재시작 직후) 방에 있는 것, 그다음 최근 것을 본다.
  const state = [...mine].sort((a, b) => Number(b.in_room) - Number(a.in_room) || b.updated_at.localeCompare(a.updated_at))[0] as ListenState;
  if (!state.in_room) return { block: false, why: 'not_in_room' };
  if (state.delivery_mode === 'channel') return { block: false, why: 'channel_mode' };
  if (state.paused) return { block: false, why: 'paused' };
  // write_report·테스트 중단은 끝낼 조건이 아니다. 사용자가 명시적으로 퇴실시킬 때(leave_room)까지 협업을 이어 간다.
  if (state.entered_at === null) return { block: false, why: 'not_in_room' };
  const entered = Date.parse(state.entered_at);
  if (!Number.isFinite(entered) || input.now - entered >= input.maxMin * 60_000) return { block: false, why: 'max_time' };
  return { block: true, reason: blockReason(input.maxMin) };
}

// ── check (hook 으로 실행) ─────────────────────────────────────────────────

export interface StopHookCheckDeps {
  /** AGENT_CHAT_HOME. */
  readonly home: string;
  readonly hostPid: number;
  readonly maxMin: number;
  readonly now: number;
  readonly out: (text: string) => void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 권한이 없을 뿐이면 살아 있다.
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

/** 상태 파일을 읽는다. 죽은 프로세스의 파일은 지운다(이 hook 이 아니면 지울 곳이 없다). */
export function readListenStates(home: string, alive: (pid: number) => boolean = isAlive): ListenState[] {
  const dir = join(home, LISTEN_STATE_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const states: ListenState[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const parsed = parseListenState(readFileSync(path, 'utf8'));
      if (!parsed.ok) continue;
      if (!alive(parsed.value.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      states.push(parsed.value);
    } catch {
      // 읽는 사이에 지워졌다. 다음 파일로 간다.
    }
  }
  return states;
}

/** hook 본체. 막을 때만 Claude Code 가 읽는 JSON 한 줄을 쓴다. 어떤 실패도 "막지 않음"으로 끝난다. */
export function runStopHookCheck(deps: StopHookCheckDeps): StopDecision {
  let decision: StopDecision;
  try {
    decision = decideStop({ states: readListenStates(deps.home), hostPid: deps.hostPid, alive: isAlive, now: deps.now, maxMin: deps.maxMin });
  } catch {
    decision = { block: false, why: 'error' };
  }
  if (decision.block) deps.out(JSON.stringify({ decision: 'block', reason: decision.reason }));
  return decision;
}

/** `--max-min <n>` 과 `--home <경로>` 를 읽는다. 잘못된 값은 기본값으로 둔다(hook 은 실패하지 않는다). */
export function parseCheckArgs(args: readonly string[], defaultHome: string): { readonly home: string; readonly maxMin: number } {
  let home = defaultHome;
  let maxMin = STOP_HOOK_DEFAULT_MAX_MIN;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === '--home' && value !== undefined && value !== '') {
      home = value;
      index += 1;
    } else if (args[index] === '--max-min' && value !== undefined) {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= STOP_HOOK_MAX_MIN_LIMIT) maxMin = parsed;
      index += 1;
    }
  }
  return { home, maxMin };
}

// ── on / off / status (사람이 실행) ────────────────────────────────────────

/** POSIX 셸 인자 하나. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * hook 명령 줄. `exec` 로 셸을 node 로 바꿔, hook 프로세스의 부모가 호스트(Claude Code)가 되게 한다.
 * 그래야 mcp-server 가 적은 ppid 와 맞는다.
 */
export function stopHookCommand(nodePath: string, cliPath: string, home: string, maxMin: number): string {
  return `exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} ${STOP_HOOK_MARKER} --home ${shellQuote(home)} --max-min ${maxMin}`;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOurs(entry: Json): boolean {
  return isObject(entry) && typeof entry['command'] === 'string' && entry['command'].includes(STOP_HOOK_MARKER);
}

/** hooks.Stop 에서 이 hook 을 뺀 목록. 비게 된 묶음은 지운다. */
function withoutOurs(groups: Json[]): Json[] {
  const kept: Json[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group['hooks'])) {
      kept.push(group);
      continue;
    }
    const hooks = group['hooks'].filter((entry) => !isOurs(entry));
    if (hooks.length === group['hooks'].length) kept.push(group);
    else if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return kept;
}

/** 설정 객체에 이 hook 을 넣거나(command 가 있으면) 뺀다(null). 다른 키와 다른 hook 은 그대로 둔다. */
export function applyStopHook(settings: JsonObject, command: string | null): JsonObject {
  const hooks: JsonObject = isObject(settings['hooks']) ? { ...settings['hooks'] } : {};
  const stop = Array.isArray(hooks['Stop']) ? withoutOurs(hooks['Stop']) : [];
  if (command !== null) stop.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] });
  if (stop.length > 0) hooks['Stop'] = stop;
  else delete hooks['Stop'];
  const next: JsonObject = { ...settings };
  if (Object.keys(hooks).length > 0) next['hooks'] = hooks;
  else delete next['hooks'];
  return next;
}

/** 지금 들어 있는 이 hook 의 명령 줄. 없으면 null. */
export function installedStopHook(settings: JsonObject): string | null {
  const hooks = settings['hooks'];
  if (!isObject(hooks) || !Array.isArray(hooks['Stop'])) return null;
  for (const group of hooks['Stop']) {
    if (!isObject(group) || !Array.isArray(group['hooks'])) continue;
    for (const entry of group['hooks']) if (isOurs(entry) && isObject(entry)) return entry['command'] as string;
  }
  return null;
}

export interface StopHookCommandDeps {
  /** Claude Code 사용자 설정 파일(`$CLAUDE_CONFIG_DIR/settings.json`, 기본 `~/.claude/settings.json`). */
  readonly settingsPath: string;
  /** 바꾸기 전의 설정을 복사해 둘 곳(`<home>/backups`). */
  readonly backupDir: string;
  readonly home: string;
  readonly nodePath: string;
  /** `<패키지 뿌리>/dist/entry/cli.js`. */
  readonly cliPath: string;
  readonly platform: string;
  readonly now: number;
  readonly out: (line: string) => void;
}

export type StopHookAction = { readonly kind: 'on'; readonly maxMin: number } | { readonly kind: 'off' } | { readonly kind: 'status' };

function readSettings(path: string): { ok: true; value: JsonObject } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Json;
    if (!isObject(parsed)) return { ok: false, reason: '설정 파일이 JSON 객체가 아니다' };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: '설정 파일을 JSON 으로 읽지 못했다' };
  }
}

function writeSettings(deps: StopHookCommandDeps, value: JsonObject): void {
  if (existsSync(deps.settingsPath)) {
    mkdirSync(deps.backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(deps.now).toISOString().replace(/[:.]/g, '-');
    copyFileSync(deps.settingsPath, join(deps.backupDir, `claude-settings-${stamp}.json`));
  } else {
    mkdirSync(dirname(deps.settingsPath), { recursive: true });
  }
  const temp = `${deps.settingsPath}.agent-chat.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, deps.settingsPath);
}

/** 종료 코드: 0 성공, 1 실패. */
export function runStopHookCommand(deps: StopHookCommandDeps, action: StopHookAction): number {
  const settings = readSettings(deps.settingsPath);
  if (!settings.ok) {
    deps.out(`실패: ${deps.settingsPath} — ${settings.reason}. 아무 것도 바꾸지 않았다.`);
    return 1;
  }
  const current = installedStopHook(settings.value);
  if (action.kind === 'status') {
    deps.out(current === null ? 'Stop hook: 꺼짐' : `Stop hook: 켜짐 — ${current}`);
    deps.out(`설정 파일: ${deps.settingsPath}`);
    return 0;
  }
  if (action.kind === 'on' && deps.platform === 'win32') {
    deps.out('실패: Stop hook 은 POSIX 셸(macOS, Linux)에서만 동작한다. 아무 것도 바꾸지 않았다.');
    return 1;
  }
  if (action.kind === 'off' && current === null) {
    deps.out('Stop hook 이 이미 꺼져 있다. 바꾸지 않았다.');
    return 0;
  }
  const command = action.kind === 'on' ? stopHookCommand(deps.nodePath, deps.cliPath, deps.home, action.maxMin) : null;
  try {
    writeSettings(deps, applyStopHook(settings.value, command));
  } catch {
    deps.out(`실패: ${deps.settingsPath} 를 쓰지 못했다.`);
    return 1;
  }
  if (action.kind === 'on') {
    deps.out(`Stop hook 을 켰다(방에 들어간 뒤 최대 ${action.maxMin}분). 설정 파일: ${deps.settingsPath}`);
    deps.out('이미 열린 Claude Code 세션에는 /hooks 로 확인하거나 세션을 다시 시작해야 반영된다.');
    deps.out('끄려면: agent-chat stop-hook off');
  } else {
    deps.out(`Stop hook 을 껐다. 설정 파일: ${deps.settingsPath}`);
  }
  return 0;
}
