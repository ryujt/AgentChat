// V-L1 을 이 PC 에서 한 번에 돌린다: 자체 호스팅 서버를 띄워 와이어 계약 테스트를 실행하고,
// 이어서 서버 진입점 시험, 결함 주입(F-01~F-14), 시험용 프록시의 자체 시험을 실행한다.
//
// 쓰는 법:
//   node tests/wire/run-local.mjs                 # 넷 다 (3분쯤 걸린다. F-06 이 100초다)
//   node tests/wire/run-local.mjs --only wire     # 하나만 (wire | entry | faults | proxy)
//
// 서버는 기본 옵션으로, 127.0.0.1 의 빈 포트에 띄운다. 빌드 결과는 dist 에서 읽고, 다른 폴더면 AGENT_CHAT_DIST 로 준다.
// 끝날 때 자기가 띄운 프로세스가 남지 않았는지 확인한다. 하나라도 실패하면 종료 코드 1 이다.

import path from 'node:path';
import { REPO_ROOT, createProcTracker } from '../support/proc.mjs';
import { argValue } from './wire-client.mjs';

const only = argValue('only') ?? 'all';
const wants = (name) => only === 'all' || only === name;
const here = path.join(REPO_ROOT, 'tests', 'wire');
const procs = createProcTracker({ label: 'v-l1' });
const results = [];

function note(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '통과' : '실패'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

/** 시험 파일 하나를 자식 프로세스로 돌리고 출력을 그대로 흘려보낸다. */
async function runTestFile(name, args, timeoutMs) {
  const child = procs.spawnNode(args[0], args.slice(1), { name, stdin: 'ignore' });
  let shown = { stdout: 0, stderr: 0 };
  const pump = setInterval(() => {
    for (const stream of ['stdout', 'stderr']) {
      const text = child[stream]();
      if (text.length > shown[stream]) {
        process[stream].write(text.slice(shown[stream]));
        shown[stream] = text.length;
      }
    }
  }, 100);
  try {
    const exit = await child.waitForExit({ timeoutMs });
    return exit;
  } catch (error) {
    child.killTree('SIGKILL');
    return { code: null, signal: 'timeout', durationMs: timeoutMs, error };
  } finally {
    clearInterval(pump);
    for (const stream of ['stdout', 'stderr']) process[stream].write(child[stream]().slice(shown[stream]));
  }
}

try {
  if (wants('wire')) {
    const server = procs.spawnDist('entry/server.js', ['--host', '127.0.0.1', '--port', '0'], { name: 'server', stdin: 'ignore' });
    const ready = await server.waitForOutput(/listening on (ws:\/\/\S+)/, { timeoutMs: 10_000 });
    const url = ready[1];
    const exit = await runTestFile('wire-contract', [path.join(here, 'wire-contract.mjs'), '--url', url], 240_000);
    note('와이어 계약 (deployment.md 2.11 의 2~15번)', exit.code === 0, `종료 코드 ${exit.code}, ${Math.round(exit.durationMs / 100) / 10}초`);

    const stopped = await server.stop({ signal: 'SIGTERM', timeoutMs: 5_000 });
    note('서버가 SIGTERM 에 5초 안에 종료 코드 0 으로 끝난다', stopped.code === 0 && !stopped.forced, `코드 ${stopped.code}, ${stopped.stopMs}ms`);
    note('서버의 stderr 가 비어 있다(미처리 예외 없음)', server.stderr().trim() === '', `${server.stderr().length}바이트`);
  }

  if (wants('entry')) {
    const exit = await runTestFile('server-entry', ['--test', path.join(here, 'server-entry.test.mjs')], 120_000);
    note('서버 진입점(실행 옵션, 준비 문구, 종료, 로그 출력)', exit.code === 0, `종료 코드 ${exit.code}, ${Math.round(exit.durationMs / 100) / 10}초`);
  }

  if (wants('faults')) {
    const exit = await runTestFile('fault-injection', ['--test', '--test-concurrency=1', path.join(here, 'fault-injection.mjs')], 540_000);
    note('결함 주입 F-01~F-14 (verification-plan.md 6절)', exit.code === 0, `종료 코드 ${exit.code}, ${Math.round(exit.durationMs / 100) / 10}초`);
  }

  if (wants('proxy')) {
    const exit = await runTestFile('signal-proxy', ['--test', path.join(here, 'signal-proxy.test.mjs')], 120_000);
    note('시험용 시그널링 프록시 자체 시험', exit.code === 0, `종료 코드 ${exit.code}, ${Math.round(exit.durationMs / 100) / 10}초`);
  }

  try {
    await procs.assertNoneLeft({ graceMs: 2_000 });
    note('띄운 프로세스가 남지 않았다', true, '');
  } catch (error) {
    note('띄운 프로세스가 남지 않았다', false, error.message);
  }
} finally {
  const killed = await procs.dispose();
  if (killed.length > 0) note('정리하면서 죽여야 했던 프로세스가 없다', false, killed.map((entry) => `${entry.name}(pid ${entry.pid})`).join(', '));
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\nV-L1: ${results.length - failed.length}/${results.length} 통과\n`);
process.exitCode = failed.length === 0 && results.length > 0 ? 0 : 1;
