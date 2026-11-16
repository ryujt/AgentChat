import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from './limits.js';
import {
  CLIENT_ACTIONS,
  JOIN_MODES,
  SERVER_MESSAGE_TYPES,
  SIGNAL_ERRORS,
  SIGNAL_ERROR_CODES,
  SIGNAL_KINDS,
  encodeClientMessage,
  encodeServerMessage,
  isSignalErrorCode,
  isSignalMessageTooLarge,
  parseClientMessage,
  parseServerMessage,
  signalCarriesRelay,
  type ClientMessage,
  type ServerMessage,
} from './signaling-wire.js';

const SID_A = 'aaaaaaaaaaaa';
const SID_B = 'bbbbbbbbbbbb';
const KEY = 'k'.repeat(43);
const CID = `${SID_A}.1`;
const HOST_CANDIDATE = 'candidate:1 1 UDP 2122317823 192.0.2.10 50000 typ host';
const SRFLX_CANDIDATE = 'candidate:2 1 UDP 1686109951 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0';
const RELAY_CANDIDATE = 'candidate:3 1 UDP 8331007 198.51.100.7 50002 typ relay raddr 0.0.0.0 rport 0';

function join(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'join',
    v: 1,
    id: 'j1',
    room: 'abcdefgh12345678',
    peer: 'claude-4kq2',
    sid: SID_A,
    key: KEY,
    mode: 'create',
    seq: 1,
    ...overrides,
  };
}

function client(message: unknown) {
  return parseClientMessage(JSON.stringify(message));
}

function server(message: unknown) {
  return parseServerMessage(JSON.stringify(message));
}

function expectClientError(message: unknown, code: string, re?: string): void {
  const result = client(message);
  assert.equal(result.ok, false, JSON.stringify(message));
  if (result.ok) return;
  assert.equal(result.code, code, `${JSON.stringify(message)} → ${result.detail}`);
  assert.equal(result.re, re);
}

