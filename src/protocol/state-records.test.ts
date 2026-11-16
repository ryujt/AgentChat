import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { LIMITS } from './limits.js';
import {
  APPEND_RECORD_KINDS,
  CLAIM_OUTCOMES,
  KEY_RECORD_KINDS,
  PRESENCE_STATUSES,
  RECORD_KINDS,
  STATE_CLOCK_MAX,
  STOP_REASONS,
  VERIFICATION_RESULTS,
  canonicalBytes,
  canonicalJson,
  compareCanonical,
  isAppendRecord,
  isKeyRecord,
  parseStateRecord,
  presenceKey,
  recordByteSize,
  recordIdentity,
  stateFingerprint,
  stateRecordSchema,
  type StateRecord,
} from './state-records.js';

const SID = 'k3x9q0ab12cd';
const TEST_ID = `${SID}-1`;

function presence(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return {
    kind: 'presence',
    key: 'presence/claude-4kq2',
    author: 'claude-4kq2',
    lc: 1794700000000,
    wall: 1794700000000,
    body: {
      client: 'claude-code',
      tools: ['browser', 'shell'],
      role: '강사',
      status: 'ready',
      listening: true,
      note: null,
      ...body,
    },
    ...overrides,
  };
}

function test(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return {
    kind: 'test',
    key: 'test',
    author: 'claude-4kq2',
    lc: 1794700000100,
    wall: 1794700000100,
    body: {
      test_id: TEST_ID,
      request: '수업 화면의 손들기 기능을 강사와 수강생 역할로 확인한다',
      started_wall: 1794700000100,
      max_duration_min: 60,
      max_scenarios: 20,
      ...body,
    },
    ...overrides,
  };
}

function stop(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return {
    kind: 'stop',
    rid: `${SID}-2`,
    author: 'codex-7f3k',
    lc: 1794700000200,
    wall: 1794700000200,
    body: { test_id: TEST_ID, reason: 'user', detail: '사용자가 중단을 요청함', ...body },
    ...overrides,
  };
}

function scenario(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return {
    kind: 'scenario',
    rid: `${SID}-3`,
    author: 'claude-4kq2',
    lc: 1794700000300,
    wall: 1794700000300,
    body: { test_id: TEST_ID, title: '손들기', plan: null, ...body },
    ...overrides,
  };
}

function claim(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return {
    kind: 'claim',
    rid: `${SID}-4`,
    author: 'claude-4kq2',
    lc: 1794700000400,
    wall: 1794700000400,
    body: {
      test_id: TEST_ID,
      scenario: `${SID}-3`,
      action: '손들기 버튼을 눌렀다',
      expected: null,
      observed: '강사 화면에 표시가 떴다',
      outcome: 'pass',
      steps: '1. 수강생으로 입장 2. 손들기 클릭',
      ...body,
    },
    ...overrides,
  };
}

function verification(overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return {
    kind: 'verification',
    rid: 'zzzzzzzzzzzz-1',
    author: 'codex-7f3k',
    lc: 1794700000500,
    wall: 1794700000500,
    body: { test_id: TEST_ID, claim: `${SID}-4`, result: 'confirmed', evidence: '강사 화면 캡처로 확인', ...body },
    ...overrides,
  };
}

function expectBad(input: unknown, code = 'BAD_RECORD'): void {
  const result = parseStateRecord(input);
  assert.equal(result.ok, false, JSON.stringify(input).slice(0, 120));
  assert.equal(result.ok ? '' : result.code, code);
}

