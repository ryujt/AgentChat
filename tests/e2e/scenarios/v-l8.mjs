#!/usr/bin/env node
// V-L8: 조립한 MCP 프로세스 여러 개를 스크립트가 tool 로 조종한다 (verification-plan.md 3.2, 시나리오 S10~S12).
// 흐름: 테스트 시작 → 시나리오 → 주장 → 타인 검증 → 역할 교대 → 퇴장·재입장 → 중단 → 보고서.
// 거절 사례: 자기 검증, 중단 뒤 시나리오 시작, 시간 제한, 시나리오 수 제한, 동시 한도 초과, 기한이나 중단 뒤의 start_test.
// 중단 뒤에 옛 시나리오로 쓴 주장이 성공으로 세지 않는다. 한 쌍이 끊긴 상태에서의 중단(부분 mesh 기준표의 V-L8 행).
//
// 방 넷: (1) 4명 전체 흐름, (2) 1분 제한(시간 제한. 다른 방과 함께 돈다), (3) 부분 mesh 의 중단, (4) 부분 mesh 의 동시 한도 초과.
// 실행: node tests/e2e/scenarios/v-l8.mjs [--ice none] [--only flow|time|partial|over (고친 부분만 다시 볼 때. 판정에는 전체 실행만 쓴다)]
// 부분 mesh 는 프록시가 필요하다. --server 를 주면 (1)(2)만 하고 (3)(4)는 미실행으로 적는다.

import { readFileSync } from 'node:fs';
import { argValue, createReport, delay, enterAll, errorSummary, finish, newRoomId, scenarioOptions, startStack, until } from './harness.mjs';

const options = scenarioOptions();
const report = createReport(`V-L8 (${options.server ?? '자체 호스팅'})`);
const STOP_REACH_MS = 5_000;
/** 고친 부분만 다시 볼 때: --only flow|time|partial|over. 판정에는 전체 실행만 쓴다. */
const ONLY = argValue(options.rest, 'only', null);
let stack = null;

const code = (reply) => (reply.isError ? reply.json?.error?.code ?? 'NOT_JSON' : 'ok');
const claimArgs = (scenarioId, outcome, note) => ({
  scenario_id: scenarioId,
  action: `did ${note}`,
  expected: 'works',
  observed: `saw ${note}`,
  outcome,
  steps: `1. ${note}`,
});

