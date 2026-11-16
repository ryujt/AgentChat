#!/usr/bin/env node
// V-L7(나): 조립한 실제 MCP 프로세스(dist/entry/mcp.js)에 MCP SDK 클라이언트로 stdio 를 붙인다 (verification-plan.md 3.2, S4·S9·S13).
// 방 기능은 실물이다(자체 호스팅 서버, 실제 WebRTC). 상대 참가자도 조립한 MCP 프로세스다.
// 확인: capability 와 instructions, 확인 전 채널 미전송, 점검 → confirm_channel → 채널 전달, 확인 호출이 없으면 poll 로 돌아옴(120초),
//       wait_for_messages 취소·응답 유실 뒤 사건이 유실되지 않음, 결과 상한, 잘못된 환경 변수로도 뜨고 notice.config 가 옴,
//       종료 400ms 이하(신호 세 가지, stdin 닫힘, 호스트의 종료 순서, 서버가 멈춰 예산을 넘기는 경로), 부모 SIGKILL 뒤 고아 없음, stdout 의 깨끗함.
//
// 실행: node tests/e2e/scenarios/v-l7.mjs [--server <주소>] [--ice none] [--repeat <종료 측정 반복 수, 기본 5>]
//   poll 복귀 확인 때문에 3분쯤 걸린다(제품의 CHANNEL_SEEN_GRACE_MS 120초를 그대로 기다린다).
//   서버가 멈추는 경로는 자체 호스팅에서만 본다.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createProcTracker, distUrl, isPidAlive } from '../../support/proc.mjs';
import { argValue, createReport, delay, errorSummary, finish, newRoomId, readDiagLogs, scenarioOptions, startStack, until } from './harness.mjs';

const { INSTRUCTIONS, TOOL_NAMES, DEFAULT_MCP_SERVER_LIMITS } = await import(distUrl('mcp-server/index.js'));
const { CHANNEL_CHECK_FILE_NAME, parseChannelCheck } = await import(distUrl('protocol/index.js'));
const { DEFAULT_INBOX_LIMITS } = await import(distUrl('inbox/index.js'));

const options = scenarioOptions();
const REPEAT = Number(argValue(options.rest, 'repeat', '5'));
const BUDGET_MS = DEFAULT_MCP_SERVER_LIMITS.SHUTDOWN_BUDGET_MS;
const GRACE_MS = DEFAULT_INBOX_LIMITS.CHANNEL_SEEN_GRACE_MS;
const HOST_PROC = path.join(path.dirname(new URL(import.meta.url).pathname), 'host-proc.mjs');
const report = createReport(`V-L7(나) (${options.server ?? '자체 호스팅'})`);
let stack = null;

const texts = (events) => events.filter((event) => event.kind === 'chat').map((event) => event.text);

async function capability() {
  const cap = await stack.agent('cap-a');
  const capabilities = cap.client.getServerCapabilities();
  const { tools } = await cap.client.listTools();
  const version = cap.client.getServerVersion();
  const packageVersion = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  report.check(
    'L7-01',
    JSON.stringify(capabilities.experimental) === JSON.stringify({ 'claude/channel': {} }) &&
      capabilities.tools !== undefined &&
      !JSON.stringify(capabilities).includes('permission'),
    'capability: tools 와 claude/channel. permission relay 는 없다',
    capabilities,
  );
  report.check('L7-02', cap.client.getInstructions() === INSTRUCTIONS, 'instructions 가 제품 문구 그대로다');
  report.check(
    'L7-03',
    tools.length === 15 && JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify([...TOOL_NAMES].sort()),
    'tool 15개',
    tools.length,
  );
  report.check('L7-04', version.name === 'agent-chat' && version.version === packageVersion, '서버 정보: agent-chat, package.json 의 버전', version);

  const off = await stack.agent('cap-b', { env: { AGENT_CHAT_CHANNEL: 'off' } });
  const offTools = (await off.client.listTools()).tools;
  report.check(
    'L7-05',
    off.client.getServerCapabilities().experimental === undefined && offTools.length === 14 && !offTools.some((tool) => tool.name === 'confirm_channel'),
    'AGENT_CHAT_CHANNEL=off: experimental 없음, confirm_channel 없음(14개)',
  );
  await cap.close();
  await off.close();
}

