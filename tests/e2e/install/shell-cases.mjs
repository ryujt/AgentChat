// 시험 전용: 셸 진입점 세 개(install.sh, claude.sh, codex.sh)에 똑같이 거는 시험 (V-L10 나).
// installer/*.test.mjs 가 스크립트 이름과 그 스크립트가 다루는 호스트를 넘겨 부른다.
// 설치기를 공백이 든 임시 폴더에 복사하고, 가짜 호스트 CLI 와 임시 HOME 으로 실행한다(fixture.mjs).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { INITIAL, changedPaths, createWorld, formatJson } from './fixture.mjs';

const ALL = ['claude', 'codex'];

function withWorld(options, check) {
  return () => {
    const world = createWorld(options);
    try {
      check(world);
      assert.deepEqual(world.leftoverMcp(), [], 'MCP 프로세스가 남았다');
    } finally {
      world.cleanup();
    }
  };
}

/** 호스트별로 agent-chat 등록이 있는가. */
function registered(world) {
  return {
    claude: 'agent-chat' in world.claudeJson().mcpServers,
    codex: world.codexTomlText().includes('[mcp_servers.agent-chat]'),
  };
}

/** 호스트별 agent-chat 등록의 명령(Node 경로). 등록이 없으면 null. */
function registeredCommands(world) {
  const toml = world.codexTomlText();
  const table = toml.indexOf('[mcp_servers.agent-chat]');
  const command = table < 0 ? null : /^command = (".*")$/m.exec(toml.slice(table));
  return {
    claude: world.claudeJson().mcpServers['agent-chat']?.command ?? null,
    codex: command === null ? null : JSON.parse(command[1]),
  };
}

/** 무작위 이름과 시각이 든 부분을 고정 글로 바꾼 출력. 두 실행의 결과를 견줄 때 쓴다. */
function normalize(world, text) {
  return text
    .replaceAll(world.root, '<root>')
    .replace(/(claude|codex)-[a-z0-9]{4}\b/g, '$1-xxxx')
    .replace(/codex-config-\d{8}T\d{6}Z/g, 'codex-config-<시각>')
    .replace(/doctor-([ab])-[a-z0-9]{4}/g, 'doctor-$1-xxxx');
}

function state(world) {
  return normalize(world, `${world.claudeJsonText()}\n---\n${world.codexTomlText()}`);
}

/**
 * @param {string} script 셸 진입점의 파일 이름.
 * @param {('claude'|'codex')[]} clients 그 스크립트가 다루는 호스트.
 */
