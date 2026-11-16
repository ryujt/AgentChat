// V-L10 (가): 설치 본체 scripts/install.mjs 를 임시 홈에서, 호스트 CLI 를 가짜로 바꿔 실행한다.
// 단계 순서, 등록 명령의 인자, 단계별 결과와 종료 코드(0·1·2), 다시 실행, 제거, Channels 판정표, 설치가 쓰는 곳을 본다.
// 호스트 CLI 와 MCP 서버가 가짜이므로 대역 수준이다. 실제 사용자 홈에 쓰지 않는다(fixture.mjs).
//
// 실행: 빌드한 뒤 `node --test tests/e2e/install/` (묶음별 빌드 폴더를 쓰면 AGENT_CHAT_DIST=<폴더>).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { INITIAL, changedPaths, createWorld, formatJson } from './fixture.mjs';
import { compareSnapshots, removeSnapshot, takeSnapshot } from './settings-snapshot.mjs';

/** 출력에서 단계 번호가 붙은 줄만, 설명을 떼고 모은다. */
function steps(output) {
  return output.split('\n').filter((line) => /^\[[^\]]+\]/.test(line)).map((line) => line.replace(/ — .*$/, ''));
}

function withWorld(options, check) {
  return async () => {
    const world = createWorld(options);
    try {
      await check(world);
      assert.deepEqual(world.leftoverMcp(), [], 'MCP 프로세스가 남았다');
    } finally {
      world.cleanup();
    }
  };
}

const heads = (calls) => calls.map((call) => `${call.host} ${call.args[0] === 'mcp' || call.args[0] === 'auth' ? call.args.slice(0, 2).join(' ') : call.args[0]}`);