describe('parseClientMessage: join', () => {
  it('세 모드를 모두 받는다', () => {
    for (const mode of ['create', 'join', 'resume']) {
      const result = client(join({ mode }));
      assert.equal(result.ok, true, mode);
      assert.deepEqual(result.ok && result.value, join({ mode }));
    }
  });

  it('모르는 필드는 버린다', () => {
    const result = client(join({ future_field: { x: 1 } }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, join());
  });

  it('접속 순번은 1 이상의 정수다', () => {
    assert.equal(client(join({ seq: 1 })).ok, true);
    assert.equal(client(join({ seq: 7 })).ok, true);
    for (const seq of [0, -1, 1.5, '2', null]) {
      expectClientError(join({ seq }), 'BAD_MESSAGE', 'j1');
    }
    const missing = join();
    delete missing['seq'];
    expectClientError(missing, 'BAD_MESSAGE', 'j1');
  });

  it('예약 이름은 BAD_MESSAGE 다', () => {
    for (const peer of ['user', 'System', 'ASSISTANT', 'room', 'you', 'all', 'server', 'agent-chat']) {
      expectClientError(join({ peer }), 'BAD_MESSAGE', 'j1');
    }
  });

  it('형식에 맞지 않는 식별자는 BAD_MESSAGE 다', () => {
    expectClientError(join({ room: 'short' }), 'BAD_MESSAGE', 'j1');
    expectClientError(join({ room: 'UPPERCASE1' }), 'BAD_MESSAGE', 'j1');
    expectClientError(join({ peer: '-leading' }), 'BAD_MESSAGE', 'j1');
    expectClientError(join({ peer: 'x'.repeat(33) }), 'BAD_MESSAGE', 'j1');
    expectClientError(join({ sid: 'tooshort' }), 'BAD_MESSAGE', 'j1');
    expectClientError(join({ key: 'k'.repeat(42) }), 'BAD_MESSAGE', 'j1');
    expectClientError(join({ mode: 'takeover' }), 'BAD_MESSAGE', 'j1');
  });

  it('id 가 형식에 맞지 않으면 re 없이 BAD_MESSAGE 다', () => {
    expectClientError(join({ id: 'x'.repeat(33) }), 'BAD_MESSAGE', undefined);
    expectClientError(join({ id: 'has space' }), 'BAD_MESSAGE', undefined);
    expectClientError(join({ id: 5 }), 'BAD_MESSAGE', undefined);
  });

  it('지원하지 않는 v 는 UNSUPPORTED_VERSION 이고 다른 필드를 보지 않는다', () => {
    expectClientError(join({ v: 99 }), 'UNSUPPORTED_VERSION', 'j1');
    expectClientError(join({ v: 0 }), 'UNSUPPORTED_VERSION', 'j1');
    expectClientError(join({ v: 2 }), 'UNSUPPORTED_VERSION', 'j1');
    // 다음 버전의 join 은 필드 모양이 달라도 협상이 되어야 한다
    expectClientError({ action: 'join', v: 2, id: 'j9', other_shape: true }, 'UNSUPPORTED_VERSION', 'j9');
  });

  it('v 가 정수가 아니면 BAD_MESSAGE 다', () => {
    for (const v of ['1', 1.5, null, true]) {
      expectClientError(join({ v }), 'BAD_MESSAGE', 'j1');
    }
    const missing = join();
    delete missing['v'];
    expectClientError(missing, 'BAD_MESSAGE', 'j1');
  });
});

describe('parseClientMessage: signal', () => {
  const base = { action: 'signal', id: 's1', to: 'codex-7f3k' };

  it('offer 와 answer 는 cid 와 sdp 를 싣는다', () => {
    for (const kind of ['offer', 'answer']) {
      const message = { ...base, kind, cid: CID, data: { sdp: 'v=0\r\n' } };
      const result = client(message);
      assert.equal(result.ok, true, kind);
      assert.deepEqual(result.ok && result.value, message);
    }
  });

  it('offer-request 는 cid 없이 빈 data 를 싣는다', () => {
    const result = client({ ...base, kind: 'offer-request', data: {} });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { ...base, kind: 'offer-request', data: {} });
  });

  it('offer-request 에 딸려 온 cid 와 data 의 내용은 버린다', () => {
    const result = client({ ...base, kind: 'offer-request', cid: CID, data: { sdp: 'x' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { ...base, kind: 'offer-request', data: {} });
  });

  it('offer·answer·candidate 는 cid 가 없으면 BAD_MESSAGE 다', () => {
    expectClientError({ ...base, kind: 'offer', data: { sdp: 'x' } }, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, kind: 'answer', data: { sdp: 'x' } }, 'BAD_MESSAGE', 's1');
    expectClientError(
      { ...base, kind: 'candidate', data: { list: [{ candidate: HOST_CANDIDATE, mid: '0' }] } },
      'BAD_MESSAGE',
      's1',
    );
    expectClientError({ ...base, kind: 'offer', cid: 'not-a-cid', data: { sdp: 'x' } }, 'BAD_MESSAGE', 's1');
  });

  it('sdp 는 12000자까지다', () => {
    const fits = { ...base, kind: 'offer', cid: CID, data: { sdp: 'a'.repeat(LIMITS.SDP_MAX_CHARS) } };
    assert.equal(client(fits).ok, true);
    const over = { ...base, kind: 'offer', cid: CID, data: { sdp: 'a'.repeat(LIMITS.SDP_MAX_CHARS + 1) } };
    expectClientError(over, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, kind: 'offer', cid: CID, data: { sdp: '' } }, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, kind: 'offer', cid: CID, data: {} }, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, kind: 'offer', cid: CID }, 'BAD_MESSAGE', 's1');
  });

  it('후보는 1~32건을 묶어 보낸다', () => {
    const item = { candidate: HOST_CANDIDATE, mid: '0' };
    const one = { ...base, kind: 'candidate', cid: CID, data: { list: [item] } };
    const result = client(one);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, one);

    const full = { ...base, kind: 'candidate', cid: CID, data: { list: Array(32).fill(item) } };
    assert.equal(client(full).ok, true);
    const over = { ...base, kind: 'candidate', cid: CID, data: { list: Array(33).fill(item) } };
    expectClientError(over, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, kind: 'candidate', cid: CID, data: { list: [] } }, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, kind: 'candidate', cid: CID, data: {} }, 'BAD_MESSAGE', 's1');
  });

  it('후보 문자열은 1024자, mid 는 16자까지다', () => {
    const at = (candidate: string, mid: string) => ({
      ...base,
      kind: 'candidate',
      cid: CID,
      data: { list: [{ candidate, mid }] },
    });
    assert.equal(client(at('c'.repeat(1024), 'm'.repeat(16))).ok, true);
    assert.equal(client(at('c', '')).ok, true);
    expectClientError(at('c'.repeat(1025), '0'), 'BAD_MESSAGE', 's1');
    expectClientError(at('c', 'm'.repeat(17)), 'BAD_MESSAGE', 's1');
    expectClientError(at('', '0'), 'BAD_MESSAGE', 's1');
    expectClientError(
      { ...base, kind: 'candidate', cid: CID, data: { list: [{ candidate: HOST_CANDIDATE }] } },
      'BAD_MESSAGE',
      's1',
    );
  });

  it('to 는 참가자 이름 형식이어야 한다', () => {
    expectClientError({ ...base, to: 'bad name', kind: 'offer-request', data: {} }, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, to: 'all', kind: 'offer-request', data: {} }, 'BAD_MESSAGE', 's1');
    expectClientError({ action: 'signal', id: 's1', kind: 'offer-request', data: {} }, 'BAD_MESSAGE', 's1');
  });

  it('모르는 kind 는 BAD_MESSAGE 다', () => {
    expectClientError({ ...base, kind: 'chat', data: { text: 'hi' } }, 'BAD_MESSAGE', 's1');
    expectClientError({ ...base, data: {} }, 'BAD_MESSAGE', 's1');
  });
});