/** 채널 확인과 poll 복귀. 복귀 확인은 120초를 기다리므로 Promise 로 돌려준다(그동안 다른 확인을 한다). */
async function channel() {
  const room = newRoomId();
  const annaLaunchedAt = Date.now();
  const anna = await stack.agent('anna');
  const bert = await stack.agent('bert', { env: { AGENT_CHAT_CHANNEL: 'off' } });
  await anna.ok('create_room', { room_id: room });
  await until(() => anna.channel.some((item) => item.meta?.kind === 'probe'), '점검 알림', 5_000);
  const probe = anna.channel.find((item) => item.meta?.kind === 'probe');
  report.check(
    'L7-06',
    /^[0-9a-z]{16}$/.test(probe.meta.token) && probe.content === 'Agent Chat channel check. Call the confirm_channel tool with this token.',
    'create_room 뒤 점검 알림(토큰 16자)',
  );
  await bert.ok('join_room', { room_id: room });
  bert.pump();
  for (const text of ['before confirm 1', 'before confirm 2']) await bert.ok('send_message', { text });
  await delay(300);
  report.check('L7-07', anna.channel.length === 1, '확인 전에는 채팅이 채널로 나가지 않는다(채널로 간 것은 점검 알림 하나)', anna.channel.map((item) => item.meta?.kind));
  const polled = await anna.ok('wait_for_messages', { timeout_sec: 5 });
  report.check(
    'L7-08',
    JSON.stringify(texts(polled.events)) === JSON.stringify(['before confirm 1', 'before confirm 2']),
    '확인 전의 글은 poll(wait_for_messages)로 받는다',
    polled.events.map((event) => `${event.kind}/${event.change ?? ''}`),
  );
  // 검토 2차 PRODUCT-R2-01: 제품 진입점은 cursor 를 프로세스 시작 시각(ms) 다음부터 센다. 다시 뜬 프로세스의 cursor 가 앞의 것과 겹치지 않는다.
  const firstCursor = Number(polled.events[0]?.cursor);
  report.check(
    'L7-35',
    /^[0-9]{13}$/.test(polled.events[0]?.cursor ?? '') && firstCursor > annaLaunchedAt && firstCursor <= Date.now() + 1_000,
    'cursor 는 프로세스 시작 시각(ms) 다음부터 센다(13자리)',
    { first_cursor: polled.events[0]?.cursor, launched_at: annaLaunchedAt },
  );

  const wrong = await anna.call('confirm_channel', { token: '0000000000000000' });
  report.check('L7-09', wrong.isError && wrong.json?.error?.code === 'INVALID_ARGUMENT', '틀린 토큰은 INVALID_ARGUMENT');
  await bert.ok('send_message', { text: 'pending before confirm' });
  const confirmed = await anna.ok('confirm_channel', { token: probe.meta.token });
  report.check(
    'L7-10',
    confirmed.delivery_mode === 'channel' && JSON.stringify(texts(confirmed.events)) === JSON.stringify(['pending before confirm']),
    'confirm_channel: channel 모드, 밀린 사건을 결과로 준다',
  );
  const channelBefore = anna.channel.length;
  const viaChannel = await bert.ok('send_message', { text: 'via channel' });
  const pushed = await until(() => anna.channel.slice(channelBefore).find((item) => item.meta?.kind === 'chat'), '채널 알림', 5_000).catch(() => null);
  report.check(
    'L7-11',
    pushed !== null && pushed.content === 'via channel' && pushed.meta.from === 'bert' && pushed.meta.msg_id === viaChannel.message_id,
    '확인 뒤의 채팅은 채널 알림으로 온다(from, msg_id)',
  );
  const startedAt = Date.now();
  const noWait = await anna.ok('wait_for_messages');
  report.check(
    'L7-12',
    noWait.status === 'channel_mode' && Date.now() - startedAt < 1_000 && noWait.notice?.pushed_since_last_call?.count >= 1,
    'channel 모드의 wait_for_messages 는 기다리지 않고, notice.pushed_since_last_call 이 붙는다',
    { ms: Date.now() - startedAt, notice: noWait.notice },
  );
  const acked = await anna.ok('wait_for_messages', { cursor: pushed?.meta.cursor ?? '0' });
  report.check('L7-13', acked.status === 'channel_mode', 'cursor 로 확인하면 channel_mode');
  const checkFile = path.join(anna.home, CHANNEL_CHECK_FILE_NAME);
  const check = existsSync(checkFile) ? parseChannelCheck(readFileSync(checkFile, 'utf8')) : { ok: false };
  report.check(
    'L7-14',
    check.ok && check.value.host === 'w9-e2e-host' && check.value.host_version === '9.9.9' && check.value.fallback_at === null,
    'channel-check.json: 호스트 이름·버전, 확인 시각',
  );

  // 확인 호출 없이 120초가 지나면 다음 tool 호출에서 poll 로 돌아온다. 놓친 사건부터 다시 준다.
  const lostCursor = acked.next_cursor;
  const unseen = await bert.ok('send_message', { text: 'never acknowledged' });
  const unseenAt = Date.now();
  return (async () => {
    await delay(Math.max(0, unseenAt + GRACE_MS + 2_000 - Date.now()));
    const status = await anna.call('get_status');
    const delivery = status.json?.notice?.delivery;
    report.check(
      'L7-15',
      delivery?.mode === 'poll' && typeof delivery.after_cursor === 'string',
      `확인 없이 ${GRACE_MS / 1000}초 뒤 다음 tool 호출에 poll 로 돌아온다(notice.delivery)`,
      delivery,
    );
    const again = await anna.ok('wait_for_messages', { cursor: delivery?.after_cursor ?? lostCursor, timeout_sec: 5 });
    report.check(
      'L7-16',
      again.events.some((event) => event.id === unseen.message_id) && (await anna.status()).delivery_mode === 'poll',
      '돌아온 뒤 확인 안 된 사건을 poll 로 다시 받는다. 모드는 poll',
    );
    const newProbe = anna.channel.filter((item) => item.meta?.kind === 'probe');
    report.check('L7-17', newProbe.length === 2 && newProbe[1].meta.token !== probe.meta.token, '새 점검 알림(다른 토큰)이 온다');
    const stale = await anna.call('confirm_channel', { token: probe.meta.token });
    report.check('L7-18', stale.isError && stale.json?.error?.code === 'INVALID_ARGUMENT', '앞 토큰은 버려졌다');
    const after = parseChannelCheck(readFileSync(checkFile, 'utf8'));
    report.check('L7-19', after.ok && after.value.fallback_at !== null, 'channel-check.json 에 되돌아간 시각이 적힌다');
    report.note(`poll 복귀까지: 마지막 채널 사건 뒤 ${Date.now() - unseenAt}ms 에 확인`);
    await bert.stopPump();
    await anna.ok('leave_room');
    await bert.ok('leave_room');
    await anna.close();
    await bert.close();
  })();
}

