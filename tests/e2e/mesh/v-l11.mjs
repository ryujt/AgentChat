// V-L11 연결 단독: 두 프로세스(signaling-client + mesh) + 자체 호스팅 서버 + 시험용 프록시.
// A-RTC-2(offer-request 흐름, 후보 묶음, 두 큐, 재전송), A-RTC-3(교체 확인), A-RTC-5(signal 크기), netInfo() 를 본다.
// 통과 기준은 docs/design/verification-plan.md 의 A-RTC-2·3·5 와 V-L11 행이다.
//
// ── 쓰는 법 ─────────────────────────────────────────────────────────────────
//
//   npm run build                                    # 또는 묶음별 빌드 폴더
//   node tests/e2e/mesh/v-l11.mjs                     # 전부. 약 2분 30초
//   AGENT_CHAT_DIST=.work/w3a/dist node tests/e2e/mesh/v-l11.mjs --only connect,queue
//
//   --only <이름,이름>     고른 절만 돌린다. 이름은 아래 절의 [이름] 이다
//   --connects <수>        [connect] 의 연결 횟수 (기본 100)
//   --requests <수>        [live] 의 방향별 요청 횟수 (기본 200)
//   --replacements <수>    [replace] 의 교체 횟수 (기본 200)
//   --netinfo-runs <수>    [netinfo] 의 연결 횟수 (기본 10)
//   --netinfo-hold-runs <수>  [netinfo] 보충(공개 STUN + 후보 선도착 주입)의 연결 횟수 (기본 5)
//   --stun <목록>          [netinfo] 가 쓸 ICE 서버 (기본 stun:stun.l.google.com:19302)
//   --drop-rounds <수>     [drop] 의 경우마다 되풀이할 횟수 (기본 1). 드문 느린 연결을 다시 찾을 때 쓴다
//   --native-log           [drop] 의 참가자를 --native-log 로 띄운다. 실패한 회에 라이브러리 로그(주소를 가림)를 함께 낸다
//
// ── 절 ──────────────────────────────────────────────────────────────────────
//
//   [connect]  A-RTC-2  두 프로세스 연결을 --connects 회. offer 를 바로 보내는 쪽과 offer-request 로 시작하는 쪽을 번갈아 한다
//   [queue]    A-RTC-2 (가)(나)  후보를 offer 보다 먼저 도착시킨다. answer 쪽 후보를 모두 버려도 그 후보만으로 연결되는지
//   [drop]     A-RTC-2 (다)  offer-request, offer, answer, 후보 묶음을 하나씩 버려도 15초 안에 연결되는지. 로그의 resends 가 주입과 맞는지
//   [dup]      A-RTC-2 (라)  같은 시그널이 두 번 와도 연결은 하나이고 같은 후보를 한 번만 넣는지
//   [fail]     protocol.md 3.3  양방향 후보를 모두 버리면(직접 연결 불가) 기한 안에 ice/ice_timeout, offer 를 계속 버리면
//                      signaling/no_answer·no_offer 로 끝나는지. 재전송 수가 보낸 시그널 수와 맞는지(세 경우를 동시에, 약 20초)
//   [live]     A-RTC-3  살아 있는 링크에 새 요청을 방향별 --requests 회 보내도 교체가 0회인지
//   [kill]     A-RTC-3  상대를 죽인 뒤의 요청은 2초 뒤에 교체되는지(offer 쪽, answer 쪽)
//   [replace]  A-RTC-3  교체를 --replacements 회 한 뒤 피어마다 링크 1개, 크래시 0, RSS 증가 20% 이하인지
//   [netinfo]  V-L11   기본 STUN 으로 --netinfo-runs 회 연결. link-open 뒤 3초 안에 srflx_seen 이 참인지.
//                      공개 STUN 에 닿지 않으면 미실행으로 적는다. 보충으로 공개 STUN + 후보 선도착 주입, 로컬 STUN 대역에서
//                      "링크가 열린 뒤의 후보"를 따로 본다(계획의 10회 판정을 대신하지 않는다)
//   [size]     A-RTC-5  위 절들에서 프록시가 본 가장 큰 signal 이 16384바이트 이하인지(항상 마지막에 낸다)
//
// 서버와 프록시는 빈 포트(0)에 띄운다. 끝날 때 자기가 띄운 프로세스가 남지 않았는지 확인한다.
// 하나라도 실패하면 종료 코드 1. 미실행 항목이 있어도 실패가 없으면 0 이고, 요약에 "미실행"으로 적는다.
// 방 ID, SDP, candidate 는 출력하지 않는다.

import dgram from 'node:dgram';
import os from 'node:os';
import { delay, newRoomId, newSid, startStack, until } from './harness.mjs';

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
const only = (argValue('only') ?? 'connect,queue,drop,dup,fail,live,kill,replace,netinfo').split(',').map((name) => name.trim());
const CONNECTS = Number.parseInt(argValue('connects') ?? '100', 10);
const REQUESTS = Number.parseInt(argValue('requests') ?? '200', 10);
const REPLACEMENTS = Number.parseInt(argValue('replacements') ?? '200', 10);
const NETINFO_RUNS = Number.parseInt(argValue('netinfo-runs') ?? '10', 10);
const NETINFO_HOLD_RUNS = Number.parseInt(argValue('netinfo-hold-runs') ?? '5', 10);
const STUN = argValue('stun') ?? 'stun:stun.l.google.com:19302';
const DROP_ROUNDS = Number.parseInt(argValue('drop-rounds') ?? '1', 10);
const NATIVE_LOG = process.argv.includes('--native-log');

