#!/usr/bin/env node
// V-S1: 이 PC 의 실제 홈에 설치하고, 설정 전후를 비교한다 (verification-plan.md 3.4).
//
// 스크립트 한 번으로 "사본 뜨기 → sh installer/install.sh → 사본 뜨기 → 비교"를 이어서 한다. 그 사이에 승인 프롬프트가 끼지 않는다.
// 이어서 다시 설치(결과가 같다), 제거(등록이 없고 목록이 설치 전과 뜻이 같다), 다시 설치(설치된 채로 둔다)를 본다.
//
// **실제 사용자 홈의 설정을 바꾼다.** 그래서 --yes 를 줘야 실행한다. 바꾸는 곳은 셋이다:
//   ~/.claude.json 의 mcpServers["agent-chat"], ~/.codex/config.toml 의 [mcp_servers.agent-chat], <AGENT_CHAT_HOME>/ 아래.
//
// 사용법:
//   node tests/e2e/install/v-s1.mjs --yes [--replace-app]
//
//   --yes          실제 홈에 설치한다는 것을 확인했다
//   --replace-app  <AGENT_CHAT_HOME>/app 이 이미 있고 이 스크립트가 만든 것이 아니어도 지우고 다시 복사한다
//
// 환경변수: 설치기의 것을 그대로 쓴다(AGENT_CHAT_HOME, AGENT_CHAT_NODE, AGENT_CHAT_CLAUDE_BIN, AGENT_CHAT_CODEX_BIN, AGENT_CHAT_SERVER).
//
// 저장소를 두는 방법: 커밋하지 않은 작업 트리를 <AGENT_CHAT_HOME>/app 에 복사한다(.git, node_modules, dist, build, .work 는 뺀다).
// git clone 으로 받는 길은 이 검증에서 보지 않는다(V-I1).
//
// 전후 비교는 settings-snapshot.mjs 가 한다(권한에 관한 키의 고정 목록. 파일 전체가 아니다).
// 이 PC 의 다른 세션에서 "항상 허용"을 고르면 같은 파일에 쓰인다. 실행하는 동안은 고르지 않는다.
//
// 종료 코드: 0 = 모든 항목 통과, 1 = 실패가 있다, 2 = 실행하지 않았다(확인 플래그 없음 등).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSnapshots, removeSnapshot, takeSnapshot } from './settings-snapshot.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'build', '.work']);
const MARKER = '.v-s1-copy';
const NAME = 'agent-chat';

const args = process.argv.slice(2);
const flags = new Set(args);
if (!flags.has('--yes') || args.some((arg) => arg !== '--yes' && arg !== '--replace-app')) {
  console.error('실행하지 않았다. 이 스크립트는 실제 사용자 홈에 Agent Chat 을 설치한다.');
  console.error('사용법: node tests/e2e/install/v-s1.mjs --yes [--replace-app]');
  process.exit(2);
}

const home = os.homedir();
const agentHome = process.env.AGENT_CHAT_HOME && process.env.AGENT_CHAT_HOME.trim() !== '' ? path.resolve(process.env.AGENT_CHAT_HOME) : path.join(home, '.agent-chat');
const app = path.join(agentHome, 'app');
const bins = { claude: process.env.AGENT_CHAT_CLAUDE_BIN || 'claude', codex: process.env.AGENT_CHAT_CODEX_BIN || 'codex' };
const cwd = process.cwd();
const results = [];

function record(id, title, pass, detail = '') {
  results.push({ id, title, pass });
  console.log(`${id} ${title}: ${pass ? '통과' : '실패'}${detail === '' ? '' : ` — ${detail}`}`);
  return pass;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', timeout: 900_000, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', missing: result.error?.code === 'ENOENT' };
}

/** 호스트 CLI 가 있는가. */
function hostPresent(host) {
  const result = run(bins[host], ['--version']);
  return !result.missing && result.status === 0;
}

/** 객체의 키를 이름 순으로 늘어놓은 JSON. Codex 0.169.0 의 `mcp get --json` 은 env 키 순서가 부를 때마다 바뀐다(S-FI-01). */
function canonicalJson(value) {
  const sort = (item) =>
    Array.isArray(item) ? item.map(sort) : item !== null && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

/**
 * 호스트 CLI 로 등록을 읽는다(조회만 한다). 설치 코드의 읽기를 쓰지 않는다.
 * @returns {{ present: boolean, entry: string | null, raw: string }} entry 는 등록된 MCP 진입점 경로.
 */
function registration(host) {
  if (host === 'claude') {
    const result = run(bins.claude, ['mcp', 'get', NAME]);
    if (result.status !== 0) return { present: false, entry: null, raw: '' };
    const line = result.stdout.split('\n').find((candidate) => candidate.trimStart().startsWith('Args:'));
    // 상태 줄(연결 점검 결과)은 실행할 때마다 달라질 수 있어 비교에서 뺀다.
    const raw = result.stdout.split('\n').filter((candidate) => !candidate.trimStart().startsWith('Status:')).join('\n');
    return { present: true, entry: line === undefined ? null : line.trimStart().slice('Args:'.length).trim(), raw };
  }
  const result = run(bins.codex, ['mcp', 'get', NAME, '--json']);
  if (result.status !== 0) return { present: false, entry: null, raw: '' };
  try {
    const parsed = JSON.parse(result.stdout);
    return { present: true, entry: parsed?.transport?.args?.[0] ?? null, raw: canonicalJson(parsed) };
  } catch {
    return { present: true, entry: null, raw: result.stdout };
  }
}

/** 설치기의 출력을 들여 써서 이 스크립트의 판정 줄과 구분한다. */
function indent(text, prefix) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => `${prefix}${line}\n`).join('');
}

