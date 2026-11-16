#!/usr/bin/env node
// V-L13: 콘솔 관전 (verification-plan.md 3.2 의 "V-L13 관전 판정 기준", architecture.md 3.14·S16, protocol.md 4.6).
// 자체 호스팅 서버 + 조립한 MCP 프로세스 4개(tool 로 조종) + 관전 프로세스(node dist/entry/monitor.js --json, sh scripts/monitor.sh).
// 관전자가 방 전체 채팅·상태·중단을 보고, 대상 지정 채팅은 보지 못하고, 아무 것도 쓰지 않고, 시그널링이 끊겨도 계속 보고,
// Ctrl-C 뒤 남은 프로세스가 없는지 본다. 셸 진입점은 공백이 든 경로에 복사해 실행한다.
//
// 실행: node tests/e2e/scenarios/v-l13.mjs [--ice none]   (npm run test:e2e -- scenarios/v-l13)
// 자체 호스팅에서만 돈다(서버를 멈췄다 다시 띄운다). 공용 서버의 짧은 확인은 tests/e2e/public/v-p8-monitor.mjs 다.
// 출력에 방 ID 원문과 채팅 본문을 남기지 않는다(표지 문자열의 유무만 적는다).

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, distPath } from '../../support/proc.mjs';
import { createReport, delay, enterAll, finish, isPidAlive, newRoomId, readDiagLogs, scenarioOptions, startStack, until } from './harness.mjs';

const options = scenarioOptions();
const report = createReport(`V-L13 관전 (${options.server ?? '자체 호스팅'})`);
const SNAPSHOT_MS = 25_000;
const SEEN_MS = 5_000;
const EXIT_MS = 3_000;
let stack = null;

const tag = randomBytes(4).toString('hex');
/** 실행마다 다른 표지 문자열. 출력에는 번호만 적는다. */
const marker = (n) => `v13-${tag}-${n}`;
const MONITOR_ENV_CLEARED = Object.fromEntries(
  ['AGENT_CHAT_SERVER', 'AGENT_CHAT_NAME', 'AGENT_CHAT_CLIENT', 'AGENT_CHAT_ICE_SERVERS', 'AGENT_CHAT_CHANNEL', 'AGENT_CHAT_WAIT_MAX_SEC', 'AGENT_CHAT_LOG_LEVEL', 'NO_COLOR', 'AGENT_CHAT_NODE'].map((name) => [
    name,
    undefined,
  ]),
);

/** 관전 프로세스의 stdout 을 JSON 줄로 읽는다. 읽지 못한 줄은 { bad: 원문 길이 } 로 둔다. */
function jsonLines(proc) {
  return proc
    .stdout()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { bad: line.length };
      }
    });
}

function events(proc) {
  return jsonLines(proc).filter((line) => line.type === 'event');
}

function countIn(text, needle) {
  return text.split(needle).length - 1;
}

/** 이름을 담은 프로세스 줄(ps). 남은 프로세스 확인에 쓴다. */
function processLinesWith(name) {
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n')
      .filter((line) => line.includes(name) && !line.includes('ps -A'));
  } catch {
    return null;
  }
}

/** 그 폴더 아래의 transcript-*.jsonl 줄 전부. */
function transcriptLines(home) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^transcript-.*\.jsonl$/.test(entry.name)) {
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          if (line === '') continue;
          try {
            found.push(JSON.parse(line));
          } catch {
            // 쓰는 중인 줄이다.
          }
        }
      }
    }
  };
  walk(path.join(home, 'rooms'));
  return found;
}

async function fingerprintOf(agent) {
  const written = await agent.call('write_report');
  if (written.isError) return null;
  const match = /상태 지문:\s*`?([0-9a-f]{12})`?/.exec(readFileSync(written.json.path, 'utf8'));
  return match === null ? null : match[1];
}

/** 비교용 참가자 표시(이름, 역할, 상태, 표시). */
const shownOf = (status) => status.participants.map((row) => [row.name, row.role, row.status, row.shown_as]);