export function defineShellTests(script, clients) {
  const others = ALL.filter((host) => !clients.includes(host));
  const expectRegistered = (world, yes) => {
    const now = registered(world);
    for (const host of clients) assert.equal(now[host], yes, `${host} 등록`);
    for (const host of others) assert.equal(now[host], false, `${script} 가 ${host} 를 등록했다`);
  };

  describe(`V-L10 (나) installer/${script}`, () => {
    test(
      `--client ${clients.length === 2 ? 'all' : clients[0]} 의 등록을 만든다. 다시 실행해도 등록이 같다`,
      withWorld({}, (w) => {
        const first = w.shell(script);
        assert.equal(first.status, 0, first.output);
        expectRegistered(w, true);
        // 고르지 않은 호스트의 CLI 는 부르지도 않는다.
        for (const host of others) assert.deepEqual(w.hostCalls(host), []);
        for (const host of clients) assert.ok(w.hostCalls(host).some((call) => call.args[1] === 'add'), `${host} 등록 명령`);
        if (!clients.includes('codex')) assert.equal(w.codexTomlText(), INITIAL.codexToml);
        if (!clients.includes('claude')) assert.equal(w.claudeJsonText(), formatJson(INITIAL.claudeJson));
        // 등록된 명령은 셸이 찾은 Node 와, 스크립트 위치에서 구한 패키지 뿌리의 MCP 진입점이다.
        for (const launch of w.mcpLaunches()) assert.deepEqual([launch.node, launch.script], [w.node, w.mcpEntry]);
        // (검토 1차 BOUNDARY-R1-02) 등록 명령은 셸이 PATH 에서 찾은 경로 그대로다(링크를 풀지 않는다).
        const commands = registeredCommands(w);
        for (const host of clients) assert.equal(commands[host], path.join(w.binDir, 'node'), `${host} 등록 명령`);
        assert.match(first.stdout, /\[10\] 연결 점검: 통과/);

        const before = [w.claudeJsonText(), w.codexTomlText()];
        w.clearHostCalls();
        const second = w.shell(script);
        assert.equal(second.status, 0, second.output);
        assert.deepEqual([w.claudeJsonText(), w.codexTomlText()], before);
        assert.deepEqual(w.hostCalls().filter((call) => call.args[1] === 'add' || call.args[1] === 'remove'), []);
      }),
    );

    test('인자 없음과 --install 의 결과가 같다', () => {
      const results = [[], ['--install']].map((args) => {
        const world = createWorld({});
        try {
          const run = world.shell(script, args);
          assert.equal(run.status, 0, run.output);
          return { stdout: normalize(world, run.stdout), state: state(world), calls: world.hostCalls().map((call) => `${call.host} ${normalize(world, call.args.join(' '))}`), npm: world.npmCalls() };
        } finally {
          world.cleanup();
        }
      });
      assert.deepEqual(results[0], results[1]);
    });

    test(
      '--uninstall 과 -u 뒤에 고른 호스트의 등록이 없다. 다시 제거해도 종료 코드 0 이다',
      withWorld({}, (w) => {
        const homeBefore = w.homeFiles();
        for (const flag of ['--uninstall', '-u']) {
          assert.equal(w.shell(script).status, 0);
          expectRegistered(w, true);
          w.clearHostCalls();
          const npmBefore = w.npmCalls().length;
          const removed = w.shell(script, [flag]);
          assert.equal(removed.status, 0, removed.output);
          expectRegistered(w, false);
          // 설정 파일이 설치 전의 바이트로 돌아왔다. 제거는 빌드도 점검도 하지 않는다.
          assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), []);
          assert.equal(w.npmCalls().length, npmBefore);
          for (const host of others) assert.deepEqual(w.hostCalls(host), []);
          for (const host of clients) assert.ok(w.hostCalls(host).some((call) => call.args[1] === 'remove'), `${host} 제거 명령`);
          assert.equal(existsSync(w.mcpEntry), true, '저장소를 지웠다');
        }
        const again = w.shell(script, ['--uninstall']);
        assert.equal(again.status, 0, again.output);
        assert.match(again.stdout, /등록이 없다/);
      }),
    );

    test(
      '틀린 인자와 둘 이상의 인자는 사용법과 종료 코드 1 이다. 아무 것도 하지 않는다',
      withWorld({}, (w) => {
        const homeBefore = w.homeFiles();
        for (const args of [[''], ['--unknown'], ['--remove'], ['--client'], ['install'], ['--install', 'extra'], ['--uninstall', '--install'], ['-u', '-u'], ['--install', '--install', '--install']]) {
          const result = w.shell(script, args);
          assert.equal(result.status, 1, args.join(' '));
          assert.equal(result.stderr, `사용법: ${script} [--install|--uninstall|-u]\n`, args.join(' '));
          assert.equal(result.stdout, '', args.join(' '));
        }
        assert.deepEqual(w.npmCalls(), []);
        assert.deepEqual(w.hostCalls(), []);
        assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), []);
        assert.equal(existsSync(w.agentHome) && existsSync(path.join(w.agentHome, 'logs')), false);
      }),
    );

    test(
      'Node 가 없거나 22 미만이면 필요한 버전과 찾은 경로를 알리고 종료 코드 1 이다. 임시 홈이 그대로다',
      withWorld({}, (w) => {
        const homeBefore = w.homeFiles();
        const fakes = path.join(w.root, 'fake nodes');
        mkdirSync(fakes);
        const fake = (name, body) => {
          const file = path.join(fakes, name);
          writeFileSync(file, `#!/bin/sh\n${body}\n`);
          chmodSync(file, 0o755);
          return file;
        };
        const old = fake('node18', "printf '18.19.0'");
        const oldPattern = old.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
        const cases = [
          ['AGENT_CHAT_NODE 가 없는 파일', { AGENT_CHAT_NODE: path.join(fakes, 'missing node') }, /missing node 을\(를\) 찾지 못했다\.\n찾은 경로: 없음/],
          ['AGENT_CHAT_NODE 가 22 미만', { AGENT_CHAT_NODE: old }, new RegExp(`찾은 버전은 18\\.19\\.0 이다\\.\\n찾은 경로: ${oldPattern}`)],
          ['AGENT_CHAT_NODE 가 21', { AGENT_CHAT_NODE: fake('node21', "printf '21.7.3'") }, /찾은 버전은 21\.7\.3 이다/],
          ['AGENT_CHAT_NODE 가 실행되지 않음', { AGENT_CHAT_NODE: fake('broken', 'exit 3') }, /Node 를 실행하지 못했다/],
          ['AGENT_CHAT_NODE 가 버전을 내지 않음', { AGENT_CHAT_NODE: fake('silent', "printf 'not-a-version'") }, /버전을 읽지 못했다\(not-a-version\)/],
          ['실행 권한이 없는 파일', { AGENT_CHAT_NODE: (() => { const file = path.join(fakes, 'plain'); writeFileSync(file, '#!/bin/sh\n'); return file; })() }, /찾지 못했다/],
        ];
        // PATH 의 node 가 22 미만인 경우와, PATH 에 node 가 없는 경우.
        const oldPath = path.join(w.root, 'old path');
        mkdirSync(oldPath);
        symlinkSync(old, path.join(oldPath, 'node'));
        cases.push(['PATH 의 node 가 22 미만', { PATH: `${oldPath}:/usr/bin:/bin` }, /찾은 버전은 18\.19\.0 이다/]);
        if (!existsSync('/usr/bin/node') && !existsSync('/bin/node')) {
          cases.push(['PATH 에 node 가 없음', { PATH: '/usr/bin:/bin' }, /node 을\(를\) 찾지 못했다\.\n찾은 경로: 없음/]);
        }
        for (const [name, env, expected] of cases) {
          for (const args of [[], ['--uninstall']]) {
            const result = w.shell(script, args, env);
            assert.equal(result.status, 1, `${name}\n${result.output}`);
            assert.match(result.stderr, /^실패: Node\.js 22 이상이 필요하다\./, name);
            assert.match(result.stderr, expected, name);
            assert.match(result.stderr, /아무 것도 바꾸지 않았다/, name);
            assert.equal(result.stdout, '', `${name}: install.mjs 가 실행됐다`);
          }
        }
        assert.deepEqual(w.npmCalls(), []);
        assert.deepEqual(w.hostCalls(), []);
        assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), []);
        assert.equal(existsSync(path.join(w.agentHome, 'logs')), false);
      }),
    );

    test(
      'AGENT_CHAT_NODE 로 고른 Node 가 MCP 등록의 명령이 된다',
      withWorld({}, (w) => {
        const chosen = path.join(w.root, 'chosen node dir', 'my node');
        mkdirSync(path.dirname(chosen));
        symlinkSync(w.node, chosen);
        // PATH 에는 쓸 수 없는 node 를 둔다. 고른 Node 만 쓰였다는 것을 보려는 것이다.
        const badPath = path.join(w.root, 'bad path');
        mkdirSync(badPath);
        writeFileSync(path.join(badPath, 'node'), "#!/bin/sh\nprintf '18.0.0'\n");
        chmodSync(path.join(badPath, 'node'), 0o755);
        symlinkSync(path.join(w.binDir, 'npm'), path.join(badPath, 'npm'));
        const result = w.shell(script, [], { AGENT_CHAT_NODE: chosen, PATH: `${badPath}:/usr/bin:/bin` });
        assert.equal(result.status, 0, result.output);
        for (const launch of w.mcpLaunches()) assert.equal(launch.node, w.node);
        expectRegistered(w, true);
        // 고른 경로(링크)가 그대로 등록된다. 링크를 푼 실경로가 아니다(검토 1차 BOUNDARY-R1-02).
        const commands = registeredCommands(w);
        for (const host of clients) assert.equal(commands[host], chosen, `${host} 등록 명령`);
      }),
    );

    test(
      '(검토 2차 BOUNDARY-R2-02) 셸 세션마다 만드는 일회용 링크(fnm_multishells)는 등록하지 않고 실경로를 등록한다. 까닭을 단계 8 에 싣는다',
      withWorld({}, (w) => {
        // fnm 은 셸마다 이런 폴더를 PATH 앞에 둔다. 셸이 끝나면 지워진다.
        const shellBin = path.join(w.root, 'fnm cache', 'fnm_multishells', '123_456', 'bin');
        mkdirSync(shellBin, { recursive: true });
        symlinkSync(w.node, path.join(shellBin, 'node'));
        const result = w.shell(script, [], { PATH: `${shellBin}:${w.binDir}:/usr/bin:/bin` });
        assert.equal(result.status, 0, result.output);
        expectRegistered(w, true);
        const commands = registeredCommands(w);
        for (const host of clients) assert.equal(commands[host], w.node, `${host} 등록 명령은 실경로다`);
        assert.match(result.stdout, /\[8\] 등록 확인 \(.+\): 통과 — 명령 .+\. 셸이 찾은 .*fnm_multishells.* 지워지는 링크라 쓰지 않았다/);
      }),
    );

    test(
      'install.mjs 의 종료 코드 1 과 2 가 셸에서 그대로 나온다',
      withWorld({}, (w) => {
        const failed = w.shell(script, [], { FAKE_NPM_FAIL: 'ci' });
        assert.equal(failed.status, 1, failed.output);
        assert.match(failed.stdout, /\[3\] 의존성과 빌드: 실패/);
        // 호스트 CLI 가 하나도 없으면 2 다.
        const none = w.shell(script, [], { AGENT_CHAT_CLAUDE_BIN: undefined, AGENT_CHAT_CODEX_BIN: undefined });
        assert.equal(none.status, 2, none.output);
        assert.match(none.stdout, /\(종료 코드 2\)/);
        expectRegistered(w, false);
      }),
    );

    test(
      '실행한 작업 폴더에 기대지 않는다. 상대 경로로 불러도, 다른 폴더에서 불러도 같은 저장소를 등록한다',
      withWorld({}, (w) => {
        const relative = w.exec('/bin/sh', [`installer/${script}`], {}, w.app);
        assert.equal(relative.status, 0, relative.output);
        const elsewhere = path.join(w.root, 'some other dir');
        mkdirSync(elsewhere);
        const far = w.exec('/bin/sh', [path.join('..', path.relative(w.root, w.app), 'installer', script)], {}, elsewhere);
        assert.equal(far.status, 0, far.output);
        assert.match(far.stdout, /MCP 등록 \([^)]+\): 건너뜀 — 이미 등록됨/);
        for (const launch of w.mcpLaunches()) assert.equal(launch.script, w.mcpEntry);
      }),
    );

    if (existsSync('/bin/dash')) {
      test(
        'bash 가 아닌 POSIX sh(dash)에서도 돈다',
        withWorld({}, (w) => {
          const installed = w.exec('/bin/dash', [path.join(w.app, 'installer', script)]);
          assert.equal(installed.status, 0, installed.output);
          expectRegistered(w, true);
          assert.equal(w.exec('/bin/dash', [path.join(w.app, 'installer', script), '-u']).status, 0);
          expectRegistered(w, false);
          assert.equal(w.exec('/bin/dash', [path.join(w.app, 'installer', script), '--bad']).status, 1);
          const missing = w.exec('/bin/dash', [path.join(w.app, 'installer', script)], { AGENT_CHAT_NODE: path.join(w.root, 'no node') });
          assert.equal(missing.status, 1);
          assert.match(missing.stderr, /^실패: Node\.js 22 이상이 필요하다\./);
        }),
      );
    }
  });
}