function install(extra = []) {
  const result = run('/bin/sh', [path.join(app, 'installer', 'install.sh'), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(indent(result.stdout, '    | '));
  process.stdout.write(indent(result.stderr, '    ! '));
  return result;
}

// ── 준비: 작업 트리를 설치 위치에 복사한다 ──────────────────────────────────

console.log(`홈: ${home}`);
console.log(`설치 위치: ${app}`);
console.log(`작업 트리: ${REPO_ROOT}`);
if (existsSync(app) && !existsSync(path.join(app, MARKER)) && !flags.has('--replace-app')) {
  console.error(`실행하지 않았다. ${app} 이 이미 있고 이 스크립트가 만든 것이 아니다. 지우고 다시 복사하려면 --replace-app 을 준다.`);
  process.exit(2);
}
const hosts = ['claude', 'codex'].filter(hostPresent);
if (hosts.length === 0) {
  console.error('실행하지 않았다. 이 PC 에 claude 와 codex CLI 가 모두 없다.');
  process.exit(2);
}
console.log(`호스트: ${hosts.join(', ')}`);

rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(REPO_ROOT, app, { recursive: true, filter: (source) => !EXCLUDED.has(path.relative(REPO_ROOT, source).split(path.sep)[0]) });
writeFileSync(path.join(app, MARKER), 'tests/e2e/install/v-s1.mjs 가 작업 트리를 복사해 만든 폴더다\n');
const entry = path.join(realpathSync(app), 'dist', 'entry', 'mcp.js');

const snapshots = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-v-s1-'));
const snapshot = (name) => {
  const dir = path.join(snapshots, name);
  takeSnapshot({ outDir: dir, home, cwd, app, codexBin: bins.codex });
  return dir;
};
/** 앞 사본과 견줘 달라진 키의 이름만 돌려준다. */
const differences = (before, after) => compareSnapshots(before, after).differences.map((difference) => `${difference.file}: ${difference.key}`);

try {
  // ── 설치 ──
  const before = snapshot('before');
  console.log('\n[1/4] sh installer/install.sh');
  const first = install();
  const afterInstall = snapshot('after-install');
  record('S1-01', '설치의 종료 코드가 0 이다', first.status === 0, `종료 코드 ${first.status}`);
  for (const host of hosts) {
    const found = registration(host);
    record(`S1-02 (${host})`, '등록된 명령 경로가 이 설치다', found.present && found.entry === entry, found.present ? '' : '등록이 없다');
  }
  const changed = differences(before, afterInstall);
  record('S1-03', '권한에 관한 키의 목록이 설치 전후에 뜻이 같다', changed.length === 0, changed.join(', '));
  if (hosts.includes('claude')) {
    record('S1-04', 'Channels 보고에 판정표의 행 번호가 나온다', /Channels \(Claude Code\): (?:가능|불가|불명) — 판정표 \d행/.test(first.stdout));
  }

  // ── 다시 설치 ──
  const registeredFirst = Object.fromEntries(hosts.map((host) => [host, registration(host).raw]));
  console.log('\n[2/4] sh installer/install.sh (다시 실행)');
  const second = install();
  const afterSecond = snapshot('after-second');
  const sameRegistration = hosts.every((host) => registration(host).raw === registeredFirst[host]);
  record('S1-05', '다시 실행해도 종료 코드가 0 이고 등록이 같다', second.status === 0 && sameRegistration, `종료 코드 ${second.status}`);
  const changedSecond = differences(before, afterSecond);
  record('S1-06', '다시 실행한 뒤에도 목록이 설치 전과 뜻이 같다', changedSecond.length === 0, changedSecond.join(', '));

  // ── 제거 ──
  console.log('\n[3/4] sh installer/install.sh --uninstall');
  const removed = install(['--uninstall']);
  const afterRemove = snapshot('after-remove');
  const gone = hosts.every((host) => !registration(host).present);
  record('S1-07', '제거의 종료 코드가 0 이고 등록이 없다', removed.status === 0 && gone, `종료 코드 ${removed.status}`);
  const changedRemove = differences(before, afterRemove);
  record('S1-08', '제거한 뒤 목록이 설치 전과 뜻이 같다', changedRemove.length === 0, changedRemove.join(', '));

  // ── 확인 뒤 다시 설치한다 (V-S2 가 이 등록을 쓴다) ──
  console.log('\n[4/4] sh installer/install.sh (다시 설치해 둔다)');
  const last = install();
  const afterLast = snapshot('after-last');
  const back = hosts.every((host) => registration(host).entry === entry);
  record('S1-09', '다시 설치한 뒤 등록이 있고 종료 코드가 0 이다', last.status === 0 && back, `종료 코드 ${last.status}`);
  const changedLast = differences(before, afterLast);
  record('S1-10', '다시 설치한 뒤에도 목록이 설치 전과 뜻이 같다', changedLast.length === 0, changedLast.join(', '));
} finally {
  // 사본에는 다른 MCP 서버의 환경 변수 값이 들어 있을 수 있다. 끝나면 지운다.
  removeSnapshot(snapshots);
}

const failed = results.filter((result) => !result.pass);
console.log(`\nV-S1 결과: ${results.length - failed.length}/${results.length} 통과${failed.length === 0 ? '' : ` (실패: ${failed.map((result) => result.id).join(', ')})`}`);
console.log('바이트 비교는 하지 않았다. git clone 으로 받는 길과 git pull 갱신은 이 검증에서 미실행이다.');
process.exit(failed.length === 0 ? 0 : 1);