describe('parseClientMessage: ping, leave, 공통 규칙', () => {
  it('ping 과 leave 는 id 만 싣는다', () => {
    assert.deepEqual(client({ action: 'ping', id: 'p1' }), { ok: true, value: { action: 'ping', id: 'p1' } });
    assert.deepEqual(client({ action: 'leave', id: 'l1', x: 1 }), {
      ok: true,
      value: { action: 'leave', id: 'l1' },
    });
    expectClientError({ action: 'ping' }, 'BAD_MESSAGE', undefined);
    expectClientError({ action: 'leave', id: '' }, 'BAD_MESSAGE', undefined);
  });

  it('모르는 action 은 BAD_MESSAGE 이고 id 를 읽을 수 있으면 re 로 돌려준다', () => {
    expectClientError({ action: 'broadcast', id: 'b1' }, 'BAD_MESSAGE', 'b1');
    expectClientError({ id: 'b2' }, 'BAD_MESSAGE', 'b2');
    expectClientError({ action: 42 }, 'BAD_MESSAGE', undefined);
    // 서버 → 클라이언트 메시지를 서버에 보내도 받지 않는다
    expectClientError({ type: 'pong', re: 'p1', members: [] }, 'BAD_MESSAGE', undefined);
  });

  it('JSON 이 아니거나 객체가 아니면 BAD_MESSAGE 다', () => {
    for (const text of ['', 'not json', '{', '[]', '"join"', '42', 'null', 'true', '{"action":"ping","id":"p1"']) {
      const result = parseClientMessage(text);
      assert.equal(result.ok, false, text);
      assert.equal(result.ok ? '' : result.code, 'BAD_MESSAGE', text);
    }
  });

  it('16384바이트까지 받고, 넘으면 파싱하지 않고 MESSAGE_TOO_LARGE 다', () => {
    const frame = (pad: number) => JSON.stringify({ action: 'ping', id: 'p1', pad: 'x'.repeat(pad) });
    const overhead = Buffer.byteLength(frame(0));
    const exact = frame(LIMITS.SIGNAL_MAX_MESSAGE_BYTES - overhead);
    assert.equal(Buffer.byteLength(exact), 16384);
    assert.equal(isSignalMessageTooLarge(exact), false);
    assert.deepEqual(parseClientMessage(exact), { ok: true, value: { action: 'ping', id: 'p1' } });

    const over = frame(LIMITS.SIGNAL_MAX_MESSAGE_BYTES - overhead + 1);
    assert.equal(Buffer.byteLength(over), 16385);
    assert.equal(isSignalMessageTooLarge(over), true);
    const result = parseClientMessage(over);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'MESSAGE_TOO_LARGE');
    assert.equal(result.ok ? '' : result.re, undefined);

    // JSON 이 아니어도 크기를 먼저 본다
    const garbage = parseClientMessage('{'.repeat(16385));
    assert.equal(garbage.ok ? '' : garbage.code, 'MESSAGE_TOO_LARGE');
  });

  it('크기는 글자 수가 아니라 UTF-8 바이트로 잰다', () => {
    const korean = JSON.stringify({ action: 'ping', id: 'p1', pad: '가'.repeat(6000) });
    assert.ok(korean.length < LIMITS.SIGNAL_MAX_MESSAGE_BYTES);
    assert.ok(Buffer.byteLength(korean) > LIMITS.SIGNAL_MAX_MESSAGE_BYTES);
    const result = parseClientMessage(korean);
    assert.equal(result.ok ? '' : result.code, 'MESSAGE_TOO_LARGE');
  });

  it('거절 사유에 받은 값의 원문을 싣지 않는다', () => {
    const secret = 'S3CRET-ROOM-VALUE';
    const result = client(join({ room: secret, key: secret }));
    assert.equal(result.ok, false);
    assert.equal((result.ok ? '' : result.detail).includes(secret), false);
  });

  it('어떤 입력에도 예외를 던지지 않는다', () => {
    const inputs = [
      '{"action":"join","v":1e400}',
      '{"action":"signal","data":{"list":"x"}}',
      '{"__proto__":{"action":"ping"},"id":"p1"}',
      '{"action":{"toString":1},"id":["a"]}',
      '\u0000',
      '{"action":"join","v":1,"id":"j","room":null,"peer":{},"sid":[],"key":1,"mode":{},"seq":"x"}',
    ];
    for (const text of inputs) {
      assert.doesNotThrow(() => parseClientMessage(text), text);
      assert.equal(parseClientMessage(text).ok, false, text);
    }
  });
});

