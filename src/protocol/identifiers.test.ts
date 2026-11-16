import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  CID_SEQ_MAX,
  ENTRY_SEQ_MAX,
  RESERVED_PEER_NAMES,
  checkPeerName,
  cidSchema,
  comparePeerNames,
  entryIdSchema,
  isCid,
  isEntryId,
  isOfferSide,
  isPeerName,
  isRequestId,
  isReservedPeerName,
  isResumeKey,
  isRoomId,
  isSid,
  makeCid,
  makeEntryId,
  newResumeKey,
  newRoomId,
  newSid,
  parseCid,
  parseEntryId,
  peerNameSchema,
  randomLowerAlnum,
  refOf,
  requestIdSchema,
  resumeKeySchema,
  roomIdSchema,
  sidSchema,
  type RandomBytes,
} from './identifiers.js';

const SID = 'k3x9q0ab12cd';

/** 정해진 바이트를 차례로 돌려주는 공급자. 다 쓰면 처음부터 다시 준다. */
function fixedBytes(values: readonly number[]): RandomBytes {
  let at = 0;
  return (size) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      out[i] = values[at % values.length] ?? 0;
      at += 1;
    }
    return out;
  };
}

describe('방 ID', () => {
  it('8~32자의 소문자와 숫자만 받는다', () => {
    assert.equal(isRoomId('a'.repeat(8)), true);
    assert.equal(isRoomId('a1b2c3d4e5f6g7h8'), true);
    assert.equal(isRoomId('z'.repeat(32)), true);
    assert.equal(isRoomId('a'.repeat(7)), false);
    assert.equal(isRoomId('a'.repeat(33)), false);
    assert.equal(isRoomId('ABCDEFGH'), false);
    assert.equal(isRoomId('abcd-efgh'), false);
    assert.equal(isRoomId('abcdefgh\n'), false);
    assert.equal(isRoomId(''), false);
    assert.equal(isRoomId(12345678), false);
    assert.equal(isRoomId(null), false);
  });

  it('스키마가 같은 판정을 한다', () => {
    assert.equal(roomIdSchema.safeParse('abcdefgh').success, true);
    assert.equal(roomIdSchema.safeParse('abcdefg').success, false);
  });

  it('생략 시 만드는 ID 는 무작위 16자다', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = newRoomId();
      assert.match(id, /^[a-z0-9]{16}$/);
      assert.equal(isRoomId(id), true);
      seen.add(id);
    }
    assert.equal(seen.size, 500);
  });
});

describe('참가자 이름', () => {
  it('글자·숫자로 시작하는 1~32자를 받는다', () => {
    for (const name of ['a', 'Z', '7', 'claude-4kq2', 'codex_mac', 'A-b_C', 'a'.repeat(32)]) {
      assert.equal(isPeerName(name), true, name);
      assert.equal(peerNameSchema.safeParse(name).success, true, name);
    }
  });

  it('형식에 맞지 않는 이름을 거절한다', () => {
    for (const name of ['', '-abc', '_abc', 'a'.repeat(33), 'a b', 'a.b', '수강생', 'a/b', 'a\n', 'presence/a']) {
      assert.equal(isPeerName(name), false, JSON.stringify(name));
      assert.equal(peerNameSchema.safeParse(name).success, false, JSON.stringify(name));
    }
    assert.equal(isPeerName(undefined), false);
    assert.equal(isPeerName(42), false);
  });

  it('예약 이름 여덟 개를 대소문자와 무관하게 거절한다', () => {
    assert.deepEqual(
      [...RESERVED_PEER_NAMES].sort(),
      ['agent-chat', 'all', 'assistant', 'room', 'server', 'system', 'user', 'you'],
    );
    for (const name of RESERVED_PEER_NAMES) {
      for (const variant of [name, name.toUpperCase(), name[0]?.toUpperCase() + name.slice(1)]) {
        assert.equal(isReservedPeerName(variant), true, variant);
        assert.equal(isPeerName(variant), false, variant);
        assert.equal(peerNameSchema.safeParse(variant).success, false, variant);
      }
    }
  });

  it('예약 이름을 품기만 한 이름은 받는다', () => {
    for (const name of ['user1', 'system-a', 'agent-chat2', 'rooms', 'allen', 'my-server']) {
      assert.equal(isPeerName(name), true, name);
    }
  });

  it('checkPeerName 은 형식 오류와 예약 이름을 INVALID_ARGUMENT 로 가려 알려 준다', () => {
    assert.deepEqual(checkPeerName('claude-4kq2'), { ok: true, value: 'claude-4kq2' });
    const format = checkPeerName('-bad');
    assert.equal(format.ok, false);
    assert.equal(format.ok ? '' : format.code, 'INVALID_ARGUMENT');
    const reserved = checkPeerName('System');
    assert.equal(reserved.ok, false);
    assert.equal(reserved.ok ? '' : reserved.code, 'INVALID_ARGUMENT');
    assert.match(reserved.ok ? '' : reserved.detail, /reserved/);
    assert.equal(checkPeerName(7).ok, false);
  });

  it('이름 비교는 UTF-16 코드 단위 순서다 (대문자가 소문자보다 작다)', () => {
    assert.equal(comparePeerNames('a', 'b'), -1);
    assert.equal(comparePeerNames('b', 'a'), 1);
    assert.equal(comparePeerNames('a', 'a'), 0);
    assert.equal(comparePeerNames('B', 'a'), -1);
    assert.equal(comparePeerNames('a', 'a-'), -1);
    assert.equal(comparePeerNames('9', 'A'), -1);
    assert.equal(comparePeerNames('Z', '_'), -1);
  });

  it('offer 는 이름이 작은 쪽만 만든다', () => {
    assert.equal(isOfferSide('claude-4kq2', 'codex-7f3k'), true);
    assert.equal(isOfferSide('codex-7f3k', 'claude-4kq2'), false);
    assert.equal(isOfferSide('same', 'same'), false);
    // 두 쪽이 같은 답을 내야 한쪽만 offer 한다
    for (const [a, b] of [['Alpha', 'alpha'], ['a1', 'a10'], ['x_y', 'x-y']] as const) {
      assert.notEqual(isOfferSide(a, b), isOfferSide(b, a));
    }
  });
});

