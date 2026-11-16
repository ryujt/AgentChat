#!/usr/bin/env node
// V-L3: 서버 + 조립한 MCP 프로세스 + 시험용 프록시 (verification-plan.md 3.2, 시나리오 S3).
// 한 쌍의 후보를 양방향으로 버리면 입장이 20초 안에 DIRECT_CONNECT_FAILED(단계 ice)로 끝난다.
// 한 참가자를 SIGSTOP 하거나 그 쌍의 offer 를 계속 버리면 단계가 signaling 이다. 끝난 뒤 서버 등록과 링크가 없다.
// (Gate 3 추가) 그 쌍의 answer 를 계속 버려도 입장자(답한 쪽)의 단계가 signaling 이다(L3-12).
// relay 후보가 0개다. turn: 설정이면 접속 전에 ICE_CONFIG_REJECTED 이고 프로세스는 떠 있다.
//
// 실행: node tests/e2e/scenarios/v-l3.mjs [--ice none]
// 프록시와 서버 로그가 필요하므로 자체 호스팅에서만 돈다(--server 를 주면 turn: 항목만 하고 나머지는 미실행으로 적는다).
// 주입으로 만든 실패다. 실제 NAT·방화벽의 실패가 아니다.

import { createReport, delay, errorSummary, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';

const options = scenarioOptions();
const report = createReport(`V-L3 (${options.server ?? '자체 호스팅'})`);
const JOIN_LIMIT_MS = 20_000;
let stack = null;
/** 프록시를 지난 candidate 시그널 가운데 relay 후보가 든 것. 본문은 남기지 않는다. */
let relayCandidates = 0;
let candidatesSeen = 0;

/** 입장 실패 뒤의 상태: 입장자는 방에 없고, 서버 등록이 없고, 기존 참가자에게 그와의 링크가 없다. */
async function afterFailure(id, joiner, existing) {
  const status = await joiner.call('get_status');
  const notInRoom = status.isError && status.json?.error?.code === 'NOT_IN_ROOM';
  const unregistered = await until(() => stack.registered(joiner.name) === false, `${joiner.name} 등록 해제`, 5_000, 50).then(
    () => true,
    () => false,
  );
  const noLinks = await until(
    async () => {
      for (const agent of existing) {
        const row = await agent.participant(joiner.name);
        if (row !== null && row.link !== 'none') return false;
      }
      return true;
    },
    '기존 참가자에게 링크 없음',
    5_000,
    100,
  ).then(
    () => true,
    () => false,
  );
  report.check(id, notInRoom && unregistered && noLinks, `실패 뒤: ${joiner.name} 은 방에 없고(NOT_IN_ROOM), 서버 등록이 없고, 기존 참가자에게 그와의 링크가 없다`, {
    notInRoom,
    unregistered,
    noLinks,
  });
}

/** 입장 결과를 기다리며 걸린 시간을 잰다. */
async function timedJoin(agent, room) {
  const startedAt = Date.now();
  const reply = await agent.call('join_room', { room_id: room }, { timeoutMs: 60_000 });
  return { reply, ms: Date.now() - startedAt };
}

function failedPeers(reply) {
  return reply.json?.error?.details?.peers ?? [];
}

async function iceCase() {
  const room = newRoomId();
  const anna = await stack.agent('anna');
  const bert = await stack.agent('bert');
  const carl = await stack.agent('carl');
  await anna.ok('create_room', { room_id: room });
  anna.pump();
  await carl.ok('join_room', { room_id: room });
  carl.pump();
  const rule = stack.proxy.addRule({ pair: ['anna', 'bert'], kind: 'candidate', op: 'drop' });
  const { reply, ms } = await timedJoin(bert, room);
  const peers = failedPeers(reply);
  const annaFail = peers.find((peer) => peer.name === 'anna');
  report.check(
    'L3-01',
    reply.isError && reply.json?.error?.code === 'DIRECT_CONNECT_FAILED' && ms <= JOIN_LIMIT_MS && annaFail?.stage === 'ice' && peers.length === 1,
    `후보를 양방향으로 버리면 ${JOIN_LIMIT_MS / 1000}초 안에 DIRECT_CONNECT_FAILED, anna 의 단계 ice (carl 은 성공해 싣지 않는다)`,
    { ms, error: errorSummary(reply), hint: reply.json?.error?.details?.hint?.slice(0, 40), candidates: annaFail?.candidates, resends: annaFail?.resends },
  );
  report.check('L3-02', rule.hits > 0, '주입이 일어났다(버린 candidate 시그널 수)', rule.hits);
  // 로그로 실패 피어, 단계, 사유를 가려낼 수 있다. 파일 로거는 200ms 마다 모아 쓰므로 나올 때까지 기다린다.
  await until(() => bert.logs('join.end').some((line) => line.outcome === 'failed'), 'join.end 줄', 3_000, 50).catch(() => {});
  const joinEnd = bert.logs('join.end').filter((line) => line.outcome === 'failed');
  const attemptEnd = bert.logs('link.attempt_end').filter((line) => line.peer === 'anna' && line.stage === 'ice');
  report.check(
    'L3-03',
    joinEnd.some((line) => line.peer === 'anna' && line.stage === 'ice') && attemptEnd.length >= 1,
    '진단 로그(join.end, link.attempt_end)에 실패 피어·단계·사유가 남는다',
    { join_end: joinEnd.map((line) => `${line.peer}:${line.stage}/${line.reason}`), attempt_end: attemptEnd.map((line) => `${line.reason}/${line.ice_state}`) },
  );
  rule.remove();
  await afterFailure('L3-04', bert, [anna, carl]);
  // 같은 참가자가 주입을 걷은 뒤 다시 들어오면 된다.
  const retry = await timedJoin(bert, room);
  report.check('L3-05', !retry.reply.isError, '주입을 걷은 뒤 다시 join_room 하면 성공한다', { ms: retry.ms, result: errorSummary(retry.reply) });
  for (const agent of [anna, bert, carl]) {
    await agent.stopPump();
    await agent.ok('leave_room');
    await agent.close();
  }
}

async function stoppedPeerCase() {
  const room = newRoomId();
  const cara = await stack.agent('cara');
  const dave = await stack.agent('dave');
  const erin = await stack.agent('erin');
  await cara.ok('create_room', { room_id: room });
  cara.pump();
  await dave.ok('join_room', { room_id: room });
  dave.pump();
  await delay(500);
  dave.pause();
  let joined;
  try {
    joined = await timedJoin(erin, room);
  } finally {
    dave.resume();
  }
  const peers = failedPeers(joined.reply);
  const daveFail = peers.find((peer) => peer.name === 'dave');
  report.check(
    'L3-06',
    joined.reply.isError && joined.reply.json?.error?.code === 'DIRECT_CONNECT_FAILED' && daveFail?.stage === 'signaling' && joined.ms <= JOIN_LIMIT_MS && peers.length === 1,
    '멈춘(SIGSTOP) 참가자가 있으면 단계 signaling 으로 끝난다(cara 는 성공)',
    { ms: joined.ms, error: errorSummary(joined.reply), hint: joined.reply.json?.error?.details?.hint?.slice(0, 40) },
  );
  await afterFailure('L3-07', erin, [cara]);
  for (const agent of [cara, dave, erin]) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

async function droppedOfferCase() {
  const room = newRoomId();
  const fay = await stack.agent('fay');
  const gus = await stack.agent('gus');
  const hal = await stack.agent('hal');
  await fay.ok('create_room', { room_id: room });
  fay.pump();
  await gus.ok('join_room', { room_id: room });
  gus.pump();
  // gus < hal 이므로 gus 가 offer 를 보낸다. 그 offer 를 계속 버린다.
  const rule = stack.proxy.addRule({ pair: ['gus', 'hal'], kind: 'offer', op: 'drop' });
  const joined = await timedJoin(hal, room);
  rule.remove();
  const peers = failedPeers(joined.reply);
  const gusFail = peers.find((peer) => peer.name === 'gus');
  report.check(
    'L3-08',
    joined.reply.isError && joined.reply.json?.error?.code === 'DIRECT_CONNECT_FAILED' && gusFail?.stage === 'signaling' && joined.ms <= JOIN_LIMIT_MS && peers.length === 1,
    '그 쌍의 offer 를 계속 버리면 단계 signaling 으로 끝난다',
    { ms: joined.ms, error: errorSummary(joined.reply), dropped: rule.hits },
  );
  await afterFailure('L3-09', hal, [fay, gus]);
  for (const agent of [fay, gus, hal]) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

// Gate 3 에서 더함(W9 공용 서버 P-W9P-08 의 관찰): 답한 쪽의 answer 만 계속 사라지면, 답한 쪽은 ICE 가 연결된 채 기한을 맞는다.
// 직접 경로는 있으므로 입장자(답한 쪽)의 오류도 단계 signaling 이어야 한다(protocol.md 3.3).
async function droppedAnswerCase() {
  const room = newRoomId();
  const mia = await stack.agent('mia');
  const nat = await stack.agent('nat');
  const pia = await stack.agent('pia');
  await mia.ok('create_room', { room_id: room });
  mia.pump();
  await nat.ok('join_room', { room_id: room });
  nat.pump();
  // nat < pia 이므로 nat 가 offer 를 보내고 입장자 pia 가 answer 를 보낸다. 그 answer 를 계속 버린다(다시 보낸 것도).
  const rule = stack.proxy.addRule({ pair: ['nat', 'pia'], kind: 'answer', op: 'drop' });
  const joined = await timedJoin(pia, room);
  rule.remove();
  const peers = failedPeers(joined.reply);
  const natFail = peers.find((peer) => peer.name === 'nat');
  report.check(
    'L3-12',
    joined.reply.isError &&
      joined.reply.json?.error?.code === 'DIRECT_CONNECT_FAILED' &&
      natFail?.stage === 'signaling' &&
      joined.ms <= JOIN_LIMIT_MS &&
      peers.length === 1 &&
      rule.hits > 0,
    '그 쌍의 answer 를 계속 버리면(답한 쪽 ICE 는 연결됨) 입장자의 오류도 단계 signaling 이다',
    { ms: joined.ms, error: errorSummary(joined.reply), stage: natFail?.stage, reason: natFail?.reason, ice_state: natFail?.ice_state, dropped: rule.hits },
  );
  await afterFailure('L3-13', pia, [mia, nat]);
  for (const agent of [mia, nat, pia]) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

async function turnCase() {
  const connectionsBefore = stack.proxy?.stats().connections ?? null;
  const results = [];
  for (const [label, ice] of [
    ['turn', 'turn:turn.example.com:3478'],
    ['turns', 'turns:turn.example.com:5349'],
    ['mixed', 'stun:stun.l.google.com:19302,turn:turn.example.com:3478'],
  ]) {
    const agent = await stack.agent(`ivy-${label}`, { env: { AGENT_CHAT_ICE_SERVERS: ice } });
    const created = await agent.call('create_room', { room_id: newRoomId() });
    const joined = await agent.call('join_room', { room_id: newRoomId() });
    const status = await agent.call('get_status');
    results.push({
      label,
      created: errorSummary(created),
      joined: errorSummary(joined),
      alive: agent.alive(),
      status: errorSummary(status),
    });
    await agent.close();
  }
  const noConnection = connectionsBefore === null || stack.proxy.stats().connections === connectionsBefore;
  report.check(
    'L3-10',
    results.every((row) => row.created === 'ICE_CONFIG_REJECTED' && row.joined === 'ICE_CONFIG_REJECTED' && row.alive && row.status === 'NOT_IN_ROOM') && noConnection,
    'turn:·turns:·섞인 목록: create_room·join_room 이 ICE_CONFIG_REJECTED, 서버에 접속하지 않았고 프로세스는 떠 있다',
    { results, noConnection },
  );
}

async function run() {
  stack = await startStack({ label: 'v-l3', proxy: true, ...options });
  if (stack.selfHosted) {
    // 모든 candidate 시그널을 보며 relay 후보를 센다. 걸러 내지 않는다(match 가 언제나 거짓).
    stack.proxy.addRule({
      kind: 'candidate',
      op: 'drop',
      match: (message) => {
        candidatesSeen += 1;
        if (/\btyp relay\b/.test(JSON.stringify(message))) relayCandidates += 1;
        return false;
      },
    });
    await iceCase();
    await stoppedPeerCase();
    await droppedOfferCase();
    await droppedAnswerCase();
  } else {
    report.skip('L3-01..09, L3-12..13', '후보·offer 버리기와 SIGSTOP', '프록시와 서버 로그는 자체 호스팅에서만 쓸 수 있다');
  }
  await turnCase();
  if (stack.selfHosted) {
    const ignoredRelay = stack.agents.flatMap((agent) => agent.logs('signal.ignored').filter((line) => line.reason === 'relay'));
    report.check('L3-11', relayCandidates === 0 && ignoredRelay.length === 0 && candidatesSeen > 0, 'relay 후보가 0개다(프록시를 지난 candidate 시그널 전부와 진단 로그)', {
      candidate_signals: candidatesSeen,
      relay: relayCandidates,
      ignored_relay: ignoredRelay.length,
    });
  }
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