describe('encodeClientMessage', () => {
  it('직렬화한 것을 서버가 그대로 해석한다', () => {
    const messages: ClientMessage[] = [
      { action: 'join', v: 1, id: 'j1', room: 'abcdefgh', peer: 'a', sid: SID_A, key: KEY, mode: 'resume', seq: 3 },
      { action: 'signal', id: 's1', to: 'b', kind: 'offer-request', data: {} },
      { action: 'signal', id: 's2', to: 'b', kind: 'offer', cid: CID, data: { sdp: 'v=0' } },
      {
        action: 'signal',
        id: 's3',
        to: 'b',
        kind: 'candidate',
        cid: CID,
        data: { list: [{ candidate: HOST_CANDIDATE, mid: '0' }, { candidate: SRFLX_CANDIDATE, mid: '0' }] },
      },
      { action: 'ping', id: 'p1' },
      { action: 'leave', id: 'l1' },
    ];
    for (const message of messages) {
      const encoded = encodeClientMessage(message);
      assert.equal(encoded.ok, true);
      if (!encoded.ok) continue;
      assert.deepEqual(parseClientMessage(encoded.value), { ok: true, value: message });
    }
  });

  it('서버가 거절할 크기는 보내기 전에 MESSAGE_TOO_LARGE 로 막는다', () => {
    // 글자 수 상한 안의 sdp 라도 줄바꿈이 많으면 직렬화하면서 16384바이트를 넘는다
    const sdp = 'a=x\r\n'.repeat(2400);
    assert.equal(sdp.length, LIMITS.SDP_MAX_CHARS);
    const encoded = encodeClientMessage({ action: 'signal', id: 's1', to: 'b', kind: 'offer', cid: CID, data: { sdp } });
    assert.equal(encoded.ok, false);
    assert.equal(encoded.ok ? '' : encoded.code, 'MESSAGE_TOO_LARGE');
  });
});

describe('encodeClientMessage: 서버가 거절할 메시지를 만들지 않는다', () => {
  it('스키마에 걸리는 메시지는 BAD_MESSAGE 다', () => {
    const bad: unknown[] = [
      join({ id: '', room: 'X', peer: 'all', sid: '', key: '', seq: 0 }),
      join({ id: '' }),
      join({ room: 'X' }),
      join({ peer: 'all' }),
      join({ seq: 0 }),
      join({ v: 2 }),
      join({ mode: 'takeover' }),
      { action: 'signal', id: 's1', to: 'b', kind: 'offer', data: { sdp: 'v=0' } },
      { action: 'signal', id: 's1', to: 'b', kind: 'chat', cid: CID, data: { text: 'hello' } },
      { action: 'signal', id: 's1', to: 'b', kind: 'candidate', cid: CID, data: { list: [] } },
      { action: 'chat', id: 'c1', to: 'b', text: 'hello' },
      { action: 'ping' },
      {},
    ];
    for (const message of bad) {
      const encoded = encodeClientMessage(message as ClientMessage);
      assert.equal(encoded.ok, false, JSON.stringify(message));
      assert.equal(encoded.ok ? '' : encoded.code, 'BAD_MESSAGE', JSON.stringify(message));
      assert.equal(parseClientMessage(JSON.stringify(message)).ok, false, JSON.stringify(message));
    }
  });

  it('모르는 필드는 싣지 않는다', () => {
    const encoded = encodeClientMessage({ action: 'ping', id: 'p1', text: 'hello' } as unknown as ClientMessage);
    assert.deepEqual(encoded, { ok: true, value: '{"action":"ping","id":"p1"}' });
  });

  it('객체가 아닌 값에도 던지지 않는다', () => {
    for (const value of [null, undefined, 'ping', 1, []]) {
      assert.doesNotThrow(() => encodeClientMessage(value as unknown as ClientMessage));
      const encoded = encodeClientMessage(value as unknown as ClientMessage);
      assert.equal(encoded.ok ? '' : encoded.code, 'BAD_MESSAGE');
    }
  });
});

