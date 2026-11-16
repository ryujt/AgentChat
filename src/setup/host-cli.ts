// 호스트 CLI(claude, codex)를 실행하는 유일한 파일 (architecture.md 3.13, mcp-interface.md 10절).
// 실행하는 하위 명령은 `--version`, `mcp get`·`add`·`remove`·`list`, `auth status` 뿐이다.
// 그 밖의 인자 묶음은 실행 전에 거절한다. 호스트를 새 에이전트로 띄우는 길을 여기서 막는다.

import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { Timers } from '../protocol/index.js';
import type { EnvMap } from './installer-env.js';
import { MCP_ENTRY_SEGMENTS, SERVER_NAME, type HostKind } from './types.js';

export const HOST_CLI_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type HostCliOutcome =
  /** 프로세스가 끝났다. 성공 여부는 code 로 본다. */
  | 'exit'
  /** 실행 파일이 없다. */
  | 'not-found'
  /** 있지만 실행할 수 없다(권한 등). */
  | 'not-executable'
  | 'timeout'
  /** 허용 목록에 없는 인자라 실행하지 않았다. */
  | 'rejected';

export interface HostCliResult {
  readonly outcome: HostCliOutcome;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 거절·실행 실패의 짧은 사유. */
  readonly detail: string;
}

export interface HostCli {
  readonly host: HostKind;
  readonly bin: string;
  run(args: readonly string[]): Promise<HostCliResult>;
}

export interface HostCliOptions {
  readonly host: HostKind;
  readonly bin: string;
  /** 자식에게 줄 환경. 설치를 실행한 환경을 그대로 넘긴다. */
  readonly env: EnvMap;
  readonly timers: Timers;
  readonly timeoutMs?: number;
}

/** 프로세스를 띄우지 못했을 때의 오류 코드. 실행 파일은 있지만 쓸 수 없다는 뜻이다. */
const SPAWN_ERRORS: readonly string[] = ['EACCES', 'EPERM', 'ENOEXEC', 'EISDIR', 'ENOTDIR', 'ELOOP'];

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\0\r\n]*$/;

function isMcpEntry(path: string): boolean {
  return path.split(/[\\/]/).slice(-MCP_ENTRY_SEGMENTS.length).join('/') === MCP_ENTRY_SEGMENTS.join('/');
}

function sameArgs(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, index) => arg === expected[index]);
}

/** `<머리> (플래그 KEY=VALUE)* -- <절대 경로 node> <…/dist/entry/mcp.js>` 인가. */
function isAddCommand(args: readonly string[], head: readonly string[], envFlag: string): boolean {
  if (!sameArgs(args.slice(0, head.length), head)) return false;
  let index = head.length;
  while (args[index] === envFlag) {
    if (!ENV_ASSIGNMENT.test(args[index + 1] ?? '')) return false;
    index += 2;
  }
  if (args[index] !== '--') return false;
  const launch = args.slice(index + 1);
  const [command, script] = launch;
  return launch.length === 2 && command !== undefined && script !== undefined && isAbsolute(command) && isAbsolute(script) && isMcpEntry(script);
}

/**
 * 인자 묶음이 허용 목록에 있는지 본다. 있으면 null, 없으면 거절 사유다.
 * 등록 이름은 `agent-chat` 하나뿐이고, 등록하는 명령은 "node 절대 경로 + 이 패키지의 MCP 진입점" 꼴만 받는다.
 */
export function checkHostCliArgs(host: HostKind, args: readonly string[]): string | null {
  const fixed: readonly (readonly string[])[] =
    host === 'claude'
      ? [
          ['--version'],
          ['mcp', 'get', SERVER_NAME],
          ['mcp', 'list'],
          ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
          ['auth', 'status'],
        ]
      : [
          ['--version'],
          ['mcp', 'get', SERVER_NAME, '--json'],
          ['mcp', 'list', '--json'],
          ['mcp', 'remove', SERVER_NAME],
        ];
  if (fixed.some((allowed) => sameArgs(args, allowed))) return null;
  const added =
    host === 'claude'
      ? isAddCommand(args, ['mcp', 'add', '--scope', 'user', SERVER_NAME], '-e')
      : isAddCommand(args, ['mcp', 'add', SERVER_NAME], '--env');
  return added ? null : 'not an allowed host CLI subcommand';
}

function errorCodeOf(error: unknown): string | number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? code : null;
}

export function createHostCli(options: HostCliOptions): HostCli {
  const { host, bin, env, timers } = options;
  const timeoutMs = options.timeoutMs ?? HOST_CLI_TIMEOUT_MS;

  const run = (args: readonly string[]): Promise<HostCliResult> => {
    const rejected = checkHostCliArgs(host, args);
    if (rejected !== null) {
      return Promise.resolve({ outcome: 'rejected', code: null, stdout: '', stderr: '', detail: rejected });
    }
    return new Promise((resolve) => {
      const state = { timedOut: false };
      const child = execFile(
        bin,
        [...args],
        { env: { ...env }, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          timers.clearTimeout(timer);
          const base = { stdout, stderr };
          if (state.timedOut) {
            resolve({ ...base, outcome: 'timeout', code: null, detail: `no exit within ${timeoutMs}ms` });
            return;
          }
          const code = errorCodeOf(error);
          if (code === 'ENOENT') resolve({ ...base, outcome: 'not-found', code: null, detail: 'executable not found' });
          else if (typeof code === 'string' && SPAWN_ERRORS.includes(code)) resolve({ ...base, outcome: 'not-executable', code: null, detail: code });
          else if (error === null) resolve({ ...base, outcome: 'exit', code: 0, detail: '' });
          else resolve({ ...base, outcome: 'exit', code: typeof code === 'number' ? code : 1, detail: typeof code === 'string' ? code : '' });
        },
      );
      // 호스트 CLI 가 입력을 기다리며 멈추지 않게 한다.
      child.stdin?.end();
      const timer = timers.setTimeout(() => {
        state.timedOut = true;
        child.kill('SIGKILL');
        // 손자 프로세스가 출력 파이프를 물고 있으면 끝났다는 알림이 오지 않는다. 우리 쪽 끝을 닫는다.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, timeoutMs);
    });
  };

  return { host, bin, run };
}
