// V-U4: 수신함의 전달 경로, 커서, 전달 모드, listening, 넘침, 비우기 (verification-plan.md 3.1).
// 가짜 시계와 가짜 채널 전송 함수로 제품 규칙을 본다. 증거 수준은 대역이다.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { defineSubscribableContractTests, SUBSCRIBABLE_CHECKS } from '../protocol/testing.js';
import type { ChannelItem, DeliveredEvent, InboxLimits, ModeChanged, WaitResult } from './contract.js';
import { createInbox, DEFAULT_INBOX_LIMITS } from './index.js';
import { chatEvent, createFakeClock, createRecordingLog, numberedChat, systemEvent, testStoppedEvent } from './testing.js';

const GRACE = DEFAULT_INBOX_LIMITS.CHANNEL_SEEN_GRACE_MS;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 아직 끝나지 않았으면 'pending' 을 돌려준다. */
async function peek<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, flush().then(() => 'pending' as const)]);
}

interface Gate {
  readonly item: ChannelItem;
  release(): void;
  fail(): void;
}

function setup(overrides: Partial<InboxLimits> = {}, options: { manualSend?: boolean; withSender?: boolean } = {}) {
  const clock = createFakeClock();
  const log = createRecordingLog();
  const inbox = createInbox({ limits: { ...DEFAULT_INBOX_LIMITS, ...overrides }, now: clock.now, timers: clock.timers, log });
  const sent: ChannelItem[] = [];
  const gates: Gate[] = [];
  if (options.withSender !== false) {
    inbox.setChannelSender((item) => {
      sent.push(item);
      if (options.manualSend !== true) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        gates.push({ item, release: resolve, fail: () => reject(new Error('send failed')) });
      });
    });
  }
  const listening: boolean[] = [];
  const modes: ModeChanged[] = [];
  inbox.on('listening-changed', (value) => listening.push(value));
  inbox.on('mode-changed', (change) => modes.push(change));

  const probeTokens = (): string[] => sent.flatMap((item) => (item.type === 'probe' ? [item.token] : []));
  const channelEvents = (): DeliveredEvent[] => sent.flatMap((item) => (item.type === 'event' ? [item.event] : []));

  /** 점검을 시작하고 그 토큰으로 확인해 channel 모드로 바꾼다. */
  async function toChannel(): Promise<void> {
    inbox.startProbe();
    await flush();
    const token = probeTokens().at(-1);
    assert.ok(token !== undefined, '점검 알림이 나가지 않았다');
    assert.equal(inbox.confirm(token).ok, true);
    await flush();
  }

  return { clock, log, inbox, sent, gates, listening, modes, probeTokens, channelEvents, toChannel };
}

function cursors(result: WaitResult): string[] {
  return result.events.map((event) => event.cursor);
}

function texts(events: readonly DeliveredEvent[]): string[] {
  return events.map((event) => event.text);
}