async function fullFlow() {
  const room = newRoomId();
  const agents = [];
  for (const name of ['amy', 'bob', 'cal', 'dee']) agents.push(await stack.agent(name));
  const [amy, bob, cal, dee] = agents;
  await enterAll(agents, room);
  await until(async () => (await amy.status()).participants.filter((row) => row.link === 'open').length === 3, 'mesh', 15_000, 200);

  const request = 'V-L8 test the checkout flow';
  const started = await amy.ok('start_test', { request, max_duration_min: 30, max_scenarios: 3 });
  report.check(
    'L8-01',
    started.sent_to.length === 3 && started.not_connected.length === 0 && started.limits.max_scenarios === 3,
    'start_test: 요청문과 제한이 셋에게 간다',
    { sent_to: started.sent_to, limits: started.limits },
  );
  const seenTest = await Promise.all(
    [bob, cal, dee].map((agent) => agent.event((e) => e.kind === 'test' && e.change === 'started', { what: '테스트 시작 사건' }).catch(() => null)),
  );
  report.check(
    'L8-02',
    seenTest.every((event) => event?.data?.request === request && event.data.by === 'amy'),
    '나머지 셋의 수신함에 테스트 시작 사건(요청문, 요청자)',
  );
  report.check('L8-03', code(await bob.call('start_test', { request: 'another' })) === 'TEST_ALREADY_ACTIVE', '진행 중에 다시 start_test 는 TEST_ALREADY_ACTIVE');

  for (const [agent, role] of [
    [amy, 'host'],
    [bob, 'actor'],
    [cal, 'verifier'],
    [dee, 'observer'],
  ]) {
    await agent.ok('set_status', { status: 'ready', role });
  }
  const s1 = await bob.ok('start_scenario', { title: 'login', actor: 'bob', verifier: 'cal' });
  report.check('L8-04', s1.index === 1 && s1.remaining === 2, 'start_scenario: 첫 시나리오, 남은 수 2', s1);
  const c1 = await bob.ok('record_claim', claimArgs(s1.scenario_id, 'pass', 'login'));
  report.check('L8-05', c1.status === 'unverified' && c1.late === false, 'record_claim: 미확인으로 기록된다', c1);
  report.check(
    'L8-06',
    code(await bob.call('record_verification', { claim_id: c1.claim_id, result: 'confirmed', evidence: 'I saw it myself' })) === 'SELF_VERIFY_FORBIDDEN',
    '자기 주장은 검증할 수 없다(SELF_VERIFY_FORBIDDEN)',
  );
  await cal.event((e) => e.kind === 'claim' && e.data?.claim_id === c1.claim_id, { what: '주장 사건' });
  const v1 = await cal.ok('record_verification', { claim_id: c1.claim_id, result: 'confirmed', evidence: 'checked on my screen' });
  report.check('L8-07', v1.claim_status === 'confirmed', '다른 참가자의 검증으로 confirmed', v1);
  const verified = await bob.event((e) => e.kind === 'verification' && e.data?.claim_id === c1.claim_id, { what: '검증 사건' }).catch(() => null);
  report.check('L8-08', verified?.data?.result === 'confirmed' && verified.data.by === 'cal', '주장 작성자에게 검증 사건이 간다');

  // 역할 교대.
  await bob.ok('set_status', { role: 'verifier' });
  await cal.ok('set_status', { role: 'actor' });
  const swapped = await until(async () => {
    const rows = (await dee.status()).participants;
    return rows.find((row) => row.name === 'bob')?.role === 'verifier' && rows.find((row) => row.name === 'cal')?.role === 'actor';
  }, '역할 교대가 보임', 10_000, 200).catch(() => false);
  report.check('L8-09', swapped === true, '역할 교대: 다른 참가자의 get_status 에 바뀐 역할이 보인다');
  const s2 = await cal.ok('start_scenario', { title: 'checkout', actor: 'cal', verifier: 'bob' });
  const c2 = await cal.ok('record_claim', claimArgs(s2.scenario_id, 'fail', 'checkout'));
  await bob.event((e) => e.kind === 'claim' && e.data?.claim_id === c2.claim_id, { what: '실패 주장 사건' });
  const v2 = await bob.ok('record_verification', { claim_id: c2.claim_id, result: 'confirmed', evidence: 'same error here' });
  report.check('L8-10', v2.claim_status === 'confirmed', '역할을 바꾼 뒤 bob 이 cal 의 실패 주장을 검증한다', v2);

  // 퇴장·재입장.
  await dee.stopPump();
  const left = await dee.ok('leave_room');
  const back = await dee.ok('join_room', { room_id: room });
  dee.pump();
  const roles = Object.fromEntries(back.participants.map((row) => [row.name, row.role]));
  report.check(
    'L8-11',
    left.left === true && back.test?.request === request && back.test.scenarios.used === 2 && roles.bob === 'verifier' && roles.cal === 'actor',
    '퇴장 뒤 재입장: 목표, 시나리오 사용 수, 바뀐 역할을 받는다',
    { scenarios: back.test?.scenarios, roles },
  );

  // 시나리오 수 제한.
  const s3 = await amy.ok('start_scenario', { title: 'refund' });
  await until(async () => (await dee.status()).test?.scenarios.used === 3, 'dee 가 3번째 시나리오를 봄', 10_000, 100);
  report.check(
    'L8-12',
    s3.remaining === 0 && code(await dee.call('start_scenario', { title: 'one too many' })) === 'SCENARIO_LIMIT_REACHED',
    '시나리오 수 제한: 한도에서 start_scenario 는 SCENARIO_LIMIT_REACHED',
  );
  const c3 = await amy.ok('record_claim', claimArgs(s3.scenario_id, 'pass', 'refund'));

  // 중단.
  const stopped = await amy.ok('stop_test', { reason: 'user asked to stop' });
  report.check('L8-13', stopped.stopped === true && stopped.sent_to.length === 3 && stopped.not_connected.length === 0, 'stop_test: 셋 모두에게 보냈다', stopped);
  const stopEvents = await Promise.all(
    [bob, cal, dee].map((agent) => agent.event((e) => e.kind === 'test' && e.change === 'stopped', { what: '중단 사건' }).catch(() => null)),
  );
  report.check('L8-14', stopEvents.every((event) => event?.data?.reason === 'user' && event.data.by === 'amy'), '나머지 셋에 중단 사건(사유 user, by amy)');
  const afterStop = await Promise.all([amy, bob, cal, dee].map((agent) => agent.call('start_scenario', { title: 'after stop' })));
  report.check(
    'L8-15',
    afterStop.every((reply) => code(reply) === 'TEST_STOPPED' && reply.json?.notice?.test_stopped?.reason === 'user'),
    '중단 뒤 전원의 start_scenario 는 TEST_STOPPED, 결과에 notice.test_stopped',
    afterStop.map(code),
  );
  report.check('L8-16', code(await cal.call('start_test', { request: 'restart please' })) === 'TEST_ENDED', '중단 뒤의 start_test 는 TEST_ENDED');
  // 중단 뒤 옛 시나리오로 쓴 주장: 받되 중단 뒤 기록. 검증을 받아도 성공에 세지 않는다.
  const late = await bob.ok('record_claim', claimArgs(s1.scenario_id, 'pass', 'late'));
  await cal.event((e) => e.kind === 'claim' && e.data?.claim_id === late.claim_id, { what: '늦은 주장 사건' });
  const lateVerified = await cal.ok('record_verification', { claim_id: late.claim_id, result: 'confirmed', evidence: 'after stop' });
  report.check('L8-17', late.late === true && lateVerified.claim_status === 'confirmed', '중단 뒤 옛 시나리오의 주장은 late=true 로 받는다(검증도 받는다)', { late, lateVerified });
  await delay(500);

  // 보고서.
  const written = await amy.ok('write_report');
  const summary = written.summary;
  report.check(
    'L8-18',
    summary.scenarios === 3 && summary.passed === 1 && summary.failed === 1 && summary.unverified === 1 && summary.late === 1,
    '보고서: 성공 1(확인된 pass), 실패 1(확인된 fail), 미확인 1, 중단 뒤 기록 1(검증을 받았어도 성공에 세지 않음)',
    summary,
  );
  const text = readFileSync(written.path, 'utf8');
  report.check('L8-19', !text.includes(room) && text.includes(c3.claim_id), '보고서에 방 ID 원문이 없고 미확인 주장이 실린다');
  const bobReport = readFileSync((await bob.ok('write_report')).path, 'utf8');
  report.check(
    'L8-20',
    ['TEST_ALREADY_ACTIVE', 'SELF_VERIFY_FORBIDDEN', 'TEST_STOPPED'].every((rejected) => bobReport.includes(rejected)),
    'bob 의 보고서 "거절된 호출"에 자기 검증·진행 중 재시작·중단 뒤 시작이 남는다',
  );
  for (const agent of agents) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

/** 1분 제한의 테스트. 다른 방과 함께 돌도록 Promise 를 돌려준다. */
async function timeLimit() {
  const room = newRoomId();
  const eve = await stack.agent('eve');
  const fox = await stack.agent('fox');
  await eve.ok('create_room', { room_id: room });
  eve.pump();
  await fox.ok('join_room', { room_id: room });
  fox.pump();
  const started = await eve.ok('start_test', { request: 'one minute only', max_duration_min: 1 });
  const startedAt = Date.now();
  const scenario = await fox.ok('start_scenario', { title: 'within the limit' });
  return (async () => {
    const stopEvent = await fox.event((e) => e.kind === 'test' && e.change === 'stopped', { what: '기한 중단 사건', timeoutMs: 75_000 }).catch(() => null);
    const stoppedAfter = stopEvent === null ? null : stopEvent.seenAt - startedAt;
    const rejected = await fox.call('start_scenario', { title: 'too late' });
    const status = await fox.ok('get_status');
    report.check(
      'L8-21',
      stopEvent?.data?.reason === 'time_limit' && stoppedAfter >= 60_000 && stoppedAfter <= 65_000 && status.test?.stopped?.reason === 'time_limit' && status.test.remaining_min === 0,
      '시간 제한: 60초 뒤 5초 안에 stop{time_limit} 이 쓰이고 퍼진다(60초 전에는 쓰이지 않는다)',
      { stopped_after_ms: stoppedAfter, by: stopEvent?.data?.by, test_id_same: status.test?.test_id === started.test_id },
    );
    report.check(
      'L8-22',
      ['TEST_STOPPED', 'TIME_LIMIT_REACHED'].includes(code(rejected)) && rejected.json?.notice?.test_stopped?.reason === 'time_limit',
      '시간 제한 뒤의 start_scenario 는 거절된다(notice.test_stopped.reason = time_limit)',
      { code: code(rejected) },
    );
    report.check('L8-23', code(await eve.call('start_test', { request: 'again' })) === 'TEST_ENDED', '기한 뒤의 start_test 는 TEST_ENDED');
    const claim = await fox.call('record_claim', claimArgs(scenario.scenario_id, 'pass', 'after deadline'));
    report.check('L8-24', !claim.isError && claim.json.late === true, '기한 뒤 옛 시나리오의 주장은 late 로 받는다');
    for (const agent of [eve, fox]) {
      await agent.stopPump();
      await agent.call('leave_room');
      await agent.close();
    }
  })();
}

/**
 * 부분 mesh 를 만든다: a 와 c 가 방에 있고, a 의 시그널링을 끊은 사이 b 가 들어오고, a–b 시그널을 계속 버린다.
 * 돌려준 drop 규칙의 hits 가 주입의 증거다.
 */
async function partialMesh(names, room) {
  const [a, b, c] = await Promise.all(names.map((name) => stack.agent(name)));
  await a.ok('create_room', { room_id: room });
  a.pump();
  await c.ok('join_room', { room_id: room });
  c.pump();
  stack.proxy.block(a.name);
  await until(() => stack.registered(a.name) === false, `${a.name} 등록 해제`, 5_000, 50);
  await b.ok('join_room', { room_id: room });
  b.pump();
  const drop = stack.proxy.addRule({ pair: [a.name, b.name], action: 'signal', op: 'drop' });
  stack.proxy.unblock(a.name);
  await until(() => stack.registered(a.name) === true, `${a.name} 재등록`, 45_000, 200);
  await until(() => drop.hits > 0, `${a.name}–${b.name} 시그널을 버림`, 20_000, 200);
  return { a, b, c, drop };
}

async function noLink(a, b) {
  return (await a.participant(b.name))?.link !== 'open' && (await b.participant(a.name))?.link !== 'open';
}

async function partialStop() {
  const room = newRoomId();
  const { a, b, c, drop } = await partialMesh(['ann', 'bea', 'cid'], room);
  const linkBefore = await noLink(a, b);
  await b.ok('start_test', { request: 'partial mesh stop', max_duration_min: 60, max_scenarios: 20 });
  await until(async () => (await a.status()).test !== null, 'ann 이 테스트를 받음(cid 를 거쳐)', 45_000, 500);
  // b 가 5초마다 시나리오와 주장을 쓰는 상태를 60초 유지한다.
  const writeStartedAt = Date.now();
  let written = 0;
  while (Date.now() - writeStartedAt < 60_000) {
    const scenario = await b.ok('start_scenario', { title: `scenario ${written + 1}` });
    await b.ok('record_claim', claimArgs(scenario.scenario_id, 'pass', `step ${written + 1}`));
    written += 1;
    await delay(Math.max(0, writeStartedAt + written * 5_000 - Date.now()));
  }
  const stopAt = Date.now();
  const stopped = await b.ok('stop_test', { reason: 'user stop in partial mesh' });
  const reached = await until(
    async () => {
      for (const agent of [a, b, c]) if ((await agent.status()).test?.stopped === null) return false;
      return true;
    },
    '전원의 test.stopped',
    STOP_REACH_MS + 2_000,
    50,
  ).then(
    () => Date.now() - stopAt,
    () => null,
  );
  report.check(
    'L8-25',
    stopped.not_connected.includes(a.name) && stopped.sent_to.includes(c.name),
    '한 쌍이 끊긴 상태의 stop_test: not_connected 에 ann, sent_to 에 cid',
    { sent_to: stopped.sent_to, not_connected: stopped.not_connected, scenarios_written: written },
  );
  report.check('L8-26', reached !== null && reached <= STOP_REACH_MS, `${STOP_REACH_MS / 1000}초 안에 전원의 get_status.test.stopped 가 채워진다`, { ms: reached });
  const after = await Promise.all([a, b, c].map((agent) => agent.call('start_scenario', { title: 'after partial stop' })));
  report.check('L8-27', after.every((reply) => code(reply) === 'TEST_STOPPED'), '그 뒤 전원의 start_scenario 는 TEST_STOPPED', after.map(code));
  const warnings = (await a.status()).warnings;
  report.check('L8-28', !warnings.some((warning) => warning.code === 'state_diverged'), 'ann 의 get_status 경고에 복제본 차이가 없다', warnings);
  const linkAfter = await noLink(a, b);
  report.check('L8-29', linkBefore && linkAfter && drop.hits > 0, '주입의 증거: 시험 내내 ann–bea 링크가 양쪽에서 open 이 아니다', { dropped: drop.hits });
  const stopResync = c.logs('state.resync').filter((line) => line.cause === 'stop' && line.peer === a.name && Date.parse(line.ts) >= stopAt - 5);
  report.note(`cid 의 state.resync{cause: stop, peer: ann}: ${stopResync.length}건`);
  drop.remove();
  for (const agent of [a, b, c]) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

async function concurrentOverLimit() {
  const room = newRoomId();
  const { a, b, c, drop } = await partialMesh(['ari', 'bo', 'cy'], room);
  await c.ok('start_test', { request: 'one scenario only', max_duration_min: 60, max_scenarios: 1 });
  await until(async () => (await a.status()).test !== null && (await b.status()).test !== null, '둘 다 테스트를 받음', 15_000, 200);
  // ari 와 bo 는 서로 링크가 없다. 둘이 거의 동시에 시작하면 각자 남은 수 1 로 보고 받아들인다.
  const [sa, sb] = await Promise.all([a.call('start_scenario', { title: 'from ari' }), b.call('start_scenario', { title: 'from bo' })]);
  const bothAccepted = !sa.isError && !sb.isError;
  // 병합 뒤 순위가 뒤인 시나리오는 한도 초과다. 둘과 이어진 cy 가 먼저 안다(over_limit 사건의 by 가 그 작성자다).
  // 작성자는 상대의 기록을 cy 와의 재동기화로 받은 뒤에 안다. 그때 그에게도 사건이 가고, 그 시나리오의 주장은 SCENARIO_OVER_LIMIT 이다.
  let seenByC = null;
  let seenByLoser = null;
  let loser = null;
  if (bothAccepted) {
    seenByC = await c.event((e) => e.kind === 'scenario' && e.change === 'over_limit', { what: 'cy 의 한도 초과 사건', timeoutMs: 20_000 }).catch(() => null);
    loser = seenByC === null ? null : seenByC.data.by === a.name ? a : seenByC.data.by === b.name ? b : null;
    if (loser !== null) {
      seenByLoser = await loser
        .event((e) => e.kind === 'scenario' && e.change === 'over_limit' && e.data?.scenario_id === seenByC.data.scenario_id, {
          what: '작성자의 한도 초과 사건',
          timeoutMs: 50_000,
        })
        .catch(() => null);
    }
  }
  const loserScenario = loser === a ? sa.json?.scenario_id : sb.json?.scenario_id;
  const winner = loser === a ? b : a;
  const winnerScenario = loser === a ? sb.json?.scenario_id : sa.json?.scenario_id;
  const loserClaim = loser === null ? null : await loser.call('record_claim', claimArgs(loserScenario, 'pass', 'over'));
  const winnerClaim = loser === null ? null : await winner.call('record_claim', claimArgs(winnerScenario, 'pass', 'kept'));
  const overEvent = seenByLoser === null ? null : { event: seenByLoser };
  report.check(
    'L8-30',
    bothAccepted && overEvent?.event?.data?.scenario_id === loserScenario && code(loserClaim ?? { isError: true, json: null }) === 'SCENARIO_OVER_LIMIT' && code(winnerClaim ?? { isError: true, json: null }) === 'ok',
    '동시 한도 초과: 링크가 없는 두 참가자가 마지막 한 자리에 동시에 시작하면, 병합 뒤 뒤 순위가 한도 초과 사건을 받고 그 주장은 SCENARIO_OVER_LIMIT',
    { accepted: [code(sa), code(sb)], loser: loser?.name ?? null, loser_claim: loserClaim === null ? null : code(loserClaim), winner_claim: winnerClaim === null ? null : code(winnerClaim), dropped: drop.hits },
  );
  report.check('L8-31', code(await c.call('start_scenario', { title: 'third' })) === 'SCENARIO_LIMIT_REACHED', '그 뒤의 start_scenario 는 SCENARIO_LIMIT_REACHED');
  drop.remove();
  for (const agent of [a, b, c]) {
    await agent.stopPump();
    await agent.call('leave_room');
    await agent.close();
  }
}

async function run() {
  stack = await startStack({ label: 'v-l8', proxy: true, ...options });
  const want = (part) => ONLY === null || ONLY === part;
  const timed = want('time') ? await timeLimit() : null;
  if (want('flow')) await fullFlow();
  if (stack.selfHosted) {
    if (want('partial')) await partialStop();
    if (want('over')) await concurrentOverLimit();
  } else {
    report.skip('L8-25..31', '부분 mesh 의 중단과 동시 한도 초과', '프록시는 자체 호스팅에서만 쓸 수 있다');
  }
  if (timed !== null) await timed;
  if (ONLY !== null) report.partial('L8-ONLY', `--only ${ONLY}: 일부만 돌렸다. V-L8 의 판정으로 쓰지 않는다`);
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
