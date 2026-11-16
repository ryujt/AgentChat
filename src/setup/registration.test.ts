// 등록 명령의 인자와 `mcp get` 출력 읽기 (architecture.md 3.13 설치 단계 6~8).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkHostCliArgs, type HostCliResult } from './host-cli.js';
import {
  addArgs,
  expectedLaunch,
  extraEnvOf,
  getArgs,
  launchOf,
  manualAddCommand,
  matchesLaunch,
  mcpEntryPath,
  parseClaudeGet,
  parseCodexGet,
  pickName,
  pointsAtInstall,
  removeArgs,
  type Registration,
} from './registration.js';

const NODE = '/opt/node dir/bin/node';
const APP = '/Users/someone/agent chat home/app';
const ENTRY = `${APP}/dist/entry/mcp.js`;

function exit(code: number, stdout: string, stderr = ''): HostCliResult {
  return { outcome: 'exit', code, stdout, stderr, detail: '' };
}

function present(result: ReturnType<typeof parseClaudeGet>): Registration {
  assert.equal(result.state, 'present');
  return (result as { registration: Registration }).registration;
}

// 실제 CLI(Claude Code 2.1.325)의 `claude mcp get <이름>` 출력 모양이다. Environment 아래 줄의 들여쓰기는 가정이다.
const CLAUDE_GET = [
  'agent-chat:',
  '  Scope: User config (available in all your projects)',
  '  Status: ✔ Connected',
  '  Type: stdio',
  `  Command: ${NODE}`,
  `  Args: ${ENTRY}`,
  '  Environment:',
  '    AGENT_CHAT_CLIENT=claude-code',
  '    AGENT_CHAT_NAME=claude-4kq2',
  '    AGENT_CHAT_WAIT_MAX_SEC=100',
  '',
  'To remove this server, run: claude mcp remove agent-chat -s user',
  '',
].join('\n');