describe('V-L10 (가) 설치', () => {
  test(
    '설치 → 다시 설치 → 제거 → 다시 제거. 단계 순서, 등록 인자, 종료 코드 0, 설치가 쓰는 곳',
    withWorld({}, (w) => {
      // 설치가 건드리면 안 되는 기록과 로그.
      mkdirSync(path.join(w.agentHome, 'rooms', 'room-1'), { recursive: true });
      mkdirSync(path.join(w.agentHome, 'logs'), { recursive: true });
      writeFileSync(path.join(w.agentHome, 'rooms', 'room-1', 'transcript.jsonl'), '{"kept":true}\n');
      const homeBefore = w.homeFiles();
      const agentBefore = w.agentHomeFiles();
      const snapshotBefore = path.join(w.root, 'snapshot before');
      const snapshotOptions = { home: w.home, cwd: w.work, app: w.app, codexBin: w.bins.codex, env: w.baseEnv, managed: [] };
      takeSnapshot({ ...snapshotOptions, outDir: snapshotBefore });
      // 사본을 뜨며 부른 `codex mcp list --json` 은 설치의 호출이 아니다.
      w.clearHostCalls();

      // ── 설치 ──
      const first = w.installMjs(['--client', 'all']);
      assert.equal(first.status, 0, first.output);
      assert.deepEqual(steps(first.stdout), [
        '[1] Node 버전: 통과',
        '[2] 설치 위치: 통과',
        '[3] 의존성과 빌드: 통과',
        '[4] 네이티브 모듈: 통과',
        '[5] 호스트 찾기 (Claude Code): 통과',
        '[5] 호스트 찾기 (Codex): 통과',
        '[5] 호스트 찾기 (Gemini CLI): 건너뜀',
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
      assert.match(first.stdout, /D1 Node 와 빌드: 통과[\s\S]*D2 등록: 통과[\s\S]*D3 MCP 초기화[^\n]*: 통과[\s\S]*D4 시그널링: 통과[\s\S]*D5 직접 연결[^\n]*: 통과[\s\S]*D6 메시지 왕복: 통과[\s\S]*D7 주소 탐색: 통과[\s\S]*D8 정리: 통과/);
      assert.match(first.stdout, /\(종료 코드 0\)/);
      assert.match(first.stdout, /Channels \(Claude Code\): 불명 — 판정표 9행/);

      // 의존성 설치와 빌드가 등록보다 먼저다. --omit=optional 을 쓰지 않는다.
      assert.deepEqual(w.npmCalls(), ['ci', 'run build']);

      // 호스트 CLI 로 실행한 하위 명령과 순서.
      const calls = w.hostCalls();
      assert.deepEqual(heads(calls), [
        'claude --version',
        'codex --version',
        'claude mcp get',
        'claude mcp add',
        'codex mcp get',
        'codex mcp add',
        'codex mcp get',
        'claude mcp get',
        'codex mcp get',
        'claude auth status',
        'claude mcp get',
        'codex mcp get',
      ]);
      const claudeAdd = calls.find((call) => call.host === 'claude' && call.args[1] === 'add').args;
      const codexAdd = calls.find((call) => call.host === 'codex' && call.args[1] === 'add').args;
      const claudeName = claudeAdd.find((arg) => arg.startsWith('AGENT_CHAT_NAME=')).slice('AGENT_CHAT_NAME='.length);
      const codexName = codexAdd.find((arg) => arg.startsWith('AGENT_CHAT_NAME=')).slice('AGENT_CHAT_NAME='.length);
      assert.match(claudeName, /^claude-[a-z0-9]{4}$/);
      assert.match(codexName, /^codex-[a-z0-9]{4}$/);
      assert.deepEqual(claudeAdd, [
        'mcp', 'add', '--scope', 'user', 'agent-chat',
        '-e', 'AGENT_CHAT_CLIENT=claude-code', '-e', `AGENT_CHAT_NAME=${claudeName}`, '-e', 'AGENT_CHAT_WAIT_MAX_SEC=100',
        '--', w.node, w.mcpEntry,
      ]);
      assert.deepEqual(codexAdd, [
        'mcp', 'add', 'agent-chat',
        '--env', 'AGENT_CHAT_CLIENT=codex', '--env', `AGENT_CHAT_NAME=${codexName}`, '--env', 'AGENT_CHAT_WAIT_MAX_SEC=540', '--env', 'AGENT_CHAT_CHANNEL=off',
        '--', w.node, w.mcpEntry,
      ]);
      // 호스트 CLI 는 설치를 실행한 작업 폴더에서 불린다.
      assert.deepEqual([...new Set(calls.map((call) => call.cwd))], [w.work]);

      // 연결 점검은 등록된 명령·인자·환경 그대로 MCP 프로세스 둘을 띄웠다.
      assert.deepEqual(
        w.mcpLaunches().map(({ node, script, args, env }) => ({ node, script, args, env })),
        [
          { node: w.node, script: w.mcpEntry, args: [], env: { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: claudeName, AGENT_CHAT_WAIT_MAX_SEC: '100' } },
          { node: w.node, script: w.mcpEntry, args: [], env: { AGENT_CHAT_CLIENT: 'codex', AGENT_CHAT_NAME: codexName, AGENT_CHAT_WAIT_MAX_SEC: '540', AGENT_CHAT_CHANNEL: 'off' } },
        ],
      );
      assert.deepEqual(w.mcpCalls().map((call) => call.name).filter((name) => name !== 'wait_for_messages' && name !== 'get_status'), [
        'create_room', 'join_room', 'send_message', 'send_message', 'leave_room', 'leave_room',
      ]);

      // 설치가 쓰는 곳은 셋뿐이다: ~/.claude.json, ~/.codex/config.toml, <AGENT_CHAT_HOME>.
      assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), ['.claude.json', '.codex/config.toml']);
      // 두 파일은 agent-chat 등록 항목을 빼면 바이트까지 같다.
      assert.equal(w.claudeJsonWithoutOwn(), formatJson(INITIAL.claudeJson));
      assert.equal(w.codexTomlWithoutOwn(), INITIAL.codexToml);
      assert.deepEqual(w.claudeJson().mcpServers['agent-chat'], {
        type: 'stdio',
        command: w.node,
        args: [w.mcpEntry],
        env: { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: claudeName, AGENT_CHAT_WAIT_MAX_SEC: '100' },
      });
      // Codex 의 이 서버 표에는 command, args, env, tool_timeout_sec 뿐이다. 승인 모드 키가 없다.
      const own = w.codexTomlText().slice(INITIAL.codexToml.length).split('\n').filter((line) => / = /.test(line)).map((line) => line.split(' = ')[0]);
      assert.deepEqual(own, ['tool_timeout_sec', 'command', 'args', 'AGENT_CHAT_CLIENT', 'AGENT_CHAT_NAME', 'AGENT_CHAT_WAIT_MAX_SEC', 'AGENT_CHAT_CHANNEL']);
      assert.match(w.codexTomlText(), /\[mcp_servers\.agent-chat\]\ntool_timeout_sec = 600\n/);

      // <AGENT_CHAT_HOME> 에는 Codex 설정 백업과 설치 CLI 의 진단 로그만 더해졌다. 기록은 그대로다.
      const added = changedPaths(agentBefore, w.agentHomeFiles());
      assert.equal(added.length, 2, added.join(', '));
      const backup = added.find((file) => /^backups\/codex-config-\d{8}T\d{6}Z\.toml$/.test(file));
      const diag = added.find((file) => /^logs\/diag-.*\.jsonl$/.test(file));
      assert.ok(backup && diag, added.join(', '));
      // 백업은 Codex CLI 가 파일을 고치기 전(mcp add 전)의 내용이다(검토 1차 BOUNDARY-R1-01).
      assert.equal(readFileSync(path.join(w.agentHome, backup), 'utf8'), INITIAL.codexToml);
      assert.equal(statSync(path.join(w.agentHome, backup)).mode & 0o777, 0o600);

      // 진단 로그: 단계와 결과만 남는다. 이름, 경로, 환경 변수 값이 없다.
      const logText = readFileSync(path.join(w.agentHome, diag), 'utf8');
      const logLines = logText.trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(logLines.some((line) => line.event === 'setup.step' && line.step === '6' && line.outcome === 'pass' && line.host === 'claude'));
      assert.ok(logLines.some((line) => line.event === 'doctor.check' && line.step === 'D6' && line.outcome === 'pass'));
      for (const line of logLines) assert.equal(line.svc, 'cli');
      for (const secret of [claudeName, codexName, w.root, 'do-not-print-this', 'fakeroom']) assert.equal(logText.includes(secret), false, secret);
      assert.equal(first.output.includes('do-not-print-this'), false);

      // 비교 도구로 봐도 권한에 관한 키는 설치 전과 뜻이 같다.
      const snapshotAfter = path.join(w.root, 'snapshot after');
      takeSnapshot({ ...snapshotOptions, outDir: snapshotAfter });
      assert.deepEqual(compareSnapshots(snapshotBefore, snapshotAfter).differences, []);

      // ── 다시 설치: 결과가 같다 ──
      const claudeAfterFirst = w.claudeJsonText();
      const codexAfterFirst = w.codexTomlText();
      w.clearHostCalls();
      const second = w.installMjs([]);
      assert.equal(second.status, 0, second.output);
      assert.deepEqual(steps(second.stdout).slice(4, 11), [
        '[5] 호스트 찾기 (Claude Code): 통과',
        '[5] 호스트 찾기 (Codex): 통과',
        '[5] 호스트 찾기 (Gemini CLI): 건너뜀',
        '[6] MCP 등록 (Claude Code): 건너뜀',
        '[7] MCP 등록 (Codex): 건너뜀',
        '[8] 등록 확인 (Claude Code): 통과',
        '[8] 등록 확인 (Codex): 통과',
      ]);
      assert.match(second.stdout, /\[6\] MCP 등록 \(Claude Code\): 건너뜀 — 이미 등록됨/);
      assert.match(second.stdout, /\[10\] 연결 점검: 통과/);
      assert.deepEqual(w.hostCalls().filter((call) => call.args[1] === 'add' || call.args[1] === 'remove'), []);
      assert.equal(w.claudeJsonText(), claudeAfterFirst);
      assert.equal(w.codexTomlText(), codexAfterFirst);
      assert.equal(readdirSync(path.join(w.agentHome, 'backups')).length, 1, '다시 설치하며 백업을 또 만들었다');

      // ── 제거 ──
      w.clearHostCalls();
      w.clearMcp();
      const npmBefore = w.npmCalls().length;
      const removed = w.installMjs(['--remove']);
      assert.equal(removed.status, 0, removed.output);
      assert.deepEqual(steps(removed.stdout), [
        '[1] Node 버전: 통과',
        '[제거 1] 호스트 찾기 (Claude Code): 통과',
        '[제거 1] 호스트 찾기 (Codex): 통과',
        '[제거 1] 호스트 찾기 (Gemini CLI): 건너뜀',
        '[제거 2] MCP 등록 제거 (Claude Code): 통과',
        '[제거 2] MCP 등록 제거 (Codex): 통과',
      ]);
      assert.deepEqual(heads(w.hostCalls()), [
        'claude --version', 'codex --version', 'claude mcp get', 'claude mcp remove', 'claude mcp get', 'codex mcp get', 'codex mcp remove', 'codex mcp get',
      ]);
      assert.deepEqual(w.hostCalls('claude').find((call) => call.args[1] === 'remove').args, ['mcp', 'remove', '--scope', 'user', 'agent-chat']);
      assert.deepEqual(w.hostCalls('codex').find((call) => call.args[1] === 'remove').args, ['mcp', 'remove', 'agent-chat']);
      // 제거는 설치 위치 확인, 의존성 설치, 빌드, 연결 점검을 하지 않는다.
      assert.equal(w.npmCalls().length, npmBefore);
      assert.deepEqual(w.mcpLaunches(), []);
      // 설정 파일이 설치 전의 바이트로 돌아왔다. 기록과 저장소는 남아 있고 경로를 알려 준다.
      assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), []);
      assert.equal(readFileSync(path.join(w.agentHome, 'rooms', 'room-1', 'transcript.jsonl'), 'utf8'), '{"kept":true}\n');
      assert.equal(existsSync(w.mcpEntry), true);
      assert.ok(removed.stdout.includes(path.join(w.agentHome, 'rooms')) && removed.stdout.includes(w.app));
      const snapshotRemoved = path.join(w.root, 'snapshot removed');
      takeSnapshot({ ...snapshotOptions, outDir: snapshotRemoved });
      assert.deepEqual(compareSnapshots(snapshotBefore, snapshotRemoved).differences, []);
      for (const dir of [snapshotBefore, snapshotAfter, snapshotRemoved]) removeSnapshot(dir);

      // ── 다시 제거: 처음부터 없어도 0 ──
      const again = w.installMjs(['--remove', '--client', 'all']);
      assert.equal(again.status, 0, again.output);
      assert.match(again.stdout, /\[제거 2\] MCP 등록 제거 \(Claude Code\): 통과 — 등록이 없다/);
      assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), []);
    }),
  );

  test(
    '--client claude 는 Codex 를, --client codex 는 Claude Code 를 건드리지 않는다',
    withWorld({}, (w) => {
      const claude = w.installMjs(['--client', 'claude']);
      assert.equal(claude.status, 0, claude.output);
      assert.deepEqual(w.hostCalls('codex'), []);
      assert.equal(w.codexTomlText(), INITIAL.codexToml);
      assert.equal(claude.stdout.includes('Codex)'), false);
      assert.equal(w.mcpLaunches().every((launch) => launch.env.AGENT_CHAT_CLIENT === 'claude-code'), true);

      w.clearHostCalls();
      const claudeJson = w.claudeJsonText();
      const codex = w.installMjs(['--client', 'codex']);
      assert.equal(codex.status, 0, codex.output);
      assert.deepEqual(w.hostCalls('claude'), []);
      assert.equal(w.claudeJsonText(), claudeJson);

      // 제거도 고른 호스트만 다룬다.
      w.clearHostCalls();
      assert.equal(w.installMjs(['--remove', '--client', 'codex']).status, 0);
      assert.deepEqual(w.hostCalls('claude'), []);
      assert.equal(w.codexTomlText(), INITIAL.codexToml);
      assert.ok('agent-chat' in w.claudeJson().mcpServers);
    }),
  );

  test(
    '호스트 CLI 를 PATH 의 기본 이름으로 찾는다. 다른 설치 뿌리(AGENT_CHAT_HOME)에서도 되고, 그 값이 등록 환경에 들어간다',
    withWorld({ hostsOnPath: true, agentHome: 'custom agent home' }, (w) => {
      const result = w.installMjs([]);
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(w.claudeJson().mcpServers['agent-chat'].args, [path.join(w.root, 'custom agent home', 'app', 'dist', 'entry', 'mcp.js')]);
      // 기본값이 아닌 설치 뿌리는 MCP 등록의 환경에 넣는다. MCP 프로세스가 같은 곳에 기록·로그·channel-check.json 을 쓴다.
      assert.equal(w.claudeJson().mcpServers['agent-chat'].env.AGENT_CHAT_HOME, w.agentHome);
      assert.match(w.codexTomlText(), new RegExp(`AGENT_CHAT_HOME = ${JSON.stringify(w.agentHome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(w.mcpLaunches().length > 0 && w.mcpLaunches().every((launch) => launch.env.AGENT_CHAT_HOME === w.agentHome), true, '연결 점검이 등록 환경 그대로 띄웠다');
      // 다시 실행해도 등록이 같다(이미 등록됨).
      const again = w.installMjs([]);
      assert.equal(again.status, 0, again.output);
      assert.match(again.stdout, /\[6\] MCP 등록 \(Claude Code\): 건너뜀/);
      assert.match(again.stdout, /\[7\] MCP 등록 \(Codex\): 건너뜀/);
      assert.deepEqual(readdirSync(path.join(w.agentHome, 'backups')).length, 1);
      // 기본 위치(~/.agent-chat)에는 아무 것도 만들지 않았다.
      assert.deepEqual(changedPaths(new Map(), w.homeFiles()).filter((file) => file.startsWith('.agent-chat')), []);
    }),
  );
});

describe('V-L10 (가) 종료 코드 2: 실패는 없지만 등록한 호스트가 없다', () => {
  test(
    '호스트 CLI 가 하나도 없으면 빌드와 네이티브 확인까지 하고 수동 등록 명령을 출력한다',
    withWorld({ hosts: [] }, (w) => {
      const homeBefore = w.homeFiles();
      const result = w.installMjs([]);
      assert.equal(result.status, 2, result.output);
      assert.deepEqual(steps(result.stdout), [
        '[1] Node 버전: 통과',
        '[2] 설치 위치: 통과',
        '[3] 의존성과 빌드: 통과',
        '[4] 네이티브 모듈: 통과',
        '[5] 호스트 찾기 (Claude Code): 건너뜀',
        '[5] 호스트 찾기 (Codex): 건너뜀',
        '[5] 호스트 찾기 (Gemini CLI): 건너뜀',
      ]);
      assert.deepEqual(w.npmCalls(), ['ci', 'run build']);
      assert.ok(result.stdout.includes(`claude mcp add --scope user agent-chat -e AGENT_CHAT_CLIENT=claude-code`));
      assert.ok(result.stdout.includes(`-- ${w.node} '${w.mcpEntry}'`), result.stdout);
      assert.match(result.stdout, /codex mcp add agent-chat --env AGENT_CHAT_CLIENT=codex .*--env AGENT_CHAT_WAIT_MAX_SEC=50 --env AGENT_CHAT_CHANNEL=off/);
      assert.match(result.stdout, /\(종료 코드 2\)/);
      assert.deepEqual(w.mcpLaunches(), []);
      assert.deepEqual(changedPaths(homeBefore, w.homeFiles()), []);
      // 제거는 없는 호스트를 건너뛰고 0 이다.
      assert.equal(w.installMjs(['--remove']).status, 0);
    }),
  );

  test(
    'user 가 아닌 scope 에 같은 이름의 등록이 있으면 등록하지 않고 사용자 조치 필요로 알린다',
    withWorld({ hosts: ['claude'] }, (w) => {
      const config = structuredClone(INITIAL.claudeJson);
      config.projects[w.work] = { allowedTools: [], mcpServers: { 'agent-chat': { type: 'stdio', command: '/other/node', args: ['/other/server.js'], env: {} } } };
      writeFileSync(path.join(w.home, '.claude.json'), formatJson(config));
      const result = w.installMjs([]);
      assert.equal(result.status, 2, result.output);
      assert.match(result.stdout, /\[6\] MCP 등록 \(Claude Code\): 사용자 조치 필요 — user 가 아닌 scope\(local\)/);
      assert.match(result.stdout, /\[10\] 연결 점검: 건너뜀/);
      assert.equal(w.claudeJsonText(), formatJson(config), '다른 scope 의 등록을 건드렸다');
      assert.deepEqual(w.hostCalls().filter((call) => call.args[1] === 'add' || call.args[1] === 'remove'), []);
      // 제거도 그 등록을 지우지 않는다. 등록이 남았으므로 1 이다.
      const removed = w.installMjs(['--remove', '--client', 'claude']);
      assert.equal(removed.status, 1, removed.output);
      assert.equal(w.claudeJsonText(), formatJson(config));
    }),
  );
});

describe('V-L10 (가) 종료 코드 1: 실패', () => {
  test(
    '저장소를 받은 자리(설치 위치 밖)에서도 그 자리를 그대로 등록한다. 예전 옵션 --in-place 는 받아들이고 결과가 같다',
    withWorld({ inPlace: true }, (w) => {
      const here = w.installMjs([]);
      assert.equal(here.status, 0, here.output);
      assert.match(here.stdout, /\[2\] 설치 위치: 통과 — 이 자리의 저장소를 등록한다[\s\S]*참고: MCP 등록은 이 폴더의 절대 경로를 쓴다/);
      assert.deepEqual(w.claudeJson().mcpServers['agent-chat'].args, [path.join(w.root, 'dev checkout', 'dist', 'entry', 'mcp.js')]);
      assert.ok(!existsSync(path.join(w.agentHome, 'app')), '설치 위치에 사본을 만들었다');

      const again = w.installMjs(['--in-place']);
      assert.equal(again.status, 0, again.output);
      assert.match(again.stdout, /\[6\] MCP 등록 \(Claude Code\): 건너뜀/);
    }),
  );

  test(
    'npm ci 나 빌드가 실패하면 등록하지 않는다',
    withWorld({}, (w) => {
      const ci = w.installMjs([], { FAKE_NPM_FAIL: 'ci' });
      assert.equal(ci.status, 1, ci.output);
      assert.match(ci.stdout, /\[3\] 의존성과 빌드: 실패 — npm ci 이\(가\) 종료 코드 7/);
      assert.deepEqual(w.npmCalls(), ['ci']);
      const build = w.installMjs([], { FAKE_NPM_FAIL: 'run' });
      assert.equal(build.status, 1, build.output);
      assert.match(build.stdout, /\[3\] 의존성과 빌드: 실패 — npm run build 이\(가\) 종료 코드 7/);
      assert.deepEqual(w.hostCalls(), []);
      assert.equal(w.claudeJsonText(), formatJson(INITIAL.claudeJson));
    }),
  );

  test(
    '빌드 뒤에도 CLI 가 없으면 실패한다',
    withWorld({ build: false }, (w) => {
      const result = w.installMjs([]);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /\[3\] 의존성과 빌드: 실패 — 빌드했지만 .*cli\.js 가 없다/);
      assert.deepEqual(w.hostCalls(), []);
    }),
  );

  test(
    '네이티브 모듈을 불러오지 못하면 OS 와 CPU 종류를 함께 출력하고 실패한다',
    withWorld({ nodeModules: false }, (w) => {
      const result = w.installMjs([]);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, new RegExp(`\\[4\\] 네이티브 모듈: 실패 — node-datachannel 을 불러오지 못했다\\. OS ${process.platform}, CPU ${process.arch}`));
      assert.deepEqual(w.hostCalls(), []);
    }),
  );

  test(
    '환경 변수로 준 호스트 CLI 를 실행할 수 없으면 건너뛰지 않고 실패한다',
    withWorld({}, (w) => {
      const result = w.installMjs([], { AGENT_CHAT_CLAUDE_BIN: path.join(w.root, 'no such dir', 'claude') });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /\[5\] 호스트 찾기 \(Claude Code\): 실패 — AGENT_CHAT_CLAUDE_BIN 로 준 파일을 실행할 수 없다/);
      // 다른 호스트는 등록하지만 종료 코드는 1 이다.
      assert.match(result.stdout, /\[7\] MCP 등록 \(Codex\): 통과/);
      assert.match(result.stdout, /\(종료 코드 1\)/);
    }),
  );

  test(
    '등록에 실패하면 실패한다',
    withWorld({ hosts: ['claude'] }, (w) => {
      const result = w.installMjs([], { FAKE_FAIL_ADD: 'claude' });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /\[6\] MCP 등록 \(Claude Code\): 실패 — 등록하지 못했다/);
      assert.match(result.stdout, /\[10\] 연결 점검: 건너뜀/);
    }),
  );

  test(
    '연결 점검이 실패하면 오류 코드를 보여 주고 실패한다. 띄운 프로세스는 정리한다',
    withWorld({}, (w) => {
      w.setMcpOptions({ createError: 'SERVER_UNREACHABLE' });
      const result = w.installMjs([]);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /D4 시그널링: 실패 — SERVER_UNREACHABLE/);
      assert.match(result.stdout, /D5 직접 연결: 건너뜀[\s\S]*D8 정리: 건너뜀/);
      assert.match(result.stdout, /\[10\] 연결 점검: 실패/);
      // 등록은 남는다. 다시 실행하면 점검만 다시 한다.
      assert.ok('agent-chat' in w.claudeJson().mcpServers);

      w.setMcpOptions({ joinError: 'DIRECT_CONNECT_FAILED' });
      const join = w.cli(['doctor']);
      assert.equal(join.status, 1, join.output);
      assert.match(join.stdout, /D5 직접 연결 \(Codex\): 실패 — DIRECT_CONNECT_FAILED — stage=ice reason=ice_timeout/);
    }),
  );

  test(
    '틀린 인자는 사용법을 stderr 에 쓰고 아무 것도 하지 않는다',
    withWorld({}, (w) => {
      for (const args of [['--client'], ['--client', 'cursor'], ['--uninstall'], ['install'], ['--remove', 'extra']]) {
        const result = w.installMjs(args);
        assert.equal(result.status, 1, args.join(' '));
        assert.match(result.stderr, /사용법: node scripts\/install\.mjs/);
        assert.equal(result.stdout, '');
      }
      assert.deepEqual(w.npmCalls(), []);
      assert.deepEqual(w.hostCalls(), []);
    }),
  );

  test(
    '빌드 결과가 없으면 제거하려고 빌드하지 않고, 손으로 실행할 명령을 출력한 뒤 실패한다',
    withWorld({ build: false }, (w) => {
      const all = w.installMjs(['--remove']);
      assert.equal(all.status, 1, all.output);
      assert.match(all.stdout, /제거하려고 빌드하지는 않는다/);
      assert.match(all.stdout, /claude mcp remove --scope user agent-chat\n\s+codex mcp remove agent-chat/);
      const one = w.installMjs(['--remove', '--client', 'codex']);
      assert.equal(one.stdout.includes('claude mcp remove'), false);
      assert.deepEqual(w.npmCalls(), []);
      assert.deepEqual(w.hostCalls(), []);
    }),
  );
});

describe('V-L10 (가) Codex 설정 파일', () => {
  test(
    '설정 파일을 고치지 못하면 그 부분만 건너뛰고 대기 상한을 50초로 등록한다. 다시 실행해도 같다',
    withWorld({ hosts: ['codex'] }, (w) => {
      // Codex 가 등록을 다른 파일에 쓴다. 설치가 고치려는 파일에는 이 서버의 표가 없다.
      const elsewhere = path.join(w.root, 'elsewhere config.toml');
      const env = { FAKE_CODEX_CONFIG: elsewhere };
      for (const round of [1, 2]) {
        const result = w.installMjs([], env);
        assert.equal(result.status, 0, result.output);
        assert.match(result.stdout, /\[7\] tool_timeout_sec = 600 \(Codex\): 건너뜀 — 설정 파일을 고치지 못했다.*대기 상한을 50초로 등록했다/, `round ${round}`);
        assert.match(readFileSync(elsewhere, 'utf8'), /AGENT_CHAT_WAIT_MAX_SEC = "50"/);
        assert.doesNotMatch(readFileSync(elsewhere, 'utf8'), /tool_timeout_sec/);
        assert.equal(w.codexTomlText(), INITIAL.codexToml, '등록이 없는 설정 파일을 건드렸다');
        // 바꾸기 전 백업은 호스트 CLI 를 부르기 전에 뜬다(검토 1차 BOUNDARY-R1-01). Codex 가 다른 파일에 쓰는 줄은 그때 모른다.
        const backupDir = path.join(w.agentHome, 'backups');
        assert.deepEqual(readdirSync(backupDir).map((name) => readFileSync(path.join(backupDir, name), 'utf8')), Array.from({ length: round }, () => INITIAL.codexToml));
        assert.equal(w.mcpLaunches().at(-1).env.AGENT_CHAT_WAIT_MAX_SEC, '50');
      }
    }),
  );

  test(
    'CODEX_HOME 을 주면 그 폴더의 설정 파일을 고친다',
    withWorld({ hosts: ['codex'] }, (w) => {
      const codexHome = path.join(w.root, 'codex home');
      mkdirSync(codexHome);
      writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n');
      const result = w.installMjs([], { CODEX_HOME: codexHome });
      assert.equal(result.status, 0, result.output);
      assert.match(readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), /^model = "x"\n\n\[mcp_servers\.agent-chat\]\ntool_timeout_sec = 600\n/);
      assert.equal(w.codexTomlText(), INITIAL.codexToml);
    }),
  );
});

describe('V-L10 (가) Channels 판정표', () => {
  // 6행과 7행은 관리형 설정 파일이 OS 의 고정 위치에 있어야 해서 프로세스 수준에서 만들 수 없다.
  // 그 두 행은 src/setup/channels.test.ts 와 setup.test.ts 가 파일을 읽는 경로까지 본다.
  const rows = [
    ['1행: 2.1.80 미만', { FAKE_CLAUDE_VERSION: '2.1.79 (Claude Code)' }, /Channels \(Claude Code\): 불가 — 판정표 1행.*poll 로 동작한다/],
    ['2행: 공급자 변수', { CLAUDE_CODE_USE_BEDROCK: '1' }, /불가 — 판정표 2행\. CLAUDE_CODE_USE_BEDROCK/],
    ['2행: Vertex', { CLAUDE_CODE_USE_VERTEX: '1' }, /불가 — 판정표 2행\. CLAUDE_CODE_USE_VERTEX/],
    ['2행: Foundry', { CLAUDE_CODE_USE_FOUNDRY: '1' }, /불가 — 판정표 2행\. CLAUDE_CODE_USE_FOUNDRY/],
    ['3행: third_party 로그인', { FAKE_CLAUDE_AUTH: '{"loggedIn":true,"authMethod":"third_party"}' }, /불가 — 판정표 3행/],
    ['4행: API 키와 2.1.128 미만', { FAKE_CLAUDE_AUTH: '{"loggedIn":true,"authMethod":"api_key"}', FAKE_CLAUDE_VERSION: '2.1.127 (Claude Code)' }, /불가 — 판정표 4행/],
    ['4행에 걸리지 않음: API 키와 2.1.128', { FAKE_CLAUDE_AUTH: '{"loggedIn":true,"authMethod":"api_key_helper"}', FAKE_CLAUDE_VERSION: '2.1.128 (Claude Code)' }, /불명 — 판정표 9행/],
    ['5행: 로그인하지 않음', { FAKE_CLAUDE_AUTH: '{"loggedIn":false,"authMethod":"none"}' }, /불명 — 판정표 5행/],
    ['5행: auth status 를 읽지 못함', { FAKE_CLAUDE_AUTH: 'fail' }, /불명 — 판정표 5행.*개발 채널 플래그/],
    ['9행: 그 밖', {}, /불명 — 판정표 9행/],
  ];
  test(
    '1~5행과 9행: 행 번호와 안내를 함께 출력한다',
    withWorld({ hosts: ['claude'] }, (w) => {
      assert.equal(w.installMjs([]).status, 0);
      for (const [name, env, expected] of rows) {
        const result = w.cli(['setup', '--client', 'claude'], env);
        assert.equal(result.status, 0, `${name}\n${result.output}`);
        assert.match(result.stdout, expected, name);
      }
    }),
  );

  test(
    '8행: 같은 호스트 버전의 확인 기록이 있으면 가능이고 확인 시각을 출력한다. 되돌아간 기록이 있으면 9행이다',
    withWorld({ hosts: ['claude'] }, (w) => {
      assert.equal(w.installMjs([]).status, 0);
      const file = path.join(w.agentHome, 'channel-check.json');
      const check = { v: 1, host: 'claude-code', host_version: '2.1.325', confirmed_at: '2026-11-15T03:00:00Z', fallback_at: null };
      writeFileSync(file, JSON.stringify(check));
      assert.match(w.cli(['setup', '--client', 'claude']).stdout, /Channels \(Claude Code\): 가능 — 판정표 8행.*마지막 확인 시각: 2026-11-15T03:00:00Z/);
      writeFileSync(file, JSON.stringify({ ...check, fallback_at: '2026-11-15T04:00:00Z' }));
      assert.match(w.cli(['setup', '--client', 'claude']).stdout, /불명 — 판정표 9행/);
      writeFileSync(file, JSON.stringify(check));
      assert.match(w.cli(['setup', '--client', 'claude'], { FAKE_CLAUDE_VERSION: '2.1.400 (Claude Code)' }).stdout, /불명 — 판정표 9행/);
      // 앞 행이 먼저다. 확인 기록이 있어도 공급자 변수가 있으면 불가다.
      assert.match(w.cli(['setup', '--client', 'claude'], { CLAUDE_CODE_USE_VERTEX: '1' }).stdout, /불가 — 판정표 2행/);
    }),
  );

  test(
    'Codex 는 항상 "불가: 채널이 없다. poll 로 받는다"다',
    withWorld({ hosts: ['codex'] }, (w) => {
      const result = w.installMjs([]);
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, /\[9\] Channels \(Codex\): 불가 — 채널이 없다\. poll 로 받는다\./);
    }),
  );
});

describe('V-L10 (가) agent-chat doctor', () => {
  test(
    '등록된 명령 그대로 점검한다. --server 가 AGENT_CHAT_SERVER 보다 먼저이고, 서버 주소는 create_room 의 인자로만 준다',
    withWorld({}, (w) => {
      assert.equal(w.installMjs([]).status, 0);
      w.clearMcp();
      const plain = w.cli(['doctor']);
      assert.equal(plain.status, 0, plain.output);
      assert.match(plain.stdout, /D8 정리: 통과\n결과: 통과 \(종료 코드 0\)/);
      assert.deepEqual(Object.keys(w.mcpCalls().find((call) => call.name === 'create_room').args), ['name']);

      w.clearMcp();
      assert.equal(w.cli(['doctor'], { AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' }).status, 0);
      assert.equal(w.mcpCalls().find((call) => call.name === 'create_room').args.server, 'ws://127.0.0.1:8787');

      w.clearMcp();
      assert.equal(w.cli(['doctor', '--server', 'ws://127.0.0.1:9999'], { AGENT_CHAT_SERVER: 'ws://127.0.0.1:8787' }).status, 0);
      assert.equal(w.mcpCalls().find((call) => call.name === 'create_room').args.server, 'ws://127.0.0.1:9999');
      assert.equal(w.mcpLaunches().some((launch) => 'AGENT_CHAT_SERVER' in launch.env), false, '서버 주소가 MCP 프로세스의 환경으로 갔다');
    }),
  );

  test(
    'D7: srflx 를 못 보면 경고이고 종료 코드는 0 이다. STUN 을 쓰지 않으면 건너뛴다',
    withWorld({ hosts: ['claude'] }, (w) => {
      assert.equal(w.installMjs([]).status, 0);
      w.setMcpOptions({ srflxSeen: false });
      const warned = w.cli(['doctor']);
      assert.equal(warned.status, 0, warned.output);
      assert.match(warned.stdout, /D7 주소 탐색: 경고 — STUN 에 닿지 않는다/);
      w.setMcpOptions({ srflxSeen: false, stun: false });
      assert.match(w.cli(['doctor']).stdout, /D7 주소 탐색: 건너뜀/);
    }),
  );

  test(
    '등록이 없으면 D2 에서 실패한다',
    withWorld({}, (w) => {
      const result = w.cli(['doctor']);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stdout, /D2 등록: 실패 — 이 설치를 가리키는 등록이 없다\(Claude Code: 등록 없음, Codex: 등록 없음, Gemini CLI: CLI 없음\)/);
      assert.deepEqual(w.mcpLaunches(), []);
    }),
  );
});

describe('V-L10 (가) 설치 본체의 문법', () => {
  test('오래된 Node 에서도 안내를 낼 수 있게 옛 문법만 쓴다', () => {
    const source = readFileSync(new URL('../../../scripts/install.mjs', import.meta.url), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const [name, pattern] of [
      ['옵셔널 체이닝', /\?\./],
      ['널 병합', /\?\?/],
      ['화살표 함수', /=>/],
      ['let·const', /\b(?:let|const)\s/],
      ['최상위 await', /\bawait\b/],
      ['node: 접두어', /from 'node:/],
      ['템플릿 문자열', /`/],
    ]) {
      assert.equal(pattern.test(code), false, name);
    }
  });
});
