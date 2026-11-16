#!/usr/bin/env node
// V-L12: 방 조율 하네스 (verification-plan.md 3.2 의 V-L12 행과 "부분 mesh 의 재동기화와 중단 기준").
// MCP 없이, 제품의 하위 모듈 실물(signaling-client, mesh, shared-state, inbox, records)로 room-session 을 세운
// 참가자 프로세스들을 자체 호스팅 서버와 시험용 프록시에 붙여 본다. 증거 수준은 로컬 실물이다(같은 PC).
//
// ── 실행 ────────────────────────────────────────────────────────────────────
//
//   1) 빌드한다.            npm run build            (묶음별 폴더면: npx tsc -p tsconfig.json --outDir .work/<묶음>/dist)
//   2) 돌린다.              node tests/e2e/room/v-l12.mjs
//                           AGENT_CHAT_DIST=.work/<묶음>/dist node tests/e2e/room/v-l12.mjs      (묶음별 폴더를 쓸 때)
//      실행기가 생기면      npm run test:e2e -- room
//
//   옵션
//     --only <이름[,이름]>   sync | early-offer | partial 가운데 고른 것만 돌린다. 기본은 셋 다.
//     --hold-seconds <초>    partial 에서 "5초마다 기록을 쓰는 상태"를 유지하는 시간. 기본 180(기준값).
//                            180보다 짧게 돌린 실행은 V-L12 의 통과로 보고하지 않는다(하네스 점검용이다).
//     --keep-home            끝난 뒤 임시 AGENT_CHAT_HOME(기록 파일)을 지우지 않고 경로를 출력한다.
//
//   걸리는 시간: sync 약 10초, early-offer 약 10초, partial 약 5분(부분 mesh 만들기 약 1분 + 3분 유지 + 마무리 1분).
//   필요한 것: 이 PC 의 빈 포트 둘(0 으로 고른다), node-datachannel 네이티브 모듈. 외부 망과 STUN 은 쓰지 않는다(host 후보만).
//   종료 코드: 0 = 고른 시나리오가 모두 통과, 1 = 하나라도 실패, 2 = 인자 오류.
//   끝날 때 띄운 프로세스가 남지 않았는지 확인한다. 남아 있으면 지우고 실패로 끝난다.
//   출력에는 방 ID, 채팅 본문, SDP, candidate 를 싣지 않는다.
//
// ── 시나리오와 통과 조건 ────────────────────────────────────────────────────
//
//   sync         입장과 동기화(S2). 둘이 서로를 link=open 으로 보고, 지문이 같고, presence 가 전해지고, 채팅이 ack 까지 간다.
//                퇴장하면 남은 쪽이 left 로 본다.
//   early-offer  프록시로 입장자의 joined 를 붙들어 offer 가 먼저 오게 한다. 그래도 입장한다.
//                주입의 증거: 붙든 규칙의 hits ≥ 1, 입장자가 받은 offer 의 시각 < joined 의 시각.
//                그 offer 로 열렸다는 증거: 받은 offer 1건, 입장자 쪽 link.attempt_end{ok} 가 재전송 주기(3초) 안.
//   partial      부분 mesh(anna–bert 링크 없음, 둘 다 cara 와 이어짐). bert 가 60분 제한의 테스트와 시나리오를 시작하고
//                5초마다 기록을 쓴다(주장과 set_status 를 섞는다). 3분 유지한 뒤 bert 가 stop 을 쓴다.
//                (1) anna 와 cara 의 경과 시간이 실제로 흐른 시간보다 1초 넘게 크지 않고 5초 넘게 작지 않다.
//                (2) bert 가 쓴 주장이 하나도 빠짐없이 각각 45초 안에 anna 의 복제본에 들어온다.
//                (3) bert 의 마지막 presence 가 45초 안에 anna 의 복제본에 들어온다.
//                (4) 3분 동안 anna–cara 링크의 state.resync 가 4회 이상이다.
//                (5) state_diverged 사건과 경고가 0건이다.
//                (6) stop 이 5초 안에 anna 의 복제본에 들어온다.
//                (7) cara 의 로그에 state.resync{cause: stop, peer: anna} 가 있고, 그 뒤 anna 의 로그에 cara 의 스냅샷 병합이 있다.
//                (8) bert 의 채팅은 anna 에게 가지 않는다(not_connected). cara 에게는 간다.
//                (9) 끝났을 때 세 참가자의 지문이 같다.
//                주입의 증거: anna–bert 사이 시그널을 버린 규칙의 hits > 0, 시험 내내 양쪽 get_status 에서 서로의 link 가 open 이 아니다,
//                양쪽 mesh 로그에 서로의 link.attempt_end{ok} 가 0건이고 실패한 시도가 있다.
//                이 증거가 없으면 통과가 아니다. (5)는 bert 까지 세 참가자를 본다.