describe('sid', () => {
  it('소문자와 숫자 12자다', () => {
    assert.equal(isSid(SID), true);
    assert.equal(sidSchema.safeParse(SID).success, true);
    assert.equal(isSid('k3x9q0ab12c'), false);
    assert.equal(isSid('k3x9q0ab12cde'), false);
    assert.equal(isSid('K3X9Q0AB12CD'), false);
    assert.equal(isSid('k3x9q0ab12c-'), false);
  });

  it('newSid 는 매번 다른 12자를 만든다', () => {
    const a = newSid();
    const b = newSid();
    assert.equal(isSid(a), true);
    assert.equal(isSid(b), true);
    assert.notEqual(a, b);
  });
});

describe('resume key', () => {
  it('base64url 43자다', () => {
    assert.equal(isResumeKey('A'.repeat(43)), true);
    assert.equal(isResumeKey('aZ09_-'.repeat(7) + 'a'), true);
    assert.equal(resumeKeySchema.safeParse('A'.repeat(43)).success, true);
    assert.equal(isResumeKey('A'.repeat(42)), false);
    assert.equal(isResumeKey('A'.repeat(44)), false);
    assert.equal(isResumeKey('+'.repeat(43)), false);
    assert.equal(isResumeKey('/'.repeat(43)), false);
    assert.equal(isResumeKey('A'.repeat(42) + '='), false);
  });

  it('newResumeKey 는 무작위 32바이트를 base64url 로 적는다', () => {
    const key = newResumeKey();
    assert.equal(isResumeKey(key), true);
    assert.equal(Buffer.from(key, 'base64url').length, 32);
    assert.notEqual(newResumeKey(), key);
    assert.equal(newResumeKey(fixedBytes([0])), 'A'.repeat(43));
  });
});