const PEER_CONNECT_TIMEOUT_MS = 15_000;
const REPLACE_PROBE_MS = 2_000;
const SIGNAL_MAX_MESSAGE_BYTES = 16_384;
// 기한 타이머가 늦게 도는 만큼의 여유. 기한을 넘겨 끝난 시도는 이 안이어야 한다.
const FAIL_SLACK_MS = 500;
// 시도 시간(diag.duration_ms)은 Date.now 의 차이(ms 버림)이고, Node 타이머는 libuv 의 ms 버림 단조 시각에 기한을 건다.
// 두 버림이 겹치면 기한대로 돈 타이머도 14999ms 로 읽힌다(2026-11-16-final-close L-FC-03). 그 측정 단위 1ms 만 빼고 본다.
// "기한 전에 끝나지 않는다"는 뜻은 그대로다(2ms 이상 이르면 실패).
const CLOCK_GRANULARITY_MS = 1;

/** @type {{section: string, name: string, verdict: '통과'|'실패'|'부분 검증'|'미실행', detail: string}[]} */
const results = [];
function note(section, name, verdict, detail = '') {
  results.push({ section, name, verdict, detail });
  process.stdout.write(`${verdict}  [${section}] ${name}${detail ? `  (${detail})` : ''}\n`);
}
const check = (section, name, ok, detail = '') => note(section, name, ok ? '통과' : '실패', detail);

const stack = await startStack({ label: 'v-l11' });
const { proxy } = stack;

const lastEnd = (peer) => peer.logs('link.attempt_end').at(-1) ?? {};
const signalCount = (key) => proxy.stats().signals[key] ?? 0;

/** 방을 새로 만들어 두 참가자를 띄운다. first 가 방을 만들고 second 가 입장한다. */
async function pair(first, second, options = {}) {
  const room = newRoomId();
  const a = await stack.peer({ room, name: first, mode: 'create', ...options });
  const b = await stack.peer({ room, name: second, mode: 'join', ...options });
  return { room, [first]: a, [second]: b, both: [a, b] };
}

async function leaveAll(peers) {
  await Promise.all(peers.map((peer) => peer.leave()));
}

