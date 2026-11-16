// V-L10 (다): 호스트 CLI 로 실행하는 하위 명령이 `--version`, `mcp get`·`add`·`remove`·`list`, `auth status` 뿐이고,
// 그 밖의 인자 묶음은 실행 전에 거절된다 (architecture.md 3.13, mcp-interface.md 10절).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkHostCliArgs, createHostCli } from './host-cli.js';
import { realTimers } from './testing.js';
import type { HostKind } from './types.js';

const NODE = '/opt/node dir/bin/node';
const ENTRY = '/home/user/.agent-chat/app/dist/entry/mcp.js';

const ALLOWED: Readonly<Record<HostKind, readonly (readonly string[])[]>> = {
  claude: [
    ['--version'],
    ['mcp', 'get', 'agent-chat'],
    ['mcp', 'list'],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '-e', 'AGENT_CHAT_CLIENT=claude-code', '-e', 'AGENT_CHAT_NAME=claude-ab12', '--', NODE, ENTRY],
    ['mcp', 'remove', '--scope', 'user', 'agent-chat'],
    ['auth', 'status'],
  ],
  codex: [
    ['--version'],
    ['mcp', 'get', 'agent-chat', '--json'],
    ['mcp', 'list', '--json'],
    ['mcp', 'add', 'agent-chat', '--', NODE, ENTRY],
    ['mcp', 'add', 'agent-chat', '--env', 'AGENT_CHAT_CHANNEL=off', '--env', 'AGENT_CHAT_WAIT_MAX_SEC=540', '--', NODE, ENTRY],
    ['mcp', 'remove', 'agent-chat'],
  ],
};

const REJECTED: Readonly<Record<HostKind, readonly (readonly string[])[]>> = {
  claude: [
    [],
    ['-p', 'join the room and keep waiting'],
    ['--print', 'hello'],
    ['--resume', 'abc'],
    ['--continue'],
    ['--dangerously-skip-permissions'],
    ['--permission-mode', 'bypassPermissions'],
    ['--allowedTools', 'mcp__agent-chat__*'],
    ['--dangerously-load-development-channels', 'server:agent-chat'],
    ['--version', '-p', 'x'],
    ['update'],
    ['install'],
    ['doctor'],
    ['config', 'set', 'x', 'y'],
    ['plugin', 'install', 'x'],
    ['setup-token'],
    ['auth', 'login'],
    ['auth', 'logout'],
    ['auth', 'status', '--text'],
    ['mcp'],
    ['mcp', 'serve'],
    ['mcp', 'add-json', 'agent-chat', '{}'],
    ['mcp', 'add-from-claude-desktop'],
    ['mcp', 'login', 'agent-chat'],
    ['mcp', 'reset-project-choices'],
    ['mcp', 'get', 'other-server'],
    ['mcp', 'get', 'agent-chat', '--json'],
    ['mcp', 'list', '--json'],
    ['mcp', 'remove', 'agent-chat'],
    ['mcp', 'remove', '--scope', 'local', 'agent-chat'],
    ['mcp', 'remove', '--scope', 'user', 'other-server'],
    ['mcp', 'add', 'agent-chat', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'project', 'agent-chat', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'user', 'other-server', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--transport', 'http', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', 'https://example.com/mcp'],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '-e', 'no-equals-sign', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '-e', 'A=1\nB=2', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '-e', '--', NODE, ENTRY],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', 'node', ENTRY],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', NODE, '/home/user/other/server.js'],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', NODE, 'dist/entry/mcp.js'],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', NODE, ENTRY, '--extra'],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', '/bin/sh', '-c', 'claude -p x'],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', NODE],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--env', 'A=1', '--', NODE, ENTRY],
  ],
  codex: [
    [],
    ['exec', 'join the room'],
    ['exec', 'resume', '--last'],
    ['resume'],
    ['queue'],
    ['login'],
    ['logout'],
    ['apply'],
    ['app-server'],
    ['sandbox'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--full-auto'],
    ['--yolo'],
    ['--ask-for-approval', 'never'],
    ['-c', 'approval_policy="never"', 'mcp', 'list', '--json'],
    ['auth', 'status'],
    ['mcp'],
    ['mcp', 'login', 'agent-chat'],
    ['mcp', 'logout', 'agent-chat'],
    ['mcp', 'get', 'agent-chat'],
    ['mcp', 'get', 'other-server', '--json'],
    ['mcp', 'list'],
    ['mcp', 'remove', 'other-server'],
    ['mcp', 'remove', '--scope', 'user', 'agent-chat'],
    ['mcp', 'add', '--scope', 'user', 'agent-chat', '--', NODE, ENTRY],
    ['mcp', 'add', 'other-server', '--', NODE, ENTRY],
    ['mcp', 'add', 'agent-chat', '--url', 'https://example.com/mcp'],
    ['mcp', 'add', 'agent-chat', '-c', 'approval_policy="never"', '--', NODE, ENTRY],
    ['mcp', 'add', 'agent-chat', '-e', 'A=1', '--', NODE, ENTRY],
    ['mcp', 'add', 'agent-chat', '--', NODE, '/home/user/other/server.js'],
    ['mcp', 'add', 'agent-chat', '--', NODE, ENTRY, 'extra'],
    ['mcp', 'add', 'agent-chat', '--', '/bin/sh', '-c', 'codex exec x'],
  ],
};

const HOSTS: readonly HostKind[] = ['claude', 'codex'];

