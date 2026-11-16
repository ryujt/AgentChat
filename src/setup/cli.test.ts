// `agent-chat` CLI 의 인자 해석과, 설치기가 읽는 환경 변수 (architecture.md 3.13).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCliArgs, runCli, type CliDeps } from './cli.js';
import { chooseNodePath, readInstallerEnv, registeredNodePath, transientNodeRoots } from './installer-env.js';
import { createFakeHost, createFakeHub, createMemoryLog, realTimers } from './testing.js';

describe('cli: 인자', () => {
  it('setup 은 --client 와 --remove 를 받는다. --client 를 생략하면 all 이다', () => {
    assert.deepEqual(parseCliArgs(['setup']), { kind: 'setup', clients: ['claude', 'codex'], remove: false });
    assert.deepEqual(parseCliArgs(['setup', '--client', 'all']), { kind: 'setup', clients: ['claude', 'codex'], remove: false });
    assert.deepEqual(parseCliArgs(['setup', '--client', 'claude']), { kind: 'setup', clients: ['claude'], remove: false });
    assert.deepEqual(parseCliArgs(['setup', '--remove', '--client', 'codex']), { kind: 'setup', clients: ['codex'], remove: true });
  });

  it('doctor 는 --server 를 받는다', () => {
    assert.deepEqual(parseCliArgs(['doctor']), { kind: 'doctor', server: null });
    assert.deepEqual(parseCliArgs(['doctor', '--server', 'ws://127.0.0.1:8787']), { kind: 'doctor', server: 'ws://127.0.0.1:8787' });
  });

  it('틀린 인자는 거절한다', () => {
    const invalid = [[], ['install'], ['setup', '--client'], ['setup', '--client', 'cursor'], ['setup', '--force'], ['doctor', '--server'], ['doctor', 'extra'], ['setup', 'doctor']];
    for (const argv of invalid) assert.equal(parseCliArgs(argv).kind, 'invalid', argv.join(' '));
    assert.equal(parseCliArgs(['--help']).kind, 'help');
  });
});

describe('cli: 설치기 환경 변수', () => {
  it('기본값을 쓴다', () => {
    assert.deepEqual(readInstallerEnv({}, '/home/u', '/work'), {
      home: '/home/u/.agent-chat',
      homeIsDefault: true,
      bins: { claude: { value: 'claude', explicit: false }, codex: { value: 'codex', explicit: false } },
      server: null,
      providerFlags: [],
      codexConfigPath: '/home/u/.codex/config.toml',
      cwd: '/work',
    });
  });

  it('AGENT_CHAT_HOME 이 기본값과 같은 곳이면(끝의 / 나 상대 경로로 줘도) 기본값으로 본다', () => {
    assert.equal(readInstallerEnv({ AGENT_CHAT_HOME: '/home/u/.agent-chat/' }, '/home/u', '/work').homeIsDefault, true);
    assert.equal(readInstallerEnv({ AGENT_CHAT_HOME: '../home/u/.agent-chat' }, '/home/u', '/work').homeIsDefault, true);
    assert.equal(readInstallerEnv({ AGENT_CHAT_HOME: '/home/u/.agent-chat-2' }, '/home/u', '/work').homeIsDefault, false);
  });

  it('준 값을 쓴다. 빈 값은 없는 것으로 본다', () => {
    const env = readInstallerEnv(
      {
        AGENT_CHAT_HOME: 'relative home',
        AGENT_CHAT_CLAUDE_BIN: '/opt/claude bin/claude',
        AGENT_CHAT_CODEX_BIN: ' ',
        AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_USE_BEDROCK: '',
        CODEX_HOME: '/custom/codex',
      },
      '/home/u',
      '/work',
    );
    assert.deepEqual(env, {
      home: '/work/relative home',
      homeIsDefault: false,
      bins: { claude: { value: '/opt/claude bin/claude', explicit: true }, codex: { value: 'codex', explicit: false } },
      server: 'ws://127.0.0.1:8787',
      providerFlags: ['CLAUDE_CODE_USE_VERTEX'],
      codexConfigPath: '/custom/codex/config.toml',
      cwd: '/work',
    });
  });
});

