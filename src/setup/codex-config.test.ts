// Codex 설정 파일의 [mcp_servers.agent-chat] 표에 tool_timeout_sec 을 넣는 줄 단위 편집 (architecture.md 3.13 설치 단계 7).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BACKUP_KEEP, applyToolTimeout, backupCodexConfig, projectConfigPaths, setToolTimeout, splitTablePath, userKeysInTable } from './codex-config.js';

const OTHERS = [
  'notify = ["bash", "-lc", "echo done"]',
  'approval_policy = "on-request"',
  '',
  '[projects."/Users/someone/work [old]"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.other]',
  'command = "other"',
  'tool_timeout_sec = 450',
  '',
].join('\n');

const OWN = ['[mcp_servers.agent-chat]', 'command = "/opt/node dir/bin/node"', 'args = ["/home/u/app/dist/entry/mcp.js"]', '', '[mcp_servers.agent-chat.env]', 'AGENT_CHAT_CLIENT = "codex"', ''].join('\n');

function edited(text: string): string {
  const result = setToolTimeout(text, 600);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return (result as { text: string }).text;
}

describe('codex-config: 표 이름 읽기', () => {
  it('따옴표와 공백이 든 이름을 마디로 나눈다', () => {
    assert.deepEqual(splitTablePath('mcp_servers.agent-chat'), ['mcp_servers', 'agent-chat']);
    assert.deepEqual(splitTablePath(' mcp_servers . "agent-chat" '), ['mcp_servers', 'agent-chat']);
    assert.deepEqual(splitTablePath("mcp_servers.'agent-chat'.env"), ['mcp_servers', 'agent-chat', 'env']);
    assert.deepEqual(splitTablePath('projects."/a b/c.d"'), ['projects', '/a b/c.d']);
    assert.deepEqual(splitTablePath('a."b\\"c"'), ['a', 'b"c']);
    for (const bad of ['', 'a..b', 'a.', '.a', 'a b', 'a."b']) assert.equal(splitTablePath(bad), null, bad);
  });
});

