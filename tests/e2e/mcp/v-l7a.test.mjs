// V-L7(가): 가짜 세션을 붙인 MCP 프로세스(fake-entry.mjs)에 MCP SDK 클라이언트로 실제 stdio 를 붙여 본다
// (verification-plan.md 3.2). 제품의 mcp-server 와 inbox 가 실제 프로세스, 실제 파이프, 실제 타이머에서 돈다.
// 세션은 가짜다. 방 기능(시그널링, WebRTC, 공유 상태)의 증거가 아니다. 증거 수준은 로컬 실물이다.
//
// 실행: AGENT_CHAT_DIST=.work/w5/dist node --test tests/e2e/mcp/v-l7a.test.mjs

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { createProcTracker, delay, distUrl, isPidAlive } from '../../support/proc.mjs';
import { CHANNEL_METHOD, SDK_HOST, connectRaw, connectSdk, createSandbox, logged, waitFor, waitGone } from './harness.mjs';
import { sendControl, waitConsumed } from './peer-script.mjs';

const { INSTRUCTIONS, TOOL_NAMES, DEFAULT_MCP_SERVER_LIMITS } = await import(distUrl('mcp-server/index.js'));
const { DEFAULT_INBOX_LIMITS } = await import(distUrl('inbox/index.js'));
const { CHANNEL_CHECK_FILE_NAME, parseChannelCheck } = await import(distUrl('protocol/index.js'));

const BUDGET_MS = DEFAULT_MCP_SERVER_LIMITS.SHUTDOWN_BUDGET_MS;
/** 호스트(Claude Code)는 SIGINT 뒤 100ms 에 SIGTERM, 그 뒤 400ms 에 SIGKILL 을 보낸다. */
const HOST_KILL_AFTER_MS = 500;

let tracker;
let sandbox;
/** 이 파일이 띄운 모든 프로세스의 pid. 끝에 남은 것이 없는지 본다. */
const spawned = [];

beforeEach(() => {
  tracker = createProcTracker({ label: 'v-l7a' });
  sandbox = createSandbox('l7a');
});

afterEach(async () => {
  for (const entry of tracker.list()) spawned.push(entry.pid);
  const killed = await tracker.dispose();
  sandbox.cleanup();
  assert.deepEqual(killed, [], '시험이 끝났을 때 남은 프로세스가 있었다');
});

after(() => {
  assert.deepEqual(spawned.filter((pid) => isPidAlive(pid)), [], '남은 프로세스');
});

async function sdk(options = {}) {
  return connectSdk({ sandbox, tracker, ...options });
}

async function raw(options = {}) {
  return connectRaw({ sandbox, tracker, ...options });
}

/** "다른 참가자"의 일을 넣고 프로세스가 읽어 갈 때까지 기다린다. */
async function inject(...ops) {
  let last = null;
  for (const op of ops) last = sendControl(sandbox.control, op);
  if (last !== null) await waitConsumed(last);
}

function eventTexts(reply) {
  return reply.json.events.map((event) => event.text);
}

function eventCursors(reply) {
  return reply.json.events.map((event) => event.cursor);
}

describe('V-L7(가) capability 와 instructions', () => {
  it('초기화 응답: tools 와 채널 capability, instructions, tool 14개. permission relay 는 없다', async () => {
    const server = await sdk();
    const capabilities = server.client.getServerCapabilities();
    assert.deepEqual(capabilities.experimental, { 'claude/channel': {} });
    assert.equal(JSON.stringify(capabilities).includes('permission'), false);
    assert.ok(capabilities.tools !== undefined);
    assert.equal(server.client.getInstructions(), INSTRUCTIONS);
    assert.equal(server.client.getServerVersion().name, 'agent-chat');
    const { tools } = await server.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    assert.equal(tools.length, 14);
    await server.close();
    assert.deepEqual(server.errors, []);
  });

  it('AGENT_CHAT_CHANNEL=off: experimental 을 선언하지 않고 confirm_channel 이 없다. 입장해도 채널로 아무 것도 보내지 않는다', async () => {
    const server = await sdk({ env: { AGENT_CHAT_CHANNEL: 'off' } });
    assert.equal(server.client.getServerCapabilities().experimental, undefined);
    const { tools } = await server.client.listTools();
    assert.equal(tools.length, 13);
    assert.equal(tools.some((tool) => tool.name === 'confirm_channel'), false);
    const created = await server.call('create_room');
    assert.equal(created.json.delivery_mode, 'poll');
    assert.equal(created.json.hint.includes('confirm_channel'), false);
    await inject({ op: 'chat', text: 'poll only' });
    assert.deepEqual(eventTexts(await server.call('wait_for_messages')), ['poll only']);
    assert.deepEqual(server.channel, []);
    await server.close();
  });

  it('revision 2026-07-28 을 요청해도 그 revision 으로 붙지 않는다', async () => {
    const server = await raw({ initialize: false });
    const response = await server.request('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'future-host', version: '3.0.0' },
    });
    assert.equal(typeof response.result.protocolVersion, 'string');
    assert.notEqual(response.result.protocolVersion, '2026-07-28');
    assert.deepEqual(response.result.capabilities.experimental, { 'claude/channel': {} });
    assert.equal(response.result.instructions, INSTRUCTIONS);
    await server.proc.stop({ signal: 'SIGTERM' });
  });
});