describe('registration: 등록 명령', () => {
  it('Claude Code 는 user scope 와 -e, Codex 는 --env 로 등록한다', () => {
    const claude = expectedLaunch('claude', { nodePath: NODE, appRoot: APP, name: 'claude-4kq2', waitMaxSec: 100 });
    assert.deepEqual(addArgs('claude', claude), [
      'mcp', 'add', '--scope', 'user', 'agent-chat',
      '-e', 'AGENT_CHAT_CLIENT=claude-code', '-e', 'AGENT_CHAT_NAME=claude-4kq2', '-e', 'AGENT_CHAT_WAIT_MAX_SEC=100',
      '--', NODE, ENTRY,
    ]);
    const codex = expectedLaunch('codex', { nodePath: NODE, appRoot: APP, name: 'codex-7f3k', waitMaxSec: 540 });
    assert.deepEqual(addArgs('codex', codex), [
      'mcp', 'add', 'agent-chat',
      '--env', 'AGENT_CHAT_CLIENT=codex', '--env', 'AGENT_CHAT_NAME=codex-7f3k', '--env', 'AGENT_CHAT_WAIT_MAX_SEC=540', '--env', 'AGENT_CHAT_CHANNEL=off',
      '--', NODE, ENTRY,
    ]);
    assert.deepEqual(removeArgs('claude'), ['mcp', 'remove', '--scope', 'user', 'agent-chat']);
    assert.deepEqual(removeArgs('codex'), ['mcp', 'remove', 'agent-chat']);
    assert.equal(mcpEntryPath(APP), ENTRY);
  });

  it('만든 인자는 모두 host-cli 의 허용 목록을 통과한다', () => {
    for (const host of ['claude', 'codex'] as const) {
      const launch = expectedLaunch(host, { nodePath: NODE, appRoot: APP, name: 'n-1', waitMaxSec: 50, extraEnv: { AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' } });
      for (const args of [getArgs(host), removeArgs(host), addArgs(host, launch)]) assert.equal(checkHostCliArgs(host, args), null, args.join(' '));
    }
  });

  it('권한이나 승인에 관한 옵션을 넣지 않는다', () => {
    for (const host of ['claude', 'codex'] as const) {
      const text = addArgs(host, expectedLaunch(host, { nodePath: NODE, appRoot: APP, name: 'n-1', waitMaxSec: 50 })).join(' ');
      assert.doesNotMatch(text, /permission|approval|sandbox|allow|trust|dangerously|yolo|hook/i);
    }
  });

  it('이름은 처음에 한 번 만들고, 기존 등록에 쓸 수 있는 이름이 있으면 그대로 쓴다', () => {
    const bytes = (size: number): Uint8Array => new Uint8Array(size).fill(10);
    assert.equal(pickName('claude', null, bytes), 'claude-aaaa');
    assert.equal(pickName('codex', null, bytes), 'codex-aaaa');
    const kept = present(parseClaudeGet(exit(0, CLAUDE_GET)));
    assert.equal(pickName('claude', kept, bytes), 'claude-4kq2');
    // 예약 이름과 형식이 틀린 이름은 버리고 새로 만든다.
    for (const bad of ['system', 'has space', '']) {
      assert.equal(pickName('claude', { ...kept, env: { AGENT_CHAT_NAME: bad } }, bytes), 'claude-aaaa', bad);
    }
  });

  it('사람이 실행할 등록 명령은 공백이 든 경로를 따옴표로 감싼다', () => {
    const launch = expectedLaunch('claude', { nodePath: NODE, appRoot: APP, name: 'claude-4kq2', waitMaxSec: 100 });
    assert.equal(
      manualAddCommand('claude', launch),
      `claude mcp add --scope user agent-chat -e AGENT_CHAT_CLIENT=claude-code -e AGENT_CHAT_NAME=claude-4kq2 -e AGENT_CHAT_WAIT_MAX_SEC=100 -- '${NODE}' '${ENTRY}'`,
    );
  });
});

describe('registration: claude mcp get 읽기', () => {
  it('명령, 인자 글, 환경, 범위를 읽는다', () => {
    const registration = present(parseClaudeGet(exit(0, CLAUDE_GET)));
    assert.deepEqual(registration, {
      command: NODE,
      args: null,
      argsText: ENTRY,
      env: { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: 'claude-4kq2', AGENT_CHAT_WAIT_MAX_SEC: '100' },
      scope: 'user',
      toolTimeoutSec: null,
      extraSettings: [],
    });
  });

  it('없는 등록과 읽지 못한 출력을 가린다', () => {
    assert.deepEqual(parseClaudeGet(exit(1, '', 'No MCP server named "agent-chat". Configured servers: other\n')), { state: 'absent' });
    assert.equal(parseClaudeGet(exit(1, '', 'something else broke')).state, 'unreadable');
    assert.equal(parseClaudeGet(exit(0, 'unexpected output')).state, 'unreadable');
    assert.equal(parseClaudeGet({ outcome: 'timeout', code: null, stdout: '', stderr: '', detail: 'no exit' }).state, 'unreadable');
  });

  it('범위를 가린다', () => {
    const scopes: [string, Registration['scope']][] = [
      ['User config (available in all your projects)', 'user'],
      ['Local config (private to you in this project)', 'local'],
      ['Project config (shared via .mcp.json)', 'project'],
      ['Enterprise config (managed by your organization)', 'other'],
    ];
    for (const [label, scope] of scopes) {
      const text = CLAUDE_GET.replace('User config (available in all your projects)', label);
      assert.equal(present(parseClaudeGet(exit(0, text))).scope, scope, label);
    }
  });

  it('환경이 없는 등록과 stdio 가 아닌 등록도 읽는다', () => {
    const bare = ['agent-chat:', '  Scope: User config (available in all your projects)', '  Type: stdio', `  Command: ${NODE}`, '  Args: --mcp-stdio', '  Environment:', '', 'To remove this server, run: x', ''].join('\n');
    assert.deepEqual(present(parseClaudeGet(exit(0, bare))).env, {});
    const http = ['agent-chat:', '  Scope: User config (available in all your projects)', '  Type: http', '  URL: https://example.com/mcp', ''].join('\n');
    const registration = present(parseClaudeGet(exit(0, http)));
    assert.equal(registration.command, '');
    assert.equal(pointsAtInstall(registration, APP), false);
  });
});

describe('registration: codex mcp get --json 읽기', () => {
  // 실제 CLI(Codex 0.169.0)의 `codex mcp get <이름> --json` 출력 모양이다.
  const json = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      name: 'agent-chat',
      enabled: true,
      disabled_reason: null,
      transport: { type: 'stdio', command: NODE, args: [ENTRY], env: { AGENT_CHAT_CLIENT: 'codex', AGENT_CHAT_NAME: 'codex-7f3k', AGENT_CHAT_WAIT_MAX_SEC: '540', AGENT_CHAT_CHANNEL: 'off' }, env_vars: [], cwd: null },
      enabled_tools: null,
      disabled_tools: null,
      startup_timeout_sec: null,
      tool_timeout_sec: 600,
      ...overrides,
    });

  it('명령, 인자, 환경, tool 호출 한도를 읽는다', () => {
    const registration = present(parseCodexGet(exit(0, json())));
    assert.equal(registration.command, NODE);
    assert.deepEqual(registration.args, [ENTRY]);
    assert.equal(registration.toolTimeoutSec, 600);
    assert.equal(registration.env['AGENT_CHAT_CHANNEL'], 'off');
    assert.equal(present(parseCodexGet(exit(0, json({ tool_timeout_sec: null })))).toolTimeoutSec, null);
    assert.deepEqual(present(parseCodexGet(exit(0, json({ transport: { type: 'stdio', command: NODE, args: [ENTRY], env: null } })))).env, {});
    assert.deepEqual(present(parseCodexGet(exit(0, json()))).extraSettings, [], '설치가 만든 등록에는 설치가 정하지 않는 설정이 없다');
  });

  it('(검토 1차 BOUNDARY-R1-01) 사용자가 더한 설정(도구 제한, 시작 기한, 꺼짐, 작업 폴더, 넘길 변수)을 읽는다', () => {
    const transport = { type: 'stdio', command: NODE, args: [ENTRY], env: {}, env_vars: ['FOO'], cwd: '/tmp' };
    const registration = present(
      parseCodexGet(
        exit(
          0,
          json({ enabled: false, enabled_tools: ['get_status'], disabled_tools: ['create_room', 'join_room'], startup_timeout_sec: 30.0, transport, future_key: 'x' }),
        ),
      ),
    );
    assert.deepEqual(
      [...registration.extraSettings].sort(),
      ['cwd', 'disabled_tools', 'enabled', 'enabled_tools', 'env_vars', 'future_key', 'startup_timeout_sec'],
    );
    // 실제 CLI 는 실수로 낸다(600.0). 정수로 읽는다.
    assert.equal(present(parseCodexGet(exit(0, json({ tool_timeout_sec: 600.0 })))).toolTimeoutSec, 600);
    // 기본값과 같은 값은 사용자 설정으로 치지 않는다.
    assert.deepEqual(present(parseCodexGet(exit(0, json({ enabled: true, disabled_reason: null })))).extraSettings, []);
  });

  it('없는 등록과 읽지 못한 출력을 가린다', () => {
    assert.deepEqual(parseCodexGet(exit(1, '', "Error: No MCP server named 'agent-chat' found.\n")), { state: 'absent' });
    assert.equal(parseCodexGet(exit(1, '', 'Error: failed to load config')).state, 'unreadable');
    assert.equal(parseCodexGet(exit(0, 'not json')).state, 'unreadable');
    assert.equal(parseCodexGet(exit(0, '{"name":"agent-chat"}')).state, 'unreadable');
  });
});

describe('registration: 견주기', () => {
  const claudeLaunch = expectedLaunch('claude', { nodePath: NODE, appRoot: APP, name: 'claude-4kq2', waitMaxSec: 100 });
  const registered = present(parseClaudeGet(exit(0, CLAUDE_GET)));

  it('명령·인자·환경이 같으면 같다', () => {
    assert.equal(matchesLaunch(registered, claudeLaunch, null), true);
  });

  it('하나라도 다르면 다르다', () => {
    assert.equal(matchesLaunch({ ...registered, command: '/usr/bin/node' }, claudeLaunch, null), false);
    assert.equal(matchesLaunch({ ...registered, argsText: '/elsewhere/dist/entry/mcp.js' }, claudeLaunch, null), false);
    assert.equal(matchesLaunch({ ...registered, env: { ...registered.env, AGENT_CHAT_WAIT_MAX_SEC: '50' } }, claudeLaunch, null), false);
    assert.equal(matchesLaunch({ ...registered, env: { ...registered.env, EXTRA: '1' } }, claudeLaunch, null), false);
    assert.equal(matchesLaunch({ ...registered, scope: 'local' }, claudeLaunch, null), false);
    assert.equal(matchesLaunch({ ...registered, toolTimeoutSec: null }, claudeLaunch, 600), false);
    assert.equal(matchesLaunch({ ...registered, toolTimeoutSec: 600 }, claudeLaunch, 600), true);
  });

  it('기본값이 아닌 설치 뿌리면 AGENT_CHAT_HOME 을 등록에 넣고, 기본값이면 넣지 않는다', () => {
    const home = '/Users/me/custom agent home';
    for (const host of ['claude', 'codex'] as const) {
      const withHome = expectedLaunch(host, { nodePath: NODE, appRoot: APP, name: 'n-1', waitMaxSec: 50, agentHome: home });
      assert.equal(withHome.env['AGENT_CHAT_HOME'], home, host);
      assert.equal(checkHostCliArgs(host, addArgs(host, withHome)), null);
      for (const agentHome of [null, undefined]) {
        const plain = expectedLaunch(host, { nodePath: NODE, appRoot: APP, name: 'n-1', waitMaxSec: 50, agentHome });
        assert.equal('AGENT_CHAT_HOME' in plain.env, false, `${host} ${String(agentHome)}`);
      }
    }
    // 설치가 정하는 변수다. 기존 등록의 값은 옮기지 않고(기본값으로 다시 설치하면 빠진다), 사용자가 준 값으로 덮이지 않는다.
    const old = { ...registered, env: { ...registered.env, AGENT_CHAT_HOME: '/old/home' } };
    assert.deepEqual(extraEnvOf('claude', old), {});
    const launch = expectedLaunch('claude', { nodePath: NODE, appRoot: APP, name: 'claude-4kq2', waitMaxSec: 100, extraEnv: extraEnvOf('claude', old) });
    assert.equal(matchesLaunch(old, launch, null), false, '기본값으로 다시 설치하면 다시 등록한다');
    const moved = expectedLaunch('claude', { nodePath: NODE, appRoot: APP, name: 'claude-4kq2', waitMaxSec: 100, agentHome: '/new/home', extraEnv: { AGENT_CHAT_HOME: '/old/home' } });
    assert.equal(moved.env['AGENT_CHAT_HOME'], '/new/home');
  });

  it('사용자가 더한 변수는 다시 등록할 때 옮긴다', () => {
    const custom = { ...registered, env: { ...registered.env, AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' } };
    assert.deepEqual(extraEnvOf('claude', custom), { AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' });
    assert.deepEqual(extraEnvOf('claude', null), {});
    const launch = expectedLaunch('claude', { nodePath: NODE, appRoot: APP, name: 'claude-4kq2', waitMaxSec: 100, extraEnv: extraEnvOf('claude', custom) });
    assert.equal(matchesLaunch(custom, launch, null), true);
    // 설치가 정하는 변수는 사용자가 더한 값으로 덮이지 않는다.
    const forced = expectedLaunch('codex', { nodePath: NODE, appRoot: APP, name: 'c-1', waitMaxSec: 540, extraEnv: { AGENT_CHAT_CHANNEL: 'auto' } });
    assert.equal(forced.env['AGENT_CHAT_CHANNEL'], 'off');
  });

  it('이 설치를 가리키는 등록만 띄울 실행 정보를 준다', () => {
    assert.equal(pointsAtInstall(registered, APP), true);
    assert.deepEqual(launchOf(registered, APP), { command: NODE, args: [ENTRY], env: registered.env });
    assert.equal(launchOf(registered, '/another/app'), null);
    const codex: Registration = { command: NODE, args: [ENTRY, '--flag'], argsText: `${ENTRY} --flag`, env: {}, scope: 'user', toolTimeoutSec: null, extraSettings: [] };
    assert.equal(pointsAtInstall(codex, APP), false);
    assert.deepEqual(launchOf({ ...codex, args: [ENTRY], argsText: ENTRY }, APP), { command: NODE, args: [ENTRY], env: {} });
  });
});
