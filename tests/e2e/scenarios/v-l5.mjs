#!/usr/bin/env node
// V-L5: 서버 재시작, 서버 쪽에서 소켓 끊기 (verification-plan.md 3.2, 시나리오 S6).
// DataChannel 이 유지된다. 끊긴 동안 채팅이 전달된다. 재등록 뒤 신규 입장이 된다. 끊긴 사이 입장한 참가자와 mesh 가 메워진다.
// 끊긴 사이 다른 프로세스가 같은 이름을 차지해도 원래 참가자의 링크가 닫히지 않고, 차지한 쪽이 나가면 재등록된다.
//
// 실행: node tests/e2e/scenarios/v-l5.mjs [--ice none]
// 서버를 다시 띄우고 프록시로 소켓을 끊으므로 자체 호스팅에서만 돈다(--server 를 주면 모두 미실행으로 적는다).

import { createReport, delay, errorSummary, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';

const options = scenarioOptions();
const report = createReport(`V-L5 (${options.server ?? '자체 호스팅'})`);
let stack = null;

/** 링크가 닫힌 기록(진단 로그 link.closed) 가운데 since 뒤의 것. */
const closedSince = (agent, since) => agent.logs('link.closed').filter((line) => Date.parse(line.ts) >= since);

async function allOpen(agents) {
  for (const agent of agents) {
    const status = await agent.status();
    for (const other of agents) {
      if (other === agent) continue;
      if (status.participants.find((row) => row.name === other.name)?.link !== 'open') return false;
    }
  }
  return true;
}

async function signalingConnected(agent) {
  return (await agent.status()).room.signaling === 'connected';
}

async function run() {
  stack = await startStack({ label: 'v-l5', proxy: true, ...options });
  if (!stack.selfHosted) {
    report.skip('L5-*', '서버 재시작과 소켓 끊기', '자체 호스팅에서만 할 수 있다');
    return;
  }
  const room = newRoomId();
  const anna = await stack.agent('anna');
  const bert = await stack.agent('bert');
  await anna.ok('create_room', { room_id: room });
  anna.pump();
  await bert.ok('join_room', { room_id: room });
  bert.pump();
  await until(() => allOpen([anna, bert]), 'anna–bert 링크', 10_000, 100);

  // ── 서버 재시작 ───────────────────────────────────────────────────────────
  const restartAt = Date.now();
  await stack.server.proc.stop({ signal: 'SIGTERM', timeoutMs: 6_000 });
  await until(async () => !(await signalingConnected(anna)) && !(await signalingConnected(bert)), '두 참가자가 끊김을 앎', 10_000, 100);
  const duringDown = await anna.ok('send_message', { text: 'while the server is down' });
  report.check('L5-01', duringDown.delivered.includes('bert'), '서버가 내려가 있는 동안 채팅이 전달된다(DataChannel)', duringDown.delivered);
  const notice = (await anna.call('get_status')).json?.notice?.signaling;
  report.note(`서버가 없는 동안 anna 의 notice.signaling: ${JSON.stringify(notice)}`);
  await delay(2_000);
  await stack.restartServer();
  const reRegistered = await until(() => stack.registered('anna') && stack.registered('bert'), '재등록', 45_000, 100).then(
    () => Date.now() - restartAt,
    () => null,
  );
  report.check('L5-02', reRegistered !== null && (await signalingConnected(anna)) && (await signalingConnected(bert)), '다시 띄운 서버에 두 참가자가 재등록한다', {
    ms_from_stop: reRegistered,
  });
  report.check(
    'L5-03',
    closedSince(anna, restartAt).length === 0 && closedSince(bert, restartAt).length === 0 && (await allOpen([anna, bert])),
    '서버 재시작 동안 DataChannel 이 유지된다(link.closed 0건, 링크 open)',
  );
  const cara = await stack.agent('cara');
  const caraJoined = await cara.call('join_room', { room_id: room });
  report.check('L5-04', !caraJoined.isError && caraJoined.json.participants.every((row) => row.link === 'open'), '재등록 뒤 신규 입장이 된다(anna, bert 와 링크)', errorSummary(caraJoined));
  cara.pump();

  // ── 서버 쪽에서 소켓 끊기 ─────────────────────────────────────────────────
  const cutAt = Date.now();
  stack.proxy.disconnect();
  const duringCut = await bert.ok('send_message', { text: 'right after the cut' });
  const recovered = await until(
    async () => (await signalingConnected(anna)) && (await signalingConnected(bert)) && (await signalingConnected(cara)) && stack.registered('cara'),
    '소켓 끊김 뒤 재등록',
    45_000,
    100,
  ).then(
    () => Date.now() - cutAt,
    () => null,
  );
  report.check(
    'L5-05',
    duringCut.delivered.length === 2 && recovered !== null && [anna, bert, cara].every((agent) => closedSince(agent, cutAt).length === 0),
    '서버 쪽에서 소켓을 끊어도 링크가 유지되고 채팅이 가며, 셋 다 재등록한다',
    { delivered: duringCut.delivered, recovered_ms: recovered },
  );

  // ── 끊긴 사이 입장한 참가자와 mesh 메우기 ─────────────────────────────────
  stack.proxy.block('anna');
  await until(() => stack.registered('anna') === false, 'anna 등록 해제', 5_000, 50);
  const jade = await stack.agent('jade');
  const jadeJoined = await jade.call('join_room', { room_id: room });
  const jadeRows = jadeJoined.json?.participants ?? [];
  report.check(
    'L5-06',
    !jadeJoined.isError && jadeRows.find((row) => row.name === 'bert')?.link === 'open' && jadeRows.find((row) => row.name === 'anna')?.link !== 'open',
    'anna 의 시그널링이 끊긴 사이 jade 가 anna 없이 입장한다',
    { result: errorSummary(jadeJoined), anna: jadeRows.find((row) => row.name === 'anna')?.shown_as },
  );
  jade.pump();
  const blockedChat = await anna.ok('send_message', { text: 'anna is off the server' });
  report.check('L5-07', blockedChat.delivered.includes('bert') && blockedChat.delivered.includes('cara'), '끊긴 동안 anna 의 채팅이 열린 링크로 간다', blockedChat.delivered);
  const unblockedAt = Date.now();
  stack.proxy.unblock('anna');
  const filled = await until(async () => (await anna.participant('jade'))?.link === 'open' && (await jade.participant('anna'))?.link === 'open', 'anna–jade 링크', 60_000, 250).then(
    () => Date.now() - unblockedAt,
    () => null,
  );
  report.check('L5-08', filled !== null && (await allOpen([anna, bert, cara, jade])), '재등록 뒤 anna 와 jade 사이가 메워져 넷이 모두 이어진다', { ms_after_unblock: filled });

  // ── 끊긴 사이 같은 이름을 차지한 다른 프로세스 ────────────────────────────
  const takeoverAt = Date.now();
  stack.proxy.block('anna');
  await until(() => stack.registered('anna') === false, 'anna 등록 해제', 5_000, 50);
  // 프록시는 이름으로 막으므로, 같은 이름의 다른 프로세스는 서버에 바로 붙인다.
  const impostor = await stack.agent('anna', { label: 'anna-impostor', env: { AGENT_CHAT_SERVER: stack.server.url } });
  const impostorJoin = impostor.call('join_room', { room_id: room }, { timeoutMs: 60_000 });
  await until(() => stack.registered('anna') === true, '다른 프로세스가 anna 로 등록', 10_000, 50);
  stack.proxy.unblock('anna');
  // 원래 anna 는 재접속을 시도하지만 이름이 차 있다(NAME_IN_USE). 멈추지 않고 계속 시도한다.
  const blocked = await until(async () => {
    const reply = await anna.call('get_status');
    return reply.json?.notice?.signaling?.reason === 'NAME_IN_USE' ? reply.json.notice.signaling : null;
  }, 'anna 의 notice.signaling NAME_IN_USE', 45_000, 250).catch(() => null);
  report.check('L5-09', blocked !== null, '원래 참가자는 재등록이 NAME_IN_USE 로 막힌 것을 notice.signaling 으로 안다', blocked ?? undefined);
  const impostorResult = await impostorJoin;
  report.check(
    'L5-10',
    impostorResult.isError && impostorResult.json?.error?.code === 'DIRECT_CONNECT_FAILED',
    '같은 이름을 차지한 프로세스는 기존 참가자와 링크를 열지 못한다(교체 확인으로 원래 링크를 지킨다)',
    errorSummary(impostorResult),
  );
  const keptLinks = [anna, bert, cara, jade].every((agent) => closedSince(agent, takeoverAt).length === 0);
  const probes = [bert, cara, jade].flatMap((agent) => agent.logs('link.replace_probe').filter((line) => line.peer === 'anna' && Date.parse(line.ts) >= takeoverAt));
  report.check(
    'L5-11',
    keptLinks && probes.length > 0 && probes.every((line) => line.outcome === 'kept'),
    '원래 anna 의 링크가 하나도 닫히지 않았다(교체 확인 결과 kept)',
    { probes: probes.length, outcomes: [...new Set(probes.map((line) => line.outcome))] },
  );
  // 입장에 실패한 쪽은 그 자리에서 서버 등록을 지운다(leave). 그 시각부터 잰다.
  const leftAt = Date.now();
  await impostor.close();
  // 차지한 쪽의 등록(conn.join{joined}) → 지움(conn.closed{removed}) → 원래 anna 의 새 등록(conn.join{joined}) 순서가 서버 로그에 나온다.
  const back = await until(
    () => {
      const events = stack.registrationEvents('anna').filter((entry) => entry.at >= takeoverAt);
      const taken = events.findIndex((entry) => entry.event === 'conn.join' && entry.outcome === 'joined');
      const removed = events.findIndex((entry, index) => index > taken && entry.event === 'conn.closed' && entry.outcome === 'removed');
      return taken >= 0 && removed > taken && events.slice(removed + 1).some((entry) => entry.event === 'conn.join' && entry.outcome === 'joined');
    },
    '원래 anna 의 재등록',
    75_000,
    250,
  ).then(
    () => Date.now() - leftAt,
    () => null,
  );
  report.check('L5-12', back !== null && (await signalingConnected(anna)), '차지한 쪽이 나가면 원래 참가자가 재등록한다', { ms_after_impostor_left: back });
  const finalChat = await anna.ok('send_message', { text: 'back again' });
  report.check('L5-13', finalChat.delivered.length === 3, '그 뒤 채팅이 셋 모두에게 간다', finalChat.delivered);

  for (const agent of [anna, bert, cara, jade]) {
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