// ── [connect] ───────────────────────────────────────────────────────────────
async function connectSection() {
  const section = 'connect';
  const times = [];
  const failures = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const round = next;
      next += 1;
      if (round >= CONNECTS) return;
      // 짝수 회: bob 이 나중에 들어와 offer-request 를 보낸다. 홀수 회: alice 가 나중에 들어와 offer 를 바로 보낸다.
      const [first, second] = round % 2 === 0 ? ['alice', 'bob'] : ['bob', 'alice'];
      let peers = [];
      try {
        const startedAt = Date.now();
        const made = await pair(first, second);
        peers = made.both;
        await Promise.all([made.alice.linkOpen('bob'), made.bob.linkOpen('alice')]);
        times.push(Date.now() - startedAt);
        made.alice.command({ cmd: 'send', peer: 'bob', text: `ping ${round}` });
        made.bob.command({ cmd: 'send', peer: 'alice', text: `pong ${round}` });
        await Promise.all([
          made.bob.event((e) => e.t === 'frame' && e.text === `ping ${round}`, { what: '프레임' }),
          made.alice.event((e) => e.t === 'frame' && e.text === `pong ${round}`, { what: '프레임' }),
        ]);
        if (made.both.some((peer) => peer.count((e) => e.t === 'attempt-failed') > 0)) throw new Error('attempt-failed 가 나왔다');
        await leaveAll(peers);
      } catch (error) {
        failures.push(`${round}회: ${String(error.message).split('\n')[0]}`);
        await Promise.all(peers.map((peer) => peer.kill()));
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  times.sort((x, y) => x - y);
  const median = times[Math.floor(times.length / 2)] ?? 0;
  check(
    section,
    `두 프로세스 연결 ${CONNECTS}회 성공 (A-RTC-2)`,
    failures.length === 0 && times.length === CONNECTS,
    `성공 ${times.length}/${CONNECTS}. 프로세스 시작부터 양쪽 link-open 까지 중앙값 ${median}ms, 최대 ${times.at(-1) ?? 0}ms${failures.length ? `. 실패: ${failures.slice(0, 3).join(' / ')}` : ''}`,
  );
}

// ── [queue] ─────────────────────────────────────────────────────────────────
async function queueSection() {
  const section = 'queue';

  // (가) 후보가 offer 보다 먼저 도착한다. 두 경우: answer 쪽에 시도가 없을 때, offer-request 를 보내고 기다릴 때.
  for (const [label, first, second] of [
    ['answer 쪽에 시도가 없을 때', 'bob', 'alice'],
    ['answer 쪽이 offer-request 를 보내고 기다릴 때', 'alice', 'bob'],
  ]) {
    const before = signalCount('alice>bob:candidate');
    const held = proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', op: 'hold' });
    const made = await pair(first, second);
    await until(() => signalCount('alice>bob:candidate') > before && held.holding >= 1, '후보 묶음이 지나가고 offer 는 붙들린 상태');
    await delay(150);
    const released = held.release();
    held.remove();
    await Promise.all([made.alice.linkOpen('bob'), made.bob.linkOpen('alice')]);
    const end = lastEnd(made.bob);
    check(section, `(가) 후보를 offer 보다 먼저 도착시켜도 연결된다: ${label}`, end.outcome === 'ok' && end.queued_applied >= 1, `붙든 offer ${released}건, 대기 큐에서 꺼내 넣은 후보 ${end.queued_applied}건, 받은 후보 host ${end.cand_remote_host}건`);
    await leaveAll(made.both);
  }

  // (나) answer 쪽 후보를 모두 버리고, offer 쪽 후보도 offer 보다 먼저 온 첫 묶음만 남긴다.
  {
    const before = signalCount('alice>bob:candidate');
    const held = proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', op: 'hold' });
    const answerSide = proxy.addRule({ from: 'bob', to: 'alice', kind: 'candidate', op: 'drop' });
    const later = proxy.addRule({ from: 'alice', to: 'bob', kind: 'candidate', nth: { first: 2 }, op: 'drop' });
    const made = await pair('bob', 'alice');
    await until(() => signalCount('alice>bob:candidate') > before && held.holding >= 1, '첫 후보 묶음이 지나가고 offer 는 붙들린 상태');
    await delay(150);
    held.release();
    held.remove();
    await Promise.all([made.alice.linkOpen('bob'), made.bob.linkOpen('alice')]);
    const bobEnd = lastEnd(made.bob);
    const aliceEnd = lastEnd(made.alice);
    check(
      section,
      '(나) answer 쪽이 보낸 후보를 모두 버려도 offer 보다 먼저 온 offer 쪽 후보만으로 연결된다',
      bobEnd.queued_applied >= 1 && bobEnd.queued_applied === bobEnd.cand_remote_host + bobEnd.cand_remote_srflx && aliceEnd.cand_remote_host + aliceEnd.cand_remote_srflx === 0,
      `answer 쪽 후보 ${answerSide.hits}건 버림(링크가 먼저 열리면 보내지 않아 0건일 수 있다), offer 쪽의 뒤 묶음 ${later.hits}건 버림. answer 쪽이 넣은 후보 ${bobEnd.queued_applied}건(모두 대기 큐), offer 쪽이 받은 후보 ${aliceEnd.cand_remote_host + aliceEnd.cand_remote_srflx}건`,
    );
    answerSide.remove();
    later.remove();
    await leaveAll(made.both);
  }
}

// ── [drop] ──────────────────────────────────────────────────────────────────
/** 실패한 회의 판정 근거. 진단 사건에는 SDP 와 candidate 가 없다. 라이브러리 로그는 --native-log 일 때만 있고 주소를 가렸다. */
function dumpAttempt(peers) {
  for (const peer of peers) {
    const lines = peer.logs().filter((line) => line.mod === 'mesh').map((line) => `${line.event}[${line.kind ?? line.outcome ?? ''} ${line.cause ?? ''} resends=${line.resends ?? ''} ice=${line.ice_state ?? ''} pc=${line.pc_state ?? ''} ms=${line.duration_ms ?? ''}]`);
    process.stdout.write(`      ${peer.name} 의 mesh 사건: ${lines.join(' → ')}\n`);
    const native = peer.nativeLogs().filter((line) => /state|juice|DTLS|SCTP|addRemoteCandidate|setRemoteDescription/i.test(line.message));
    if (native.length === 0) continue;
    const base = native[0].at;
    process.stdout.write(`      ${peer.name} 의 라이브러리 로그(첫 줄 기준 ms):\n${native.map((line) => `        +${line.at - base} ${line.message}`).join('\n')}\n`);
  }
}

async function dropSection() {
  const section = 'drop';
  // expect 는 로그의 resends 가 들어야 하는 범위 [최소, 최대] 다. 버린 것을 다시 보내는 쪽은 정확히 1회다.
  // 상대 쪽은 그 재전송에 답하는 것(중복 offer 에 answer 를 다시 보냄)과 자기 3초 주기가 겹칠 수 있어 범위로 본다.
  const cases = [
    { name: 'offer-request', first: 'alice', second: 'bob', rules: [{ from: 'bob', to: 'alice', kind: 'offer-request', nth: 1, op: 'drop' }], expect: { alice: [0, 0], bob: [1, 1] } },
    { name: 'offer', first: 'bob', second: 'alice', rules: [{ from: 'alice', to: 'bob', kind: 'offer', nth: 1, op: 'drop' }], expect: { alice: [1, 1], bob: [0, 0] } },
    { name: 'answer', first: 'bob', second: 'alice', rules: [{ from: 'bob', to: 'alice', kind: 'answer', nth: 1, op: 'drop' }], expect: { alice: [1, 1], bob: [1, 2] } },
    {
      name: '후보 묶음(양방향의 첫 묶음)',
      first: 'bob',
      second: 'alice',
      rules: [
        { from: 'alice', to: 'bob', kind: 'candidate', nth: 1, op: 'drop' },
        { from: 'bob', to: 'alice', kind: 'candidate', nth: 1, op: 'drop' },
      ],
      expect: { alice: [1, 1], bob: [0, 1] },
    },
  ];
  const flags = NATIVE_LOG ? ['--native-log'] : [];
  for (const item of cases) {
    const rounds = [];
    for (let round = 0; round < DROP_ROUNDS; round += 1) {
      const rules = item.rules.map((rule) => proxy.addRule(rule));
      const startedAt = Date.now();
      const made = await pair(item.first, item.second, { flags });
      let opened = false;
      try {
        await Promise.all([
          made.alice.linkOpen('bob', { timeoutMs: PEER_CONNECT_TIMEOUT_MS }),
          made.bob.linkOpen('alice', { timeoutMs: PEER_CONNECT_TIMEOUT_MS }),
        ]);
        opened = true;
      } catch {
        opened = false;
      }
      const elapsed = Date.now() - startedAt;
      // 시도 안에서 잰 시간(시도 시작 → 채널 열림). 프로세스 시작과 입장을 빼고 본다.
      const attemptMs = Math.max(lastEnd(made.alice).duration_ms ?? -1, lastEnd(made.bob).duration_ms ?? -1);
      const resends = { alice: lastEnd(made.alice).resends, bob: lastEnd(made.bob).resends };
      const hits = rules.map((rule) => rule.hits);
      const resendsMatch = Object.entries(item.expect).every(([name, [min, max]]) => resends[name] >= min && resends[name] <= max);
      const failed = made.both.some((peer) => peer.count((e) => e.t === 'attempt-failed') > 0);
      const ok = opened && elapsed <= PEER_CONNECT_TIMEOUT_MS && !failed && hits.every((count) => count === 1) && resendsMatch;
      rounds.push({ ok, elapsed, attemptMs, resends, hits });
      if (!ok) {
        process.stdout.write(`      ${item.name} ${round + 1}회째 실패: 열림 ${opened}, 연결까지 ${elapsed}ms, 시도 안 ${attemptMs}ms, resends alice=${resends.alice} bob=${resends.bob}, 버린 수 ${hits.join('+')}\n`);
        dumpAttempt(made.both);
      }
      for (const rule of rules) rule.remove();
      await leaveAll(made.both);
    }
    const passed = rounds.filter((entry) => entry.ok).length;
    const times = rounds.map((entry) => entry.attemptMs).sort((x, y) => x - y);
    const resendText = [...new Set(rounds.map((entry) => `${entry.resends.alice}/${entry.resends.bob}`))].join(', ');
    check(
      section,
      `(다) ${item.name} 을(를) 하나 버려도 15초 안에 연결된다. 로그의 resends 가 주입과 맞는다`,
      passed === DROP_ROUNDS,
      DROP_ROUNDS === 1
        ? `버린 수 ${rounds[0].hits.join('+')}건, 연결까지 ${rounds[0].elapsed}ms(프로세스 시작 포함. 시도 안 ${rounds[0].attemptMs}ms), resends alice=${rounds[0].resends.alice} bob=${rounds[0].resends.bob}(기대 ${JSON.stringify(item.expect)})`
        : `${DROP_ROUNDS}회 중 통과 ${passed}. 시도 안에서 잰 연결 시간 최소 ${times[0]}ms, 중앙값 ${times[Math.floor(times.length / 2)]}ms, 최대 ${times.at(-1)}ms. resends(alice/bob) ${resendText}(기대 ${JSON.stringify(item.expect)})`,
    );
  }
}

// ── [fail] ──────────────────────────────────────────────────────────────────
/**
 * 열리지 못하는 시도가 기한(15초) 안에 정해진 단계로 끝나는지 본다(protocol.md 3.3 의 실패 분류).
 * 세 경우를 동시에 돌린다. 이름이 경우마다 달라 규칙이 섞이지 않는다. 이름이 작은 쪽(…a)이 offer 쪽이다.
 * expect 가 null 인 쪽에는 시도가 없다(목록에서 상대를 아직 못 봤다. pong 은 30초 주기라 기한 안에 오지 않는다).
 */
async function failSection() {
  const section = 'fail';
  const cases = [
    {
      name: '직접 연결 불가(양방향 후보를 모두 버림)',
      offer: 'ia',
      answer: 'ib',
      creator: 'ib',
      rules: [{ pair: ['ia', 'ib'], kind: 'candidate', op: 'drop' }],
      expect: { ia: ['ice', 'ice_timeout'], ib: ['ice', 'ice_timeout'] },
      // 시도마다 처음 묶음 1건 + 재전송마다 1건(후보가 32건 이하일 때).
      sent: (count, ends) => count('ia>ib:candidate') === 1 + ends.ia.resends && count('ib>ia:candidate') === 1 + ends.ib.resends,
      sentText: (count) => `후보 메시지 ia→ib ${count('ia>ib:candidate')}건, ib→ia ${count('ib>ia:candidate')}건(모두 버림)`,
    },
    {
      name: 'offer 를 계속 버림(offer 쪽이 나중에 들어와 offer 를 바로 보냄)',
      offer: 'oa',
      answer: 'ob',
      creator: 'ob',
      rules: [{ from: 'oa', to: 'ob', kind: 'offer', op: 'drop' }],
      expect: { oa: ['signaling', 'no_answer'], ob: null },
      sent: (count, ends) => count('oa>ob:offer') === 1 + ends.oa.resends,
      sentText: (count) => `offer ${count('oa>ob:offer')}건(모두 버림), 후보 ${count('oa>ob:candidate')}건`,
    },
    {
      name: 'offer 를 계속 버림(answer 쪽이 나중에 들어와 offer-request 를 보냄)',
      offer: 'ra',
      answer: 'rb',
      creator: 'ra',
      rules: [{ from: 'ra', to: 'rb', kind: 'offer', op: 'drop' }],
      expect: { ra: ['signaling', 'no_answer'], rb: ['signaling', 'no_offer'] },
      // offer 쪽은 주기 재전송에 더해 offer-request 를 받을 때마다 offer 를 다시 보낸다.
      sent: (count, ends) => count('ra>rb:offer') === 1 + ends.ra.resends && count('rb>ra:offer-request') === 1 + ends.rb.resends,
      sentText: (count) => `offer ${count('ra>rb:offer')}건(모두 버림), offer-request ${count('rb>ra:offer-request')}건`,
    },
  ];

  async function runCase(item) {
    const rules = item.rules.map((rule) => proxy.addRule(rule));
    const room = newRoomId();
    const joiner = item.creator === item.offer ? item.answer : item.offer;
    const peers = {};
    peers[item.creator] = await stack.peer({ room, name: item.creator, mode: 'create' });
    peers[joiner] = await stack.peer({ room, name: joiner, mode: 'join' });
    const joinedAt = Date.now();
    const both = [peers[item.offer], peers[item.answer]];
    const failures = {};
    const waitMs = PEER_CONNECT_TIMEOUT_MS + 3_000;
    await Promise.all(
      Object.entries(item.expect).map(async ([name, expected]) => {
        if (expected === null) return;
        try {
          failures[name] = await peers[name].event((e) => e.t === 'attempt-failed', { what: 'attempt-failed', timeoutMs: waitMs });
          failures[name].afterJoinMs = failures[name].seenAt - joinedAt;
        } catch {
          failures[name] = null;
        }
      }),
    );
    // 시도가 없어야 하는 쪽도 기한이 지날 때까지 지켜본다.
    await delay(Math.max(0, joinedAt + waitMs - Date.now() - 2_500));
    const statuses = await Promise.all(both.map((peer) => peer.status()));
    const ends = {};
    for (const peer of both) ends[peer.name] = peer.logs('link.attempt_end').at(-1) ?? null;
    const count = (key) => signalCount(key);
    const verdicts = Object.entries(item.expect).map(([name, expected]) => {
      const peer = peers[name];
      const opened = peer.count((e) => e.t === 'link-open');
      const failCount = peer.count((e) => e.t === 'attempt-failed');
      if (expected === null) {
        return { name, ok: opened === 0 && failCount === 0 && ends[name] === null, text: `${name}: 시도 없음(attempt-failed ${failCount}건, link-open ${opened}건)` };
      }
      const failure = failures[name];
      const end = ends[name];
      const status = statuses[both.indexOf(peer)];
      const ok =
        failure !== null &&
        failure.stage === expected[0] &&
        failure.reason === expected[1] &&
        failCount === 1 &&
        opened === 0 &&
        failure.diag.duration_ms >= PEER_CONNECT_TIMEOUT_MS - CLOCK_GRANULARITY_MS &&
        failure.diag.duration_ms <= PEER_CONNECT_TIMEOUT_MS + FAIL_SLACK_MS &&
        end !== null &&
        end.outcome === 'failed' &&
        end.stage === expected[0] &&
        end.reason === expected[1] &&
        end.resends === failure.diag.resends &&
        status.links.length === 0;
      const text =
        failure === null
          ? `${name}: ${waitMs}ms 안에 attempt-failed 가 없다`
          : `${name}: ${failure.stage}/${failure.reason}, 시도 안 ${failure.diag.duration_ms}ms(입장 뒤 ${failure.afterJoinMs}ms), ice=${failure.diag.ice_state} pc=${failure.diag.pc_state}, 받은 후보 ${failure.diag.remote.host + failure.diag.remote.srflx}건, resends ${failure.diag.resends}, 남은 링크·시도 ${status.links.length}개`;
      return { name, ok, text };
    });
    const sentOk = Object.values(ends).every((end) => end === null || typeof end.resends === 'number') && item.sent(count, Object.fromEntries(Object.entries(ends).map(([name, end]) => [name, end ?? { resends: 0 }])));
    check(
      section,
      `${item.name}: 기한 안에 ${[...new Set(Object.values(item.expect).filter(Boolean).map((pair) => pair.join('/')))].join(', ')} 로 끝나고 재전송 수가 보낸 시그널 수와 맞는다`,
      verdicts.every((entry) => entry.ok) && sentOk,
      `${verdicts.map((entry) => entry.text).join('. ')}. ${item.sentText(count)}`,
    );
    if (!verdicts.every((entry) => entry.ok)) dumpAttempt(both);
    for (const rule of rules) rule.remove();
    await leaveAll(both);
  }

  await Promise.all(cases.map((item) => runCase(item)));
}

// ── [dup] ───────────────────────────────────────────────────────────────────
async function dupSection() {
  const section = 'dup';
  const rules = ['offer', 'answer', 'candidate'].map((kind) => proxy.addRule({ pair: ['alice', 'bob'], kind, op: 'duplicate' }));
  const made = await pair('bob', 'alice');
  await Promise.all([made.alice.linkOpen('bob'), made.bob.linkOpen('alice')]);
  await delay(300);
  const opens = made.both.map((peer) => peer.count((e) => e.t === 'link-open'));
  const ends = made.both.map((peer) => lastEnd(peer));
  // 같은 후보가 두 번 온 쪽은 받은 후보 수만큼 중복을 무시했어야 한다(연결이 먼저 열려 뒤 묶음을 못 본 쪽은 0 일 수 있다).
  const dupIgnored = ends.reduce((sum, end) => sum + (end.dup_ignored ?? 0), 0);
  // 중복을 걸렀다면 한쪽이 넣은 후보 수는 상대가 모은 후보 수를 넘지 않는다.
  const remote = (end) => end.cand_remote_host + end.cand_remote_srflx;
  const local = (end) => end.cand_local_host + end.cand_local_srflx;
  const candidatesOnce = remote(ends[0]) <= local(ends[1]) && remote(ends[1]) <= local(ends[0]);
  check(
    section,
    '(라) 같은 offer·answer·후보가 두 번 와도 연결은 하나이고 같은 후보를 한 번만 넣는다',
    opens.every((count) => count === 1) && dupIgnored >= 1 && candidatesOnce && made.both.every((peer) => peer.count((e) => e.t === 'attempt-failed' || e.t === 'link-closed') === 0),
    `두 번 보낸 수 offer ${rules[0].hits}, answer ${rules[1].hits}, 후보 ${rules[2].hits}. link-open ${opens.join('/')}회, 무시한 중복 ${dupIgnored}건, 넣은 후보 ${ends.map(remote).join('/')}건(상대가 모은 후보 ${ends.map(local).reverse().join('/')}건)`,
  );
  for (const rule of rules) rule.remove();
  await leaveAll(made.both);
}

// ── [live] ──────────────────────────────────────────────────────────────────
/** 같은 이름의 다른 프로세스 노릇을 하는 날 클라이언트를 서버에 바로 붙인다. 진짜의 등록이 지워질 때까지 다시 한다. */
async function impostor(room, name) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const raw = await stack.raw();
    const { reply, sid } = await raw.join({ room, peer: name, mode: 'join' });
    if (reply.type === 'joined') return { raw, sid };
    raw.close();
    await delay(50);
  }
  throw new Error(`${name} 의 이름으로 등록하지 못했다`);
}

