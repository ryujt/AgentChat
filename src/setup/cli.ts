// `agent-chat` CLI 의 인자 해석과 실행 (architecture.md 3.13 공개 진입점).
//   agent-chat setup [--client claude|codex|all] [--remove]
//   agent-chat doctor [--server <주소>]

import { runDoctor } from './doctor.js';
import { createHostCli } from './host-cli.js';
import { EXIT_FAILED, EXIT_OK, runRemove, runSetup, type SetupDeps } from './setup.js';
import { HOSTS, createReporter, type HostKind } from './types.js';

export const USAGE: readonly string[] = [
  '사용법:',
  '  agent-chat setup [--client claude|codex|all] [--remove]   MCP 등록(또는 제거), Channels 보고, 연결 점검, 안내',
  '  agent-chat doctor [--server <주소>]                      등록된 명령 그대로 MCP 프로세스 둘을 띄워 연결을 점검',
  '',
  '설치는 저장소의 installer/install.sh 로 한다(Node 찾기, 의존성 설치, 빌드까지 한다).',
];

export type CliCommand =
  | { readonly kind: 'setup'; readonly clients: readonly HostKind[]; readonly remove: boolean }
  | { readonly kind: 'doctor'; readonly server: string | null }
  | { readonly kind: 'help' }
  | { readonly kind: 'invalid'; readonly reason: string };

function clientsOf(value: string | undefined): readonly HostKind[] | null {
  if (value === 'all') return HOSTS;
  if (value === 'claude' || value === 'codex') return [value];
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
        if (parsed === null) return { kind: 'invalid', reason: '--client 에는 claude, codex, all 가운데 하나를 준다' };
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
  return { kind: 'invalid', reason: `모르는 명령: ${command}` };
}

export interface CliDeps extends SetupDeps {
  /** 명령 이름 뒤의 인자(`process.argv.slice(2)`). */
  readonly argv: readonly string[];
  /** 사용법과 인자 오류를 쓰는 곳(stderr). */
  readonly err: (line: string) => void;
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
  const reporter = createReporter(deps.out, deps.log);
  reporter.line('연결 점검 (등록된 명령 그대로 MCP 프로세스 둘을 띄운다)');
  const result = await runDoctor({
    appRoot: deps.appRoot,
    nodeVersion: deps.nodeVersion,
    hosts: HOSTS.map((host) => deps.makeHostCli?.(host, deps.env.bins[host].value) ?? createHostCli({ host, bin: deps.env.bins[host].value, env: deps.rawEnv, timers: deps.timers })),
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