function valid(input: unknown): StateRecord {
  const result = parseStateRecord(input);
  assert.equal(result.ok, true, result.ok ? '' : result.detail);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

describe('기록 스키마: 종류별 통과 표본', () => {
  it('여섯 종류를 모두 받는다', () => {
    const samples = [presence(), test(), stop(), scenario(), claim(), verification()];
    assert.deepEqual(
      samples.map((sample) => valid(sample).kind),
      [...RECORD_KINDS],
    );
    for (const sample of samples) {
      assert.deepEqual(valid(sample), sample);
      assert.equal(stateRecordSchema.safeParse(sample).success, true);
    }
  });

  it('키 기록은 presence 와 test, 추가 기록은 나머지 넷이다', () => {
    assert.deepEqual([...KEY_RECORD_KINDS], ['presence', 'test']);
    assert.deepEqual([...APPEND_RECORD_KINDS], ['stop', 'scenario', 'claim', 'verification']);
    for (const sample of [presence(), test()]) {
      const record = valid(sample);
      assert.equal(isKeyRecord(record), true);
      assert.equal(isAppendRecord(record), false);
      assert.equal('key' in record, true);
    }
    for (const sample of [stop(), scenario(), claim(), verification()]) {
      const record = valid(sample);
      assert.equal(isKeyRecord(record), false);
      assert.equal(isAppendRecord(record), true);
      assert.equal('rid' in record, true);
    }
  });

  it('선택 필드와 null 을 받는다', () => {
    valid(presence({}, { role: null, note: '준비됨', tools: [] }));
    valid(scenario({}, { plan: '강사가 먼저 방을 연다', actor: 'claude-4kq2', verifier: 'codex-7f3k' }));
    valid(claim({}, { expected: '표시가 뜬다', outcome: 'fail' }));
    valid(stop({}, { reason: 'time_limit', detail: '' }));
    for (const result of ['confirmed', 'refuted', 'unable']) valid(verification({}, { result }));
    for (const status of ['joined', 'ready', 'working', 'left']) valid(presence({}, { status }));
  });

  it('모르는 필드는 버린다', () => {
    const record = valid(claim({ future: 1 }, { extra: 'x' }));
    assert.deepEqual(record, claim());
  });
});

describe('공개 표는 실행 중에 바뀌지 않는다 (기록)', () => {
  it('종류와 값의 목록이 얼어 있다', () => {
    const lists: readonly (readonly string[])[] = [
      RECORD_KINDS,
      KEY_RECORD_KINDS,
      APPEND_RECORD_KINDS,
      PRESENCE_STATUSES,
      STOP_REASONS,
      CLAIM_OUTCOMES,
      VERIFICATION_RESULTS,
    ];
    for (const list of lists) {
      assert.ok(Object.isFrozen(list), list.join(','));
      assert.throws(() => (list as string[]).push('x'), TypeError);
    }
    assert.deepEqual([...RECORD_KINDS], ['presence', 'test', 'stop', 'scenario', 'claim', 'verification']);
  });
});

describe('기록 스키마: 거절 표본', () => {
  it('모르는 kind 와 객체가 아닌 값', () => {
    expectBad({ ...claim(), kind: 'chat' });
    expectBad({ ...claim(), kind: undefined });
    expectBad(null);
    expectBad('claim');
    expectBad([claim()]);
    expectBad(42);
  });

  it('공통 필드가 빠지거나 형식이 틀리면 거절한다', () => {
    for (const field of ['author', 'lc', 'wall', 'body', 'rid']) {
      const broken: Record<string, unknown> = claim();
      delete broken[field];
      expectBad(broken);
    }
    expectBad(claim({ author: 'system' }));
    expectBad(claim({ author: 'bad name' }));
    expectBad(claim({ lc: -1 }));
    expectBad(claim({ lc: 1.5 }));
    expectBad(claim({ lc: '5' }));
    expectBad(claim({ wall: Number.MAX_SAFE_INTEGER + 2 }));
    expectBad(claim({ rid: 'not-an-id' }));
  });

  it('lc 와 wall 은 안전 정수까지다. 그 위에서는 더하기 1 이 값을 바꾸지 못한다 (5.2)', () => {
    assert.equal(STATE_CLOCK_MAX, 2 ** 53 - 1);
    assert.equal(STATE_CLOCK_MAX, Number.MAX_SAFE_INTEGER);
    // 정상 시계는 여기에 닿지 않는다. Date 가 낼 수 있는 가장 큰 값이 더 작다
    assert.ok(8.64e15 < STATE_CLOCK_MAX);
    for (const sample of [presence, test, stop, scenario, claim, verification]) {
      assert.equal(valid(sample({ lc: STATE_CLOCK_MAX })).lc, STATE_CLOCK_MAX);
      assert.equal(valid(sample({ wall: STATE_CLOCK_MAX })).wall, STATE_CLOCK_MAX);
      const overLc = parseStateRecord(sample({ lc: STATE_CLOCK_MAX + 1 }));
      assert.equal(overLc.ok, false);
      if (!overLc.ok) assert.deepEqual([overLc.code, overLc.detail], ['BAD_RECORD', 'lc: too_big']);
      expectBad(sample({ wall: STATE_CLOCK_MAX + 1 }));
    }
    // 상한에 맞춘 기록을 본 뒤에 쓴 기록(본 값 + 1)은 스키마가 받지 않는다. shared-state 가 그 쓰기를 거절한다
    const seen = valid(presence({ lc: STATE_CLOCK_MAX })).lc;
    expectBad(stop({ lc: seen + 1 }));
    expectBad(claim({ lc: Number.POSITIVE_INFINITY }));
    expectBad(claim({ lc: Number.NaN }));
    expectBad(claim({ lc: 1e21 }));
  });

  it('presence 의 키는 presence/<author> 여야 한다 (남의 presence 를 대신 쓸 수 없다)', () => {
    assert.equal(presenceKey('claude-4kq2'), 'presence/claude-4kq2');
    expectBad(presence({ key: 'presence/codex-7f3k' }));
    expectBad(presence({ key: 'presence/' }));
    expectBad(presence({ key: 'claude-4kq2' }));
    expectBad(presence({ key: 'test' }));
    expectBad(presence({ author: 'codex-7f3k' }));
    valid(presence({ key: 'presence/codex-7f3k', author: 'codex-7f3k' }));
  });

  it('test 의 키는 test 하나다', () => {
    expectBad(test({ key: 'test/2' }));
    expectBad(test({ key: 'presence/claude-4kq2' }));
    const noKey: Record<string, unknown> = test();
    delete noKey['key'];
    expectBad(noKey);
  });

  it('열거 값이 아닌 것', () => {
    expectBad(presence({}, { status: 'busy' }));
    expectBad(stop({}, { reason: 'crash' }));
    expectBad(claim({}, { outcome: 'unknown' }));
    expectBad(verification({}, { result: 'approved' }));
  });

  it('body 필드가 빠지거나 타입이 틀린 것', () => {
    expectBad(presence({}, { tools: 'browser' }));
    expectBad(presence({}, { listening: 'yes' }));
    expectBad(presence({}, { client: null }));
    expectBad(test({}, { max_duration_min: 0 }));
    expectBad(test({}, { max_scenarios: 2.5 }));
    expectBad(test({}, { test_id: 'bad' }));
    expectBad(scenario({}, { title: undefined }));
    expectBad(scenario({}, { actor: 'system' }));
    expectBad(scenario({}, { verifier: null }));
    expectBad(claim({}, { scenario: 'bad' }));
    expectBad(claim({}, { observed: undefined }));
    expectBad(verification({}, { claim: 'bad' }));
    expectBad(verification({}, { evidence: 5 }));
  });
});

describe('기록 상한', () => {
  it('글자 필드 하나는 UTF-8 4096바이트까지다', () => {
    valid(claim({}, { action: 'a'.repeat(4096) }));
    expectBad(claim({}, { action: 'a'.repeat(4097) }));
    // 한글은 글자당 3바이트: 1365자 = 4095바이트, 1366자 = 4098바이트
    valid(test({}, { request: '가'.repeat(1365) }));
    expectBad(test({}, { request: '가'.repeat(1366) }));
    valid(presence({}, { tools: ['t'.repeat(4096)] }));
    expectBad(presence({}, { tools: ['ok', 't'.repeat(4097)] }));
    expectBad(presence({}, { role: 'r'.repeat(4097) }));
    expectBad(verification({}, { evidence: 'e'.repeat(4097) }));
  });

  it('글자 필드를 모두 채운 claim 은 기록 상한 안이다', () => {
    const full = valid(
      claim(
        {},
        {
          action: 'a'.repeat(4096),
          expected: 'b'.repeat(4096),
          observed: 'c'.repeat(4096),
          steps: 'd'.repeat(4096),
        },
      ),
    );
    assert.ok(recordByteSize(full) < LIMITS.STATE_RECORD_MAX_BYTES);
  });

  it('직렬화한 기록 하나는 32768바이트까지다', () => {
    const withTools = (lastLength: number) =>
      presence({}, { tools: [...Array(7).fill('t'.repeat(4096)), 't'.repeat(lastLength)] });
    const baseSize = recordByteSize(valid(withTools(0)));
    const room = LIMITS.STATE_RECORD_MAX_BYTES - baseSize;
    assert.ok(room > 0 && room < 4096, `room=${room}`);

    const exact = valid(withTools(room));
    assert.equal(recordByteSize(exact), 32768);

    const over = parseStateRecord(withTools(room + 1));
    assert.equal(over.ok, false);
    assert.equal(over.ok ? '' : over.code, 'RECORD_TOO_LARGE');
  });

  it('크기는 모르는 필드를 버린 뒤에 잰다', () => {
    const padded = presence({ junk: 'x'.repeat(40000) });
    const record = valid(padded);
    assert.equal(recordByteSize(record), recordByteSize(valid(presence())));
  });
});

describe('정규 직렬화', () => {
  it('키를 정렬하고 공백을 넣지 않는다', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(canonicalJson([]), '[]');
    assert.equal(canonicalJson({}), '{}');
    assert.equal(canonicalJson('글'), '"글"');
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(true), 'true');
    assert.equal(canonicalJson(1.5), '1.5');
  });

  it('키 순서가 달라도 같은 문자열이 나온다', () => {
    const a = claim();
    const reversed = Object.fromEntries(Object.entries(a).reverse()) as Record<string, unknown>;
    reversed['body'] = Object.fromEntries(Object.entries(a.body).reverse());
    assert.notEqual(JSON.stringify(a), JSON.stringify(reversed));
    assert.equal(canonicalJson(a), canonicalJson(reversed));
    assert.equal(compareCanonical(a, reversed), 0);
  });

  it('배열 순서는 내용의 일부다', () => {
    assert.notEqual(canonicalJson({ tools: ['a', 'b'] }), canonicalJson({ tools: ['b', 'a'] }));
  });

  it('undefined 인 속성은 빠진다 (JSON 으로 오간 기록과 같아진다)', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalJson(JSON.parse(JSON.stringify({ a: 1, b: undefined }))), '{"a":1}');
    assert.equal(canonicalJson([undefined]), '[null]');
    assert.equal(canonicalJson(undefined), 'null');
  });

  it('JSON 으로 다시 읽으면 같은 값이다', () => {
    for (const sample of [presence(), test(), stop(), scenario(), claim(), verification()]) {
      assert.deepEqual(JSON.parse(canonicalJson(sample)), sample);
    }
    const tricky = { text: '따옴표 " 역슬래시 \\ 줄바꿈 \n 제어 \u0001 이모지 😀' };
    assert.deepEqual(JSON.parse(canonicalJson(tricky)), tricky);
  });

  it('바이트는 UTF-8 이다', () => {
    assert.deepEqual(Buffer.from(canonicalBytes({ a: '가' })), Buffer.from('{"a":"가"}', 'utf8'));
    assert.equal(canonicalBytes({ a: '가' }).length, 11);
  });

  it('비교는 UTF-8 바이트의 사전식이다', () => {
    assert.equal(compareCanonical({ a: 1 }, { a: 2 }), -1);
    assert.equal(compareCanonical({ a: 2 }, { a: 1 }), 1);
    assert.equal(compareCanonical({ a: 1 }, { a: 1 }), 0);
    // U+FF5E(바이트 EF BD 9E) 와 U+1F600(바이트 F0 9F 98 80):
    // UTF-16 코드 단위로는 뒤쪽(D83D)이 작지만 UTF-8 바이트로는 앞쪽이 작다
    assert.ok('～' > '\u{1f600}');
    assert.equal(compareCanonical({ a: '～' }, { a: '\u{1f600}' }), -1);
  });

  it('식별자가 같고 내용이 다른 두 기록은 어느 순서로 견줘도 같은 쪽이 작다', () => {
    const a = valid(claim({}, { observed: '표시가 떴다' }));
    const b = valid(claim({}, { observed: '표시가 안 떴다' }));
    assert.equal(recordIdentity(a), recordIdentity(b));
    const ab = compareCanonical(a, b);
    const ba = compareCanonical(b, a);
    assert.notEqual(ab, 0);
    assert.equal(ab, -ba);
    const keep = (x: StateRecord, y: StateRecord) => (compareCanonical(x, y) <= 0 ? x : y);
    assert.deepEqual(keep(a, b), keep(b, a));
  });
});