describe('공개 표는 실행 중에 바뀌지 않는다 (시그널링)', () => {
  it('이름 목록 넷이 얼어 있다', () => {
    for (const list of [CLIENT_ACTIONS, SERVER_MESSAGE_TYPES, JOIN_MODES, SIGNAL_KINDS]) {
      assert.ok(Object.isFrozen(list));
      assert.throws(() => (list as unknown as string[]).push('chat'), TypeError);
    }
    assert.deepEqual([...CLIENT_ACTIONS], ['join', 'signal', 'ping', 'leave']);
    assert.deepEqual([...SIGNAL_KINDS], ['offer-request', 'offer', 'answer', 'candidate']);
  });

  it('오류 표는 안쪽 값까지 얼어 있다', () => {
    assert.ok(Object.isFrozen(SIGNAL_ERRORS));
    assert.ok(Object.isFrozen(SIGNAL_ERROR_CODES));
    for (const code of SIGNAL_ERROR_CODES) assert.ok(Object.isFrozen(SIGNAL_ERRORS[code]), code);
    assert.throws(() => {
      (SIGNAL_ERRORS.REPLACED as { fatal: boolean }).fatal = true;
    }, TypeError);
    assert.equal(SIGNAL_ERRORS.REPLACED.fatal, false);
  });
});

describe('signalCarriesRelay: relay 후보가 든 signal 을 전달하지 않는다', () => {
  it('sdp 안의 relay 후보 줄을 찾는다', () => {
    const clean = `v=0\r\na=${HOST_CANDIDATE}\r\na=${SRFLX_CANDIDATE}\r\n`;
    const tainted = `${clean}a=${RELAY_CANDIDATE}\r\n`;
    assert.equal(signalCarriesRelay({ kind: 'offer', cid: CID, data: { sdp: clean } }), false);
    assert.equal(signalCarriesRelay({ kind: 'offer', cid: CID, data: { sdp: tainted } }), true);
    assert.equal(signalCarriesRelay({ kind: 'answer', cid: CID, data: { sdp: tainted } }), true);
  });

  it('후보 묶음에 relay 가 하나라도 있으면 참이다', () => {
    const list = [
      { candidate: HOST_CANDIDATE, mid: '0' },
      { candidate: SRFLX_CANDIDATE, mid: '0' },
    ];
    assert.equal(signalCarriesRelay({ kind: 'candidate', cid: CID, data: { list } }), false);
    assert.equal(
      signalCarriesRelay({
        kind: 'candidate',
        cid: CID,
        data: { list: [...list, { candidate: RELAY_CANDIDATE, mid: '0' }] },
      }),
      true,
    );
  });

  it('offer-request 는 항상 거짓이다', () => {
    assert.equal(signalCarriesRelay({ kind: 'offer-request', data: {} }), false);
  });

  it('해석한 클라이언트 메시지를 그대로 넣을 수 있다', () => {
    const parsed = client({
      action: 'signal',
      id: 's1',
      to: 'b',
      kind: 'candidate',
      cid: CID,
      data: { list: [{ candidate: RELAY_CANDIDATE, mid: '0' }] },
    });
    assert.ok(parsed.ok && parsed.value.action === 'signal' && signalCarriesRelay(parsed.value));
  });
});

