import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from './limits.js';
import {
  BYE_REASONS,
  P2P_FRAME_TYPES,
  encodeP2PFrame,
  packStateFrames,
  parseP2PFrame,
  type ChatFrame,
  type P2PFrame,
} from './p2p-wire.js';
import { parseStateRecord, recordByteSize, type StateRecord } from './state-records.js';

const SID = 'k3x9q0ab12cd';
const FP = '0123456789ab';

function parse(frame: unknown) {
  return parseP2PFrame(JSON.stringify(frame));
}

function expectCode(frame: unknown, code: string): void {
  const result = parse(frame);
  assert.equal(result.ok, false, JSON.stringify(frame).slice(0, 120));
  assert.equal(result.ok ? '' : result.code, code, result.ok ? '' : result.detail);
}

function expectFrame(frame: unknown): void {
  assert.deepEqual(parse(frame), { ok: true, value: frame, invalidRecords: 0 });
}

function claimRecord(seq: number, observed = '표시가 떴다'): StateRecord {
  const parsed = parseStateRecord({
    kind: 'claim',
    rid: `${SID}-${seq.toString(36)}`,
    author: 'claude-4kq2',
    lc: 1794700000000 + seq,
    wall: 1794700000000 + seq,
    body: {
      test_id: `${SID}-1`,
      scenario: `${SID}-2`,
      action: '손들기',
      expected: null,
      observed,
      outcome: 'pass',
      steps: '1. 입장 2. 클릭',
    },
  });
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}

describe('parseP2PFrame: 타입별 통과 표본', () => {
  it('타입은 여덟 개다', () => {
    assert.deepEqual([...P2P_FRAME_TYPES], ['hello', 'state', 'sync_end', 'chat', 'ack', 'ping', 'pong', 'bye']);
  });

  it('hello', () => {
    expectFrame({
      v: 1,
      t: 'hello',
      peer: 'claude-4kq2',
      sid: SID,
      wall: 1794700000000,
      client: { name: 'agent-chat', version: '0.1.0' },
    });
  });

  it('chat: 방 전체(to=null)와 대상 지정', () => {
    expectFrame({ v: 1, t: 'chat', id: `${SID}-1a`, to: null, text: '강사 화면에서 손들기 표시가 보입니다', wall: 1 });
    expectFrame({ v: 1, t: 'chat', id: `${SID}-1b`, to: ['codex-7f3k', 'gemini-1'], text: '', wall: 0 });
  });

  it('ack, ping, pong', () => {
    expectFrame({ v: 1, t: 'ack', id: `${SID}-1a` });
    expectFrame({ v: 1, t: 'ping', n: 0, sc: 0, sf: 'e3b0c44298fc' });
    expectFrame({ v: 1, t: 'ping', n: 41, sc: 17, sf: FP });
    expectFrame({ v: 1, t: 'pong', n: 41 });
  });

  it('bye 의 사유는 네 가지다', () => {
    assert.deepEqual([...BYE_REASONS], ['leave', 'shutdown', 'version', 'protocol_error']);
    for (const reason of BYE_REASONS) expectFrame({ v: 1, t: 'bye', reason });
    expectCode({ v: 1, t: 'bye', reason: 'bored' }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'bye' }, 'BAD_FRAME');
  });

  it('모르는 필드는 버린다', () => {
    assert.deepEqual(parse({ v: 1, t: 'pong', n: 3, later: true }), {
      ok: true,
      value: { v: 1, t: 'pong', n: 3 },
      invalidRecords: 0,
    });
  });
});