describe('codex-config: 줄 넣기', () => {
  it('표 머리줄 바로 아래에 한 줄을 넣고 다른 줄은 그대로 둔다', () => {
    const text = `${OTHERS}\n${OWN}`;
    const lines = edited(text).split('\n');
    const at = lines.indexOf('[mcp_servers.agent-chat]');
    assert.equal(lines[at + 1], 'tool_timeout_sec = 600');
    lines.splice(at + 1, 1);
    assert.equal(lines.join('\n'), text);
  });

  it('이미 있으면 값을 바꾸고, 같으면 아무 것도 바꾸지 않는다', () => {
    const before = `${OWN.replace('command =', 'tool_timeout_sec = 60\ncommand =')}`;
    const after = edited(before);
    assert.equal(after.split('\n').filter((line) => line.startsWith('tool_timeout_sec')).join('|'), 'tool_timeout_sec = 600');
    assert.deepEqual(setToolTimeout(after, 600), { ok: true, text: after, changed: false });
  });

  it('다른 서버의 tool_timeout_sec 은 건드리지 않는다', () => {
    assert.ok(edited(`${OTHERS}\n${OWN}`).includes('command = "other"\ntool_timeout_sec = 450'));
  });

  it('따옴표로 적은 표 이름과 뒤에 주석이 붙은 머리줄도 찾는다', () => {
    for (const header of ['[mcp_servers."agent-chat"]', "[ mcp_servers . 'agent-chat' ]  # 설치가 넣음"]) {
      const lines = edited(OWN.replace('[mcp_servers.agent-chat]', header)).split('\n');
      assert.equal(lines[lines.indexOf(header) + 1], 'tool_timeout_sec = 600', header);
    }
  });

  it('CRLF 줄 끝을 지킨다', () => {
    const result = edited(OWN.replaceAll('\n', '\r\n'));
    assert.ok(result.includes('[mcp_servers.agent-chat]\r\ntool_timeout_sec = 600\r\ncommand'));
    assert.equal(result.replaceAll('\r\n', '').includes('\n'), false);
  });

  it('여러 줄 문자열과 여러 줄 배열 안의 글은 표 머리줄로 보지 않는다', () => {
    const tricky = [
      'note = """',
      '[mcp_servers.agent-chat]',
      'tool_timeout_sec = 1',
      '"""',
      'list = [',
      '  "[mcp_servers.agent-chat]",',
      '  [1, 2],',
      ']',
      "literal = '''",
      '[mcp_servers.agent-chat]',
      "'''",
      'path = "C:\\\\dir\\\\" # [mcp_servers.agent-chat]',
      '',
    ].join('\n');
    assert.deepEqual(setToolTimeout(tricky, 600), { ok: false, reason: '[mcp_servers.agent-chat] table not found' });
    const lines = edited(`${tricky}${OWN}`).split('\n');
    assert.equal(lines.filter((line) => line === 'tool_timeout_sec = 600').length, 1);
    assert.equal(lines[lines.lastIndexOf('[mcp_servers.agent-chat]') + 1], 'tool_timeout_sec = 600');
    assert.equal(lines[2], 'tool_timeout_sec = 1');
  });

  it('표가 없거나, 다른 꼴로 적혔거나, 두 번 나오면 손대지 않고 실패한다', () => {
    const cases = [
      OTHERS,
      '',
      '[mcp_servers]\nagent-chat = { command = "node", args = [] }\n',
      'mcp_servers.agent-chat.command = "node"\n',
      '[[mcp_servers.agent-chat]]\ncommand = "node"\n',
      '[mcp_servers.agent-chat.env]\nA = "1"\n',
      `${OWN}\n${OWN}`,
    ];
    for (const text of cases) assert.equal(setToolTimeout(text, 600).ok, false, text);
  });

  it('승인 모드 키를 넣지 않는다', () => {
    assert.doesNotMatch(edited(OWN), /approval|enabled_tools|disabled_tools|sandbox|trust/);
  });
});