describe('오류 코드 표 (2.4)', () => {
  it('코드는 열세 개다', () => {
    assert.deepEqual([...SIGNAL_ERROR_CODES].sort(), [
      'BAD_MESSAGE',
      'MESSAGE_TOO_LARGE',
      'NAME_IN_USE',
      'NOT_JOINED',
      'PEER_NOT_FOUND',
      'RATE_LIMITED',
      'RELAY_NOT_ALLOWED',
      'REPLACED',
      'ROOM_EXISTS',
      'ROOM_FULL',
      'ROOM_NOT_FOUND',
      'SERVER_ERROR',
      'UNSUPPORTED_VERSION',
    ]);
  });

  it('서버가 연결을 닫는 것은 RATE_LIMITED 와 REPLACED 뿐이다', () => {
    const closing = SIGNAL_ERROR_CODES.filter((code) => SIGNAL_ERRORS[code].closes).sort();
    assert.deepEqual(closing, ['RATE_LIMITED', 'REPLACED']);
  });

  it('치명은 UNSUPPORTED_VERSION 하나다. REPLACED 는 치명이 아니다', () => {
    const fatal = SIGNAL_ERROR_CODES.filter((code) => SIGNAL_ERRORS[code].fatal);
    assert.deepEqual(fatal, ['UNSUPPORTED_VERSION']);
    assert.equal(SIGNAL_ERRORS.REPLACED.fatal, false);
  });

  it('isSignalErrorCode 는 표의 코드만 참이다', () => {
    assert.equal(isSignalErrorCode('ROOM_FULL'), true);
    assert.equal(isSignalErrorCode('room_full'), false);
    assert.equal(isSignalErrorCode('toString'), false);
    assert.equal(isSignalErrorCode('INVALID_ARGUMENT'), false);
    assert.equal(isSignalErrorCode(undefined), false);
  });
});

