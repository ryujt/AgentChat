#!/usr/bin/env node
// 로컬 실물 시험(V-L*) 실행기. `npm run test:e2e [-- <묶음>… [시나리오 인자…]]`.
// 묶음을 하나씩 차례로 실행하고(포트를 쓰는 시나리오가 겹치지 않게), 묶음마다 종료 코드·걸린 시간·남은 프로세스를 요약한다.
// 제품 코드가 아니다. 빌드가 먼저다(npm run build). 빌드 결과의 위치는 AGENT_CHAT_DIST 를 따른다(tests/support/proc.mjs).
//
// ── 묶음 ────────────────────────────────────────────────────────────────────
//
//   wire        node tests/wire/run-local.mjs                      V-L1 (와이어 계약, 결함 주입 F-01~F-14, 프록시 자체 시험)
//   mesh        node tests/e2e/mesh/v-l11.mjs                      V-L11 (연결 단독. 공개 STUN 에 닿는다)
//   room        node tests/e2e/room/v-l12.mjs                      V-L12 (방 조율 하네스. 3분 남짓)
//   mcp         node --test tests/e2e/mcp/*.test.mjs               V-L7(가) (가짜 세션)
//   install     node --test tests/e2e/install/                     V-L10(가) (가짜 호스트 CLI)
//   scenarios   tests/e2e/scenarios 의 v-l2 … v-l8, v-l13, a-rtc 를 차례로   V-L2~V-L8, V-L7(나), V-L13(관전), A-RTC-4·6 (조립한 MCP 진입점)
//   scenarios/<이름>   그 시나리오 하나(예: scenarios/v-l3). 장시간 시험 v-l9 는 이렇게 이름으로만 돈다
//
//   묶음을 주지 않으면 wire, mesh, room, mcp, install, scenarios 를 모두 돈다(scenarios/v-l9 는 빠진다).
//   묶음 이름 뒤의 `--` 로 시작하는 인자부터는 시나리오 스크립트에만 넘긴다. 예:
//     npm run test:e2e -- scenarios/v-l2 --server wss://agent-chat.tools.camp      (V-P2)
//     npm run test:e2e -- scenarios --ice none
//
// ── 남은 프로세스 ───────────────────────────────────────────────────────────
//
//   묶음이 도는 동안 0.5초마다 프로세스 표(ps)를 읽어 그 묶음의 자손을 모은다. 묶음이 끝나고 3초 뒤에도 살아 있는 자손이 있으면
//   "남은 프로세스"로 보고하고 그 묶음을 실패로 세며, 그 프로세스(이 실행기가 자손으로 본 것만)를 SIGKILL 한다.
//   다른 세션의 프로세스는 건드리지 않는다. 출력에는 실행 파일 이름만 쓴다(인자에 방 ID 가 있을 수 있다).
//
// 종료 코드: 모든 묶음이 종료 코드 0 이고 남은 프로세스가 없으면 0, 아니면 1. 모르는 묶음 이름은 2.

import { execFileSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCENARIO_DIR = path.join(HERE, 'scenarios');
/** 기본 실행에서 빼는 시나리오(장시간). 이름으로 주면 돈다. */
const LONG_SCENARIOS = new Set(['v-l9']);
/** 기본 실행의 시나리오 순서. 폴더에 있는데 여기 없는 것은 뒤에 이름순으로 붙는다. */
const SCENARIO_ORDER = ['v-l2', 'v-l3', 'v-l4', 'v-l5', 'v-l6', 'v-l7', 'v-l8', 'v-l13', 'a-rtc'];
const SAMPLE_MS = 500;
const LEFTOVER_GRACE_MS = 3_000;

const node = process.execPath;
const rel = (...segments) => path.join(REPO_ROOT, ...segments);

function scenarioNames() {
  const present = readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith('.mjs') && file !== 'harness.mjs' && file !== 'host-proc.mjs')
    .map((file) => file.replace(/\.mjs$/, ''));
  const ordered = SCENARIO_ORDER.filter((name) => present.includes(name));
  const rest = present.filter((name) => !ordered.includes(name)).sort();
  return [...ordered, ...rest];
}

function testFiles(dir, pattern) {
  return readdirSync(rel(dir))
    .filter((file) => pattern.test(file))
    .sort()
    .map((file) => rel(dir, file));
}

