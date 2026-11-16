// V-U9: 채팅 전달(크기, 속도, ack, resend_of). 하위 모듈 없이 단독으로 본다(architecture.md 3.10).
// 프레임을 보내는 함수 하나만 가짜로 준다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, parseP2PFrame } from '../protocol/index.js';
import type { ChatFrame } from '../protocol/index.js';
import { createChatDelivery } from './chat-delivery.js';
import type { ChatDelivery, ChatTargets } from './chat-delivery.js';
import { FakeClock, SEC, flushMicrotasks, sidOf } from './testing.js';

const SID = sidOf('me');

interface Rig {
  readonly clock: FakeClock;
  readonly chat: ChatDelivery;
  /** 보낸 프레임. */
  readonly wire: { peer: string; frame: ChatFrame }[];
  /** 이 피어로는 보내지 못한다. */
  readonly closed: Set<string>;
}

function rig(sentBufferSize = 200): Rig {
  const clock = new FakeClock();
  const wire: Rig['wire'] = [];
  const closed = new Set<string>();
  const chat = createChatDelivery({
    sid: SID,
    now: clock.now,
    timers: clock.timers,
    sentBufferSize,
    sendFrame: (peer, text) => {
      if (closed.has(peer)) return 'not_open';
      const parsed = parseP2PFrame(text);
      assert.ok(parsed.ok && parsed.value.t === 'chat', '받는 쪽이 거절할 프레임을 보냈다');
      wire.push({ peer, frame: parsed.value });
      return 'ok';
    },
  });
  return { clock, chat, wire, closed };
}

const targets = (open: string[], absent: string[] = []): ChatTargets => ({ open, absent, known: [...open, ...absent] });

function chatFrame(id: string, to: string[] | null = null, text = '안녕'): ChatFrame {
  return { v: LIMITS.P2P_VERSION, t: 'chat', id, to, text, wall: 0 };
}