describe('parseServerMessage', () => {
  const members = [
    { peer: 'codex-7f3k', sid: SID_B },
    { peer: 'gemini-1', sid: 'cccccccccccc' },
  ];

  it('joined 는 자신을 뺀 참가자 목록과 서버 값을 싣는다', () => {
    const message = {
      type: 'joined',
      re: 'j1',
      members,
      max_peers: 8,
      ping_interval_ms: 30000,
      stale_after_ms: 90000,
    };
    assert.deepEqual(server(message), { ok: true, value: message });
    assert.deepEqual(server({ ...message, members: [] }), { ok: true, value: { ...message, members: [] } });
  });

  it('joined 의 필드가 빠지거나 형식이 틀리면 BAD_MESSAGE 다', () => {
    const message = { type: 'joined', re: 'j1', members, max_peers: 8, ping_interval_ms: 30000, stale_after_ms: 90000 };
    for (const field of ['re', 'members', 'max_peers', 'ping_interval_ms', 'stale_after_ms']) {
      const broken: Record<string, unknown> = { ...message };
      delete broken[field];
      const result = server(broken);
      assert.equal(result.ok ? '' : result.code, 'BAD_MESSAGE', field);
    }
    const badMember = server({ ...message, members: [{ peer: 'system', sid: SID_B }] });
    assert.equal(badMember.ok ? '' : badMember.code, 'BAD_MESSAGE');
    const badSid = server({ ...message, members: [{ peer: 'ok', sid: 'x' }] });
    assert.equal(badSid.ok ? '' : badSid.code, 'BAD_MESSAGE');
    const zero = server({ ...message, max_peers: 0 });
    assert.equal(zero.ok ? '' : zero.code, 'BAD_MESSAGE');
  });

  it('pong 은 같은 형식의 목록을 싣는다', () => {
    const message = { type: 'pong', re: 'p1', members };
    assert.deepEqual(server(message), { ok: true, value: message });
    const noRe = server({ type: 'pong', members });
    assert.equal(noRe.ok ? '' : noRe.code, 'BAD_MESSAGE');
  });

  it('signal 에는 서버가 붙인 from 과 sid 가 있다', () => {
    const offer = { type: 'signal', from: 'claude-4kq2', sid: SID_A, kind: 'offer', cid: CID, data: { sdp: 'v=0' } };
    assert.deepEqual(server(offer), { ok: true, value: offer });
    const request = { type: 'signal', from: 'codex-7f3k', sid: SID_B, kind: 'offer-request', data: {} };
    assert.deepEqual(server(request), { ok: true, value: request });
    const candidates = {
      type: 'signal',
      from: 'claude-4kq2',
      sid: SID_A,
      kind: 'candidate',
      cid: CID,
      data: { list: [{ candidate: HOST_CANDIDATE, mid: '0' }] },
    };
    assert.deepEqual(server(candidates), { ok: true, value: candidates });

    for (const field of ['from', 'sid', 'cid', 'data']) {
      const broken: Record<string, unknown> = { ...offer };
      delete broken[field];
      const result = server(broken);
      assert.equal(result.ok ? '' : result.code, 'BAD_MESSAGE', field);
    }
  });

  it('error 는 코드와 선택 필드를 싣는다', () => {
    for (const code of SIGNAL_ERROR_CODES) {
      const message = { type: 'error', code, message: 'm' };
      assert.deepEqual(server(message), { ok: true, value: message }, code);
    }
    const full = {
      type: 'error',
      code: 'UNSUPPORTED_VERSION',
      message: 'unsupported',
      re: 'j1',
      retry_after_ms: 1500,
      supported: [1],
    };
    assert.deepEqual(server(full), { ok: true, value: full });
  });

  it('표에 없는 오류 코드와 잘못된 선택 필드는 BAD_MESSAGE 다', () => {
    const unknown = server({ type: 'error', code: 'SOMETHING_NEW', message: 'm' });
    assert.equal(unknown.ok ? '' : unknown.code, 'BAD_MESSAGE');
    const negative = server({ type: 'error', code: 'RATE_LIMITED', message: 'm', retry_after_ms: -1 });
    assert.equal(negative.ok ? '' : negative.code, 'BAD_MESSAGE');
    const noMessage = server({ type: 'error', code: 'RATE_LIMITED' });
    assert.equal(noMessage.ok ? '' : noMessage.code, 'BAD_MESSAGE');
  });

  it('모르는 필드는 버린다', () => {
    const result = server({ type: 'pong', re: 'p1', members: [], server_time: 1 });
    assert.deepEqual(result, { ok: true, value: { type: 'pong', re: 'p1', members: [] } });
  });

  it('type 이 없는 프레임은 게이트웨이 프레임이다', () => {
    const throttled = '{"message":"Too Many Requests"}';
    const result = parseServerMessage(throttled);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'GATEWAY_FRAME');
    assert.equal(result.frameBytes, Buffer.byteLength(throttled));
    // 본문은 로그에 남기지 않는다. 사유에도 싣지 않는다
    assert.equal(result.detail.includes('Too Many'), false);

    for (const text of [
      '{"message":"Internal server error","connectionId":"abc","requestId":"def"}',
      '{}',
      'Too Many Requests',
      '[1,2]',
      '"joined"',
      'null',
      ' ',
    ]) {
      const other = parseServerMessage(text);
      assert.equal(other.ok ? '' : other.code, 'GATEWAY_FRAME', text);
    }
  });

  it('길이 0 인 프레임은 따로 가린다', () => {
    const result = parseServerMessage('');
    assert.equal(result.ok ? '' : result.code, 'EMPTY_FRAME');
    assert.equal(result.ok ? -1 : result.frameBytes, 0);
  });

  it('모르는 type 은 UNKNOWN_TYPE 이다', () => {
    for (const message of [{ type: 'peer-joined', peer: 'x' }, { type: 'join' }, { type: 7 }, { type: null }]) {
      const result = server(message);
      assert.equal(result.ok ? '' : result.code, 'UNKNOWN_TYPE', JSON.stringify(message));
    }
  });

  it('encodeServerMessage 로 만든 것을 클라이언트가 그대로 해석한다', () => {
    const messages: ServerMessage[] = [
      { type: 'joined', re: 'j1', members, max_peers: 8, ping_interval_ms: 30000, stale_after_ms: 90000 },
      { type: 'pong', re: 'p1', members: [] },
      { type: 'signal', from: 'a', sid: SID_A, kind: 'answer', cid: CID, data: { sdp: 'v=0' } },
      { type: 'signal', from: 'b', sid: SID_B, kind: 'offer-request', data: {} },
      { type: 'error', code: 'REPLACED', message: 'replaced by a newer connection' },
      { type: 'error', code: 'PEER_NOT_FOUND', message: 'gone', re: 's1' },
    ];
    for (const message of messages) {
      const encoded = encodeServerMessage(message);
      assert.equal(encoded.ok, true, JSON.stringify(message));
      if (!encoded.ok) continue;
      assert.deepEqual(parseServerMessage(encoded.value), { ok: true, value: message });
    }
  });

  it('어떤 입력에도 예외를 던지지 않는다', () => {
    for (const text of ['{"type":"joined","members":{"length":3}}', '{"type":"signal","kind":[]}', '\u0000', '{"type":']) {
      assert.doesNotThrow(() => parseServerMessage(text), text);
      assert.equal(parseServerMessage(text).ok, false, text);
    }
  });
});

