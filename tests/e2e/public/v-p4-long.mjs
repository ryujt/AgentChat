#!/usr/bin/env node
// V-P4: 공용 서버의 유휴와 2시간 한도, 130분 (verification-plan.md 3.3 V-P4). 제품 코드가 아니다. src 는 이 파일을 import 하지 않는다.
// 조립한 MCP 프로세스 4개를 공용 서버(서버 인자 없음, 제품 기본값)로 한 방에 넣고 130분 둔다. 서버를 끊는 주입은 하지 않는다.
// 끊김은 게이트웨이의 최대 연결 시간(문서상 2시간)이 스스로 만든다.
//
// ── 실행 ────────────────────────────────────────────────────────────────────
//
//   AGENT_CHAT_DIST=<빌드> TMPDIR=<임시> nohup node tests/e2e/public/v-p4-long.mjs --out <스크래치 폴더> > <로그> 2>&1 &
//   [--minutes 130]  mesh 가 선 때부터의 시간(분). 130 보다 짧으면 끝에 "장시간 검증 아님"(부분)을 적는다
//   [--chat-sec 10]  참가자마다 채팅 간격(초). 채팅은 DataChannel 로만 간다(서버 부하가 아니다)
//   필요: AWS 자격 증명(cloudwatch:GetMetricStatistics, logs:FilterLogEvents, cloudformation:DescribeStacks, dynamodb:Query).
//   표지 파일(<out>/v-p4-markers.json, 권한 600)에 방 ID·이름을 남긴다. 표준 출력에는 남기지 않는다.
//
// ── 부하 ────────────────────────────────────────────────────────────────────
//
//   서버로 가는 것은 제품이 스스로 보내는 것뿐이다: 입장(join), 30초마다 ping, mesh 의 시그널, 끊긴 뒤의 재등록, 끝의 퇴장.
//   참가자마다 10초에 채팅 1건(방 전체). 10초마다 get_status(로컬 tool 호출. 서버로 가지 않는다).
//
// ── 통과 조건 (실행 전에 고정) ──────────────────────────────────────────────
//
//   P4-01 4 프로세스가 공용 서버로 한 방에 들어가 6쌍 모두 link open.
//   P4-02 ping 으로 10분을 넘겨 유지: 참가자마다 첫 시그널링 연결이 600초 넘게 이어졌다(첫 signal.state connected 부터
//         첫 signal.error{socket_closed} 까지. 끊김이 없었으면 끝까지).
//   P4-03 2시간 근처의 끊김: 참가자마다 첫 연결의 서버 쪽 끊김(socket_closed)이 첫 연결 뒤 [115분, 122분] 안에 있다.
//         (문서상 2시간. 끊김이 이 구간에 없으면 2시간 한도를 본 것이 아니므로 통과가 아니다)
//   P4-04 재접속·재등록: 그 끊김마다 60초 안에 signal.state connected(새 seq)가 오고, 마지막 끊김 3분 뒤 DynamoDB(강한 일관성)에
//         네 참가자의 항목이 모두 있고 lastSeenAt 이 90초 안이다. 함수 로그에 이 방의 conn.join{joined} 가 첫 입장 뒤 4건 이상 더 있다.
//   P4-05 DataChannel 유지: 전 구간 link.closed 0건. 10초 상태 표본 전부에서 4명 모두 link open 3개. 끊김이 실제로 일어났다는
//         증거는 진단 로그의 signal.error{socket_closed}(참가자마다 1건 이상)다. 시그널링이 connected 가 아닌 표본이 있으면 그 표본에서도
//         link open 3개여야 한다. (고침: 처음 판은 "재접속 중 표본이 하나 이상"을 요구했다. 실제 재접속은 0.4~1.4초라 10초 표본에
//         잡히지 않는다. 2026-11-16 final-long 의 P-FL-03 에서 드러났다. 기준(DataChannel 유지)은 같고 증거를 로그로 바꿨다.)
//   P4-06 채팅 유실 0: 보낸 채팅마다 delivered 3명·undelivered 0, 받은 쪽 셋이 정확히 한 번씩 받았다. 끊김 앞뒤 60초 안에 보낸 채팅이 있다.
//   P4-07 게이트웨이 메시지 수(CloudWatch AWS/ApiGateway MessageCount, 1분 Sum)가 ping 과 시그널의 예상치 안:
//         (가) 안정 구간의 분이 30개 이상이고, 그 합이 16·n ± max(10, 1%·16·n), 어느 분도 22 이하다
//              (참가자 4 × ping 2회/분 × 수신+pong = 16. V-P2 실측 16). 안정 구간 = mesh 2분 뒤부터 끝 2분 전까지의 분 가운데,
//              [분 − 60초, 분 + 120초) 안에 이 방의 conn.join·conn.closed·relay 함수 로그 줄과 참가자의 signal.state 변화가 없고,
//              그 분과 앞뒤 분의 접근 로그가 각각 MESSAGE 8건(= 이 방의 ping 4 × 2)이고 CONNECT·DISCONNECT 가 0건인 분.
//              공용 스테이지를 다른 연결이 함께 쓰면 그 분은 빠진다. 채팅이 서버를 지났다면 그 분의 MESSAGE 가 8 을 넘어 빠지므로
//              안정 구간이 30분에 못 미쳐 통과하지 못한다(아래 (나)로도 가려진다). 30분에 못 미친 원인이 다른 연결이면 "부분"으로 적는다.
//         (나) 이 방의 relay 함수 로그 줄이 mesh 60초 뒤부터 끝까지 0건이다(링크가 닫히지 않으므로 새 시그널이 없다. 채팅이 서버를 지나면 relay 다).
//         (다) 전 구간 합 T: 다른 방의 함수 로그 줄과 이 시험 밖의 CONNECT 가 없으면 16·N − 40 ≤ T ≤ 16·N + 4·(이 방의 conn.join 줄 + relay 줄) + 40
//              (N 은 전 구간 분 수). 다른 연결이 섞였으면 T 와 접근 로그 내역을 적고 (다)는 "부분"(오염)으로 한다.
//   PROC  띄운 프로세스가 남지 않았다.
//
// 출력에 방 ID 원문, 채팅 본문, 참가자 이름 원문 외의 식별자(계정 ID, API ID)를 남기지 않는다.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { argValue, createReport, delay, enterAll, finish, newRoomId, PUBLIC_SERVER, startStack, until } from '../scenarios/harness.mjs';
import { appJson, createRoomReader, fetchLogEvents, kst, metricMinutes, peerRefOf, roomRefOf, saveRaw, stackOutputs, sumWindow } from './aws.mjs';