describe('V-U4 inbox: poll 전달과 커서', () => {
  it('프로세스가 뜨면 poll 이고, 대기한 적이 없으면 listening 은 거짓이다', () => {
    const { inbox } = setup();
    assert.equal(inbox.mode(), 'poll');
    assert.equal(inbox.listening(), false);
    assert.deepEqual(inbox.stats(), { queued: 0, undelivered: 0, dropped: 0, unconfirmed: 0 });
  });

  it('넣은 순서대로, 1부터 시작하는 커서를 붙여 준다. 사건의 내용은 바꾸지 않는다', async () => {
    const { inbox } = setup();
    const first = chatEvent('강사 화면에서 손들기 표시가 보입니다');
    inbox.push(first);
    inbox.push(testStoppedEvent());
    const result = await inbox.wait({ timeoutMs: 1000 });
    assert.equal(result.status, 'events');
    assert.deepEqual(cursors(result), ['1', '2']);
    assert.equal(result.next_cursor, '2');
    assert.equal(result.more, false);
    assert.deepEqual(result.events[0], { cursor: '1', ...first });
    assert.deepEqual(result.events[1], { cursor: '2', ...testStoppedEvent() });
  });

  it('사건이 없으면 기한에 빈 timeout 으로 끝난다. 받은 커서를 그대로 돌려준다', async () => {
    const { inbox, clock } = setup();
    const pending = inbox.wait({ timeoutMs: 5000 });
    clock.advance(4999);
    assert.equal(await peek(pending), 'pending');
    clock.advance(1);
    assert.deepEqual(await pending, { status: 'timeout', events: [], next_cursor: '0', more: false });
  });

  it('timeoutMs 가 0 이면 기다리지 않는다', async () => {
    const { inbox, clock } = setup();
    assert.equal((await inbox.wait({ timeoutMs: 0 })).status, 'timeout');
    assert.equal(clock.pending() <= 1, true, 'wait 의 기한 타이머가 남지 않는다(listening 타이머만 있다)');
  });

  it('대기 중에 넣은 사건으로 바로 끝난다', async () => {
    const { inbox } = setup();
    const pending = inbox.wait({ timeoutMs: 50_000 });
    assert.equal(await peek(pending), 'pending');
    inbox.push(numberedChat(1));
    const result = await pending;
    assert.equal(result.status, 'events');
    assert.deepEqual(texts(result.events), ['message 1']);
  });

  it('cursor 를 주면 그 뒤를 다시 준다(이미 준 것 포함). 생략하면 마지막으로 준 곳 뒤부터다', async () => {
    const { inbox } = setup();
    for (let i = 1; i <= 3; i += 1) inbox.push(numberedChat(i));
    const first = await inbox.wait({ timeoutMs: 0 });
    assert.deepEqual(cursors(first), ['1', '2', '3']);
    inbox.push(numberedChat(4));

    // 응답을 못 받은 에이전트가 이전 next_cursor 로 다시 부른다.
    const again = await inbox.wait({ cursor: '1', timeoutMs: 0 });
    assert.deepEqual(cursors(again), ['2', '3', '4']);
    const fromStart = await inbox.wait({ cursor: '0', timeoutMs: 0 });
    assert.deepEqual(cursors(fromStart), ['1', '2', '3', '4']);

    inbox.push(numberedChat(5));
    const next = await inbox.wait({ timeoutMs: 0 });
    assert.deepEqual(cursors(next), ['5'], '생략하면 이미 준 것은 다시 주지 않는다');
  });

  it('아직 준 적 없는 곳을 가리키는 cursor 는 마지막으로 준 곳으로 본다', async () => {
    const { inbox } = setup();
    inbox.push(numberedChat(1));
    inbox.push(numberedChat(2));
    const result = await inbox.wait({ cursor: '99', timeoutMs: 0 });
    assert.deepEqual(cursors(result), ['1', '2'], '준 적 없는 사건을 건너뛰지 않는다');
    const empty = await inbox.wait({ cursor: '99', timeoutMs: 0 });
    assert.deepEqual(empty, { status: 'timeout', events: [], next_cursor: '2', more: false });
  });

  it('형식이 틀린 cursor 는 생략한 것으로 본다', async () => {
    const { inbox } = setup();
    inbox.push(numberedChat(1));
    await inbox.wait({ timeoutMs: 0 });
    inbox.push(numberedChat(2));
    for (const cursor of ['abc', '-1', '1.5', '', ' 1', '1e3']) {
      const result = await inbox.wait({ cursor, timeoutMs: 0 });
      assert.equal(result.events.some((event) => event.cursor === '1'), false, cursor);
    }
  });

  it('취소된 wait 은 cancelled 로 끝나고 커서를 옮기지 않는다. 그 뒤에 온 사건을 다음 호출이 받는다', async () => {
    const { inbox, clock } = setup();
    inbox.push(numberedChat(1));
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['1']);

    const controller = new AbortController();
    const pending = inbox.wait({ timeoutMs: 50_000, signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, { status: 'cancelled', events: [], next_cursor: '1', more: false });

    inbox.push(numberedChat(2));
    inbox.push(numberedChat(3));
    assert.equal(inbox.stats().undelivered, 2, '취소된 호출이 사건을 꺼내 가지 않았다');
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['2', '3']);
    clock.advance(60_000);
    assert.equal(inbox.stats().undelivered, 0);
  });

  it('이미 취소된 signal 로 부르면 사건이 있어도 꺼내지 않는다', async () => {
    const { inbox } = setup();
    inbox.push(numberedChat(1));
    const controller = new AbortController();
    controller.abort();
    const result = await inbox.wait({ timeoutMs: 1000, signal: controller.signal });
    assert.deepEqual(result, { status: 'cancelled', events: [], next_cursor: '0', more: false });
    assert.equal(inbox.stats().undelivered, 1);
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['1']);
  });

  it('사건으로 끝난 뒤의 취소는 아무 것도 바꾸지 않는다', async () => {
    const { inbox } = setup();
    const controller = new AbortController();
    const pending = inbox.wait({ timeoutMs: 50_000, signal: controller.signal });
    inbox.push(numberedChat(1));
    controller.abort();
    assert.deepEqual(cursors(await pending), ['1']);
    assert.deepEqual(await inbox.wait({ timeoutMs: 0 }), { status: 'timeout', events: [], next_cursor: '1', more: false });
  });

  it('동시에 두 번 부르면 먼저 부른 쪽이 빈 timeout 으로 끝나고, 뒤에 부른 쪽이 사건을 받는다', async () => {
    const { inbox } = setup();
    const first = inbox.wait({ timeoutMs: 50_000 });
    const second = inbox.wait({ timeoutMs: 50_000 });
    assert.deepEqual(await first, { status: 'timeout', events: [], next_cursor: '0', more: false });
    assert.equal(await peek(second), 'pending');
    inbox.push(numberedChat(1));
    assert.deepEqual(cursors(await second), ['1']);
  });

  it('한 번에 20건까지만 주고 남으면 more 로 알린다', async () => {
    const { inbox } = setup();
    for (let i = 1; i <= 45; i += 1) inbox.push(numberedChat(i));
    const first = await inbox.wait({ timeoutMs: 0 });
    assert.equal(first.events.length, 20);
    assert.equal(first.more, true);
    assert.equal(first.next_cursor, '20');
    const second = await inbox.wait({ cursor: first.next_cursor, timeoutMs: 0 });
    assert.equal(second.events.length, 20);
    assert.equal(second.more, true);
    const third = await inbox.wait({ cursor: second.next_cursor, timeoutMs: 0 });
    assert.deepEqual(cursors(third), ['41', '42', '43', '44', '45']);
    assert.equal(third.more, false);
  });

  it('한 번에 24000바이트까지만 준다. 길이는 cursor 를 붙인 사건의 JSON 으로 잰다', async () => {
    const { inbox } = setup();
    for (let i = 1; i <= 6; i += 1) inbox.push(numberedChat(i, '가'.repeat(2000)));
    const result = await inbox.wait({ timeoutMs: 0 });
    const size = result.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
    assert.equal(result.events.length, 3, '6000바이트 남짓한 사건은 세 개까지 들어간다');
    assert.ok(size <= DEFAULT_INBOX_LIMITS.WAIT_MAX_RESULT_BYTES, `결과가 ${size}바이트다`);
    assert.equal(result.more, true);
    const rest = await inbox.wait({ cursor: result.next_cursor, timeoutMs: 0 });
    assert.deepEqual(cursors(rest), ['4', '5', '6']);
    assert.equal(rest.more, false);
  });

  it('사건 하나가 바이트 상한보다 크면 그것 하나만 준다', async () => {
    const { inbox } = setup();
    inbox.push(numberedChat(1, '"'.repeat(16000)));
    inbox.push(numberedChat(2));
    const first = await inbox.wait({ timeoutMs: 0 });
    assert.deepEqual(cursors(first), ['1']);
    assert.ok(Buffer.byteLength(JSON.stringify(first.events[0]), 'utf8') > DEFAULT_INBOX_LIMITS.WAIT_MAX_RESULT_BYTES);
    assert.equal(first.more, true);
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['2']);
  });

  it('전달을 로그에 남기되 본문은 남기지 않는다', async () => {
    const { inbox, log } = setup();
    inbox.push(chatEvent('비밀-본문-표지'));
    await inbox.wait({ timeoutMs: 0 });
    const delivered = log.named('inbox.delivered');
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0]?.fields, { via: 'poll', delivered: 1, bytes: delivered[0]?.fields.bytes, more: false, msg_id: ['k3x9q0ab12cd-1a'] });
    assert.equal(JSON.stringify(log.events).includes('비밀-본문-표지'), false);
  });
});