async function cancelAndLimits() {
  const room = newRoomId();
  const cara = await stack.agent('cara');
  const dave = await stack.agent('dave');
  await cara.ok('create_room', { room_id: room });
  await dave.ok('join_room', { room_id: room });
  // 입장 사건을 비운다.
  const first = await cara.ok('wait_for_messages', { timeout_sec: 2 });
  const cursor = first.next_cursor;

  // (1) 호스트가 wait 을 취소한다.
  const controller = new AbortController();
  const pending = cara.call('wait_for_messages', { cursor, timeout_sec: 8 }, { signal: controller.signal }).then(
    () => 'resolved',
    () => 'rejected',
  );
  await delay(300);
  controller.abort();
  const cancelled = await pending;
  await dave.ok('send_message', { text: 'after cancel' });
  const got1 = await cara.ok('wait_for_messages', { timeout_sec: 5 });
  report.check(
    'L7-20',
    cancelled === 'rejected' && JSON.stringify(texts(got1.events)) === JSON.stringify(['after cancel']),
    'wait_for_messages 를 취소한 뒤 온 사건을 cursor 없는 다음 호출이 받는다(유실 없음)',
  );

  // (2) 호스트의 요청 기한이 먼저 끝난다. 사건은 그 뒤에 온다.
  const timedOut = await cara.call('wait_for_messages', { timeout_sec: 5 }, { timeoutMs: 300 }).then(
    () => 'resolved',
    () => 'timeout',
  );
  await dave.ok('send_message', { text: 'after host timeout' });
  const got2 = await cara.ok('wait_for_messages', { timeout_sec: 5 });
  report.check(
    'L7-21',
    timedOut === 'timeout' && JSON.stringify(texts(got2.events)) === JSON.stringify(['after host timeout']),
    '호스트의 요청 기한이 먼저 끝나도 사건이 유실되지 않는다',
  );

  // (3) 응답을 잃은 에이전트가 이전 cursor 로 다시 부르면 같은 사건을 다시 받는다.
  const previous = got1.next_cursor;
  const replay = await cara.ok('wait_for_messages', { cursor: previous, timeout_sec: 2 });
  report.check(
    'L7-22',
    replay.events.some((event) => event.id === got2.events[0]?.id),
    '이전 next_cursor 로 다시 부르면 이미 준 사건을 다시 준다',
  );

  // (4) 결과 상한: 20건, 넘으면 more.
  for (let i = 0; i < 25; i += 1) await dave.ok('send_message', { text: `bulk ${String(i).padStart(2, '0')}` });
  await delay(300);
  const page1 = await cara.ok('wait_for_messages', { timeout_sec: 2 });
  const page2 = await cara.ok('wait_for_messages', { cursor: page1.next_cursor, timeout_sec: 2 });
  report.check(
    'L7-23',
    page1.events.length === 20 && page1.more === true && page2.events.length === 5 && page2.more === false,
    '결과 상한: 한 번에 20건, 남으면 more=true, 이어 받으면 나머지 5건',
    { page1: page1.events.length, more1: page1.more, page2: page2.events.length },
  );
  // 큰 글: 사건 JSON 의 합이 24000바이트를 넘지 않는다.
  const big = 'x'.repeat(9_000);
  for (let i = 0; i < 4; i += 1) await dave.ok('send_message', { text: `${i}${big}` });
  await delay(300);
  const bigPage = await cara.ok('wait_for_messages', { cursor: page2.next_cursor, timeout_sec: 2 });
  const eventBytes = bigPage.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
  report.check(
    'L7-24',
    bigPage.events.length === 2 && bigPage.more === true && eventBytes <= DEFAULT_INBOX_LIMITS.WAIT_MAX_RESULT_BYTES,
    '결과 상한: 사건 JSON 의 합이 24000바이트를 넘지 않는다',
    { events: bigPage.events.length, bytes: eventBytes },
  );
  await cara.ok('leave_room');
  await dave.ok('leave_room');
  await cara.close();
  await dave.close();
}

