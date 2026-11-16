#!/usr/bin/env node
// V-L4: 조립한 MCP 프로세스 4개 중 하나를 SIGKILL, SIGSTOP (verification-plan.md 3.2, 시나리오 S5·S7).
// 나머지가 15초 안에 disconnected 로 표시한다. 나머지끼리의 채팅이 유지된다. 같은 이름으로 다시 들어온 프로세스가 목표와 역할 현황을 받는다.
// 그 뒤 새로 입장한 참가자가 죽은 참가자를 disconnected 로 본다.
// 한 쌍만 끊긴 상태(부분 mesh. 프록시로 만든다)에서 한쪽이 기록을 쓰고 떠난 뒤, 남은 둘의 지문이 45초 안에 같아진다(35초 + 여유 10초).
//
// 실행: node tests/e2e/scenarios/v-l4.mjs [--ice none]
// 부분 mesh 는 프록시가 필요하다. 자체 호스팅에서만 그 항목을 한다(--server 를 주면 미실행으로 적는다).

import { readFileSync } from 'node:fs';
import { createReport, delay, enterAll, errorSummary, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';

const options = scenarioOptions();
const report = createReport(`V-L4 (${options.server ?? '자체 호스팅'})`);
const DEAD_LIMIT_MS = 15_000;
const CONVERGE_LIMIT_MS = 45_000;
let stack = null;

/**
 * 그 참가자가 peer 를 끊긴 것으로 본 시각(since 부터 ms).
 * 판정 시각은 관찰자 자신의 진단 로그 link.closed 의 ts 다(같은 PC 의 같은 시계). 수신함 사건이 이 시험 프로세스에 닿은 시각(event)도 함께 낸다.
 * last_alive_age_ms 는 관찰자가 본 마지막 생존 증거에서 판정까지의 시간이다.
 */
async function disconnectedAt(agent, peer, since, timeoutMs = 25_000) {
  const event = await agent
    .event((e) => e.kind === 'peer' && e.from === peer && e.change === 'disconnected' && e.seenAt >= since, { timeoutMs, what: `${peer} disconnected 사건` })
    .catch(() => null);
  const closed = await until(
    () => agent.logs('link.closed').find((line) => line.peer === peer && Date.parse(line.ts) >= since - 1),
    'link.closed 줄',
    3_000,
    50,
  ).catch(() => null);
  return {
    ms: closed === null ? null : Date.parse(closed.ts) - since,
    reason: closed?.reason ?? null,
    last_alive_age_ms: closed?.last_alive_age_ms ?? null,
    event_ms: event === null ? null : event.seenAt - since,
  };
}

/** 보고서 파일의 "상태 지문"(12자리). write_report 를 불러 만든다. */
async function fingerprintOf(agent) {
  const written = await agent.call('write_report');
  if (written.isError) return null;
  const text = readFileSync(written.json.path, 'utf8');
  const match = /상태 지문:\s*`?([0-9a-f]{12})`?/.exec(text);
  return match === null ? null : match[1];
}

async function killCase() {
  const room = newRoomId();
  const agents = [];
  for (const name of ['anna', 'bert', 'cara', 'dave']) agents.push(await stack.agent(name));
  const [anna, bert, cara, dave] = agents;
  await enterAll(agents, room);
  const request = 'V-L4 target: keep the room alive';
  await anna.ok('start_test', { request, max_duration_min: 30 });
  for (const [index, agent] of agents.entries()) await agent.ok('set_status', { status: 'working', role: `role-${agent.name}-${index}` });
  // 모두가 서로의 역할을 볼 때까지(스냅샷에 들어가게).
  await until(async () => {
    for (const agent of agents) {
      const status = await agent.status();
      if (status.participants.filter((row) => row.role?.startsWith('role-') && row.link === 'open').length !== 3) return false;
    }
    return true;
  }, '역할 공유', 15_000, 200);

  await dave.stopPump();
  const killedAt = Date.now();
  await dave.kill();
  const times = await Promise.all([anna, bert, cara].map((agent) => disconnectedAt(agent, 'dave', killedAt)));
  report.check(
    'L4-01',
    times.every((row) => row.ms !== null && row.ms <= DEAD_LIMIT_MS && row.event_ms !== null),
    `SIGKILL: 나머지 셋이 ${DEAD_LIMIT_MS / 1000}초 안에 dave 를 disconnected 로 본다(관찰자 로그의 link.closed 시각)`,
    times,
  );
  const shown = await Promise.all([anna, bert, cara].map(async (agent) => (await agent.participant('dave'))?.shown_as));
  report.check('L4-02', shown.every((value) => value === 'disconnected'), 'get_status 의 dave 는 disconnected(준비 완료로 보이지 않는다)', shown);

  const chat = await anna.ok('send_message', { text: 'still talking after kill' });
  report.check(
    'L4-03',
    chat.delivered.includes('bert') && chat.delivered.includes('cara') && !chat.delivered.includes('dave'),
    '나머지끼리의 채팅이 유지된다',
    { delivered: chat.delivered, undelivered: chat.undelivered },
  );

  // 같은 이름으로 다시 들어온다(새 프로세스).
  const dave2 = await stack.agent('dave', { label: 'dave-2' });
  const rejoined = await dave2.ok('join_room', { room_id: room });
  dave2.pump();
  const roles = Object.fromEntries(rejoined.participants.map((row) => [row.name, row.role]));
  report.check(
    'L4-04',
    rejoined.test?.request === request &&
      rejoined.test.by === 'anna' &&
      roles.anna === 'role-anna-0' &&
      roles.bert === 'role-bert-1' &&
      roles.cara === 'role-cara-2' &&
      rejoined.participants.every((row) => row.link === 'open'),
    '재입장자가 join_room 결과로 현재 목표(요청문·요청자)와 참가자별 역할을 받는다',
    { test_by: rejoined.test?.by, remaining_min: rejoined.test?.remaining_min, roles },
  );

  // cara 를 죽인 뒤 새 참가자가 들어온다. 그는 cara 를 disconnected 로 본다(presence 는 스냅샷에 있다).
  const caraKilledAt = Date.now();
  await cara.kill();
  await until(() => stack.selfHosted ? stack.registered('cara') === false : true, '서버가 cara 기록을 지움', 5_000, 50).catch(() => {});
  const erin = await stack.agent('erin');
  const erinJoined = await erin.call('join_room', { room_id: room });
  const caraRow = erinJoined.json?.participants?.find((row) => row.name === 'cara');
  report.check(
    'L4-05',
    !erinJoined.isError && caraRow?.shown_as === 'disconnected' && caraRow.status === 'working' && caraRow.role === 'role-cara-2',
    '그 뒤 새로 입장한 참가자는 죽은 참가자를 disconnected 로 본다(presence 의 working·역할이 살아 있는 것으로 보이지 않는다)',
    { result: errorSummary(erinJoined), cara: caraRow, after_kill_ms: Date.now() - caraKilledAt },
  );
  erin.pump();
  for (const agent of [anna, bert, dave2, erin]) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

async function stopCase() {
  const room = newRoomId();
  const agents = [];
  for (const name of ['amos', 'beth', 'carl', 'dora']) agents.push(await stack.agent(name));
  const [amos, beth, carl, dora] = agents;
  await enterAll(agents, room);
  await until(async () => (await amos.status()).participants.filter((row) => row.link === 'open').length === 3, 'mesh', 15_000, 200);
  await dora.stopPump();
  const stoppedAt = Date.now();
  dora.pause();
  try {
    const times = await Promise.all([amos, beth, carl].map((agent) => disconnectedAt(agent, 'dora', stoppedAt)));
    report.check(
      'L4-06',
      times.every((row) => row.ms !== null && row.ms <= DEAD_LIMIT_MS && row.event_ms !== null),
      `SIGSTOP: 나머지 셋이 ${DEAD_LIMIT_MS / 1000}초 안에 dora 를 disconnected 로 본다(관찰자 로그의 link.closed 시각)`,
      times,
    );
    const chat = await beth.ok('send_message', { text: 'still talking while stopped' });
    report.check('L4-07', chat.delivered.includes('amos') && chat.delivered.includes('carl'), 'SIGSTOP 중에도 나머지끼리의 채팅이 유지된다', {
      delivered: chat.delivered,
      undelivered: chat.undelivered,
    });
  } finally {
    dora.resume();
  }
  // 다시 깨어난 참가자는 링크를 다시 맺는다(S6 의 복구와 같은 길). 판정 항목은 아니고 관찰로 남긴다.
  const back = await until(async () => (await amos.participant('dora'))?.link === 'open', 'dora 재연결', 40_000, 500).then(
    () => true,
    () => false,
  );
  report.note(`SIGCONT 뒤 dora 가 amos 와 다시 이어졌는가: ${back}`);
  for (const agent of agents) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

async function convergeCase() {
  const room = newRoomId();
  const amy = await stack.agent('amy');
  const cyd = await stack.agent('cyd');
  const ben = await stack.agent('ben');
  await amy.ok('create_room', { room_id: room });
  amy.pump();
  await cyd.ok('join_room', { room_id: room });
  cyd.pump();
  await cyd.ok('start_test', { request: 'V-L4 partial mesh', max_duration_min: 60 });
  // amy 의 시그널링만 끊는다. 그 사이 ben 이 들어온다(목록에 amy 가 없다).
  stack.proxy.block('amy');
  await until(() => stack.registered('amy') === false, 'amy 등록 해제', 5_000, 50);
  await ben.ok('join_room', { room_id: room });
  ben.pump();
  const drop = stack.proxy.addRule({ pair: ['amy', 'ben'], action: 'signal', op: 'drop' });
  stack.proxy.unblock('amy');
  await until(() => stack.registered('amy') === true, 'amy 재등록', 45_000, 200);
  // amy 와 ben 사이에는 링크가 없다(주입의 증거). amy 는 ben 을 목록에서 보고 접촉을 시도한다.
  await until(() => drop.hits > 0, 'amy–ben 시그널을 버림', 20_000, 200);
  const before = { amy: (await amy.participant('ben'))?.link, ben: (await ben.participant('amy'))?.link };

  // ben 이 기록을 쓰고 떠난다.
  const scenario = await ben.ok('start_scenario', { title: 'partial mesh scenario' });
  await ben.ok('record_claim', { scenario_id: scenario.scenario_id, action: 'clicked', observed: 'saw', outcome: 'pass', steps: '1. click' });
  await ben.ok('set_status', { status: 'ready', role: 'leaving soon' });
  await delay(300);
  await ben.stopPump();
  await ben.ok('leave_room');
  const leftAt = Date.now();
  let same = null;
  let last = null;
  while (Date.now() - leftAt <= CONVERGE_LIMIT_MS + 5_000) {
    const [a, c] = await Promise.all([fingerprintOf(amy), fingerprintOf(cyd)]);
    last = { amy: a, cyd: c };
    if (a !== null && a === c) {
      same = Date.now() - leftAt;
      break;
    }
    await delay(1_000);
  }
  const after = (await amy.participant('ben'))?.link;
  report.check(
    'L4-08',
    same !== null && same <= CONVERGE_LIMIT_MS && before.amy !== 'open' && before.ben !== 'open' && after !== 'open',
    `한 쌍(amy–ben)만 끊긴 상태에서 ben 이 기록을 쓰고 떠난 뒤, amy 와 cyd 의 지문이 ${CONVERGE_LIMIT_MS / 1000}초 안에 같아진다`,
    { ms: same, links_before: before, link_after: after, dropped: drop.hits, last_fingerprints_equal: last?.amy === last?.cyd },
  );
  const resync = cyd.logs('state.resync').filter((line) => line.cause !== undefined && line.peer === 'amy' && Date.parse(line.ts) >= leftAt);
  report.note(`ben 이 떠난 뒤 cyd 의 amy 쪽 state.resync(계기 있는 줄): ${resync.map((line) => line.cause).join(',') || '없음'}`);
  drop.remove();
  for (const agent of [amy, cyd]) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
  await ben.close();
}

async function run() {
  stack = await startStack({ label: 'v-l4', proxy: true, ...options });
  await killCase();
  await stopCase();
  if (stack.selfHosted) await convergeCase();
  else report.skip('L4-08', '부분 mesh 의 지문 수렴', '프록시는 자체 호스팅에서만 쓸 수 있다');
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