/** 묶음 이름 → 실행할 명령들. */
function plan(name, forwarded) {
  switch (name) {
    case 'wire':
      return [{ label: 'wire (V-L1)', args: [rel('tests', 'wire', 'run-local.mjs')] }];
    case 'mesh':
      return [{ label: 'mesh (V-L11)', args: [rel('tests', 'e2e', 'mesh', 'v-l11.mjs')] }];
    case 'room':
      return [{ label: 'room (V-L12)', args: [rel('tests', 'e2e', 'room', 'v-l12.mjs')] }];
    case 'mcp':
      return [{ label: 'mcp (V-L7 가)', args: ['--test', ...testFiles(path.join('tests', 'e2e', 'mcp'), /\.test\.mjs$/)] }];
    case 'install':
      return [{ label: 'install (V-L10 가)', args: ['--test', rel('tests', 'e2e', 'install') + path.sep] }];
    case 'scenarios':
      return scenarioNames()
        .filter((scenario) => !LONG_SCENARIOS.has(scenario))
        .map((scenario) => ({ label: `scenarios/${scenario}`, args: [path.join(SCENARIO_DIR, `${scenario}.mjs`), ...forwarded] }));
    default: {
      const match = /^scenarios\/([a-z0-9-]+)$/.exec(name);
      if (match !== null && scenarioNames().includes(match[1])) {
        return [{ label: name, args: [path.join(SCENARIO_DIR, `${match[1]}.mjs`), ...forwarded] }];
      }
      return null;
    }
  }
}

function processTable() {
  try {
    const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const table = new Map();
    for (const line of text.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match !== null) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
    }
    return table;
  } catch {
    return null;
  }
}

/** 명령 줄에서 실행 파일과 스크립트의 이름만 뽑는다(인자는 싣지 않는다). */
function shortName(command) {
  const parts = command.split(/\s+/).filter((part) => part !== '');
  const script = parts.slice(1).find((part) => /\.(m?js)$/.test(part));
  return [path.basename(parts[0] ?? '?'), script === undefined ? null : path.relative(REPO_ROOT, script)].filter(Boolean).join(' ');
}

function runOne(step) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    process.stdout.write(`\n▶ ${step.label}\n`);
    const child = spawn(node, step.args, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
    /** 이 묶음의 자손으로 본 프로세스: pid → 명령 줄. */
    const descendants = new Map();
    const sample = () => {
      const table = processTable();
      if (table === null) return;
      let added = true;
      while (added) {
        added = false;
        for (const [pid, info] of table) {
          if (descendants.has(pid)) continue;
          if (info.ppid === child.pid || descendants.has(info.ppid)) {
            descendants.set(pid, info.command);
            added = true;
          }
        }
      }
    };
    const sampler = setInterval(sample, SAMPLE_MS);
    child.once('exit', (code, signal) => {
      clearInterval(sampler);
      const durationMs = Date.now() - startedAt;
      setTimeout(() => {
        const table = processTable();
        const leftovers = [];
        if (table !== null) {
          for (const [pid, command] of descendants) {
            const now = table.get(pid);
            if (now !== undefined && now.command === command) leftovers.push({ pid, name: shortName(command) });
          }
        }
        for (const entry of leftovers) {
          try {
            process.kill(entry.pid, 'SIGKILL');
          } catch {
            // 이미 끝났다.
          }
        }
        resolve({ label: step.label, code, signal, durationMs, leftovers, sampled: table !== null });
      }, LEFTOVER_GRACE_MS);
    });
  });
}

const argv = process.argv.slice(2);
const firstOption = argv.findIndex((arg) => arg.startsWith('--'));
const suiteArgs = firstOption < 0 ? argv : argv.slice(0, firstOption);
const forwarded = firstOption < 0 ? [] : argv.slice(firstOption);
const suites = suiteArgs.length === 0 ? ['wire', 'mesh', 'room', 'mcp', 'install', 'scenarios'] : suiteArgs;

const steps = [];
for (const suite of suites) {
  const planned = plan(suite.replace(/\/+$/, ''), forwarded);
  if (planned === null) {
    process.stderr.write(`모르는 묶음: ${suite}\n쓸 수 있는 것: wire, mesh, room, mcp, install, scenarios, ${scenarioNames().map((name) => `scenarios/${name}`).join(', ')}\n`);
    process.exit(2);
  }
  steps.push(...planned);
}

const results = [];
for (const step of steps) results.push(await runOne(step));

process.stdout.write('\n=== test:e2e 요약 ===\n');
for (const result of results) {
  const ok = result.code === 0 && result.leftovers.length === 0;
  const left = result.leftovers.length === 0 ? '' : `, 남은 프로세스 ${result.leftovers.length}개(지움): ${result.leftovers.map((entry) => entry.name).join(', ')}`;
  const sampled = result.sampled ? '' : ', 프로세스 표를 읽지 못함';
  process.stdout.write(`${ok ? '통과' : '실패'}  ${result.label}  종료 코드 ${result.code ?? result.signal}, ${(result.durationMs / 1000).toFixed(1)}초${left}${sampled}\n`);
}
const failed = results.filter((result) => result.code !== 0 || result.leftovers.length > 0);
process.stdout.write(`묶음 ${results.length}개: 통과 ${results.length - failed.length}, 실패 ${failed.length}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
