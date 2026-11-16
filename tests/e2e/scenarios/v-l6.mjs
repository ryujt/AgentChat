#!/usr/bin/env node
// V-L6: 조립한 MCP 프로세스 6개를 동시에 입장 (verification-plan.md 3.2, 시나리오 S8).
// 전원이 서로 연결된다. 쌍마다 링크가 하나다. 정원에서 하나 모자란 방에 3개가 동시에 들어오면 정원을 넘지 않는다(통과 1 이하).
//
// 구성: 한 프로세스가 방을 만들고, 6개가 동시에 join_room 한다(방에 7명 = 정원 8 − 1). 이어서 3개가 동시에 join_room 한다(3회).
// 실행: node tests/e2e/scenarios/v-l6.mjs [--server <주소>] [--ice none] [--rounds <정원 시험 회차, 기본 3>]

import { argValue, createReport, delay, errorSummary, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';
import { distUrl } from '../../support/proc.mjs';

const { LIMITS } = await import(distUrl('protocol/index.js'));
const options = scenarioOptions();
const ROUNDS = Number(argValue(options.rest, 'rounds', '3'));
const report = createReport(`V-L6 (${options.server ?? '자체 호스팅'})`);
let stack = null;

async function run() {
  stack = await startStack({ label: 'v-l6', proxy: true, ...options });
  const room = newRoomId();
  const host = await stack.agent('host');
  await host.ok('create_room', { room_id: room });
  host.pump();
  const joiners = [];
  for (let i = 1; i <= 6; i += 1) joiners.push(await stack.agent(`peer${i}`));
  const startedAt = Date.now();
  const results = await Promise.all(joiners.map((agent) => agent.call('join_room', { room_id: room }, { timeoutMs: 60_000 })));
  const joinMs = Date.now() - startedAt;
  report.check('L6-01', results.every((reply) => !reply.isError), '6개가 동시에 join_room: 모두 성공', { ms: joinMs, results: results.map(errorSummary) });
  for (const agent of joiners) agent.pump();
  const everyone = [host, ...joiners];
  const meshed = await until(
    async () => {
      for (const agent of everyone) {
        const status = await agent.status();
        if (status.participants.filter((row) => row.link === 'open').length !== everyone.length - 1) return false;
      }
      return true;
    },
    '7명 전원 mesh',
    30_000,
    250,
  ).then(
    () => Date.now() - startedAt,
    () => null,
  );
  report.check('L6-02', meshed !== null, '전원이 서로 연결된다(7명, 21쌍)', { ms_from_join: meshed });
  await delay(500);
  // 쌍마다 링크가 하나다: 각자의 진단 로그에서 피어마다 열린 시도(link.attempt_end{ok})가 하나이고 닫힌 링크가 없다.
  const duplicates = [];
  for (const agent of everyone) {
    const opened = agent.logs('link.attempt_end').filter((line) => line.outcome === 'ok');
    const closed = agent.logs('link.closed');
    for (const other of everyone) {
      if (other === agent) continue;
      const count = opened.filter((line) => line.peer === other.name).length;
      if (count !== 1) duplicates.push(`${agent.name}→${other.name}:${count}`);
    }
    if (closed.length > 0) duplicates.push(`${agent.name}: closed ${closed.length}`);
  }
  report.check('L6-03', duplicates.length === 0, '쌍마다 링크가 하나다(피어마다 열린 시도 1건, 닫힌 링크 0건)', duplicates);
  if (stack.selfHosted) {
    const stats = stack.proxy.stats();
    report.note(`시그널 수(c2s, 버린 것 포함): 가장 큰 signal ${stats.maxSignalBytes}바이트, 보낸 쌍·종류 ${Object.keys(stats.signals).length}가지`);
  }

  // 정원에서 하나 모자란 방(7명)에 3개가 동시에 들어온다.
  const capacity = LIMITS.ROOM_MAX_PEERS;
  const rounds = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const extras = [];
    for (let i = 1; i <= 3; i += 1) extras.push(await stack.agent(`late${round}x${i}`));
    const replies = await Promise.all(extras.map((agent) => agent.call('join_room', { room_id: room }, { timeoutMs: 60_000 })));
    const passed = replies.filter((reply) => !reply.isError).length;
    // 서버 쪽: 그 순간 등록된 이름 수(서버 로그). 정원을 넘지 않는다.
    const names = [...everyone, ...extras].map((agent) => agent.name);
    const registered = stack.selfHosted ? names.filter((name) => stack.registered(name)).length : null;
    const views = await Promise.all(everyone.map(async (agent) => (await agent.status()).participants.filter((row) => row.link === 'open').length + 1));
    rounds.push({ round, passed, results: replies.map(errorSummary), registered, max_view: Math.max(...views) });
    for (const [index, agent] of extras.entries()) {
      if (!replies[index].isError) await agent.ok('leave_room');
      await agent.close();
    }
    await until(async () => {
      for (const agent of everyone) if ((await agent.status()).participants.filter((row) => row.link === 'open').length !== everyone.length - 1) return false;
      return stack.selfHosted ? names.filter((name) => stack.registered(name)).length === everyone.length : true;
    }, '7명으로 돌아옴', 20_000, 250).catch(() => {});
  }
  report.check(
    'L6-04',
    rounds.every((row) => row.passed <= 1 && (row.registered === null || row.registered <= capacity) && row.max_view <= capacity),
    `정원 ${capacity} 에서 하나 모자란 방에 3개가 동시에 입장 ${ROUNDS}회: 매회 통과 1 이하, 정원을 넘지 않는다`,
    rounds,
  );
  for (const agent of everyone) {
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
