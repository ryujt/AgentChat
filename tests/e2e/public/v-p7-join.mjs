#!/usr/bin/env node
// V-P7 유실과 스로틀 아래의 입장(verification-plan.md 3.3, deployment.md 2.7). 제품 코드가 아니다.
// 조립한 MCP 프로세스를 공용 서버(서버 인자 없음)로 띄운다. 한 회차: 한 프로세스가 방을 만들고, 4개가 동시에 join_room 한다.
//
// --part a  (가) 함수가 식은 상태: 회차마다 --idle-min 분 동안 이 스크립트가 서버에 아무 것도 보내지 않은 뒤 시작한다.
//           설정(환경 변수, 코드, 동시 실행)은 바꾸지 않는다. 식었는지는 회차 구간의 함수 로그 INIT_START 수로 적는다.
//           통과: --trials 회 모두 만들기 1 + 동시 입장 4 성공. 재전송 횟수·걸린 시간을 적는다.
// --part b  (나) 다른 연결로 스테이지 스로틀을 넘긴 상태(flood.mjs)에서 같은 회차를 돈다. 부하 단계(--levels, 초당 건수)마다 1회.
//           입장 뒤에도 --hold-sec 초 동안 부하를 유지해 ping 이 버려질 때의 재접속을 본다.
//           통과: 입장마다 성공하거나, 실패면 실패한 피어의 단계가 signaling. 부하 동안 재접속(signal.state reconnecting) 0회.
//
// 실행: AGENT_CHAT_DIST=<빌드> TMPDIR=<임시> node tests/e2e/public/v-p7-join.mjs --part a --out <스크래치> [--trials 10] [--idle-min 10] [--initial-idle-min 10]
//       AGENT_CHAT_DIST=<빌드> TMPDIR=<임시> node tests/e2e/public/v-p7-join.mjs --part b --out <스크래치> [--levels 60,120,240] [--flood-conns 24] [--hold-sec 70] [--keep-home]

import path from 'node:path';
import { argValue, createReport, delay, errorSummary, finish, newRoomId, PUBLIC_SERVER, startStack, until } from '../scenarios/harness.mjs';
import { fetchLogEvents, kst, saveRaw, stackOutputs } from './aws.mjs';
import { startFlood } from './flood.mjs';

const rest = process.argv.slice(2);
const PART = argValue(rest, 'part', null);
const OUT = argValue(rest, 'out', null);
if ((PART !== 'a' && PART !== 'b') || OUT === null) {
  process.stderr.write('--part a|b 와 --out <스크래치 폴더> 가 필요하다\n');
  process.exit(2);
}
const TRIALS = Number(argValue(rest, 'trials', '10'));
const IDLE_MS = Number(argValue(rest, 'idle-min', '10')) * 60_000;
const INITIAL_IDLE_MS = Number(argValue(rest, 'initial-idle-min', argValue(rest, 'idle-min', '10'))) * 60_000;
const LEVELS = (argValue(rest, 'levels', '60,120,240') ?? '').split(',').map(Number);
const FLOOD_CONNS = Number(argValue(rest, 'flood-conns', '24'));
const HOLD_MS = Number(argValue(rest, 'hold-sec', '70')) * 1000;

const report = createReport(`V-P7 (${PART === 'a' ? '가: 식은 함수' : '나: 스로틀 넘김'}) ${PUBLIC_SERVER}`);
const tag = newRoomId().slice(0, 6);
let stack = null;

function diagCounts(agent) {
  const lines = agent.logs();
  const count = (match) => lines.filter(match).length;
  const resendsByCause = {};
  for (const line of lines.filter((value) => value.event === 'signal.resend')) {
    const key = `${line.kind}/${line.cause}`;
    resendsByCause[key] = (resendsByCause[key] ?? 0) + 1;
  }
  return {
    resends: count((line) => line.event === 'signal.resend'),
    resendsByCause,
    gateway: count((line) => line.event === 'signal.gateway_frame' && line.frame_len > 0),
    pingMiss: count((line) => line.event === 'signal.ping_miss'),
    reconnects: count((line) => line.event === 'signal.state' && line.state === 'reconnecting'),
    attemptFailed: count((line) => line.event === 'link.attempt_end' && line.outcome !== 'ok'),
    signalErrors: count((line) => line.event === 'signal.error' && typeof line.error_code === 'string'),
  };
}