async function liveSection() {
  const section = 'live';
  const made = await pair('alice', 'bob');
  await Promise.all([made.alice.linkOpen('bob'), made.bob.linkOpen('alice')]);
  const kept = (peer) => peer.logs('link.replace_probe').filter((line) => line.outcome === 'kept').length;

  // answer 쪽(bob)에 새 cid 의 offer 를 보낸다. 진짜 alice 는 시그널링만 끊기고 DataChannel 은 살아 있다.
  proxy.block('alice');
  const fakeAlice = await impostor(made.room, 'alice');
  for (let n = 1; n <= REQUESTS; n += 1) {
    fakeAlice.raw.signal('bob', { kind: 'offer', cid: `${fakeAlice.sid}.${n}`, data: { sdp: 'v=0\r\n' } });
    await until(() => kept(made.bob) >= n, `bob 의 ${n}번째 교체 확인 결과`, 5_000, 2);
  }
  fakeAlice.raw.close();
  proxy.unblock('alice');
  await made.alice.event((e) => e.t === 'state' && e.state === 'connected', { what: '진짜 alice 의 재등록', timeoutMs: 45_000, from: made.alice.events.length });

  // offer 쪽(alice)에 offer-request 를 보낸다.
  proxy.block('bob');
  const fakeBob = await impostor(made.room, 'bob');
  for (let n = 1; n <= REQUESTS; n += 1) {
    fakeBob.raw.signal('alice', { kind: 'offer-request', data: {} });
    await until(() => kept(made.alice) >= n, `alice 의 ${n}번째 교체 확인 결과`, 5_000, 2);
  }
  fakeBob.raw.close();
  proxy.unblock('bob');

  // 링크가 그대로인지 프레임으로 본다.
  made.alice.command({ cmd: 'send', peer: 'bob', text: 'after requests' });
  made.bob.command({ cmd: 'send', peer: 'alice', text: 'after requests' });
  await Promise.all([
    made.bob.event((e) => e.t === 'frame' && e.text === 'after requests', { what: '요청 뒤의 프레임' }),
    made.alice.event((e) => e.t === 'frame' && e.text === 'after requests', { what: '요청 뒤의 프레임' }),
  ]);
  const replaced = made.both.map((peer) => peer.logs('link.replace_probe').filter((line) => line.outcome !== 'kept').length);
  const closed = made.both.map((peer) => peer.count((e) => e.t === 'link-closed'));
  const opens = made.both.map((peer) => peer.count((e) => e.t === 'link-open'));
  check(
    section,
    `살아 있는 링크에 새 요청을 ${REQUESTS * 2}회(offer ${REQUESTS}, offer-request ${REQUESTS}) 보내도 교체 0회 (A-RTC-3)`,
    kept(made.bob) === REQUESTS && kept(made.alice) === REQUESTS && replaced.every((count) => count === 0) && closed.every((count) => count === 0) && opens.every((count) => count === 1),
    `유지 ${kept(made.alice)}+${kept(made.bob)}회, 교체 ${replaced.join('+')}회, link-closed ${closed.join('+')}회`,
  );
  await leaveAll(made.both);
}