describe('cid', () => {
  it('<sid>.<순번 1~6자리> 형식이다', () => {
    assert.equal(isCid(`${SID}.0`), true);
    assert.equal(isCid(`${SID}.999999`), true);
    assert.equal(cidSchema.safeParse(`${SID}.12`).success, true);
    assert.equal(isCid(`${SID}.1000000`), false);
    assert.equal(isCid(`${SID}.`), false);
    assert.equal(isCid(`${SID}-1`), false);
    assert.equal(isCid(`${SID}.1a`), false);
    assert.equal(isCid(`short.1`), false);
    assert.equal(isCid(SID), false);
  });

  it('만들고 다시 읽으면 같은 sid 와 순번이 나온다', () => {
    const made = makeCid(SID, 42);
    assert.deepEqual(made, { ok: true, value: `${SID}.42` });
    assert.deepEqual(parseCid(`${SID}.42`), { ok: true, value: { sid: SID, seq: 42 } });
    assert.deepEqual(makeCid(SID, 0), { ok: true, value: `${SID}.0` });
    assert.deepEqual(makeCid(SID, CID_SEQ_MAX), { ok: true, value: `${SID}.999999` });
  });

  it('순번은 숫자로 견준다 (앞자리 0 이 있어도 같은 순번이다)', () => {
    assert.deepEqual(parseCid(`${SID}.007`), { ok: true, value: { sid: SID, seq: 7 } });
    const nine = parseCid(`${SID}.9`);
    const ten = parseCid(`${SID}.10`);
    assert.ok(nine.ok && ten.ok && nine.value.seq < ten.value.seq);
  });

  it('범위를 벗어난 순번과 잘못된 sid 는 INVALID_ARGUMENT 다', () => {
    for (const seq of [-1, CID_SEQ_MAX + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = makeCid(SID, seq);
      assert.equal(result.ok, false, String(seq));
      assert.equal(result.ok ? '' : result.code, 'INVALID_ARGUMENT');
    }
    assert.equal(makeCid('BAD', 1).ok, false);
    assert.equal(parseCid('nope').ok, false);
    assert.equal(parseCid(undefined).ok, false);
  });
});

describe('메시지 ID 와 기록 ID', () => {
  it('<sid>-<36진수 1~8자리> 형식이다', () => {
    assert.equal(isEntryId(`${SID}-1a`), true);
    assert.equal(isEntryId(`${SID}-0`), true);
    assert.equal(isEntryId(`${SID}-zzzzzzzz`), true);
    assert.equal(entryIdSchema.safeParse(`${SID}-1a`).success, true);
    assert.equal(isEntryId(`${SID}-`), false);
    assert.equal(isEntryId(`${SID}-zzzzzzzzz`), false);
    assert.equal(isEntryId(`${SID}-1A`), false);
    assert.equal(isEntryId(`${SID}.1`), false);
    assert.equal(isEntryId(`${SID}-1-2`), false);
  });

  it('순번을 36진수로 적는다 (문서 예시 k3x9q0ab12cd-1a 는 46번이다)', () => {
    assert.deepEqual(makeEntryId(SID, 46), { ok: true, value: 'k3x9q0ab12cd-1a' });
    assert.deepEqual(parseEntryId('k3x9q0ab12cd-1a'), { ok: true, value: { sid: SID, seq: 46 } });
    assert.deepEqual(makeEntryId(SID, 0), { ok: true, value: `${SID}-0` });
    assert.deepEqual(makeEntryId(SID, ENTRY_SEQ_MAX), { ok: true, value: `${SID}-zzzzzzzz` });
    assert.deepEqual(parseEntryId(`${SID}-zzzzzzzz`), { ok: true, value: { sid: SID, seq: ENTRY_SEQ_MAX } });
  });

  it('범위를 벗어난 순번과 잘못된 입력은 INVALID_ARGUMENT 다', () => {
    for (const seq of [-1, ENTRY_SEQ_MAX + 1, 0.5, Number.NaN]) {
      assert.equal(makeEntryId(SID, seq).ok, false, String(seq));
    }
    assert.equal(makeEntryId('bad sid', 1).ok, false);
    assert.equal(parseEntryId('x-1').ok, false);
    assert.equal(parseEntryId(5).ok, false);
  });
});

describe('요청 id', () => {
  it('글자·숫자·_·- 의 1~32자다', () => {
    assert.equal(isRequestId('a'), true);
    assert.equal(isRequestId('Req_01-x'), true);
    assert.equal(isRequestId('x'.repeat(32)), true);
    assert.equal(requestIdSchema.safeParse('r1').success, true);
    assert.equal(isRequestId(''), false);
    assert.equal(isRequestId('x'.repeat(33)), false);
    assert.equal(isRequestId('a b'), false);
    assert.equal(isRequestId('a.b'), false);
    assert.equal(isRequestId(1), false);
  });
});

describe('무작위 문자열', () => {
  it('주입한 바이트로 결과가 정해진다', () => {
    // 0→'0', 9→'9', 10→'a', 35→'z', 36→'0'(한 바퀴)
    assert.equal(randomLowerAlnum(5, fixedBytes([0, 9, 10, 35, 36])), '09az0');
  });

  it('치우침을 만드는 바이트(252~255)는 버린다', () => {
    assert.equal(randomLowerAlnum(3, fixedBytes([252, 1, 255, 2, 253, 254, 3])), '123');
    assert.equal(randomLowerAlnum(1, fixedBytes([251])), 'z');
  });

  it('공급자가 쓸 수 있는 바이트를 주지 않아도 끝난다', () => {
    const stuck = randomLowerAlnum(8, fixedBytes([255]));
    assert.match(stuck, /^[a-z0-9]{8}$/);
    const empty = randomLowerAlnum(8, () => new Uint8Array(0));
    assert.match(empty, /^[a-z0-9]{8}$/);
  });

  it('길이가 0 이하이거나 정수가 아니면 빈 문자열이다', () => {
    assert.equal(randomLowerAlnum(0), '');
    assert.equal(randomLowerAlnum(-3), '');
    assert.equal(randomLowerAlnum(2.5), '');
  });

  it('모든 글자가 고르게 나온다 (36글자 × 평균 500회)', () => {
    const counts = new Map<string, number>();
    for (const ch of randomLowerAlnum(18000)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    assert.equal(counts.size, 36);
    for (const [ch, count] of counts) {
      assert.ok(count > 350 && count < 650, `${ch}: ${count}`);
    }
  });
});

describe('참조 값 (room_ref, conn_ref, peer_ref, ip_ref)', () => {
  it('SHA-256 의 앞 12자리 16진수다', () => {
    assert.equal(refOf('abc'), 'ba7816bf8f01');
    assert.equal(refOf(''), 'e3b0c44298fc');
    assert.equal(refOf('방'), createHash('sha256').update('방', 'utf8').digest('hex').slice(0, 12));
    assert.match(refOf(newRoomId()), /^[0-9a-f]{12}$/);
  });

  it('원문이 결과에 드러나지 않는다', () => {
    const room = 'secretroom123456';
    assert.equal(refOf(room).includes(room), false);
    assert.notEqual(refOf(room), refOf('secretroom123457'));
  });
});
