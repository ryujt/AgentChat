#!/usr/bin/env node
// V-L9: 조립한 MCP 프로세스 4개, 130분 장시간 시험 (verification-plan.md 3.2 "V-L9 장시간 판정 기준", 실행 전에 고정).
//
// ── 실행 방법 (기본 실행기 `npm run test:e2e` 에는 들지 않는다. 이름으로만 돈다) ─────────────
//
//   npm run build
//   TMPDIR=<임시 폴더> nohup node tests/e2e/scenarios/v-l9.mjs > <임시 폴더>/v-l9.log 2>&1 &
//   또는: npm run test:e2e -- scenarios/v-l9
//   [--minutes 130]   전체 시간(분). 130 보다 짧으면 끝에 "장시간 검증 아님"을 적는다(통과로 보고하지 않는다)
//   [--warmup 5]      워밍업(분). RSS 기준은 워밍업 직후의 값이다
//   [--ice none]      host 후보만(기본은 제품 기본값: 공개 STUN)
//   [--rejoin-every 10] [--cut-every 30]   주입 주기(분). 스크립트를 짧게 확인할 때만 바꾼다. 판정 기준의 주기는 기본값이다
//   진행은 60초마다 [표본] 줄로 나온다. 끝나면 판정 줄과 요약이 나온다. 종료 코드: 실패가 없으면 0.
//   자체 호스팅 서버와 프록시를 빈 포트로 띄운다(서버 쪽 소켓 끊기를 프록시로 한다). 공용 서버로는 돌지 않는다(V-P4 는 따로 있다).
//
// ── 부하와 주입 ──────────────────────────────────────────────────────────────
//
//   참가자마다 10초에 채팅 1건(방 전체). 10분마다 한 참가자(돌아가며)의 퇴장·재입장(같은 프로세스. leave_room → join_room).
//   30분마다 서버 쪽 소켓 끊기(프록시가 모든 연결을 끊는다). 테스트 하나를 480분 제한으로 시작해 두고 끝에 보고서의 지문을 견준다.
//
// ── 통과 조건 ────────────────────────────────────────────────────────────────
//
//   예상 밖 링크 종료 0건(퇴장·재입장의 bye 로 닫힌 것은 뺀다). 보낸 채팅 = 받은 채팅(ack_timeout·not_connected 로 보고된 것은 뺀다.
//   받은 것은 delivered ⊆ 받은 참가자 ⊆ delivered ∪ ack_timeout, 중복 없음). 프로세스별 RSS 가 워밍업 직후 대비 20% 넘게 늘지 않음.
//   주입 뒤 60초 안에 mesh 회복(4명 모두 링크 3개 open, 시그널링 connected). 끝났을 때 모든 참가자의 상태 지문이 같음.
//   주입이 실제로 일어났다는 로그(퇴장·재입장의 bye, 프록시가 끊은 연결과 서버의 재등록)가 없으면 통과가 아니다.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argValue, createReport, delay, enterAll, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';

const options = scenarioOptions();
const MINUTES = Number(argValue(options.rest, 'minutes', '130'));
const WARMUP_MIN = Number(argValue(options.rest, 'warmup', '5'));
const CHAT_EVERY_MS = 10_000;
const REJOIN_EVERY_MS = Number(argValue(options.rest, 'rejoin-every', '10')) * 60_000;
const CUT_EVERY_MS = Number(argValue(options.rest, 'cut-every', '30')) * 60_000;
const SAMPLE_EVERY_MS = 60_000;
const RECOVER_LIMIT_MS = 60_000;
const RSS_GROWTH_LIMIT = 0.2;
const report = createReport(`V-L9 (${MINUTES}분)`);
let stack = null;

