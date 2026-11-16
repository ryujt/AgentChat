#!/usr/bin/env node
// V-P5 로그와 스로틀(verification-plan.md 3.3, deployment.md 2.7). 제품 코드가 아니다.
//
// 1. 표지 실행: 조립한 MCP 프로세스 3개를 공용 서버로 한 방에 넣고, 표지를 심은 채팅·역할을 보낸다.
//    실제 SDP·후보 조각을 표지로 쓰려고 이 PC 의 시험용 프록시(tests/support/signal-proxy.mjs)를 공용 서버 앞에 둔다.
//    프록시는 버리거나 늦추지 않는다. 클라이언트가 보낸 offer·answer·후보의 조각을 메모리에 모을 뿐이다.
// 2. 스로틀: 입장하지 않은 다른 연결 여러 개로 스테이지 기본 한도(초당 25, 버스트 100)를 넘기고 클라이언트가 받은 것을 센다.
//    스테이지 스로틀 설정은 바꾸지 않는다.
// 3. 로그 확인: --since 부터 지금까지의 함수 로그·접근 로그를 받아 표지 원문을 찾는다(V-P2·V-P3 의 표지 파일도 함께).
//    접근 로그 줄이 모두 JSON 으로 읽히는지, 스로틀 줄이 어떻게 남는지 본다. 로그 그룹 보존이 7일인지 본다.
// 통과: 표지 종류(채팅 본문, 방 ID, 참가자 이름, SDP 조각)마다 0건, 보존 7일, 스로틀 때 클라이언트가 받은 것을 기록.
//
// 실행: AGENT_CHAT_DIST=<빌드> TMPDIR=<임시> node tests/e2e/public/v-p5-logs.mjs --out <스크래치> --since <epoch ms>
//         [--markers <파일,파일>] [--flood-conns 20] [--flood-rate 100] [--flood-sec 20]
// 표준 출력에는 표지 원문을 쓰지 않는다. 건수만 쓴다. 받은 로그 원문은 --out 에 권한 600 으로 남긴다.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startSignalProxy } from '../../support/signal-proxy.mjs';
import { argValue, createReport, delay, finish, newRoomId, PUBLIC_SERVER, startStack, until } from '../scenarios/harness.mjs';
import { appJson, fetchLogEvents, kst, retentionDays, saveRaw, stackOutputs } from './aws.mjs';
import { startFlood } from './flood.mjs';

const rest = process.argv.slice(2);
const OUT = argValue(rest, 'out', null);
const SINCE = Number(argValue(rest, 'since', 'NaN'));
const EXTRA = (argValue(rest, 'markers', '') ?? '').split(',').filter((entry) => entry !== '');
const FLOOD_CONNS = Number(argValue(rest, 'flood-conns', '20'));
const FLOOD_RATE = Number(argValue(rest, 'flood-rate', '100'));
const FLOOD_SEC = Number(argValue(rest, 'flood-sec', '20'));
if (OUT === null || !Number.isFinite(SINCE)) {
  process.stderr.write('--out <스크래치 폴더> 와 --since <epoch ms> 가 필요하다\n');
  process.exit(2);
}

const report = createReport(`V-P5 로그와 스로틀 (${PUBLIC_SERVER})`);
const token = newRoomId().slice(0, 8);
let stack = null;
let proxy = null;

/** 표지: {kind, value}. kind 는 chat | room | name | sdp | generic. */
const markers = [];
const addMarker = (kind, value, note) => {
  if (typeof value === 'string' && value.length > 0 && !markers.some((entry) => entry.value === value)) markers.push({ kind, value, note });
};