describe('V-L7(가) 점검, 확인, 채널 전달', () => {
  it('확인 전에는 채팅이 채널로 나가지 않는다. 채널로 가는 것은 점검 알림뿐이고, 사건은 poll 로 받는다', async () => {
    const server = await sdk();
    const created = await server.call('create_room');
    assert.equal(created.isError, false, created.text);
    assert.equal(created.json.delivery_mode, 'poll');
    const token = await server.probeToken();
    assert.match(token, /^[0-9a-z]{16}$/);
    assert.equal(server.probes()[0].content, 'Agent Chat channel check. Call the confirm_channel tool with this token.');

    await inject({ op: 'chat', text: '확인 전의 글 1' }, { op: 'chat', text: '확인 전의 글 2' }, { op: 'stop', reason: 'stop before confirm' });
    const reply = await server.call('wait_for_messages');
    assert.deepEqual(reply.json.events.map((event) => event.kind), ['chat', 'chat', 'test']);
    // cursor 는 프로세스 시작 시각(ms) 다음부터 1씩 오른다(검토 2차 PRODUCT-R2-01).
    const first = Number(reply.json.events[0].cursor);
    assert.ok(first > 1_700_000_000_000, `cursor ${first}`);
    assert.deepEqual(eventCursors(reply), [String(first), String(first + 1), String(first + 2)]);
    // 받은 뒤에도 채널로는 점검 알림 하나뿐이다.
    await delay(150);
    assert.equal(server.channel.length, 1);
    assert.deepEqual(server.otherNotifications, []);
    await server.close();
    assert.deepEqual(server.errors, []);
  });

  it('점검 → confirm_channel → 채널 전달. channel 모드의 wait_for_messages 는 기다리지 않는다', async () => {
    const server = await sdk();
    await server.call('create_room');
    const token = await server.probeToken();
    await inject({ op: 'chat', text: '밀린 글' });

    const wrong = await server.call('confirm_channel', { token: '0000000000000000' });
    assert.equal(wrong.isError, true);
    assert.equal(wrong.json.error.code, 'INVALID_ARGUMENT');

    const confirmed = await server.call('confirm_channel', { token });
    assert.equal(confirmed.isError, false, confirmed.text);
    assert.equal(confirmed.json.delivery_mode, 'channel');
    assert.deepEqual(eventTexts(confirmed), ['밀린 글']);
    // cursor 는 프로세스 시작 시각(ms) 다음부터 센다(검토 2차 PRODUCT-R2-01. fake-entry 도 제품 조립처럼 넘긴다). 첫 사건이 base + 1 이다.
    const base = Number(confirmed.json.next_cursor) - 1;
    assert.equal(confirmed.json.events[0].cursor, String(base + 1));
    assert.ok(base > 1_700_000_000_000, `cursor 시작값 ${base} 은 프로세스 시작 시각이다`);

    await inject({ op: 'chat', text: '채널로 가는 글' }, { op: 'stop', reason: 'user asked' });
    await waitFor(() => server.channelEvents().length === 2, { what: '채널 알림 2건' });
    const [chat, stopped] = server.channelEvents();
    assert.equal(chat.content, '채널로 가는 글');
    assert.deepEqual(Object.keys(chat.meta).sort(), ['cursor', 'from', 'kind', 'msg_id', 'to', 'ts']);
    assert.equal(chat.meta.kind, 'chat');
    assert.equal(chat.meta.from, 'peer-script');
    assert.equal(chat.meta.cursor, String(base + 2));
    assert.equal(stopped.meta.kind, 'test');
    assert.equal(stopped.meta.change, 'stopped');
    assert.equal(stopped.content.split('\n').length, 2, '상태 사건은 요약 한 줄과 data 한 줄이다');
    for (const item of server.channel) for (const value of Object.values(item.meta)) assert.equal(typeof value, 'string');

    const startedAt = Date.now();
    const noWait = await server.call('wait_for_messages');
    assert.equal(noWait.json.status, 'channel_mode');
    assert.ok(Date.now() - startedAt < 1000, 'channel 모드에서는 기다리지 않는다');
    assert.deepEqual(noWait.json.notice.pushed_since_last_call, { count: 2, after_cursor: String(base + 1) });
    assert.deepEqual(noWait.json.notice.test_stopped, { reason: 'user', by: 'peer-script' });

    const acked = await server.call('wait_for_messages', { cursor: String(base + 3) });
    assert.equal(acked.json.status, 'channel_mode');
    assert.equal(acked.json.notice.pushed_since_last_call, undefined);
    assert.equal((await server.call('get_status')).json.delivery_mode, 'channel');

    // 확인 기록 파일: 호스트 이름과 버전, 확인 시각.
    const file = path.join(sandbox.home, CHANNEL_CHECK_FILE_NAME);
    await waitFor(() => existsSync(file), { what: 'channel-check.json' });
    const check = parseChannelCheck(readFileSync(file, 'utf8'));
    assert.equal(check.ok, true);
    assert.equal(check.value.host, 'w5-e2e-host');
    assert.equal(check.value.host_version, '1.2.3');
    assert.equal(check.value.fallback_at, null);
    await server.close();
    assert.deepEqual(server.errors, []);
  });

  it('놓친 채널 알림은 notice.pushed_since_last_call 의 after_cursor 로 다시 받는다', async () => {
    const server = await sdk();
    await server.call('create_room');
    await server.call('confirm_channel', { token: await server.probeToken() });
    await inject({ op: 'chat', text: 'a' }, { op: 'chat', text: 'b' }, { op: 'chat', text: 'c' });
    await waitFor(() => server.channelEvents().length === 3, { what: '채널 알림 3건' });
    const status = await server.call('get_status');
    const after = status.json.notice.pushed_since_last_call.after_cursor;
    const again = await server.call('wait_for_messages', { cursor: after });
    assert.equal(again.json.status, 'events');
    assert.deepEqual(eventTexts(again), ['a', 'b', 'c']);
    assert.deepEqual(again.json.events.map((event) => event.id), server.channelEvents().map((item) => item.meta.msg_id));
    await server.close();
  });

  it('확인 호출이 없으면 poll 로 돌아온다. 놓친 사건부터 다시 받고, 앞 토큰은 버려지고, 새 점검 알림이 온다', async () => {
    const graceMs = 800;
    const server = await sdk({ args: ['--inbox-limits', JSON.stringify({ CHANNEL_SEEN_GRACE_MS: graceMs })] });
    await server.call('create_room');
    const firstToken = await server.probeToken();
    const base = (await server.call('confirm_channel', { token: firstToken })).json.next_cursor;
    await inject({ op: 'chat', text: '확인받지 못한 글 1' }, { op: 'chat', text: '확인받지 못한 글 2' });
    await waitFor(() => server.channelEvents().length === 2, { what: '채널 알림 2건' });

    // 기한 안의 호출은 모드를 바꾸지 않는다.
    const early = await server.call('get_status');
    assert.equal(early.json.delivery_mode, 'channel');
    assert.equal(early.json.notice.delivery, undefined);

    // 확인 호출 없이 기한을 넘긴다. 프로세스가 스스로 수신 불명으로 바꾼다(진단 사건으로 본다).
    await waitFor(() => logged(server.log(), 'delivery.listening').some((entry) => entry.to === false && entry.cause === 'channel'), {
      timeoutMs: graceMs + 3000,
      what: '수신 불명',
    });
    const status = await server.call('get_status');
    assert.equal(status.json.delivery_mode, 'poll');
    assert.deepEqual(status.json.notice.delivery, { mode: 'poll', reason: 'channel_unconfirmed', after_cursor: base });

    const again = await server.call('wait_for_messages', { cursor: status.json.notice.delivery.after_cursor });
    assert.deepEqual(eventTexts(again), ['확인받지 못한 글 1', '확인받지 못한 글 2']);
    assert.deepEqual(again.json.events.map((event) => event.id), server.channelEvents().map((item) => item.meta.msg_id), 'id 가 같아 두 번 받은 것을 알아볼 수 있다');
    assert.equal(again.json.notice, undefined);

    const secondToken = await server.probeToken({ after: 1 });
    assert.notEqual(secondToken, firstToken);
    const stale = await server.call('confirm_channel', { token: firstToken });
    assert.equal(stale.json.error.code, 'INVALID_ARGUMENT');
    assert.equal((await server.call('get_status')).json.delivery_mode, 'poll');

    // 이후는 poll 로 받는다. 채널로는 가지 않는다.
    const before = server.channelEvents().length;
    await inject({ op: 'chat', text: 'poll 로 받는 글' });
    assert.deepEqual(eventTexts(await server.call('wait_for_messages')), ['poll 로 받는 글']);
    assert.equal(server.channelEvents().length, before);

    const check = parseChannelCheck(readFileSync(path.join(sandbox.home, CHANNEL_CHECK_FILE_NAME), 'utf8'));
    assert.equal(check.ok, true);
    assert.equal(typeof check.value.fallback_at, 'string', '되돌아간 시각이 확인 기록 파일에 남는다');

    // 새 토큰으로는 다시 channel 이 된다.
    assert.equal((await server.call('confirm_channel', { token: secondToken })).json.delivery_mode, 'channel');
    await server.close();
    assert.deepEqual(server.errors, []);
  });

  it('수신 불명에서 cursor 없이 wait_for_messages 를 부르면 그 호출로 돌아와 사건을 받는다', async () => {
    const server = await sdk({ args: ['--inbox-limits', JSON.stringify({ CHANNEL_SEEN_GRACE_MS: 500 })] });
    await server.call('create_room');
    await server.call('confirm_channel', { token: await server.probeToken() });
    await inject({ op: 'chat', text: '놓친 글' });
    await waitFor(() => logged(server.log(), 'delivery.listening').some((entry) => entry.to === false), { what: '수신 불명' });
    const reply = await server.call('wait_for_messages');
    assert.equal(reply.json.status, 'events');
    assert.deepEqual(eventTexts(reply), ['놓친 글']);
    assert.equal(reply.json.notice.delivery.mode, 'poll');
    await server.close();
  });
});