describe('채팅 전달: 보내기와 ack', () => {
  it('방 전체 글은 열린 링크 전부에 가고, ack 가 온 수신자가 delivered 다', async () => {
    const { chat, wire } = rig();
    const sending = chat.send({ text: '시작합니다' }, targets(['A', 'B']));
    assert.deepEqual(wire.map((entry) => entry.peer), ['A', 'B']);
    assert.equal(wire[0]?.frame.to, null);
    const id = wire[0]?.frame.id as string;
    assert.equal(id, `${SID}-1`);
    chat.ack('A', id);
    chat.ack('B', id);
    const { result, sent } = await sending;
    assert.deepEqual(result, { ok: true, message_id: id, delivered: ['A', 'B'], undelivered: [] });
    assert.deepEqual({ to: sent?.to, text: sent?.text, targets: sent?.targets }, { to: null, text: '시작합니다', targets: 2 });
  });

  it('ack 가 5초 안에 없으면 그 수신자는 ack_timeout 이다(결과 불명). 온 수신자는 delivered 다', async () => {
    const { chat, wire, clock } = rig();
    const sending = chat.send({ text: 'x' }, targets(['A', 'B']));
    chat.ack('A', wire[0]?.frame.id as string);
    let done = false;
    void sending.then(() => {
      done = true;
    });
    await clock.advance(LIMITS.CHAT_ACK_TIMEOUT_MS - 1);
    assert.equal(done, false, '기한 전에는 끝나지 않는다');
    await clock.advance(1);
    const { result } = await sending;
    assert.ok(result.ok);
    assert.deepEqual(result.delivered, ['A']);
    assert.deepEqual(result.undelivered, [{ name: 'B', reason: 'ack_timeout' }]);
  });

  it('링크가 없는 수신자는 not_connected 다. 방 전체 글에는 방에 있지만 링크가 없는 참가자도 실린다', async () => {
    const { chat, wire } = rig();
    const sending = chat.send({ text: 'x' }, targets(['A'], ['C']));
    chat.ack('A', wire[0]?.frame.id as string);
    const { result } = await sending;
    assert.ok(result.ok);
    assert.deepEqual(result.delivered, ['A']);
    assert.deepEqual(result.undelivered, [{ name: 'C', reason: 'not_connected' }]);
    assert.deepEqual(wire.map((entry) => entry.peer), ['A'], 'C 에게는 프레임이 가지 않는다');
  });

  it('대상 지정 글은 대상에게만 간다. 프레임의 to 에 대상이 실린다', async () => {
    const { chat, wire } = rig();
    const sending = chat.send({ text: 'x', to: ['B', 'B'] }, targets(['A', 'B']));
    assert.deepEqual(wire.map((entry) => entry.peer), ['B']);
    assert.deepEqual(wire[0]?.frame.to, ['B']);
    chat.ack('B', wire[0]?.frame.id as string);
    const { result } = await sending;
    assert.ok(result.ok);
    assert.deepEqual(result.delivered, ['B']);
  });

  it('모르는 수신자와 빈 to 는 INVALID_ARGUMENT 이고 아무에게도 보내지 않는다', async () => {
    const { chat, wire } = rig();
    const unknown = await chat.send({ text: 'x', to: ['A', 'Z'] }, targets(['A']));
    assert.deepEqual([unknown.result.ok, unknown.result.ok ? '' : unknown.result.code], [false, 'INVALID_ARGUMENT']);
    const empty = await chat.send({ text: 'x', to: [] }, targets(['A']));
    assert.equal(empty.result.ok ? '' : empty.result.code, 'INVALID_ARGUMENT');
    assert.equal(wire.length, 0);
  });

  it('보내는 중에 링크가 닫히면 그 수신자는 기다리지 않고 ack_timeout 으로 끝난다', async () => {
    const { chat } = rig();
    const sending = chat.send({ text: 'x' }, targets(['A']));
    chat.peerClosed('A');
    const { result } = await sending;
    assert.ok(result.ok);
    assert.deepEqual(result.undelivered, [{ name: 'A', reason: 'ack_timeout' }]);
  });

  it('다른 피어의 ack 와 다른 id 의 ack 는 전달로 치지 않는다', async () => {
    const { chat, wire, clock } = rig();
    const sending = chat.send({ text: 'x', to: ['A'] }, targets(['A', 'B']));
    const id = wire[0]?.frame.id as string;
    chat.ack('B', id);
    chat.ack('A', `${SID}-zz`);
    await clock.advance(LIMITS.CHAT_ACK_TIMEOUT_MS);
    const { result } = await sending;
    assert.ok(result.ok);
    assert.deepEqual(result.delivered, []);
    assert.deepEqual(result.undelivered, [{ name: 'A', reason: 'ack_timeout' }]);
  });

  it('close() 는 진행 중인 전송과 이후의 전송을 CANCELLED 로 끝낸다', async () => {
    const { chat } = rig();
    const sending = chat.send({ text: 'x' }, targets(['A']));
    chat.close();
    assert.equal((await sending).result.ok ? '' : ((await sending).result as { code: string }).code, 'CANCELLED');
    const later = await chat.send({ text: 'y' }, targets(['A']));
    assert.equal(later.result.ok ? '' : later.result.code, 'CANCELLED');
  });
});

