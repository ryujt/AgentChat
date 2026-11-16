#!/usr/bin/env node
// Agent Chat 설치 본체. 의존성 없이 돈다.
//
// 보통은 installer/install.sh(Claude Code + Codex), installer/claude.sh, installer/codex.sh 가 Node 를 찾아
// 이 파일을 실행한다. sh 가 없는 곳(Windows)에서는 이 파일을 직접 실행한다.
//
// 사용법:
//   node scripts/install.mjs [--client claude|codex|gemini|all]            # 설치 또는 갱신
//   node scripts/install.mjs [--client claude|codex|gemini|all] --remove       # MCP 등록 제거
//
// 환경변수 (모두 선택):
//   AGENT_CHAT_HOME        기록·로그·백업을 두는 곳 (기본값: ~/.agent-chat). 저장소는 받은 자리에서 그대로 설치한다
//   AGENT_CHAT_CLAUDE_BIN  Claude Code CLI 실행 파일 (기본값: claude)
//   AGENT_CHAT_CODEX_BIN   Codex CLI 실행 파일 (기본값: codex)
//   AGENT_CHAT_SERVER      연결 점검이 쓸 서버 주소 (기본값: 공용 서버)
//   AGENT_CHAT_INSTALL_NODE 셸 진입점이 넘기는 값(직접 주지 않는다). 셸이 찾은 Node 의 경로이고, 이 Node 와 같은 파일이며
//                          셸 세션마다 만드는 일회용 링크(fnm_multishells, 임시 폴더·XDG_RUNTIME_DIR 아래)가 아니면 MCP 등록의
//                          명령이 된다(링크 그대로). 아니거나 없으면 이 Node 의 실경로(process.execPath)다
//
// 하는 일: 1 Node 버전 → 2 설치 위치 → 3 npm ci, npm run build → 4 네이티브 모듈 확인
//          → 5~11 MCP 등록, 등록 확인, Channels 보고, 연결 점검, 안내 (dist/entry/cli.js setup).
// 제거는 1 만 한 뒤 dist/entry/cli.js setup --remove 를 실행한다. 권한 설정은 바꾸지 않는다.
//
// 종료 코드: 0 = 호스트 하나 이상에 등록됐고 연결 점검이 통과했다. 1 = 실패가 있다.
//            2 = 실패는 없지만 등록한 호스트가 없다. 제거는 0 = 등록이 남아 있지 않다, 1 = 실패.
//
// 오래된 Node 에서도 "Node 22 이상이 필요하다"는 안내를 낼 수 있게, 이 파일은 옛 문법만 쓴다.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

var MIN_NODE_MAJOR = 22;
var CLIENTS = ['claude', 'codex', 'gemini', 'all'];
var EXIT_FAILED = 1;

var root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
var cliPath = path.join(root, 'dist', 'entry', 'cli.js');

function say(line) {
  process.stdout.write(line + '\n');
}

function step(id, title, outcome, detail) {
  say('[' + id + '] ' + title + ': ' + outcome + (detail ? ' — ' + detail : ''));
}

function usage() {
  process.stderr.write(
    [
      '사용법: node scripts/install.mjs [--client claude|codex|gemini|all] [--remove]',
      '  --client     등록할 호스트 (기본값: all)',
      '  --remove     MCP 등록을 지운다. 기록과 저장소는 지우지 않는다',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  var options = { client: 'all', remove: false };
  for (var index = 0; index < argv.length; index += 1) {
    var arg = argv[index];
    if (arg === '--remove') options.remove = true;
    else if (arg === '--in-place') continue; // 예전 옵션. 이제 늘 이 자리에서 설치한다
    else if (arg === '--client' && CLIENTS.indexOf(argv[index + 1]) >= 0) {
      options.client = argv[index + 1];
      index += 1;
    } else return null;
  }
  return options;
}

function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    return path.resolve(target);
  }
}

function installHome() {
  var given = process.env.AGENT_CHAT_HOME;
  return given && given.trim() !== '' ? path.resolve(given) : path.join(os.homedir(), '.agent-chat');
}

/** 명령을 실행하고 문제를 글로 돌려준다. 문제가 없으면 null. 출력은 그대로 보여 준다. */
function run(command, args, label) {
  var result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    // Windows 의 npm 은 .cmd 라서 셸을 거쳐야 실행된다.
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error) return label + ' 을(를) 실행하지 못했다(' + (result.error.code || result.error.message) + ')';
  if (result.status !== 0) return label + ' 이(가) 종료 코드 ' + result.status + ' (으)로 끝났다';
  return null;
}

