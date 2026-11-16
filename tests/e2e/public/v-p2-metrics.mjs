#!/usr/bin/env node
// V-P2 의 "채팅이 서버를 지나지 않음을 서버에서 본다"(verification-plan.md 3.3). 제품 코드가 아니다.
// 조립한 MCP 프로세스 4개를 공용 서버(서버 인자 없음, 제품 기본값)로 한 방에 넣고, 분 경계에 맞춘 세 구간을 둔다.
//   Q1: 채팅 0건 / C: 채팅 N건(기본 200) / Q2: 채팅 0건. 구간 길이는 같다(기본 5분).
// 끝난 뒤 CloudWatch 지표(API Gateway MessageCount, Lambda Invocations)를 분 단위로 읽어 구간별 합을 견준다.
// 통과: |C − Q1| ≤ 5 이고 |C − Q2| ≤ 5 (두 지표 모두), 채팅 N건 모두 delivered.
// 보조 증거: 접근 로그의 구간별 eventType 수, 함수 로그의 relay 줄 중 이 방(room_ref)의 것.
//
// 실행: AGENT_CHAT_DIST=<빌드> TMPDIR=<임시> node tests/e2e/public/v-p2-metrics.mjs --out <스크래치 폴더> [--window-min 5] [--chats 200]
// 필요: AWS 자격 증명(cloudwatch:GetMetricStatistics, logs:FilterLogEvents, cloudformation:DescribeStacks).
// 표지 파일(<out>/v-p2-markers.json, 권한 600)에 방 ID·이름·채팅 표지를 남긴다. V-P5 의 로그 검색이 쓴다. 표준 출력에는 남기지 않는다.

import path from 'node:path';
import { createReport, delay, enterAll, finish, newRoomId, PUBLIC_SERVER, startStack, until } from '../scenarios/harness.mjs';
import { argValue } from '../scenarios/harness.mjs';
import { appJson, fetchLogEvents, kst, metricMinutes, roomRefOf, saveRaw, stackOutputs, sumWindow } from './aws.mjs';

const rest = process.argv.slice(2);
const OUT = argValue(rest, 'out', null);
const WINDOW_MS = Number(argValue(rest, 'window-min', '5')) * 60_000;
const CHATS = Number(argValue(rest, 'chats', '200'));
const METRIC_WAIT_MS = Number(argValue(rest, 'metric-wait-min', '25')) * 60_000;
if (OUT === null) {
  process.stderr.write('--out <스크래치 폴더> 가 필요하다\n');
  process.exit(2);
}

const report = createReport(`V-P2 지표 비교 (${PUBLIC_SERVER}, 구간 ${WINDOW_MS / 60_000}분, 채팅 ${CHATS}건)`);
const token = newRoomId().slice(0, 10);
let stack = null;

async function meshComplete(agents) {
  for (const agent of agents) {
    const status = await agent.status();
    for (const other of agents) {
      if (other !== agent && status.participants.find((entry) => entry.name === other.name)?.link !== 'open') return false;
    }
  }
  return true;
}

async function sleepUntil(at) {
  const wait = at - Date.now();
  if (wait > 0) await delay(wait);
}

