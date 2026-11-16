// V-S1·V-S2 를 실행하는 스크립트(v-s1.mjs, v-s2.mjs) 자체의 시험. 대역 수준이다.
// 임시 홈과 가짜 호스트 CLI 로 스크립트를 끝까지 돌려, 실제 홈에서 실행했을 때 스크립트의 결함으로 멈추지 않게 한다.
// 실제 홈에서의 V-S1·V-S2 는 이 시험이 아니다(총괄이 따로 실행한다).
//
// 실행: 빌드한 뒤 `node --test tests/e2e/install/` (묶음별 빌드 폴더를 쓰면 AGENT_CHAT_DIST=<폴더>).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, distRoot } from '../../support/proc.mjs';
import { INITIAL, changedPaths, createWorld, formatJson } from './fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V_S1 = path.join(HERE, 'v-s1.mjs');
const V_S2 = path.join(HERE, 'v-s2.mjs');

/**
 * v-s1.mjs 는 작업 트리를 dist 없이 복사한다. 그래서 여기서는 가짜 npm 이 빌드 결과를 채운다:
 * `npm ci` 는 node_modules 를 링크하고, `npm run build` 는 미리 만든 빌드 결과와 가짜 MCP 서버를 넣는다.
 */
function useBuildingNpm(world) {
  const dist = distRoot();
  writeFileSync(
    path.join(world.binDir, 'npm'),
    [
      '#!/bin/sh',
      'set -eu',
      'printf \'%s\\n\' "$*" >> "$FAKE_NPM_LOG"',
      'case "$1" in',
      `  ci) [ -e node_modules ] || ln -s "${path.join(REPO_ROOT, 'node_modules')}" node_modules`,
      '      if [ "${FAKE_NPM_TAMPER:-}" = "1" ]; then printf \'{"permissions":{"allow":["Bash(*)"]}}\\n\' > "$HOME/.claude/settings.json"; fi ;;',
      `  run) mkdir -p dist/entry && cp -R "${dist}/setup" "${dist}/protocol" "${dist}/diagnostics" dist/`,
      `       cp "${dist}/entry/cli.js" dist/entry/cli.js && cp "${path.join(HERE, 'fake-mcp-server.mjs')}" dist/entry/mcp.js ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(path.join(world.binDir, 'npm'), 0o755);
}

function withWorld(options, check) {
  return () => {
    const world = createWorld(options);
    try {
      useBuildingNpm(world);
      check(world);
      assert.deepEqual(world.leftoverMcp(), [], 'MCP 프로세스가 남았다');
    } finally {
      world.cleanup();
    }
  };
}

describe('V-S1·V-S2 실행 스크립트 (대역)', () => {
  test(
    'v-s1.mjs: 확인 플래그가 없으면 아무 것도 하지 않는다',
    withWorld({}, (w) => {
      const homeBefore = w.homeFiles();
      for (const args of [[], ['--replace-app'], ['--yes', '--extra']]) {
        const result = w.exec(process.execPath, [V_S1, ...args]);
        assert.equal(result.status, 2, result.output);
        assert.match(result.stderr, /실행하지 않았다/);
      }
      // 설치 위치에 이 스크립트가 만들지 않은 폴더가 있으면 지우지 않는다.
      const kept = w.exec(process.execPath, [V_S1, '--yes']);
      assert.equal(kept.status, 2, kept.output);
      assert.match(kept.stderr, /--replace-app/);
      assert.equal(existsSync(w.mcpEntry), true);
      assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), []);
      assert.deepEqual(w.hostCalls().filter((call) => call.args[0] === 'mcp'), []);
    }),
  );

  test(
    'v-s1.mjs 가 설치·재설치·제거·재설치를 하고 전후를 비교한다. 이어서 v-s2.mjs 가 그 등록으로 통신한다',
    withWorld({}, (w) => {
      const s1 = w.exec(process.execPath, [V_S1, '--yes', '--replace-app']);
      assert.equal(s1.status, 0, s1.output);
      for (const id of ['S1-01', 'S1-02 (claude)', 'S1-02 (codex)', 'S1-03', 'S1-04', 'S1-05', 'S1-06', 'S1-07', 'S1-08', 'S1-09', 'S1-10']) {
        assert.ok(new RegExp(`^${id.replace(/[()]/g, '\\$&')} [^\\n]*: 통과`, 'm').test(s1.stdout), `${id}\n${s1.stdout}`);
      }
      assert.match(s1.stdout, /V-S1 결과: 11\/11 통과/);
      // 작업 트리를 복사했다. .git, node_modules(링크는 가짜 npm 이 만든 것), dist 는 복사하지 않았다.
      assert.equal(existsSync(path.join(w.app, 'installer', 'install.sh')), true);
      assert.equal(existsSync(path.join(w.app, 'src', 'setup', 'index.ts')), true);
      assert.equal(existsSync(path.join(w.app, '.git')), false);
      assert.equal(existsSync(path.join(w.app, '.work')), false);
      assert.equal(existsSync(path.join(w.app, '.v-s1-copy')), true);
      // 사용자가 쓰는 길 그대로 셸 진입점으로 네 번 실행했다(설치, 재설치, 제거, 재설치).
      assert.deepEqual(w.npmCalls(), ['ci', 'run build', 'ci', 'run build', 'ci', 'run build']);
      // 끝난 뒤에는 설치된 채다. 사본은 지웠고, 출력에 다른 서버의 값이 없다.
      assert.ok('agent-chat' in w.claudeJson().mcpServers);
      assert.match(w.codexTomlText(), /\[mcp_servers\.agent-chat\]\ntool_timeout_sec = 600/);
      assert.equal(s1.output.includes('do-not-print-this'), false);
      const snapshots = /사본을|agent-chat-v-s1-/.test(s1.output);
      assert.equal(snapshots, false);

      // 두 번째 실행은 --replace-app 없이도 된다(이 스크립트가 만든 폴더다).
      w.clearMcp();
      const s2 = w.exec(process.execPath, [V_S2]);
      assert.equal(s2.status, 0, s2.output);
      assert.match(s2.stdout, /V-S2 결과: 9\/9 통과/);
      // 등록된 명령과 환경 그대로 띄웠다. doctor 도 같은 등록으로 둘을 더 띄웠다.
      const launches = w.mcpLaunches();
      assert.equal(launches.length, 4);
      assert.deepEqual(launches.slice(0, 2).map((launch) => [launch.script, launch.env.AGENT_CHAT_CLIENT, launch.env.AGENT_CHAT_WAIT_MAX_SEC]), [
        [path.join(w.app, 'dist', 'entry', 'mcp.js'), 'claude-code', '100'],
        [path.join(w.app, 'dist', 'entry', 'mcp.js'), 'codex', '540'],
      ]);
      // server 를 생략했다.
      const calls = w.mcpCalls();
      assert.deepEqual(Object.keys(calls.find((call) => call.name === 'create_room').args), ['name']);
      assert.deepEqual(Object.keys(calls.find((call) => call.name === 'join_room').args).sort(), ['name', 'room_id']);

      w.clearMcp();
      const withServer = w.exec(process.execPath, [V_S2, '--server', 'ws://127.0.0.1:8787']);
      assert.equal(withServer.status, 0, withServer.output);
      assert.equal(w.mcpCalls().filter((call) => call.name === 'create_room').every((call) => call.args.server === 'ws://127.0.0.1:8787'), true);
    }),
  );

  test(
    'v-s1.mjs: 실제 Codex 0.169.0 처럼 env 순서가 바뀌고 다른 서버 표의 표기를 다시 써도(뜻은 같다) 통과한다',
    withWorld({}, (w) => {
      // 2026-11-16 실제 홈 V-S1(S-FI-01)에서 본 꼴: 다른 서버의 `args = []`, 정수 시간, 공백 든 배열.
      const extra = ['', '[mcp_servers.rea]', 'command = "/usr/bin/rea"', 'args = [ "/opt/rea", "mcp" ]', 'startup_timeout_sec = 30', 'tool_timeout_sec = 450', '', '[mcp_servers.repl]', 'command = "/usr/bin/repl"', 'args = []', 'startup_timeout_sec = 120', ''];
      writeFileSync(path.join(w.home, '.codex', 'config.toml'), `${INITIAL.codexToml}${extra.join('\n')}`);
      const state = path.join(w.root, 'codex-0169-state');
      const s1 = w.exec(process.execPath, [V_S1, '--yes', '--replace-app'], { FAKE_CODEX_LIKE_0169: state });
      // 가짜 CLI 가 실제로 표기를 바꿔 썼고 env 순서를 여러 번 바꿨다(시험이 헛돌지 않았다).
      const text = w.codexTomlText();
      assert.match(text, /\[mcp_servers\.rea\]\ncommand = "\/usr\/bin\/rea"\nargs = \["\/opt\/rea", "mcp"\]\nstartup_timeout_sec = 30\.0\ntool_timeout_sec = 450\.0/);
      assert.match(text, /\[mcp_servers\.repl\]\ncommand = "\/usr\/bin\/repl"\nstartup_timeout_sec = 120\.0/);
      assert.ok(Number(readFileSync(state, 'utf8')) >= 4);
      assert.equal(s1.status, 0, s1.output);
      assert.match(s1.stdout, /V-S1 결과: 11\/11 통과/);
    }),
  );

  test(
    'v-s1.mjs: 설치 중에 권한 설정이 바뀌면 달라진 키의 이름을 대며 실패한다',
    withWorld({}, (w) => {
      const result = w.exec(process.execPath, [V_S1, '--yes', '--replace-app'], { FAKE_NPM_TAMPER: '1' });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /^S1-03 [^\n]*: 실패 — ~\/\.claude\/settings\.json: permissions, ~\/\.claude\/settings\.json: hooks$/m);
      assert.match(result.stdout, /^S1-08 [^\n]*: 실패 — ~\/\.claude\/settings\.json: permissions, ~\/\.claude\/settings\.json: hooks$/m);
      assert.equal(result.output.includes('Bash(*)'), false, '값이 출력됐다');
      assert.notEqual(readFileSync(path.join(w.home, '.claude', 'settings.json'), 'utf8'), formatJson(INITIAL.claudeSettings));
    }),
  );

  test(
    'v-s2.mjs: 등록이 없으면 실행하지 못했다고 알린다. 틀린 인자는 사용법이다',
    withWorld({}, (w) => {
      const result = w.exec(process.execPath, [V_S2]);
      assert.equal(result.status, 2, result.output);
      assert.match(result.stderr, /등록이 없다\. 먼저 V-S1 을 실행한다/);
      assert.deepEqual(w.mcpLaunches(), []);
      assert.equal(w.exec(process.execPath, [V_S2, '--server']).status, 2);
      assert.equal(w.exec(process.execPath, [V_S2, 'extra']).status, 2);
    }),
  );

  test(
    'v-s2.mjs: 통신이 실패하면 실패한 항목을 대고 종료 코드 1 이다. 띄운 프로세스는 정리한다',
    withWorld({}, (w) => {
      assert.equal(w.installMjs([]).status, 0);
      w.setMcpOptions({ dropChat: true });
      const result = w.exec(process.execPath, [V_S2]);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /^S2-04 [^\n]*: 실패/m);
      assert.match(result.stdout, /^S2-08 [^\n]*: 통과/m);
    }),
  );
});