describe('V-U4 inbox: 프로세스를 넘는 커서 (검토 2차 PRODUCT-R2-01)', () => {
  /** 프로세스 하나의 수신함. 제품 조립(entry/mcp)은 프로세스 시작 시각을 cursorBase 로 준다. */
  function processInbox(startedAt: number) {
    const clock = createFakeClock(startedAt);
    return createInbox({ limits: DEFAULT_INBOX_LIMITS, now: clock.now, timers: clock.timers, log: createRecordingLog(), cursorBase: startedAt });
  }

  it('cursorBase 를 주면 순번은 그 값 다음부터다. 아무 것도 주지 않았으면 next_cursor 는 그 값이다', async () => {
    const startedAt = Date.UTC(2026, 10, 16, 3, 0, 0);
    const inbox = processInbox(startedAt);
    assert.deepEqual(await inbox.wait({ timeoutMs: 0 }), { status: 'timeout', events: [], next_cursor: String(startedAt), more: false });
    inbox.push(numberedChat(1));
    inbox.push(numberedChat(2));
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), [String(startedAt + 1), String(startedAt + 2)]);
  });

  it('MCP 프로세스가 다시 떠도 새 사건의 cursor 는 앞 프로세스의 cursor 와 겹치지 않는다. 앞 cursor 를 넘겨도 새 사건을 처음부터 받는다', async () => {
    // 에이전트는 안내대로 cursor 로 중복을 거른다(같은 cursor 는 같은 사건).
    const seen = new Set<string>();
    const handled: string[] = [];
    const take = (result: WaitResult): void => {
      for (const event of result.events) {
        if (seen.has(event.cursor)) continue;
        seen.add(event.cursor);
        handled.push(event.text);
      }
    };
    const first = processInbox(Date.UTC(2026, 10, 16, 3, 0, 0));
    for (let i = 1; i <= 3; i += 1) first.push(numberedChat(i, `before restart ${i}`));
    const before = await first.wait({ timeoutMs: 0 });
    take(before);
    first.close();

    // 같은 대화가 이어지는 채로 MCP 서버만 다시 떴다(호스트의 재연결, crash 뒤 재시작). 5초 뒤다.
    const second = processInbox(Date.UTC(2026, 10, 16, 3, 0, 5));
    second.push(numberedChat(1, 'after restart 1'));
    second.push(testStoppedEvent());
    const after = await second.wait({ timeoutMs: 0, cursor: before.next_cursor });
    take(after);
    assert.equal(after.events.length, 2, '앞 프로세스의 cursor 를 넘겨도 새 사건을 모두 준다');
    assert.deepEqual(handled, ['before restart 1', 'before restart 2', 'before restart 3', 'after restart 1', after.events[1]?.text], '새 사건을 중복으로 버리지 않는다');
    for (const event of after.events) assert.ok(Number(event.cursor) > Number(before.next_cursor), `${event.cursor} > ${before.next_cursor}`);
  });

  it('cursor 는 15자리 숫자(tool 입력 형식) 안에 든다. 쓸 수 없는 cursorBase 는 0 으로 본다', async () => {
    const late = processInbox(Date.UTC(2286, 0, 1));
    late.push(numberedChat(1));
    const [cursor] = cursors(await late.wait({ timeoutMs: 0 }));
    assert.match(cursor ?? '', /^[0-9]{1,15}$/);
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, 2e15]) {
      const clock = createFakeClock();
      const inbox = createInbox({ limits: DEFAULT_INBOX_LIMITS, now: clock.now, timers: clock.timers, log: createRecordingLog(), cursorBase: bad });
      inbox.push(numberedChat(1));
      assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['1'], String(bad));
    }
  });
});