describe('codex-config: 파일 고치기', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-codexcfg-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const NOW = Date.parse('2026-11-15T03:04:05.678Z');

  function setup(name: string, content: string): { configPath: string; backupDir: string } {
    const dir = join(root, name, 'codex home');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, content, { mode: 0o640 });
    return { configPath, backupDir: join(root, name, 'agent chat home', 'backups') };
  }

  it('백업한 뒤 고치고, 파일 권한을 지킨다', () => {
    const original = `${OTHERS}\n${OWN}`;
    const { configPath, backupDir } = setup('ok', original);
    const result = applyToolTimeout({ configPath, backupDir, seconds: 600, now: () => NOW });
    assert.equal(result.ok, true);
    const backupPath = (result as { backupPath: string }).backupPath;
    assert.equal(backupPath, join(backupDir, 'codex-config-20261115T030405Z.toml'));
    assert.equal(readFileSync(backupPath, 'utf8'), original);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    assert.equal(statSync(backupDir).mode & 0o777, 0o700);
    assert.equal(readFileSync(configPath, 'utf8'), edited(original));
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    // 임시 파일이 남지 않는다.
    assert.deepEqual(readdirSync(join(configPath, '..')), ['config.toml']);
  });

  it('restore 는 고치기 전 내용으로 되돌린다', () => {
    const original = OWN;
    const { configPath, backupDir } = setup('restore', original);
    const result = applyToolTimeout({ configPath, backupDir, seconds: 600, now: () => NOW });
    assert.equal(result.ok, true);
    (result as { restore(): void }).restore();
    assert.equal(readFileSync(configPath, 'utf8'), original);
  });

  it('이미 들어 있으면 백업도 쓰기도 하지 않는다', () => {
    const { configPath, backupDir } = setup('same', edited(OWN));
    const result = applyToolTimeout({ configPath, backupDir, seconds: 600, now: () => NOW });
    assert.deepEqual({ ok: result.ok, changed: (result as { changed: boolean }).changed }, { ok: true, changed: false });
    assert.equal(existsSync(backupDir), false);
  });

  it('같은 시각의 백업이 있으면 덮어쓰지 않고 다른 이름으로 둔다', () => {
    const { configPath, backupDir } = setup('twice', OWN);
    assert.equal(applyToolTimeout({ configPath, backupDir, seconds: 600, now: () => NOW }).ok, true);
    writeFileSync(configPath, OWN);
    const second = applyToolTimeout({ configPath, backupDir, seconds: 600, now: () => NOW });
    assert.equal((second as { backupPath: string }).backupPath, join(backupDir, 'codex-config-20261115T030405Z-2.toml'));
    assert.equal(readdirSync(backupDir).length, 2);
  });

  it('표가 없거나 파일이 없으면 아무 것도 쓰지 않고 실패한다', () => {
    const { configPath, backupDir } = setup('missing-table', OTHERS);
    assert.equal(applyToolTimeout({ configPath, backupDir, seconds: 600, now: () => NOW }).ok, false);
    assert.equal(readFileSync(configPath, 'utf8'), OTHERS);
    assert.equal(existsSync(backupDir), false);
    const absent = applyToolTimeout({ configPath: join(root, 'nope', 'config.toml'), backupDir, seconds: 600, now: () => NOW });
    assert.equal(absent.ok, false);
    assert.equal(existsSync(backupDir), false);
  });

  it('설정 파일이 링크면 링크는 두고 가리키는 파일을 고친다', () => {
    const { configPath, backupDir } = setup('link', OWN);
    const link = join(root, 'link', 'config-link.toml');
    symlinkSync(configPath, link);
    assert.equal(applyToolTimeout({ configPath: link, backupDir, seconds: 600, now: () => NOW }).ok, true);
    assert.equal(readFileSync(configPath, 'utf8'), edited(OWN));
    assert.equal(readFileSync(link, 'utf8'), edited(OWN));
  });
});

describe('codex-config: 사용자가 더한 키 읽기 (검토 1차 BOUNDARY-R1-01)', () => {
  it('설치가 만든 표에는 사용자 키가 없다. 다른 서버의 키는 보지 않는다', () => {
    assert.deepEqual(userKeysInTable(`${OTHERS}\n${OWN}`), { ok: true, keys: [], defined: true });
    assert.deepEqual(userKeysInTable(edited(OWN)), { ok: true, keys: [], defined: true });
    assert.deepEqual(userKeysInTable(OTHERS), { ok: true, keys: [], defined: false }, '표가 없으면 빈 목록이고 정의를 찾지 못했다');
    assert.deepEqual(userKeysInTable('[mcp_servers.agent-chat]\ncommand = "n"\nenv = { A = "1" }\n'), { ok: true, keys: [], defined: true }, '한 줄 env');
  });

  it('승인 모드·도구 제한·시작 기한 같은 키와 하위 표를 찾는다', () => {
    const text = [
      OTHERS,
      '[mcp_servers.agent-chat]',
      'command = "/opt/homebrew/Cellar/node/26.11.0/bin/node"',
      'args = ["/x/dist/entry/mcp.js"]',
      'disabled_tools = [',
      '  "create_room",',
      '  "join_room",',
      ']',
      'default_tools_approval_mode = "prompt" # 매번 묻는다',
      '"startup_timeout_sec" = 30',
      'tools.get_status.approval_mode = "approve"',
      '',
      '[mcp_servers.agent-chat.env]',
      'AGENT_CHAT_CLIENT = "codex"',
      '',
      '[mcp_servers.agent-chat.tools.create_room]',
      'approval_mode = "prompt"',
      '',
      '[mcp_servers.after]',
      'enabled = false',
    ].join('\n');
    const result = userKeysInTable(text);
    assert.equal(result.ok, true);
    assert.deepEqual([...(result as { keys: readonly string[] }).keys].sort(), ['default_tools_approval_mode', 'disabled_tools', 'startup_timeout_sec', 'tools']);
  });

  it('여러 줄 값 안의 글은 키로 보지 않는다. 표가 두 번 나오면 실패한다', () => {
    const tricky = ['[mcp_servers.agent-chat]', 'command = "n"', 'args = [', '  "enabled = false",', ']', 'description = """', 'cwd = "/x"', '"""', ''].join('\n');
    assert.deepEqual(userKeysInTable(tricky), { ok: true, keys: ['description'], defined: true });
    assert.equal(userKeysInTable(`${OWN}\n${OWN}`).ok, false);
  });
});