// ── [kill] ──────────────────────────────────────────────────────────────────
async function killSection() {
  const section = 'kill';
  for (const [victimName, survivorName, label] of [
    ['alice', 'bob', 'answer 쪽이 새 offer 를 받는다'],
    ['bob', 'alice', 'offer 쪽이 offer-request 를 받는다'],
  ]) {
    const made = await pair('alice', 'bob');
    const victim = made[victimName];
    const survivor = made[survivorName];
    await Promise.all([made.alice.linkOpen('bob'), made.bob.linkOpen('alice')]);
    const firstOpen = survivor.events.find((e) => e.t === 'link-open');
    await victim.kill();
    // 죽은 참가자의 링크는 생존 확인(15초)이 실패하기 전까지 열려 있다. 그 사이에 같은 이름의 새 프로세스가 들어온다.
    const mark = survivor.events.length;
    const reborn = await stack.peer({ room: made.room, name: victimName, mode: 'join' });
    const closed = await survivor.linkClosed(victimName, { from: mark, timeoutMs: 10_000 });
    const reopened = await survivor.linkOpen(victimName, { from: mark, timeoutMs: 10_000 });
    await reborn.linkOpen(survivorName);
    const probe = survivor.logs('link.replace_probe').at(-1) ?? {};
    check(
      section,
      `상대를 죽인 뒤의 요청은 2초 뒤 교체된다: ${label} (A-RTC-3)`,
      closed.reason === 'replaced' && probe.outcome === 'replaced' && probe.duration_ms >= REPLACE_PROBE_MS && probe.duration_ms < REPLACE_PROBE_MS + 500 && reopened.sid !== firstOpen.sid && survivor.count((e) => e.t === 'attempt-failed') === 0,
      `확인에 걸린 시간 ${probe.duration_ms}ms, 닫힌 사유 ${closed.reason}, 새 링크의 상대 sid 가 바뀜: ${reopened.sid !== firstOpen.sid}`,
    );
    survivor.command({ cmd: 'send', peer: victimName, text: 'to the new one' });
    await reborn.event((e) => e.t === 'frame' && e.text === 'to the new one', { what: '새 링크의 프레임' });
    await leaveAll([survivor, reborn]);
  }
}