/** 프록시가 본 signal 에서 SDP·후보 조각을 모은다. */
function captureSignal(message) {
  if (message.kind === 'offer' || message.kind === 'answer') {
    const sdp = message.data?.sdp ?? '';
    for (const line of sdp.split(/\r?\n/)) {
      const ufrag = /^a=ice-ufrag:(.+)$/.exec(line);
      if (ufrag) addMarker('sdp', ufrag[1].trim(), 'ice-ufrag');
      const pwd = /^a=ice-pwd:(.+)$/.exec(line);
      if (pwd) addMarker('sdp', pwd[1].trim(), 'ice-pwd');
      const fingerprint = /^a=fingerprint:\S+ (.+)$/.exec(line);
      if (fingerprint) addMarker('sdp', fingerprint[1].trim(), 'fingerprint');
      const candidate = /^a=candidate:(.+)$/.exec(line);
      if (candidate) addMarker('sdp', candidate[1].trim(), 'sdp-candidate');
      const origin = /^o=\S+ (\d{6,}) /.exec(line);
      if (origin) addMarker('sdp', origin[1], 'o=session-id');
    }
  } else if (message.kind === 'candidate') {
    for (const item of message.data?.list ?? []) addMarker('sdp', String(item.candidate).replace(/^(a=)?candidate:/, ''), 'candidate');
  }
  return false;
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

async function markerRun() {
  proxy = await startSignalProxy({ upstream: PUBLIC_SERVER });
  proxy.addRule({ dir: 'c2s', action: 'signal', match: captureSignal, op: 'drop' });
  stack = await startStack({ label: 'v-p5', server: proxy.url });
  const room = newRoomId();
  const names = [0, 1, 2].map((index) => `mk${index}${token}`);
  addMarker('room', room);
  for (const name of names) addMarker('name', name);
  const agents = [];
  for (const name of names) agents.push(await stack.agent(name));
  await agents[0].ok('create_room', { room_id: room });
  agents[0].pump();
  for (const agent of agents.slice(1)) {
    await agent.ok('join_room', { room_id: room });
    agent.pump();
  }
  const meshed = await until(() => meshComplete(agents), '전원 mesh', 20_000, 250).catch(() => false);
  report.check('P5-01', meshed === true, '표지 실행: 3 프로세스가 프록시 → 공용 서버로 입장, 3쌍 link open');
  const role = `mkrole-${token}`;
  addMarker('chat', role, 'role');
  await agents[0].ok('set_status', { status: 'ready', role });
  let delivered = 0;
  for (let i = 0; i < 10; i += 1) {
    const text = `mkchat-${token}-${i} 표지 본문 ${token.split('').reverse().join('')}`;
    addMarker('chat', text);
    addMarker('chat', `mkchat-${token}-${i}`);
    const result = await agents[i % 3].ok('send_message', { text });
    if (result.undelivered.length === 0 && result.delivered.length === 2) delivered += 1;
  }
  report.check('P5-02', delivered === 10, '표지 채팅 10건이 모두 delivered', { delivered });
  for (const agent of agents) {
    await agent.stopPump();
    await agent.ok('leave_room');
  }
  for (const agent of agents) await agent.close();
  const sdpCount = markers.filter((entry) => entry.kind === 'sdp').length;
  const byNote = {};
  for (const entry of markers.filter((value) => value.kind === 'sdp')) byNote[entry.note] = (byNote[entry.note] ?? 0) + 1;
  report.check('P5-03', sdpCount > 0, '프록시가 실제 SDP·후보 조각을 표지로 모았다', byNote);
}

function loadExtraMarkers() {
  for (const file of EXTRA) {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value.room === 'string') addMarker('room', value.room);
    for (const room of value.rooms ?? []) addMarker('room', room);
    for (const name of value.names ?? []) addMarker('name', name);
    if (typeof value.chatPrefix === 'string') addMarker('chat', value.chatPrefix, 'prefix');
  }
}

async function floodRun() {
  const flood = await startFlood({ url: PUBLIC_SERVER, connections: FLOOD_CONNS, ratePerSec: FLOOD_RATE });
  const startedAt = flood.startedAt;
  await delay(FLOOD_SEC * 1000);
  const stats = await flood.stop();
  report.note(`스로틀 부하(${kst(startedAt)}, 연결 ${FLOOD_CONNS}, 목표 초당 ${FLOOD_RATE}): ${JSON.stringify(stats)}`);
  report.check(
    'P5-T1',
    stats.gateway > 0,
    '다른 연결로 스테이지 한도를 넘겼다(게이트웨이 프레임을 받았다). 받은 프레임 모양과 연결 유지 여부를 기록한다',
    { sent: stats.sent, server_replies: stats.notJoined, gateway_frames: stats.gateway, closed_during: stats.closed, rate_limited: stats.rateLimited },
  );
  return { startedAt, endedAt: Date.now(), stats };
}

function scanLogs(lines, label) {
  const hits = {};
  for (const marker of markers) {
    const key = marker.note === undefined ? marker.kind : `${marker.kind}:${marker.note}`;
    hits[key] ??= { markers: 0, hits: 0 };
    hits[key].markers += 1;
    for (const line of lines) if (line.message.includes(marker.value)) hits[key].hits += 1;
  }
  const generic = ['a=ice-ufrag', 'a=ice-pwd', 'a=fingerprint', 'a=candidate', 'candidate:', 'm=application', 'v=0', '"sdp"', '"text"', '"room"', '"peer":'];
  const genericHits = Object.fromEntries(generic.map((needle) => [needle, lines.filter((line) => line.message.includes(needle)).length]));
  report.note(`${label}: 줄 ${lines.length}, 표지별 ${JSON.stringify(hits)}, 일반 문자열 ${JSON.stringify(genericHits)}`);
  return { hits, genericHits };
}

