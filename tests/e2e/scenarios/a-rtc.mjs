#!/usr/bin/env node
// 가정 확인 A-RTC-4, A-RTC-6 (verification-plan.md 2.1). 조립한 MCP 프로세스 8개로 본다. G5 의 넘어가는 조건이다.
//   A-RTC-4: 8 피어 mesh 가 한 번에 서는가. 8 프로세스가 20초 안에 전원 연결. 연결별 시그널 수 60초 300건 이하. 쌍마다 보낸 시그널 수를 기록한다.
//   A-RTC-6: 종료 예산 안에 bye 가 도착하고 프로세스가 끝나는가. 링크 7개에서 30회: bye 수신 100%, 종료 400ms 이하.
//
// 구성: 한 프로세스가 방을 만들고 7개가 동시에 join_room 한다. 이어서 매회 한 참가자에게 SIGTERM 을 보내고(링크 7개),
//       나머지 7명의 진단 로그에서 그 참가자와의 링크가 bye{shutdown} 으로 닫혔는지 본다. 같은 이름의 새 프로세스로 다시 채운다.
//       덧붙여 서버를 멈춘 채(SIGSTOP) 보내는 경로(세션 정리가 예산을 넘는 경로)를 몇 회 잰다.
// 실행: node tests/e2e/scenarios/a-rtc.mjs [--ice none] [--repeat <A-RTC-6 회차, 기본 30>] [--forced <서버를 멈춘 회차, 기본 5>]
// 자체 호스팅에서만 돈다(프록시로 시그널을 세고 서버를 멈춘다).