describe('parseP2PFrame: sync_end', () => {
  it('테스트가 없으면 count 만 싣는다', () => {
    expectFrame({ v: 1, t: 'sync_end', count: 0 });
    expectFrame({ v: 1, t: 'sync_end', count: 12 });
  });

  it('테스트가 있으면 test_id 와 test_elapsed_ms 를 함께 싣는다', () => {
    expectFrame({ v: 1, t: 'sync_end', count: 12, test_id: `${SID}-1`, test_elapsed_ms: 600000 });
    expectFrame({ v: 1, t: 'sync_end', count: 12, test_id: `${SID}-1`, test_elapsed_ms: 0 });
  });

  it('답에는 sf 가 붙는다', () => {
    expectFrame({ v: 1, t: 'sync_end', count: 12, sf: FP });
    expectFrame({ v: 1, t: 'sync_end', count: 12, test_id: `${SID}-1`, test_elapsed_ms: 5, sf: FP });
  });

  it('test_id 와 test_elapsed_ms 가운데 하나만 있으면 거절한다', () => {
    expectCode({ v: 1, t: 'sync_end', count: 12, test_id: `${SID}-1` }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 12, test_elapsed_ms: 600000 }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 12, test_elapsed_ms: 600000, sf: FP }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 12, test_id: `${SID}-1`, test_elapsed_ms: null }, 'BAD_FRAME');
  });

  it('경과 시간은 0 이상의 정수다', () => {
    expectCode({ v: 1, t: 'sync_end', count: 1, test_id: `${SID}-1`, test_elapsed_ms: -1 }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 1, test_id: `${SID}-1`, test_elapsed_ms: 0.5 }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 1, test_id: `${SID}-1`, test_elapsed_ms: '600000' }, 'BAD_FRAME');
  });

  it('count, test_id, sf 의 형식을 본다', () => {
    expectCode({ v: 1, t: 'sync_end' }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: -1 }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 1, test_id: 'bad', test_elapsed_ms: 1 }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 1, sf: 'XYZ' }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'sync_end', count: 1, sf: '0123456789abc' }, 'BAD_FRAME');
  });
});

describe('parseP2PFrame: 버전과 타입', () => {
  it('v 가 다른 프레임은 타입과 모양이 어떻든 VERSION_MISMATCH 다', () => {
    for (const frame of [
      { v: 2, t: 'hello', peer: 'a', sid: SID, wall: 1, client: { name: 'x', version: '9' } },
      { v: 2, t: 'brand_new_type', payload: {} },
      { v: 0, t: 'ping' },
      { v: 2 },
    ]) {
      const result = parse(frame);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.code, 'VERSION_MISMATCH');
      assert.equal(result.theirVersion, frame.v);
    }
  });

  it('v 가 없거나 정수가 아니면 BAD_FRAME 이다', () => {
    expectCode({ t: 'pong', n: 1 }, 'BAD_FRAME');
    expectCode({ v: '1', t: 'pong', n: 1 }, 'BAD_FRAME');
    expectCode({ v: 1.5, t: 'pong', n: 1 }, 'BAD_FRAME');
    expectCode({ v: null, t: 'pong', n: 1 }, 'BAD_FRAME');
  });

  it('같은 버전의 모르는 타입은 UNKNOWN_TYPE 이다', () => {
    expectCode({ v: 1, t: 'control', action: 'stop' }, 'UNKNOWN_TYPE');
    expectCode({ v: 1, t: 'presence' }, 'UNKNOWN_TYPE');
    expectCode({ v: 1 }, 'UNKNOWN_TYPE');
    expectCode({ v: 1, t: 5 }, 'UNKNOWN_TYPE');
  });

  it('JSON 이 아니거나 객체가 아니면 BAD_FRAME 이다', () => {
    for (const text of ['', 'hello', '{', '[]', '"ping"', '1', 'null']) {
      const result = parseP2PFrame(text);
      assert.equal(result.ok ? '' : result.code, 'BAD_FRAME', text);
    }
  });
});

