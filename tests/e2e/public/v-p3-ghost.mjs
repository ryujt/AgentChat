#!/usr/bin/env node
// V-P3 유령 처리(verification-plan.md 3.3, architecture.md S14). 제품 코드가 아니다.
// 조립한 MCP 프로세스를 공용 서버(서버 인자 없음)로 띄운다. 서버 기록은 스택의 DynamoDB 테이블을 강한 일관성 Query 로 읽어 본다(읽기만).
//
// 가. SIGKILL: 두 참가자 방에서 한쪽을 SIGKILL 하고, 그 참가자 항목이 테이블에서 지워지기까지의 시간을 잰다.
//     이어서 새 참가자가 바로 입장되는지 본다(기록한다).
// 나. SIGSTOP: 두 참가자 방에서 한쪽을 SIGSTOP 하고, 새 참가자가 입장에 성공할 때까지 join_room 을 되풀이한다.
//     통과: 성공한 시도의 시작이 SIGSTOP 뒤 105초(90초 + 연결 기한 15초) 이내. 그 전의 실패가 모두 DIRECT_CONNECT_FAILED 이고
//     실패한 피어가 멈춘 참가자 하나, 단계 signaling 이다. 멈춘 참가자의 lastSeenAt 으로 서버의 오래됨 시점을 함께 적는다.
//     SIGCONT 뒤 멈췄던 참가자가 다시 등록되는지도 적는다.
//
// 실행: AGENT_CHAT_DIST=<빌드> TMPDIR=<임시> node tests/e2e/public/v-p3-ghost.mjs --out <스크래치> [--kill-rounds 5] [--stop-rounds 3] [--keep-home]
// 표지 파일(<out>/v-p3-markers.json, 권한 600)에 방 ID·이름을 남긴다(V-P5 가 쓴다).

import path from 'node:path';
import { argValue, createReport, delay, errorSummary, finish, newRoomId, PUBLIC_SERVER, startStack, until } from '../scenarios/harness.mjs';
import { createRoomReader, kst, saveRaw, stackOutputs } from './aws.mjs';

const rest = process.argv.slice(2);
const OUT = argValue(rest, 'out', null);
const KILL_ROUNDS = Number(argValue(rest, 'kill-rounds', '5'));
const STOP_ROUNDS = Number(argValue(rest, 'stop-rounds', '3'));
if (OUT === null) {
  process.stderr.write('--out <스크래치 폴더> 가 필요하다\n');
  process.exit(2);
}
const STALE_MS = 90_000;
const CONNECT_DEADLINE_MS = 15_000;
const report = createReport(`V-P3 유령 처리 (${PUBLIC_SERVER})`);
const markers = { rooms: [], names: [] };
let stack = null;
let reader = null;

const tag = newRoomId().slice(0, 6);
const nameOf = (role, round) => `p3${role}${round}-${tag}`;

async function enter(agent, room, mode) {
  await agent.ok(mode === 'create' ? 'create_room' : 'join_room', { room_id: room });
  agent.pump();
}

async function killRound(round) {
  const room = newRoomId();
  const names = [nameOf('ka', round), nameOf('kb', round), nameOf('kc', round)];
  markers.rooms.push(room);
  markers.names.push(...names);
  const [a, b, c] = [await stack.agent(names[0]), await stack.agent(names[1]), await stack.agent(names[2])];
  await enter(a, room, 'create');
  await enter(b, room, 'join');
  await until(async () => (await reader.peers(room)).some((entry) => entry.peer === names[1]), '서버 기록에 b 가 있다', 10_000, 100);
  const killedAt = Date.now();
  b.kill(); // 기다리지 않는다. 신호를 보낸 시각부터 잰다.
  let polls = 0;
  let lastPollMs = 0;
  const goneAt = await until(
    async () => {
      const startedAt = Date.now();
      const peers = await reader.peers(room);
      polls += 1;
      lastPollMs = Date.now() - startedAt;
      return peers.some((entry) => entry.peer === names[1]) ? null : Date.now();
    },
    '서버 기록에서 b 가 지워진다',
    120_000,
    20,
  ).catch(() => null);
  const goneMs = goneAt === null ? null : goneAt - killedAt;
  // 새 참가자가 바로 들어온다(죽은 참가자가 필수 목록에 없다).
  const joinStartedAt = Date.now();
  const joined = await c.call('join_room', { room_id: room }, { timeoutMs: 60_000 });
  const joinMs = Date.now() - joinStartedAt;
  for (const agent of [a, c]) {
    await agent.stopPump();
    await agent.call('leave_room');
  }
  for (const agent of [a, b, c]) await agent.close().catch(() => {});
  return { round, goneMs, polls, lastPollMs, joinOk: !joined.isError, joinMs, joinError: errorSummary(joined) };
}