import { argValue, createReport, delay, errorSummary, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';
import { distUrl } from '../../support/proc.mjs';

const { LIMITS } = await import(distUrl('protocol/index.js'));
const { DEFAULT_MCP_SERVER_LIMITS } = await import(distUrl('mcp-server/index.js'));
const options = scenarioOptions();
const REPEAT = Number(argValue(options.rest, 'repeat', '30'));
const FORCED = Number(argValue(options.rest, 'forced', '5'));
const BUDGET_MS = DEFAULT_MCP_SERVER_LIMITS.SHUTDOWN_BUDGET_MS;
const report = createReport(`A-RTC-4·6 (${options.server ?? '자체 호스팅'})`);
let stack = null;

async function openCount(agent) {
  return (await agent.status()).participants.filter((row) => row.link === 'open').length;
}

async function run() {
  stack = await startStack({ label: 'a-rtc', proxy: true, ...options });
  if (!stack.selfHosted) {
    report.skip('A-RTC-4·6', '8 피어 mesh 와 종료 bye', '자체 호스팅에서만 한다');
    return;
  }
  const room = newRoomId();
  const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const agents = new Map();
  for (const name of names) agents.set(name, await stack.agent(name));
  const first = agents.get('p1');
  await first.ok('create_room', { room_id: room });
  first.pump();
  const rest = names.slice(1).map((name) => agents.get(name));
  const startedAt = Date.now();
  const signalsBefore = stack.proxy.stats().signals;
  const replies = await Promise.all(rest.map((agent) => agent.call('join_room', { room_id: room }, { timeoutMs: 60_000 })));
  for (const agent of rest) agent.pump();
  const meshed = await until(
    async () => {
      for (const agent of agents.values()) if ((await openCount(agent)) !== 7) return false;
      return true;
    },
    '8명 전원 mesh',
    40_000,
    200,
  ).then(
    () => Date.now() - startedAt,
    () => null,
  );
  report.check(
    'A-RTC-4a',
    replies.every((reply) => !reply.isError) && meshed !== null && meshed <= LIMITS.JOIN_MESH_TIMEOUT_MS,
    `8 프로세스(1개가 만들고 7개가 동시에 입장)가 ${LIMITS.JOIN_MESH_TIMEOUT_MS / 1000}초 안에 전원 연결(28쌍)`,
    { ms: meshed, results: replies.map(errorSummary) },
  );
  // 60초 창의 연결별 시그널 수. 입장 시작부터 60초가 지난 때의 누계를 본다.
  await delay(Math.max(0, startedAt + 60_000 - Date.now()));
  const signals = stack.proxy.stats().signals;
  const perSender = {};
  const perPair = {};
  for (const [key, count] of Object.entries(signals)) {
    const before = signalsBefore[key] ?? 0;
    const added = count - before;
    if (added <= 0) continue;
    const [pair, kind] = key.split(':');
    const [from, to] = pair.split('>');
    perSender[from] = (perSender[from] ?? 0) + added;
    const pairKey = [from, to].sort().join('–');
    perPair[pairKey] ??= {};
    perPair[pairKey][kind] = (perPair[pairKey][kind] ?? 0) + added;
  }
  const maxPerSender = Math.max(...Object.values(perSender));
  report.check('A-RTC-4b', maxPerSender <= LIMITS.RATE_MAX_MESSAGES, `연결별 시그널 수가 60초에 ${LIMITS.RATE_MAX_MESSAGES}건 이하`, { per_sender: perSender, max: maxPerSender });
  const pairTotals = Object.values(perPair).map((kinds) => Object.values(kinds).reduce((sum, n) => sum + n, 0));
  report.note(`쌍마다 보낸 시그널 수(28쌍): 최소 ${Math.min(...pairTotals)}, 최대 ${Math.max(...pairTotals)}, 합 ${pairTotals.reduce((a, b) => a + b, 0)}`);
  report.note(`쌍별 상세: ${JSON.stringify(perPair)}`);
  report.note(`가장 큰 signal 메시지: ${stack.proxy.stats().maxSignalBytes}바이트(상한 ${LIMITS.SIGNAL_MAX_MESSAGE_BYTES})`);

  // ── A-RTC-6 ──────────────────────────────────────────────────────────────
  const rows = [];
  let serial = 0;
  /**
   * name 에게 SIGTERM 을 보내고 같은 이름의 새 프로세스로 다시 채운다.
   * pauseServer: 서버를 멈춘 채 보낸다. 그 참가자가 서버에 바로 붙어 있어야 leave 의 닫는 악수가 끝나지 않는다(프록시는 멈추지 않는다).
   * respawnDirect: 새 프로세스를 프록시 없이 서버에 바로 붙인다.
   */
  async function rotate(name, { pauseServer = false, respawnDirect = false } = {}) {
    serial += 1;
    const index = serial;
    const victim = agents.get(name);
    const others = [...agents.values()].filter((agent) => agent !== victim);
    const links = await openCount(victim);
    await victim.stopPump();
    await delay(150);
    if (pauseServer) stack.pauseServer();
    const sentAt = Date.now();
    let stopped;
    try {
      stopped = await victim.stop('SIGTERM');
    } finally {
      if (pauseServer) stack.resumeServer();
    }
    const bye = await until(
      () => others.every((agent) => agent.logs('link.closed').some((line) => line.peer === name && line.reason === 'bye_shutdown' && Date.parse(line.ts) >= sentAt - 5)),
      'bye 수신',
      3_000,
      50,
    ).then(
      () => others.length,
      () => others.filter((agent) => agent.logs('link.closed').some((line) => line.peer === name && line.reason === 'bye_shutdown' && Date.parse(line.ts) >= sentAt - 5)).length,
    );
    const line = victim.logs('shutdown').at(-1);
    rows.push({ name, links, stopMs: stopped.stopMs, code: stopped.code, bye, receivers: others.length, forced: line?.forced ?? null, closed_ms: line?.duration_ms ?? null, paused: pauseServer });
    // 같은 이름의 새 프로세스로 다시 채운다.
    await until(() => stack.registered(name) === false, `${name} 등록 해제`, 5_000, 50).catch(() => {});
    const fresh = await stack.agent(name, { label: `${name}-r${index}`, env: respawnDirect ? { AGENT_CHAT_SERVER: stack.server.url } : {} });
    const rejoined = await fresh.call('join_room', { room_id: room }, { timeoutMs: 60_000 });
    if (rejoined.isError) throw new Error(`${name} 다시 입장 실패: ${errorSummary(rejoined)}`);
    fresh.pump();
    agents.set(name, fresh);
    await until(
      async () => {
        for (const agent of agents.values()) if ((await openCount(agent)) !== 7) return false;
        return true;
      },
      '다시 8명 mesh',
      30_000,
      200,
    );
  }
  for (let i = 0; i < REPEAT; i += 1) await rotate(names[i % names.length]);
  const normal = rows.filter((row) => !row.paused);
  const byeTotal = normal.reduce((sum, row) => sum + row.bye, 0);
  const receivers = normal.reduce((sum, row) => sum + row.receivers, 0);
  report.check(
    'A-RTC-6',
    normal.length === REPEAT && normal.every((row) => row.links === 7 && row.code === 0 && row.stopMs <= BUDGET_MS) && byeTotal === receivers,
    `링크 7개에서 SIGTERM ${REPEAT}회: bye 수신 ${byeTotal}/${receivers}, 종료 ${BUDGET_MS}ms 이하, 종료 코드 0`,
    { stop_ms: normal.map((row) => row.stopMs), max: Math.max(...normal.map((row) => row.stopMs)), links: [...new Set(normal.map((row) => row.links))] },
  );
  // 서버를 멈추는 회차의 대상은 먼저 서버에 바로 붙은 프로세스로 바꿔 둔다(이 교체는 위 판정에 넣지 않는다).
  const forcedNames = names.slice(0, FORCED);
  const prepared = rows.length;
  for (const name of forcedNames) await rotate(name, { respawnDirect: true });
  rows.splice(prepared);
  for (const name of forcedNames) await rotate(name, { pauseServer: true });
  const paused = rows.filter((row) => row.paused);
  report.check(
    'A-RTC-6b',
    paused.every((row) => row.code === 0 && row.stopMs <= BUDGET_MS),
    `서버를 멈춘 채(세션 정리가 예산을 넘는 경로) 링크 7개에서 SIGTERM ${FORCED}회: 종료 ${BUDGET_MS}ms 이하, 종료 코드 0`,
    paused.map((row) => ({ ms: row.stopMs, forced: row.forced, closed_ms: row.closed_ms, bye: `${row.bye}/${row.receivers}` })),
  );
  for (const agent of agents.values()) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