describe('parseP2PFrame: hello 와 chat 의 검증', () => {
  const hello = { v: 1, t: 'hello', peer: 'claude-4kq2', sid: SID, wall: 1, client: { name: 'agent-chat', version: '0.1.0' } };
  const chat = { v: 1, t: 'chat', id: `${SID}-1a`, to: null, text: 'hi', wall: 1 };

  it('hello 의 peer·sid·client 형식을 본다', () => {
    expectCode({ ...hello, peer: 'system' }, 'BAD_FRAME');
    expectCode({ ...hello, peer: 'bad name' }, 'BAD_FRAME');
    expectCode({ ...hello, sid: 'short' }, 'BAD_FRAME');
    expectCode({ ...hello, wall: -5 }, 'BAD_FRAME');
    expectCode({ ...hello, client: { name: 'agent-chat' } }, 'BAD_FRAME');
    expectCode({ ...hello, client: 'agent-chat' }, 'BAD_FRAME');
    const { client: _client, ...noClient } = hello;
    expectCode(noClient, 'BAD_FRAME');
  });

  it('chat 의 id 와 to 형식을 본다', () => {
    expectCode({ ...chat, id: 'm1' }, 'BAD_FRAME');
    expectCode({ ...chat, to: [] }, 'BAD_FRAME');
    expectCode({ ...chat, to: 'codex-7f3k' }, 'BAD_FRAME');
    expectCode({ ...chat, to: ['room'] }, 'BAD_FRAME');
    expectCode({ ...chat, to: ['ok', 'not ok'] }, 'BAD_FRAME');
    const { to: _to, ...noTo } = chat;
    expectCode(noTo, 'BAD_FRAME');
    expectCode({ ...chat, text: 5 }, 'BAD_FRAME');
    expectCode({ ...chat, wall: '1' }, 'BAD_FRAME');
  });

  it('chat.text 는 UTF-8 16384바이트까지다', () => {
    expectFrame({ ...chat, text: 'a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES) });
    expectCode({ ...chat, text: 'a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES + 1) }, 'BAD_FRAME');
    // 한글 5461자 = 16383바이트, 5462자 = 16386바이트
    expectFrame({ ...chat, text: '가'.repeat(5461) });
    expectCode({ ...chat, text: '가'.repeat(5462) }, 'BAD_FRAME');
  });

  it('ack·ping·pong 의 필드 형식을 본다', () => {
    expectCode({ v: 1, t: 'ack' }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'ack', id: 7 }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'ping', n: 1, sc: 1 }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'ping', n: 1, sc: -1, sf: FP }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'ping', n: 1, sc: 1, sf: 'not-a-print' }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'pong' }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'pong', n: 1.2 }, 'BAD_FRAME');
  });
});

