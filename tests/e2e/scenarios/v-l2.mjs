#!/usr/bin/env node
// V-L2: 서버 + 조립한 MCP 프로세스 2개, 4개 (verification-plan.md 3.2, 시나리오 S1·S2·S4).
// 생성, 입장, 상태 공유, 방 전체·대상 지정 채팅, ack, 자기 메시지 미수신. 채팅을 보낸 구간에서 서버의 relay 사건 수가 늘지 않는다.
//
// 실행:
//   node tests/e2e/scenarios/v-l2.mjs                                  자체 호스팅(빈 포트로 띄운다). 로컬 실물
//   node tests/e2e/scenarios/v-l2.mjs --server wss://agent-chat.tools.camp   공용 서버(V-P2). server 인자 없이 제품 기본값으로 간다
//   [--ice none]  host 후보만 쓴다(기본은 제품 기본값: 공개 STUN)
// 공용 서버에서는 서버 로그가 없어 relay 확인을 미실행으로 적는다(V-P2 는 그것을 CloudWatch 지표로 본다).

import { createReport, enterAll, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';

const options = scenarioOptions();
const report = createReport(`V-L2 (${options.server ?? '자체 호스팅'})`);
const CHAT_ROUNDS = 10;
let stack = null;

/** 모든 참가자의 get_status 에서 나머지가 모두 link open 이다. */
async function meshComplete(agents) {
  for (const agent of agents) {
    const status = await agent.status();
    for (const other of agents) {
      if (other === agent) continue;
      const row = status.participants.find((entry) => entry.name === other.name);
      if (row?.link !== 'open') return false;
    }
  }
  return true;
}

/** 각자 chat 사건 수(보낸 사람별). */
function chatsFrom(agent, from, since = 0) {
  return agent.events.slice(since).filter((event) => event.kind === 'chat' && event.from === from);
}

async function run() {
  stack = await startStack({ label: 'v-l2', ...options });
  const selfHosted = stack.selfHosted;

  // ── 2개 ─────────────────────────────────────────────────────────────────
  {
    const room = newRoomId();
    const anna = await stack.agent('anna');
    const bert = await stack.agent('bert');

    const created = await anna.ok('create_room', { room_id: room });
    report.check(
      'L2-2-01',
      created.name === 'anna' && created.participants.length === 1 && created.participants[0].name === 'anna' && created.delivery_mode === 'poll' && typeof created.server === 'string',
      'create_room: 자기 한 명, poll, 정규화한 서버 키',
      { server: created.server, delivery_mode: created.delivery_mode },
    );
    anna.pump();
    const joinedAt = Date.now();
    const joined = await bert.ok('join_room', { room_id: room });
    const annaRow = joined.participants.find((entry) => entry.name === 'anna');
    report.check('L2-2-02', annaRow?.link === 'open' && joined.test === null, 'join_room: anna 와 링크가 열려 있다', {
      ms: Date.now() - joinedAt,
      link: annaRow?.link,
      shown_as: annaRow?.shown_as,
    });
    bert.pump();

    // 상태 공유: anna 가 쓴 presence 가 bert 의 get_status 에 보인다. anna 는 대기 중이라 listening 이다.
    await anna.ok('set_status', { status: 'ready', role: 'tester', tools: ['browser'] });
    const seen = await until(async () => {
      const row = await bert.participant('anna');
      return row?.status === 'ready' && row.role === 'tester' && row.tools?.[0] === 'browser' && row.shown_as === 'ready' ? row : null;
    }, 'bert 가 anna 의 ready·역할을 본다', 15_000, 200).catch(() => null);
    report.check('L2-2-03', seen !== null, '상태 공유: bert 의 get_status 에 anna 의 status·role·tools, shown_as ready', seen ?? undefined);
    await bert.event((event) => event.kind === 'peer' && event.from === 'anna' && event.change === 'ready', { what: 'anna ready 사건' }).then(
      () => report.pass('L2-2-04', 'bert 의 수신함에 peer.ready 사건'),
      (error) => report.fail('L2-2-04', 'bert 의 수신함에 peer.ready 사건', error.message),
    );

    // 채팅 구간: 서버의 relay 수가 늘지 않는다.
    const relayBefore = stack.relayCount();
    const sent = [];
    for (let i = 0; i < CHAT_ROUNDS; i += 1) {
      sent.push(await anna.ok('send_message', { text: `a→room ${i}` }));
      sent.push(await bert.ok('send_message', { text: `b→room ${i}` }));
    }
    const allDelivered = sent.every((result) => result.delivered.length === 1 && result.undelivered.length === 0);
    report.check('L2-2-05', allDelivered, `send_message ${sent.length}건이 모두 delivered(ack)`, {
      undelivered: sent.filter((result) => result.undelivered.length > 0).length,
    });
    await until(() => chatsFrom(bert, 'anna').length >= CHAT_ROUNDS && chatsFrom(anna, 'bert').length >= CHAT_ROUNDS, '양쪽이 채팅을 모두 받음', 20_000, 100);
    const ids = new Set(sent.map((result) => result.message_id));
    const received = [...chatsFrom(bert, 'anna'), ...chatsFrom(anna, 'bert')];
    report.check(
      'L2-2-06',
      received.length === CHAT_ROUNDS * 2 && received.every((event) => ids.has(event.id) && event.to === 'room'),
      '받은 채팅 = 보낸 채팅(중복 없음, to=room)',
      { received: received.length },
    );
    report.check('L2-2-07', chatsFrom(anna, 'anna').length === 0 && chatsFrom(bert, 'bert').length === 0, '자기 메시지는 자기 수신함에 오지 않는다');
    if (selfHosted) {
      const relayAfter = stack.relayCount();
      report.check('L2-2-08', relayAfter === relayBefore, '채팅 구간에 서버 relay 사건 수가 늘지 않았다', { before: relayBefore, after: relayAfter });
    } else {
      report.skip('L2-2-08', '서버 relay 사건 수', '공용 서버라 서버 로그가 없다(V-P2 가 CloudWatch 로 본다)');
    }

    for (const agent of [bert, anna]) {
      await agent.stopPump();
      const left = await agent.ok('leave_room');
      report.check(`L2-2-09-${agent.name}`, left.left === true && typeof left.transcript_path === 'string', `${agent.name} leave_room`);
    }
    for (const agent of [anna, bert]) {
      const closed = await agent.close();
      report.check(`L2-2-10-${agent.name}`, closed.exit.code === 0, `${agent.name} 종료 코드 0`, { ms: closed.ms, code: closed.exit.code });
    }
  }

  // ── 4개 ─────────────────────────────────────────────────────────────────
  {
    const room = newRoomId();
    const names = ['anna4', 'bert4', 'cara4', 'dave4'];
    const agents = [];
    for (const name of names) agents.push(await stack.agent(name));
    const startedAt = Date.now();
    const entered = await enterAll(agents, room);
    report.check(
      'L2-4-01',
      entered.every((result, index) => result.participants.filter((entry) => entry.name !== result.name && entry.link === 'open').length === index),
      '네 참가자 입장: 각 입장 결과에 먼저 들어온 참가자가 모두 link open',
      { ms: Date.now() - startedAt },
    );
    const complete = await until(() => meshComplete(agents), '전원 mesh', 20_000, 250).catch(() => false);
    report.check('L2-4-02', complete === true, '전원이 서로 link open(6쌍)');

    for (const [index, agent] of agents.entries()) await agent.ok('set_status', { status: 'ready', role: `role-${index}` });
    const shared = await until(async () => {
      for (const agent of agents) {
        const status = await agent.status();
        for (const [index, other] of agents.entries()) {
          if (other === agent) continue;
          const row = status.participants.find((entry) => entry.name === other.name);
          if (row?.role !== `role-${index}` || row.status !== 'ready') return false;
        }
      }
      return true;
    }, '전원이 서로의 역할을 봄', 15_000, 250).catch(() => false);
    report.check('L2-4-03', shared === true, '상태 공유: 전원이 서로의 status·role 을 본다');

    const relayBefore = stack.relayCount();
    const marks = agents.map((agent) => agent.events.length);
    const roomSends = [];
    for (let round = 0; round < 3; round += 1) {
      for (const agent of agents) roomSends.push({ from: agent.name, result: await agent.ok('send_message', { text: `${agent.name} room ${round}` }) });
    }
    report.check(
      'L2-4-04',
      roomSends.every(({ from, result }) => result.delivered.length === 3 && !result.delivered.includes(from) && result.undelivered.length === 0),
      `방 전체 채팅 ${roomSends.length}건: 각각 나머지 3명에게 delivered`,
    );
    // 대상 지정: anna → cara 만.
    const targeted = await agents[0].ok('send_message', { text: 'only for cara', to: ['cara4'] });
    report.check('L2-4-05', targeted.delivered.length === 1 && targeted.delivered[0] === 'cara4', '대상 지정 채팅: delivered 는 cara 하나', targeted.delivered);
    await until(
      () => agents.every((agent, index) => agents.every((other) => other === agent || chatsFrom(agent, other.name, marks[index]).filter((event) => event.to === 'room').length === 3)),
      '전원이 방 전체 채팅을 받음',
      20_000,
      100,
    ).then(
      () => report.pass('L2-4-06', '방 전체 채팅: 전원이 나머지 셋의 글을 3건씩 받았다(to=room)'),
      (error) => report.fail('L2-4-06', '방 전체 채팅 수신', error.message),
    );
    const cara = agents[2];
    await cara.event((event) => event.kind === 'chat' && event.id === targeted.message_id, { what: '대상 지정 채팅' }).then(
      (event) => report.check('L2-4-07', event.to === 'you' && event.from === 'anna4', 'cara 가 대상 지정 채팅을 to=you 로 받았다'),
      (error) => report.fail('L2-4-07', 'cara 가 대상 지정 채팅을 받았다', error.message),
    );
    // 다른 둘에게는 오지 않는다. ack 를 받은 뒤 1초를 더 본다.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const leaked = [agents[1], agents[3]].filter((agent) => agent.events.some((event) => event.id === targeted.message_id && event.kind === 'chat'));
    report.check('L2-4-08', leaked.length === 0, '대상이 아닌 bert·dave 는 그 글을 받지 않았다');
    report.check(
      'L2-4-09',
      agents.every((agent) => chatsFrom(agent, agent.name).length === 0),
      '자기 메시지는 자기 수신함에 오지 않는다(4명)',
    );
    if (stack.selfHosted) {
      const relayAfter = stack.relayCount();
      report.check('L2-4-10', relayAfter === relayBefore, '채팅 구간에 서버 relay 사건 수가 늘지 않았다', { before: relayBefore, after: relayAfter });
    } else {
      report.skip('L2-4-10', '서버 relay 사건 수', '공용 서버라 서버 로그가 없다');
    }

    for (const agent of agents) {
      await agent.stopPump();
      await agent.ok('leave_room');
    }
    const codes = [];
    for (const agent of agents) codes.push((await agent.close()).exit.code);
    report.check('L2-4-11', codes.every((code) => code === 0), '네 프로세스 leave_room 뒤 종료 코드 0', codes);
  }
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
