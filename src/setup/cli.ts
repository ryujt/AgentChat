// `agent-chat` CLI 의 인자 해석과 실행 (architecture.md 3.13 공개 진입점).
//   agent-chat setup [--client claude|codex|all] [--remove]
//   agent-chat doctor [--server <주소>]
//   (agent-chat monitor … 는 entry/cli 가 이 파일보다 먼저 entry/monitor 로 넘긴다)

import { join } from 'node:path';
import { runDoctor } from './doctor.js';
import { createHostCli } from './host-cli.js';
import { EXIT_FAILED, EXIT_OK, runRemove, runSetup, type SetupDeps } from './setup.js';
import { STOP_HOOK_DEFAULT_MAX_MIN, STOP_HOOK_MAX_MIN_LIMIT, runStopHookCommand, type StopHookAction } from './stop-hook.js';
import { HOSTS, createReporter, type HostKind } from './types.js';

export const USAGE: readonly string[] = [
  '사용법:',
  '  agent-chat setup [--client claude|codex|gemini|all] [--remove]   MCP 등록(또는 제거), Channels 보고, 연결 점검, 안내',
  '  agent-chat doctor [--server <주소>]                      등록된 명령 그대로 MCP 프로세스 둘을 띄워 연결을 점검',
  '  agent-chat monitor <room_id> [서버] [--json]             방에 읽기 전용 관전자로 들어가 대화를 콘솔에서 본다(-h 로 자세히)',
  '  agent-chat stop-hook on [--max-min <분>] | off | status  Claude Code 가 방에 있는 채로 턴을 끝내지 못하게 하는 선택형 hook(기본 끔)',
  '',
  '설치는 저장소의 installer/install.sh 로 한다(Node 찾기, 의존성 설치, 빌드까지 한다).',
];

export type CliCommand =
  | { readonly kind: 'setup'; readonly clients: readonly HostKind[]; readonly remove: boolean }
  | { readonly kind: 'doctor'; readonly server: string | null }
  | { readonly kind: 'stop-hook'; readonly action: StopHookAction }
  | { readonly kind: 'help' }
  | { readonly kind: 'invalid'; readonly reason: string };

function clientsOf(value: string | undefined): readonly HostKind[] | null {
  if (value === 'all') return HOSTS;
  if (value === 'claude' || value === 'codex' || value === 'gemini') return [value];
  return null;
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return command === undefined ? { kind: 'invalid', reason: '명령이 없다' } : { kind: 'help' };
  }
  if (command === 'setup') {
    let clients: readonly HostKind[] = HOSTS;
    let remove = false;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] as string;
      if (arg === '--remove') remove = true;
      else if (arg === '--client') {
        const parsed = clientsOf(rest[index + 1]);
        if (parsed === null) return { kind: 'invalid', reason: '--client 에는 claude, codex, gemini, all 가운데 하나를 준다' };
        clients = parsed;
        index += 1;
      } else return { kind: 'invalid', reason: `모르는 인자: ${arg}` };
    }
    return { kind: 'setup', clients, remove };
  }
  if (command === 'doctor') {
    let server: string | null = null;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] as string;
      const value = rest[index + 1];
      if (arg !== '--server') return { kind: 'invalid', reason: `모르는 인자: ${arg}` };
      if (value === undefined || value === '') return { kind: 'invalid', reason: '--server 에는 서버 주소를 준다' };
      server = value;
      index += 1;
    }
    return { kind: 'doctor', server };
  }
  if (command === 'stop-hook') {
    const [verb, ...options] = rest;
    if ((verb === 'off' || verb === 'status') && options.length === 0) return { kind: 'stop-hook', action: { kind: verb } };
    if (verb === 'on') {
      let maxMin = STOP_HOOK_DEFAULT_MAX_MIN;
      if (options.length > 0) {
        const value = Number(options[1]);
        if (options[0] !== '--max-min' || options.length !== 2 || !Number.isInteger(value) || value < 1 || value > STOP_HOOK_MAX_MIN_LIMIT) {
          return { kind: 'invalid', reason: `--max-min 에는 1~${STOP_HOOK_MAX_MIN_LIMIT} 사이의 정수를 준다` };
        }
        maxMin = value;
      }
      return { kind: 'stop-hook', action: { kind: 'on', maxMin } };
    }
    return { kind: 'invalid', reason: 'stop-hook 에는 on [--max-min <분>], off, status 가운데 하나를 준다' };
  }
  return { kind: 'invalid', reason: `모르는 명령: ${command}` };
}

export interface CliDeps extends SetupDeps {
  /** 명령 이름 뒤의 인자(`process.argv.slice(2)`). */
  readonly argv: readonly string[];
  /** 사용법과 인자 오류를 쓰는 곳(stderr). */
  readonly err: (line: string) => void;
  /** 사용자 홈. stop-hook 이 `~/.claude/settings.json` 을 찾는다. */
  readonly userHome?: string;
}

/** 명령을 실행하고 종료 코드를 돌려준다. */
export async function runCli(deps: CliDeps): Promise<number> {
  const command = parseCliArgs(deps.argv);
  if (command.kind === 'help') {
    for (const line of USAGE) deps.out(line);
    return EXIT_OK;
  }
  if (command.kind === 'invalid') {
    deps.err(`실패: ${command.reason}`);
    for (const line of USAGE) deps.err(line);
    return EXIT_FAILED;
  }
  if (command.kind === 'setup') {
    return command.remove ? runRemove(deps, command.clients) : runSetup(deps, command.clients);
  }
  if (command.kind === 'stop-hook') {
    const configDir = deps.rawEnv['CLAUDE_CONFIG_DIR'];
    return runStopHookCommand(
      {
        settingsPath: join(configDir !== undefined && configDir !== '' ? configDir : join(deps.userHome ?? '', '.claude'), 'settings.json'),
        backupDir: join(deps.env.home, 'backups'),
        home: deps.env.home,
        nodePath: deps.nodePath,
        cliPath: join(deps.appRoot, 'dist', 'entry', 'cli.js'),
        platform: deps.platform,
        now: deps.now(),
        out: deps.out,
      },
      command.action,
    );
  }
  const reporter = createReporter(deps.out, deps.log);
  reporter.line('연결 점검 (등록된 명령 그대로 MCP 프로세스 둘을 띄운다)');
  const result = await runDoctor({
    appRoot: deps.appRoot,
    nodeVersion: deps.nodeVersion,
    hosts: HOSTS.map((host) => deps.makeHostCli?.(host, deps.env.bins[host].value) ?? createHostCli({ host, bin: deps.env.bins[host].value, env: deps.rawEnv, timers: deps.timers })),
    geminiSettings: deps.env.geminiSettings,
    // --server 가 AGENT_CHAT_SERVER 보다 먼저다.
    server: command.server ?? deps.env.server,
    launch: deps.launch,
    now: deps.now,
    timers: deps.timers,
    reporter,
    randomBytes: deps.randomBytes,
    limits: deps.doctorLimits,
  });
  reporter.line(`결과: ${result.ok ? '통과' : '실패'} (종료 코드 ${result.ok ? EXIT_OK : EXIT_FAILED})`);
  return result.ok ? EXIT_OK : EXIT_FAILED;
}