async function badEnv() {
  const room = newRoomId();
  const erin = await stack.agent('erin', {
    env: {
      AGENT_CHAT_NAME: 'Bad Name!',
      AGENT_CHAT_CLIENT: 'bad client',
      AGENT_CHAT_CHANNEL: 'maybe',
      AGENT_CHAT_WAIT_MAX_SEC: 'soon',
      AGENT_CHAT_LOG_LEVEL: 'loud',
    },
  });
  const created = await erin.call('create_room', { room_id: room });
  const names = (created.json?.notice?.config ?? []).map((entry) => entry.name).sort();
  report.check(
    'L7-25',
    !created.isError &&
      /^agent-[0-9a-z]{6}$/.test(created.json.name) &&
      JSON.stringify(names) ===
        JSON.stringify(['AGENT_CHAT_CHANNEL', 'AGENT_CHAT_CLIENT', 'AGENT_CHAT_LOG_LEVEL', 'AGENT_CHAT_NAME', 'AGENT_CHAT_WAIT_MAX_SEC']),
    '잘못된 환경 변수 다섯: 프로세스가 뜨고 기본값으로 동작하며 notice.config 가 이름과 이유를 준다',
    { name: created.json?.name, names },
  );
  const status = await erin.ok('get_status');
  report.check('L7-26', status.warnings.filter((warning) => warning.code === 'config').length === 5, 'get_status.warnings 에 무시한 설정 다섯');
  await erin.ok('leave_room');
  await erin.close();

  const fred = await stack.agent('fred', { env: { AGENT_CHAT_SERVER: 'ftp://nowhere' } });
  const noServer = await fred.call('create_room', { room_id: newRoomId() });
  const withServer = stack.url === null ? null : await fred.call('create_room', { room_id: newRoomId(), server: stack.url });
  report.check(
    'L7-27',
    noServer.isError && noServer.json?.error?.code === 'INVALID_ARGUMENT' && (withServer === null || !withServer.isError),
    '잘못된 AGENT_CHAT_SERVER: server 인자 없이 부르면 INVALID_ARGUMENT, 인자를 주면 무시된다(공용 서버로 바꿔 접속하지 않는다)',
    { noServer: errorSummary(noServer), withServer: withServer === null ? '미실행' : errorSummary(withServer) },
  );
  if (withServer !== null && !withServer.isError) await fred.ok('leave_room');
  await fred.close();

  const gina = await stack.agent('gina', { home: '/dev/null/agent-chat-home' });
  const ginaRoom = await gina.call('create_room', { room_id: newRoomId() });
  report.check(
    'L7-28',
    !ginaRoom.isError && ginaRoom.json.notice?.record_failed === true && gina.alive(),
    '쓸 수 없는 AGENT_CHAT_HOME: 프로세스가 뜨고 방에 들어가며 notice.record_failed 로 알린다',
    { result: errorSummary(ginaRoom), notice: ginaRoom.json?.notice },
  );
  if (!ginaRoom.isError) await gina.ok('leave_room');
  await gina.close();
}