async function run() {
  const outputs = await stackOutputs();
  const runStartedAt = Date.now();
  await markerRun();
  loadExtraMarkers();
  const flood = await floodRun();

  // 로그가 들어올 때까지: 접근 로그에 부하 끝 무렵의 줄이 보이고, 두 번 읽은 줄 수가 같을 때까지(최대 10분).
  let access = [];
  let fn = [];
  const deadline = Date.now() + 600_000;
  let previous = -1;
  await delay(30_000);
  while (Date.now() < deadline) {
    access = await fetchLogEvents(outputs.AccessLogGroup, SINCE, Date.now());
    fn = await fetchLogEvents(outputs.FunctionLogGroup, SINCE, Date.now());
    const lastAccess = Math.max(0, ...access.map((line) => line.timestamp));
    const total = access.length + fn.length;
    if (lastAccess >= flood.endedAt - 10_000 && total === previous) break;
    previous = total;
    await delay(30_000);
  }
  saveRaw(path.join(OUT, 'v-p5-access-raw.json'), access);
  saveRaw(path.join(OUT, 'v-p5-function-raw.json'), fn);
  saveRaw(path.join(OUT, 'v-p5-markers.json'), markers);
  report.note(`로그 범위 ${kst(SINCE)}~${kst(Date.now())}, 표지 실행 시작 ${kst(runStartedAt)}`);

  // 표지 원문.
  const accessScan = scanLogs(access, '접근 로그');
  const fnScan = scanLogs(fn, '함수 로그');
  for (const kind of ['chat', 'room', 'name', 'sdp']) {
    const total = (scan) => Object.entries(scan.hits).filter(([key]) => key.split(':')[0] === kind).reduce((sum, [, value]) => sum + value.hits, 0);
    const count = markers.filter((entry) => entry.kind === kind).length;
    report.check(`P5-M-${kind}`, count > 0 && total(accessScan) === 0 && total(fnScan) === 0, `표지 ${kind} ${count}개가 접근 로그·함수 로그에 0건`, {
      access: total(accessScan),
      function: total(fnScan),
    });
  }
  const sdpGeneric = ['a=ice-ufrag', 'a=ice-pwd', 'a=fingerprint', 'a=candidate', 'candidate:', 'm=application'];
  report.check(
    'P5-M-generic',
    sdpGeneric.every((needle) => accessScan.genericHits[needle] === 0 && fnScan.genericHits[needle] === 0),
    'SDP 일반 문자열(a=ice-*, a=fingerprint, candidate:, m=application)이 두 로그에 0건',
  );

  // 접근 로그 형식과 스로틀 줄.
  let unparsed = 0;
  const statuses = {};
  const errors = {};
  const throttled = [];
  for (const line of access) {
    let value;
    try {
      value = JSON.parse(line.message);
    } catch {
      unparsed += 1;
      continue;
    }
    statuses[value.status] = (statuses[value.status] ?? 0) + 1;
    errors[value.error] = (errors[value.error] ?? 0) + 1;
    const at = Number(value.requestTimeEpoch);
    if (at >= flood.startedAt - 2_000 && at <= flood.endedAt + 5_000 && value.status === '429') throttled.push(value);
  }
  report.note(`접근 로그 status 분포 ${JSON.stringify(statuses)}, error 분포 ${JSON.stringify(errors)}`);
  report.check('P5-A1', unparsed === 0, '접근 로그의 모든 줄이 JSON 으로 읽힌다(스로틀 줄 포함)', { lines: access.length, unparsed });
  const shapes = {};
  for (const value of throttled) {
    const key = `${value.eventType}|${value.routeKey}|${value.status}|${value.error}|${value.integrationStatus}`;
    shapes[key] = (shapes[key] ?? 0) + 1;
  }
  report.note(`부하 구간의 429 줄 모양: ${JSON.stringify(shapes)}`);
  report.check('P5-A2', throttled.length > 0, '스로틀된 메시지가 접근 로그에 429 로 남는다(기록)', { lines: throttled.length });

  // 함수 로그 필드.
  const fields = new Set();
  let appLines = 0;
  let peerField = 0;
  for (const line of fn) {
    const value = appJson(line.message);
    if (value === null) continue;
    appLines += 1;
    for (const key of Object.keys(value)) fields.add(key);
    if ('peer' in value) peerField += 1;
  }
  report.check('P5-F1', appLines > 0 && peerField === 0, '함수 로그 앱 줄에 peer 필드가 없다', { app_lines: appLines, fields: [...fields].sort().join(',') });

  // 보존.
  const retentions = {};
  for (const group of [outputs.FunctionLogGroup, outputs.AccessLogGroup, `/aws/lambda/${outputs.FunctionName}`]) retentions[group] = await retentionDays(group);
  report.note(`보존 일수: ${JSON.stringify(retentions)}`);
  report.check(
    'P5-R1',
    retentions[outputs.FunctionLogGroup] === 7 && retentions[outputs.AccessLogGroup] === 7 && retentions[`/aws/lambda/${outputs.FunctionName}`] === null,
    '함수·접근 로그 그룹 보존 7일, 기본 이름의 Lambda 로그 그룹은 없다',
  );
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
if (proxy !== null) await proxy.close().catch(() => {});
await finish(report, stack, failure);