// ── [replace] ───────────────────────────────────────────────────────────────
async function replaceSection() {
  const section = 'replace';
  // 가운데 참가자 하나와, 죽였다 다시 띄우는 참가자 여섯(이름이 작은 셋은 offer 쪽, 큰 셋은 answer 쪽). 방 정원 8 안이다.
  const names = ['aa', 'ab', 'ac', 'za', 'zb', 'zc'];
  const room = newRoomId();
  const hub = await stack.peer({ room, name: 'mm', mode: 'create', nodeArgs: ['--expose-gc'] });
  const current = new Map();
  // 여섯은 가운데 참가자에게만 접촉한다(서로는 잇지 않는다). 가운데 프로세스의 링크와 메모리만 본다.
  const spawnVictim = async (name) => {
    const victim = await stack.peer({ room, name, mode: 'join', flags: ['--no-auto-contact'] });
    victim.command({ cmd: 'contact', peer: 'mm' });
    return victim;
  };
  await Promise.all(
    names.map(async (name) => {
      current.set(name, await spawnVictim(name));
      await hub.linkOpen(name);
    }),
  );
  await delay(500);
  const baseline = await hub.status({ gc: true });

  const cycles = Math.ceil(REPLACEMENTS / names.length);
  let done = 0;
  const failures = [];
  for (let cycle = 0; cycle < cycles && failures.length === 0; cycle += 1) {
    await Promise.all(
      names.map(async (name) => {
        if (done >= REPLACEMENTS) return;
        done += 1;
        try {
          await current.get(name).kill();
          const mark = hub.events.length;
          const fresh = await spawnVictim(name);
          current.set(name, fresh);
          const closed = await hub.linkClosed(name, { from: mark, timeoutMs: 12_000 });
          if (closed.reason !== 'replaced') throw new Error(`닫힌 사유가 ${closed.reason} 다`);
          await hub.linkOpen(name, { from: mark, timeoutMs: 12_000 });
          await fresh.linkOpen('mm', { timeoutMs: 12_000 });
        } catch (error) {
          failures.push(`${cycle}회 ${name}: ${String(error.message).split('\n')[0]}`);
        }
      }),
    );
  }
  await delay(500);
  const final = await hub.status({ gc: true });
  const replacedCount = hub.logs('link.replace_probe').filter((line) => line.outcome === 'replaced').length;
  const growth = (final.rss - baseline.rss) / baseline.rss;
  const openLinks = final.links.filter((link) => link.state === 'open');
  const onePerPeer = openLinks.length === names.length && new Set(openLinks.map((link) => link.peer)).size === names.length && final.links.length === names.length;
  const hubFailed = hub.count((e) => e.t === 'attempt-failed');
  check(section, `교체 ${REPLACEMENTS}회 (A-RTC-3)`, failures.length === 0 && replacedCount === REPLACEMENTS, `교체 ${replacedCount}회${failures.length ? `. 실패: ${failures.slice(0, 3).join(' / ')}` : ''}`);
  check(section, '교체 뒤 피어마다 링크 1개', onePerPeer, `열린 링크 ${openLinks.length}개 / 피어 ${names.length}명, 진행 중인 시도 ${final.links.length - openLinks.length}개`);
  check(section, '크래시 0', hub.proc.exit === null && hub.proc.stderr().trim() === '' && hubFailed === 0, `가운데 프로세스가 살아 있고 stderr ${hub.proc.stderr().length}바이트, attempt-failed ${hubFailed}건`);
  check(
    section,
    'RSS 증가 20% 이하',
    growth <= 0.2,
    `${(baseline.rss / 1048576).toFixed(1)}MB → ${(final.rss / 1048576).toFixed(1)}MB (${(growth * 100).toFixed(1)}%). JS 힙 ${(baseline.heap / 1048576).toFixed(1)}MB → ${(final.heap / 1048576).toFixed(1)}MB`,
  );
  await leaveAll([hub, ...current.values()]);
}

