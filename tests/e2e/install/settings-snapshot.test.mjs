// V-L10 (가) 가운데 "비교 도구의 자체 시험".
// 목록 밖의 키만 바뀐 사본은 같다고 하고, 목록의 키가 하나 바뀐 사본은 파일마다 다르다고 한다. 결과에 값이 출력되지 않는다.
// 실행: node --test tests/e2e/install/settings-snapshot.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLAUDE_PROJECT_KEYS, compareSnapshots, readTomlEntries, removeSnapshot, sameJson, takeSnapshot, tomlValueMeaning } from './settings-snapshot.mjs';

const TOOL = fileURLToPath(new URL('./settings-snapshot.mjs', import.meta.url));
const SECRET = 'do-not-print-this';
const NEW_VALUE = 'changed-value-must-not-appear';
const root = mkdtempSync(path.join(tmpdir(), 'agent chat snapshot '));
after(() => rmSync(root, { recursive: true, force: true }));

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const BASE = {
  claudeJson: {
    numStartups: 5,
    tipsHistory: { a: 1 },
    mcpServers: { other: { type: 'stdio', command: '/usr/bin/other', args: ['--flag'], env: { OTHER_TOKEN: SECRET } } },
    projects: {
      '/some/project': {
        allowedTools: ['Bash(ls:*)'],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: false,
        mcpContextUris: [],
        lastCost: 1.5,
      },
    },
  },
  settings: { model: 'keep', theme: 'dark', permissions: { allow: ['Read'], deny: [] }, hooks: { Stop: [] }, skipDangerousModePermissionPrompt: false },
  localSettings: { permissions: { allow: [] } },
  mcpJson: '{"mcpServers":{}}\n',
  managed: '{"channelsEnabled":true}\n',
  codexToml: [
    'notify = ["bash", "-lc", "echo done"]',
    'model = "gpt"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '',
    '[tui]',
    'theme = "dark"',
    '',
    '[projects."/some/project"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.other]',
    'command = "/usr/bin/other"',
    'args = ["--flag"]',
    '',
    '[mcp_servers.other.env]',
    `OTHER_TOKEN = "${SECRET}"`,
    '',
  ].join('\n'),
  codexList: [{ name: 'other', enabled: true, transport: { type: 'stdio', command: '/usr/bin/other', args: ['--flag'], env: { OTHER_TOKEN: SECRET } }, tool_timeout_sec: null }],
};

const OWN_TOML = [
  '',
  '[mcp_servers.agent-chat]',
  'tool_timeout_sec = 600',
  'command = "/opt/node"',
  'args = ["/home/u/.agent-chat/app/dist/entry/mcp.js"]',
  '',
  '[mcp_servers.agent-chat.env]',
  'AGENT_CHAT_NAME = "codex-ab12"',
  '',
].join('\n');

let counter = 0;