async function meshComplete(agents) {
  for (const agent of agents) {
    const status = await agent.status();
    for (const other of agents) {
      if (other !== agent && status.participants.find((entry) => entry.name === other.name)?.link !== 'open') return false;
    }
  }
  return true;
}

/** 한 회차: 만들기 1, 동시 입장 4. */
async function trial(label, { whileInRoom } = {}) {
  const room = newRoomId();
  const creator = await stack.agent(`p7${label}c-${tag}`);
  const joiners = [];
  for (let i = 0; i < 4; i += 1) joiners.push(await stack.agent(`p7${label}j${i}-${tag}`));
  const all = [creator, ...joiners];
  const startedAt = Date.now();
  const created = await creator.call('create_room', { room_id: room }, { timeoutMs: 90_000 });
  const createMs = Date.now() - startedAt;
  let joins = [];
  let meshMs = null;
  if (!created.isError) {
    creator.pump();
    const joinStartedAt = Date.now();
    joins = await Promise.all(
      joiners.map(async (agent) => {
        const reply = await agent.call('join_room', { room_id: room }, { timeoutMs: 90_000 });
        const ms = Date.now() - joinStartedAt;
        if (!reply.isError) agent.pump();
        const peers = (reply.json?.error?.details?.peers ?? []).map((peer) => ({ stage: peer.stage, reason: peer.reason }));
        return { ok: !reply.isError, ms, error: errorSummary(reply), code: reply.json?.error?.code ?? null, peers };
      }),
    );
    if (joins.every((entry) => entry.ok)) {
      const meshed = await until(() => meshComplete(all), '전원 mesh', 20_000, 250).catch(() => false);
      meshMs = meshed === true ? Date.now() - joinStartedAt : null;
    }
  }
  if (whileInRoom !== undefined) await whileInRoom();
  const diag = all.map((agent) => diagCounts(agent));
  for (const agent of all) {
    await agent.stopPump();
    await agent.call('leave_room').catch(() => {});
  }
  for (const agent of all) await agent.close().catch(() => {});
  const endedAt = Date.now();
  return {
    label,
    startedAt,
    endedAt,
    create: {
      ok: !created.isError,
      ms: createMs,
      error: errorSummary(created),
      code: created.json?.error?.code ?? null,
      peers: (created.json?.error?.details?.peers ?? []).map((peer) => ({ stage: peer.stage, reason: peer.reason })),
    },
    joins,
    meshMs,
    diag,
  };
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

function summarize(result) {
  const joinMs = result.joins.map((entry) => entry.ms);
  return {
    create: `${result.create.ok ? 'ok' : result.create.error} ${result.create.ms}ms`,
    joins: result.joins.map((entry) => (entry.ok ? `ok ${entry.ms}ms` : `${entry.error} ${entry.ms}ms`)),
    join_max_ms: joinMs.length > 0 ? Math.max(...joinMs) : null,
    mesh_ms: result.meshMs,
    resends: sum(result.diag.map((entry) => entry.resends)),
    gateway_frames: sum(result.diag.map((entry) => entry.gateway)),
    ping_miss: sum(result.diag.map((entry) => entry.pingMiss)),
    reconnects: sum(result.diag.map((entry) => entry.reconnects)),
    attempt_failed: sum(result.diag.map((entry) => entry.attemptFailed)),
  };
}

async function partA(outputs) {
  const results = [];
  for (let index = 1; index <= TRIALS; index += 1) {
    const idle = index === 1 ? INITIAL_IDLE_MS : IDLE_MS;
    report.note(`회차 ${index}: ${idle / 60_000}분 쉰 뒤 시작(${kst(Date.now() + idle)})`);
    await delay(idle);
    const result = await trial(`a${index}`);
    results.push(result);
    report.note(`회차 ${index} (${kst(result.startedAt)}): ${JSON.stringify(summarize(result))}`);
    saveRaw(path.join(OUT, 'v-p7a-results.json'), results);
  }
  // 함수 로그로 식은 상태였는지 적는다(로그 수집 지연을 기다린다).
  await delay(90_000);
  const fn = await fetchLogEvents(outputs.FunctionLogGroup, results[0].startedAt - 5_000, Date.now());
  saveRaw(path.join(OUT, 'v-p7a-function-raw.json'), fn);
  const cold = results.map((result) => {
    const lines = fn.filter((line) => line.timestamp >= result.startedAt - 2_000 && line.timestamp <= result.endedAt + 2_000);
    const inits = lines.filter((line) => line.message.startsWith('INIT_START')).length;
    const initDurations = lines.map((line) => /Init Duration: ([\d.]+) ms/.exec(line.message)?.[1]).filter((value) => value !== undefined).map(Number);
    const starts = lines.filter((line) => line.message.startsWith('START ')).length;
    const firstStart = lines.find((line) => line.message.startsWith('START ') || line.message.startsWith('INIT_START'));
    return { inits, initDurations, starts, firstIsInit: firstStart?.message.startsWith('INIT_START') ?? false };
  });
  report.note(`회차별 INIT_START/Init Duration(ms)/호출: ${cold.map((entry, i) => `${i + 1}:${entry.inits}/${entry.initDurations.map(Math.round).join('+') || '-'}/${entry.starts}${entry.firstIsInit ? '(첫 호출이 초기화)' : ''}`).join(' ')}`);
  saveRaw(path.join(OUT, 'v-p7a-cold.json'), cold);
  const allOk = results.every((result) => result.create.ok && result.joins.length === 4 && result.joins.every((entry) => entry.ok));
  report.check('P7A-01', allOk, `${TRIALS}회 모두 만들기 1 + 동시 입장 4 성공`, {
    failed_trials: results.filter((result) => !(result.create.ok && result.joins.every((entry) => entry.ok))).map((result) => result.label),
  });
  report.check('P7A-02', results.every((result) => result.meshMs !== null), '회차마다 다섯 프로세스가 20초 안에 전원 mesh');
  report.check('P7A-03', cold.every((entry) => entry.firstIsInit), '회차마다 첫 호출이 새 실행 환경의 초기화(INIT_START)로 시작했다(식은 상태였다)', {
    inits: cold.map((entry) => entry.inits),
  });
  report.note(`재전송 합(회차별): ${results.map((result) => summarize(result).resends).join(',')}; 입장 최대 ms: ${results.map((result) => summarize(result).join_max_ms).join(',')}`);
}

async function partB() {
  const results = [];
  for (const level of LEVELS) {
    const flood = await startFlood({ url: PUBLIC_SERVER, connections: FLOOD_CONNS, ratePerSec: level });
    await delay(8_000); // 버스트 버킷이 비게 한다.
    const result = await trial(`b${level}`, { whileInRoom: () => delay(HOLD_MS) });
    const floodStats = await flood.stop();
    results.push({ level, result, floodStats });
    const summary = summarize(result);
    report.note(`부하 초당 ${level} (${kst(result.startedAt)}): ${JSON.stringify(summary)}; 부하 ${JSON.stringify({ sent: floodStats.sent, passed: floodStats.notJoined, gateway: floodStats.gateway, closed: floodStats.closed })}`);
    const entries = [result.create, ...result.joins];
    report.check(
      `P7B-${level}-1`,
      floodStats.gateway > 0 && entries.every((entry) => entry.ok || (entry.code === 'DIRECT_CONNECT_FAILED' && entry.peers.length > 0 && entry.peers.every((peer) => peer.stage === 'signaling'))),
      `초당 ${level}: 스로틀을 넘긴 상태에서 입장이 성공하거나, 실패면 단계 signaling`,
      { create: summary.create, joins: summary.joins },
    );
    report.check(`P7B-${level}-2`, summary.reconnects === 0, `초당 ${level}: 부하 동안 재접속 0회`, { reconnects: summary.reconnects, ping_miss: summary.ping_miss, gateway_frames: summary.gateway_frames });
    saveRaw(path.join(OUT, 'v-p7b-results.json'), results);
    await delay(20_000);
  }
}

async function run() {
  const outputs = await stackOutputs();
  stack = await startStack({ label: `v-p7${PART}`, server: PUBLIC_SERVER, keepHome: rest.includes('--keep-home') });
  if (rest.includes('--keep-home')) report.note(`임시 홈(지우지 않음): ${stack.homeRoot}`);
  if (PART === 'a') await partA(outputs);
  else await partB();
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