/** 방 하나를 두 참가자로 만들어 둔다. 여기에 측정 대상을 넣고 끝낸다. */
async function shutdownTimings() {
  const room = newRoomId();
  const peers = [await stack.agent('hana'), await stack.agent('ivan')];
  await peers[0].ok('create_room', { room_id: room });
  peers[0].pump();
  await peers[1].ok('join_room', { room_id: room });
  peers[1].pump();

  const methods = ['SIGTERM', 'SIGINT', 'SIGHUP', 'stdin', 'host-sequence'];
  const measured = [];
  let serial = 0;
  async function victim() {
    serial += 1;
    const agent = await stack.agent('vic', { label: `vic-${serial}` });
    await agent.ok('join_room', { room_id: room });
    agent.pump();
    // 대기가 걸려 있게 한다.
    await delay(200);
    return agent;
  }
  async function byeSeen(name, sinceMs) {
    // 상대의 진단 로그에 bye 로 닫힌 링크가 남는다.
    return until(
      () => peers.every((peer) => peer.logs('link.closed').some((line) => line.peer === name && line.reason === 'bye_shutdown' && Date.parse(line.ts) >= sinceMs - 5)),
      'bye 수신',
      3_000,
      50,
    ).then(
      () => true,
      () => false,
    );
  }

  for (const method of methods) {
    for (let i = 0; i < REPEAT; i += 1) {
      const agent = await victim();
      const sentAt = Date.now();
      let result;
      if (method === 'stdin') {
        const closed = await agent.close();
        result = { code: closed.exit.code, stopMs: closed.ms };
      } else if (method === 'host-sequence') {
        // Claude Code: SIGINT → 100ms → SIGTERM → 400ms → SIGKILL.
        await agent.stopPump();
        const t0 = Date.now();
        agent.proc.kill('SIGINT');
        const term = setTimeout(() => agent.proc.kill('SIGTERM'), 100);
        const kill = setTimeout(() => agent.proc.kill('SIGKILL'), 500);
        const exit = await agent.proc.waitForExit({ timeoutMs: 3_000 });
        clearTimeout(term);
        clearTimeout(kill);
        // waitForExit 는 프로세스가 죽은 순간에 풀린다. 그때까지의 시간을 잰다.
        result = { code: exit.code, signal: exit.signal, stopMs: Date.now() - t0 };
      } else {
        const stopped = await agent.stop(method);
        result = { code: stopped.code, signal: stopped.signal, stopMs: stopped.stopMs, forced: stopped.forced };
      }
      const bye = await byeSeen('vic', sentAt);
      const shutdownLine = agent.logs('shutdown').at(-1);
      measured.push({ method, ...result, bye, cause: shutdownLine?.cause, forcedBudget: shutdownLine?.forced, duration_ms: shutdownLine?.duration_ms });
      // 다음 측정 전에 상대가 vic 을 left 로 정리할 시간을 준다.
      await delay(300);
    }
  }
  for (const method of methods) {
    const rows = measured.filter((row) => row.method === method);
    const max = Math.max(...rows.map((row) => row.stopMs));
    report.check(
      `L7-30-${method}`,
      rows.every((row) => row.code === 0 && row.stopMs <= BUDGET_MS && row.bye),
      `${method}: 방에 링크 2개·대기가 걸린 채로 ${REPEAT}회, 모두 ${BUDGET_MS}ms 안에 종료 코드 0, 상대가 bye 를 받음`,
      { ms: rows.map((row) => row.stopMs), max, causes: [...new Set(rows.map((row) => row.cause))], forced: rows.map((row) => row.forcedBudget) },
    );
  }

  // 서버가 멈춰 leave 의 닫는 악수가 끝나지 않는다. 세션 정리가 예산을 넘는 경로다.
  if (stack.selfHosted) {
    const forcedRows = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const agent = await victim();
      stack.pauseServer();
      let stopped;
      const sentAt = Date.now();
      try {
        stopped = await agent.stop('SIGTERM');
      } finally {
        stack.resumeServer();
      }
      const bye = await byeSeen('vic', sentAt);
      const line = agent.logs('shutdown').at(-1);
      forcedRows.push({ code: stopped.code, stopMs: stopped.stopMs, bye, forced: line?.forced, duration_ms: line?.duration_ms });
      await delay(300);
    }
    report.check(
      'L7-31',
      forcedRows.every((row) => row.code === 0 && row.stopMs <= BUDGET_MS),
      `서버가 멈춘 채 SIGTERM(세션 정리가 예산을 넘는 경로) ${REPEAT}회: 모두 ${BUDGET_MS}ms 안에 종료 코드 0`,
      { ms: forcedRows.map((row) => row.stopMs), forced: forcedRows.map((row) => row.forced), closed_ms: forcedRows.map((row) => row.duration_ms), bye: forcedRows.map((row) => row.bye) },
    );
  } else {
    report.skip('L7-31', '서버가 멈춘 경로의 종료 시간', '공용 서버는 멈출 수 없다');
  }

  for (const peer of peers) {
    await peer.stopPump();
    await peer.ok('leave_room');
    await peer.close();
  }
  return measured;
}