describe('encodeServerMessage: 클라이언트가 거절할 메시지는 만들지 않는다', () => {
  // 타입으로는 막히는 값이다. 결함이 있는 서버 규칙 코드를 흉내 낸다.
  function encodeLoose(message: unknown) {
    return encodeServerMessage(message as ServerMessage);
  }

  function expectBadMessage(message: unknown, detail: RegExp): void {
    const result = encodeLoose(message);
    assert.equal(result.ok, false, JSON.stringify(message));
    if (result.ok) return;
    assert.equal(result.code, 'BAD_MESSAGE');
    assert.match(result.detail, detail);
    // 같은 값을 그대로 보냈다면 클라이언트가 버렸을 것이다
    const received = parseServerMessage(JSON.stringify(message));
    assert.equal(received.ok, false);
  }

  it('표에 없는 오류 코드와 문자열이 아닌 message', () => {
    expectBadMessage({ type: 'error', code: 'NOPE', message: 5 }, /code: .*message: /);
    expectBadMessage({ type: 'error', code: 'ROOM_FULL' }, /^message: /);
    expectBadMessage({ type: 'error', code: 'RATE_LIMITED', message: 'm', retry_after_ms: -1 }, /^retry_after_ms: /);
  });

  it('형식이 틀린 re 와 빠진 필드', () => {
    expectBadMessage({ type: 'joined', re: 'bad id!', members: [], max_peers: 8, ping_interval_ms: 30000, stale_after_ms: 90000 }, /^re: /);
    expectBadMessage({ type: 'joined', re: 'j1', members: [] }, /max_peers: /);
    expectBadMessage({ type: 'pong', members: [] }, /^re: /);
    expectBadMessage({ type: 'pong', re: 'p1', members: [{ peer: 'system', sid: SID_B }] }, /^members\.0\.peer: /);
  });

  it('kind 에 맞지 않는 signal', () => {
    expectBadMessage({ type: 'signal', from: 'a', sid: SID_A, kind: 'candidate', cid: CID, data: { list: [] } }, /^data\.list: /);
    expectBadMessage({ type: 'signal', from: 'a', sid: SID_A, kind: 'offer', data: { sdp: 'v=0' } }, /^cid: /);
    expectBadMessage({ type: 'signal', from: 'a', sid: 'x', kind: 'offer-request', data: {} }, /^sid: /);
    expectBadMessage({ type: 'signal', from: 'a', sid: SID_A, kind: 'chat', data: { text: 'hello' } }, /kind/);
  });

  it('모르는 type 과 객체가 아닌 값', () => {
    for (const message of [{ type: 'peer-joined', peer: 'x' }, { re: 'p1', members: [] }, null, 'pong', ['pong'], 7]) {
      const result = encodeLoose(message);
      assert.equal(result.ok, false, JSON.stringify(message));
      if (!result.ok) assert.equal(result.code, 'BAD_MESSAGE');
    }
  });

  it('모르는 필드는 싣지 않는다', () => {
    const result = encodeLoose({ type: 'pong', re: 'r', members: [], secret: 'leak' });
    assert.deepEqual(result, { ok: true, value: '{"type":"pong","re":"r","members":[]}' });
    const signal = encodeLoose({ type: 'signal', from: 'a', sid: SID_A, kind: 'offer-request', data: { text: 'hello' }, text: 'hello' });
    assert.equal(signal.ok, true);
    if (signal.ok) assert.equal(signal.value.includes('hello'), false);
  });

  it('오류 코드 13개는 모두 직렬화된다', () => {
    for (const code of SIGNAL_ERROR_CODES) {
      const result = encodeServerMessage({ type: 'error', code, message: 'm', re: 'r1' });
      assert.equal(result.ok, true, code);
    }
  });

  it('크기 상한은 걸지 않는다 (클라이언트가 보낸 16384바이트 signal 에 from 과 sid 를 붙여도 나간다)', () => {
    const sdp = 'a'.repeat(LIMITS.SDP_MAX_CHARS);
    const result = encodeServerMessage({ type: 'signal', from: 'a'.repeat(32), sid: SID_A, kind: 'offer', cid: CID, data: { sdp } });
    assert.equal(result.ok, true);
  });
});
