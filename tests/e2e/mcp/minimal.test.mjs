// 최소판 확인: 방 기능 없이 "점검 알림 → confirm_channel → 시험 사건 전달"이 되는가.
// 사람이 실제 호스트(Claude Code)에 붙여 A-MCP-1·2·8·9 를 볼 때 쓰는 것과 같은 진입점(fake-entry.mjs)과
// 같은 조종 명령(peer-script.mjs 를 프로세스로 실행)을 MCP SDK 클라이언트로 미리 돌려 본다.
// 호스트는 SDK 클라이언트다. 실제 호스트가 채널을 등록하고 유휴 세션을 깨우는지는 여기서 보이지 않는다(A-MCP-1 미실행).
//
// 실행: AGENT_CHAT_DIST=.work/w5/dist node --test tests/e2e/mcp/minimal.test.mjs

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { createProcTracker, isPidAlive } from '../../support/proc.mjs';
import { PEER_SCRIPT, connectSdk, createSandbox, logged, waitFor } from './harness.mjs';
import { TAG_TEXT, readSent } from './peer-script.mjs';

let tracker;
let sandbox;
const spawned = [];

beforeEach(() => {
  tracker = createProcTracker({ label: 'minimal' });
  sandbox = createSandbox('min');
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

/** 사람이 다른 터미널에서 치는 것과 같은 명령을 실행한다. */
async function peer(...args) {
  const result = await tracker.run(process.execPath, [PEER_SCRIPT, '--control', sandbox.control, ...args], { name: 'peer-script', timeoutMs: 10_000 });
  assert.equal(result.code, 0, `peer-script ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

describe('최소판: 점검 알림 → confirm_channel → 시험 사건 전달', () => {
  it('입장하면 점검 알림이 오고, 그 토큰으로 확인하면 다른 프로세스가 넣은 글이 채널 알림으로 온다', async (t) => {
    const launchedAt = Date.now();
    const server = await connectSdk({ sandbox, tracker, env: { AGENT_CHAT_NAME: 'claude-min', AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_WAIT_MAX_SEC: '100' } });
    const created = await server.call('create_room');
    assert.equal(created.isError, false, created.text);
    assert.equal(created.json.name, 'claude-min');
    assert.equal(created.json.delivery_mode, 'poll');

    // 1. 점검 알림
    const token = await server.probeToken();
    assert.deepEqual(server.probes()[0], {
      content: 'Agent Chat channel check. Call the confirm_channel tool with this token.',
      meta: { kind: 'probe', token },
    });

    // 2. 확인
    const confirmed = await server.call('confirm_channel', { token });
    // cursor 는 프로세스 시작 시각(ms) 다음부터 센다(검토 2차 PRODUCT-R2-01. 이 조립 fake-entry 도 제품 조립처럼 넘긴다. 제품 진입점은 scenarios/v-l7 의 L7-35).
    // 아직 사건이 없으니 next_cursor 는 그 시작값이다.
    const base = Number(confirmed.json.next_cursor);
    assert.deepEqual(confirmed.json, { ok: true, delivery_mode: 'channel', events: [], next_cursor: String(base) });
    assert.ok(base >= launchedAt - 1_000 && base <= Date.now(), `cursor 시작값 ${base} 은 프로세스 시작 시각이다(띄운 때 ${launchedAt})`);

    // 3. 다른 프로세스가 넣은 시험 사건이 채널로 온다
    const sentAt = Date.now();
    await peer('chat', '안녕하세요.', '이', '글에', '답해', '주세요');
    await waitFor(() => server.channelEvents().length === 1, { what: '채널 알림' });
    t.diagnostic(`측정: 다른 프로세스가 글을 넣은 뒤 채널 알림 도착까지 ${Date.now() - sentAt}ms (같은 PC, 명령 실행 시간 포함)`);
    const [chat] = server.channelEvents();
    assert.equal(chat.content, '안녕하세요. 이 글에 답해 주세요');
    assert.equal(chat.meta.kind, 'chat');
    assert.equal(chat.meta.from, 'peer-script');
    assert.equal(chat.meta.cursor, String(base + 1));

    // 에이전트가 하는 일: 답하고, 본 곳까지 확인한다.
    const sent = await server.call('send_message', { text: '받았습니다' });
    assert.deepEqual(sent.json.delivered, ['peer-script']);
    assert.deepEqual(sent.json.notice.pushed_since_last_call, { count: 1, after_cursor: String(base) });
    const acked = await server.call('wait_for_messages', { cursor: chat.meta.cursor });
    assert.equal(acked.json.status, 'channel_mode');
    assert.deepEqual(readSent(sandbox.control).map((entry) => entry.text), ['받았습니다']);

    // 기록 보기 명령: 사람이 시점을 적을 때 쓴다.
    const logText = await peer('log');
    for (const expected of ['delivery.probe', 'delivery.mode', 'tool.call', '"tool":"confirm_channel"', 'control.op']) {
      assert.ok(logText.includes(expected), `log 출력에 ${expected} 이 없다`);
    }
    assert.equal(logText.includes(token), false, '토큰은 기록에 남지 않는다');
    assert.equal(logText.includes('안녕하세요'), false, '본문은 진단 기록에 남지 않는다');
    assert.ok((await peer('sent')).includes('받았습니다'));

    await server.close();
    assert.deepEqual(server.errors, []);
    assert.deepEqual(logged(server.log(), 'shutdown').map((entry) => entry.cause), ['stdin_end']);
  });

  it('send_message 에 가짜 참가자가 답한다(--echo-ms). 유휴 세션을 깨우는지 볼 때 쓴다', async () => {
    const server = await connectSdk({ sandbox, tracker, args: ['--echo-ms', '150'] });
    await server.call('create_room');
    await server.call('confirm_channel', { token: await server.probeToken() });
    await server.call('send_message', { text: 'ping' });
    await waitFor(() => server.channelEvents().length === 1, { what: '답 글의 채널 알림' });
    assert.equal(server.channelEvents()[0].content, 'echo: ping');
    await server.close();
  });

  it('채널 태그가 든 글(A-MCP-8): 알림의 본문에서 태그가 무력화돼 나간다. poll 결과에는 원문이 문자열 값으로 실린다', async () => {
    const server = await connectSdk({ sandbox, tracker });
    await server.call('create_room');
    const token = await server.probeToken();
    await peer('tag');
    const polled = await server.call('wait_for_messages');
    assert.equal(polled.json.events[0].text, TAG_TEXT);

    await server.call('confirm_channel', { token });
    await peer('tag');
    await waitFor(() => server.channelEvents().length === 1, { what: '채널 알림' });
    const content = server.channelEvents()[0].content;
    assert.equal(/<\/?channel/i.test(content), false, content);
    assert.equal(content, TAG_TEXT.replaceAll('</channel', '<\\/channel').replaceAll('<channel', '<\\channel'));
    await server.close();
  });

  it('24000바이트 결과(A-MCP-9): 20건을 한 결과로 받고 마지막 글의 표지까지 온다. 한도를 넘는 글 하나는 따로 온다', async (t) => {
    const server = await connectSdk({ sandbox, tracker, env: { AGENT_CHAT_CHANNEL: 'off' } });
    await server.call('create_room');

    const bigOut = await peer('big', '24000');
    const bigMarker = /END-[0-9a-z]+/.exec(bigOut)?.[0];
    assert.ok(bigMarker !== undefined, bigOut);
    const big = await server.call('wait_for_messages');
    assert.equal(big.json.events.length, 20);
    assert.equal(big.json.more, false);
    assert.ok(big.json.events.at(-1).text.endsWith(bigMarker), '마지막 글의 표지가 왔다');
    assert.ok(big.bytes > 22_000 && big.bytes < 25_000, `결과 ${big.bytes}바이트`);

    const hugeOut = await peer('huge');
    const hugeMarker = /END-[0-9a-z]+/.exec(hugeOut)?.[0];
    const huge = await server.call('wait_for_messages');
    assert.equal(huge.json.events.length, 1);
    assert.ok(huge.json.events[0].text.endsWith(hugeMarker));
    assert.ok(huge.bytes > 24_000, `결과 ${huge.bytes}바이트`);
    t.diagnostic(`측정: big 24000 → 결과 ${big.bytes}바이트(사건 20건). huge → 결과 ${huge.bytes}바이트(사건 1건)`);

    await peer('burst', '30');
    const first = await server.call('wait_for_messages');
    assert.equal(first.json.events.length, 20);
    assert.equal(first.json.more, true);
    await server.close();
  });

  it('중단 사건: 채널로 오고, 이후의 모든 tool 결과에 notice.test_stopped 가 붙는다', async () => {
    const server = await connectSdk({ sandbox, tracker });
    await server.call('create_room');
    await server.call('confirm_channel', { token: await server.probeToken() });
    await peer('stop', '사용자가', '중단을', '요청함');
    await waitFor(() => server.channelEvents().length === 1, { what: '중단 알림' });
    const stopped = server.channelEvents()[0];
    assert.equal(stopped.meta.kind, 'test');
    assert.equal(stopped.meta.change, 'stopped');
    const status = await server.call('get_status');
    assert.deepEqual(status.json.notice.test_stopped, { reason: 'user', by: 'peer-script' });
    assert.equal(status.json.test.stopped.detail, '사용자가 중단을 요청함');
    const refused = await server.call('start_scenario', { title: '새 시나리오' });
    assert.equal(refused.json.error.code, 'TEST_STOPPED');
    await server.close();
  });

  it('조종 명령은 MCP 프로세스가 없으면 실패를 알린다', async () => {
    const result = await tracker.run(process.execPath, [PEER_SCRIPT, '--control', sandbox.control, '--wait-ms', '300', 'chat', 'nobody home'], { name: 'peer-script', timeoutMs: 10_000 });
    assert.equal(result.code, 2);
    const usage = await tracker.run(process.execPath, [PEER_SCRIPT, 'chat', 'x'], { name: 'peer-script', timeoutMs: 10_000 });
    assert.equal(usage.code, 1);
  });
});