describe('host-cli: 허용하는 하위 명령', () => {
  for (const host of HOSTS) {
    it(`${host}: 허용 목록의 인자 묶음은 통과한다`, () => {
      for (const args of ALLOWED[host]) assert.equal(checkHostCliArgs(host, args), null, args.join(' '));
    });

    it(`${host}: 그 밖의 인자 묶음은 거절한다`, () => {
      for (const args of REJECTED[host]) assert.notEqual(checkHostCliArgs(host, args), null, args.join(' '));
    });

    it(`${host}: 실행하는 첫 두 마디는 --version, mcp get·add·remove·list, auth status 뿐이다`, () => {
      const heads = new Set(ALLOWED[host].map((args) => (args[0] === '--version' ? '--version' : `${args[0]} ${args[1]}`)));
      const expected = host === 'claude' ? ['--version', 'auth status', 'mcp add', 'mcp get', 'mcp list', 'mcp remove'] : ['--version', 'mcp add', 'mcp get', 'mcp list', 'mcp remove'];
      assert.deepEqual([...heads].sort(), expected);
      // 허용 목록에 없는 첫 두 마디로 시작하는 묶음은 어떤 꼬리를 붙여도 거절된다.
      for (const args of REJECTED[host]) {
        const head = args[0] === '--version' ? '--version' : `${args[0]} ${args[1]}`;
        if (!expected.includes(head)) assert.notEqual(checkHostCliArgs(host, [...args, 'agent-chat']), null, args.join(' '));
      }
    });
  }

  it('다른 호스트의 인자 형식은 통하지 않는다', () => {
    for (const args of ALLOWED.claude.filter((entry) => entry[0] !== '--version')) {
      assert.notEqual(checkHostCliArgs('codex', args), null, args.join(' '));
    }
    for (const args of ALLOWED.codex.filter((entry) => entry[0] !== '--version')) {
      assert.notEqual(checkHostCliArgs('claude', args), null, args.join(' '));
    }
  });
});

describe('host-cli: 실행', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-hostcli-'));
  const dir = join(root, 'bin with spaces');
  mkdirSync(dir);
  const log = join(root, 'calls.log');
  const fake = join(dir, 'fake-host');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$FAKE_LOG"; done',
      'printf \'%s\\n\' "seen:$AGENT_CHAT_MARK leak:${AGENT_CHAT_HOSTCLI_LEAK:-none}"',
      'if [ "${FAKE_SLEEP:-}" != "" ]; then exec sleep "$FAKE_SLEEP"; fi',
      'printf \'warn\\n\' >&2',
      'exit "${FAKE_CODE:-0}"',
      '',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
  after(() => rmSync(root, { recursive: true, force: true }));

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env['PATH'] ?? '', FAKE_LOG: log, AGENT_CHAT_MARK: 'given', ...extra });
  const logged = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

  it('거절한 인자 묶음은 프로세스를 띄우지 않는다', async () => {
    rmSync(log, { force: true });
    const cli = createHostCli({ host: 'claude', bin: fake, env: env(), timers: realTimers });
    for (const args of REJECTED.claude) {
      const result = await cli.run(args);
      assert.equal(result.outcome, 'rejected', args.join(' '));
    }
    assert.equal(existsSync(log), false, '거절한 인자로 실행 파일이 불렸다');
  });

  it('허용한 인자를 그대로 넘기고 종료 코드와 출력을 돌려준다', async () => {
    rmSync(log, { force: true });
    const cli = createHostCli({ host: 'claude', bin: fake, env: env(), timers: realTimers });
    const args = ['mcp', 'add', '--scope', 'user', 'agent-chat', '-e', 'AGENT_CHAT_NAME=claude-ab12', '--', NODE, ENTRY];
    const result = await cli.run(args);
    assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome: 'exit', code: 0 });
    assert.equal(result.stdout, 'seen:given leak:none\n');
    assert.equal(result.stderr, 'warn\n');
    // 공백이 든 경로도 한 인자로 간다.
    assert.deepEqual(logged(), args);
  });

  it('0 이 아닌 종료 코드를 그대로 돌려준다', async () => {
    const cli = createHostCli({ host: 'codex', bin: fake, env: env({ FAKE_CODE: '3' }), timers: realTimers });
    const result = await cli.run(['mcp', 'get', 'agent-chat', '--json']);
    assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome: 'exit', code: 3 });
  });

  it('실행 파일이 없으면 not-found, 실행 권한이 없으면 not-executable 이다', async () => {
    const missing = createHostCli({ host: 'claude', bin: join(dir, 'nope'), env: env(), timers: realTimers });
    assert.equal((await missing.run(['--version'])).outcome, 'not-found');
    const plain = join(dir, 'plain-file');
    writeFileSync(plain, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const blocked = createHostCli({ host: 'claude', bin: plain, env: env(), timers: realTimers });
    assert.equal((await blocked.run(['--version'])).outcome, 'not-executable');
  });

  it('기한 안에 끝나지 않으면 프로세스를 끝내고 timeout 을 돌려준다', async () => {
    const cli = createHostCli({ host: 'claude', bin: fake, env: env({ FAKE_SLEEP: '5' }), timers: realTimers, timeoutMs: 200 });
    const startedAt = Date.now();
    const result = await cli.run(['--version']);
    assert.equal(result.outcome, 'timeout');
    assert.ok(Date.now() - startedAt < 3000, '기한 뒤에도 기다렸다');
  });

  it('준 환경만 자식에게 넘긴다', async () => {
    process.env['AGENT_CHAT_HOSTCLI_LEAK'] = 'leak';
    try {
      const cli = createHostCli({ host: 'claude', bin: fake, env: env({ AGENT_CHAT_MARK: 'only-this' }), timers: realTimers });
      assert.equal((await cli.run(['--version'])).stdout, 'seen:only-this leak:none\n');
    } finally {
      delete process.env['AGENT_CHAT_HOSTCLI_LEAK'];
    }
  });
});