/** 임시 홈을 만들고 사본을 뜬 뒤, mutate 로 고치고 다시 사본을 떠 비교한다. initial.codexToml 로 처음 Codex 설정을 바꿀 수 있다. */
function scenario(mutate, initial = {}) {
  counter += 1;
  const base = path.join(root, `case ${counter}`);
  const home = path.join(base, 'home dir');
  const cwd = path.join(base, 'work dir');
  const app = path.join(base, 'home dir', '.agent-chat', 'app');
  const managedDir = path.join(base, 'managed');
  const files = {
    claudeJson: path.join(home, '.claude.json'),
    settings: path.join(home, '.claude', 'settings.json'),
    homeLocalSettings: path.join(home, '.claude', 'settings.local.json'),
    cwdSettings: path.join(cwd, '.claude', 'settings.json'),
    cwdLocalSettings: path.join(cwd, '.claude', 'settings.local.json'),
    cwdMcpJson: path.join(cwd, '.mcp.json'),
    appSettings: path.join(app, '.claude', 'settings.json'),
    appMcpJson: path.join(app, '.mcp.json'),
    managed: path.join(managedDir, 'managed-settings.json'),
    managedMcp: path.join(managedDir, 'managed-mcp.json'),
    codexToml: path.join(home, '.codex', 'config.toml'),
    codexList: path.join(base, 'codex-list.json'),
  };
  for (const dir of [path.join(home, '.claude'), path.join(home, '.codex'), path.join(cwd, '.claude'), path.join(app, '.claude'), managedDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(files.claudeJson, json(BASE.claudeJson));
  writeFileSync(files.settings, json(BASE.settings));
  writeFileSync(files.cwdLocalSettings, json(BASE.localSettings));
  writeFileSync(files.cwdMcpJson, BASE.mcpJson);
  writeFileSync(files.managed, BASE.managed);
  writeFileSync(files.codexToml, initial.codexToml ?? BASE.codexToml);
  writeFileSync(files.codexList, JSON.stringify(BASE.codexList));
  // `codex mcp list --json` 을 흉내 내는 실행 파일. 옆의 파일 내용을 그대로 낸다.
  const codexBin = path.join(base, 'fake codex');
  writeFileSync(codexBin, `#!/bin/sh\n[ "$1 $2 $3" = "mcp list --json" ] || exit 64\ncat "${files.codexList}"\n`);
  chmodSync(codexBin, 0o755);

  const options = { home, cwd, app, codexBin, managed: [files.managed, files.managedMcp], env: { PATH: '/usr/bin:/bin' } };
  const before = path.join(base, 'snapshot before');
  const afterDir = path.join(base, 'snapshot after');
  takeSnapshot({ ...options, outDir: before });
  const edit = (file, change) => writeFileSync(file, json(change(JSON.parse(readFileSync(file, 'utf8')))));
  mutate({ files, edit, home, cwd, app });
  takeSnapshot({ ...options, outDir: afterDir });
  const result = compareSnapshots(before, afterDir);
  const cli = spawnSync(process.execPath, [TOOL, 'compare', before, afterDir], { encoding: 'utf8' });
  return { result, cli, before, afterDir, keys: result.differences.map((difference) => `${difference.file}: ${difference.key}`) };
}

function assertSame(run) {
  assert.deepEqual(run.keys, []);
  assert.equal(run.result.same, true);
  assert.equal(run.cli.status, 0, run.cli.stdout + run.cli.stderr);
  assert.match(run.cli.stdout, /^같다:/);
}

/** 달라진 것이 정확히 expected 뿐이고, 출력에 값이 없다. */
function assertDiffers(run, expected) {
  assert.deepEqual(run.keys, expected);
  assert.equal(run.result.same, false);
  assert.equal(run.cli.status, 1, run.cli.stdout + run.cli.stderr);
  for (const line of expected) assert.ok(run.cli.stdout.includes(`  ${line}`), run.cli.stdout);
  for (const text of [run.cli.stdout, run.cli.stderr, JSON.stringify(run.result)]) {
    assert.equal(text.includes(SECRET), false, '결과에 값이 나왔다');
    assert.equal(text.includes(NEW_VALUE), false, '결과에 값이 나왔다');
  }
}

describe('settings-snapshot: 목록 밖의 키만 바뀌면 같다', () => {
  test('아무 것도 바꾸지 않으면 같다', () => {
    const run = scenario(() => {});
    assertSame(run);
    assert.equal(run.result.compared, 13, '파일 12개와 codex mcp list');
  });

  test('호스트가 스스로 고쳐 쓰는 값과 설치가 넣는 agent-chat 등록은 비교하지 않는다', () => {
    assertSame(
      scenario(({ files, edit }) => {
        edit(files.claudeJson, (config) => ({
          // 키 순서가 달라져도 뜻은 같다.
          projects: {
            '/some/project': { ...config.projects['/some/project'], lastCost: 99, lastSessionId: NEW_VALUE },
            // 설치 중에 생긴 새 항목은 권한 키가 비어 있거나 거짓이면 된다.
            '/new/project': { allowedTools: [], hasTrustDialogAccepted: false, mcpServers: {}, lastCost: 0 },
          },
          mcpServers: { 'agent-chat': { type: 'stdio', command: '/opt/node', args: ['x'], env: { AGENT_CHAT_NAME: NEW_VALUE } }, ...config.mcpServers },
          numStartups: 6,
          tipsHistory: { a: 2, b: NEW_VALUE },
          newTopLevelCache: NEW_VALUE,
        }));
        edit(files.settings, (config) => ({ ...config, model: NEW_VALUE, theme: 'light', tui: { fullscreen: true } }));
        writeFileSync(
          files.codexToml,
          `# 주석이 더해졌다\n${BASE.codexToml.replace('theme = "dark"', `theme = "${NEW_VALUE}"`).replace('model = "gpt"', '\n\nmodel = "other"   # 줄 끝 주석')}\n[desktop]\nmode = "x"\n${OWN_TOML}`,
        );
        writeFileSync(files.codexList, JSON.stringify([...BASE.codexList, { name: 'agent-chat', transport: { command: NEW_VALUE } }]));
      }),
    );
  });

  test('Codex 설정의 줄 순서, 빈 줄, 주석이 달라져도 같다', () => {
    assertSame(
      scenario(({ files }) => {
        writeFileSync(
          files.codexToml,
          [
            '# 순서를 바꿨다',
            'sandbox_mode = "workspace-write"',
            'approval_policy = "on-request"   # 주석',
            'notify = ["bash", "-lc", "echo done"]',
            '[mcp_servers.other.env]',
            `OTHER_TOKEN = "${SECRET}"`,
            '[mcp_servers.other]',
            'args = ["--flag"]',
            '',
            '',
            'command = "/usr/bin/other"',
            '[projects."/some/project"]',
            'trust_level = "trusted"',
          ].join('\n'),
        );
      }),
    );
  });
});

describe('settings-snapshot: 목록의 키가 하나 바뀌면 그 파일이 다르다', () => {
  const claude = (name, change, expected) =>
    test(`~/.claude.json: ${name}`, () => {
      assertDiffers(scenario(({ files, edit }) => edit(files.claudeJson, change)), expected.map((key) => `~/.claude.json: ${key}`));
    });
  const project = 'projects."/some/project"';

  claude('다른 MCP 서버의 환경이 바뀜', (c) => ({ ...c, mcpServers: { other: { ...c.mcpServers.other, env: { OTHER_TOKEN: NEW_VALUE } } } }), ['mcpServers.other']);
  claude('다른 MCP 서버가 더해짐', (c) => ({ ...c, mcpServers: { ...c.mcpServers, sneaky: { command: NEW_VALUE } } }), ['mcpServers.sneaky']);
  claude('다른 MCP 서버가 없어짐', (c) => ({ ...c, mcpServers: {} }), ['mcpServers.other']);
  claude('허용 목록에 규칙이 더해짐', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], allowedTools: ['Bash(ls:*)', `Bash(${NEW_VALUE})`] } } }), [`${project}.allowedTools`]);
  claude('폴더 신뢰가 바뀜', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], hasTrustDialogAccepted: false } } }), [`${project}.hasTrustDialogAccepted`]);
  claude('프로젝트의 MCP 서버가 더해짐', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], mcpServers: { x: { command: NEW_VALUE } } } } }), [`${project}.mcpServers`]);
  claude('.mcp.json 서버 승인이 더해짐', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], enabledMcpjsonServers: [NEW_VALUE] } } }), [`${project}.enabledMcpjsonServers`]);
  claude('.mcp.json 서버 거절이 더해짐', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], disabledMcpjsonServers: [NEW_VALUE] } } }), [`${project}.disabledMcpjsonServers`]);
  claude('외부 include 승인이 바뀜', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], hasClaudeMdExternalIncludesApproved: true } } }), [`${project}.hasClaudeMdExternalIncludesApproved`]);
  claude('MCP 문맥 URI 가 더해짐', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], mcpContextUris: [NEW_VALUE] } } }), [`${project}.mcpContextUris`]);
  claude('새 projects 항목에 허용 규칙이 있음', (c) => ({ ...c, projects: { ...c.projects, '/new/project': { allowedTools: [NEW_VALUE], hasTrustDialogAccepted: false } } }), ['projects."/new/project".allowedTools']);
  claude('있던 허용 규칙이 없어짐', (c) => ({ ...c, projects: { '/some/project': { ...c.projects['/some/project'], allowedTools: [] } } }), [`${project}.allowedTools`]);
  claude('새 projects 항목이 신뢰됨', (c) => ({ ...c, projects: { ...c.projects, '/new/project': { allowedTools: [], hasTrustDialogAccepted: true } } }), ['projects."/new/project".hasTrustDialogAccepted']);

  test('~/.claude.json: 비교하는 projects 키의 목록', () => {
    assert.deepEqual(CLAUDE_PROJECT_KEYS, [
      'allowedTools', 'mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'mcpContextUris',
    ]);
  });

  const settings = (name, change, expected) =>
    test(`~/.claude/settings.json: ${name}`, () => {
      assertDiffers(scenario(({ files, edit }) => edit(files.settings, change)), expected.map((key) => `~/.claude/settings.json: ${key}`));
    });
  settings('permissions.allow 에 규칙이 더해짐', (c) => ({ ...c, permissions: { ...c.permissions, allow: ['Read', NEW_VALUE] } }), ['permissions']);
  settings('hooks 가 더해짐', (c) => ({ ...c, hooks: { Stop: [{ hooks: [{ type: 'command', command: NEW_VALUE }] }] } }), ['hooks']);
  settings('이름에 permission 이 든 키가 바뀜', (c) => ({ ...c, skipDangerousModePermissionPrompt: true }), ['skipDangerousModePermissionPrompt']);
  settings('이름에 mcp 가 든 키가 더해짐', (c) => ({ ...c, enableAllProjectMcpServers: true }), ['enableAllProjectMcpServers']);
  settings('이름에 sandbox 가 든 키가 더해짐', (c) => ({ ...c, sandbox: { enabled: false, note: NEW_VALUE } }), ['sandbox']);
  settings('이름에 hook 이 든 키가 더해짐 (대소문자 무시)', (c) => ({ ...c, disableAllHooks: true }), ['disableAllHooks']);
  settings('permissions 가 없어짐', ({ permissions, ...rest }) => rest, ['permissions']);

  test('작업 폴더의 settings.local.json: permissions 가 바뀜', () => {
    assertDiffers(
      scenario(({ files, edit }) => edit(files.cwdLocalSettings, () => ({ permissions: { allow: [NEW_VALUE] } }))),
      ['<작업 폴더>/.claude/settings.local.json: permissions'],
    );
  });

  test('없던 설정 파일이 생기면 다르다. 내용이 비어도 같다', () => {
    assertDiffers(scenario(({ files }) => writeFileSync(files.homeLocalSettings, '{}\n')), ['~/.claude/settings.local.json: (없던 파일이 생겼다)']);
    assertDiffers(scenario(({ files }) => writeFileSync(files.appSettings, json({ permissions: { allow: [NEW_VALUE] } }))), ['<설치된 저장소>/.claude/settings.json: (없던 파일이 생겼다)']);
    assertDiffers(scenario(({ files }) => writeFileSync(files.appMcpJson, `{"mcpServers":{"x":{"command":"${NEW_VALUE}"}}}`)), ['<설치된 저장소>/.mcp.json: (없던 파일이 생겼다)']);
    assertDiffers(scenario(({ files }) => writeFileSync(files.managedMcp, '{}')), ['관리형 설정 managed-mcp.json: (없던 파일이 생겼다)']);
  });

  test('있던 설정 파일이 없어지면 다르다', () => {
    assertDiffers(scenario(({ files }) => rmSync(files.settings)), ['~/.claude/settings.json: (있던 파일이 없어졌다)']);
    assertDiffers(scenario(({ files }) => rmSync(files.cwdMcpJson)), ['<작업 폴더>/.mcp.json: (있던 파일이 없어졌다)']);
  });

  test('.mcp.json 과 관리형 설정은 한 바이트만 달라도 다르다', () => {
    assertDiffers(scenario(({ files }) => writeFileSync(files.cwdMcpJson, `${BASE.mcpJson} `)), ['<작업 폴더>/.mcp.json: (파일 내용)']);
    assertDiffers(scenario(({ files }) => writeFileSync(files.managed, '{"channelsEnabled":false}\n')), ['관리형 설정 managed-settings.json: (파일 내용)']);
  });

  test('JSON 으로 읽지 못하게 된 설정 파일은 다르다', () => {
    assertDiffers(scenario(({ files }) => writeFileSync(files.settings, `{ "permissions": "${NEW_VALUE}`)), ['~/.claude/settings.json: (JSON 으로 읽지 못했다)']);
  });

  const codex = (name, change, expected) =>
    test(`~/.codex/config.toml: ${name}`, () => {
      assertDiffers(scenario(({ files }) => writeFileSync(files.codexToml, change(BASE.codexToml))), expected.map((key) => `~/.codex/config.toml: ${key}`));
    });
  codex('approval_policy 가 바뀜', (t) => t.replace('"on-request"', '"never"'), ['approval_policy']);
  codex('sandbox_mode 가 바뀜', (t) => t.replace('"workspace-write"', '"danger-full-access"'), ['sandbox_mode']);
  codex('sandbox_mode 가 없어짐', (t) => t.replace('sandbox_mode = "workspace-write"\n', ''), ['sandbox_mode']);
  codex('프로젝트의 trust_level 이 바뀜', (t) => t.replace('"trusted"', '"untrusted"'), ['[projects."/some/project"] trust_level']);
  codex('리터럴 문자열의 내용이 바뀜', (t) => t.replace('"trusted"', "'untrusted'"), ['[projects."/some/project"] trust_level']);
  codex('새 프로젝트가 신뢰됨', (t) => `${t}\n[projects."/new/project"]\ntrust_level = "trusted"\n`, ['[projects."/new/project"] trust_level']);
  codex('notify 가 바뀜', (t) => t.replace('"echo done"', `"${NEW_VALUE}"`), ['notify']);
  codex('이름에 sandbox 가 든 표가 더해짐', (t) => `${t}\n[sandbox_workspace_write]\nnetwork_access = true\n`, ['[sandbox_workspace_write] network_access']);
  codex('이름에 hook 이 든 키가 더해짐', (t) => t.replace('[tui]', `[tui]\nnotification_hook = "${NEW_VALUE}"`), ['[tui] notification_hook']);
  codex('다른 MCP 서버의 명령이 바뀜', (t) => t.replace('command = "/usr/bin/other"', `command = "${NEW_VALUE}"`), ['[mcp_servers.other] command']);
  codex('다른 MCP 서버의 환경이 바뀜', (t) => t.replace(SECRET, NEW_VALUE), ['[mcp_servers.other.env] OTHER_TOKEN']);
  codex('다른 MCP 서버에 승인 모드 키가 더해짐', (t) => t.replace('args = ["--flag"]', 'args = ["--flag"]\ndefault_tools_approval_mode = "approve"'), ['[mcp_servers.other] default_tools_approval_mode']);
  codex('다른 MCP 서버가 더해짐', (t) => `${t}\n[mcp_servers.sneaky]\ncommand = "${NEW_VALUE}"\n`, ['[mcp_servers.sneaky] command']);
  codex('agent-chat 표에 승인 모드 키가 들어감', (t) => `${t}${OWN_TOML.replace('tool_timeout_sec = 600', 'tool_timeout_sec = 600\ndefault_tools_approval_mode = "approve"')}`, [
    '[mcp_servers.agent-chat] default_tools_approval_mode (agent-chat 표에 있으면 안 되는 키)',
  ]);
  codex('agent-chat 표에 enabled_tools 가 들어감', (t) => `${t}${OWN_TOML}enabled_tools = ["${NEW_VALUE}"]\n`.replace('[mcp_servers.agent-chat.env]\nAGENT_CHAT_NAME = "codex-ab12"\n', ''), [
    '[mcp_servers.agent-chat] enabled_tools (agent-chat 표에 있으면 안 되는 키)',
  ]);

  test('codex mcp list --json: 다른 서버의 항목이 바뀜', () => {
    assertDiffers(
      scenario(({ files }) => writeFileSync(files.codexList, JSON.stringify([{ ...BASE.codexList[0], transport: { ...BASE.codexList[0].transport, command: NEW_VALUE } }]))),
      ['codex mcp list --json: codex mcp list: other'],
    );
    assertDiffers(scenario(({ files }) => writeFileSync(files.codexList, JSON.stringify([...BASE.codexList, { name: 'sneaky', transport: { command: NEW_VALUE } }]))), [
      'codex mcp list --json: codex mcp list: sneaky',
    ]);
    assertDiffers(scenario(({ files }) => writeFileSync(files.codexList, 'not json')), ['codex mcp list --json: (한쪽 사본에서만 읽었다)']);
  });

  test('여러 파일이 바뀌면 파일마다 알린다', () => {
    const run = scenario(({ files, edit }) => {
      edit(files.claudeJson, (c) => ({ ...c, mcpServers: {} }));
      edit(files.settings, (c) => ({ ...c, hooks: { Stop: [NEW_VALUE] } }));
      writeFileSync(files.codexToml, BASE.codexToml.replace('"on-request"', '"never"'));
    });
    assertDiffers(run, ['~/.claude.json: mcpServers.other', '~/.claude/settings.json: hooks', '~/.codex/config.toml: approval_policy']);
  });
});