describe('V-L7(가) 대기, 취소, 결과 상한', () => {
  it('wait_for_messages 를 취소해도 사건이 유실되지 않는다(취소 신호)', async () => {
    const server = await sdk();
    await server.call('create_room');
    await inject({ op: 'chat', text: 'first' });
    const first = await server.call('wait_for_messages');
    assert.equal(first.json.next_cursor, first.json.events[0].cursor);
    const last = Number(first.json.next_cursor);

    const controller = new AbortController();
    const pending = server.call('wait_for_messages', { timeout_sec: 30 }, { signal: controller.signal });
    await waitFor(() => logged(server.log(), 'delivery.listening').some((entry) => entry.to === true), { what: '대기 시작' });
    await delay(100);
    controller.abort('user pressed stop');
    await assert.rejects(pending);
    await waitFor(() => logged(server.log(), 'tool.call').some((entry) => entry.error_code === 'CANCELLED'), { what: '서버가 취소를 봄' });

    await inject({ op: 'chat', text: 'after cancel 1' }, { op: 'chat', text: 'after cancel 2' });
    const next = await server.call('wait_for_messages', { cursor: first.json.next_cursor });
    assert.deepEqual(eventTexts(next), ['after cancel 1', 'after cancel 2']);
    assert.deepEqual(eventCursors(next), [String(last + 1), String(last + 2)], '순번이 건너뛰지 않았다');
    await server.close();
  });

  it('호스트의 요청 기한이 먼저 끝나도 사건이 유실되지 않는다. cursor 없이 다시 불러도 받는다', async () => {
    const server = await sdk();
    await server.call('create_room');
    // 호스트의 기한 400ms, 서버의 대기 30초: 호스트가 먼저 포기하고 취소 알림을 보낸다.
    await assert.rejects(server.call('wait_for_messages', { timeout_sec: 30 }, { timeout: 400 }), /timed out/i);
    await waitFor(() => logged(server.log(), 'tool.call').some((entry) => entry.error_code === 'CANCELLED'), { what: '서버가 취소를 봄' });
    await inject({ op: 'chat', text: 'kept 1' }, { op: 'chat', text: 'kept 2' });
    const reply = await server.call('wait_for_messages');
    assert.deepEqual(eventTexts(reply), ['kept 1', 'kept 2']);
    await server.close();
  });

  it('응답을 잃은 에이전트가 이전 next_cursor 로 다시 부르면 같은 사건을 다시 받는다', async () => {
    const server = await sdk();
    await server.call('create_room');
    await inject({ op: 'chat', text: 'one' }, { op: 'chat', text: 'two' });
    const lost = await server.call('wait_for_messages');
    const again = await server.call('wait_for_messages', { cursor: '0' });
    assert.deepEqual(again.json.events, lost.json.events);
    const nothing = await server.call('wait_for_messages', { cursor: lost.json.next_cursor, timeout_sec: 0 });
    assert.equal(nothing.json.status, 'timeout');
    await server.close();
  });

  it('사건이 없으면 기한에 timeout 으로 끝난다. 걸어 둔 대기는 사건이 오는 즉시 끝난다', async () => {
    const server = await sdk({ env: { AGENT_CHAT_WAIT_MAX_SEC: '5' } });
    await server.call('create_room');
    const startedAt = Date.now();
    const short = await server.call('wait_for_messages', { timeout_sec: 0.3 });
    const elapsed = Date.now() - startedAt;
    assert.equal(short.json.status, 'timeout');
    assert.ok(elapsed >= 280 && elapsed < 2000, `0.3초 대기가 ${elapsed}ms 걸렸다`);

    const pending = server.call('wait_for_messages', { timeout_sec: 500 });
    await delay(100);
    const sentAt = Date.now();
    await inject({ op: 'chat', text: 'wake' });
    const woke = await pending;
    assert.deepEqual(eventTexts(woke), ['wake']);
    assert.ok(Date.now() - sentAt < 2000, '사건이 오면 바로 끝난다');
    await server.close();
  });

  it('결과 상한: 한 번에 20건까지. 남으면 more 로 알리고 이어 받는다', async () => {
    const server = await sdk();
    await server.call('create_room');
    await inject({ op: 'burst', count: 45 });
    const first = await server.call('wait_for_messages');
    assert.equal(first.json.events.length, DEFAULT_INBOX_LIMITS.WAIT_MAX_EVENTS);
    assert.equal(first.json.more, true);
    const second = await server.call('wait_for_messages', { cursor: first.json.next_cursor });
    assert.equal(second.json.events.length, 20);
    assert.equal(second.json.more, true);
    const third = await server.call('wait_for_messages', { cursor: second.json.next_cursor });
    assert.equal(third.json.events.length, 5);
    assert.equal(third.json.more, false);
    const all = [...first.json.events, ...second.json.events, ...third.json.events];
    const start = Number(all[0].cursor);
    assert.deepEqual(all.map((event) => event.cursor), Array.from({ length: 45 }, (_, i) => String(start + i)), '빠지거나 겹친 사건이 없다');
    await server.close();
  });

  it('결과 상한: 사건의 합이 24000바이트를 넘지 않는다. 사건 하나가 더 크면 그것 하나만 준다', async (t) => {
    const server = await sdk();
    await server.call('create_room');
    await inject({ op: 'burst', count: 12, bytes: 5000 });
    const sizes = [];
    let cursor = '0';
    let received = 0;
    for (;;) {
      const reply = await server.call('wait_for_messages', { cursor });
      const eventBytes = reply.json.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
      sizes.push({ events: reply.json.events.length, eventBytes, resultBytes: reply.bytes });
      assert.ok(eventBytes <= DEFAULT_INBOX_LIMITS.WAIT_MAX_RESULT_BYTES, `사건의 합이 ${eventBytes}바이트다`);
      received += reply.json.events.length;
      cursor = reply.json.next_cursor;
      if (!reply.json.more) break;
    }
    assert.equal(received, 12);
    assert.deepEqual(sizes.map((size) => size.events), [4, 4, 4]);
    // 결과 전체(봉투 포함)는 사건의 합보다 조금 크다. 기록해 둔다.
    assert.ok(sizes.every((size) => size.resultBytes < DEFAULT_INBOX_LIMITS.WAIT_MAX_RESULT_BYTES + 1000), JSON.stringify(sizes));

    await inject({ op: 'chat', text: `${'"'.repeat(14000)} END` }, { op: 'chat', text: 'small' });
    const huge = await server.call('wait_for_messages', { cursor });
    assert.equal(huge.json.events.length, 1);
    assert.ok(huge.bytes > DEFAULT_INBOX_LIMITS.WAIT_MAX_RESULT_BYTES, `큰 사건 하나의 결과는 ${huge.bytes}바이트다`);
    assert.ok(huge.json.events[0].text.endsWith(' END'), '잘리지 않았다');
    t.diagnostic(`측정: 결과 크기 ${JSON.stringify(sizes)}, 큰 사건 하나의 결과 ${huge.bytes}바이트`);
    assert.equal(huge.json.more, true);
    assert.deepEqual(eventTexts(await server.call('wait_for_messages', { cursor: huge.json.next_cursor })), ['small']);
    await server.close();
  });

  it('방을 나가면 받지 않은 사건을 버리고 그 수를 알린다. 다음 방에서 앞 방의 사건이 나오지 않는다', async () => {
    const server = await sdk();
    await server.call('create_room');
    const base = Number((await server.call('wait_for_messages', { timeout_sec: 0 })).json.next_cursor);
    await inject({ op: 'chat', text: 'old room 1' }, { op: 'chat', text: 'old room 2' });
    const left = await server.call('leave_room');
    assert.equal(left.json.undelivered_events, 2);
    assert.equal((await server.call('wait_for_messages')).json.error.code, 'NOT_IN_ROOM');

    await server.call('create_room');
    const empty = await server.call('wait_for_messages', { cursor: '0', timeout_sec: 0.2 });
    assert.equal(empty.json.status, 'timeout');
    await inject({ op: 'chat', text: 'new room' });
    const reply = await server.call('wait_for_messages', { cursor: '0' });
    assert.deepEqual(eventTexts(reply), ['new room']);
    assert.equal(reply.json.events[0].cursor, String(base + 3), '순번은 이어 간다');
    await server.close();
  });
});