// ── [netinfo] ───────────────────────────────────────────────────────────────
/** 127.0.0.1 에서 STUN Binding 요청에 delayMs 늦게 답하는 대역. 공개 STUN 의 증거가 아니다. */
async function startStunStub(delayMs) {
  const socket = dgram.createSocket('udp4');
  const cookie = [0x21, 0x12, 0xa4, 0x42];
  const timers = new Set();
  socket.on('message', (message, remote) => {
    if (message.length < 20 || message.readUInt16BE(0) !== 0x0001) return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0);
    response.writeUInt16BE(12, 2);
    message.copy(response, 4, 4, 20);
    response.writeUInt16BE(0x0020, 20);
    response.writeUInt16BE(8, 22);
    response.writeUInt8(0x01, 25);
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    remote.address.split('.').forEach((part, index) => response.writeUInt8(Number(part) ^ cookie[index], 28 + index));
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        socket.send(response, remote.port, remote.address);
      } catch {
        // 이미 닫았다.
      }
    }, delayMs);
    timers.add(timer);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        socket.close(() => resolve());
      }),
  };
}

async function netinfoRun(ice) {
  // holdOffer: (가)와 같은 주입. offer 를 붙들어 offer 쪽 후보가 먼저 도착하게 한다(bob 이 방을 만들고 alice 가 들어와 offer 를 보낸다).
  const held = ice.holdOffer ? proxy.addRule({ from: 'alice', to: 'bob', kind: 'offer', op: 'hold' }) : null;
  const before = signalCount('alice>bob:candidate');
  const first = ice.holdOffer || ice.round % 2 !== 0 ? 'bob' : 'alice';
  const made = await pair(first, first === 'alice' ? 'bob' : 'alice', { ice: ice.servers });
  if (held !== null) {
    await until(() => signalCount('alice>bob:candidate') > before && held.holding >= 1, '후보 묶음이 지나가고 offer 는 붙들린 상태');
    await delay(150);
    held.release();
    held.remove();
  }
  const opens = await Promise.all([made.alice.linkOpen('bob'), made.bob.linkOpen('alice')]);
  // 늘 alice, bob 의 순서로 돌려준다.
  const lags = [];
  for (const [peer, open] of [[made.alice, opens[0]], [made.bob, opens[1]]]) {
    try {
      const srflx = await peer.event((e) => e.t === 'srflx', { what: 'srflx_seen', timeoutMs: 3_000 + Math.max(0, open.at - Date.now()) });
      lags.push(srflx.at - open.at);
    } catch {
      lags.push(null);
    }
  }
  await leaveAll(made.both);
  return lags;
}