describe('codex-config: 표준 머리줄이 아닌 표기 (검토 2차 BOUNDARY-R2-01)', () => {
  const keysOf = (text: string): { keys: string[]; defined: boolean } => {
    const result = userKeysInTable(text);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    const ok = result as { keys: readonly string[]; defined: boolean };
    return { keys: [...ok.keys].sort(), defined: ok.defined };
  };

  it('(ch1) [mcp_servers] 표 안의 인라인 표 agent-chat = { ... }', () => {
    const text = [
      OTHERS,
      '[mcp_servers]',
      'agent-chat = { command = "/old/node", args = ["/x/mcp.js"], default_tools_approval_mode = "prompt", env = { AGENT_CHAT_NAME = "codex-keep" } }',
      '',
    ].join('\n');
    assert.deepEqual(keysOf(text), { keys: ['default_tools_approval_mode'], defined: true });
  });

  it('(ch2) [mcp_servers] 표 안의 점 키 agent-chat.<키>', () => {
    const text = [
      '[mcp_servers]',
      'agent-chat.command = "/old/node"',
      'agent-chat.args = ["/x/mcp.js"]',
      'agent-chat.default_tools_approval_mode = "prompt"',
      'agent-chat.tools.send_message.approval_mode = "prompt"',
      'agent-chat.env.AGENT_CHAT_NAME = "codex-keep"',
      '',
      OTHERS,
    ].join('\n');
    assert.deepEqual(keysOf(text), { keys: ['default_tools_approval_mode', 'tools'], defined: true });
  });

  it('(ch3) 최상위 점 키 mcp_servers.agent-chat.<키>', () => {
    const text = [
      'mcp_servers.agent-chat.command = "/old/node"',
      'mcp_servers.agent-chat.args = ["/x/mcp.js"]',
      'mcp_servers.agent-chat.default_tools_approval_mode = "prompt"',
      '',
      OTHERS,
    ].join('\n');
    assert.deepEqual(keysOf(text), { keys: ['default_tools_approval_mode'], defined: true });
  });

  it('따옴표 이름, 최상위 인라인 표, 중첩 인라인 표, 점 키를 쓴 하위 표 머리줄도 읽는다', () => {
    assert.deepEqual(keysOf('[mcp_servers]\n"agent-chat".disabled_tools = ["send_message"]\n'), { keys: ['disabled_tools'], defined: true });
    assert.deepEqual(keysOf("[mcp_servers]\n'agent-chat' = { command = 'n', enabled = false }\n"), { keys: ['enabled'], defined: true });
    assert.deepEqual(
      keysOf('mcp_servers = { "agent-chat" = { command = "n", tools = { send_message = { approval_mode = "prompt" } } }, other = { command = "o", enabled_tools = ["x"] } }\n'),
      { keys: ['tools'], defined: true },
    );
    assert.deepEqual(keysOf('[mcp_servers.agent-chat.tools]\nsend_message = { approval_mode = "prompt" }\n'), { keys: ['tools'], defined: true });
    assert.deepEqual(keysOf('[ mcp_servers . "agent-chat" ]\ncommand = "n"\nstartup_timeout_sec = 5\n'), { keys: ['startup_timeout_sec'], defined: true });
  });

  it('설치가 정하는 키(command, args, env, tool_timeout_sec)만 있으면 빈 목록이다. 정의는 찾았다', () => {
    const inline = '[mcp_servers]\nagent-chat = { command = "/old/node", args = ["/x"], env = { MY_TOKEN = "s" }, tool_timeout_sec = 600 }\n';
    assert.deepEqual(keysOf(inline), { keys: [], defined: true });
    assert.deepEqual(keysOf('mcp_servers.agent-chat.command = "n"\nmcp_servers.agent-chat.env.A = "1"\n'), { keys: [], defined: true });
  });

  it('다른 서버의 같은 꼴은 보지 않는다. 문자열과 주석 안의 글은 구조로 보지 않는다', () => {
    assert.deepEqual(keysOf('[mcp_servers]\nother = { default_tools_approval_mode = "prompt" }\nagent-chat-old.enabled = false\n'), { keys: [], defined: false });
    const strings = [
      'note = "mcp_servers.agent-chat.enabled = false"  # agent-chat = { enabled = false }',
      "path = 'C:\\x\\[mcp_servers.agent-chat]'",
      '[mcp_servers]',
      'agent-chat = { command = "a = { b } [c] # d", args = [ "}", \'{\', """x""" ], env = { "K = 1" = "v,}" } }',
    ].join('\n');
    assert.deepEqual(keysOf(strings), { keys: [], defined: true });
  });

  it('여러 줄 배열 안의 인라인 표와 주석을 지나간다', () => {
    const text = [
      '[mcp_servers]',
      'agent-chat.args = [',
      '  "/x/mcp.js", # 진입점',
      '  { not = "a key of agent-chat" },',
      ']',
      'agent-chat.enabled_tools = ["get_status"]',
    ].join('\n');
    assert.deepEqual(keysOf(text), { keys: ['enabled_tools'], defined: true });
  });

  it('닫히지 않은 문자열·괄호는 읽지 못한 것으로 실패한다(아는 척 넘어가지 않는다)', () => {
    assert.equal(userKeysInTable('[mcp_servers]\nagent-chat = { command = "n"\n').ok, false);
    assert.equal(userKeysInTable('[mcp_servers.agent-chat]\ncommand = "n\n').ok, false);
  });
});