describe('V-L7(가) 잘못된 환경 변수로도 프로세스가 뜬다', () => {
  it('잘못된 값은 기본값으로 바꾸고 notice.config 와 get_status.warnings 로 알린다', async () => {
    const server = await sdk({
      env: {
        AGENT_CHAT_WAIT_MAX_SEC: 'abc',
        AGENT_CHAT_LOG_LEVEL: 'loud',
        AGENT_CHAT_CHANNEL: 'maybe',
        AGENT_CHAT_NAME: 'bad name!',
        AGENT_CHAT_CLIENT: 'x y',
      },
    });
    const expected = [
      { name: 'AGENT_CHAT_NAME', reason: 'name must be 1-32 characters of letters, digits, "_" or "-", starting with a letter or digit' },
      { name: 'AGENT_CHAT_CLIENT', reason: 'must be 1-64 characters of letters, digits, ".", "_" or "-"' },
      { name: 'AGENT_CHAT_CHANNEL', reason: 'must be auto or off' },
      { name: 'AGENT_CHAT_WAIT_MAX_SEC', reason: 'not an integer' },
      { name: 'AGENT_CHAT_LOG_LEVEL', reason: 'must be debug, info, warn or error' },
    ];
    // 방 밖의 실패 결과에도 붙는다.
    const outside = await server.call('get_status');
    assert.equal(outside.json.error.code, 'NOT_IN_ROOM');
    assert.deepEqual(outside.json.notice.config, expected);

    const created = await server.call('create_room');
    assert.equal(created.isError, false, created.text);
    assert.match(created.json.name, /^agent-[0-9a-z]{6}$/, '무작위 기본 이름을 쓴다');
    assert.equal(created.json.participants[0].client, 'unknown');
    assert.deepEqual(created.json.notice.config, expected);
    // 채널 설정이 잘못됐으면 기본값 auto 다: 점검 알림이 온다.
    assert.match(await server.probeToken(), /^[0-9a-z]{16}$/);

    const status = await server.call('get_status');
    assert.deepEqual(
      status.json.warnings,
      expected.map((problem) => ({ code: 'config', ...problem })),
    );
    assert.deepEqual(
      logged(server.log(), 'config.problem').map((entry) => entry.name),
      expected.map((problem) => problem.name),
    );
    await server.close();
    assert.deepEqual(server.errors, []);
  });

  it('TURN 이 든 ICE 설정: 프로세스는 뜨고, 기본값으로 바꾸지 않고, 입장을 ICE_CONFIG_REJECTED 로 거절한다', async () => {
    const server = await sdk({ env: { AGENT_CHAT_ICE_SERVERS: 'stun:stun.example.com,turn:user:zq-secret@relay.example.com:3478' } });
    assert.equal((await server.client.listTools()).tools.length, 14);
    for (const [tool, args] of [
      ['create_room', {}],
      ['join_room', { room_id: 'abcdefgh12345678' }],
    ]) {
      const reply = await server.call(tool, args);
      assert.equal(reply.isError, true);
      assert.equal(reply.json.error.code, 'ICE_CONFIG_REJECTED');
      assert.equal(reply.text.includes('zq-secret'), false, '설정 원문을 결과에 싣지 않는다');
      assert.equal(reply.json.notice, undefined, '기본값으로 바꾼 것이 아니므로 notice.config 에 싣지 않는다');
    }
    assert.equal((await server.call('get_status')).json.error.code, 'NOT_IN_ROOM', '프로세스는 살아 있고 방에 들어가지 않았다');
    assert.equal(server.channel.length, 0, '입장하지 않았으므로 점검도 없다');
    assert.equal(JSON.stringify(server.log()).includes('zq-secret'), false, '설정 원문을 로그에 남기지 않는다');
    assert.deepEqual(logged(server.log(), 'config.problem').map((entry) => entry.name), ['AGENT_CHAT_ICE_SERVERS']);
    await server.close();
  });

  it('잘못된 AGENT_CHAT_SERVER: server 인자 없이 부르면 INVALID_ARGUMENT, 인자를 주면 무시된다', async () => {
    const server = await sdk({ env: { AGENT_CHAT_SERVER: 'ftp://files.example.com' } });
    const refused = await server.call('create_room');
    assert.equal(refused.json.error.code, 'INVALID_ARGUMENT');
    const created = await server.call('create_room', { server: 'localhost:8787' });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.json.server, 'ws://localhost:8787', '공용 서버로 바꿔 접속하지 않는다');
    await server.close();
  });

  it('쓸 수 없는 AGENT_CHAT_HOME: 프로세스는 뜨고 채널 확인도 된다. 확인 기록 파일만 못 쓴다', async () => {
    writeFileSync(path.join(sandbox.root, 'blocker'), 'x');
    const server = await sdk({ env: { AGENT_CHAT_HOME: path.join(sandbox.root, 'blocker', 'home') } });
    await server.call('create_room');
    const confirmed = await server.call('confirm_channel', { token: await server.probeToken() });
    assert.equal(confirmed.json.delivery_mode, 'channel');
    await inject({ op: 'chat', text: 'still works' });
    await waitFor(() => server.channelEvents().length === 1, { what: '채널 알림' });
    await waitFor(() => logged(server.log(), 'channel_check.write').some((entry) => entry.outcome === 'failed'), { what: '쓰기 실패 로그' });
    await server.close();
    assert.deepEqual(server.errors, []);
  });

  it('이름이 이미 쓰이고 있으면 다른 name 으로 다시 부르라고 알린다', async () => {
    const server = await sdk({ env: { AGENT_CHAT_NAME: 'peer-script' } });
    const refused = await server.call('create_room');
    assert.equal(refused.json.error.code, 'SIGNALING_ERROR');
    assert.deepEqual(refused.json.error.details, { server_code: 'NAME_IN_USE' });
    assert.ok(refused.json.error.message.includes('different `name` argument'));
    assert.equal((await server.call('create_room', { name: 'claude-a' })).json.name, 'claude-a');
    await server.close();
  });
});