async function netinfoSection() {
  const section = 'netinfo';
  const perRun = [];
  for (let round = 0; round < NETINFO_RUNS; round += 1) perRun.push(await netinfoRun({ round, servers: STUN }));
  const all = perRun.flat();
  const seen = all.filter((lag) => lag !== null);
  const summary = `${NETINFO_RUNS}회 × 2 프로세스. link-open 기준 srflx 시각(ms, alice/bob): ${perRun.map((lags) => lags.map((lag) => (lag === null ? '없음' : lag)).join('/')).join(', ')}`;
  if (seen.length === 0) {
    note(section, `기본 STUN(${STUN})으로 link-open 뒤 3초 안에 srflx_seen 이 참이 된다`, '미실행', `공개 STUN 에 닿지 않았다. ${summary}`);
  } else {
    check(section, `기본 STUN(${STUN})으로 매회 link-open 뒤 3초 안에 srflx_seen 이 참이 된다`, seen.length === all.length && seen.every((lag) => lag <= 3_000), summary);
    const after = perRun.filter((lags) => lags.some((lag) => lag !== null && lag > 0)).length;
    note(
      section,
      'link-open 보다 늦게 srflx 후보가 나온 회가 1회 이상이다(링크가 열린 뒤의 후보를 세는 길을 지났다)',
      after >= 1 ? '통과' : '부분 검증',
      `${after}/${NETINFO_RUNS}회${after === 0 ? '. 공개 STUN 의 응답이 후보 묶음 대기(100ms)보다 빨라 srflx 가 항상 먼저 나왔다' : ''}`,
    );
  }

  // 보충: 공개 STUN 그대로, 후보가 offer 보다 먼저 도착하게 한다. answer 쪽(bob)은 offer 를 받자마자 대기 큐의 후보로 검사를
  // 시작하므로 링크가 자기 후보 묶음(100ms)보다 먼저 열린다. 그때 공개 STUN 의 응답이 아직 없으면 srflx 는 링크 뒤에 나온다.
  // 계획의 10회(주입 없음)를 대신하지 않는다. 판정은 따로 낸다.
  {
    const runs = [];
    for (let round = 0; round < NETINFO_HOLD_RUNS; round += 1) runs.push(await netinfoRun({ round, servers: STUN, holdOffer: true }));
    const flat = runs.flat();
    const afterRuns = runs.filter((lags) => lags.some((lag) => lag !== null && lag > 0)).length;
    if (flat.every((lag) => lag === null)) {
      note(section, `(보충, 공개 STUN, 후보 선도착 주입) 링크가 열린 뒤에 나온 srflx 를 센다`, '미실행', '공개 STUN 에 닿지 않았다');
    } else {
      check(
        section,
        `(보충, 공개 STUN, 후보 선도착 주입) 매회 link-open 뒤 3초 안에 srflx_seen 이 참이고, srflx 가 링크 뒤에 나온 회가 1회 이상이다`,
        flat.every((lag) => lag !== null && lag <= 3_000) && afterRuns >= 1,
        `${NETINFO_HOLD_RUNS}회 × 2 프로세스(alice=offer 쪽/bob=answer 쪽). link-open 기준 srflx 시각(ms): ${runs.map((lags) => lags.map((lag) => (lag === null ? '없음' : lag)).join('/')).join(', ')}. 링크 뒤에 나온 회 ${afterRuns}/${NETINFO_HOLD_RUNS}`,
      );
    }
  }

  // 보충: 답을 400ms 늦추는 로컬 STUN 대역으로 "링크가 열린 뒤에 나온 후보"를 확실히 만든다.
  const stub = await startStunStub(400);
  try {
    const lags = await netinfoRun({ round: 0, servers: `stun:127.0.0.1:${stub.port}` });
    check(
      section,
      '(보충, 로컬 STUN 대역) 링크가 열린 뒤에 나온 srflx 후보를 세어 srflx_seen 이 참이 된다',
      lags.every((lag) => lag !== null && lag > 0 && lag <= 3_000),
      `link-open 뒤 ${lags.join('/')}ms(alice/bob) 에 참이 됐다. 공개 STUN 에 닿는다는 증거는 아니다`,
    );
  } finally {
    await stub.close();
  }
}

// ── [size] ──────────────────────────────────────────────────────────────────
function sizeSection() {
  const stats = proxy.stats();
  const total = Object.values(stats.signals).reduce((sum, count) => sum + count, 0);
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address !== undefined && !address.internal);
  const v4 = addresses.filter((address) => address.family === 'IPv4').length;
  const v6 = addresses.filter((address) => address.family === 'IPv6').length;
  check(
    'size',
    '관찰한 가장 큰 signal 메시지가 16384바이트 이하다 (A-RTC-5)',
    total > 0 && stats.maxSignalBytes <= SIGNAL_MAX_MESSAGE_BYTES,
    `signal ${total}건 가운데 최대 ${stats.maxSignalBytes}바이트. 이 PC 의 외부 주소: IPv4 ${v4}개, IPv6 ${v6}개(인터페이스 ${Object.keys(os.networkInterfaces()).length}개)`,
  );
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const sections = {
  connect: connectSection,
  queue: queueSection,
  drop: dropSection,
  dup: dupSection,
  fail: failSection,
  live: liveSection,
  kill: killSection,
  replace: replaceSection,
  netinfo: netinfoSection,
};
const startedAt = Date.now();
let aborted = null;
try {
  for (const name of only) {
    const run = sections[name];
    if (run === undefined) {
      note(name, '모르는 절 이름이다', '실패', `쓸 수 있는 이름: ${Object.keys(sections).join(', ')}`);
      continue;
    }
    const sectionStart = Date.now();
    try {
      proxy.clearRules();
      await run();
    } catch (error) {
      note(name, '절을 끝까지 돌리지 못했다', '실패', String(error.message).split('\n').slice(0, 12).join(' | '));
    }
    process.stdout.write(`      [${name}] ${((Date.now() - sectionStart) / 1000).toFixed(1)}초\n`);
  }
  sizeSection();
} catch (error) {
  aborted = error;
}

try {
  if (aborted !== null) throw aborted;
  const closed = await stack.close();
  check('정리', '띄운 프로세스가 남지 않았다', true, '');
  check('정리', '서버가 종료 코드 0 으로 끝났고 stderr 가 비어 있다', closed.serverExit.code === 0 && closed.serverStderr.trim() === '', `코드 ${closed.serverExit.code}, stderr ${closed.serverStderr.length}바이트`);
} catch (error) {
  const killed = await stack.abort();
  note('정리', '띄운 프로세스가 남지 않았다', '실패', `${String(error.message).split('\n')[0]}${killed.length ? `. 지운 프로세스: ${killed.map((entry) => entry.name).join(', ')}` : ''}`);
}

const counts = { 통과: 0, 실패: 0, '부분 검증': 0, 미실행: 0 };
for (const result of results) counts[result.verdict] += 1;
process.stdout.write(`\nV-L11: 통과 ${counts['통과']}, 실패 ${counts['실패']}, 부분 검증 ${counts['부분 검증']}, 미실행 ${counts['미실행']} (${((Date.now() - startedAt) / 1000).toFixed(1)}초)\n`);
process.exitCode = counts['실패'] === 0 && results.length > 0 ? 0 : 1;