function rssKb(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

async function fingerprintOf(agent) {
  const written = await agent.call('write_report');
  if (written.isError) return null;
  const match = /상태 지문:\s*`?([0-9a-f]{12})`?/.exec(readFileSync(written.json.path, 'utf8'));
  return match === null ? null : match[1];
}

async function run() {
  if (options.server !== null) {
    report.skip('L9', '장시간', '자체 호스팅에서만 돈다(공용 서버의 장시간은 V-P4)');
    return;
  }
  stack = await startStack({ label: 'v-l9', proxy: true, ...options });
  const room = newRoomId();
  const agents = [];
  for (const name of ['ana', 'ben', 'cat', 'dan']) agents.push(await stack.agent(name));
  await enterAll(agents, room);
  await agents[0].ok('start_test', { request: 'V-L9 long run', max_duration_min: 480, max_scenarios: 100 });
  const startedAt = Date.now();
  const endAt = startedAt + MINUTES * 60_000;
  const warmupEnd = startedAt + WARMUP_MIN * 60_000;

  const inRoom = new Set(agents.map((agent) => agent.name));
  /** 보낸 채팅: id → {from, delivered, undelivered} */
  const sent = new Map();
  const injections = [];
  const recoveries = [];
  const plannedCloses = []; // {at, name}
  const samples = [];
  let baseline = null;
  let stopping = false;

  async function meshRecovered() {
    for (const agent of agents) {
      const status = await agent.status();
      if (status.room.signaling !== 'connected') return false;
      if (status.participants.filter((row) => row.link === 'open').length !== agents.length - 1) return false;
    }
    return true;
  }

  async function recover(kind, at) {
    const ms = await until(meshRecovered, `${kind} 뒤 mesh 회복`, RECOVER_LIMIT_MS + 30_000, 500).then(
      () => Date.now() - at,
      () => null,
    );
    recoveries.push({ kind, ms });
    return ms;
  }

  const chatLoops = agents.map(async (agent, index) => {
    await delay(index * (CHAT_EVERY_MS / agents.length));
    let serial = 0;
    while (!stopping) {
      const due = Date.now() + CHAT_EVERY_MS;
      if (inRoom.has(agent.name)) {
        serial += 1;
        const reply = await agent.call('send_message', { text: `${agent.name} chat ${serial}` }).catch(() => null);
        if (reply !== null && !reply.isError) {
          sent.set(reply.json.message_id, { from: agent.name, delivered: reply.json.delivered, undelivered: reply.json.undelivered });
        }
      }
      await delay(Math.max(0, due - Date.now()));
    }
  });

  let nextRejoin = startedAt + REJOIN_EVERY_MS;
  let nextCut = startedAt + CUT_EVERY_MS;
  let nextSample = startedAt + SAMPLE_EVERY_MS;
  let rejoinIndex = 0;
  while (Date.now() < endAt) {
    const now = Date.now();
    if (now >= nextSample) {
      nextSample += SAMPLE_EVERY_MS;
      const rss = Object.fromEntries(agents.map((agent) => [agent.name, rssKb(agent.pid)]));
      const links = [];
      for (const agent of agents) links.push((await agent.status()).participants.filter((row) => row.link === 'open').length);
      samples.push({ at: Date.now() - startedAt, rss, links });
      if (baseline === null && Date.now() >= warmupEnd) baseline = rss;
      process.stdout.write(`[표본] ${Math.round((Date.now() - startedAt) / 60_000)}분 rss(KB)=${JSON.stringify(rss)} links=${links.join(',')} 보낸 채팅=${sent.size}\n`);
    }
    if (now >= nextRejoin) {
      nextRejoin += REJOIN_EVERY_MS;
      const agent = agents[rejoinIndex % agents.length];
      rejoinIndex += 1;
      const at = Date.now();
      inRoom.delete(agent.name);
      await agent.stopPump();
      await agent.ok('leave_room');
      plannedCloses.push({ at, name: agent.name });
      await agent.ok('join_room', { room_id: room });
      agent.pump();
      inRoom.add(agent.name);
      injections.push({ kind: 'rejoin', at: at - startedAt, who: agent.name });
      process.stdout.write(`[주입] 퇴장·재입장 ${agent.name}: 회복 ${await recover('rejoin', at)}ms\n`);
    }
    if (now >= nextCut) {
      nextCut += CUT_EVERY_MS;
      const at = Date.now();
      const before = stack.proxy.stats().connections;
      stack.proxy.disconnect();
      const ms = await recover('cut', at);
      const reconnected = stack.proxy.stats().connections - before;
      injections.push({ kind: 'cut', at: at - startedAt, reconnected });
      process.stdout.write(`[주입] 서버 쪽 소켓 끊기: 다시 붙은 연결 ${reconnected}개, 회복 ${ms}ms\n`);
    }
    await delay(1_000);
  }
  stopping = true;
  await Promise.all(chatLoops);
  await delay(CHAT_EVERY_MS);

  // ── 판정 ──
  const unexpected = [];
  for (const agent of agents) {
    for (const line of agent.logs('link.closed')) {
      const at = Date.parse(line.ts);
      const planned =
        ['bye_leave', 'leave'].includes(line.reason) ||
        plannedCloses.some((entry) => Math.abs(entry.at - at) < 5_000 && (entry.name === agent.name || entry.name === line.peer));
      if (!planned) unexpected.push({ who: agent.name, peer: line.peer, reason: line.reason });
    }
  }
  report.check('L9-01', unexpected.length === 0, '예상 밖 링크 종료 0건', unexpected.slice(0, 10));

  const mismatches = [];
  for (const [id, entry] of sent) {
    const receivers = agents.filter((agent) => agent.events.some((event) => event.kind === 'chat' && event.id === id)).map((agent) => agent.name);
    const duplicated = agents.some((agent) => agent.events.filter((event) => event.kind === 'chat' && event.id === id).length > 1);
    const allowed = new Set([...entry.delivered, ...entry.undelivered.filter((item) => item.reason === 'ack_timeout').map((item) => item.name)]);
    const ok = entry.delivered.every((name) => receivers.includes(name)) && receivers.every((name) => allowed.has(name)) && !duplicated;
    if (!ok) mismatches.push({ id, from: entry.from, delivered: entry.delivered.length, receivers: receivers.length, duplicated });
  }
  report.check('L9-02', mismatches.length === 0 && sent.size > 0, `보낸 채팅 = 받은 채팅(${sent.size}건)`, mismatches.slice(0, 10));

  const last = samples.at(-1)?.rss ?? {};
  const growth = Object.fromEntries(
    agents.map((agent) => [agent.name, baseline?.[agent.name] && last[agent.name] ? Math.round(((last[agent.name] - baseline[agent.name]) / baseline[agent.name]) * 1000) / 10 : null]),
  );
  report.check(
    'L9-03',
    baseline !== null && Object.values(growth).every((value) => value !== null && value <= RSS_GROWTH_LIMIT * 100),
    `프로세스별 RSS 가 워밍업 직후 대비 ${RSS_GROWTH_LIMIT * 100}% 넘게 늘지 않음`,
    { growth_percent: growth, baseline, last },
  );
  report.check(
    'L9-04',
    recoveries.length > 0 && recoveries.every((entry) => entry.ms !== null && entry.ms <= RECOVER_LIMIT_MS),
    `주입 뒤 ${RECOVER_LIMIT_MS / 1000}초 안에 mesh 회복(${recoveries.length}회)`,
    recoveries,
  );
  const rejoins = injections.filter((entry) => entry.kind === 'rejoin').length;
  const cuts = injections.filter((entry) => entry.kind === 'cut');
  const byeSeen = agents.some((agent) => agent.logs('link.closed').some((line) => line.reason === 'bye_leave'));
  report.check(
    'L9-05',
    // 주입은 주기의 배수 가운데 끝나기 전의 때에만 한다(130분이면 퇴장·재입장 12회, 소켓 끊기 4회).
    rejoins >= Math.ceil((MINUTES * 60_000) / REJOIN_EVERY_MS) - 1 &&
      cuts.length >= Math.ceil((MINUTES * 60_000) / CUT_EVERY_MS) - 1 &&
      rejoins > 0 &&
      cuts.length > 0 &&
      byeSeen &&
      cuts.every((entry) => entry.reconnected >= agents.length),
    '주입이 실제로 일어났다(퇴장·재입장의 bye 로그, 끊은 뒤 다시 붙은 연결)',
    { rejoins, cuts },
  );
  let fingerprints = null;
  const same = await until(
    async () => {
      fingerprints = await Promise.all(agents.map((agent) => fingerprintOf(agent)));
      return fingerprints.every((value) => value !== null && value === fingerprints[0]);
    },
    '지문이 같아짐',
    60_000,
    2_000,
  ).then(
    () => true,
    () => false,
  );
  report.check('L9-06', same, '끝났을 때 모든 참가자의 상태 지문이 같다', fingerprints);
  if (MINUTES < 130 || REJOIN_EVERY_MS !== 10 * 60_000 || CUT_EVERY_MS !== 30 * 60_000) {
    report.partial('L9-LEN', `실행 ${MINUTES}분, 주입 주기 ${REJOIN_EVERY_MS / 60_000}분·${CUT_EVERY_MS / 60_000}분: 고정 기준(130분, 10분·30분)과 달라 장시간 검증으로 보고하지 않는다`);
  }
  for (const agent of agents) {
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