describe('프레임 크기 (직렬화한 뒤 65536바이트)', () => {
  /** 제어 문자는 직렬화하면 6바이트(\u0001)가 된다. 글 16384바이트 안에서 프레임만 키울 수 있다. */
  function chatOfFrameBytes(target: number): ChatFrame {
    const empty: ChatFrame = { v: 1, t: 'chat', id: `${SID}-1a`, to: null, text: '', wall: 1 };
    const base = Buffer.byteLength(JSON.stringify(empty));
    const controls = 10000;
    const plain = target - base - controls * 6;
    const frame: ChatFrame = { ...empty, text: '\u0001'.repeat(controls) + 'a'.repeat(plain) };
    assert.ok(Buffer.byteLength(frame.text) <= LIMITS.CHAT_MAX_TEXT_BYTES);
    assert.equal(Buffer.byteLength(JSON.stringify(frame)), target);
    return frame;
  }

  it('정확히 65536바이트인 프레임은 보내고 받는다', () => {
    const frame = chatOfFrameBytes(LIMITS.P2P_MAX_FRAME_BYTES);
    const encoded = encodeP2PFrame(frame);
    assert.equal(encoded.ok, true);
    if (!encoded.ok) return;
    assert.equal(Buffer.byteLength(encoded.value), 65536);
    assert.deepEqual(parseP2PFrame(encoded.value), { ok: true, value: frame, invalidRecords: 0 });
  });

  it('65537바이트는 보내기 전에도 받을 때도 FRAME_TOO_LARGE 다', () => {
    const frame = chatOfFrameBytes(LIMITS.P2P_MAX_FRAME_BYTES + 1);
    const encoded = encodeP2PFrame(frame);
    assert.equal(encoded.ok, false);
    assert.equal(encoded.ok ? '' : encoded.code, 'FRAME_TOO_LARGE');
    const received = parseP2PFrame(JSON.stringify(frame));
    assert.equal(received.ok ? '' : received.code, 'FRAME_TOO_LARGE');
  });

  it('글은 상한 안이어도 직렬화하면 프레임 상한을 넘을 수 있다', () => {
    const text = '\u0001'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES);
    assert.equal(Buffer.byteLength(text), LIMITS.CHAT_MAX_TEXT_BYTES);
    const encoded = encodeP2PFrame({ v: 1, t: 'chat', id: `${SID}-1a`, to: null, text, wall: 1 });
    assert.equal(encoded.ok ? '' : encoded.code, 'FRAME_TOO_LARGE');
    // 따옴표만으로는 2배라 넘지 않는다
    const quotes = encodeP2PFrame({ v: 1, t: 'chat', id: `${SID}-1a`, to: null, text: '"'.repeat(16384), wall: 1 });
    assert.equal(quotes.ok, true);
  });

  it('크기를 넘는 프레임은 JSON 이 아니어도 FRAME_TOO_LARGE 다', () => {
    const result = parseP2PFrame('x'.repeat(LIMITS.P2P_MAX_FRAME_BYTES + 1));
    assert.equal(result.ok ? '' : result.code, 'FRAME_TOO_LARGE');
  });

  it('encodeP2PFrame 으로 만든 것을 parseP2PFrame 이 그대로 읽는다', () => {
    const frames: P2PFrame[] = [
      { v: 1, t: 'hello', peer: 'a', sid: SID, wall: 5, client: { name: 'agent-chat', version: '0.1.0' } },
      { v: 1, t: 'state', records: [claimRecord(5)], snap: true },
      { v: 1, t: 'state', records: [claimRecord(6)] },
      { v: 1, t: 'sync_end', count: 2, test_id: `${SID}-1`, test_elapsed_ms: 1234, sf: FP },
      { v: 1, t: 'chat', id: `${SID}-1a`, to: ['b'], text: '줄\n바꿈 "따옴표"', wall: 9 },
      { v: 1, t: 'ack', id: `${SID}-1a` },
      { v: 1, t: 'ping', n: 1, sc: 2, sf: FP },
      { v: 1, t: 'pong', n: 1 },
      { v: 1, t: 'bye', reason: 'leave' },
    ];
    for (const frame of frames) {
      const encoded = encodeP2PFrame(frame);
      assert.equal(encoded.ok, true);
      if (!encoded.ok) continue;
      assert.deepEqual(parseP2PFrame(encoded.value), { ok: true, value: frame, invalidRecords: 0 });
    }
  });
});