async function orphan() {
  const room = newRoomId();
  const peer = await stack.agent('jack');
  await peer.ok('create_room', { room_id: room });
  peer.pump();
  const tracker = createProcTracker({ label: 'v-l7-host' });
  try {
    const env = {
      HOME: path.join(stack.homeRoot, 'home'),
      AGENT_CHAT_HOME: stack.home('kate'),
      AGENT_CHAT_NAME: 'kate',
      AGENT_CHAT_CLIENT: 'e2e',
      AGENT_CHAT_LOG_LEVEL: 'debug',
      ...(stack.url === null ? { AGENT_CHAT_SERVER: undefined } : { AGENT_CHAT_SERVER: stack.url }),
      ...(options.ice === undefined ? { AGENT_CHAT_ICE_SERVERS: undefined } : { AGENT_CHAT_ICE_SERVERS: options.ice }),
    };
    const host = tracker.spawnNode(HOST_PROC, ['join', room], { name: 'host-proc', env });
    const ready = await host.waitForOutput(/SERVER_PID (\d+)/, { timeoutMs: 60_000 });
    const serverPid = Number(ready[1]);
    tracker.trackPid(serverPid, 'mcp-kate');
    const linked = await until(async () => (await peer.participant('kate'))?.link === 'open', 'jack–kate 링크', 10_000).catch(() => false);
    host.kill('SIGKILL');
    await host.waitForExit({ timeoutMs: 3_000 });
    const killedAt = Date.now();
    const gone = await until(() => !isPidAlive(serverPid), 'MCP 프로세스 종료', 3_000, 2).then(
      () => Date.now() - killedAt,
      () => null,
    );
    const shutdownLine = readDiagLogs(stack.home('kate')).filter((line) => line.event === 'shutdown').at(-1);
    report.check(
      'L7-32',
      linked === true && gone !== null && gone <= BUDGET_MS,
      `부모(호스트)를 SIGKILL 하면 MCP 프로세스가 ${BUDGET_MS}ms 안에 스스로 끝난다(고아 없음)`,
      { ms: gone, cause: shutdownLine?.cause },
    );
    const left = await until(async () => (await peer.participant('kate'))?.shown_as === 'left', 'jack 이 kate 를 left 로 봄', 5_000).then(
      () => true,
      () => false,
    );
    report.check('L7-33', left, '상대가 bye 를 받아 left 로 표시한다');
    await tracker.assertNoneLeft({ graceMs: 1_000 });
  } finally {
    await tracker.dispose();
  }
  await peer.stopPump();
  await peer.ok('leave_room');
  await peer.close();
}

async function run() {
  stack = await startStack({ label: 'v-l7', ...options });
  await capability();
  const fallback = await channel();
  await cancelAndLimits();
  await badEnv();
  await shutdownTimings();
  await orphan();
  await fallback;
  const dirty = stack.agents.filter((agent) => agent.transport.badLines > 0 || agent.clientErrors.length > 0 || agent.otherNotifications.length > 0);
  report.check(
    'L7-34',
    dirty.length === 0,
    `stdout 에는 JSON-RPC 메시지만 나왔다(프로세스 ${stack.agents.length}개. 로그 수준 debug, 잘못된 설정, 오류 결과, 채널 알림 포함)`,
    dirty.map((agent) => ({ name: agent.name, bad: agent.transport.badLines, errors: agent.clientErrors })),
  );
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
}
await finish(report, stack, failure);