describe('codex-config: 이스케이프로 적은 큰따옴표 키 (검토 3차 BOUNDARY-R3-01)', () => {
  const keysOf = (text: string): { keys: string[]; defined: boolean } => {
    const result = userKeysInTable(text);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    const ok = result as { keys: readonly string[]; defined: boolean };
    return { keys: [...ok.keys].sort(), defined: ok.defined };
  };

  it('표 이름의 TOML 이스케이프(\\b \\t \\n \\f \\r \\" \\\\ \\uXXXX \\UXXXXXXXX)를 모두 풀어 견준다', () => {
    assert.deepEqual(splitTablePath('mcp_servers."agent\\u002Dchat"'), ['mcp_servers', 'agent-chat']);
    assert.deepEqual(splitTablePath('mcp_servers."agent\\U0000002dchat"'), ['mcp_servers', 'agent-chat']);
    assert.deepEqual(splitTablePath('"\\u0061gent-chat"'), ['agent-chat']);
    assert.deepEqual(splitTablePath('"a\\tb\\nc\\bd\\fe\\rf\\"g\\\\h"'), ['a\tb\nc\bd\fe\rf"g\\h']);
    assert.deepEqual(splitTablePath('"\\U0001F600"'), ['\u{1F600}']);
    // 작은따옴표 키는 이스케이프가 없다. 글자 그대로다.
    assert.deepEqual(splitTablePath("'agent\\u002Dchat'"), ['agent\\u002Dchat']);
    // TOML 에 없는 이스케이프, 모자란 자릿수, 유니코드 스칼라 값이 아닌 것은 읽지 못한 것이다.
    for (const bad of ['"a\\xb"', '"a\\u12"', '"a\\uD800"', '"a\\U00110000"', '"a\\ "']) assert.equal(splitTablePath(bad), null, bad);
  });

  it('머리줄만 이스케이프로 적은 정의(실제 Codex 가 agent-chat 으로 읽는 꼴)에서 승인 모드와 도구별 승인을 찾는다', () => {
    // 검토자가 실제 Codex 0.169.0 에 넣은 설정 그대로다. 파일에 "agent-chat" 이라는 글자가 없다.
    const text = [
      '[mcp_servers."agent\\u002Dchat"]',
      'command = "node"',
      'args = ["x.js"]',
      'default_tools_approval_mode = "approve"',
      '[mcp_servers."agent\\u002Dchat".tools.room_send]',
      'approval_mode = "prompt"',
      '',
    ].join('\n');
    assert.equal(text.includes('agent-chat'), false);
    assert.deepEqual(keysOf(text), { keys: ['default_tools_approval_mode', 'tools'], defined: true });
  });

  it('이스케이프 키와 표준 표기를 섞어도 하위 표를 놓치지 않는다', () => {
    const mixed = '[mcp_servers."agent\\u002Dchat".tools.x]\napproval_mode = "approve"\n[mcp_servers.agent-chat]\ncommand = "node"\n';
    assert.deepEqual(keysOf(mixed), { keys: ['tools'], defined: true });
    assert.deepEqual(keysOf('[mcp_servers]\n"agent\\u002dchat".default_tools_approval_mode = "approve"\n'), { keys: ['default_tools_approval_mode'], defined: true });
    assert.deepEqual(keysOf('mcp_servers = { "agent\\U0000002Dchat" = { command = "n", enabled = false } }\n'), { keys: ['enabled'], defined: true });
    // 정의가 이스케이프 머리줄 하나와 표준 머리줄 하나로 두 번 나오면 같은 표가 두 번이다.
    assert.equal(userKeysInTable('[mcp_servers."agent\\u002Dchat"]\ncommand = "a"\n[mcp_servers.agent-chat]\nargs = []\n').ok, false);
  });

  it('키에 TOML 에 없는 이스케이프가 있으면 읽지 못한 것으로 실패한다', () => {
    assert.equal(userKeysInTable('[mcp_servers."agent\\xchat"]\ncommand = "n"\n').ok, false);
    assert.equal(userKeysInTable('[mcp_servers]\n"agent\\u002".command = "n"\n').ok, false);
  });

  it('이스케이프로 적은 표 머리줄에도 tool_timeout_sec 을 넣는다', () => {
    const text = '[mcp_servers."agent\\u002Dchat"]\ncommand = "node"\n';
    assert.equal(edited(text), '[mcp_servers."agent\\u002Dchat"]\ntool_timeout_sec = 600\ncommand = "node"\n');
  });
});

