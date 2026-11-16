// 설치 단계 5~11 과 제거의 조율 (architecture.md 3.13). 호스트 CLI 와 MCP 서버는 가짜다.
// 프로세스를 띄우는 전 구간은 tests/e2e/install 과 installer/*.test.mjs 가 본다.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readInstallerEnv, type EnvMap } from './installer-env.js';
import { runRemove, runSetup, type SetupDeps } from './setup.js';
import { createFakeHost, createFakeHub, createMemoryLog, realTimers, type FakeHost, type FakeHostOptions, type FakeHub, type FakeHubOptions } from './testing.js';
import type { HostKind } from './types.js';

const root = mkdtempSync(join(tmpdir(), 'agent-chat-setup-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NODE = '/opt/node dir/bin/node';
const BOTH: readonly HostKind[] = ['claude', 'codex'];
const CODEX_OTHERS = 'approval_policy = "on-request"\n\n[mcp_servers.other]\ncommand = "other"\n';

interface World {
  readonly home: string;
  readonly appRoot: string;
  readonly entry: string;
  readonly codexConfig: string;
  readonly hosts: Record<HostKind, FakeHost>;
  readonly hub: FakeHub;
  readonly lines: string[];
  readonly log: ReturnType<typeof createMemoryLog>;
  readonly deps: SetupDeps;
  text(): string;
  adds(host: HostKind): string[][];
}

interface WorldOptions {
  readonly claude?: FakeHostOptions;
  readonly codex?: FakeHostOptions;
  readonly hub?: FakeHubOptions;
  readonly env?: EnvMap;
  /** Codex 가 등록을 쓰는 파일이 설치가 고치는 파일과 다르다. */
  readonly codexWritesElsewhere?: boolean;
  readonly managedSettingsPath?: string;
  /** 기본값이 아닌 설치 뿌리(AGENT_CHAT_HOME)로 설치한다. */
  readonly customHome?: boolean;
  /** 설치를 실행한 작업 폴더(세계 폴더 기준 상대 경로). 생략하면 세계 폴더다. 만들어 둔다. */
  readonly cwd?: string;
}

function world(name: string, options: WorldOptions = {}): World {
  const base = join(root, name);
  // 설치 뿌리는 기본값(<사용자 홈>/.agent-chat)이다. customHome 이면 다른 곳이다(그때는 등록에 AGENT_CHAT_HOME 이 들어간다).
  const home = options.customHome === true ? join(base, 'agent chat home') : join(base, 'user home', '.agent-chat');
  const appRoot = join(home, 'app');
  const entry = join(appRoot, 'dist', 'entry', 'mcp.js');
  const codexDir = join(base, 'user home', '.codex');
  const codexConfig = join(codexDir, 'config.toml');
  mkdirSync(join(appRoot, 'dist', 'entry'), { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(entry, '// 가짜 진입점\n');
  writeFileSync(codexConfig, CODEX_OTHERS);
  const elsewhere = join(base, 'elsewhere.toml');
  const hosts: Record<HostKind, FakeHost> = {
    claude: createFakeHost('claude', options.claude),
    codex: createFakeHost('codex', { configPath: options.codexWritesElsewhere === true ? elsewhere : codexConfig, ...options.codex }),
  };
  const hub = createFakeHub(options.hub);
  const lines: string[] = [];
  const log = createMemoryLog();
  const cwd = options.cwd === undefined ? base : join(base, options.cwd);
  mkdirSync(cwd, { recursive: true });
  const deps: SetupDeps = {
    env: readInstallerEnv({ AGENT_CHAT_HOME: home, ...options.env }, join(base, 'user home'), cwd),
    rawEnv: {},
    appRoot,
    nodePath: NODE,
    nodeVersion: '26.12.1',
    platform: 'darwin',
    now: () => Date.parse('2026-11-15T03:04:05Z'),
    timers: realTimers,
    log,
    out: (line) => void lines.push(line),
    launch: hub.launch,
    makeHostCli: (host) => hosts[host],
    randomBytes: (size) => new Uint8Array(size).fill(10),
    managedSettingsPath: options.managedSettingsPath ?? join(base, 'no-managed-settings.json'),
    doctorLimits: { messageMs: 150, srflxWaitMs: 120, srflxPollMs: 40 },
  };
  return {
    home,
    appRoot,
    entry,
    codexConfig,
    hosts,
    hub,
    lines,
    log,
    deps,
    text: () => lines.join('\n'),
    adds: (host) => hosts[host].calls.filter((call) => call[1] === 'add'),
  };
}

function stepLines(w: World): string[] {
  return w.lines.filter((line) => /^\[\d+\]/.test(line)).map((line) => line.replace(/ — .*$/, ''));
}

describe('setup: 설치', () => {
  it('두 호스트를 등록하고 확인한 뒤 Channels 보고, 연결 점검, 안내 순서로 진행한다', async () => {
    const w = world('both');
    const code = await runSetup(w.deps, BOTH);
    assert.equal(code, 0, w.text());
    assert.deepEqual(stepLines(w), [
      '[5] 호스트 찾기 (Claude Code): 통과',
      '[5] 호스트 찾기 (Codex): 통과',
      '[6] MCP 등록 (Claude Code): 통과',
      '[7] MCP 등록 (Codex): 통과',
      '[7] tool_timeout_sec = 600 (Codex): 통과',
      '[8] 등록 확인 (Claude Code): 통과',
      '[8] 등록 확인 (Codex): 통과',
      '[9] Channels (Claude Code): 불명',
      '[9] Channels (Codex): 불가',
      '[10] 연결 점검 (등록된 명령 그대로 MCP 프로세스 둘을 띄운다)',
      '[10] 연결 점검: 통과',
      '[11] 안내: 사용자 조치 필요',
      '[11] 안내: 사용자 조치 필요',
      '[11] 안내: 사용자 조치 필요',
    ]);
    assert.match(w.text(), /결과: 통과 \d+, 실패 0, .*\(종료 코드 0\)/);
  });

  it('등록 명령의 인자가 설계와 같다', async () => {
    const w = world('args');
    await runSetup(w.deps, BOTH);
    assert.deepEqual(w.adds('claude'), [[
      'mcp', 'add', '--scope', 'user', 'agent-chat',
      '-e', 'AGENT_CHAT_CLIENT=claude-code', '-e', 'AGENT_CHAT_NAME=claude-aaaa', '-e', 'AGENT_CHAT_WAIT_MAX_SEC=100',
      '--', NODE, w.entry,
    ]]);
    assert.deepEqual(w.adds('codex'), [[
      'mcp', 'add', 'agent-chat',
      '--env', 'AGENT_CHAT_CLIENT=codex', '--env', 'AGENT_CHAT_NAME=codex-aaaa', '--env', 'AGENT_CHAT_WAIT_MAX_SEC=540', '--env', 'AGENT_CHAT_CHANNEL=off',
      '--', NODE, w.entry,
    ]]);
    // 설치가 호스트 CLI 로 실행한 하위 명령은 허용 목록의 것뿐이다.
    const heads = new Set([...w.hosts.claude.calls, ...w.hosts.codex.calls].map((call) => (call[0] === '--version' ? call[0] : `${call[0]} ${call[1]}`)));
    assert.deepEqual([...heads].sort(), ['--version', 'auth status', 'mcp add', 'mcp get']);
  });

  it('Codex 설정 파일에는 tool_timeout_sec 한 줄만 더하고 백업을 남긴다. 승인 모드 키를 넣지 않는다', async () => {
    const w = world('codex-config');
    await runSetup(w.deps, ['codex']);
    const config = readFileSync(w.codexConfig, 'utf8');
    assert.ok(config.startsWith(CODEX_OTHERS), '다른 항목이 바뀌었다');
    assert.ok(config.includes('[mcp_servers.agent-chat]\ntool_timeout_sec = 600\ncommand = '));
    const own = config.slice(CODEX_OTHERS.length);
    assert.doesNotMatch(own, /approval|enabled_tools|disabled_tools|sandbox|trust/);
    const backups = readdirSync(join(w.home, 'backups'));
    assert.deepEqual(backups, ['codex-config-20261115T030405Z.toml']);
    assert.doesNotMatch(readFileSync(join(w.home, 'backups', backups[0] as string), 'utf8'), /tool_timeout_sec = 600/);
  });

  it('다시 실행하면 등록을 건너뛰고 결과가 같다. 이름을 새로 만들지 않는다', async () => {
    const w = world('rerun');
    assert.equal(await runSetup(w.deps, BOTH), 0);
    const config = readFileSync(w.codexConfig, 'utf8');
    const claude = structuredClone(w.hosts.claude.scopes.get('user'));
    w.lines.length = 0;
    w.hosts.claude.calls.length = 0;
    w.hosts.codex.calls.length = 0;
    const second = { ...w.deps, randomBytes: (size: number) => new Uint8Array(size).fill(11) };
    assert.equal(await runSetup(second, BOTH), 0, w.text());
    assert.deepEqual(stepLines(w).slice(0, 6), [
      '[5] 호스트 찾기 (Claude Code): 통과',
      '[5] 호스트 찾기 (Codex): 통과',
      '[6] MCP 등록 (Claude Code): 건너뜀',
      '[7] MCP 등록 (Codex): 건너뜀',
      '[8] 등록 확인 (Claude Code): 통과',
      '[8] 등록 확인 (Codex): 통과',
    ]);
    assert.match(w.text(), /이미 등록됨/);
    assert.deepEqual([...w.hosts.claude.calls, ...w.hosts.codex.calls].filter((call) => call[1] === 'add' || call[1] === 'remove'), []);
    assert.equal(readFileSync(w.codexConfig, 'utf8'), config);
    assert.deepEqual(w.hosts.claude.scopes.get('user'), claude);
    assert.equal(readdirSync(join(w.home, 'backups')).length, 1, '백업을 또 만들었다');
  });

  it('--client 로 고른 호스트만 다룬다', async () => {
    const claudeOnly = world('claude-only');
    assert.equal(await runSetup(claudeOnly.deps, ['claude']), 0);
    assert.deepEqual(claudeOnly.hosts.codex.calls, []);
    assert.equal(readFileSync(claudeOnly.codexConfig, 'utf8'), CODEX_OTHERS);
    assert.doesNotMatch(claudeOnly.text(), /Codex/);

    const codexOnly = world('codex-only');
    assert.equal(await runSetup(codexOnly.deps, ['codex']), 0);
    assert.deepEqual(codexOnly.hosts.claude.calls, []);
    assert.equal(codexOnly.hosts.claude.scopes.size, 0);
    assert.doesNotMatch(codexOnly.text(), /Claude Code\)/);
  });

  it('없는 호스트는 건너뛰고 있는 호스트만 등록한다', async () => {
    const w = world('one-missing', { codex: { version: null } });
    assert.equal(await runSetup(w.deps, BOTH), 0, w.text());
    assert.match(w.text(), /\[5\] 호스트 찾기 \(Codex\): 건너뜀/);
    assert.equal(w.adds('claude').length, 1);
  });

  it('고른 호스트가 하나도 없으면 수동 등록 명령을 출력하고 종료 코드 2 다. 점검은 하지 않는다', async () => {
    const w = world('none', { claude: { version: null }, codex: { version: null } });
    assert.equal(await runSetup(w.deps, BOTH), 2);
    assert.match(w.text(), /claude mcp add --scope user agent-chat -e AGENT_CHAT_CLIENT=claude-code .* -- '\/opt\/node dir\/bin\/node' '.*\/dist\/entry\/mcp\.js'/);
    assert.match(w.text(), /codex mcp add agent-chat --env AGENT_CHAT_CLIENT=codex .*AGENT_CHAT_WAIT_MAX_SEC=50 .*AGENT_CHAT_CHANNEL=off/);
    assert.match(w.text(), /\(종료 코드 2\)/);
    assert.equal(w.hub.launches.length, 0);
    assert.doesNotMatch(w.text(), /\[10\]/);
  });

  it('환경 변수로 준 호스트 CLI 를 실행할 수 없으면 건너뛰지 않고 실패다', async () => {
    const w = world('explicit-missing', { claude: { version: null }, env: { AGENT_CHAT_CLAUDE_BIN: '/no/such/claude' } });
    assert.equal(await runSetup(w.deps, ['claude']), 1);
    assert.match(w.text(), /\[5\] 호스트 찾기 \(Claude Code\): 실패 — AGENT_CHAT_CLAUDE_BIN 로 준 파일을 실행할 수 없다/);
    // 다른 호스트가 있으면 그 호스트는 등록하지만 종료 코드는 1 이다.
    const mixed = world('explicit-missing-mixed', { claude: { version: null }, env: { AGENT_CHAT_CLAUDE_BIN: '/no/such/claude' } });
    assert.equal(await runSetup(mixed.deps, BOTH), 1);
    assert.equal(mixed.adds('codex').length, 1);
  });

  it('기본값이 아닌 AGENT_CHAT_HOME 으로 설치하면 두 호스트의 등록 환경에 그 값을 넣는다. 다시 실행하면 이미 등록됨이다', async () => {
    const w = world('custom-home', { customHome: true });
    assert.equal(w.deps.env.homeIsDefault, false);
    assert.equal(await runSetup(w.deps, BOTH), 0, w.text());
    assert.equal(w.hosts.claude.scopes.get('user')?.env['AGENT_CHAT_HOME'], w.home);
    assert.equal(w.adds('codex')[0]?.includes(`AGENT_CHAT_HOME=${w.home}`), true);
    // 연결 점검은 등록된 환경 그대로 MCP 프로세스를 띄운다. 그 프로세스도 같은 설치 뿌리를 쓴다.
    assert.equal(w.hub.launches.length > 0 && w.hub.launches.every((launch) => launch.env['AGENT_CHAT_HOME'] === w.home), true);
    w.lines.length = 0;
    assert.equal(await runSetup(w.deps, BOTH), 0, w.text());
    assert.match(w.text(), /\[6\] MCP 등록 \(Claude Code\): 건너뜀 — 이미 등록됨/);
    assert.match(w.text(), /\[7\] MCP 등록 \(Codex\): 건너뜀 — 이미 등록됨/);
  });

  it('기본값으로 다시 설치하면 예전 등록의 AGENT_CHAT_HOME 을 뺀다', async () => {
    const w = world('home-back-to-default');
    w.hosts.claude.scopes.set('user', {
      command: NODE,
      args: [w.entry],
      env: { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: 'claude-keep', AGENT_CHAT_WAIT_MAX_SEC: '100', AGENT_CHAT_HOME: '/old/agent home' },
    });
    assert.equal(await runSetup(w.deps, ['claude']), 0, w.text());
    assert.match(w.text(), /\[6\] MCP 등록 \(Claude Code\): 통과 — 명령이나 환경이 달라 다시 등록/);
    assert.deepEqual(w.hosts.claude.scopes.get('user')?.env, { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: 'claude-keep', AGENT_CHAT_WAIT_MAX_SEC: '100' });
  });

  it('명령이나 환경이 다른 등록은 지우고 다시 등록한다. 이름과 사용자가 더한 변수는 지킨다', async () => {
    const w = world('changed');
    w.hosts.claude.scopes.set('user', {
      command: '/old/node',
      args: ['/old/app/dist/entry/mcp.js'],
      env: { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: 'claude-keep', AGENT_CHAT_WAIT_MAX_SEC: '50', AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' },
    });
    assert.equal(await runSetup(w.deps, ['claude']), 0, w.text());
    assert.match(w.text(), /\[6\] MCP 등록 \(Claude Code\): 통과 — 명령이나 환경이 달라 다시 등록/);
    assert.deepEqual(w.hosts.claude.calls.filter((call) => call[1] === 'add' || call[1] === 'remove').map((call) => call[1]), ['remove', 'add']);
    assert.deepEqual(w.hosts.claude.scopes.get('user'), {
      command: NODE,
      args: [w.entry],
      env: { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: 'claude-keep', AGENT_CHAT_WAIT_MAX_SEC: '100', AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' },
    });
  });

  it('user 가 아닌 scope 에 같은 이름이 있으면 등록하지 않고 사용자 조치 필요로 알린다', async () => {
    const w = world('local-scope', { codex: { version: null } });
    const local = { command: '/other/node', args: ['/other/server.js'], env: {} };
    w.hosts.claude.scopes.set('local', local);
    assert.equal(await runSetup(w.deps, BOTH), 2, w.text());
    assert.match(w.text(), /\[6\] MCP 등록 \(Claude Code\): 사용자 조치 필요 — user 가 아닌 scope\(local\)/);
    assert.deepEqual(w.adds('claude'), []);
    assert.deepEqual(w.hosts.claude.calls.filter((call) => call[1] === 'remove'), []);
    assert.deepEqual(w.hosts.claude.scopes.get('local'), local);
    assert.match(w.text(), /\[10\] 연결 점검: 건너뜀/);
  });

  it('(검토 1차 BOUNDARY-R1-01) 기존 Codex 등록에 사용자가 건 제한이 있으면 다시 등록하지 않고 사용자 조치 필요로 알린다. 설정 파일을 바꾸지 않는다', async () => {
    const w = world('codex-user-keys');
    // brew 업그레이드 전 경로로 등록돼 있고, 사용자가 도구 제한과 승인 모드를 더했다.
    const before = [
      CODEX_OTHERS,
      '[mcp_servers.agent-chat]',
      'command = "/opt/homebrew/Cellar/node/26.11.0/bin/node"',
      `args = ${JSON.stringify([w.entry])}`,
      'disabled_tools = ["create_room", "join_room"]',
      'default_tools_approval_mode = "prompt"',
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 600',
      '',
      '[mcp_servers.agent-chat.env]',
      'AGENT_CHAT_CLIENT = "codex"',
      'AGENT_CHAT_NAME = "codex-keep"',
      'AGENT_CHAT_WAIT_MAX_SEC = "540"',
      'AGENT_CHAT_CHANNEL = "off"',
      '',
    ].join('\n');
    writeFileSync(w.codexConfig, before);
    const code = await runSetup(w.deps, ['codex']);
    assert.equal(code, 2, w.text());
    assert.match(w.text(), /\[7\] MCP 등록 \(Codex\): 사용자 조치 필요 — 기존 등록에 설치가 정하지 않는 설정\(default_tools_approval_mode, disabled_tools, startup_timeout_sec\)이 있다/);
    assert.ok(w.text().includes(JSON.stringify(NODE)), '손으로 맞출 명령을 알려 준다');
    assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove'), [], 'remove/add 를 하지 않는다');
    assert.equal(readFileSync(w.codexConfig, 'utf8'), before, '설정 파일을 바꾸지 않는다');
    assert.equal(existsSync(join(w.home, 'backups')), false);
    assert.match(w.text(), /\[10\] 연결 점검: 건너뜀/);
  });

  it('(검토 1차 BOUNDARY-R1-01) get --json 이 내는 사용자 설정만 있어도(파일에 표가 없어도) 다시 등록하지 않는다', async () => {
    const w = world('codex-user-json', { codexWritesElsewhere: true });
    const elsewhere = join(root, 'codex-user-json', 'elsewhere.toml');
    writeFileSync(elsewhere, ['[mcp_servers.agent-chat]', 'command = "/old/node"', `args = ${JSON.stringify([w.entry])}`, 'enabled_tools = ["get_status"]', ''].join('\n'));
    assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
    assert.match(w.text(), /사용자 조치 필요 — 기존 등록에 설치가 정하지 않는 설정\(enabled_tools\)/);
    assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove'), []);
  });

  describe('(검토 2차 BOUNDARY-R2-01) 표준 머리줄이 아닌 표기로 적힌 Codex 등록', () => {
    const OLD = { command: '/old/node', env: { AGENT_CHAT_CLIENT: 'codex', AGENT_CHAT_NAME: 'codex-keep', AGENT_CHAT_WAIT_MAX_SEC: '540', AGENT_CHAT_CHANNEL: 'off' } };
    const forms: [string, (entry: string) => string, string][] = [
      [
        'ch1 인라인 표',
        (entry) =>
          `[mcp_servers]\nagent-chat = { command = "/old/node", args = ${JSON.stringify([entry])}, default_tools_approval_mode = "prompt", env = { AGENT_CHAT_NAME = "codex-keep" } }\n`,
        'default_tools_approval_mode',
      ],
      [
        'ch2 [mcp_servers] 의 점 키',
        (entry) =>
          [
            '[mcp_servers]',
            'agent-chat.command = "/old/node"',
            `agent-chat.args = ${JSON.stringify([entry])}`,
            'agent-chat.default_tools_approval_mode = "prompt"',
            'agent-chat.tools.send_message.approval_mode = "prompt"',
            '',
          ].join('\n'),
        'default_tools_approval_mode, tools',
      ],
      [
        'ch3 최상위 점 키',
        (entry) =>
          [
            'mcp_servers.agent-chat.command = "/old/node"',
            `mcp_servers.agent-chat.args = ${JSON.stringify([entry])}`,
            'mcp_servers.agent-chat.default_tools_approval_mode = "prompt"',
            '',
          ].join('\n'),
        'default_tools_approval_mode',
      ],
    ];
    for (const [label, make, keys] of forms) {
      it(`${label}: 사용자가 건 승인 모드를 찾아 다시 등록하지 않는다. 설정 파일을 바꾸지 않는다`, async () => {
        const w = world(`codex-form-${label.slice(0, 3)}`, { codex: { registeredAs: { ...OLD, args: ['/old/app/dist/entry/mcp.js'] } } });
        const before = make(w.entry);
        writeFileSync(w.codexConfig, before);
        assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
        assert.match(w.text(), new RegExp(`\\[7\\] MCP 등록 \\(Codex\\): 사용자 조치 필요 — 기존 등록에 설치가 정하지 않는 설정\\(${keys}\\)이 있다`));
        assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove'), [], 'remove/add 를 하지 않는다');
        assert.equal(readFileSync(w.codexConfig, 'utf8'), before, '설정 파일을 바꾸지 않는다');
      });
    }

    // (검토 3차 BOUNDARY-R3-01) 큰따옴표 키의 이스케이프. 실제 Codex 는 둘 다 agent-chat 으로 읽는다.
    const escaped: [string, string, string][] = [
      [
        'esc1 머리줄만 이스케이프',
        [
          '[mcp_servers."agent\\u002Dchat"]',
          'command = "node"',
          'args = ["x.js"]',
          'default_tools_approval_mode = "approve"',
          '[mcp_servers."agent\\u002Dchat".tools.room_send]',
          'approval_mode = "prompt"',
          '',
        ].join('\n'),
        'default_tools_approval_mode, tools',
      ],
      ['esc2 이스케이프 하위 표와 표준 머리줄', '[mcp_servers."agent\\u002Dchat".tools.x]\napproval_mode = "prompt"\n[mcp_servers.agent-chat]\ncommand = "node"\n', 'tools'],
    ];
    for (const [label, before, keys] of escaped) {
      it(`(검토 3차 BOUNDARY-R3-01) ${label}: 도구별 승인을 찾아 다시 등록하지 않는다. 설정 파일을 바꾸지 않는다`, async () => {
        const w = world(`codex-${label.slice(0, 4)}`, { codex: { registeredAs: { ...OLD, args: ['x.js'] } } });
        writeFileSync(w.codexConfig, before);
        assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
        assert.match(w.text(), new RegExp(`\\[7\\] MCP 등록 \\(Codex\\): 사용자 조치 필요 — 기존 등록에 설치가 정하지 않는 설정\\(${keys}\\)이 있다`));
        assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove'), [], 'remove/add 를 하지 않는다');
        assert.equal(readFileSync(w.codexConfig, 'utf8'), before, '설정 파일을 바꾸지 않는다');
        assert.equal(existsSync(join(w.home, 'backups')), false);
      });
    }

    it('이 서버의 정의를 설정 파일에서 찾지 못했는데 이름은 보이면, 다시 등록하지 않고 사용자 조치 필요로 멈춘다', async () => {
      const w = world('codex-form-unknown', { codex: { registeredAs: { ...OLD, args: ['/old/app/dist/entry/mcp.js'] } } });
      // 해석기가 모르는 곳에 정의가 있다(여기서는 주석이 이름을 말할 뿐 정의가 없다). 읽지 못한 키를 지울 수 있어 멈춘다.
      const before = `${CODEX_OTHERS}\n# agent-chat 은 [mcp_servers] 아래 다른 표기로 적어 두었다\n`;
      writeFileSync(w.codexConfig, before);
      assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
      assert.match(w.text(), /\[7\] MCP 등록 \(Codex\): 사용자 조치 필요 — .*정의를 .*찾지 못했다/);
      assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove'), []);
      assert.equal(readFileSync(w.codexConfig, 'utf8'), before);
    });
  });

  it('(검토 2차 BOUNDARY-R2-03) 사용자 조치 필요 안내에는 설치가 정하는 env 값만 싣는다. 사용자가 넣은 env 의 값은 싣지 않는다', async () => {
    const w = world('codex-secret-env');
    writeFileSync(
      w.codexConfig,
      [
        CODEX_OTHERS,
        '[mcp_servers.agent-chat]',
        'command = "/old/node"',
        `args = ${JSON.stringify([w.entry])}`,
        'disabled_tools = ["send_message"]',
        '',
        '[mcp_servers.agent-chat.env]',
        'AGENT_CHAT_CLIENT = "codex"',
        'AGENT_CHAT_NAME = "codex-keep"',
        'MY_API_TOKEN = "sk-secret-123"',
        '',
      ].join('\n'),
    );
    assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
    assert.match(w.text(), /\[7\] MCP 등록 \(Codex\): 사용자 조치 필요/);
    assert.equal(w.text().includes('sk-secret-123'), false, `사용자 env 값이 출력에 나왔다:\n${w.text()}`);
    assert.match(w.text(), /AGENT_CHAT_NAME=codex-keep/, '손으로 맞출 설치 변수는 싣는다');
    assert.match(w.text(), /AGENT_CHAT_WAIT_MAX_SEC=540/);
    assert.match(w.text(), /MY_API_TOKEN/, '그대로 둘 변수의 이름은 알려 준다');
    assert.equal(JSON.stringify(w.log.events).includes('sk-secret-123'), false, '진단 로그에도 없다');
  });

  describe('(검토 3차 BOUNDARY-R3-02) 작업 폴더의 Codex 프로젝트 설정에 같은 이름의 등록', () => {
    const PROJECT = { command: 'node', args: ['proj.js'], env: {} };
    const projectToml = '[mcp_servers.agent-chat]\ncommand = "node"\nargs = ["proj.js"]\ndefault_tools_approval_mode = "prompt"\n';
    const userToml = `[projects."${join(root, 'x')}"]\ntrust_level = "trusted"\n\n${CODEX_OTHERS}`;

    it('작업 폴더의 .codex/config.toml 에 등록이 있으면 다시 등록하지 않고 사용자 조치 필요로 멈춘다. 두 파일을 바꾸지 않는다', async () => {
      // 실제 Codex 는 신뢰한 프로젝트 폴더에서 그 등록을 get 결과로 내고, remove/add 는 사용자 설정만 고친다(검토자 실측).
      const w = world('codex-project', { codex: { registeredAs: PROJECT } });
      const projectConfig = join(root, 'codex-project', '.codex', 'config.toml');
      mkdirSync(join(root, 'codex-project', '.codex'), { recursive: true });
      writeFileSync(projectConfig, projectToml);
      const before = userToml;
      writeFileSync(w.codexConfig, before);
      assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
      assert.ok(
        w.lines.some((line) => line.startsWith('[7] MCP 등록 (Codex): 사용자 조치 필요 — ') && line.includes(`프로젝트 설정(${projectConfig})에 같은 이름(agent-chat)의 등록이 있다`)),
        w.text(),
      );
      assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove'), [], 'remove/add 를 하지 않는다');
      assert.equal(readFileSync(w.codexConfig, 'utf8'), before, '사용자 설정을 바꾸지 않는다');
      assert.equal(readFileSync(projectConfig, 'utf8'), projectToml, '프로젝트 설정을 바꾸지 않는다');
      assert.equal(existsSync(join(w.home, 'backups')), false);
      assert.doesNotMatch(w.text(), /대기 상한을 50초로 등록했다/);
    });

    it('사용자 설정에도 정의가 있어도 멈춘다(Codex 는 신뢰한 프로젝트의 등록을 먼저 쓴다)', async () => {
      const w = world('codex-project-both', { codex: { registeredAs: PROJECT } });
      mkdirSync(join(root, 'codex-project-both', '.codex'), { recursive: true });
      writeFileSync(join(root, 'codex-project-both', '.codex', 'config.toml'), projectToml);
      const before = `${CODEX_OTHERS}\n[mcp_servers.agent-chat]\ncommand = "/old/node"\nargs = ${JSON.stringify([w.entry])}\n`;
      writeFileSync(w.codexConfig, before);
      assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
      assert.match(w.text(), /\[7\] MCP 등록 \(Codex\): 사용자 조치 필요 — .*프로젝트 설정\(/);
      assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove'), []);
      assert.equal(readFileSync(w.codexConfig, 'utf8'), before);
    });

    it('git 저장소 안이면 저장소 뿌리부터 작업 폴더까지의 .codex/config.toml 을 본다. 뿌리 위는 보지 않는다', async () => {
      const w = world('codex-project-git', { codex: { registeredAs: PROJECT }, cwd: join('repo', 'sub', 'deeper') });
      const repo = join(root, 'codex-project-git', 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.codex'), { recursive: true });
      writeFileSync(join(repo, '.codex', 'config.toml'), projectToml);
      assert.equal(await runSetup(w.deps, ['codex']), 2, w.text());
      assert.ok(w.text().includes(`프로젝트 설정(${join(repo, '.codex', 'config.toml')})`), w.text());

      // 저장소 뿌리 위의 .codex 는 Codex 가 읽지 않는다. 그곳의 등록으로는 멈추지 않는다.
      // 사용자 설정에 옛 등록이 있어 get 이 present 다(그래서 프로젝트 설정을 찾아본다).
      const above = world('codex-project-above', { cwd: 'repo' });
      mkdirSync(join(root, 'codex-project-above', 'repo', '.git'), { recursive: true });
      mkdirSync(join(root, 'codex-project-above', '.codex'), { recursive: true });
      writeFileSync(join(root, 'codex-project-above', '.codex', 'config.toml'), projectToml);
      writeFileSync(above.codexConfig, `${CODEX_OTHERS}\n[mcp_servers.agent-chat]\ncommand = "/old/node"\nargs = ${JSON.stringify([above.entry])}\n`);
      assert.equal(await runSetup(above.deps, ['codex']), 0, above.text());
      assert.match(above.text(), /\[7\] MCP 등록 \(Codex\): 통과 — 명령이나 환경이 달라 다시 등록/);
    });

    it('프로젝트 설정에 이 이름이 없으면 지금처럼 등록한다', async () => {
      const w = world('codex-project-other');
      mkdirSync(join(root, 'codex-project-other', '.codex'), { recursive: true });
      writeFileSync(join(root, 'codex-project-other', '.codex', 'config.toml'), '[mcp_servers.other]\ncommand = "o"\n');
      assert.equal(await runSetup(w.deps, ['codex']), 0, w.text());
      assert.match(w.text(), /\[7\] tool_timeout_sec = 600 \(Codex\): 통과/);
    });

    it('제거도 프로젝트 설정의 등록은 지우지 않고 알린다. 등록이 남았으므로 종료 코드 1 이다', async () => {
      const w = world('codex-project-remove', { codex: { registeredAs: PROJECT } });
      const projectConfig = join(root, 'codex-project-remove', '.codex', 'config.toml');
      mkdirSync(join(root, 'codex-project-remove', '.codex'), { recursive: true });
      writeFileSync(projectConfig, projectToml);
      assert.equal(await runRemove(w.deps, ['codex']), 1, w.text());
      assert.ok(w.text().includes(`[제거 2] MCP 등록 제거 (Codex): 사용자 조치 필요 — `) && w.text().includes(`프로젝트 설정(${projectConfig})`), w.text());
      assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'remove'), []);
      assert.equal(readFileSync(projectConfig, 'utf8'), projectToml);
    });
  });

  it('(검토 1차 BOUNDARY-R1-01) 다시 등록할 때는 Codex CLI 가 파일을 고치기 전에 백업한다. 이 실행의 백업은 하나다', async () => {
    const w = world('codex-backup-before');
    const before = [
      CODEX_OTHERS,
      '[mcp_servers.agent-chat]',
      'command = "/old/node"',
      `args = ${JSON.stringify([w.entry])}`,
      '',
      '[mcp_servers.agent-chat.env]',
      'AGENT_CHAT_NAME = "codex-keep"',
      '',
    ].join('\n');
    writeFileSync(w.codexConfig, before);
    assert.equal(await runSetup(w.deps, ['codex']), 0, w.text());
    assert.deepEqual(w.hosts.codex.calls.filter((call) => call[1] === 'add' || call[1] === 'remove').map((call) => call[1]), ['remove', 'add']);
    const backups = readdirSync(join(w.home, 'backups'));
    assert.equal(backups.length, 1, backups.join(','));
    assert.equal(readFileSync(join(w.home, 'backups', backups[0] as string), 'utf8'), before, '바꾸기 전 내용 그대로다');
    assert.match(w.text(), /\[7\] MCP 등록 \(Codex\): 통과 — 명령이나 환경이 달라 다시 등록\. 바꾸기 전 설정 백업: /);
    assert.match(readFileSync(w.codexConfig, 'utf8'), /AGENT_CHAT_NAME = "codex-keep"/);
  });

  it('Codex 설정 파일을 고치지 못하면 그 부분만 건너뛰고 대기 상한을 50초로 등록한다', async () => {
    const w = world('codex-edit-fails', { codexWritesElsewhere: true });
    assert.equal(await runSetup(w.deps, ['codex']), 0, w.text());
    assert.match(w.text(), /\[7\] tool_timeout_sec = 600 \(Codex\): 건너뜀 — 설정 파일을 고치지 못했다.*대기 상한을 50초로 등록했다/);
    assert.deepEqual(w.adds('codex').map((call) => call.filter((arg) => arg.startsWith('AGENT_CHAT_WAIT_MAX_SEC'))), [['AGENT_CHAT_WAIT_MAX_SEC=540'], ['AGENT_CHAT_WAIT_MAX_SEC=50']]);
    assert.equal(readFileSync(w.codexConfig, 'utf8'), CODEX_OTHERS, '등록이 없는 설정 파일을 건드렸다');
    // 바꾸기 전 백업은 호스트 CLI 를 부르기 전에 뜬다. Codex 가 다른 파일에 쓰는 줄은 그때 모른다.
    assert.deepEqual(readdirSync(join(w.home, 'backups')).map((name) => readFileSync(join(w.home, 'backups', name), 'utf8')), [CODEX_OTHERS]);
    // 다시 실행해도 결과가 같다.
    w.lines.length = 0;
    assert.equal(await runSetup(w.deps, ['codex']), 0);
    assert.match(w.text(), /대기 상한을 50초로 등록했다/);
    assert.equal(w.adds('codex').at(-1)?.includes('AGENT_CHAT_WAIT_MAX_SEC=50'), true);
  });

  it('고친 설정을 Codex 가 읽지 못하면 고치기 전으로 되돌리고 50초로 등록한다', async () => {
    const w = world('codex-unread', { codex: { hideTimeout: true } });
    assert.equal(await runSetup(w.deps, ['codex']), 0, w.text());
    assert.match(w.text(), /\[7\] tool_timeout_sec = 600 \(Codex\): 건너뜀/);
    const config = readFileSync(w.codexConfig, 'utf8');
    assert.doesNotMatch(config, /tool_timeout_sec/);
    assert.match(config, /AGENT_CHAT_WAIT_MAX_SEC = "50"/);
  });

  it('등록에 실패하면 실패이고 종료 코드 1 이다', async () => {
    const w = world('add-fails', { claude: { failAdd: true }, codex: { version: null } });
    assert.equal(await runSetup(w.deps, BOTH), 1);
    assert.match(w.text(), /\[6\] MCP 등록 \(Claude Code\): 실패/);
    assert.match(w.text(), /\[10\] 연결 점검: 건너뜀/);
  });

  it('(검토 2차 BOUNDARY-R2-02) 등록 확인은 등록한 Node 명령과, 셸이 찾은 경로를 쓰지 않은 까닭을 보여 준다', async () => {
    const plain = world('node-note-none');
    assert.equal(await runSetup(plain.deps, ['codex']), 0, plain.text());
    assert.ok(plain.lines.includes(`[8] 등록 확인 (Codex): 통과 — 명령 ${NODE}`), plain.text());

    const w = world('node-note');
    const note = '셸이 찾은 /run/user/1000/fnm_multishells/1_2/bin/node 는 셸 세션이 끝나면 지워지는 링크라 쓰지 않았다';
    const deps: SetupDeps = { ...w.deps, nodeNote: note };
    assert.equal(await runSetup(deps, ['codex']), 0, w.text());
    assert.ok(w.lines.includes(`[8] 등록 확인 (Codex): 통과 — 명령 ${NODE}. ${note}`), w.text());
  });

  it('등록 뒤에 읽은 경로가 이 설치와 다르면 등록 확인이 실패한다', async () => {
    const w = world('verify-fails', { claude: { reportPath: '/elsewhere/dist/entry/mcp.js' }, codex: { version: null } });
    w.hosts.claude.scopes.set('user', { command: NODE, args: ['/elsewhere/dist/entry/mcp.js'], env: {} });
    assert.equal(await runSetup(w.deps, BOTH), 1);
    assert.match(w.text(), /\[8\] 등록 확인 \(Claude Code\): 실패 — 등록된 명령이 이 설치와 다르다/);
    assert.equal(w.hub.launches.length, 0);
  });

  it('연결 점검이 실패하면 종료 코드 1 이다', async () => {
    const w = world('doctor-fails', { hub: { createError: { code: 'SERVER_UNREACHABLE' } } });
    assert.equal(await runSetup(w.deps, BOTH), 1);
    assert.match(w.text(), /D4 시그널링: 실패 — SERVER_UNREACHABLE/);
    assert.match(w.text(), /\[10\] 연결 점검: 실패/);
    assert.match(w.text(), /\(종료 코드 1\)/);
  });

  it('연결 점검은 AGENT_CHAT_SERVER 를 create_room 의 server 인자로 주고 등록에는 넣지 않는다', async () => {
    const w = world('server-env', { env: { AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' } });
    assert.equal(await runSetup(w.deps, BOTH), 0, w.text());
    assert.equal(w.hub.toolCalls.find((call) => call.name === 'create_room')?.args['server'], 'ws://127.0.0.1:8787');
    assert.equal(w.adds('claude').flat().some((arg) => arg.includes('AGENT_CHAT_SERVER')), false);
    assert.equal(w.adds('codex').flat().some((arg) => arg.includes('AGENT_CHAT_SERVER')), false);
  });

  it('연결 점검은 두 호스트의 등록을 하나씩 띄운다', async () => {
    const w = world('doctor-both');
    await runSetup(w.deps, BOTH);
    assert.deepEqual(w.hub.launches.map((launch) => [launch.command, launch.args, launch.env['AGENT_CHAT_CLIENT']]), [
      [NODE, [w.entry], 'claude-code'],
      [NODE, [w.entry], 'codex'],
    ]);
    assert.equal(w.hub.open(), 0);
  });

  it('Channels 보고에 판정표의 행 번호가 나온다', async () => {
    const rows: [string, WorldOptions, RegExp][] = [
      ['row1', { claude: { version: '2.1.79 (Claude Code)' } }, /Channels \(Claude Code\): 불가 — 판정표 1행/],
      ['row2', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, /불가 — 판정표 2행/],
      ['row3', { claude: { auth: { authMethod: 'third_party' } } }, /불가 — 판정표 3행/],
      ['row4', { claude: { version: '2.1.127 (Claude Code)', auth: { authMethod: 'api_key' } } }, /불가 — 판정표 4행/],
      ['row5', { claude: { auth: 'fail' } }, /불명 — 판정표 5행/],
      ['row9', {}, /불명 — 판정표 9행/],
    ];
    for (const [name, options, expected] of rows) {
      const w = world(`channels-${name}`, { ...options, codex: { version: null } });
      assert.equal(await runSetup(w.deps, BOTH), 0, w.text());
      assert.match(w.text(), expected, name);
    }
  });

  it('Channels 6~8행: 관리형 설정 파일과 확인 기록 파일을 읽는다', async () => {
    const managed = (name: string, content: string): string => {
      const path = join(root, `${name}.json`);
      writeFileSync(path, content);
      return path;
    };
    const off = world('channels-row6', { codex: { version: null }, managedSettingsPath: managed('managed-off', '{"channelsEnabled":false}') });
    await runSetup(off.deps, BOTH);
    assert.match(off.text(), /불가 — 판정표 6행/);

    const silent = world('channels-row7', { codex: { version: null }, managedSettingsPath: managed('managed-silent', '{"permissions":{}}') });
    await runSetup(silent.deps, BOTH);
    assert.match(silent.text(), /불명 — 판정표 7행/);

    const confirmed = world('channels-row8', { codex: { version: null } });
    writeFileSync(
      join(confirmed.home, 'channel-check.json'),
      JSON.stringify({ v: 1, host: 'claude-code', host_version: '2.1.325', confirmed_at: '2026-11-15T03:00:00Z', fallback_at: null }),
    );
    await runSetup(confirmed.deps, BOTH);
    assert.match(confirmed.text(), /가능 — 판정표 8행.*마지막 확인 시각: 2026-11-15T03:00:00Z/);
  });

  it('Codex 는 항상 "불가: 채널이 없다. poll 로 받는다"로 보고한다', async () => {
    const w = world('channels-codex');
    await runSetup(w.deps, ['codex']);
    assert.match(w.text(), /\[9\] Channels \(Codex\): 불가 — 채널이 없다\. poll 로 받는다\./);
  });

  it('안내에 재시작, 승인, 항상 허용 범위, IP 공개, channel 경고문이 든다. 권한을 대신 바꾸지 않는다', async () => {
    const w = world('guide');
    await runSetup(w.deps, BOTH);
    const text = w.text();
    assert.match(text, /열려 있는 Claude Code 세션을 다시 시작한다/);
    assert.match(text, /열려 있는 Codex 세션을 다시 시작한다/);
    assert.match(text, /설치와 에이전트는 권한·허용 목록·hook 설정을 고치지 않는다/);
    assert.match(text, /"항상 허용"을 골라도 되는 tool: wait_for_messages, send_message/);
    assert.match(text, /매번 승인으로 남기기를 권하는 tool: create_room, join_room, start_test/);
    assert.match(text, /이 PC 의 IP 주소를 본다/);
    assert.ok(text.includes('--dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.'));
    assert.match(text, /설치는 플래그를 대신 붙이지 않고 승인을 대신하지 않는다/);
    // Channels 가 불가면 channel 안내를 싣지 않는다.
    const blocked = world('guide-blocked', { env: { CLAUDE_CODE_USE_VERTEX: '1' } });
    await runSetup(blocked.deps, ['claude']);
    assert.doesNotMatch(blocked.text(), /local channel development only/);
  });

  it('진단 로그에는 단계, 결과, 호스트만 남는다', async () => {
    const w = world('log');
    await runSetup(w.deps, BOTH);
    const steps = w.log.events.filter((event) => event.event === 'setup.step');
    assert.deepEqual(
      steps.map((event) => `${event.fields.step} ${event.fields.host ?? '-'} ${event.fields.outcome}`),
      ['5 claude pass', '5 codex pass', '6 claude pass', '7 codex pass', '7 codex pass', '8 claude pass', '8 codex pass', '9 claude unknown', '9 codex impossible', '10 - pass', '11 - action', '11 - action', '11 - action'],
    );
    const allowed = ['step', 'outcome', 'host', 'error_code', 'duration_ms', 'reason'];
    for (const event of w.log.events) {
      assert.equal(event.module, 'setup');
      for (const [key, value] of Object.entries(event.fields)) {
        if (value !== undefined) assert.ok(allowed.includes(key), key);
      }
    }
    assert.doesNotMatch(JSON.stringify(w.log.events), /claude-aaaa|codex-aaaa|node dir|agent chat home/);
  });
});

describe('setup: 제거', () => {
  it('고른 호스트의 등록을 지우고, 다시 제거해도 종료 코드 0 이다', async () => {
    const w = world('remove');
    assert.equal(await runSetup(w.deps, BOTH), 0);
    writeFileSync(join(w.home, 'keep.txt'), 'keep');
    w.lines.length = 0;
    assert.equal(await runRemove(w.deps, BOTH), 0, w.text());
    assert.equal(w.hosts.claude.scopes.size, 0);
    assert.equal(readFileSync(w.codexConfig, 'utf8'), CODEX_OTHERS);
    assert.match(w.text(), /\[제거 2\] MCP 등록 제거 \(Claude Code\): 통과 — 등록을 지웠다/);
    assert.match(w.text(), /\[제거 2\] MCP 등록 제거 \(Codex\): 통과 — 등록을 지웠다/);
    // 기록과 저장소는 지우지 않고 경로만 알려 준다.
    assert.ok(w.text().includes(join(w.home, 'rooms')));
    assert.ok(w.text().includes(w.appRoot));
    // (검토 1차 BOUNDARY-R1-03) 로그와 Codex 설정 백업의 위치도 알리고, 백업에 다른 서버의 비밀값이 있을 수 있다고 알린다.
    assert.ok(w.text().includes(join(w.home, 'logs')));
    assert.ok(w.text().includes(join(w.home, 'backups')));
    assert.match(w.text(), /백업에는 다른 MCP 서버의 환경 변수 값\(토큰 등\)이 들어 있을 수 있다/);
    assert.equal(existsSync(w.entry), true);
    assert.equal(readFileSync(join(w.home, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(w.hub.launches.length, 2, '제거가 MCP 프로세스를 띄웠다');

    w.lines.length = 0;
    assert.equal(await runRemove(w.deps, BOTH), 0);
    assert.match(w.text(), /등록이 없다/);
  });

  it('호스트 하나만 고르면 다른 호스트의 등록은 남는다', async () => {
    const w = world('remove-one');
    await runSetup(w.deps, BOTH);
    assert.equal(await runRemove(w.deps, ['claude']), 0);
    assert.equal(w.hosts.claude.scopes.size, 0);
    assert.match(readFileSync(w.codexConfig, 'utf8'), /\[mcp_servers\.agent-chat\]/);
  });

  it('없는 호스트 CLI 는 건너뛴다. 처음부터 등록이 없어도 종료 코드 0 이다', async () => {
    const w = world('remove-none', { codex: { version: null } });
    assert.equal(await runRemove(w.deps, BOTH), 0, w.text());
    assert.match(w.text(), /\[제거 1\] 호스트 찾기 \(Codex\): 건너뜀/);
    assert.match(w.text(), /\(종료 코드 0\)/);
  });

  it('user 가 아닌 scope 의 등록은 지우지 않고 알린다. 등록이 남았으므로 종료 코드 1 이다', async () => {
    const w = world('remove-local');
    w.hosts.claude.scopes.set('project', { command: '/x/node', args: ['/x/server.js'], env: {} });
    assert.equal(await runRemove(w.deps, ['claude']), 1);
    assert.match(w.text(), /사용자 조치 필요 — user 가 아닌 scope\(project\)/);
    assert.equal(w.hosts.claude.scopes.has('project'), true);
    assert.deepEqual(w.hosts.claude.calls.filter((call) => call[1] === 'remove'), []);
  });
});