describe('settings-snapshot: Codex 설정 값은 표기가 아니라 뜻으로 견준다', () => {
  // 2026-11-16 실제 홈 V-S1(S-FI-01): Codex 0.169.0 의 `mcp add`·`remove` 가 파일을 다시 쓰면서 다른 서버 표의
  // `args = []` 를 지우고, 정수 시간을 소수로, 배열 공백을 바꿨다. Codex 가 읽는 값(`codex mcp get --json`)은 같았다.
  const OTHERS = [
    '',
    '[mcp_servers.rea]',
    'command = "/usr/bin/rea"',
    'args = [ "/opt/rea", "mcp" ]',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 450',
    'enabled_tools = []',
    '',
    '[mcp_servers.repl]',
    'command = "/usr/bin/repl"',
    'args = []',
    'startup_timeout_sec = 120',
    "note = 'lit'",
    'size = 1_000',
    'mask = 0xff',
    'ratio = 1e2',
    'text = "a\\u0062c"',
    'inline = { a = 1, "b c" = [ true, false ] }',
    '',
  ].join('\n');
  const initial = { codexToml: `${BASE.codexToml}${OTHERS}` };
  const rewrite = (mapper) => scenario(({ files }) => writeFileSync(files.codexToml, mapper(initial.codexToml)), initial);

  test('Codex 가 다시 쓴 표기(빈 args 지움, 정수 → 소수, 배열 공백)는 같다', () => {
    assertSame(
      rewrite((t) =>
        t
          .replace('args = [ "/opt/rea", "mcp" ]', 'args = ["/opt/rea", "mcp"]')
          .replace('startup_timeout_sec = 30', 'startup_timeout_sec = 30.0')
          .replace('tool_timeout_sec = 450', 'tool_timeout_sec = 450.0')
          .replace('args = []\n', '')
          .replace('startup_timeout_sec = 120', 'startup_timeout_sec = 120.0'),
      ),
    );
  });

  test('따옴표 종류, 이스케이프, 밑줄·진법·지수, 인라인 표의 공백이 달라도 뜻이 같으면 같다', () => {
    assertSame(
      rewrite((t) =>
        t
          .replace('"trusted"', "'trusted'")
          .replace("note = 'lit'", 'note = "lit"')
          .replace('size = 1_000', 'size = 1000')
          .replace('mask = 0xff', 'mask = 255')
          .replace('ratio = 1e2', 'ratio = 100.0')
          .replace('text = "a\\u0062c"', "text = 'abc'")
          .replace('inline = { a = 1, "b c" = [ true, false ] }', 'inline = {"b c"=[true,false],a=1}'),
      ),
    );
  });

  const differs = (name, mapper, expected) =>
    test(name, () => assertDiffers(rewrite(mapper), expected.map((key) => `~/.codex/config.toml: ${key}`)));
  differs('시간 값이 바뀌면 다르다', (t) => t.replace('tool_timeout_sec = 450', 'tool_timeout_sec = 450.5'), ['[mcp_servers.rea] tool_timeout_sec']);
  differs('수가 문자열이 되면 다르다', (t) => t.replace('startup_timeout_sec = 30', 'startup_timeout_sec = "30"'), ['[mcp_servers.rea] startup_timeout_sec']);
  differs('배열의 순서가 바뀌면 다르다', (t) => t.replace('[ "/opt/rea", "mcp" ]', '["mcp", "/opt/rea"]'), ['[mcp_servers.rea] args']);
  differs('비어 있지 않던 args 가 비면 다르다', (t) => t.replace('[ "/opt/rea", "mcp" ]', '[]'), ['[mcp_servers.rea] args']);
  differs('빈 enabled_tools 가 없어지면 다르다(빈 목록은 "아무 tool 도 허용하지 않음"일 수 있다)', (t) => t.replace('enabled_tools = []\n', ''), ['[mcp_servers.rea] enabled_tools']);
  differs('MCP 서버 표 밖의 빈 배열은 없는 키와 같게 보지 않는다', (t) => t.replace('[tui]', '[tui]\nsandbox_args = []'), ['[tui] sandbox_args']);
  differs('인라인 표의 값이 바뀌면 다르다', (t) => t.replace('a = 1,', 'a = 2,'), ['[mcp_servers.repl] inline']);
  differs('읽지 못하는 값은 원문으로 견준다', (t) => t.replace("note = 'lit'", 'note = "bad \\q escape"'), ['[mcp_servers.repl] note']);
});