describe('채팅 전달: 크기', () => {
  it('text 가 UTF-8 16384바이트면 보내고, 1바이트 넘으면 INVALID_ARGUMENT 다', async () => {
    const { chat, wire } = rig();
    const fits = chat.send({ text: 'a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES) }, targets(['A']));
    assert.equal(wire.length, 1);
    chat.ack('A', wire[0]?.frame.id as string);
    assert.equal((await fits).result.ok, true);

    const over = await chat.send({ text: 'a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES + 1) }, targets(['A']));
    assert.equal(over.result.ok ? '' : over.result.code, 'INVALID_ARGUMENT');
    // 한글은 글자당 3바이트다. 글자 수가 아니라 바이트로 잰다.
    const korean = await chat.send({ text: '가'.repeat(5462) }, targets(['A']));
    assert.equal(korean.result.ok ? '' : korean.result.code, 'INVALID_ARGUMENT');
    assert.equal(wire.length, 1, '넘는 글은 아무에게도 가지 않았다');
  });

  it('text 는 상한 안이어도 직렬화한 프레임이 65536바이트를 넘으면 INVALID_ARGUMENT 다', async () => {
    const { chat, wire } = rig();
    // 제어 문자는 직렬화하면 6바이트(\u0001)가 된다. 16384자면 프레임이 98KB 를 넘는다.
    const text = '\u0001'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES);
    const result = await chat.send({ text }, targets(['A']));
    assert.equal(result.result.ok ? '' : result.result.code, 'INVALID_ARGUMENT');
    assert.equal(wire.length, 0);
  });

  it('거절한 글은 메시지 순번을 쓰지 않는다', async () => {
    const { chat, wire } = rig();
    await chat.send({ text: 'a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES + 1) }, targets(['A']));
    void chat.send({ text: 'ok' }, targets(['A']));
    assert.equal(wire[0]?.frame.id, `${SID}-1`);
  });
});

describe('채팅 전달: 속도', () => {
  it('60초에 60건까지 보내고 61번째는 CHAT_RATE_LIMITED 다. 아무에게도 보내지 않는다', async () => {
    const { chat, wire, clock } = rig();
    for (let i = 0; i < LIMITS.CHAT_SEND_RATE_MAX; i += 1) {
      void chat.send({ text: `m${i}` }, targets(['A']));
      chat.ack('A', wire.at(-1)?.frame.id as string);
      await clock.advance(100);
    }
    assert.equal(wire.length, 60);
    const limited = await chat.send({ text: 'over' }, targets(['A']));
    assert.equal(limited.result.ok, false);
    assert.ok(!limited.result.ok && limited.result.code === 'CHAT_RATE_LIMITED');
    // 첫 글은 6초 전에 보냈다. 창에서 나가려면 54초가 남았다.
    assert.equal(limited.result.details.retry_after_ms, LIMITS.CHAT_RATE_WINDOW_MS - 60 * 100);
    assert.equal(wire.length, 60);
    assert.equal(limited.sent, null);
  });

  it('retry_after_ms 가 지나면 다시 보낼 수 있다', async () => {
    const { chat, wire, clock } = rig();
    for (let i = 0; i < LIMITS.CHAT_SEND_RATE_MAX; i += 1) {
      void chat.send({ text: 'x' }, targets(['A']));
      chat.ack('A', wire.at(-1)?.frame.id as string);
    }
    const limited = await chat.send({ text: 'over' }, targets(['A']));
    assert.ok(!limited.result.ok && limited.result.code === 'CHAT_RATE_LIMITED');
    await clock.advance(limited.result.details.retry_after_ms - 1);
    const still = await chat.send({ text: 'over' }, targets(['A']));
    assert.equal(still.result.ok ? '' : still.result.code, 'CHAT_RATE_LIMITED');
    await clock.advance(1);
    const before = wire.length;
    void chat.send({ text: 'again' }, targets(['A']));
    assert.equal(wire.length, before + 1);
  });

  it('거절한 글(크기, 모르는 수신자)은 속도 창에 세지 않는다', async () => {
    const { chat, wire } = rig();
    for (let i = 0; i < 100; i += 1) await chat.send({ text: 'x', to: ['Z'] }, targets(['A']));
    for (let i = 0; i < LIMITS.CHAT_SEND_RATE_MAX; i += 1) {
      void chat.send({ text: 'x' }, targets(['A']));
      chat.ack('A', wire.at(-1)?.frame.id as string);
    }
    assert.equal(wire.length, LIMITS.CHAT_SEND_RATE_MAX);
  });

  it('한 피어의 미확인 글이 50건을 넘으면 그 피어로의 새 전송은 바로 not_connected 다', async () => {
    const { chat, wire, clock } = rig();
    // 느린 피어 S 는 ack 를 하지 않는다. 보내는 쪽 속도 한도에 걸리지 않게 1.1초씩 띄운다.
    for (let i = 0; i < LIMITS.CHAT_UNACKED_MAX + 1; i += 1) {
      void chat.send({ text: 'x' }, targets(['S', 'F']));
      chat.ack('F', wire.at(-1)?.frame.id as string);
      await clock.advance(1100);
    }
    assert.equal(wire.filter((entry) => entry.peer === 'S').length, 51);
    const blocked = chat.send({ text: 'x' }, targets(['S', 'F']));
    assert.equal(wire.filter((entry) => entry.peer === 'S').length, 51, 'S 에게는 더 보내지 않는다');
    chat.ack('F', wire.at(-1)?.frame.id as string);
    const { result } = await blocked;
    assert.ok(result.ok);
    assert.deepEqual(result.delivered, ['F']);
    assert.deepEqual(result.undelivered, [{ name: 'S', reason: 'not_connected' }]);

    // 늦은 ack 가 오면 다시 보낼 수 있다.
    chat.ack('S', wire.find((entry) => entry.peer === 'S')?.frame.id as string);
    await clock.advance(61 * SEC);
    void chat.send({ text: 'x' }, targets(['S']));
    assert.equal(wire.filter((entry) => entry.peer === 'S').length, 52);
  });
});

describe('채팅 전달: resend_of', () => {
  it('같은 id 와 원문으로, 처음에 전달되지 않은 참가자 가운데 지금 연결된 참가자에게만 다시 보낸다', async () => {
    const { chat, wire, clock } = rig();
    const first = chat.send({ text: '원문' }, targets(['A', 'B'], ['C']));
    const id = wire[0]?.frame.id as string;
    chat.ack('A', id);
    await clock.advance(LIMITS.CHAT_ACK_TIMEOUT_MS);
    const firstResult = (await first).result;
    assert.ok(firstResult.ok);
    assert.deepEqual(firstResult.undelivered, [
      { name: 'B', reason: 'ack_timeout' },
      { name: 'C', reason: 'not_connected' },
    ]);

    wire.length = 0;
    // text 를 줘도 무시하고 원문을 쓴다. C 는 이제 연결됐고, 새로 들어온 D 는 대상이 아니다.
    const again = chat.send({ text: '다른 글', resend_of: id }, targets(['A', 'B', 'C', 'D']));
    assert.deepEqual(wire.map((entry) => entry.peer), ['B', 'C'], '이미 받은 A 와 새로 온 D 에게는 가지 않는다');
    assert.deepEqual(wire.map((entry) => [entry.frame.id, entry.frame.text]), [
      [id, '원문'],
      [id, '원문'],
    ]);
    chat.ack('B', id);
    chat.ack('C', id);
    const { result, sent } = await again;
    assert.deepEqual(result, { ok: true, message_id: id, delivered: ['B', 'C'], undelivered: [] });
    assert.equal(sent?.text, '원문');

    // 모두 받았으면 다시 보낼 대상이 없다.
    wire.length = 0;
    const none = await chat.send({ text: '', resend_of: id }, targets(['A', 'B', 'C']));
    assert.deepEqual(none.result, { ok: true, message_id: id, delivered: [], undelivered: [] });
    assert.equal(wire.length, 0);
  });

  it('다시 보낼 때도 연결되지 않은 참가자는 not_connected 로 남는다', async () => {
    const { chat, wire } = rig();
    const first = await chat.send({ text: 'x', to: ['C'] }, { open: [], absent: ['C'], known: ['C'] });
    assert.ok(first.result.ok);
    const again = await chat.send({ text: 'x', resend_of: first.result.message_id }, targets([], ['C']));
    assert.ok(again.result.ok);
    assert.deepEqual(again.result.undelivered, [{ name: 'C', reason: 'not_connected' }]);
    assert.equal(wire.length, 0);
  });

  it('버퍼에 없는 id 는 INVALID_ARGUMENT 다', async () => {
    const { chat } = rig();
    const result = await chat.send({ text: 'x', resend_of: `${SID}-9` }, targets(['A']));
    assert.equal(result.result.ok ? '' : result.result.code, 'INVALID_ARGUMENT');
  });

  it('보낸 버퍼는 최근 것만 갖는다. 밀려난 id 는 다시 보낼 수 없다', async () => {
    const { chat, wire, clock } = rig(3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      void chat.send({ text: `m${i}` }, targets(['A']));
      ids.push(wire.at(-1)?.frame.id as string);
    }
    await clock.advance(LIMITS.CHAT_ACK_TIMEOUT_MS);
    const oldest = await chat.send({ text: '', resend_of: ids[0] as string }, targets(['A']));
    assert.equal(oldest.result.ok ? '' : oldest.result.code, 'INVALID_ARGUMENT');
    const kept = chat.send({ text: '', resend_of: ids[1] as string }, targets(['A']));
    chat.ack('A', ids[1] as string);
    assert.equal((await kept).result.ok, true);
  });

  it('기한 뒤에 온 ack 는 다음 resend_of 의 대상에서 그 참가자를 뺀다', async () => {
    const { chat, wire, clock } = rig();
    const first = chat.send({ text: 'x' }, targets(['A']));
    const id = wire[0]?.frame.id as string;
    await clock.advance(LIMITS.CHAT_ACK_TIMEOUT_MS);
    await first;
    chat.ack('A', id);
    wire.length = 0;
    const again = await chat.send({ text: '', resend_of: id }, targets(['A']));
    assert.deepEqual(again.result, { ok: true, message_id: id, delivered: [], undelivered: [] });
    assert.equal(wire.length, 0);
  });
});

describe('채팅 전달: 받기', () => {
  it('처음 본 id 는 new, 다시 온 id 는 duplicate 다', () => {
    const { chat } = rig();
    assert.deepEqual(chat.accept('A', chatFrame('aaaaaaaaaaaa-1'), 'me'), { kind: 'new', to: 'room' });
    assert.deepEqual(chat.accept('A', chatFrame('aaaaaaaaaaaa-1'), 'me'), { kind: 'duplicate' });
    assert.deepEqual(chat.accept('A', chatFrame('aaaaaaaaaaaa-2', ['me', 'B']), 'me'), { kind: 'new', to: 'you' });
  });

  it('나를 지정하지 않은 대상 지정 글은 받지 않는다', () => {
    const { chat } = rig();
    assert.deepEqual(chat.accept('A', chatFrame('aaaaaaaaaaaa-1', ['B']), 'me'), { kind: 'misaddressed' });
    // 버린 글의 id 는 본 것으로 치지 않는다.
    assert.deepEqual(chat.accept('A', chatFrame('aaaaaaaaaaaa-1', ['me']), 'me'), { kind: 'new', to: 'you' });
  });

  it('최근 4096개의 id 만 기억한다', () => {
    const { chat, clock } = rig();
    const id = (n: number): string => `aaaaaaaaaaaa-${n.toString(36)}`;
    for (let n = 0; n <= LIMITS.SEEN_ID_CAPACITY; n += 1) {
      // 받는 쪽 속도 한도에 걸리지 않게 시간을 띄운다.
      if (n % 100 === 0) clock.jump(LIMITS.CHAT_RATE_WINDOW_MS);
      assert.equal(chat.accept('A', chatFrame(id(n)), 'me').kind, 'new');
    }
    clock.jump(LIMITS.CHAT_RATE_WINDOW_MS);
    assert.equal(chat.accept('A', chatFrame(id(1)), 'me').kind, 'duplicate', '아직 기억한다');
    assert.equal(chat.accept('A', chatFrame(id(0)), 'me').kind, 'new', '가장 오래된 것은 밀려났다');
  });

  it('한 피어에게서 60초에 120건을 넘으면 넘는 것을 버린다. 다른 피어는 영향이 없다', async () => {
    const { chat, clock } = rig();
    for (let n = 0; n < LIMITS.CHAT_RECV_RATE_MAX; n += 1) {
      assert.equal(chat.accept('A', chatFrame(`aaaaaaaaaaaa-${n.toString(36)}`), 'me').kind, 'new');
    }
    assert.deepEqual(chat.accept('A', chatFrame('aaaaaaaaaaaa-zz'), 'me'), { kind: 'rate_exceeded' });
    assert.equal(chat.accept('B', chatFrame('bbbbbbbbbbbb-1'), 'me').kind, 'new');
    await clock.advance(LIMITS.CHAT_RATE_WINDOW_MS);
    assert.equal(chat.accept('A', chatFrame('aaaaaaaaaaaa-zz'), 'me').kind, 'new', '창이 지나면 다시 받는다');
    await flushMicrotasks();
  });
});