async function run() {
  const outputs = await stackOutputs();
  stack = await startStack({ label: 'v-p2m', server: PUBLIC_SERVER });
  const room = newRoomId();
  const names = ['p2-anna', 'p2-bert', 'p2-cara', 'p2-dave'];
  saveRaw(path.join(OUT, 'v-p2-markers.json'), { room, names, chatPrefix: `p2chat-${token}-` });
  const agents = [];
  for (const name of names) agents.push(await stack.agent(name));
  const enteredAt = Date.now();
  await enterAll(agents, room);
  const meshed = await until(() => meshComplete(agents), '전원 mesh', 20_000, 250).catch(() => false);
  report.check('P2M-01', meshed === true, '4 프로세스가 공용 서버로 한 방에 들어가 6쌍 모두 link open', { ms: Date.now() - enteredAt });
  if (meshed !== true) throw new Error('mesh 가 서지 않았다');

  // 입장 직후의 시그널이 구간에 들어가지 않게, 1분 이상 지난 다음 분 경계에서 시작한다.
  const t0 = Math.ceil((Date.now() + 60_000) / 60_000) * 60_000;
  const windows = [
    { name: 'Q1', start: t0, end: t0 + WINDOW_MS },
    { name: 'C', start: t0 + WINDOW_MS, end: t0 + 2 * WINDOW_MS },
    { name: 'Q2', start: t0 + 2 * WINDOW_MS, end: t0 + 3 * WINDOW_MS },
  ];
  report.note(`구간(KST): ${windows.map((w) => `${w.name} ${kst(w.start)}~${kst(w.end)}`).join(', ')}`);
  const marks = agents.map((agent) => agent.events.length);

  await sleepUntil(windows[1].start);
  // C 구간: 끝나기 30초 전까지 고르게 보낸다. 4건 중 3건은 방 전체, 1건은 다음 참가자 하나에게.
  const spacing = (WINDOW_MS - 30_000) / CHATS;
  const sends = [];
  for (let i = 0; i < CHATS; i += 1) {
    await sleepUntil(windows[1].start + 2_000 + i * spacing);
    const from = agents[i % 4];
    const targeted = i % 4 === 3;
    const to = targeted ? [agents[(i + 1) % 4].name] : undefined;
    const result = await from.ok('send_message', { text: `p2chat-${token}-${i}`, ...(to === undefined ? {} : { to }) });
    sends.push({ from: from.name, targeted, result, at: Date.now() });
  }
  const lastSendAt = sends.at(-1)?.at ?? 0;
  report.check('P2M-02', lastSendAt < windows[1].end, `채팅 ${CHATS}건을 C 구간 안에 보냈다`, { last_send: kst(lastSendAt), c_end: kst(windows[1].end) });
  const delivered = sends.filter(({ targeted, result }) => result.undelivered.length === 0 && result.delivered.length === (targeted ? 1 : 3)).length;
  report.check('P2M-03', delivered === CHATS, `send_message ${CHATS}건이 모두 delivered(ack)`, { delivered });

  await sleepUntil(windows[2].end);
  // 받은 쪽 확인: 방 전체 글은 셋이, 대상 지정 글은 하나가 받는다.
  const expected = new Map(agents.map((agent) => [agent.name, 0]));
  for (const { from, targeted, result } of sends) {
    if (targeted) expected.set(result.delivered[0], expected.get(result.delivered[0]) + 1);
    else for (const agent of agents) if (agent.name !== from) expected.set(agent.name, expected.get(agent.name) + 1);
  }
  const received = agents.map((agent, index) => agent.events.slice(marks[index]).filter((event) => event.kind === 'chat').length);
  report.check(
    'P2M-04',
    agents.every((agent, index) => received[index] === expected.get(agent.name)),
    '받은 채팅 수가 보낸 쪽 ack 와 같다',
    { received, expected: agents.map((agent) => expected.get(agent.name)) },
  );

  for (const agent of agents) {
    await agent.stopPump();
    await agent.ok('leave_room');
  }
  const codes = [];
  for (const agent of agents) codes.push((await agent.close()).exit.code);
  report.check('P2M-05', codes.every((code) => code === 0), '네 프로세스 leave_room 뒤 종료 코드 0', codes);

  // ── 지표 ────────────────────────────────────────────────────────────────
  const start = windows[0].start;
  const end = windows[2].end;
  const apiDims = { ApiId: outputs.ApiId, Stage: outputs.StageName };
  const fnDims = { FunctionName: outputs.FunctionName };
  const read = async () => ({
    messages: await metricMinutes({ namespace: 'AWS/ApiGateway', metric: 'MessageCount', dimensions: apiDims, startMs: start, endMs: end }),
    invocations: await metricMinutes({ namespace: 'AWS/Lambda', metric: 'Invocations', dimensions: fnDims, startMs: start, endMs: end }),
  });
  const deadline = Date.now() + METRIC_WAIT_MS;
  let previous = null;
  let current = null;
  let stable = false;
  // 집계 지연: 마지막 분이 채워지고, 1분 간격으로 두 번 읽은 값이 같을 때까지 기다린다. 끝난 뒤 최소 3분은 기다린다.
  await sleepUntil(end + 180_000);
  while (Date.now() < deadline) {
    current = await read();
    const complete = current.messages.every((entry) => entry.present) && current.invocations.every((entry) => entry.present);
    if (complete && previous !== null && JSON.stringify(previous) === JSON.stringify(current)) {
      stable = true;
      break;
    }
    previous = current;
    await delay(60_000);
  }
  saveRaw(path.join(OUT, 'v-p2-metrics.json'), { windows, current });
  report.check('P2M-06', stable, '지표가 모든 분에 있고 1분 간격 두 번 읽은 값이 같다(집계 지연이 끝났다)', { read_at: kst(Date.now()) });
  const row = (minutes) => windows.map((w) => sumWindow(minutes, w.start, w.end));
  const msg = row(current.messages);
  const inv = row(current.invocations);
  report.note(`분별 MessageCount: ${current.messages.map((e) => e.sum).join(',')}`);
  report.note(`분별 Invocations: ${current.invocations.map((e) => e.sum).join(',')}`);
  report.check('P2M-07', Math.abs(msg[1] - msg[0]) <= 5 && Math.abs(msg[1] - msg[2]) <= 5, 'API Gateway MessageCount: |C−Q1| ≤ 5, |C−Q2| ≤ 5', {
    Q1: msg[0],
    C: msg[1],
    Q2: msg[2],
  });
  report.check('P2M-08', Math.abs(inv[1] - inv[0]) <= 5 && Math.abs(inv[1] - inv[2]) <= 5, 'Lambda Invocations: |C−Q1| ≤ 5, |C−Q2| ≤ 5', {
    Q1: inv[0],
    C: inv[1],
    Q2: inv[2],
  });

  // ── 보조: 로그 ──────────────────────────────────────────────────────────
  const access = await fetchLogEvents(outputs.AccessLogGroup, start - 60_000, end + 60_000);
  const fn = await fetchLogEvents(outputs.FunctionLogGroup, start - 60_000, end + 60_000);
  saveRaw(path.join(OUT, 'v-p2-access-raw.json'), access);
  saveRaw(path.join(OUT, 'v-p2-function-raw.json'), fn);
  const roomRef = roomRefOf(room);
  const accessRows = windows.map((w) => {
    const counts = {};
    let unparsed = 0;
    for (const line of access) {
      let value;
      try {
        value = JSON.parse(line.message);
      } catch {
        unparsed += 1;
        continue;
      }
      const at = Number(value.requestTimeEpoch);
      if (at < w.start || at >= w.end) continue;
      counts[value.eventType] = (counts[value.eventType] ?? 0) + 1;
    }
    return { window: w.name, ...counts, unparsed };
  });
  report.note(`접근 로그 구간별 eventType: ${JSON.stringify(accessRows)}`);
  const fnRows = windows.map((w) => {
    let starts = 0;
    let inits = 0;
    let relayAll = 0;
    let relayRoom = 0;
    let apps = 0;
    for (const line of fn) {
      if (line.timestamp < w.start || line.timestamp >= w.end) continue;
      if (line.message.startsWith('START ')) starts += 1;
      else if (line.message.startsWith('INIT_START')) inits += 1;
      else {
        const value = appJson(line.message);
        if (value !== null) apps += 1;
        if (value?.event === 'relay') {
          relayAll += 1;
          if (value.room_ref === roomRef) relayRoom += 1;
        }
      }
    }
    return { window: w.name, starts, inits, apps, relayAll, relayRoom };
  });
  report.note(`함수 로그 구간별: ${JSON.stringify(fnRows)}`);
  report.check('P2M-09', fnRows.every((entry) => entry.relayRoom === 0), '세 구간 모두 이 방의 relay 줄이 0 이다(채팅 구간 포함)', fnRows.map((entry) => entry.relayRoom));
  const otherTraffic = accessRows.some((entry) => (entry.CONNECT ?? 0) + (entry.DISCONNECT ?? 0) > 0) || fnRows.some((entry) => entry.relayAll > 0);
  report.note(otherTraffic ? '구간 안에 다른 연결의 접속·해제 또는 다른 방의 relay 가 있었다(지표에 섞였을 수 있다)' : '구간 안에 다른 연결의 접속·해제와 relay 가 없었다');
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