describe('V-L7(가) stdout 과 stdio 수명', () => {
  it('stdout 에는 JSON-RPC 메시지만 나간다(로그 수준 debug, 잘못된 설정, 오류 결과, 채널 알림을 섞어서)', async () => {
    const server = await raw({ env: { AGENT_CHAT_LOG_LEVEL: 'debug', AGENT_CHAT_WAIT_MAX_SEC: 'abc' } });
    await server.request('tools/list', {});
    await server.call('get_status');
    await server.call('create_room');
    const token = await server.probeToken();
    await inject({ op: 'chat', text: 'poll' });
    await server.call('wait_for_messages');
    await server.call('confirm_channel', { token });
    await inject({ op: 'chat', text: 'channel' });
    await waitFor(() => server.notifications().length >= 2, { what: '채널 알림' });
    await server.call('set_status', { status: 'busy' });
    server.send({ jsonrpc: '2.0', id: 9999, method: 'no/such/method' });
    await waitFor(() => server.messages().some((message) => message.id === 9999), { what: '오류 응답' });
    server.proc.stdin.write('this is not json\n');
    await server.call('leave_room');
    const result = await server.proc.stop({ signal: 'SIGTERM' });
    assert.equal(result.forced, false);
    assert.equal(result.code, 0);

    assert.deepEqual(server.badLines(), [], 'stdout 에 JSON 이 아닌 줄이 있다');
    const messages = server.messages();
    assert.ok(messages.length >= 11, `stdout 메시지 ${messages.length}건`);
    for (const message of messages) {
      assert.equal(message.jsonrpc, '2.0');
      assert.ok(message.id !== undefined || message.method === CHANNEL_METHOD, JSON.stringify(message).slice(0, 200));
    }
    assert.equal(server.proc.stderr(), '', '시험 진입점은 stderr 에도 쓰지 않는다');
    assert.ok(server.log().length > 10, '진단은 파일로만 남는다');
  });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    it(`${signal}: 방에 있고 대기가 걸린 채로 받아도 ${BUDGET_MS}ms 안에 종료 코드 0 으로 끝난다`, async (t) => {
      const server = await raw();
      await server.call('create_room');
      server.post('tools/call', { name: 'wait_for_messages', arguments: {} });
      await waitFor(() => logged(server.log(), 'delivery.listening').some((entry) => entry.to === true), { what: '대기 시작' });
      const result = await server.proc.stop({ signal, timeoutMs: 3000 });
      assert.equal(result.forced, false);
      assert.equal(result.code, 0, `signal=${result.signal}`);
      assert.ok(result.stopMs <= BUDGET_MS, `${signal} 뒤 ${result.stopMs}ms 에 끝났다`);
      t.diagnostic(`측정: ${signal} 뒤 프로세스 종료까지 ${result.stopMs}ms`);
      const shutdown = logged(server.log(), 'shutdown');
      assert.equal(shutdown.length, 1);
      assert.equal(shutdown[0].cause, signal);
      assert.equal(shutdown[0].forced, false);
      assert.ok(shutdown[0].duration_ms <= BUDGET_MS);
      assert.equal(logged(server.log(), 'tool.call').at(-1).error_code, 'CANCELLED', '걸려 있던 대기가 끝났다');
      assert.deepEqual(server.badLines(), []);
    });
  }

  it(`stdin 이 닫히면(호스트가 연결을 닫음) ${BUDGET_MS}ms 안에 끝난다`, async (t) => {
    const server = await sdk();
    await server.call('create_room');
    const pending = server.call('wait_for_messages').catch(() => 'closed');
    await delay(100);
    const elapsed = await server.close();
    await pending;
    assert.ok(elapsed <= BUDGET_MS, `stdin 종료 뒤 ${elapsed}ms 에 끝났다`);
    t.diagnostic(`측정: stdin 종료 뒤 프로세스 종료까지 ${elapsed}ms`);
    const shutdown = logged(server.log(), 'shutdown');
    assert.equal(shutdown.length, 1);
    assert.equal(shutdown[0].cause, 'stdin_end');
    assert.equal(shutdown[0].forced, false);
  });

  it('호스트의 종료 순서(SIGINT, 100ms 뒤 SIGTERM)를 받아도 SIGKILL 전에 종료 코드 0 으로 끝난다. 세션 종료가 200ms 걸리는 경우', async (t) => {
    const server = await raw({ args: ['--shutdown-delay-ms', '200'] });
    await server.call('create_room');
    const startedAt = Date.now();
    server.proc.kill('SIGINT');
    await delay(100);
    server.proc.kill('SIGTERM');
    const result = await server.proc.waitForExit({ timeoutMs: 3000 });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.code, 0, `signal=${result.signal}`);
    assert.ok(elapsed <= BUDGET_MS, `SIGINT 뒤 ${elapsed}ms 에 끝났다`);
    assert.ok(elapsed >= 190, '세션 종료를 기다렸다');
    t.diagnostic(`측정: SIGINT 뒤 프로세스 종료까지 ${elapsed}ms (세션 종료 200ms)`);
    const shutdown = logged(server.log(), 'shutdown');
    assert.equal(shutdown.length, 1, '두 번째 신호로 종료를 다시 시작하지 않는다');
    assert.equal(shutdown[0].cause, 'SIGINT');
    assert.equal(shutdown[0].forced, false);
  });

  it(`세션 종료가 끝나지 않으면 예산 ${BUDGET_MS}ms 에 기다리기를 그만두고 끝난다(forced). 호스트의 SIGKILL 보다 먼저다`, async (t) => {
    const server = await raw({ args: ['--shutdown-hang'] });
    await server.call('create_room');
    const result = await server.proc.stop({ signal: 'SIGTERM', timeoutMs: 3000 });
    assert.equal(result.forced, false, '시험의 SIGKILL 없이 스스로 끝났다');
    assert.equal(result.code, 0);
    const shutdown = logged(server.log(), 'shutdown');
    assert.equal(shutdown.length, 1);
    assert.equal(shutdown[0].forced, true);
    assert.equal(shutdown[0].level, 'warn');
    assert.ok(shutdown[0].duration_ms >= BUDGET_MS - 5 && shutdown[0].duration_ms <= BUDGET_MS + 50, `closed 까지 ${shutdown[0].duration_ms}ms`);
    assert.ok(result.stopMs >= BUDGET_MS - 5, '예산까지는 기다렸다');
    assert.ok(result.stopMs < HOST_KILL_AFTER_MS, `SIGTERM 뒤 ${result.stopMs}ms 에 끝났다`);
    t.diagnostic(`측정: 예산 초과 경로. closed 까지 ${shutdown[0].duration_ms}ms, 프로세스 종료까지 ${result.stopMs}ms`);
  });

  it('stdout 이 깨지면(EPIPE) 죽지 않고 종료 절차를 밟는다', async (t) => {
    const server = await raw();
    await server.call('create_room');
    const token = await server.probeToken();
    await server.call('confirm_channel', { token });
    // 호스트가 읽기를 그만둔다. 그 뒤에 서버가 쓰는 채널 알림이 EPIPE 를 만든다.
    server.proc.child.stdout.destroy();
    await inject({ op: 'burst', count: 5 });
    const result = await server.proc.waitForExit({ timeoutMs: 3000 });
    assert.equal(result.code, 0, `signal=${result.signal}`);
    const shutdown = logged(server.log(), 'shutdown');
    assert.equal(shutdown.length, 1);
    assert.equal(shutdown[0].cause, 'stdout_error');
    assert.equal(shutdown[0].forced, false);
    assert.equal(server.proc.stderr(), '', '잡히지 않은 예외가 없다');
    t.diagnostic(`측정: stdout 이 깨진 뒤 closed 까지 ${shutdown[0].duration_ms}ms`);
  });

  it('부모(호스트)가 SIGKILL 되면 고아로 남지 않는다', async (t) => {
    const host = tracker.spawnNode(SDK_HOST, [sandbox.control], { name: 'sdk-host', env: sandbox.env() });
    const match = await host.waitForOutput(/SERVER_PID (\d+)/, { timeoutMs: 10_000 });
    const serverPid = Number(match[1]);
    tracker.trackPid(serverPid, 'fake-entry(orphan?)');
    assert.equal(isPidAlive(serverPid), true);
    assert.equal(logged(readLogSafe(), 'tool.call').some((entry) => entry.tool === 'create_room'), true, '방에 들어간 상태다');

    host.kill('SIGKILL');
    await host.waitForExit({ timeoutMs: 3000 });
    const goneMs = await waitGone(serverPid, { timeoutMs: 3000 });
    assert.ok(goneMs <= 1000, `부모가 죽은 뒤 ${goneMs}ms 에 끝났다`);
    t.diagnostic(`측정: 부모 SIGKILL 뒤 MCP 프로세스 종료까지 ${goneMs}ms (원인 ${logged(readLogSafe(), 'shutdown')[0]?.cause})`);
    const shutdown = logged(readLogSafe(), 'shutdown');
    assert.equal(shutdown.length, 1);
    assert.ok(['stdin_end', 'stdin_close'].includes(shutdown[0].cause), shutdown[0].cause);
    assert.equal(shutdown[0].forced, false);
    await tracker.assertNoneLeft({ graceMs: 500 });
  });
});

function readLogSafe() {
  const file = path.join(sandbox.control, 'log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}