const rest = process.argv.slice(2);
const OUT = argValue(rest, 'out', null);
const MINUTES = Number(argValue(rest, 'minutes', '130'));
const CHAT_EVERY_MS = Number(argValue(rest, 'chat-sec', '10')) * 1000;
const STATUS_EVERY_MS = 10_000;
const SAMPLE_EVERY_MS = 60_000;
const METRIC_WAIT_MS = 30 * 60_000;
const CUT_MIN = 115 * 60_000;
const CUT_MAX = 122 * 60_000;
if (OUT === null) {
  process.stderr.write('--out <스크래치 폴더> 가 필요하다\n');
  process.exit(2);
}

const report = createReport(`V-P4 유휴와 2시간 한도 (${PUBLIC_SERVER}, ${MINUTES}분)`);
let stack = null;

function rssKb(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

async function meshComplete(agents) {
  for (const agent of agents) {
    const status = await agent.status();
    if (status.participants.filter((row) => row.link === 'open').length !== agents.length - 1) return false;
  }
  return true;
}

/** 참가자 하나의 시그널링 기록(진단 로그): 상태 변화와 소켓 닫힘. */
function signalingTimeline(agent) {
  const rows = [];
  for (const line of agent.logs()) {
    if (line.event === 'signal.state') rows.push({ at: Date.parse(line.ts), kind: line.state, seq: line.seq, reason: line.reason ?? null });
    else if (line.event === 'signal.error' && line.reason === 'socket_closed') rows.push({ at: Date.parse(line.ts), kind: 'socket_closed' });
    else if (line.event === 'signal.ping_miss') rows.push({ at: Date.parse(line.ts), kind: 'ping_miss', misses: line.misses, reason: line.reason });
    else if (line.event === 'signal.gateway_frame') rows.push({ at: Date.parse(line.ts), kind: 'gateway_frame' });
  }
  return rows.sort((a, b) => a.at - b.at);
}

async function run() {
  const outputs = await stackOutputs();
  stack = await startStack({ label: 'v-p4', server: PUBLIC_SERVER });
  const room = newRoomId();
  const names = ['p4-anna', 'p4-bert', 'p4-cara', 'p4-dave'];
  saveRaw(path.join(OUT, 'v-p4-markers.json'), { room, names });
  const agents = [];
  for (const name of names) agents.push(await stack.agent(name));
  const enteredAt = Date.now();
  await enterAll(agents, room);
  const meshed = await until(() => meshComplete(agents), '전원 mesh', 30_000, 250).then(
    () => true,
    () => false,
  );
  report.check('P4-01', meshed, '4 프로세스가 공용 서버로 한 방에 들어가 6쌍 모두 link open', { ms: Date.now() - enteredAt });
  if (!meshed) throw new Error('mesh 가 서지 않았다');
  const startedAt = Date.now();
  report.note(`시작(KST) ${kst(enteredAt)} 입장, ${kst(startedAt)} mesh. 끝 예정 ${kst(startedAt + MINUTES * 60_000)}`);

  /** 보낸 채팅: id → {from, at, delivered, undelivered} */
  const sent = new Map();
  const sendErrors = [];
  /** 10초 상태 표본: {at, rows:[{name, signaling, open}]} */
  const statusSamples = [];
  let stopping = false;

  const chatLoops = agents.map(async (agent, index) => {
    await delay(index * (CHAT_EVERY_MS / agents.length));
    let serial = 0;
    while (!stopping) {
      const due = Date.now() + CHAT_EVERY_MS;
      serial += 1;
      const at = Date.now();
      const reply = await agent.call('send_message', { text: `${agent.name} p4 ${serial}` }).catch((error) => ({ isError: true, text: String(error) }));
      if (!reply.isError && reply.json !== null) {
        sent.set(reply.json.message_id, { from: agent.name, at, delivered: reply.json.delivered, undelivered: reply.json.undelivered });
      } else {
        sendErrors.push({ from: agent.name, at, text: String(reply.text).slice(0, 120) });
      }
      await delay(Math.max(0, due - Date.now()));
    }
  });

  const endAt = startedAt + MINUTES * 60_000;
  let nextStatus = startedAt;
  let nextSample = startedAt + SAMPLE_EVERY_MS;
  while (Date.now() < endAt) {
    const now = Date.now();
    if (now >= nextStatus) {
      nextStatus += STATUS_EVERY_MS;
      const rows = [];
      for (const agent of agents) {
        const status = await agent.status().catch(() => null);
        rows.push({
          name: agent.name,
          signaling: status?.room?.signaling ?? 'unknown',
          open: status === null ? -1 : status.participants.filter((row) => row.link === 'open').length,
        });
      }
      statusSamples.push({ at: Date.now(), rows });
      const notConnected = rows.filter((row) => row.signaling !== 'connected');
      if (notConnected.length > 0) {
        process.stdout.write(`[재접속 중] ${Math.round((Date.now() - startedAt) / 1000)}초 ${notConnected.map((row) => `${row.name}:${row.signaling}`).join(',')} links=${rows.map((row) => row.open).join(',')}\n`);
      }
    }
    if (now >= nextSample) {
      nextSample += SAMPLE_EVERY_MS;
      const last = statusSamples.at(-1);
      const rss = Object.fromEntries(agents.map((agent) => [agent.name, rssKb(agent.pid)]));
      process.stdout.write(
        `[표본] ${Math.round((Date.now() - startedAt) / 60_000)}분 signaling=${last.rows.map((row) => row.signaling).join(',')} links=${last.rows.map((row) => row.open).join(',')} rss(KB)=${JSON.stringify(Object.values(rss))} 보낸 채팅=${sent.size} 보내기 오류=${sendErrors.length}\n`,
      );
    }
    await delay(1_000);
  }
  stopping = true;
  await Promise.all(chatLoops);
  await delay(CHAT_EVERY_MS);
  const runEnd = Date.now();

  // ── 시그널링 기록 ──
  const timelines = Object.fromEntries(agents.map((agent) => [agent.name, signalingTimeline(agent)]));
  const perAgent = {};
  for (const agent of agents) {
    const rows = timelines[agent.name];
    const firstConnected = rows.find((row) => row.kind === 'connected');
    const closes = rows.filter((row) => row.kind === 'socket_closed');
    const firstClose = closes[0] ?? null;
    const reconnects = closes.map((close) => {
      const back = rows.find((row) => row.kind === 'connected' && row.at >= close.at && row.seq !== undefined);
      return { closedAt: close.at, backMs: back === undefined ? null : back.at - close.at, seq: back?.seq ?? null };
    });
    perAgent[agent.name] = {
      firstConnectedAt: firstConnected?.at ?? null,
      firstConnectionMs: firstConnected === undefined ? null : (firstClose?.at ?? runEnd) - firstConnected.at,
      firstCloseAfterMin: firstConnected === undefined || firstClose === null ? null : Math.round(((firstClose.at - firstConnected.at) / 60_000) * 100) / 100,
      closes: closes.length,
      reconnects,
      pingMisses: rows.filter((row) => row.kind === 'ping_miss').length,
      gatewayFrames: rows.filter((row) => row.kind === 'gateway_frame').length,
    };
  }
  saveRaw(path.join(OUT, 'v-p4-timelines.json'), { startedAt, runEnd, timelines, perAgent });
  report.note(`참가자별 시그널링: ${JSON.stringify(Object.values(perAgent).map((entry) => ({ firstCloseAfterMin: entry.firstCloseAfterMin, closes: entry.closes, backMs: entry.reconnects.map((r) => r.backMs), pingMisses: entry.pingMisses, gatewayFrames: entry.gatewayFrames })))}`);
  report.note(`끊김 시각(KST): ${Object.values(perAgent).map((entry) => entry.reconnects.map((r) => kst(r.closedAt)).join('/')).join(', ')}`);

  report.check(
    'P4-02',
    Object.values(perAgent).every((entry) => entry.firstConnectionMs !== null && entry.firstConnectionMs > 600_000),
    'ping 으로 10분을 넘겨 유지(참가자마다 첫 시그널링 연결이 600초 초과)',
    Object.values(perAgent).map((entry) => (entry.firstConnectionMs === null ? null : Math.round(entry.firstConnectionMs / 1000))),
  );
  report.check(
    'P4-03',
    Object.values(perAgent).every((entry) => entry.firstCloseAfterMin !== null && entry.firstCloseAfterMin * 60_000 >= CUT_MIN && entry.firstCloseAfterMin * 60_000 <= CUT_MAX),
    `2시간 근처의 끊김: 첫 연결의 끊김이 첫 연결 뒤 [${CUT_MIN / 60_000}, ${CUT_MAX / 60_000}]분 안`,
    Object.values(perAgent).map((entry) => entry.firstCloseAfterMin),
  );
  const allReconnects = Object.values(perAgent).flatMap((entry) => entry.reconnects);
  const reconnectOk = allReconnects.length >= agents.length && allReconnects.every((entry) => entry.backMs !== null && entry.backMs <= 60_000);

  // 재등록: 마지막 끊김 3분 뒤(이미 지났으면 지금) DynamoDB 를 읽는다. 참가자들은 아직 방에 있다.
  const lastClose = Math.max(0, ...allReconnects.map((entry) => entry.closedAt));
  if (lastClose > 0 && Date.now() < lastClose + 180_000) await delay(lastClose + 180_000 - Date.now());
  const reader = createRoomReader(outputs.TableName);
  let peers = [];
  try {
    peers = await reader.peers(room);
  } finally {
    reader.close();
  }
  const readAt = Date.now();
  const wanted = new Set(names.flatMap((name) => [name, peerRefOf(name)]));
  const present = names.filter((name) => peers.some((entry) => entry.peer === name || entry.peer === peerRefOf(name)));
  const fresh = peers.filter((entry) => wanted.has(entry.peer)).every((entry) => readAt - entry.lastSeenAt * (entry.lastSeenAt < 1e12 ? 1000 : 1) <= 90_000);
  report.note(`DynamoDB 참가자 항목(${kst(readAt)}): ${present.length}/4, lastSeenAt 나이(초) ${JSON.stringify(peers.map((entry) => Math.round((readAt - entry.lastSeenAt * (entry.lastSeenAt < 1e12 ? 1000 : 1)) / 1000)))}`);

  // ── DataChannel 유지 ──
  const closedLinks = agents.flatMap((agent) => agent.logs('link.closed').map((line) => ({ who: agent.name, reason: line.reason, at: line.ts })));
  const badSamples = statusSamples.filter((sample) => sample.rows.some((row) => row.open !== agents.length - 1));
  const reconnectingSamples = statusSamples.filter((sample) => sample.rows.some((row) => row.signaling !== 'connected'));
  const reconnectingBad = reconnectingSamples.filter((sample) => sample.rows.some((row) => row.open !== agents.length - 1));

  // ── 채팅 ──
  const received = new Map();
  for (const agent of agents) {
    for (const event of agent.events) {
      if (event.kind !== 'chat') continue;
      const list = received.get(event.id) ?? [];
      list.push(agent.name);
      received.set(event.id, list);
    }
  }
  const mismatches = [];
  for (const [id, entry] of sent) {
    const receivers = received.get(id) ?? [];
    const others = names.filter((name) => name !== entry.from);
    const ok =
      entry.undelivered.length === 0 &&
      entry.delivered.length === others.length &&
      others.every((name) => entry.delivered.includes(name)) &&
      receivers.length === others.length &&
      others.every((name) => receivers.includes(name));
    if (!ok) mismatches.push({ from: entry.from, at: kst(entry.at), delivered: entry.delivered.length, undelivered: entry.undelivered.map((u) => u.reason), receivers: receivers.length });
  }
  const nearCut = [...sent.values()].filter((entry) => allReconnects.some((r) => Math.abs(entry.at - r.closedAt) <= 60_000)).length;
  const duringReconnect = [...sent.values()].filter((entry) =>
    reconnectingSamples.some((sample) => Math.abs(sample.at - entry.at) <= 5_000 && sample.rows.some((row) => row.signaling !== 'connected')),
  ).length;

  // ── 퇴장과 종료 ──
  for (const agent of agents) {
    await agent.stopPump();
    await agent.call('leave_room').catch(() => null);
  }
  const codes = [];
  for (const agent of agents) codes.push((await agent.close()).exit.code);
  report.note(`leave_room 뒤 종료 코드 ${JSON.stringify(codes)}`);

  // ── 함수 로그와 접근 로그(이 방) ──
  const windowStart = Math.floor(enteredAt / 60_000) * 60_000;
  const windowEnd = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
  await delay(Math.max(0, windowEnd + 180_000 - Date.now()));
  const roomRef = roomRefOf(room);
  const fn = await fetchLogEvents(outputs.FunctionLogGroup, windowStart - 60_000, windowEnd + 60_000);
  const access = await fetchLogEvents(outputs.AccessLogGroup, windowStart, windowEnd);
  saveRaw(path.join(OUT, 'v-p4-function-raw.json'), fn);
  saveRaw(path.join(OUT, 'v-p4-access-raw.json'), access);
  const roomLines = [];
  const otherRoomLines = [];
  for (const line of fn) {
    const value = appJson(line.message);
    if (value === null || typeof value.room_ref !== 'string') continue;
    if (line.timestamp < windowStart || line.timestamp >= windowEnd) continue;
    const row = { at: line.timestamp, event: value.event, outcome: value.outcome ?? null };
    (value.room_ref === roomRef ? roomLines : otherRoomLines).push(row);
  }
  const joinsAll = roomLines.filter((line) => line.event === 'conn.join');
  const joinsJoined = joinsAll.filter((line) => line.outcome === 'joined');
  const relays = roomLines.filter((line) => line.event === 'relay');
  const firstMesh = startedAt;
  const laterJoined = joinsJoined.filter((line) => line.at > firstMesh + 60_000);
  const byOutcome = {};
  for (const line of roomLines) byOutcome[`${line.event}|${line.outcome}`] = (byOutcome[`${line.event}|${line.outcome}`] ?? 0) + 1;
  report.note(`함수 로그(이 방): ${JSON.stringify(byOutcome)}`);
  const otherByOutcome = {};
  for (const line of otherRoomLines) otherByOutcome[`${line.event}|${line.outcome}`] = (otherByOutcome[`${line.event}|${line.outcome}`] ?? 0) + 1;
  report.note(`함수 로그(다른 방): ${JSON.stringify(otherByOutcome)}`);
  const accessCounts = {};
  /** 분(epoch ms) → eventType 별 수 */
  const accessByMinute = new Map();
  for (const line of access) {
    let value;
    try {
      value = JSON.parse(line.message);
    } catch {
      continue;
    }
    accessCounts[value.eventType] = (accessCounts[value.eventType] ?? 0) + 1;
    const minute = Math.floor(Number(value.requestTimeEpoch) / 60_000) * 60_000;
    const counts = accessByMinute.get(minute) ?? {};
    counts[value.eventType] = (counts[value.eventType] ?? 0) + 1;
    accessByMinute.set(minute, counts);
  }
  const ourConnects = agents.length + allReconnects.length;
  report.note(`접근 로그 전 구간 eventType: ${JSON.stringify(accessCounts)} (이 시험의 CONNECT 는 입장 4 + 재접속 ${allReconnects.length} = ${ourConnects}. 재접속 시도가 실패해 다시 붙은 것은 더 많을 수 있다)`);

  report.check(
    'P4-04',
    reconnectOk && present.length === names.length && fresh && laterJoined.length >= agents.length,
    '2시간 근처 끊김 뒤 재접속·재등록(60초 안 connected, DynamoDB 4/4 lastSeenAt 90초 안, 함수 로그 conn.join{joined} 추가 4건 이상)',
    { reconnects: allReconnects.length, back_ms: allReconnects.map((entry) => entry.backMs), dynamo: present.length, fresh, later_joined: laterJoined.length },
  );
  report.check(
    'P4-05',
    closedLinks.length === 0 &&
      badSamples.length === 0 &&
      statusSamples.length > 0 &&
      Object.values(perAgent).every((entry) => entry.closes >= 1) &&
      reconnectingBad.length === 0,
    'DataChannel 유지(link.closed 0, 10초 표본 전부 link open 3, 참가자마다 시그널링 끊김이 로그에 있음)',
    {
      link_closed: closedLinks.slice(0, 10),
      samples: statusSamples.length,
      bad: badSamples.length,
      socket_closed: Object.values(perAgent).map((entry) => entry.closes),
      reconnecting_samples: reconnectingSamples.length,
      reconnecting_bad: reconnectingBad.length,
    },
  );
  report.check(
    'P4-06',
    sent.size > 0 && mismatches.length === 0 && sendErrors.length === 0 && nearCut > 0,
    `채팅 유실 0(${sent.size}건 모두 delivered 3·받은 쪽 3 정확히 한 번)`,
    { sent: sent.size, mismatches: mismatches.length, first: mismatches.slice(0, 5), send_errors: sendErrors.slice(0, 5), near_cut: nearCut, during_reconnect_sample: duringReconnect },
  );

  // ── 지표 ──
  const apiDims = { ApiId: outputs.ApiId, Stage: outputs.StageName };
  const fnDims = { FunctionName: outputs.FunctionName };
  const read = async () => ({
    messages: await metricMinutes({ namespace: 'AWS/ApiGateway', metric: 'MessageCount', dimensions: apiDims, startMs: windowStart, endMs: windowEnd }),
    invocations: await metricMinutes({ namespace: 'AWS/Lambda', metric: 'Invocations', dimensions: fnDims, startMs: windowStart, endMs: windowEnd }),
  });
  const deadline = Date.now() + METRIC_WAIT_MS;
  let previous = null;
  let current = null;
  let stable = false;
  while (Date.now() < deadline) {
    current = await read();
    const complete = current.messages.every((entry) => entry.present);
    if (complete && previous !== null && JSON.stringify(previous) === JSON.stringify(current)) {
      stable = true;
      break;
    }
    previous = current;
    await delay(60_000);
  }
  saveRaw(path.join(OUT, 'v-p4-metrics.json'), { windowStart, windowEnd, current, roomLines, timelines });
  report.note(`지표 집계 안정: ${stable} (${kst(Date.now())})`);
  report.note(`분별 MessageCount: ${current.messages.map((entry) => entry.sum).join(',')}`);
  report.note(`분별 Invocations: ${current.invocations.map((entry) => entry.sum).join(',')}`);

  // 안정 구간: 이 방의 conn.join·conn.closed·relay 줄과 참가자 signal.state 변화가 [분 − 60초, 분 + 120초) 안에 없고, mesh 2분 뒤부터 끝 2분 전까지.
  const activity = [
    ...roomLines.filter((line) => line.event === 'conn.join' || line.event === 'conn.closed' || line.event === 'relay').map((line) => line.at),
    ...Object.values(timelines).flatMap((rows) => rows.filter((row) => row.kind !== 'ping_miss').map((row) => row.at)),
  ];
  const candidates = current.messages.filter(
    (entry) =>
      entry.minute >= startedAt + 120_000 &&
      entry.minute + 60_000 <= runEnd - 120_000 &&
      !activity.some((at) => at >= entry.minute - 60_000 && at < entry.minute + 120_000),
  );
  const accessOf = (minute) => accessByMinute.get(minute) ?? {};
  // 지표의 분과 접근 로그의 분이 어긋날 수 있어(스모크에서 본 것) 앞뒤 분까지 깨끗해야 한다.
  const isCleanOne = (minute) => {
    const counts = accessOf(minute);
    return (counts.MESSAGE ?? 0) === 8 && (counts.CONNECT ?? 0) === 0 && (counts.DISCONNECT ?? 0) === 0;
  };
  const isClean = (minute) => isCleanOne(minute - 60_000) && isCleanOne(minute) && isCleanOne(minute + 60_000);
  const steady = candidates.filter((entry) => isClean(entry.minute));
  const dirty = candidates.filter((entry) => !isClean(entry.minute));
  // 빠진 분의 내역: 다른 방 줄이 그 분에 있었는가(다른 연결 때문인지 가리는 근거)
  const dirtyRows = dirty.map((entry) => ({
    at: kst(entry.minute),
    messageCount: entry.sum,
    access: accessOf(entry.minute),
    otherRoomLines: otherRoomLines.filter((line) => line.at >= entry.minute && line.at < entry.minute + 60_000).length,
  }));
  const steadySum = steady.reduce((total, entry) => total + entry.sum, 0);
  const steadyMax = Math.max(0, ...steady.map((entry) => entry.sum));
  const tolerance = Math.max(10, Math.ceil(0.01 * 16 * steady.length));
  const partA = stable && steady.length >= 30 && Math.abs(steadySum - 16 * steady.length) <= tolerance && steadyMax <= 22;
  const lateRelays = relays.filter((line) => line.at > startedAt + 60_000);
  const partB = lateRelays.length === 0;
  const totalMinutes = current.messages.length;
  const total = sumWindow(current.messages, windowStart, windowEnd);
  const upper = 16 * totalMinutes + 4 * (joinsAll.length + relays.length) + 40;
  const lower = 16 * totalMinutes - 40;
  const foreign = otherRoomLines.length > 0 || (accessCounts.CONNECT ?? 0) > ourConnects;
  const partC = total >= lower && total <= upper;
  const detail = {
    candidate_minutes: candidates.length,
    steady_minutes: steady.length,
    steady_sum: steadySum,
    steady_expected: 16 * steady.length,
    tolerance,
    steady_max: steadyMax,
    excluded_by_access_log: dirty.length,
    late_room_relays: lateRelays.length,
    total_minutes: totalMinutes,
    total,
    lower,
    upper,
    foreign_traffic: foreign,
    room_join_lines: joinsAll.length,
    room_relay_lines: relays.length,
    invocations_total: sumWindow(current.invocations, windowStart, windowEnd),
  };
  saveRaw(path.join(OUT, 'v-p4-p407.json'), { detail, dirtyRows, steady: steady.map((entry) => ({ at: kst(entry.minute), sum: entry.sum })) });
  report.note(`P4-07 에서 빠진 분(접근 로그가 ping 만이 아님) 앞 10개: ${JSON.stringify(dirtyRows.slice(0, 10))}`);
  const title = '게이트웨이 메시지 수가 ping 과 시그널의 예상치 안((가) 안정 구간 30분 이상·16·n ± 허용·분당 22 이하 (나) mesh 뒤 이 방 relay 0 (다) 전 구간 하한·상한)';
  if (partA && partB && (foreign || partC)) {
    if (foreign && !partC) report.partial('P4-07', `${title}: (가)(나) 통과, (다)는 다른 연결이 섞여 판정하지 못함`, detail);
    else if (foreign) report.pass('P4-07', `${title} — 다른 연결이 섞였으나 (다)도 범위 안`, detail);
    else report.pass('P4-07', title, detail);
  } else if (stable && partB && foreign && steady.length < 30 && Math.abs(steadySum - 16 * steady.length) <= tolerance && steadyMax <= 22) {
    report.partial('P4-07', `${title}: 다른 연결이 섞여 안정 구간이 30분에 못 미침`, detail);
  } else {
    report.fail('P4-07', title, detail);
  }

  if (MINUTES < 130) report.partial('P4-LEN', `실행 ${MINUTES}분: 고정 기준(130분)보다 짧아 장시간 검증으로 보고하지 않는다`);
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