/** 관전 프로세스를 띄운다. args 는 조립 파일 인자. */
function spawnMonitor(name, args, home) {
  return stack.procs.spawnNode(distPath('entry', 'monitor.js'), args, {
    name: `monitor-${name}`,
    stdin: 'ignore',
    env: { ...MONITOR_ENV_CLEARED, HOME: path.join(stack.homeRoot, 'home'), AGENT_CHAT_HOME: home, ...(options.ice === undefined ? {} : { AGENT_CHAT_ICE_SERVERS: options.ice }) },
  });
}

/** 저장소의 scripts/monitor.sh 를 공백이 든 폴더에 복사하고 dist·node_modules·package.json 을 링크로 붙인다. */
function spacedCopy() {
  const root = path.join(stack.homeRoot, 'with space', "it's app");
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, 'scripts', 'monitor.sh'), path.join(root, 'scripts', 'monitor.sh'));
  for (const entry of ['dist', 'node_modules', 'package.json']) symlinkSync(path.join(REPO_ROOT, entry === 'dist' ? path.relative(REPO_ROOT, path.dirname(distPath('entry'))) : entry), path.join(root, entry));
  return root;
}

async function run() {
  if (options.server !== null) {
    report.skip('L13', '관전 전체', '자체 호스팅에서만 돈다(서버를 멈췄다 다시 띄운다). 공용 서버는 V-P8');
    return;
  }
  stack = await startStack({ label: 'v-l13', ...options });
  const server = stack.url;
  const room = newRoomId();
  const names = ['ann', 'ben', 'cat', 'dan'];
  const agents = [];
  for (const name of names) agents.push(await stack.agent(name));
  const [ann, ben, cat, dan] = agents;

  // ── 1. 넷이 들어가 서로 ready 로 본다 ──
  await enterAll(agents, room);
  for (const [agent, role] of [
    [ann, 'host'],
    [ben, 'actor'],
    [cat, 'verifier'],
    [dan, 'checker'],
  ]) {
    await agent.ok('set_status', { status: 'ready', role });
  }
  const allReady = await until(
    async () => {
      for (const agent of agents) {
        const status = await agent.status();
        if (status.participants.length !== 3 || !status.participants.every((row) => row.shown_as === 'ready')) return false;
      }
      return true;
    },
    '넷이 서로 ready',
    30_000,
    250,
  ).catch(() => false);
  report.check('L13-01', allReady === true, '넷 모두 서로를 shown_as: ready 로 본다');
  const before = new Map();
  for (const agent of agents) before.set(agent.name, await agent.status());

  // ── 2. 관전자 O (--json) ──
  const obs = `obs${randomBytes(3).toString('hex')}`;
  const obsHome = stack.home(obs);
  const startedAt = Date.now();
  const o = spawnMonitor(obs, ['--json', '--room', room, '--server', server, '--name', obs], obsHome);
  const snapshot = await until(() => jsonLines(o)[0], '첫 stdout 줄', SNAPSHOT_MS, 50).catch(() => null);
  const snapshotMs = Date.now() - startedAt;
  report.check(
    'L13-02',
    snapshot?.type === 'snapshot' &&
      snapshot.participants.map((row) => row.name).sort().join(',') === names.join(',') &&
      snapshot.participants.every((row) => row.shown_as === 'ready') &&
      snapshot.observers.length === 0 &&
      !o.stdout().includes(room),
    `${SNAPSHOT_MS / 1000}초 안에 첫 줄이 snapshot(참가자 넷, 모두 ready, 관전자 없음, 방 ID 없음)`,
    { ms: snapshotMs, type: snapshot?.type, participants: snapshot?.participants?.length },
  );

  // ── 3. 넷에게 관전자로 보인다. 준비 판정은 그대로다 ──
  const joinedSeen = await Promise.all(
    agents.map((agent) => agent.event((e) => e.kind === 'peer' && e.change === 'observer_joined' && e.from === obs, { timeoutMs: SEEN_MS, what: 'observer_joined' }).catch(() => null)),
  );
  await delay(300);
  const after = new Map();
  for (const agent of agents) after.set(agent.name, await agent.status());
  report.check(
    'L13-03a',
    joinedSeen.every((event) => event !== null) &&
      agents.every((agent) => agent.events.filter((e) => e.kind === 'peer' && e.change === 'observer_joined' && e.from === obs).length === 1),
    '넷 모두 peer / observer_joined 를 정확히 한 번 받았다',
  );
  report.check(
    'L13-03b',
    agents.every((agent) => {
      const status = after.get(agent.name);
      return status.observers.some((row) => row.name === obs && row.link === 'open') && !status.participants.some((row) => row.name === obs);
    }),
    '넷의 get_status.observers 에 O 가 link: open 으로 있고 participants 에 없다',
  );
  report.check(
    'L13-03c',
    agents.every((agent) => {
      const a = before.get(agent.name);
      const b = after.get(agent.name);
      return (
        JSON.stringify(shownOf(a)) === JSON.stringify(shownOf(b)) &&
        JSON.stringify(a.claims.waiting_for_you) === JSON.stringify(b.claims.waiting_for_you) &&
        JSON.stringify(a.warnings) === JSON.stringify(b.warnings)
      );
    }),
    '전과 후의 participants(이름·역할·상태·표시), waiting_for_you, warnings 가 같다',
  );
  report.check('L13-03d', typeof after.get('ann').room.monitor_command === 'string' && after.get('ann').room.monitor_command.includes('monitor.sh'), 'get_status.room.monitor_command 가 있다');

  // ── 4. 공유 상태의 변화가 관전 출력에 나온다 ──
  const seenWithin = async (id, match, what) => {
    const at = Date.now();
    const found = await until(() => events(o).find(match), what, SEEN_MS, 50).catch(() => null);
    report.check(id, found !== null && found !== undefined, `O 의 stdout 에 ${what} 가 ${SEEN_MS / 1000}초 안에`, { ms: Date.now() - at });
    return found;
  };
  const started = await ann.ok('start_test', { request: `request ${marker('req')}`, max_duration_min: 30, max_scenarios: 5 });
  await seenWithin('L13-04a', (e) => e.kind === 'test' && e.change === 'started' && e.data.test_id === started.test_id, 'test/started');
  await ben.event((e) => e.kind === 'test' && e.change === 'started', { what: '테스트 시작' });
  const scenario = await ben.ok('start_scenario', { title: 'hand raise', actor: 'cat', verifier: 'dan' });
  await seenWithin('L13-04b', (e) => e.kind === 'scenario' && e.change === 'started' && e.data.scenario_id === scenario.scenario_id, 'scenario/started');
  await cat.event((e) => e.kind === 'scenario' && e.data?.scenario_id === scenario.scenario_id, { what: '시나리오 사건' });
  const claim = await cat.ok('record_claim', { scenario_id: scenario.scenario_id, action: 'pressed', expected: 'icon', observed: 'icon shown', outcome: 'pass', steps: '1. press' });
  await seenWithin('L13-04c', (e) => e.kind === 'claim' && e.data.claim_id === claim.claim_id, 'claim');
  await dan.event((e) => e.kind === 'claim' && e.data?.claim_id === claim.claim_id, { what: '주장 사건' });
  await dan.ok('record_verification', { claim_id: claim.claim_id, result: 'confirmed', evidence: 'same on my screen' });
  await seenWithin('L13-04d', (e) => e.kind === 'verification' && e.data.claim_id === claim.claim_id && e.data.claim_status === 'confirmed', 'verification(confirmed)');
  await ben.ok('set_status', { status: 'working' });
  await seenWithin('L13-04e', (e) => e.kind === 'peer' && e.change === 'status' && e.from === 'ben' && e.data.status === 'working', 'peer/status(ben, working)');

  // ── 5. 방 전체 글은 보이고 대상 지정 글은 보이지 않는다 ──
  const m1 = await ann.ok('send_message', { text: `${marker(1)}\n두 번째 줄` });
  const m2 = await dan.ok('send_message', { text: marker(2) });
  const chatSeen = await until(
    () => {
      const chats = events(o).filter((e) => e.kind === 'chat');
      return chats.some((e) => e.text.startsWith(marker(1)) && e.from === 'ann' && e.to === 'room') && chats.some((e) => e.text === marker(2) && e.from === 'dan' && e.to === 'room');
    },
    'M1, M2',
    SEEN_MS,
    50,
  ).catch(() => false);
  await ben.ok('send_message', { text: marker(3), to: ['cat'] });
  await cat.ok('send_message', { text: marker(4), to: ['ann', 'dan'] });
  report.check(
    'L13-05a',
    chatSeen === true && events(o).filter((e) => e.kind === 'chat' && e.text.includes(marker(1))).length === 1 && events(o).filter((e) => e.kind === 'chat' && e.text === marker(2)).length === 1,
    'M1(두 줄)·M2 가 kind chat, to room, 맞는 from 으로 각 한 번',
  );
  report.check('L13-05b', m1.delivered.includes(obs) && m2.delivered.includes(obs), '보낸 쪽 결과의 delivered 에 O 가 있다', { m1: m1.delivered.length, m2: m2.delivered.length });
  const injected = await Promise.all([
    cat.event((e) => e.kind === 'chat' && e.text === marker(3), { what: 'M3' }).catch(() => null),
    ann.event((e) => e.kind === 'chat' && e.text === marker(4), { what: 'M4' }).catch(() => null),
    dan.event((e) => e.kind === 'chat' && e.text === marker(4), { what: 'M4' }).catch(() => null),
  ]);
  report.check('L13-05c', injected.every((event) => event !== null), '주입 확인: cat 이 M3, ann·dan 이 M4 를 받았다');

  // ── 6. 시그널링 서버가 멈춰도 계속 본다 ──
  const restarting = stack.restartServer({ downMs: 12_000 });
  const stoppedServer = await until(() => stack.server.proc.exit !== null, '서버가 멈춤', 10_000, 50).catch(() => false);
  const downAt = Date.now();
  await delay(2_000);
  await ann.ok('send_message', { text: marker(5) });
  const m5 = await until(() => events(o).find((e) => e.kind === 'chat' && e.text === marker(5)), 'M5', SEEN_MS, 50).catch(() => null);
  const serverDownDuringM5 = stack.server.proc.exit !== null;
  report.check(
    'L13-06a',
    stoppedServer === true && serverDownDuringM5 && m5 !== null && o.exit === null,
    '서버가 멈춘 동안 M5 가 O 의 stdout 에 나오고 O 가 살아 있다',
    { server_down_ms: Date.now() - downAt },
  );
  await restarting;
  const restartedAt = Date.now();
  const reRegistered = await until(() => stack.registered(obs), 'O 의 재등록', 60_000, 250).catch(() => false);
  const registeredMs = Date.now() - restartedAt;
  // 로그는 200ms 묶어 쓴다. 줄이 파일에 나올 때까지 잠깐 기다린다.
  const connectedLine = await until(
    () => readDiagLogs(obsHome).some((line) => line.event === 'signal.state' && line.state === 'connected' && Date.parse(line.ts) >= restartedAt - 1_000),
    'O 의 signal.state connected 로그',
    5_000,
    100,
  ).catch(() => false);
  report.check('L13-06b', reRegistered === true && connectedLine === true, '서버가 돌아온 뒤 60초 안에 O 가 재등록한다(서버 등록과 O 의 signal.state connected 로그)', { ms: registeredMs, log_connected: connectedLine });

  // ── 7. 중단 ──
  const stopReason = `stop ${marker('stop')}`;
  const stopped = await cat.ok('stop_test', { reason: stopReason });
  await seenWithin('L13-07a', (e) => e.kind === 'test' && e.change === 'stopped' && e.data.by === 'cat' && e.data.detail === stopReason, 'test/stopped(by cat, detail)');
  report.check('L13-07b', !stopped.sent_to.includes(obs) && !stopped.not_connected.includes(obs), 'stop_test 의 sent_to·not_connected 에 O 가 없다', stopped);

  // ── 8. 읽기 전용 ──
  const transcripts = agents.flatMap((agent) => transcriptLines(agent.home));
  const authored = transcripts.filter((line) => line.kind === 'state' && line.record?.author === obs).length;
  const chatFromObs = transcripts.filter((line) => line.kind === 'chat_in' && line.from === obs).length;
  const badFrames = agents.flatMap((agent) => agent.logs('p2p.bad_frame')).filter((line) => line.error_code === 'observer_chat' || line.error_code === 'observer_write').length;
  report.check('L13-08a', transcripts.length > 0 && authored === 0 && chatFromObs === 0 && badFrames === 0, 'O 가 쓴 state·chat 이 기록 파일에 0건, observer_* 잘못된 프레임 0건', {
    lines: transcripts.length,
    authored,
    chatFromObs,
    badFrames,
  });
  const fingerprints = await Promise.all(agents.map((agent) => fingerprintOf(agent)));
  report.check('L13-08b', fingerprints.every((value) => value !== null && value === fingerprints[0]), '넷의 상태 지문이 같다', fingerprints);

  // ── 9. Ctrl-C ──
  const oStop = await o.stop({ signal: 'SIGINT', timeoutMs: 6_000 });
  const lastLine = jsonLines(o).at(-1);
  report.check(
    'L13-09a',
    !oStop.forced && oStop.code === 0 && oStop.stopMs <= EXIT_MS && lastLine?.type === 'end' && lastLine.reason === 'interrupted',
    `SIGINT 뒤 ${EXIT_MS / 1000}초 안에 종료 코드 0, 마지막 줄 {type: end, reason: interrupted}`,
    { stop_ms: oStop.stopMs, code: oStop.code, forced: oStop.forced },
  );
  const leftSeen = await Promise.all(
    agents.map((agent) => agent.event((e) => e.kind === 'peer' && e.change === 'observer_left' && e.from === obs, { timeoutMs: 5_000, what: 'observer_left' }).catch(() => null)),
  );
  const afterLeave = [];
  for (const agent of agents) afterLeave.push(await agent.status());
  report.check(
    'L13-09b',
    leftSeen.every((event) => event?.data?.reason === 'bye_shutdown') && afterLeave.every((status) => status.observers.length === 0),
    '넷 모두 5초 안에 observer_left(bye_shutdown) 를 받고 observers 가 비었다',
    leftSeen.map((event) => event?.data?.reason ?? null),
  );
  report.check(
    'L13-09c',
    !isPidAlive(o.pid) && (processLinesWith(obs)?.length ?? -1) === 0,
    '남은 프로세스 0(O 의 pid 없음, 이름을 담은 프로세스 줄 0)',
  );
  report.check(
    'L13-09d',
    agents.every((agent, index) => JSON.stringify(shownOf(afterLeave[index]).map(([name, role]) => [name, role])) === JSON.stringify(shownOf(before.get(agent.name)).map(([name, role]) => [name, role]))),
    '넷의 participants(이름·역할)가 1번과 같다(관전자가 참가자로 남지 않았다)',
  );

  // ── 9-2. stdout 이 닫히면(파이프의 읽는 쪽이 끝남) bye 를 보내고 종료 코드 0 ──
  const obs5 = `obs${randomBytes(3).toString('hex')}`;
  const o5 = spawnMonitor(obs5, ['--json', room, server, '--name', obs5], stack.home(obs5));
  const o5Snapshot = await until(() => jsonLines(o5)[0]?.type === 'snapshot', 'O5 snapshot', SNAPSHOT_MS, 50).catch(() => false);
  await until(async () => (await ann.status()).observers.some((row) => row.name === obs5 && row.link === 'open'), 'ann 이 O5 를 봄', 10_000, 100).catch(() => false);
  o5.child.stdout.destroy();
  await ann.ok('send_message', { text: marker('pipe') });
  const o5Exit = await o5.waitForExit({ timeoutMs: 10_000 }).catch(async () => {
    await o5.stop({ signal: 'SIGKILL', timeoutMs: 2_000 });
    return null;
  });
  const o5Left = await ann.event((e) => e.kind === 'peer' && e.change === 'observer_left' && e.from === obs5, { timeoutMs: 5_000, what: 'O5 observer_left' }).catch(() => null);
  report.check(
    'L13-09e',
    o5Snapshot === true && o5Exit?.code === 0 && o5Left?.data?.reason === 'bye_shutdown' && !isPidAlive(o5.pid),
    'stdout 의 읽는 쪽이 닫히면(EPIPE) bye 를 보내고 종료 코드 0(130 이 아니다)',
    { code: o5Exit?.code ?? null, left: o5Left?.data?.reason ?? null },
  );

  // ── 10. 사람용 출력, 셸 진입점(공백이 든 경로) ──
  // 서버를 다시 띄운 뒤다. 넷이 재등록을 마친 뒤에 들어가야 O2 가 넷 모두와 링크를 연다(나중에 붙는 쪽은 그 전의 글을 못 본다).
  await until(() => names.every((name) => stack.registered(name)), '넷 모두 재등록', 60_000, 250).catch(() => false);
  const spaced = spacedCopy();
  const obs2 = `obs${randomBytes(3).toString('hex')}`;
  const obs2Home = stack.home(obs2);
  const o2 = stack.procs.spawn('sh', [path.join(spaced, 'scripts', 'monitor.sh'), room, server, '--name', obs2], {
    name: `monitor-sh-${obs2}`,
    stdin: 'ignore',
    env: { ...MONITOR_ENV_CLEARED, HOME: path.join(stack.homeRoot, 'home'), AGENT_CHAT_HOME: obs2Home, ...(options.ice === undefined ? {} : { AGENT_CHAT_ICE_SERVERS: options.ice }) },
  });
  const live = await until(() => o2.stdout().includes('여기부터 실시간'), 'O2 의 실시간 머리줄', SNAPSHOT_MS, 50).catch(() => false);
  await until(async () => (await ann.status()).observers.some((row) => row.name === obs2 && row.link === 'open'), 'ann 이 O2 를 봄', 10_000, 100).catch(() => false);
  const hostile = `${marker(6)} \u001b[31m빨강 \u202e뒤집기\n둘째 줄`;
  await ann.ok('send_message', { text: hostile });
  const m6 = await until(() => o2.stdout().includes(marker(6)), 'O2 의 M6', SEEN_MS, 50).catch(() => false);
  await delay(200);
  const shPid = o2.pid;
  const commandOf = (() => {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(shPid)], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  const o2Stop = await o2.stop({ signal: 'SIGINT', timeoutMs: 6_000 });
  const o2Out = o2.stdout();
  report.check(
    'L13-10a',
    live === true && m6 === true && countIn(o2Out, marker(6)) === 1 && /│ 둘째 줄/.test(o2Out),
    '사람용 출력: 요약 뒤 실시간 머리줄, M6 의 표지가 한 번, 둘째 줄은 │ 로 이어 쓴다',
    { live, m6, count: countIn(o2Out, marker(6)), continued: /│ 둘째 줄/.test(o2Out), stdout_lines: o2Out.split('\n').length, stderr: o2.stderr().split('\n').filter(Boolean).map((line) => line.slice(0, 60)) },
  );
  report.check(
    'L13-10b',
    !o2Out.includes('\u001b') && !o2Out.includes('\u202e') && o2Out.includes('\\u{1b}[31m') && !o2Out.includes(room),
    'stdout 전체에 ESC 바이트와 U+202E 가 0개(보이는 글자로 바뀜, 색 꺼짐), 방 ID 0번',
    { esc: o2Out.includes('\u001b'), rlo: o2Out.includes('\u202e'), visible: o2Out.includes('\\u{1b}[31m'), room: o2Out.includes(room) },
  );
  report.check(
    'L13-10c',
    !o2Stop.forced && o2Stop.code === 0 && o2Stop.stopMs <= EXIT_MS && !isPidAlive(shPid) && (processLinesWith(obs2)?.length ?? -1) === 0 && /node/.test(commandOf) && !/^sh /.test(commandOf),
    `sh 진입점(공백이 든 경로): exec 로 node 가 같은 pid 를 잇고, SIGINT 뒤 ${EXIT_MS / 1000}초 안에 종료 코드 0, sh·node 가 남지 않는다`,
    { stop_ms: o2Stop.stopMs, code: o2Stop.code, exec: /node/.test(commandOf) },
  );

  // 셸 진입점의 실패 경로(공백이 든 경로).
  const help = stack.procs.spawn('sh', [path.join(spaced, 'scripts', 'monitor.sh'), '-h'], { name: 'monitor-sh-help', stdin: 'ignore', env: MONITOR_ENV_CLEARED });
  const helpExit = await help.waitForExit({ timeoutMs: 10_000 });
  const noNode = stack.procs.spawn('sh', [path.join(spaced, 'scripts', 'monitor.sh'), room], {
    name: 'monitor-sh-nonode',
    stdin: 'ignore',
    env: { ...MONITOR_ENV_CLEARED, AGENT_CHAT_NODE: path.join(stack.homeRoot, 'no such node') },
  });
  const noNodeExit = await noNode.waitForExit({ timeoutMs: 10_000 });
  const oldNodePath = path.join(stack.homeRoot, 'with space', 'old node');
  writeFileSync(oldNodePath, '#!/bin/sh\nprintf 20.11.0\n');
  chmodSync(oldNodePath, 0o755);
  const oldNode = stack.procs.spawn('sh', [path.join(spaced, 'scripts', 'monitor.sh'), room], {
    name: 'monitor-sh-oldnode',
    stdin: 'ignore',
    env: { ...MONITOR_ENV_CLEARED, AGENT_CHAT_NODE: oldNodePath },
  });
  const oldNodeExit = await oldNode.waitForExit({ timeoutMs: 10_000 });
  const bare = path.join(stack.homeRoot, 'with space', 'no build');
  mkdirSync(path.join(bare, 'scripts'), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, 'scripts', 'monitor.sh'), path.join(bare, 'scripts', 'monitor.sh'));
  const noBuild = stack.procs.spawn('sh', [path.join(bare, 'scripts', 'monitor.sh'), room], { name: 'monitor-sh-nobuild', stdin: 'ignore', env: MONITOR_ENV_CLEARED });
  const noBuildExit = await noBuild.waitForExit({ timeoutMs: 10_000 });
  report.check(
    'L13-10d',
    helpExit.code === 0 &&
      /사용법: agent-chat monitor/.test(help.stdout()) &&
      noNodeExit.code === 2 &&
      /Node\.js 22 이상이 필요하다/.test(noNode.stderr()) &&
      oldNodeExit.code === 2 &&
      /20\.11\.0/.test(oldNode.stderr()) &&
      noBuildExit.code === 2 &&
      /빌드 결과가 없다/.test(noBuild.stderr()) &&
      ![noNode, oldNode, noBuild].some((proc) => `${proc.stdout()}${proc.stderr()}`.includes(room)),
    'sh 진입점(공백이 든 경로): -h 는 0, Node 없음·22 미만·빌드 없음은 안내와 종료 코드 2(방 ID 를 찍지 않는다)',
    { help: helpExit.code, noNode: noNodeExit.code, oldNode: oldNodeExit.code, noBuild: noBuildExit.code },
  );

  // ── 11. 없는 방, 찬 방 ──
  const obs3 = `obs${randomBytes(3).toString('hex')}`;
  const o3 = spawnMonitor(obs3, ['--json', newRoomId(), server, '--name', obs3], stack.home(obs3));
  const o3Exit = await o3.waitForExit({ timeoutMs: 10_000 }).catch(() => null);
  const o3Error = jsonLines(o3).find((line) => line.type === 'error');
  report.check(
    'L13-11a',
    o3Exit?.code === 1 && o3Error?.details?.server_code === 'ROOM_NOT_FOUND' && /방이 없다/.test(o3.stderr()) && !isPidAlive(o3.pid) && stack.registered(obs3) === false,
    '아무도 없는 방: 10초 안에 종료 코드 1, error(ROOM_NOT_FOUND), 남은 프로세스·서버 등록 없음',
    { code: o3Exit?.code, server_code: o3Error?.details?.server_code },
  );
  const extra = [];
  for (const name of ['eve', 'fay', 'gus', 'hal']) {
    const agent = await stack.agent(name);
    await agent.ok('join_room', { room_id: room });
    extra.push(agent);
  }
  // 서버를 다시 띄운 뒤라 처음 넷이 재등록을 마쳐야 서버가 보는 인원이 8이다.
  const full = await until(() => [...names, 'eve', 'fay', 'gus', 'hal'].every((name) => stack.registered(name)), '8명 모두 서버에 등록', 60_000, 250).catch(() => false);
  const obs4 = `obs${randomBytes(3).toString('hex')}`;
  const o4 = spawnMonitor(obs4, ['--json', room, server, '--name', obs4], stack.home(obs4));
  const o4Exit = await o4.waitForExit({ timeoutMs: 10_000 }).catch(async () => {
    await o4.stop({ signal: 'SIGINT', timeoutMs: 5_000 });
    return null;
  });
  const o4Error = jsonLines(o4).find((line) => line.type === 'error');
  report.check(
    'L13-11b',
    o4Exit?.code === 1 && o4Error?.details?.server_code === 'ROOM_FULL' && /정원/.test(o4.stderr()) && !isPidAlive(o4.pid) && stack.registered(obs4) === false,
    '정원이 찬 방(MCP 8개): 종료 코드 1, error(ROOM_FULL), 남은 프로세스·서버 등록 없음',
    { full, code: o4Exit?.code, server_code: o4Error?.details?.server_code },
  );

  // ── 12. 로그 규칙과 끝까지의 셈 ──
  const markers = [1, 2, 3, 4, 5, 6].map(marker);
  const logText = [obsHome, obs2Home].map((home) => JSON.stringify(readDiagLogs(home))).join('\n');
  const monitorLines = [...readDiagLogs(obsHome), ...readDiagLogs(obs2Home)];
  const stderrText = `${o.stderr()}\n${o2.stderr()}`;
  report.check(
    'L13-12a',
    monitorLines.length > 0 && monitorLines.every((line) => line.svc === 'monitor') && markers.every((m) => !logText.includes(m)) && !logText.includes(room) && !logText.includes(marker('stop')),
    'O·O2 의 진단 로그(svc monitor)에 표지 문자열과 방 ID 원문이 0건',
    { lines: monitorLines.length },
  );
  report.check('L13-12b', stderrText.split('\n').filter((line) => line.trim().startsWith('{')).length === 0, 'O·O2 의 stderr 에 JSON 로그 줄이 0건(stderrCopy: false)');
  const everything = `${o.stdout()}${o.stderr()}${o2.stdout()}${o2.stderr()}`;
  report.check('L13-05d', countIn(everything, marker(3)) === 0 && countIn(everything, marker(4)) === 0, '대상 지정 글 M3·M4 는 O·O2 의 stdout·stderr 어디에도 0번(한계 확인)');
  for (const agent of extra) await agent.close();
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