describe('encodeP2PFrame: 받는 쪽이 거절할 프레임을 만들지 않는다', () => {
  const chat = (text: string): ChatFrame => ({ v: 1, t: 'chat', id: `${SID}-1a`, to: null, text, wall: 1 });

  it('chat.text 가 16384바이트를 넘으면 프레임이 상한 안이어도 BAD_FRAME 이다', () => {
    const over = encodeP2PFrame(chat('a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES + 1)));
    assert.equal(over.ok, false);
    assert.equal(over.ok ? '' : over.code, 'BAD_FRAME');
    assert.match(over.ok ? '' : over.detail, /^text: /);
    assert.equal(encodeP2PFrame(chat('a'.repeat(20000))).ok, false);
    assert.equal(encodeP2PFrame(chat('가'.repeat(5462))).ok, false, '한글 5462자는 16386바이트다');
    assert.equal(encodeP2PFrame(chat('a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES))).ok, true);
    assert.equal(encodeP2PFrame(chat('가'.repeat(5461))).ok, true);
  });

  it('스키마에 걸리는 프레임은 BAD_FRAME 이다', () => {
    const bad: unknown[] = [
      { v: 1, t: 'chat', id: 'not-an-id', to: null, text: 'x', wall: 1 },
      { v: 1, t: 'chat', id: `${SID}-1a`, to: [], text: 'x', wall: 1 },
      { v: 1, t: 'chat', id: `${SID}-1a`, to: ['all'], text: 'x', wall: 1 },
      { v: 2, t: 'ack', id: `${SID}-1a` },
      { v: 1, t: 'hello', peer: 'system', sid: SID, wall: 1, client: { name: 'a', version: '1' } },
      { v: 1, t: 'sync_end', count: 1, test_id: `${SID}-1` },
      { v: 1, t: 'ping', n: 1, sc: 1, sf: 'short' },
      { v: 1, t: 'bye', reason: 'bored' },
      { v: 1, t: 'relay', to: 'b', text: 'x' },
      { v: 1 },
      { v: 1, t: 'state', records: 'none' },
      { v: 1, t: 'state', records: [{ kind: 'claim' }] },
      { v: 1, t: 'state', records: [claimRecord(1), { ...claimRecord(2), author: 'system' }] },
    ];
    for (const frame of bad) {
      const encoded = encodeP2PFrame(frame as P2PFrame);
      assert.equal(encoded.ok, false, JSON.stringify(frame).slice(0, 100));
      assert.equal(encoded.ok ? '' : encoded.code, 'BAD_FRAME', JSON.stringify(frame).slice(0, 100));
      // 받는 쪽도 같은 프레임을 그대로는 받지 않는다(state 는 나쁜 기록만 버린다)
      const received = parseP2PFrame(JSON.stringify(frame));
      assert.ok(!received.ok || received.invalidRecords > 0, JSON.stringify(frame).slice(0, 100));
    }
  });

  it('통과시킨 것은 받는 쪽이 버리는 기록 없이 받는다', () => {
    const frames: P2PFrame[] = [
      chat('a'.repeat(LIMITS.CHAT_MAX_TEXT_BYTES)),
      { v: 1, t: 'state', records: [claimRecord(1), claimRecord(2)], snap: true },
      { v: 1, t: 'sync_end', count: 0 },
    ];
    for (const frame of frames) {
      const encoded = encodeP2PFrame(frame);
      assert.equal(encoded.ok, true);
      if (!encoded.ok) continue;
      const received = parseP2PFrame(encoded.value);
      assert.equal(received.ok, true);
      assert.equal(received.ok ? received.invalidRecords : -1, 0);
    }
  });

  it('모르는 필드는 싣지 않는다', () => {
    const encoded = encodeP2PFrame({ v: 1, t: 'pong', n: 1, extra: 'x' } as unknown as P2PFrame);
    assert.deepEqual(encoded, { ok: true, value: '{"v":1,"t":"pong","n":1}' });
  });

  it('객체가 아닌 값에도 던지지 않는다', () => {
    for (const value of [null, undefined, 'chat', 1, [], [{ v: 1, t: 'pong', n: 1 }]]) {
      assert.doesNotThrow(() => encodeP2PFrame(value as unknown as P2PFrame));
      const encoded = encodeP2PFrame(value as unknown as P2PFrame);
      assert.equal(encoded.ok ? '' : encoded.code, 'BAD_FRAME');
    }
  });
});

describe('공개 표는 실행 중에 바뀌지 않는다 (P2P)', () => {
  it('타입 목록과 bye 사유 목록이 얼어 있다', () => {
    assert.ok(Object.isFrozen(P2P_FRAME_TYPES));
    assert.ok(Object.isFrozen(BYE_REASONS));
    assert.throws(() => (P2P_FRAME_TYPES as unknown as string[]).push('x'), TypeError);
    assert.throws(() => (BYE_REASONS as unknown as string[]).push('x'), TypeError);
    assert.equal(P2P_FRAME_TYPES.length, 8);
  });

  it('목록을 바꾸려 한 뒤에도 모르는 타입은 UNKNOWN_TYPE 이고 던지지 않는다', () => {
    try {
      (P2P_FRAME_TYPES as unknown as string[]).push('x');
    } catch {
      // 얼어 있어 던진다
    }
    assert.doesNotThrow(() => parseP2PFrame('{"v":1,"t":"x"}'));
    expectCode({ v: 1, t: 'x' }, 'UNKNOWN_TYPE');
    // 객체의 기본 속성 이름도 타입이 아니다
    for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.doesNotThrow(() => parse({ v: 1, t }), t);
      expectCode({ v: 1, t }, 'UNKNOWN_TYPE');
    }
  });
});

describe('parseP2PFrame: state', () => {
  it('스냅샷(snap: true)과 변경(snap 없음)을 받는다', () => {
    const records = [claimRecord(5), claimRecord(6)];
    assert.deepEqual(parse({ v: 1, t: 'state', records, snap: true }), {
      ok: true,
      value: { v: 1, t: 'state', records, snap: true },
      invalidRecords: 0,
    });
    assert.deepEqual(parse({ v: 1, t: 'state', records }), {
      ok: true,
      value: { v: 1, t: 'state', records },
      invalidRecords: 0,
    });
    assert.deepEqual(parse({ v: 1, t: 'state', records: [], snap: true }), {
      ok: true,
      value: { v: 1, t: 'state', records: [], snap: true },
      invalidRecords: 0,
    });
  });

  it('검증에 걸린 기록만 버리고 건수를 알려 준다', () => {
    const good = claimRecord(5);
    const result = parse({
      v: 1,
      t: 'state',
      records: [
        good,
        { ...good, kind: 'unknown-kind' },
        { ...good, rid: 'bad' },
        null,
        {
          kind: 'presence',
          key: 'presence/someone-else',
          author: 'claude-4kq2',
          lc: 1,
          wall: 1,
          body: { client: 'c', tools: [], role: null, status: 'ready', listening: true, note: null },
        },
        claimRecord(7),
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.invalidRecords, 4);
    assert.equal(result.value.t, 'state');
    assert.deepEqual(result.value.t === 'state' && result.value.records, [good, claimRecord(7)]);
  });

  it('records 가 배열이 아니거나 snap 이 불리언이 아니면 프레임 전체가 BAD_FRAME 이다', () => {
    expectCode({ v: 1, t: 'state' }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'state', records: { 0: claimRecord(5) } }, 'BAD_FRAME');
    expectCode({ v: 1, t: 'state', records: [], snap: 'yes' }, 'BAD_FRAME');
  });
});

describe('packStateFrames: 49152바이트를 목표로 나눠 담는다', () => {
  function unpack(frames: readonly string[]): { records: StateRecord[]; snaps: (boolean | undefined)[] } {
    const records: StateRecord[] = [];
    const snaps: (boolean | undefined)[] = [];
    for (const text of frames) {
      const parsed = parseP2PFrame(text);
      assert.equal(parsed.ok, true);
      if (!parsed.ok || parsed.value.t !== 'state') throw new Error('not a state frame');
      assert.equal(parsed.invalidRecords, 0);
      records.push(...parsed.value.records);
      snaps.push(parsed.value.snap);
    }
    return { records, snaps };
  }

  it('기록이 없으면 프레임도 없다', () => {
    assert.deepEqual(packStateFrames([], { snap: true }), { ok: true, value: [] });
  });

  it('작은 묶음은 프레임 하나에 든다', () => {
    const records = [claimRecord(5), claimRecord(6), claimRecord(7)];
    const packed = packStateFrames(records, { snap: true });
    assert.equal(packed.ok, true);
    if (!packed.ok) return;
    assert.equal(packed.value.length, 1);
    assert.deepEqual(unpack(packed.value), { records, snaps: [true] });
  });

  it('변경에는 snap 을 싣지 않는다', () => {
    const packed = packStateFrames([claimRecord(5)], { snap: false });
    assert.equal(packed.ok, true);
    if (!packed.ok) return;
    assert.equal(packed.value[0]?.includes('snap'), false);
    assert.deepEqual(unpack(packed.value).snaps, [undefined]);
  });

  it('큰 묶음은 순서를 지키며 여러 프레임으로 나뉘고, 프레임마다 목표 크기 이하다', () => {
    const records: StateRecord[] = [];
    for (let i = 0; i < 120; i += 1) records.push(claimRecord(100 + i, 'x'.repeat(3000)));
    const packed = packStateFrames(records, { snap: true });
    assert.equal(packed.ok, true);
    if (!packed.ok) return;
    assert.ok(packed.value.length > 1);
    for (const frame of packed.value) {
      assert.ok(Buffer.byteLength(frame) <= LIMITS.STATE_FRAME_TARGET_BYTES, `${Buffer.byteLength(frame)}`);
    }
    const unpacked = unpack(packed.value);
    assert.deepEqual(unpacked.records, records);
    assert.ok(unpacked.snaps.every((snap) => snap === true));
    // 나눌 때 빈 공간을 크게 남기지 않는다: 마지막을 뺀 프레임은 기록 하나만큼도 비어 있지 않다
    const one = recordByteSize(records[0] as StateRecord);
    for (const frame of packed.value.slice(0, -1)) {
      assert.ok(Buffer.byteLength(frame) + one + 1 > LIMITS.STATE_FRAME_TARGET_BYTES);
    }
  });

  it('상한에 가까운 기록 하나도 한 프레임에 든다', () => {
    const big = parseStateRecord({
      kind: 'presence',
      key: 'presence/claude-4kq2',
      author: 'claude-4kq2',
      lc: 1,
      wall: 1,
      body: {
        client: 'claude-code',
        tools: [...Array(7).fill('t'.repeat(4096)), 't'.repeat(3700)],
        role: null,
        status: 'ready',
        listening: true,
        note: null,
      },
    });
    assert.equal(big.ok, true);
    if (!big.ok) return;
    assert.ok(recordByteSize(big.value) > 32000);
    const packed = packStateFrames([big.value, big.value], { snap: true });
    assert.equal(packed.ok, true);
    if (!packed.ok) return;
    assert.equal(packed.value.length, 2);
    for (const frame of packed.value) {
      assert.ok(Buffer.byteLength(frame) <= LIMITS.STATE_FRAME_TARGET_BYTES);
    }
    assert.deepEqual(unpack(packed.value).records, [big.value, big.value]);
  });
});

describe('packStateFrames: 받는 쪽이 버릴 기록은 싣지 않는다', () => {
  function expectBadFrame(records: readonly unknown[], detail: RegExp): void {
    // 타입으로는 막히는 값이다. 검증을 빠뜨린 호출자를 흉내 낸다.
    const packed = packStateFrames(records as readonly StateRecord[], { snap: true });
    assert.equal(packed.ok, false);
    if (packed.ok) return;
    assert.equal(packed.code, 'BAD_FRAME');
    assert.match(packed.detail, detail);
  }

  it('글자 필드가 4096바이트를 넘는 기록은 BAD_FRAME 이다', () => {
    const good = claimRecord(5);
    const long = { ...good, body: { ...good.body, observed: 'x'.repeat(LIMITS.STATE_TEXT_FIELD_MAX_BYTES + 1) } };
    assert.equal(parseStateRecord(long).ok, false);
    expectBadFrame([long], /^records\.0: /);
  });

  it('직렬화한 크기가 32768바이트를 넘는 기록은 BAD_FRAME 이다', () => {
    const huge = {
      kind: 'presence',
      key: 'presence/claude-4kq2',
      author: 'claude-4kq2',
      lc: 1,
      wall: 1,
      body: { client: 'c', tools: Array(12).fill('t'.repeat(4096)), role: null, status: 'ready', listening: true, note: null },
    };
    const alone = parseStateRecord(huge);
    assert.equal(alone.ok ? '' : alone.code, 'RECORD_TOO_LARGE');
    expectBadFrame([huge], /^records\.0: record is \d+ bytes; the limit is 32768$/);
  });

  it('스키마에 맞지 않는 기록(모르는 kind, 남의 presence, 범위를 넘은 lc)은 BAD_FRAME 이다', () => {
    const good = claimRecord(5);
    expectBadFrame([{ ...good, kind: 'unknown-kind' }], /^records\.0: /);
    expectBadFrame([null], /^records\.0: /);
    expectBadFrame(
      [
        {
          kind: 'presence',
          key: 'presence/someone-else',
          author: 'claude-4kq2',
          lc: 1,
          wall: 1,
          body: { client: 'c', tools: [], role: null, status: 'ready', listening: true, note: null },
        },
      ],
      /^records\.0: /,
    );
    expectBadFrame([{ ...good, lc: 2 ** 53 }], /^records\.0: lc: /);
  });

  it('하나만 걸려도 프레임을 하나도 만들지 않고, 걸린 기록의 순번을 알려 준다', () => {
    const records: unknown[] = [];
    for (let i = 0; i < 40; i += 1) records.push(claimRecord(100 + i, 'x'.repeat(3000)));
    // 앞의 기록만으로 프레임 둘이 차는 묶음이다. 마지막 하나가 걸린다.
    const fits = packStateFrames(records as readonly StateRecord[], { snap: true });
    assert.ok(fits.ok && fits.value.length > 2);
    records.push({ ...claimRecord(999), rid: 'bad' });
    expectBadFrame(records, /^records\.40: /);
  });

  it('encodeP2PFrame 과 같은 기록을 거절한다', () => {
    const good = claimRecord(5);
    const samples: unknown[] = [
      { ...good, body: { ...good.body, steps: '가'.repeat(1366) } },
      { ...good, author: 'system' },
      { ...good, wall: -1 },
      { ...good, body: { ...good.body, outcome: 'maybe' } },
    ];
    for (const sample of samples) {
      const frame = { v: 1, t: 'state', records: [sample] } as unknown as P2PFrame;
      const encoded = encodeP2PFrame(frame);
      const packed = packStateFrames([sample] as readonly StateRecord[], { snap: false });
      assert.equal(encoded.ok, false, JSON.stringify(sample).slice(0, 80));
      assert.deepEqual(packed, encoded);
    }
  });

  it('모르는 필드는 싣지 않는다. 받는 쪽이 읽은 값과 보낸 값이 같다', () => {
    const good = claimRecord(5);
    const extra = { ...good, secret: 'leak', body: { ...good.body, hidden: 'leak' } };
    const packed = packStateFrames([extra as StateRecord], { snap: false });
    assert.equal(packed.ok, true);
    if (!packed.ok) return;
    assert.equal(packed.value.length, 1);
    assert.equal(packed.value[0]?.includes('leak'), false);
    const parsed = parseP2PFrame(packed.value[0] as string);
    assert.deepEqual(parsed, { ok: true, value: { v: 1, t: 'state', records: [good] }, invalidRecords: 0 });
  });

  it('만든 프레임은 받는 쪽에서 버리는 기록이 없다 (상한에 맞춘 기록 포함)', () => {
    const good = claimRecord(5);
    const edge = { ...good, lc: Number.MAX_SAFE_INTEGER, body: { ...good.body, observed: 'x'.repeat(LIMITS.STATE_TEXT_FIELD_MAX_BYTES) } };
    const packed = packStateFrames([good, edge as StateRecord, claimRecord(7)], { snap: true });
    assert.equal(packed.ok, true);
    if (!packed.ok) return;
    let count = 0;
    for (const text of packed.value) {
      const parsed = parseP2PFrame(text);
      assert.equal(parsed.ok && parsed.invalidRecords, 0);
      if (parsed.ok && parsed.value.t === 'state') count += parsed.value.records.length;
    }
    assert.equal(count, 3);
  });
});