describe('V-U4 inbox: 점검과 channel 모드', () => {
  it('전송 함수가 없으면 점검을 시작하지 않고, 어떤 토큰도 받지 않는다', () => {
    const { inbox, sent } = setup({}, { withSender: false });
    inbox.startProbe();
    assert.deepEqual(sent, []);
    assert.deepEqual(inbox.confirm(''), { ok: false, code: 'INVALID_ARGUMENT' });
    assert.equal(inbox.mode(), 'poll');
  });

  it('점검 알림은 무작위 16자 토큰을 싣는다. 다시 시작해도 같은 토큰이다', async () => {
    const { inbox, probeTokens } = setup();
    inbox.startProbe();
    await flush();
    inbox.startProbe();
    await flush();
    const tokens = probeTokens();
    assert.equal(tokens.length, 2);
    assert.match(tokens[0] ?? '', /^[0-9a-z]{16}$/);
    assert.equal(tokens[0], tokens[1]);
    const other = setup();
    other.inbox.startProbe();
    await flush();
    assert.notEqual(other.probeTokens()[0], tokens[0], '수신함마다 토큰이 다르다');
  });

  it('확인 전에는 사건을 채널로 보내지 않는다. 채널로 가는 것은 점검 알림뿐이다', async () => {
    const { inbox, sent, channelEvents } = setup();
    inbox.push(numberedChat(1));
    inbox.startProbe();
    inbox.push(numberedChat(2));
    await flush();
    inbox.push(testStoppedEvent());
    await flush();
    assert.deepEqual(channelEvents(), []);
    assert.deepEqual(sent.map((item) => item.type), ['probe']);
    // poll 로는 그대로 받는다.
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['1', '2', '3']);
  });

  it('틀린 토큰은 INVALID_ARGUMENT 이고 모드는 그대로다', async () => {
    const { inbox, modes, probeTokens } = setup();
    inbox.startProbe();
    await flush();
    assert.deepEqual(inbox.confirm('0000000000000000'), { ok: false, code: 'INVALID_ARGUMENT' });
    assert.deepEqual(inbox.confirm(`${probeTokens()[0]}x`), { ok: false, code: 'INVALID_ARGUMENT' });
    assert.equal(inbox.mode(), 'poll');
    assert.deepEqual(modes, []);
  });

  it('맞는 토큰이면 channel 이 되고, 밀린 사건은 그 결과로만 나간다', async () => {
    const { inbox, modes, probeTokens, channelEvents } = setup();
    inbox.push(numberedChat(1));
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['1']);
    inbox.startProbe();
    await flush();
    inbox.push(numberedChat(2));
    inbox.push(numberedChat(3));

    const result = inbox.confirm(probeTokens()[0] ?? '');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.events.map((event) => event.cursor), ['2', '3']);
    assert.equal(result.next_cursor, '3');
    assert.equal(inbox.mode(), 'channel');
    assert.deepEqual(modes, [{ from: 'poll', to: 'channel', cause: 'confirmed' }]);
    await flush();
    assert.deepEqual(channelEvents(), [], '밀린 사건이 채널로 또 나가지 않는다');
    assert.equal(inbox.stats().unconfirmed, 0, '결과로 준 사건은 확인을 기다리지 않는다');
    assert.deepEqual(await inbox.wait({ timeoutMs: 0 }), { status: 'channel_mode', events: [], next_cursor: '3', more: false });
  });

  it('대기와 확인이 겹치면 대기 중이던 wait 은 빈 channel_mode 로 끝난다. 그 뒤의 사건은 채널로만 간다', async () => {
    const { inbox, probeTokens, channelEvents } = setup();
    inbox.push(numberedChat(1));
    await inbox.wait({ timeoutMs: 0 });
    inbox.startProbe();
    await flush();
    const pending = inbox.wait({ cursor: '1', timeoutMs: 50_000 });
    assert.equal(await peek(pending), 'pending');

    const result = inbox.confirm(probeTokens()[0] ?? '');
    assert.deepEqual(result, { ok: true, events: [], next_cursor: '1' });
    assert.deepEqual(await pending, { status: 'channel_mode', events: [], next_cursor: '1', more: false });
    inbox.push(numberedChat(2));
    await flush();
    assert.deepEqual(channelEvents().map((event) => event.cursor), ['2']);
  });

  it('channel 모드에서 같은 토큰으로 다시 확인해도 바뀌는 것이 없다', async () => {
    const { inbox, modes, probeTokens, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    assert.deepEqual(inbox.confirm(probeTokens()[0] ?? ''), { ok: true, events: [], next_cursor: '0' });
    assert.equal(inbox.mode(), 'channel');
    assert.equal(modes.length, 1);
    assert.equal(inbox.stats().unconfirmed, 1);
  });

  it('확인 결과도 상한을 지킨다. 넘는 나머지와 이후 사건은 채널로 순서대로 간다', async () => {
    const { inbox, probeTokens, channelEvents } = setup();
    for (let i = 1; i <= 23; i += 1) inbox.push(numberedChat(i));
    inbox.startProbe();
    await flush();
    const result = inbox.confirm(probeTokens()[0] ?? '');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.events.length, 20);
    assert.equal(result.next_cursor, '20');
    inbox.push(numberedChat(24));
    await flush();
    assert.deepEqual(channelEvents().map((event) => event.cursor), ['21', '22', '23', '24']);
  });

  it('channel 모드의 사건은 채널로 한 번만 나가고, wait 은 기다리지 않고 channel_mode 를 돌려준다', async () => {
    const { inbox, clock, toChannel, channelEvents } = setup();
    await toChannel();
    const event = chatEvent('채널로 가는 글');
    inbox.push(event);
    await flush();
    assert.deepEqual(channelEvents(), [{ cursor: '1', ...event }]);

    const result = await inbox.wait({ timeoutMs: 50_000 });
    assert.deepEqual(result, { status: 'channel_mode', events: [], next_cursor: '0', more: false });
    assert.equal(clock.pending() <= 1, true, '기한 타이머를 걸지 않는다');
    await flush();
    assert.equal(channelEvents().length, 1, '같은 사건이 다시 나가지 않는다');
  });

  it('채널 전송은 하나씩, 앞의 것이 끝난 뒤에 다음 것을 넘긴다', async () => {
    const { inbox, gates, sent, probeTokens } = setup({}, { manualSend: true });
    inbox.startProbe();
    assert.equal(sent.length, 1);
    assert.equal(inbox.confirm(probeTokens()[0] ?? '').ok, true);
    inbox.push(numberedChat(1));
    inbox.push(numberedChat(2));
    await flush();
    assert.equal(sent.length, 1, '점검 알림의 전송이 끝나기 전에는 넘기지 않는다');
    gates[0]?.release();
    await flush();
    assert.deepEqual(sent.map((item) => item.type), ['probe', 'event']);
    gates[1]?.release();
    await flush();
    assert.equal(sent.length, 3);
    assert.equal(inbox.stats().undelivered, 0);
  });

  it('전송 함수가 reject 하거나 던져도 멈추지 않는다', async () => {
    const clock = createFakeClock();
    const log = createRecordingLog();
    const inbox = createInbox({ limits: DEFAULT_INBOX_LIMITS, now: clock.now, timers: clock.timers, log });
    const seen: string[] = [];
    const tokenBox = { token: '' };
    let call = 0;
    inbox.setChannelSender((item) => {
      call += 1;
      seen.push(item.type === 'probe' ? 'probe' : item.event.cursor);
      if (item.type === 'probe') tokenBox.token = item.token;
      if (call === 2) return Promise.reject(new Error('not connected'));
      if (call === 3) throw new Error('sync failure');
      return Promise.resolve();
    });
    inbox.startProbe();
    await flush();
    assert.equal(inbox.confirm(tokenBox.token).ok, true);
    for (let i = 1; i <= 4; i += 1) inbox.push(numberedChat(i));
    await flush();
    await flush();
    assert.deepEqual(seen, ['probe', '1', '2', '3', '4']);
    assert.equal(log.named('delivery.channel_send').length, 2);
    assert.equal(JSON.stringify(log.events).includes('not connected'), false, '오류 글을 로그에 남기지 않는다');
  });

  it('channel 모드의 wait{cursor} 는 cursor 까지를 확인으로 치고, 그 뒤에 보낸 사건을 바로 다시 준다', async () => {
    const { inbox, toChannel } = setup();
    await toChannel();
    for (let i = 1; i <= 3; i += 1) inbox.push(numberedChat(i));
    await flush();
    assert.equal(inbox.stats().unconfirmed, 3);

    const partial = await inbox.wait({ cursor: '1', timeoutMs: 50_000 });
    assert.equal(partial.status, 'events');
    assert.deepEqual(cursors(partial), ['2', '3'], '에이전트가 못 본 알림을 결과로 다시 받는다');
    assert.equal(partial.next_cursor, '3');
    assert.equal(inbox.stats().unconfirmed, 2);

    const done = await inbox.wait({ cursor: '3', timeoutMs: 50_000 });
    assert.deepEqual(done, { status: 'channel_mode', events: [], next_cursor: '3', more: false });
    assert.equal(inbox.stats().unconfirmed, 0);
  });

  it('보내지 않은 곳까지 확인할 수는 없다', async () => {
    const { inbox, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    const result = await inbox.wait({ cursor: '50', timeoutMs: 0 });
    assert.deepEqual(result, { status: 'channel_mode', events: [], next_cursor: '1', more: false });
    inbox.push(numberedChat(2));
    await flush();
    assert.equal(inbox.stats().unconfirmed, 1, '나중에 보낸 사건이 미리 확인되지 않는다');
  });

  it('다른 tool 호출에는 pushed_since_last_call 이 붙고, 그 after_cursor 로 다시 받으면 놓친 사건이 온다', async () => {
    const { inbox, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    assert.deepEqual(inbox.noteToolCall({ name: 'get_status' }), {
      pushed_since_last_call: { count: 1, after_cursor: '0' },
    });
    assert.deepEqual(inbox.noteToolCall({ name: 'get_status' }), {}, '마지막 호출 뒤에 보낸 것이 없다');

    inbox.push(numberedChat(2));
    inbox.push(numberedChat(3));
    await flush();
    const notice = inbox.noteToolCall({ name: 'send_message' });
    assert.deepEqual(notice, { pushed_since_last_call: { count: 2, after_cursor: '1' } });

    // 호스트가 알림 둘을 버렸다고 하자. 에이전트가 알려 준 커서로 다시 받는다.
    const after = notice.pushed_since_last_call?.after_cursor;
    assert.deepEqual(inbox.noteToolCall({ name: 'wait_for_messages', cursor: after }), {});
    const again = await inbox.wait({ cursor: after, timeoutMs: 0 });
    assert.deepEqual(texts(again.events), ['message 2', 'message 3']);
  });

  it('cursor 없는 wait_for_messages 에도 pushed_since_last_call 이 붙는다. cursor 를 준 호출에는 붙지 않는다', async () => {
    const { inbox, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    assert.deepEqual(inbox.noteToolCall({ name: 'wait_for_messages' }), {
      pushed_since_last_call: { count: 1, after_cursor: '0' },
    });
    inbox.push(numberedChat(2));
    await flush();
    assert.deepEqual(inbox.noteToolCall({ name: 'wait_for_messages', cursor: '1' }), {});
    assert.deepEqual(inbox.noteToolCall({ name: 'get_status' }), {}, '확인 호출이 집계를 비웠다');
  });

  it('poll 모드의 tool 호출에는 아무 것도 붙지 않는다', () => {
    const { inbox } = setup();
    inbox.push(numberedChat(1));
    assert.deepEqual(inbox.noteToolCall({ name: 'get_status' }), {});
    assert.deepEqual(inbox.noteToolCall({ name: 'wait_for_messages' }), {});
  });
});

describe('V-U4 inbox: 수신 불명과 poll 복귀', () => {
  async function uncertain() {
    const context = setup();
    await context.toChannel();
    context.inbox.push(numberedChat(1));
    context.inbox.push(numberedChat(2));
    await flush();
    context.clock.advance(GRACE);
    return context;
  }

  it('확인이 120초 넘게 없으면 수신 불명이 되어 listening 이 거짓이 된다. 모드는 아직 channel 이다', async () => {
    const { inbox, clock, listening, toChannel } = setup();
    await toChannel();
    assert.equal(inbox.listening(), true);
    inbox.push(numberedChat(1));
    await flush();
    clock.advance(GRACE - 1);
    assert.equal(inbox.listening(), true);
    clock.advance(1);
    assert.equal(inbox.listening(), false);
    assert.equal(inbox.mode(), 'channel');
    assert.deepEqual(listening, [true, false]);
  });

  it('수신 불명에서 wait_for_messages{cursor} 가 아닌 다음 호출에 poll 로 돌아간다', async () => {
    const { inbox, modes, probeTokens } = await uncertain();
    const before = probeTokens().length;
    const notice = inbox.noteToolCall({ name: 'get_status' });
    assert.deepEqual(notice, { delivery: { mode: 'poll', reason: 'channel_unconfirmed', after_cursor: '0' } });
    assert.equal(inbox.mode(), 'poll');
    assert.deepEqual(modes.at(-1), { from: 'channel', to: 'poll', cause: 'channel_unconfirmed' });
    await flush();
    assert.equal(probeTokens().length, before + 1, '새 점검 알림을 보낸다');
    assert.notEqual(probeTokens().at(-1), probeTokens().at(-2));

    // 확인 안 된 사건부터 poll 로 다시 준다.
    const again = await inbox.wait({ cursor: notice.delivery?.after_cursor, timeoutMs: 0 });
    assert.deepEqual(texts(again.events), ['message 1', 'message 2']);
    assert.deepEqual(inbox.noteToolCall({ name: 'get_status' }), {}, '되돌아간 뒤에는 알림이 한 번만 붙는다');
  });

  it('수신 불명에서도 wait_for_messages{cursor} 는 되돌리지 않는다. 확인으로 치고 listening 이 참이 된다', async () => {
    const { inbox, listening } = await uncertain();
    assert.deepEqual(inbox.noteToolCall({ name: 'wait_for_messages', cursor: '2' }), {});
    const result = await inbox.wait({ cursor: '2', timeoutMs: 0 });
    assert.equal(result.status, 'channel_mode');
    assert.equal(inbox.mode(), 'channel');
    assert.equal(inbox.listening(), true);
    assert.equal(listening.at(-1), true);
  });

  it('수신 불명에서 일부만 확인하면 나머지를 결과로 다시 주고, 그때부터 다시 확인을 기다린다', async () => {
    const { inbox, clock } = await uncertain();
    inbox.noteToolCall({ name: 'wait_for_messages', cursor: '1' });
    const result = await inbox.wait({ cursor: '1', timeoutMs: 0 });
    assert.deepEqual(cursors(result), ['2']);
    assert.equal(inbox.listening(), true);
    clock.advance(GRACE - 1);
    assert.equal(inbox.listening(), true);
    clock.advance(1);
    assert.equal(inbox.listening(), false);
  });

  it('cursor 없는 wait_for_messages 도 돌아가는 호출이고, 확인 안 된 사건부터 받는다', async () => {
    const { inbox } = await uncertain();
    const notice = inbox.noteToolCall({ name: 'wait_for_messages' });
    assert.deepEqual(notice.delivery, { mode: 'poll', reason: 'channel_unconfirmed', after_cursor: '0' });
    // mcp-server 는 noteToolCall 뒤에 같은 호출로 wait 을 부른다. channel_mode 가 아니라 사건을 받는다.
    const result = await peek(inbox.wait({ timeoutMs: 50_000 }));
    assert.notEqual(result, 'pending', '기다리지 않고 바로 돌려준다');
    if (result === 'pending') return;
    assert.equal(result.status, 'events');
    assert.deepEqual(texts(result.events), ['message 1', 'message 2']);
    assert.equal(inbox.listening(), true);
  });

  it('형식이 틀린 cursor 를 준 wait_for_messages 는 확인이 아니다', async () => {
    const { inbox } = await uncertain();
    assert.ok(inbox.noteToolCall({ name: 'wait_for_messages', cursor: 'abc' }).delivery !== undefined);
    assert.equal(inbox.mode(), 'poll');
  });

  it('confirm_channel 도 돌아가는 호출이다. 앞 토큰은 INVALID_ARGUMENT 이고, 새 토큰으로 확인하면 다시 channel 이 된다', async () => {
    const { inbox, probeTokens, channelEvents } = await uncertain();
    const oldToken = probeTokens().at(-1) ?? '';
    const notice = inbox.noteToolCall({ name: 'confirm_channel' });
    assert.ok(notice.delivery !== undefined);
    assert.deepEqual(inbox.confirm(oldToken), { ok: false, code: 'INVALID_ARGUMENT' });
    assert.equal(inbox.mode(), 'poll');

    await flush();
    const newToken = probeTokens().at(-1) ?? '';
    assert.notEqual(newToken, oldToken);
    const sentBefore = channelEvents().length;
    const result = inbox.confirm(newToken);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(texts(result.events), ['message 1', 'message 2'], '확인 안 된 사건을 결과로 돌려준다');
    assert.equal(inbox.mode(), 'channel');
    await flush();
    assert.equal(channelEvents().length, sentBefore, '결과로 준 사건을 채널로 또 보내지 않는다');
  });

  it('채널이 잘 되는데 확인 호출이 없었으면 사건이 한 번 더 전달된다. id 가 같아 알아볼 수 있다', async () => {
    const { inbox, channelEvents } = await uncertain();
    inbox.noteToolCall({ name: 'send_message' });
    const again = await inbox.wait({ timeoutMs: 0 });
    assert.deepEqual(
      again.events.map((event) => event.id),
      channelEvents().map((event) => event.id),
    );
    assert.deepEqual(cursors(again), channelEvents().map((event) => event.cursor));
  });

  it('수신 불명이 아니면 다른 tool 호출이 모드를 바꾸지 않는다', async () => {
    const { inbox, clock, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    clock.advance(GRACE - 1);
    assert.ok(inbox.noteToolCall({ name: 'get_status' }).pushed_since_last_call !== undefined);
    assert.equal(inbox.mode(), 'channel');
  });

  it('전달 모드의 변화를 로그에 남긴다. 토큰은 남기지 않는다', async () => {
    const { inbox, log, probeTokens } = await uncertain();
    inbox.noteToolCall({ name: 'get_status' });
    const modes = log.named('delivery.mode').map((entry) => entry.fields);
    assert.deepEqual(modes, [
      { from: 'poll', to: 'channel', cause: 'confirmed' },
      { from: 'channel', to: 'poll', cause: 'channel_unconfirmed', unseen: 2 },
    ]);
    const text = JSON.stringify(log.events);
    for (const token of probeTokens()) assert.equal(text.includes(token), false);
  });
});

describe('V-U4 inbox: listening', () => {
  it('poll: 대기가 걸려 있으면 참이고, 마지막 대기가 끝난 지 120초 안이면 참이다. 바뀔 때 알린다', async () => {
    const { inbox, clock, listening, log } = setup();
    const pending = inbox.wait({ timeoutMs: 50_000 });
    assert.equal(inbox.listening(), true);
    assert.deepEqual(listening, [true]);
    clock.advance(50_000);
    assert.equal((await pending).status, 'timeout');
    assert.equal(inbox.listening(), true, '끝난 직후에는 아직 수신 중으로 본다');
    clock.advance(DEFAULT_INBOX_LIMITS.LISTEN_GRACE_MS - 1);
    assert.equal(inbox.listening(), true);
    clock.advance(1);
    assert.equal(inbox.listening(), false);
    assert.deepEqual(listening, [true, false]);
    assert.deepEqual(log.named('delivery.listening').map((entry) => entry.fields.to), [true, false]);
  });

  it('poll: 대기를 반복하는 동안에는 알림이 한 번뿐이다', async () => {
    const { inbox, clock, listening } = setup();
    for (let round = 0; round < 5; round += 1) {
      const pending = inbox.wait({ timeoutMs: 50_000 });
      clock.advance(50_000);
      await pending;
      clock.advance(10_000);
    }
    assert.deepEqual(listening, [true]);
  });

  it('poll: 사건을 바로 받고 끝난 호출도 대기로 친다', async () => {
    const { inbox, listening } = setup();
    inbox.push(numberedChat(1));
    await inbox.wait({ timeoutMs: 0 });
    assert.equal(inbox.listening(), true);
    assert.deepEqual(listening, [true]);
  });

  it('poll: 취소된 대기가 끝난 뒤에도 120초 동안은 참이다', async () => {
    const { inbox, clock } = setup();
    const controller = new AbortController();
    const pending = inbox.wait({ timeoutMs: 50_000, signal: controller.signal });
    controller.abort();
    await pending;
    assert.equal(inbox.listening(), true);
    clock.advance(DEFAULT_INBOX_LIMITS.LISTEN_GRACE_MS);
    assert.equal(inbox.listening(), false);
  });

  it('channel: 확인 안 된 사건이 없으면 참이다. 대기한 적이 없던 에이전트는 확인하는 순간 참이 된다', async () => {
    const { inbox, listening, toChannel } = setup();
    assert.equal(inbox.listening(), false);
    await toChannel();
    assert.equal(inbox.listening(), true);
    assert.deepEqual(listening, [true]);
  });

  it('channel: 가장 오래된 확인 안 된 사건이 기준이다. 뒤에 보낸 사건이 기한을 미루지 않는다', async () => {
    const { inbox, clock, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    clock.advance(GRACE - 10);
    inbox.push(numberedChat(2));
    await flush();
    clock.advance(10);
    assert.equal(inbox.listening(), false);
  });

  it('channel: 가장 오래된 것을 확인하면 다음 것의 시각이 기준이 된다', async () => {
    const { inbox, clock, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    clock.advance(GRACE - 10);
    inbox.push(numberedChat(2));
    await flush();
    inbox.noteToolCall({ name: 'wait_for_messages', cursor: '1' });
    // 2번은 결과로 다시 나가므로 그때부터 다시 잰다.
    await inbox.wait({ cursor: '1', timeoutMs: 0 });
    clock.advance(GRACE - 1);
    assert.equal(inbox.listening(), true);
    clock.advance(1);
    assert.equal(inbox.listening(), false);
  });

  it('listening() 은 타이머가 울리기 전이라도 지금 시각으로 계산한 값을 준다', async () => {
    const clock = createFakeClock();
    let skew = 0;
    const inbox = createInbox({
      limits: DEFAULT_INBOX_LIMITS,
      now: () => clock.now() + skew,
      timers: clock.timers,
      log: createRecordingLog(),
    });
    await inbox.wait({ timeoutMs: 0 });
    assert.equal(inbox.listening(), true);
    skew = DEFAULT_INBOX_LIMITS.LISTEN_GRACE_MS;
    assert.equal(inbox.listening(), false);
  });
});

describe('V-U4 inbox: 넘침 정책', () => {
  it('넘치면 이미 전달한 것부터 버린다. 누락 알림을 넣지 않는다', async () => {
    const { inbox } = setup({ INBOX_MAX_EVENTS: 5 });
    for (let i = 1; i <= 5; i += 1) inbox.push(numberedChat(i));
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['1', '2', '3', '4', '5']);
    inbox.push(numberedChat(6));
    inbox.push(numberedChat(7));
    assert.deepEqual(inbox.stats(), { queued: 5, undelivered: 2, dropped: 0, unconfirmed: 0 });
    // 버린 구간을 가리키는 cursor 는 남은 가장 오래된 사건부터 받는다.
    const again = await inbox.wait({ cursor: '0', timeoutMs: 0 });
    assert.deepEqual(cursors(again), ['3', '4', '5', '6', '7']);
    assert.equal(again.events.some((event) => event.kind === 'system'), false);
  });

  it('전달하지 못한 것을 버려야 하면 누락 알림 하나로 바꾸고 건수를 센다', async () => {
    const { inbox, log } = setup({ INBOX_MAX_EVENTS: 5 });
    for (let i = 1; i <= 5; i += 1) inbox.push(numberedChat(i));
    inbox.push(numberedChat(6));
    assert.deepEqual(inbox.stats(), { queued: 5, undelivered: 5, dropped: 2, unconfirmed: 0 });
    inbox.push(numberedChat(7));
    inbox.push(numberedChat(8));
    assert.equal(inbox.stats().queued, 5, '상한을 넘지 않는다');
    assert.equal(inbox.stats().dropped, 4);

    const result = await inbox.wait({ timeoutMs: 0 });
    assert.deepEqual(cursors(result), ['4', '5', '6', '7', '8']);
    const marker = result.events[0];
    assert.equal(marker?.kind, 'system');
    assert.equal(marker?.from, 'system');
    assert.equal(marker?.to, 'you');
    assert.equal(marker?.id, null);
    assert.deepEqual(marker?.data, { code: 'inbox_dropped', count: 4 });
    assert.deepEqual(texts(result.events.slice(1)), ['message 5', 'message 6', 'message 7', 'message 8']);
    assert.deepEqual(log.named('inbox.dropped').map((entry) => entry.fields.unseen), [2, 1, 1]);
  });

  it('전달한 누락 알림은 다음에 넘칠 때 조용히 버려진다', async () => {
    const { inbox } = setup({ INBOX_MAX_EVENTS: 4 });
    for (let i = 1; i <= 5; i += 1) inbox.push(numberedChat(i));
    const first = await inbox.wait({ timeoutMs: 0 });
    assert.equal(first.events[0]?.kind, 'system');
    const before = inbox.stats().dropped;
    inbox.push(numberedChat(6));
    inbox.push(numberedChat(7));
    assert.equal(inbox.stats().dropped, before);
    assert.equal((await inbox.wait({ timeoutMs: 0 })).events.some((event) => event.kind === 'system'), false);
  });

  it('channel 모드: 확인된 사건은 조용히 버린다', async () => {
    const { inbox, toChannel } = setup({ INBOX_MAX_EVENTS: 4 });
    await toChannel();
    for (let i = 1; i <= 4; i += 1) inbox.push(numberedChat(i));
    await flush();
    inbox.noteToolCall({ name: 'wait_for_messages', cursor: '4' });
    await inbox.wait({ cursor: '4', timeoutMs: 0 });
    inbox.push(numberedChat(5));
    await flush();
    assert.deepEqual(inbox.stats(), { queued: 4, undelivered: 0, dropped: 0, unconfirmed: 1 });
  });

  it('channel 모드: 확인 안 된 사건을 버려야 하면 누락으로 세고, poll 로 돌아갔을 때 알림이 맨 앞에 나온다', async () => {
    const { inbox, clock, toChannel, channelEvents } = setup({ INBOX_MAX_EVENTS: 4 });
    await toChannel();
    for (let i = 1; i <= 6; i += 1) {
      inbox.push(numberedChat(i));
      await flush();
    }
    assert.equal(channelEvents().length, 6, '채널로는 모두 나갔다');
    assert.equal(channelEvents().some((event) => event.kind === 'system'), false, '이미 보낸 구간의 알림은 채널로 보내지 않는다');
    assert.deepEqual(inbox.stats(), { queued: 4, undelivered: 0, dropped: 3, unconfirmed: 4 });

    clock.advance(GRACE);
    assert.equal(inbox.listening(), false, '버린 사건의 시각이 기준으로 남는다');
    const notice = inbox.noteToolCall({ name: 'get_status' });
    const again = await inbox.wait({ cursor: notice.delivery?.after_cursor, timeoutMs: 0 });
    assert.deepEqual(again.events[0]?.data, { code: 'inbox_dropped', count: 3 });
    assert.deepEqual(texts(again.events.slice(1)), ['message 4', 'message 5', 'message 6']);
  });

  it('channel 모드: 아직 보내지 못한 사건을 버려야 하면 누락 알림이 채널로 차례에 맞게 나간다', async () => {
    const { inbox, gates, channelEvents, probeTokens } = setup({ INBOX_MAX_EVENTS: 4 }, { manualSend: true });
    inbox.startProbe();
    assert.equal(inbox.confirm(probeTokens()[0] ?? '').ok, true);
    // 점검 알림의 전송이 끝나지 않아 사건이 쌓인다.
    for (let i = 1; i <= 6; i += 1) inbox.push(numberedChat(i));
    assert.equal(inbox.stats().queued, 4);
    assert.equal(inbox.stats().dropped, 3);
    for (let i = 0; i < 5; i += 1) {
      gates[i]?.release();
      await flush();
    }
    const sentEvents = channelEvents();
    assert.deepEqual(sentEvents.map((event) => event.cursor), ['3', '4', '5', '6']);
    assert.deepEqual(sentEvents[0]?.data, { code: 'inbox_dropped', count: 3 });
  });
});

describe('V-U4 inbox: discardAll', () => {
  it('내준 사건과 내주지 않은 사건을 모두 버리고, 내주지 않은 수를 돌려준다', async () => {
    const { inbox, log } = setup();
    for (let i = 1; i <= 3; i += 1) inbox.push(numberedChat(i));
    await inbox.wait({ timeoutMs: 0 });
    for (let i = 4; i <= 8; i += 1) inbox.push(numberedChat(i));
    assert.equal(inbox.discardAll(), 5);
    assert.deepEqual(inbox.stats(), { queued: 0, undelivered: 0, dropped: 0, unconfirmed: 0 });
    assert.deepEqual(log.named('inbox.discarded').map((entry) => entry.fields), [{ unseen: 5 }]);
    assert.equal(inbox.discardAll(), 0);
    assert.equal(log.named('inbox.discarded').length, 1, '버린 것이 없으면 로그를 남기지 않는다');
  });

  it('그 뒤의 wait 은 옛 cursor 로 와도 버린 사건을 주지 않고, 새로 넣은 사건을 처음부터 준다. 순번은 이어진다', async () => {
    const { inbox } = setup();
    for (let i = 1; i <= 4; i += 1) inbox.push(numberedChat(i));
    const before = await inbox.wait({ timeoutMs: 0 });
    inbox.push(numberedChat(5));
    inbox.discardAll();

    for (const cursor of [undefined, '0', '2', before.next_cursor, '5', '99']) {
      const empty = await inbox.wait(cursor === undefined ? { timeoutMs: 0 } : { cursor, timeoutMs: 0 });
      assert.deepEqual(empty.events, [], `cursor ${cursor}`);
    }
    inbox.push(chatEvent('다음 방의 첫 글'));
    inbox.push(chatEvent('다음 방의 둘째 글'));
    const next = await inbox.wait({ cursor: before.next_cursor, timeoutMs: 0 });
    assert.deepEqual(cursors(next), ['6', '7'], '순번이 1 로 돌아가지 않는다');
    assert.deepEqual(texts(next.events), ['다음 방의 첫 글', '다음 방의 둘째 글']);
  });

  it('넘쳐서 버린 것이 아니다. 누락 알림이 생기지 않고 dropped 가 그대로다', async () => {
    const { inbox } = setup({ INBOX_MAX_EVENTS: 4 });
    for (let i = 1; i <= 5; i += 1) inbox.push(numberedChat(i));
    const dropped = inbox.stats().dropped;
    assert.equal(dropped, 2);
    inbox.discardAll();
    assert.equal(inbox.stats().dropped, dropped);
    inbox.push(numberedChat(6));
    const next = await inbox.wait({ timeoutMs: 0 });
    assert.deepEqual(next.events.map((event) => event.kind), ['chat']);
  });

  it('모드와 점검 토큰은 그대로다', async () => {
    const { inbox, probeTokens, modes } = setup();
    inbox.startProbe();
    await flush();
    inbox.push(numberedChat(1));
    assert.equal(inbox.discardAll(), 1);
    assert.equal(inbox.mode(), 'poll');
    assert.equal(inbox.confirm(probeTokens()[0] ?? '').ok, true, '비우기 전의 토큰이 그대로 통한다');
    assert.equal(inbox.mode(), 'channel');
    inbox.push(numberedChat(2));
    await flush();
    assert.equal(inbox.discardAll(), 0, '채널로 보낸 사건은 내준 것이다');
    assert.equal(inbox.mode(), 'channel');
    assert.equal(modes.length, 1);
  });

  it('channel 모드: 확인 안 된 사건이 없어져 수신 불명과 pushed_since_last_call 이 생기지 않는다', async () => {
    const { inbox, clock, toChannel, listening } = setup();
    await toChannel();
    for (let i = 1; i <= 3; i += 1) inbox.push(numberedChat(i));
    await flush();
    assert.equal(inbox.stats().unconfirmed, 3);
    clock.advance(GRACE - 1000);
    inbox.discardAll();
    assert.equal(inbox.stats().unconfirmed, 0);
    clock.advance(GRACE * 2);
    assert.equal(inbox.listening(), true, '앞 방의 사건 때문에 수신 불명이 되지 않는다');
    assert.deepEqual(listening, [true]);
    assert.deepEqual(inbox.noteToolCall({ name: 'join_room' }), {}, '앞 방의 집계가 붙지 않고 poll 로 돌아가지도 않는다');
    assert.equal(inbox.mode(), 'channel');

    inbox.push(numberedChat(4));
    await flush();
    const result = await inbox.wait({ cursor: '0', timeoutMs: 0 });
    assert.deepEqual(cursors(result), ['4'], '앞 방의 사건을 다시 주지 않는다');
  });

  it('수신 불명 상태에서 비우면 listening 이 참으로 돌아온다', async () => {
    const { inbox, clock, toChannel } = setup();
    await toChannel();
    inbox.push(numberedChat(1));
    await flush();
    clock.advance(GRACE);
    assert.equal(inbox.listening(), false);
    inbox.discardAll();
    assert.equal(inbox.listening(), true);
    assert.equal(inbox.mode(), 'channel');
  });

  it('대기 중인 wait 을 끝내지 않는다. 그 뒤에 넣은 사건을 받는다', async () => {
    const { inbox } = setup();
    inbox.push(numberedChat(1));
    await inbox.wait({ timeoutMs: 0 });
    const pending = inbox.wait({ timeoutMs: 50_000 });
    inbox.discardAll();
    assert.equal(await peek(pending), 'pending');
    inbox.push(numberedChat(2));
    assert.deepEqual(cursors(await pending), ['2']);
  });

  it('내주지 않은 누락 알림도 한 건으로 센다', () => {
    const { inbox } = setup({ INBOX_MAX_EVENTS: 4 });
    for (let i = 1; i <= 5; i += 1) inbox.push(numberedChat(i));
    assert.equal(inbox.discardAll(), 4);
  });
});

describe('V-U4 inbox: 닫기와 방어', () => {
  it('close 는 대기 중인 wait 을 cancelled 로 끝내고 타이머를 지운다. 여러 번 불러도 된다', async () => {
    const { inbox, clock, listening } = setup();
    const pending = inbox.wait({ timeoutMs: 50_000 });
    inbox.close();
    inbox.close();
    assert.deepEqual(await pending, { status: 'cancelled', events: [], next_cursor: '0', more: false });
    assert.equal(clock.pending(), 0);
    const before = listening.length;
    inbox.push(numberedChat(1));
    clock.advance(1_000_000);
    assert.equal(listening.length, before, '닫은 뒤에는 이벤트를 내지 않는다');
    assert.equal((await inbox.wait({ timeoutMs: 1000 })).status, 'cancelled');
    assert.equal(inbox.listening(), false);
    assert.deepEqual(inbox.noteToolCall({ name: 'get_status' }), {});
    assert.equal(inbox.discardAll(), 0);
  });

  it('push 는 JSON 으로 적을 수 없는 사건을 받아도 던지지 않는다', async () => {
    const { inbox, log } = setup();
    const loop: Record<string, unknown> = { code: 'record_failed' };
    loop['self'] = loop;
    assert.doesNotThrow(() => inbox.push({ ...systemEvent('record_failed'), data: loop as never }));
    assert.equal(inbox.stats().queued, 0);
    assert.equal(log.named('inbox.error').length, 1);
    inbox.push(numberedChat(1));
    assert.deepEqual(cursors(await inbox.wait({ timeoutMs: 0 })), ['1'], '버린 사건은 순번을 쓰지 않는다');
  });

  it('리스너 안에서 수신함을 다시 불러도 상태가 깨지지 않는다', async () => {
    const { inbox } = setup();
    const seen: boolean[] = [];
    inbox.on('listening-changed', (value) => {
      seen.push(inbox.listening() === value);
      if (value) inbox.push(systemEvent('record_failed'));
    });
    const pending = inbox.wait({ timeoutMs: 50_000 });
    const result = await pending;
    assert.deepEqual(seen, [true]);
    assert.deepEqual(result.events.map((event) => event.kind), ['system']);
  });
});

describe('V-U4 inbox: Subscribable 적합성', () => {
  defineSubscribableContractTests('inbox listening-changed', () => {
    const { inbox, clock } = setup();
    return {
      subscribe: (listener) => inbox.on('listening-changed', listener),
      emit: () => {
        if (inbox.listening()) {
          // 대기가 끝나고 기한이 지나면 거짓으로 한 번 바뀐다.
          clock.advance(50_000 + DEFAULT_INBOX_LIMITS.LISTEN_GRACE_MS);
        } else {
          void inbox.wait({ timeoutMs: 50_000 });
        }
      },
    };
  });

  // 적합성 확인은 동기로 돈다. 채널 전송이 끝나려면 한 틱이 필요하므로 channel 모드의 수신함을 미리 만들어 둔다.
  const prepared: ReturnType<typeof setup>[] = [];
  before(async () => {
    for (let i = 0; i < SUBSCRIBABLE_CHECKS.length; i += 1) {
      const context = setup();
      await context.toChannel();
      context.inbox.push(numberedChat(1));
      await flush();
      prepared.push(context);
    }
  });

  defineSubscribableContractTests('inbox mode-changed', () => {
    const context = prepared.pop();
    assert.ok(context !== undefined, '준비한 수신함이 모자란다');
    const { inbox, clock, probeTokens } = context;
    return {
      subscribe: (listener) => inbox.on('mode-changed', listener),
      emit: () => {
        if (inbox.mode() === 'channel') {
          // 확인이 끊긴 뒤의 tool 호출: channel → poll
          clock.advance(GRACE);
          inbox.noteToolCall({ name: 'leave_room' });
        } else {
          // 되돌아가며 보낸 새 점검 알림의 토큰으로 확인: poll → channel
          inbox.confirm(probeTokens().at(-1) ?? '');
        }
      },
    };
  });
});