describe('codex-config: 작업 폴더에서 Codex 가 읽는 프로젝트 설정 (검토 3차 BOUNDARY-R3-02)', () => {
  it('git 저장소 안이면 저장소 뿌리부터 작업 폴더까지, 밖이면 작업 폴더 하나다. 뿌리 위는 보지 않는다', () => {
    const repo = join('/w', 'repo');
    const has = (path: string): boolean => path === join(repo, '.git');
    const config = (dir: string): string => join(dir, '.codex', 'config.toml');
    assert.deepEqual(projectConfigPaths(join(repo, 'a', 'b'), has), [config(repo), config(join(repo, 'a')), config(join(repo, 'a', 'b'))]);
    assert.deepEqual(projectConfigPaths(repo, has), [config(repo)]);
    assert.deepEqual(projectConfigPaths(join('/w', 'other', 'x'), has), [config(join('/w', 'other', 'x'))]);
    assert.deepEqual(projectConfigPaths('/', () => false), [config('/')]);
  });
});

describe('codex-config: 바꾸기 전 백업과 정리 (검토 1차 BOUNDARY-R1-01, R1-03)', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-codexbak-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  let tick = Date.parse('2026-11-15T03:04:05.000Z');
  const now = (): number => tick;

  it('설정 파일 전체를 0600 으로 백업한다. 파일이 없으면 아무 것도 쓰지 않는다', () => {
    const dir = join(root, 'one');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.toml');
    const backupDir = join(dir, 'backups');
    assert.deepEqual(backupCodexConfig({ configPath, backupDir, now }), { ok: true, backupPath: null });
    assert.equal(existsSync(backupDir), false);
    writeFileSync(configPath, `${OTHERS}\n${OWN}`);
    const result = backupCodexConfig({ configPath, backupDir, now });
    assert.equal(result.ok, true);
    const backupPath = (result as { backupPath: string }).backupPath;
    assert.equal(readFileSync(backupPath, 'utf8'), `${OTHERS}\n${OWN}`);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  });

  it(`백업은 가장 오래된 하나와 최근 ${BACKUP_KEEP}개만 남긴다. 설치가 만든 이름이 아닌 파일은 건드리지 않는다`, () => {
    const dir = join(root, 'many');
    mkdirSync(join(dir, 'backups'), { recursive: true });
    const configPath = join(dir, 'config.toml');
    const backupDir = join(dir, 'backups');
    writeFileSync(join(backupDir, 'mine.toml'), 'user file');
    const made: string[] = [];
    for (let index = 0; index < BACKUP_KEEP + 3; index += 1) {
      tick += 1_000;
      writeFileSync(configPath, `version ${index}`);
      const result = backupCodexConfig({ configPath, backupDir, now });
      const path = (result as { backupPath: string }).backupPath;
      // 수정 시각을 만든 순서대로 둔다(같은 ms 에 여럿을 만들 수 있다).
      utimesSync(path, tick / 1000, tick / 1000);
      made.push(path);
    }
    const left = readdirSync(backupDir).sort();
    assert.equal(left.length, BACKUP_KEEP + 2);
    assert.ok(left.includes('mine.toml'));
    // 처음 것(원래 파일)은 남는다. Codex CLI 가 다른 서버 표의 표기까지 다시 쓰므로 원래 표기는 이것에만 있다.
    assert.equal(readFileSync(made[0] as string, 'utf8'), 'version 0');
    for (const path of made.slice(-BACKUP_KEEP)) assert.equal(existsSync(path), true, path);
    for (const path of made.slice(1, -BACKUP_KEEP)) assert.equal(existsSync(path), false, path);
  });

  it('가장 오래된 백업은 회전으로 지우지 않는다. 그보다 새 것만 최근 순으로 줄인다', () => {
    const dir = join(root, 'oldest');
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const configPath = join(dir, 'config.toml');
    // 이미 회전된 설치(처음 것이 이미 지워진 뒤): 남은 것 가운데 가장 오래된 것을 남긴다.
    const made: string[] = [];
    for (let index = 0; index < 2 * BACKUP_KEEP + 2; index += 1) {
      tick += 1_000;
      writeFileSync(configPath, `round ${index}`);
      const path = (backupCodexConfig({ configPath, backupDir, now }) as { backupPath: string }).backupPath;
      utimesSync(path, tick / 1000, tick / 1000);
      made.push(path);
      const kept = readdirSync(backupDir).length;
      assert.equal(kept, Math.min(index + 1, BACKUP_KEEP + 1), `${index + 1}번째 백업 뒤 ${kept}개`);
      assert.equal(existsSync(made[0] as string), true, '처음 백업을 지웠다');
    }
  });

  it('applyToolTimeout 에 backupDir 을 주지 않으면 백업하지 않는다(부른 쪽이 이미 떴다)', () => {
    const dir = join(root, 'nobackup');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, OWN);
    const result = applyToolTimeout({ configPath, backupDir: null, seconds: 600, now });
    assert.equal(result.ok, true);
    assert.equal((result as { backupPath: string | null }).backupPath, null);
    assert.deepEqual(readdirSync(dir), ['config.toml']);
    assert.equal(readFileSync(configPath, 'utf8'), edited(OWN));
  });
});