describe('지문', () => {
  it('식별 문자열: 추가 기록은 rid, 키 기록은 key·lc·author 다', () => {
    assert.equal(recordIdentity(valid(claim())), `${SID}-4`);
    assert.equal(recordIdentity(valid(stop())), `${SID}-2`);
    assert.equal(recordIdentity(valid(test())), 'test|1794700000100|claude-4kq2');
    assert.equal(recordIdentity(valid(presence())), 'presence/claude-4kq2|1794700000000|claude-4kq2');
  });

  it('식별 문자열을 정렬해 줄바꿈으로 이은 것의 SHA-256 앞 12자리다', () => {
    const records = [presence(), test(), stop(), scenario(), claim(), verification()].map(valid);
    const joined = [
      `${SID}-2`,
      `${SID}-3`,
      `${SID}-4`,
      'presence/claude-4kq2|1794700000000|claude-4kq2',
      'test|1794700000100|claude-4kq2',
      'zzzzzzzzzzzz-1',
    ].join('\n');
    const expected = createHash('sha256').update(joined, 'utf8').digest('hex').slice(0, 12);
    assert.equal(stateFingerprint(records), expected);
    assert.match(stateFingerprint(records), /^[0-9a-f]{12}$/);
  });

  it('값이 고정돼 있다 (정의가 바뀌면 다른 버전의 참가자와 지문이 영영 어긋난다)', () => {
    assert.equal(stateFingerprint([]), 'e3b0c44298fc');
    assert.equal(stateFingerprint([valid(claim())]), createHash('sha256').update(`${SID}-4`).digest('hex').slice(0, 12));
    const records = [presence(), test(), stop(), scenario(), claim(), verification()].map(valid);
    // shasum -a 256 으로 따로 계산한 값이다
    assert.equal(stateFingerprint(records), '8bf49d06f0a5');
  });

  it('기록의 순서와 무관하다', () => {
    const records = [presence(), test(), stop(), scenario(), claim(), verification()].map(valid);
    const expected = stateFingerprint(records);
    assert.equal(stateFingerprint([...records].reverse()), expected);
    assert.equal(stateFingerprint(new Set(records)), expected);
    const rotated = [...records.slice(3), ...records.slice(0, 3)];
    assert.equal(stateFingerprint(rotated), expected);
  });

  it('기록이 하나 더 있거나 키 기록의 lc·author 가 다르면 달라진다', () => {
    const base = [presence(), test(), claim()].map(valid);
    const fingerprint = stateFingerprint(base);
    assert.notEqual(stateFingerprint([...base, valid(stop())]), fingerprint);
    assert.notEqual(stateFingerprint([valid(presence({ lc: 1794700000001 })), valid(test()), valid(claim())]), fingerprint);
    assert.notEqual(
      stateFingerprint([valid(presence()), valid(test({ author: 'codex-7f3k' })), valid(claim())]),
      fingerprint,
    );
  });

  it('추가 기록의 내용은 지문에 들지 않는다 (식별자만 본다)', () => {
    const a = [valid(claim({}, { observed: '가' }))];
    const b = [valid(claim({}, { observed: '나' }))];
    assert.equal(stateFingerprint(a), stateFingerprint(b));
  });
});