describe('settings-snapshot: 비어 있는 값', () => {
  test('호스트가 빈 기본값을 채우거나 지워도 같다. 빈 값과 없는 키는 뜻이 같다', () => {
    assertSame(
      scenario(({ files, edit }) =>
        edit(files.claudeJson, (c) => {
          const { mcpServers, enabledMcpjsonServers, hasClaudeMdExternalIncludesApproved, ...rest } = c.projects['/some/project'];
          return { ...c, projects: { '/some/project': { ...rest, disabledMcpjsonServers: undefined, newKeyFromHost: [] }, '/another': { mcpServers: {}, allowedTools: [], hasTrustDialogAccepted: false } } };
        }),
      ),
    );
  });
});

describe('settings-snapshot: 사본', () => {
  test('사본 폴더는 0700, 파일은 0600 이고 clean 으로 지운다', () => {
    const run = scenario(() => {});
    assert.equal(statSync(run.before).mode & 0o777, 0o700);
    const names = readdirSync(run.before);
    assert.ok(names.includes('manifest.json') && names.includes('codex-mcp-list.json'));
    for (const name of names) assert.equal(statSync(path.join(run.before, name)).mode & 0o777, 0o600, name);
    // 사본에는 원문이 들어 있다. 그래서 권한을 좁히고 끝나면 지운다.
    assert.ok(names.some((name) => readFileSync(path.join(run.before, name), 'utf8').includes(SECRET)));
    const cleaned = spawnSync(process.execPath, [TOOL, 'clean', run.before, run.afterDir], { encoding: 'utf8' });
    assert.equal(cleaned.status, 0);
    assert.equal(existsSync(run.before), false);
    assert.equal(existsSync(run.afterDir), false);
    removeSnapshot(run.before);
  });

  test('명령줄: take 로 뜬 사본을 compare 로 비교한다. 틀린 사용법은 종료 코드 2 다', () => {
    const base = path.join(root, 'cli');
    const home = path.join(base, 'home dir');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    writeFileSync(path.join(home, '.claude.json'), json(BASE.claudeJson));
    writeFileSync(path.join(home, '.codex', 'config.toml'), BASE.codexToml);
    const take = (out) => spawnSync(process.execPath, [TOOL, 'take', out, '--home', home, '--cwd', base, '--codex-bin', path.join(base, 'no-codex')], { encoding: 'utf8' });
    const first = take(path.join(base, 'one'));
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /사본을 떴다: 파일 2개/);
    writeFileSync(path.join(home, '.codex', 'config.toml'), BASE.codexToml.replace('"on-request"', '"never"'));
    assert.equal(take(path.join(base, 'two')).status, 0);
    const compared = spawnSync(process.execPath, [TOOL, 'compare', path.join(base, 'one'), path.join(base, 'two')], { encoding: 'utf8' });
    assert.equal(compared.status, 1);
    assert.equal(compared.stdout, '다르다: 1개 (값은 출력하지 않는다)\n  ~/.codex/config.toml: approval_policy\n');
    for (const args of [[], ['take'], ['compare', 'only-one'], ['take', 'x', '--unknown', 'y'], ['wat']]) {
      assert.equal(spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' }).status, 2, args.join(' '));
    }
    const missing = spawnSync(process.execPath, [TOOL, 'compare', path.join(base, 'nope'), path.join(base, 'two')], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /^실패: 사본을 읽지 못했다/);
  });

  test('설치 코드(src/setup)를 import 하지 않는다. Node 내장 모듈만 쓴다', () => {
    const source = readFileSync(TOOL, 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    assert.ok(specifiers.length > 0);
    for (const specifier of specifiers) assert.match(specifier, /^node:/, specifier);
    assert.equal(/\bimport\s*\(/.test(source), false, '동적 import 가 있다');
  });
});

describe('settings-snapshot: TOML 줄 단위 읽기', () => {
  const names = (text) => readTomlEntries(text).map((entry) => [entry.table.join('/'), entry.key.join('/'), entry.value]);

  test('표 머리줄로 현재 표를 정하고 키와 값 원문을 얻는다', () => {
    assert.deepEqual(names('a = 1\n\n# 주석\n[t.u]\nb = "x"  # 꼬리 주석\n[ "q r" . s ]\nc.d = true\n'), [
      ['', 'a', '1'],
      ['t/u', 'b', '"x"'],
      ['q r/s', 'c/d', 'true'],
    ]);
  });

  test('여러 줄에 걸친 값은 닫힐 때까지 잇는다', () => {
    const text = ['list = [', '  "a", # 주석', '  "[not.a.table]",', ']', 'text = """', '# 주석이 아니다', '[not.a.table]', '"""', 'after = 1', "lit = '''", 'x = 1', "'''", 'inline = { a = [1, 2], b = "}" }'].join('\n');
    assert.deepEqual(names(text), [
      ['', 'list', '[ "a", "[not.a.table]", ]'],
      ['', 'text', '"""\n# 주석이 아니다\n[not.a.table]\n"""'],
      ['', 'after', '1'],
      ['', 'lit', "'''\nx = 1\n'''"],
      ['', 'inline', '{ a = [1, 2], b = "}" }'],
    ]);
  });

  test('문자열 안의 #, =, 괄호는 값의 일부다', () => {
    assert.deepEqual(names('[projects."/a=b [x] #1"]\ntrust_level = "t#u=[v]"\n"k=1" = 2\n'), [
      ['projects//a=b [x] #1', 'trust_level', '"t#u=[v]"'],
      ['projects//a=b [x] #1', 'k=1', '2'],
    ]);
  });

  test('배열 표는 나온 순서로 번호를 붙인다', () => {
    assert.deepEqual(names('[[hooks]]\nevent = "a"\n[[hooks]]\nevent = "b"\n[other]\nx = 1\n'), [
      ['hooks/#0', 'event', '"a"'],
      ['hooks/#1', 'event', '"b"'],
      ['other', 'x', '1'],
    ]);
  });

  test('CRLF 줄 끝도 읽는다', () => {
    assert.deepEqual(names('a = 1\r\n[t]\r\nb = "x"\r\n'), [['', 'a', '1'], ['t', 'b', '"x"']]);
  });

  test('sameJson 은 객체의 키 순서를 보지 않고 배열의 순서는 본다', () => {
    assert.equal(sameJson({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }), true);
    assert.equal(sameJson([1, 2], [2, 1]), false);
    assert.equal(sameJson({ a: 1 }, { a: 1, b: undefined }), false);
    assert.equal(sameJson(undefined, undefined), true);
    assert.equal(sameJson(null, {}), false);
    assert.equal(sameJson([], {}), false);
  });

  test('tomlValueMeaning: 값 원문의 뜻', () => {
    const cases = [
      ['"a\\tb"', 's:a\tb'],
      ["'a\\tb'", 's:a\\tb'],
      ['"\\U0001F600"', 's:\u{1F600}'],
      ['"""\nline1\\\n   line2"""', 's:line1line2'],
      ['""""quoted""""', 's:"quoted"'],
      ["'''\nraw ''x'''''", "s:raw ''x''"],
      ['30', 'n:30'],
      ['30.0', 'n:30'],
      ['+30', 'n:30'],
      ['3e1', 'n:30'],
      ['0o17', 'n:15'],
      ['0b1_0', 'n:2'],
      ['-inf', 'n:-inf'],
      ['true', true],
      ['1979-05-27 07:32:00Z', 'd:1979-05-27T07:32:00Z'],
      ['[ 1, "1" , ]', ['n:1', 's:1']],
      ['{ a.b = 1, c = [] }', { a: { b: 'n:1' }, c: [] }],
    ];
    for (const [raw, meaning] of cases) assert.deepEqual(tomlValueMeaning(raw), meaning, raw);
    // 읽지 못하면 undefined 다(원문으로 견준다).
    for (const raw of ['"\\q"', '"open', '007', '[1, 2', '{ a = 1, a = 2 }', '1 2', 'yes', '"\\uD800"']) assert.equal(tomlValueMeaning(raw), undefined, raw);
  });
});