describe('cli: 등록 명령이 될 Node 경로 (검토 1차 BOUNDARY-R1-02)', () => {
  // brew 의 /opt/homebrew/bin/node 는 버전이 박힌 Cellar 경로를 가리키는 링크다. process.execPath 는 링크를 푼 경로다.
  const links: Record<string, string> = {
    '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/26.12.1_1/bin/node',
    '/opt/homebrew/Cellar/node/26.12.1_1/bin/node': '/opt/homebrew/Cellar/node/26.12.1_1/bin/node',
    '/work/tools/node': '/opt/homebrew/Cellar/node/26.12.1_1/bin/node',
    '/usr/local/bin/node': '/usr/local/bin/node',
  };
  const realpath = (path: string): string => {
    const target = links[path];
    if (target === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return target;
  };
  const exec = '/opt/homebrew/Cellar/node/26.12.1_1/bin/node';

  it('셸이 찾은 경로가 지금 실행 중인 Node 와 같은 파일이면 그 경로(링크 그대로)를 쓴다', () => {
    assert.equal(registeredNodePath('/opt/homebrew/bin/node', exec, realpath, '/work'), '/opt/homebrew/bin/node');
  });

  it('상대 경로는 작업 폴더 기준의 절대 경로로 바꾼다', () => {
    assert.equal(registeredNodePath('tools/node', exec, realpath, '/work'), '/work/tools/node');
  });

  it('주지 않았거나, 다른 Node 거나, 풀 수 없으면 process.execPath 를 쓴다', () => {
    assert.equal(registeredNodePath(undefined, exec, realpath, '/work'), exec);
    assert.equal(registeredNodePath(' ', exec, realpath, '/work'), exec);
    assert.equal(registeredNodePath('/usr/local/bin/node', exec, realpath, '/work'), exec, '다른 Node 다(셸이 찾은 것과 실행 중인 것이 다르다)');
    assert.equal(registeredNodePath('/no/such/node', exec, realpath, '/work'), exec);
  });

  describe('(검토 2차 BOUNDARY-R2-02) 셸 세션마다 만드는 일회용 링크', () => {
    const fnmExec = '/home/u/.local/share/fnm/node-versions/v26.12.1/installation/bin/node';
    const fnmLinks: Record<string, string> = {
      '/run/user/1000/fnm_multishells/123_456/bin/node': fnmExec,
      '/Users/u/Library/Caches/fnm_multishells/9_9/bin/node': fnmExec,
      '/var/folders/ab/T/shell-1/bin/node': fnmExec,
      '/run/user/1000/other/bin/node': fnmExec,
      '/var/folders/ab/Tx/bin/node': fnmExec,
      '/home/u/.local/share/fnm/aliases/default/bin/node': fnmExec,
      [fnmExec]: fnmExec,
    };
    const fnmRealpath = (path: string): string => {
      const target = fnmLinks[path];
      if (target === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return target;
    };
    const roots = transientNodeRoots({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/var/folders/ab/T');

    it('임시 폴더와 XDG_RUNTIME_DIR 을 일회용 링크의 뿌리로 본다. 없는 값은 뺀다', () => {
      assert.deepEqual(roots, ['/var/folders/ab/T', '/run/user/1000']);
      assert.deepEqual(transientNodeRoots({}, '/tmp'), ['/tmp']);
      assert.deepEqual(transientNodeRoots({ XDG_RUNTIME_DIR: ' ' }, ''), []);
    });

    it('fnm_multishells 아래, 임시 폴더 아래, XDG_RUNTIME_DIR 아래의 링크는 같은 파일이어도 쓰지 않고 실경로를 쓴다', () => {
      for (const transient of [
        '/run/user/1000/fnm_multishells/123_456/bin/node',
        '/Users/u/Library/Caches/fnm_multishells/9_9/bin/node',
        '/var/folders/ab/T/shell-1/bin/node',
        '/run/user/1000/other/bin/node',
      ]) {
        assert.equal(registeredNodePath(transient, fnmExec, fnmRealpath, '/work', roots), fnmExec, transient);
        const choice = chooseNodePath(transient, fnmExec, fnmRealpath, '/work', roots);
        assert.equal(choice.path, fnmExec);
        assert.match(choice.note ?? '', /지워지는 링크라 쓰지 않았다/, transient);
        assert.ok((choice.note ?? '').includes(transient), '어느 경로를 거른 것인지 알린다');
      }
    });

    it('뿌리와 이름만 비슷한 폴더나 버전 관리 도구의 고정 별칭 링크는 그대로 쓴다', () => {
      assert.equal(registeredNodePath('/var/folders/ab/Tx/bin/node', fnmExec, fnmRealpath, '/work', roots), '/var/folders/ab/Tx/bin/node');
      const alias = '/home/u/.local/share/fnm/aliases/default/bin/node';
      assert.equal(registeredNodePath(alias, fnmExec, fnmRealpath, '/work', roots), alias);
      assert.match(chooseNodePath(alias, fnmExec, fnmRealpath, '/work', roots).note ?? '', /셸이 찾은 링크 그대로.*실경로/);
    });

    it('셸이 찾은 경로가 실경로와 같으면 알릴 것이 없다. 다른 Node 면 그 까닭을 알린다', () => {
      assert.deepEqual(chooseNodePath(fnmExec, fnmExec, fnmRealpath, '/work', roots), { path: fnmExec, note: null });
      assert.deepEqual(chooseNodePath(undefined, fnmExec, fnmRealpath, '/work', roots), { path: fnmExec, note: null });
      assert.match(chooseNodePath('/usr/local/bin/node', exec, realpath, '/work', roots).note ?? '', /다른 파일이라/);
    });
  });
});

describe('cli: 실행', () => {
  function deps(argv: string[], overrides: Partial<CliDeps> = {}): CliDeps & { lines: string[]; errors: string[] } {
    const lines: string[] = [];
    const errors: string[] = [];
    const hub = createFakeHub();
    return {
      argv,
      env: readInstallerEnv({}, '/nonexistent-home', '/'),
      rawEnv: {},
      appRoot: '/nonexistent-app',
      nodePath: '/opt/node',
      nodeVersion: '26.12.1',
      platform: 'darwin',
      now: Date.now,
      timers: realTimers,
      log: createMemoryLog(),
      out: (line) => void lines.push(line),
      err: (line) => void errors.push(line),
      launch: hub.launch,
      makeHostCli: (host) => createFakeHost(host, { version: null }),
      lines,
      errors,
      ...overrides,
    };
  }

  it('틀린 인자는 사용법을 stderr 에 쓰고 종료 코드 1 이다', async () => {
    const run = deps(['setup', '--client', 'cursor']);
    assert.equal(await runCli(run), 1);
    assert.deepEqual(run.lines, []);
    assert.match(run.errors.join('\n'), /사용법:[\s\S]*agent-chat setup[\s\S]*agent-chat doctor/);
  });

  it('--help 는 사용법을 stdout 에 쓰고 종료 코드 0 이다', async () => {
    const run = deps(['--help']);
    assert.equal(await runCli(run), 0);
    assert.match(run.lines.join('\n'), /사용법:/);
    assert.deepEqual(run.errors, []);
  });

  it('doctor 는 빌드 결과가 없으면 D1 에서 실패하고 종료 코드 1 이다', async () => {
    const run = deps(['doctor']);
    assert.equal(await runCli(run), 1);
    assert.match(run.lines.join('\n'), /D1 Node 와 빌드: 실패/);
  });

  it('setup 은 호스트가 없으면 종료 코드 2 다', async () => {
    const run = deps(['setup', '--client', 'claude']);
    assert.equal(await runCli(run), 2);
    assert.match(run.lines.join('\n'), /claude mcp add --scope user agent-chat/);
    assert.doesNotMatch(run.lines.join('\n'), /codex mcp add/);
  });
});