import { delay, newRoomId, startStack, until } from './harness.mjs';

const SCENARIOS = ['sync', 'early-offer', 'partial'];

function parseArgs(argv) {
  const options = { only: SCENARIOS, holdSeconds: 180, keepHome: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      options.only = String(argv[(i += 1)] ?? '').split(',').filter(Boolean);
      if (options.only.length === 0 || options.only.some((name) => !SCENARIOS.includes(name))) return null;
    } else if (arg === '--hold-seconds') {
      options.holdSeconds = Number(argv[(i += 1)]);
      if (!Number.isFinite(options.holdSeconds) || options.holdSeconds < 30) return null;
    } else if (arg === '--keep-home') {
      options.keepHome = true;
    } else {
      return null;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options === null) {
  process.stderr.write('사용법: node tests/e2e/room/v-l12.mjs [--only sync,early-offer,partial] [--hold-seconds <30 이상>] [--keep-home]\n');
  process.exit(2);
}

/** 확인 한 건. 실패해도 다음 확인을 계속한다. */
const checks = [];
function check(scenario, what, expected, actual, passed) {
  checks.push({ scenario, what, expected, actual, passed: Boolean(passed) });
  process.stdout.write(`${passed ? '통과' : '실패'}  [${scenario}] ${what} — 기대: ${expected} / 실제: ${actual}\n`);
}
const note = (text) => process.stdout.write(`      ${text}\n`);

const linkOf = (status, name) => status.participants?.find((peer) => peer.name === name)?.link ?? 'absent';
const shownOf = (status, name) => status.participants?.find((peer) => peer.name === name)?.shown_as ?? 'absent';

// ── sync ────────────────────────────────────────────────────────────────────

async function scenarioSync(stack) {
  const S = 'sync';
  const room = newRoomId();
  const alice = await stack.peer('alice');
  const bob = await stack.peer('bob');
  const created = await alice.call('create', { room });
  check(S, '방 생성', 'ok', created.ok ? 'ok' : created.code, created.ok);
  const joined = await bob.call('join', { room });
  check(S, '입장', 'ok', joined.ok ? 'ok' : `${joined.code} ${JSON.stringify(joined.details ?? {})}`, joined.ok);
  if (!created.ok || !joined.ok) return;
  check(S, '입장 결과의 참가자', 'alice 가 link=open', linkOf(joined, 'alice'), linkOf(joined, 'alice') === 'open');

  const aliceStatus = await until(async () => {
    const status = await alice.call('status');
    return status.ok && linkOf(status, 'bob') === 'open' && status.participants.find((peer) => peer.name === 'bob')?.status === 'joined' ? status : null;
  }, 'alice 가 bob 의 presence 를 받는다', 10_000);
  check(S, 'alice 가 본 bob', 'link=open, status=joined', `${linkOf(aliceStatus, 'bob')}, ${aliceStatus.participants[0]?.status}`, true);
  await alice.event((e) => e.t === 'inbox' && e.kind === 'peer' && e.change === 'joined' && e.from === 'bob', { what: 'bob 입장 사건' });
  check(S, 'alice 의 수신함', 'peer.joined(bob) 사건', '있음', true);

  const set = await alice.call('command', { command: { type: 'set_status', status: 'ready', role: '강사', tools: ['browser'] } });
  check(S, 'set_status', 'ok', set.ok ? 'ok' : set.code, set.ok);
  const seen = await until(async () => {
    const status = await bob.call('status');
    const peer = status.ok ? status.participants.find((candidate) => candidate.name === 'alice') : undefined;
    return peer?.role === '강사' && peer.status === 'ready' ? peer : null;
  }, 'bob 이 alice 의 역할을 본다', 10_000);
  check(S, 'bob 이 본 alice 의 presence', 'role=강사, status=ready', `role=${seen.role}, status=${seen.status}`, true);

  const sent = await bob.call('send', { text: '하네스가 보낸 글' });
  check(S, '채팅 전달', 'delivered=[alice]', JSON.stringify(sent.delivered ?? sent.code), sent.ok && sent.delivered.join() === 'alice' && sent.undelivered.length === 0);
  const got = await alice.event((e) => e.t === 'inbox' && e.kind === 'chat' && e.from === 'bob', { what: 'bob 의 글' });
  check(S, 'alice 의 수신함', 'chat(bob) 사건, id 가 message_id 와 같다', got.id, got.id === sent.message_id);
  const own = bob.count((e) => e.t === 'inbox' && e.kind === 'chat');
  check(S, '자기 글', 'bob 의 수신함에 없다', String(own), own === 0);

  const [a, b] = await Promise.all([alice.call('replica'), bob.call('replica')]);
  check(S, '복제본 지문', '같다', `${a.fingerprint} / ${b.fingerprint}`, a.fingerprint === b.fingerprint && a.count === b.count);

  await bob.leave();
  const after = await until(async () => {
    const status = await alice.call('status');
    return status.ok && shownOf(status, 'bob') === 'left' ? status : null;
  }, 'alice 가 bob 을 left 로 본다', 10_000);
  check(S, '퇴장 뒤 alice 가 본 bob', 'shown_as=left, link=none', `${shownOf(after, 'bob')}, ${linkOf(after, 'bob')}`, linkOf(after, 'bob') === 'none');
  await alice.leave();
}

// ── early-offer ─────────────────────────────────────────────────────────────

async function scenarioEarlyOffer(stack) {
  const S = 'early-offer';
  const room = newRoomId();
  // 이름이 작은 쪽이 offer 를 만든다. 먼저 있던 alpha 가 offer 쪽이 되게 이름을 고른다.
  const alpha = await stack.peer('alpha');
  const zulu = await stack.peer('zulu');
  const created = await alpha.call('create', { room });
  check(S, '방 생성', 'ok', created.ok ? 'ok' : created.code, created.ok);
  if (!created.ok) return;

  const held = stack.proxy.addRule({ dir: 's2c', type: 'joined', to: 'zulu', op: 'hold' });
  const joining = zulu.send('join', { room });
  try {
    await until(() => held.hits >= 1, '프록시가 zulu 의 joined 를 붙든다', 5_000, 10);
    // alpha 의 소켓을 끊는다. 재등록의 joined 목록에 zulu 가 있으므로 alpha 가 zulu 에게 offer 를 보낸다.
    stack.proxy.disconnect({ peer: 'alpha' });
    const offer = await zulu.event((e) => e.t === 'signal' && e.kind === 'offer' && e.from === 'alpha', { what: 'alpha 의 offer', timeoutMs: 8_000 });
    const joinedBefore = zulu.count((e) => e.t === 'joined');
    check(S, '주입: offer 가 joined 보다 먼저 왔다', 'joined 를 아직 못 받았다', `joined ${joinedBefore}건, 붙든 규칙 hits ${held.hits}`, joinedBefore === 0 && held.hits >= 1);
    held.release();
    const { result } = await zulu.result(joining, { what: 'join 의 결과' });
    check(S, '입장', 'ok', result.ok ? 'ok' : `${result.code} ${JSON.stringify(result.details ?? {})}`, result.ok);
    const joined = zulu.events.find((e) => e.t === 'joined');
    check(S, '순서', 'offer 의 시각 ≤ joined 의 시각', `${offer.at} / ${joined?.at}`, joined !== undefined && offer.at <= joined.at);
    if (result.ok) check(S, '입장 결과의 참가자', 'alpha 가 link=open', linkOf(result, 'alpha'), linkOf(result, 'alpha') === 'open');
    // joined 전에 받은 offer 를 버리고 재전송으로 열린 것이 아님을 본다. 재전송 주기(3초)보다 먼저 열렸고 offer 는 한 건이었다.
    const offers = zulu.count((e) => e.t === 'signal' && e.kind === 'offer' && e.from === 'alpha');
    const opened = zulu.logs('link.attempt_end').find((line) => line.peer === 'alpha' && line.outcome === 'ok');
    check(
      S,
      '먼저 온 offer 로 링크가 열렸다',
      'alpha 의 offer 1건, zulu 의 link.attempt_end{alpha, ok} 가 3초 안',
      `offer ${offers}건, ${opened === undefined ? '열림 기록 없음' : `${opened.duration_ms}ms, 재전송 ${opened.resends}`}`,
      offers === 1 && opened !== undefined && opened.duration_ms < 3_000,
    );
  } finally {
    held.remove();
  }
  await zulu.leave().catch(() => zulu.kill());
  await alpha.leave().catch(() => alpha.kill());
}

// ── partial ─────────────────────────────────────────────────────────────────

async function scenarioPartial(stack) {
  const S = 'partial';
  const room = newRoomId();
  const anna = await stack.peer('anna');
  const bert = await stack.peer('bert');
  const cara = await stack.peer('cara');

  const created = await cara.call('create', { room });
  const annaJoined = await anna.call('join', { room });
  check(S, 'cara 생성, anna 입장', 'ok', `${created.ok ? 'ok' : created.code} / ${annaJoined.ok ? 'ok' : annaJoined.code}`, created.ok && annaJoined.ok);
  if (!created.ok || !annaJoined.ok) return;

  // 부분 mesh 만들기: anna 의 시그널링을 끊은 사이 bert 를 입장시키고, 그 둘 사이의 시그널을 계속 버린다.
  const dropped = stack.proxy.addRule({ pair: ['anna', 'bert'], action: 'signal', op: 'drop' });
  stack.proxy.block('anna');
  stack.proxy.disconnect({ peer: 'anna' });
  await until(async () => {
    const status = await anna.call('status');
    return status.ok && status.room.signaling === 'reconnecting';
  }, 'anna 의 시그널링이 끊긴다', 15_000);
  const bertJoined = await bert.call('join', { room });
  check(S, 'bert 입장(anna 가 서버 목록에 없는 사이)', 'ok', bertJoined.ok ? 'ok' : `${bertJoined.code} ${JSON.stringify(bertJoined.details ?? {})}`, bertJoined.ok);
  if (!bertJoined.ok) return;
  stack.proxy.unblock('anna');
  await until(async () => {
    const status = await anna.call('status');
    return status.ok && status.room.signaling === 'connected';
  }, 'anna 가 다시 등록된다', 45_000, 200);

  /** 주입의 증거: 양쪽 get_status 에서 서로의 링크가 열려 있지 않다. */
  const partialNow = async () => {
    const [a, b, c] = await Promise.all([anna.call('status'), bert.call('status'), cara.call('status')]);
    return {
      annaSeesBert: linkOf(a, 'bert'),
      bertSeesAnna: linkOf(b, 'anna'),
      caraOpen: linkOf(c, 'anna') === 'open' && linkOf(c, 'bert') === 'open',
      holds: linkOf(a, 'bert') !== 'open' && linkOf(b, 'anna') !== 'open' && linkOf(c, 'anna') === 'open' && linkOf(c, 'bert') === 'open',
    };
  };
  const evidence = [];
  const recordEvidence = async (when) => {
    const state = await partialNow();
    evidence.push({ when, ...state });
    return state;
  };
  const first = await recordEvidence('부분 mesh 직후');
  check(S, '부분 mesh', 'anna–bert 링크 없음, 둘 다 cara 와 open', JSON.stringify(first), first.holds);

  // 약 31초 뒤 양쪽에 peer.unreachable 사건이 간다(연속 실패 2회). bert 는 다음 pong 에서 anna 를 알게 된다.
  await anna.event((e) => e.t === 'inbox' && e.kind === 'peer' && e.change === 'unreachable' && e.from === 'bert', { what: 'anna 의 unreachable(bert) 사건', timeoutMs: 60_000 });
  check(S, 'anna 의 닿지 않음 사건', 'peer.unreachable(bert) 1회', String(anna.count((e) => e.t === 'inbox' && e.change === 'unreachable')), true);
  check(S, '주입: 시그널을 버린 규칙', 'hits > 0', String(dropped.hits), dropped.hits > 0);

  // 기준 구간: bert 가 60분 제한의 테스트와 시나리오를 시작하고 5초마다 기록을 쓴다.
  const started = await bert.timed('command', { command: { type: 'start_test', request: '하네스의 테스트 요청', max_duration_min: 60, max_scenarios: 20 } });
  check(S, 'start_test', 'ok, not_connected=[anna]', JSON.stringify(started.result.not_connected ?? started.result.code), started.result.ok && started.result.not_connected.join() === 'anna');
  if (!started.result.ok) return;
  const startedAt = started.at;
  const scenario = await bert.call('command', { command: { type: 'start_scenario', title: '하네스의 시나리오' } });
  check(S, 'start_scenario', 'ok', scenario.ok ? 'ok' : scenario.code, scenario.ok);
  if (!scenario.ok) return;

  const claims = [];
  let lastNote = null;
  let lastNoteAt = 0;
  const holdMs = options.holdSeconds * 1000;
  for (let tick = 1; startedAt + tick * 5_000 <= startedAt + holdMs; tick += 1) {
    await delay(Math.max(0, startedAt + tick * 5_000 - Date.now()));
    if (tick % 3 === 0) {
      lastNote = `n${tick}`;
      const written = await bert.timed('command', { command: { type: 'set_status', status: 'working', note: lastNote } });
      lastNoteAt = written.at;
    } else {
      const written = await bert.timed('command', {
        command: { type: 'record_claim', scenario_id: scenario.scenario_id, action: `행동 ${tick}`, observed: '관찰', outcome: 'pass', steps: '절차' },
      });
      if (written.result.ok) claims.push({ id: written.result.claim_id, at: written.at });
      else check(S, `record_claim ${tick}`, 'ok', written.result.code, false);
    }
    if (tick % 6 === 0) await recordEvidence(`${tick * 5}초`);
  }

  // (1) 경과 시간. 읽은 순간의 실제 경과와 견준다.
  for (const peer of [anna, cara]) {
    const info = await peer.call('replica');
    const actual = info.at - startedAt;
    const diff = (info.elapsed_ms ?? Number.NaN) - actual;
    check(S, `(1) ${peer.name} 의 경과 시간`, '실제보다 1초 넘게 크지 않고 5초 넘게 작지 않다', `경과 ${info.elapsed_ms}ms, 실제 ${actual}ms, 차이 ${diff}ms`, diff <= 1_000 && diff >= -5_000);
  }

  // (6)(7) 중단. bert 는 anna 에게 직접 보내지 못한다. cara 가 병합한 순간 anna 와 교환을 시작한다.
  const stopped = await bert.timed('command', { command: { type: 'stop_test', reason: '하네스의 중단 사유' } });
  check(S, 'stop_test', 'sent_to=[cara], not_connected=[anna]', JSON.stringify([stopped.result.sent_to, stopped.result.not_connected]), stopped.result.ok && stopped.result.sent_to.join() === 'cara' && stopped.result.not_connected.join() === 'anna');
  const stopMerged = await anna
    .event((e) => e.t === 'merged' && e.records.some((record) => record.kind === 'stop'), { what: 'anna 의 복제본에 stop 이 들어온다', timeoutMs: 20_000 })
    .catch(() => null);
  const stopDelay = stopMerged === null ? Number.NaN : stopMerged.at - stopped.at;
  check(S, '(6) stop 이 anna 의 복제본에 들어온 시간', '5초 안', `${stopDelay}ms (${stopMerged?.from ?? '없음'} 에게서, 스냅샷 ${stopMerged?.snapshot})`, stopDelay <= 5_000);
  // 진단 사건 줄은 사건 줄보다 늦게 읽힐 수 있다. 잠깐 기다려서 본다.
  const findCaraStop = () => cara.logs('state.resync').find((line) => line.cause === 'stop' && line.peer === 'anna' && line.at >= stopped.at - 50);
  const findAnnaMerge = () => {
    const start = findCaraStop();
    return start === undefined ? undefined : anna.logs('state.merge').find((line) => line.peer === 'cara' && line.snapshot === true && line.applied >= 1 && line.at >= start.at - 50);
  };
  await until(() => findAnnaMerge() !== undefined, '중단으로 시작된 교환의 병합이 anna 의 로그에 나온다', 3_000, 20).catch(() => {});
  const caraStop = findCaraStop();
  const annaMerge = findAnnaMerge();
  check(S, '(7) 로그', 'cara: state.resync{cause:stop, peer:anna} → anna: cara 의 스냅샷 병합(applied ≥ 1)', `${caraStop === undefined ? '없음' : '있음'} → ${annaMerge === undefined ? '없음' : `applied ${annaMerge.applied}`}`, caraStop !== undefined && annaMerge !== undefined);
  if (caraStop === undefined || annaMerge === undefined) {
    // 실패했을 때 가려낼 수 있게 그 무렵의 진단 사건을 보인다(본문 없음).
    const near = (line) => Math.abs(line.at - stopped.at) <= 2_000;
    note(`stop_test 결과 시각 ${stopped.at}`);
    for (const line of cara.logs().filter((entry) => entry.event.startsWith('state.') && near(entry))) note(`cara ${JSON.stringify(line)}`);
    for (const line of anna.logs().filter((entry) => entry.event.startsWith('state.') && near(entry))) note(`anna ${JSON.stringify(line)}`);
  }

  // (2) 주장이 하나도 빠짐없이 45초 안에. 마지막에 쓴 것은 45초까지 기다려 준다.
  const arrivalOf = (id) => anna.events.find((e) => e.t === 'merged' && e.records.some((record) => record.id === id))?.at;
  await until(() => claims.every((claim) => arrivalOf(claim.id) !== undefined), 'bert 의 주장이 모두 anna 에 들어온다', 46_000, 200).catch(() => {});
  const delays = claims.map((claim) => (arrivalOf(claim.id) ?? Number.POSITIVE_INFINITY) - claim.at);
  const missing = delays.filter((ms) => !Number.isFinite(ms)).length;
  const slowest = Math.max(...delays.filter(Number.isFinite), 0);
  check(S, '(2) bert 의 주장이 anna 의 복제본에 들어온 시간', `${claims.length}건 모두 45초 안`, `빠진 것 ${missing}건, 가장 늦은 것 ${slowest}ms`, missing === 0 && slowest <= 45_000);

  // (3) presence 는 키 기록이라 마지막 값이 45초 안에 들어오면 된다.
  const presence = await until(async () => {
    const info = await anna.call('replica');
    return info.presences?.bert?.note === lastNote ? info : null;
  }, 'bert 의 마지막 presence 가 anna 에 들어온다', Math.max(1_000, lastNoteAt + 46_000 - Date.now()), 200).catch(() => null);
  check(S, '(3) bert 의 마지막 presence', '45초 안에 anna 의 복제본에', presence === null ? '들어오지 않았다' : `${presence.at - lastNoteAt}ms 안`, presence !== null && presence.at - lastNoteAt <= 45_000);

  // (4) 유지 구간 동안 anna–cara 링크의 재동기화 횟수(시작한 것과 답한 것).
  const inWindow = (line) => line.at >= startedAt && line.at <= startedAt + holdMs;
  const resyncs = anna.logs('state.resync').filter((line) => line.peer === 'cara' && line.cause !== undefined && inWindow(line));
  const expectedResyncs = options.holdSeconds >= 180 ? 4 : 1;
  check(S, `(4) ${options.holdSeconds}초 동안 anna–cara 의 state.resync`, `${expectedResyncs}회 이상`, `${resyncs.length}회 (${[...new Set(resyncs.map((line) => line.cause))].join(', ')})`, resyncs.length >= expectedResyncs);
  const gaps = [...new Set([...anna.logs('state.resync'), ...cara.logs('state.resync')].filter((line) => line.gap_ms !== undefined).map((line) => line.gap_ms))];
  note(`재동기화 간격(gap_ms)의 값: ${gaps.join(', ')}`);
  const caraResyncs = cara.logs('state.resync').filter((line) => line.peer === 'anna' && line.cause !== undefined && inWindow(line));
  note(`유지 구간의 state.resync 시각(시작 기준 초): anna ${resyncs.map((line) => ((line.at - startedAt) / 1000).toFixed(1)).join(', ')} / cara ${caraResyncs.map((line) => `${((line.at - startedAt) / 1000).toFixed(1)}(${line.cause})`).join(', ')}`);

  // (5) state_diverged 사건과 경고. 끊긴 쌍의 한쪽(bert)까지 세 참가자를 다 본다.
  const divergedEvents = [anna, bert, cara].map((peer) => peer.count((e) => e.t === 'inbox' && e.code === 'state_diverged') + peer.logs('state.diverged').length);
  const statuses = await Promise.all([anna, bert, cara].map((peer) => peer.call('status')));
  const warnings = statuses.map((status) => (status.warnings ?? []).filter((warning) => warning.code === 'state_diverged').length);
  check(S, '(5) state_diverged', '사건 0건, 경고 0건 (anna+bert+cara)', `사건·로그 ${divergedEvents.join('+')}건, 경고 ${warnings.join('+')}건`, divergedEvents.every((n) => n === 0) && warnings.every((n) => n === 0));

  // (8) 채팅은 작성자와 수신자를 잇는 링크로만 간다.
  const chat = await bert.call('send', { text: 'anna 에게는 가지 않는 글' });
  const annaUndelivered = chat.ok && chat.undelivered.some((entry) => entry.name === 'anna' && entry.reason === 'not_connected');
  await delay(1_000);
  const annaChats = anna.count((e) => e.t === 'inbox' && e.kind === 'chat' && e.from === 'bert');
  const caraChats = cara.count((e) => e.t === 'inbox' && e.kind === 'chat' && e.from === 'bert');
  check(S, '(8) bert 의 채팅', 'delivered=[cara], anna 는 not_connected, anna 의 수신함에 없음', `${JSON.stringify(chat.delivered ?? chat.code)}, anna 수신 ${annaChats}건, cara 수신 ${caraChats}건`, annaUndelivered && chat.delivered.join() === 'cara' && annaChats === 0 && caraChats === 1);

  // (9) 끝났을 때의 지문.
  const prints = await until(async () => {
    const infos = await Promise.all([anna, bert, cara].map((peer) => peer.call('replica')));
    return new Set(infos.map((info) => info.fingerprint)).size === 1 ? infos : null;
  }, '세 참가자의 지문이 같아진다', 46_000, 500).catch(() => null);
  check(S, '(9) 세 참가자의 지문', '같다', prints === null ? '45초 안에 같아지지 않았다' : `${prints[0].fingerprint} (기록 ${prints[0].count}건)`, prints !== null);

  // 주입의 증거: 시험 내내 anna–bert 링크가 없었다.
  await recordEvidence('끝');
  const held = evidence.every((entry) => entry.holds);
  check(S, '주입의 증거: 시험 내내 부분 mesh', `${evidence.length}번 본 get_status 모두 anna–bert 링크 없음`, evidence.map((entry) => `${entry.when}:${entry.annaSeesBert}/${entry.bertSeesAnna}`).join(' '), held);
  check(S, '주입의 증거: 버린 시그널', 'hits > 0', String(dropped.hits), dropped.hits > 0);
  // get_status 를 본 사이에도 열린 적이 없음을 mesh 의 로그로 본다. 시도는 있었고 모두 열리지 못했다.
  const attemptsBetween = (peer, other) => peer.logs('link.attempt_end').filter((line) => line.peer === other);
  const annaAttempts = attemptsBetween(anna, 'bert');
  const bertAttempts = attemptsBetween(bert, 'anna');
  const openedBetween = [...annaAttempts, ...bertAttempts].filter((line) => line.outcome === 'ok').length;
  const reasons = [...new Set([...annaAttempts, ...bertAttempts].filter((line) => line.outcome !== 'ok').map((line) => `${line.stage}/${line.reason}`))];
  check(
    S,
    '주입의 증거: mesh 로그',
    'anna–bert 사이 link.attempt_end{ok} 0건, 실패한 시도 ≥ 1',
    `열림 ${openedBetween}건, 실패 anna ${annaAttempts.length - annaAttempts.filter((line) => line.outcome === 'ok').length}건·bert ${bertAttempts.length - bertAttempts.filter((line) => line.outcome === 'ok').length}건 (${reasons.join(', ')})`,
    openedBetween === 0 && annaAttempts.length + bertAttempts.length >= 1,
  );
  if (options.holdSeconds < 180) note(`유지 시간이 ${options.holdSeconds}초다. 기준(180초)보다 짧으므로 V-L12 의 통과로 보고하지 않는다.`);

  dropped.remove();
  for (const peer of [anna, bert, cara]) await peer.leave().catch(() => peer.kill());
}

// ── 실행 ────────────────────────────────────────────────────────────────────

const RUN = { sync: scenarioSync, 'early-offer': scenarioEarlyOffer, partial: scenarioPartial };
let failed = false;
for (const name of options.only) {
  const startedAt = Date.now();
  let stack = null;
  try {
    stack = await startStack({ label: `v-l12-${name}`, keepHome: options.keepHome });
    process.stdout.write(`\n▶ ${name} (프로세스: ${stack.pids().map((entry) => `${entry.name}=${entry.pid}`).join(', ')})\n`);
    await RUN[name](stack);
    process.stdout.write(`      띄운 프로세스: ${stack.pids().map((entry) => `${entry.name}=${entry.pid}`).join(', ')}\n`);
    if (options.keepHome) process.stdout.write(`      임시 홈: ${stack.homeRoot}\n`);
    await stack.close();
    check(name, '끝난 뒤 남은 프로세스', '0개', '0개', true);
  } catch (error) {
    failed = true;
    process.stdout.write(`실패  [${name}] 시나리오가 끝까지 가지 못했다: ${error?.message ?? error}\n`);
    if (stack !== null) {
      const killed = await stack.abort().catch(() => []);
      process.stdout.write(`      정리하면서 지운 프로세스: ${killed.length === 0 ? '없음' : killed.map((entry) => `${entry.name}=${entry.pid}`).join(', ')}\n`);
    }
  }
  process.stdout.write(`      ${name}: ${((Date.now() - startedAt) / 1000).toFixed(1)}초\n`);
}

const failures = checks.filter((entry) => !entry.passed);
process.stdout.write(`\n확인 ${checks.length}건, 통과 ${checks.length - failures.length}건, 실패 ${failures.length}건${failed ? ', 끝까지 가지 못한 시나리오 있음' : ''}\n`);
process.exit(failures.length === 0 && !failed ? 0 : 1);