async function stopRound(round) {
  const room = newRoomId();
  const names = [nameOf('sa', round), nameOf('sb', round), nameOf('sc', round)];
  markers.rooms.push(room);
  markers.names.push(...names);
  const [a, b, c] = [await stack.agent(names[0]), await stack.agent(names[1]), await stack.agent(names[2])];
  await enter(a, room, 'create');
  await enter(b, room, 'join');
  // 라운드마다 ping 주기 안의 다른 자리에서 멈춘다.
  await delay(3_000 + round * 7_000);
  await b.stopPump();
  const before = (await reader.peers(room)).find((entry) => entry.peer === names[1]);
  b.pause();
  const stoppedAt = Date.now();
  const lastSeenAge = before === undefined ? null : stoppedAt - before.lastSeenAt;
  const staleRel = before === undefined ? null : before.lastSeenAt + STALE_MS - stoppedAt;
  const attempts = [];
  try {
    for (;;) {
      const startedAt = Date.now();
      if (startedAt - stoppedAt > 240_000) break;
      const reply = await c.call('join_room', { room_id: room }, { timeoutMs: 90_000 });
      const endedAt = Date.now();
      const peers = reply.json?.error?.details?.peers ?? [];
      attempts.push({
        startRel: startedAt - stoppedAt,
        endRel: endedAt - stoppedAt,
        ok: !reply.isError,
        code: reply.isError ? (reply.json?.error?.code ?? 'unknown') : 'ok',
        peers: peers.map((peer) => ({ who: peer.name === names[1] ? 'stopped' : peer.name === names[0] ? 'creator' : 'other', stage: peer.stage, reason: peer.reason })),
      });
      if (!reply.isError) break;
    }
  } finally {
    b.resume();
  }
  const resumedAt = Date.now();
  // SIGCONT 뒤: 멈췄던 참가자가 다시 등록되는가(테이블의 lastSeenAt 이 SIGCONT 뒤 값으로 바뀐다).
  const reRegistered = await until(
    async () => {
      const entry = (await reader.peers(room)).find((value) => value.peer === names[1]);
      return entry !== undefined && entry.lastSeenAt >= resumedAt ? Date.now() : null;
    },
    'SIGCONT 뒤 재등록',
    90_000,
    500,
  ).catch(() => null);
  const reconnects = b.logs('signal.state').filter((line) => line.state === 'reconnecting').length;
  for (const agent of [a, b, c]) {
    await agent.stopPump();
    await agent.call('leave_room');
  }
  for (const agent of [a, b, c]) await agent.close().catch(() => {});
  return {
    round,
    stopAt: kst(stoppedAt),
    lastSeenAge,
    staleRel,
    attempts,
    reRegisteredMs: reRegistered === null ? null : reRegistered - resumedAt,
    reconnectsAfterResume: reconnects,
  };
}

async function run() {
  const outputs = await stackOutputs();
  reader = createRoomReader(outputs.TableName);
  stack = await startStack({ label: 'v-p3', server: PUBLIC_SERVER, keepHome: rest.includes('--keep-home') });
  report.note(`임시 홈: ${rest.includes('--keep-home') ? stack.homeRoot : '끝나면 지움'}`);

  const kills = [];
  for (let round = 1; round <= KILL_ROUNDS; round += 1) {
    const result = await killRound(round);
    kills.push(result);
    report.note(`SIGKILL ${round}: 기록 삭제 ${result.goneMs}ms(조회 ${result.polls}회, 마지막 조회 ${result.lastPollMs}ms), 새 입장 ${result.joinOk ? '성공' : `실패 ${result.joinError}`} ${result.joinMs}ms`);
  }
  report.check(
    'P3-K1',
    kills.every((entry) => entry.goneMs !== null),
    `SIGKILL ${KILL_ROUNDS}회 모두 서버 기록이 지워졌다(시간 기록)`,
    { gone_ms: kills.map((entry) => entry.goneMs) },
  );
  report.check('P3-K2', kills.every((entry) => entry.joinOk), '기록이 지워진 뒤 새 참가자의 입장이 바로 성공한다', { join_ms: kills.map((entry) => entry.joinMs) });

  const stops = [];
  for (let round = 1; round <= STOP_ROUNDS; round += 1) {
    const result = await stopRound(round);
    stops.push(result);
    const success = result.attempts.find((entry) => entry.ok);
    report.note(
      `SIGSTOP ${round} (${result.stopAt}): 멈출 때 lastSeenAt 나이 ${result.lastSeenAge}ms → 오래됨 시점 +${result.staleRel}ms. 시도 ${result.attempts
        .map((entry) => `[${entry.startRel}~${entry.endRel} ${entry.code}${entry.peers.map((peer) => ` ${peer.who}:${peer.stage}/${peer.reason}`).join('')}]`)
        .join(' ')}. SIGCONT 뒤 재등록 ${result.reRegisteredMs}ms, 재접속 ${result.reconnectsAfterResume}회`,
    );
    const failures = result.attempts.filter((entry) => !entry.ok);
    report.check(
      `P3-S${round}a`,
      success !== undefined && success.startRel <= STALE_MS + CONNECT_DEADLINE_MS,
      'SIGSTOP 뒤 신규 입장이 가능해진 시각(성공한 시도의 시작)이 90초 + 연결 기한(15초) 이내',
      { success_start_ms: success?.startRel ?? null, success_end_ms: success?.endRel ?? null, stale_at_ms: result.staleRel },
    );
    report.check(
      `P3-S${round}b`,
      failures.every((entry) => entry.code === 'DIRECT_CONNECT_FAILED' && entry.peers.length === 1 && entry.peers[0].who === 'stopped' && entry.peers[0].stage === 'signaling'),
      '그동안의 입장 실패가 모두 DIRECT_CONNECT_FAILED, 멈춘 참가자 하나, 단계 signaling',
      { failures: failures.length },
    );
    report.check(`P3-S${round}c`, result.reRegisteredMs !== null, 'SIGCONT 뒤 멈췄던 참가자가 다시 등록된다(기록)', { ms: result.reRegisteredMs });
  }
  saveRaw(path.join(OUT, 'v-p3-markers.json'), markers);
  saveRaw(path.join(OUT, 'v-p3-results.json'), { kills, stops });
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
if (markers.rooms.length > 0) saveRaw(path.join(OUT, 'v-p3-markers.json'), markers);
reader?.close();
await finish(report, stack, failure);