function checkNode() {
  var major = Number(String(process.versions.node).split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    step(1, 'Node 버전', '통과', 'v' + process.versions.node + ' (' + process.execPath + ')');
    return true;
  }
  step(1, 'Node 버전', '실패', 'Node.js ' + MIN_NODE_MAJOR + ' 이상이 필요하다(지금 v' + process.versions.node + ', ' + process.execPath + '). 아무 것도 바꾸지 않았다');
  return false;
}

/** 저장소를 받은 자리에서 그대로 설치한다. 등록은 이 자리의 절대 경로를 쓴다. */
function checkLocation() {
  var expected = path.join(installHome(), 'app');
  if (realPath(root) === realPath(expected)) {
    step(2, '설치 위치', '통과', root);
    return true;
  }
  step(2, '설치 위치', '통과', '이 자리의 저장소를 등록한다(' + root + ')');
  say('  참고: MCP 등록은 이 폴더의 절대 경로를 쓴다. 폴더를 옮기거나 지우면 이 설치기를 다시 실행한다.');
  return true;
}

function buildPackage() {
  // --omit=optional 을 쓰지 않는다. node-datachannel 의 프리빌트가 선택 의존성이다.
  var problem = run('npm', ['ci'], 'npm ci') || run('npm', ['run', 'build'], 'npm run build');
  if (problem === null && !fs.existsSync(cliPath)) problem = '빌드했지만 ' + cliPath + ' 가 없다';
  step(3, '의존성과 빌드', problem === null ? '통과' : '실패', problem);
  return problem === null;
}

function checkNative() {
  var probe =
    "import('node-datachannel').then(function () { process.exit(0); }, " +
    'function (error) { console.error(String((error && error.message) || error)); process.exit(1); });';
  // 새 프로세스에서 불러 본다. 실패해도 설치 프로세스가 함께 죽지 않는다.
  var result = spawnSync(process.execPath, ['-e', probe], { cwd: root, encoding: 'utf8' });
  if (!result.error && result.status === 0) {
    step(4, '네이티브 모듈', '통과', 'node-datachannel (' + process.platform + ' ' + process.arch + ')');
    return true;
  }
  var reason = result.error ? String(result.error.code || result.error.message) : String(result.stderr || '').split('\n')[0];
  step(4, '네이티브 모듈', '실패', 'node-datachannel 을 불러오지 못했다. OS ' + process.platform + ', CPU ' + process.arch + (reason ? ' (' + reason + ')' : ''));
  return false;
}

/** 빌드한 CLI 에 넘긴다. 등록, 확인, Channels 보고, 연결 점검, 안내는 그쪽(src/setup)이 한다. */
function runCli(args) {
  // 작업 폴더는 설치를 실행한 곳 그대로 둔다. 호스트 CLI 가 그 폴더의 등록을 함께 본다.
  // 그 폴더(또는 그 git 저장소)의 Codex 프로젝트 설정에 같은 이름의 등록이 있으면 설치가 알아보고 멈춘다(src/setup/setup.ts).
  var result = spawnSync(process.execPath, [cliPath].concat(args), { stdio: 'inherit' });
  return typeof result.status === 'number' ? result.status : EXIT_FAILED;
}

function remove(client) {
  if (fs.existsSync(cliPath)) return runCli(['setup', '--remove', '--client', client]);
  say('실패: 빌드 결과(' + cliPath + ')가 없어 제거를 실행하지 못했다. 제거하려고 빌드하지는 않는다.');
  say('아래 명령을 직접 실행한다:');
  if (client === 'all' || client === 'claude') say('  claude mcp remove --scope user agent-chat');
  if (client === 'all' || client === 'codex') say('  codex mcp remove agent-chat');
  if (client === 'all' || client === 'gemini') say('  gemini mcp remove --scope user agent-chat');
  return EXIT_FAILED;
}

function main() {
  var options = parseArgs(process.argv.slice(2));
  if (options === null) {
    usage();
    return EXIT_FAILED;
  }
  if (!checkNode()) return EXIT_FAILED;
  if (options.remove) return remove(options.client);
  if (!checkLocation()) return EXIT_FAILED;
  if (!buildPackage()) return EXIT_FAILED;
  if (!checkNative()) return EXIT_FAILED;
  return runCli(['setup', '--client', options.client]);
}

process.exitCode = main();
