// V-U6: 허용 필드 필터 (architecture.md 6.2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_EVENT_CHARS, MAX_LIST_ITEMS, MAX_STRING_CHARS, buildLine, filterFields, passesLevel } from './fields.js';
import type { LogService } from './log-port.js';

const T0 = Date.UTC(2026, 10, 15, 9, 30, 0);

function line(fields: unknown, service: LogService = 'mcp', extra: { module?: unknown; event?: unknown } = {}): Record<string, unknown> {
  const text = buildLine({
    service,
    proc: 'abc123',
    tsMs: T0,
    level: 'info',
    module: extra.module ?? 'mesh',
    event: extra.event ?? 'link.attempt_end',
    fields,
  });
  assert.notEqual(text, null);
  assert.ok(!(text as string).includes('\n'), '줄 안에 개행이 없어야 한다');
  return JSON.parse(text as string) as Record<string, unknown>;
}

describe('V-U6 허용 필드 필터', () => {
  it('로거가 붙이는 칸이 모든 줄에 있다', () => {
    assert.deepEqual(line(undefined), {
      ts: '2026-11-15T09:30:00.000Z',
      level: 'info',
      svc: 'mcp',
      proc: 'abc123',
      mod: 'mesh',
      event: 'link.attempt_end',
    });
  });

  it('허용 목록에 없는 키는 출력되지 않는다', () => {
    const out = line({ outcome: 'ok', text: '채팅 본문', sdp: 'v=0', candidate: 'candidate:1', key: 'secret', room_id: 'abcd1234' });
    assert.deepEqual(Object.keys(out), ['ts', 'level', 'svc', 'proc', 'mod', 'event', 'outcome']);
    assert.ok(!JSON.stringify(out).includes('채팅 본문'));
  });

  it('호출 지점이 로거의 칸을 덮어쓰지 못한다', () => {
    const out = line({ ts: 'x', level: 'error', svc: 'server', proc: 'zzzzzz', mod: 'x', event: 'x', dropped: 9 });
    assert.equal(out['proc'], 'abc123');
    assert.equal(out['svc'], 'mcp');
    assert.equal(out['event'], 'link.attempt_end');
    assert.equal('dropped' in out, false);
  });

  it('중첩 객체는 키째 버린다', () => {
    const out = line({ reason: { text: '본문' }, state: new Map([['a', 1]]), stage: () => 'x', kind: Symbol('k'), seq: 10n, attempt: 2 });
    assert.equal('reason' in out, false);
    assert.equal('state' in out, false);
    assert.equal('stage' in out, false);
    assert.equal('kind' in out, false);
    assert.equal('seq' in out, false);
    assert.equal(out['attempt'], 2);
  });

  it('목록 안의 객체는 버리고 스칼라만 남긴다', () => {
    const out = line({ targets: ['alice', { name: 'bob' }, 3, null, true, ['nested'], undefined] });
    assert.deepEqual(out['targets'], ['alice', 3, null, true]);
  });

  it('목록은 정해진 개수까지만 남긴다', () => {
    const out = line({ targets: Array.from({ length: MAX_LIST_ITEMS + 10 }, (_, i) => i) });
    assert.equal((out['targets'] as unknown[]).length, MAX_LIST_ITEMS);
  });

  it('오류 객체는 이름과 코드만 남긴다', () => {
    const error = Object.assign(new TypeError('피어가 보낸 글이 섞인 메시지'), { code: 'ERR_X' });
    const out = line({ error_code: error, reason: new Error('본문'), targets: [new RangeError('목록 안')] });
    assert.equal(out['error_code'], 'TypeError:ERR_X');
    assert.equal(out['reason'], 'Error');
    assert.deepEqual(out['targets'], ['RangeError']);
    const text = JSON.stringify(out);
    assert.ok(!text.includes('피어가 보낸'));
    assert.ok(!text.includes('본문'));
    assert.ok(!text.includes('목록 안'));
    assert.ok(!text.includes('at '), 'stack 이 없어야 한다');
  });

  it('문자열의 개행과 제어 문자를 공백으로 바꾼다', () => {
    const out = line({ reason: 'a\nb\r\nc\td\u0000e\u001bf\u007fg\u0085h\u2028i\u2029j' });
    assert.equal(out['reason'], 'a b  c d e f g h i j');
  });

  it('사건 이름의 개행도 바꾸고 길이를 자른다', () => {
    const out = line({}, 'mcp', { event: `join\n{"forged":true}${'x'.repeat(200)}` });
    assert.equal((out['event'] as string).length, MAX_EVENT_CHARS);
    assert.ok((out['event'] as string).startsWith('join {"forged":true}'));
  });

  it('긴 문자열은 자른다', () => {
    const out = line({ reason: 'x'.repeat(MAX_STRING_CHARS + 500) });
    assert.equal((out['reason'] as string).length, MAX_STRING_CHARS);
  });

  it('유한하지 않은 수와 undefined 는 버린다', () => {
    const out = line({ duration_ms: Number.NaN, attempt: Number.POSITIVE_INFINITY, bytes: undefined, seq: 0, dup: false, via: null });
    assert.equal('duration_ms' in out, false);
    assert.equal('attempt' in out, false);
    assert.equal('bytes' in out, false);
    assert.equal(out['seq'], 0);
    assert.equal(out['dup'], false);
    assert.equal(out['via'], null);
  });

  it('모르는 모듈 이름과 문자열이 아닌 사건 이름은 unknown 으로 남긴다', () => {
    const out = line({}, 'mcp', { module: 'evil\nmod', event: { a: 1 } });
    assert.equal(out['mod'], 'unknown');
    assert.equal(out['event'], 'unknown');
  });

  it('필드 자리에 객체가 아닌 것이 와도 줄은 나온다', () => {
    for (const fields of [null, 'text', 3, ['a'], new Error('x')]) {
      const out = line(fields);
      assert.deepEqual(Object.keys(out), ['ts', 'level', 'svc', 'proc', 'mod', 'event']);
    }
  });

  it('읽다가 던지는 필드는 줄을 버리고 던지지 않는다', () => {
    const fields = {
      get outcome(): string {
        throw new Error('getter');
      },
    };
    assert.equal(buildLine({ service: 'mcp', proc: 'abc123', tsMs: T0, level: 'info', module: 'mesh', event: 'x', fields }), null);
  });

  it('표현할 수 없는 시각은 줄을 버린다', () => {
    for (const tsMs of [Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
      assert.equal(buildLine({ service: 'mcp', proc: 'abc123', tsMs, level: 'info', module: 'mesh', event: 'x', fields: {} }), null);
    }
  });
});

describe('V-U6 peer 필드와 svc', () => {
  it('svc 가 server·lambda 면 peer 를 출력하지 않는다', () => {
    for (const service of ['server', 'lambda'] as const) {
      const out = line({ peer: 'alice', peer_ref: '0123456789ab', room_ref: 'ba9876543210' }, service);
      assert.equal('peer' in out, false, service);
      assert.equal(out['peer_ref'], '0123456789ab');
      assert.equal(out['room_ref'], 'ba9876543210');
      assert.equal(out['svc'], service);
    }
  });

  it('svc 가 mcp·cli·monitor 면 peer 를 출력한다', () => {
    for (const service of ['mcp', 'cli', 'monitor'] as const) {
      const out = line({ peer: 'alice' }, service);
      assert.equal(out['peer'], 'alice', service);
    }
  });

  it('filterFields 도 같은 규칙이다', () => {
    assert.deepEqual(filterFields({ peer: 'alice', from: 'bob' }, 'server'), { from: 'bob' });
    assert.deepEqual(filterFields({ peer: 'alice', from: 'bob' }, 'mcp'), { peer: 'alice', from: 'bob' });
  });
});

describe('V-U6 수준', () => {
  it('기준보다 낮은 수준은 통과하지 못한다', () => {
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    for (const [t, threshold] of levels.entries()) {
      for (const [l, level] of levels.entries()) {
        assert.equal(passesLevel(level, threshold), l >= t, `${level} / ${threshold}`);
      }
    }
  });

  it('모르는 수준은 쓰지 않는다', () => {
    assert.equal(passesLevel('trace', 'debug'), false);
    assert.equal(passesLevel(undefined, 'debug'), false);
    assert.equal(passesLevel('toString', 'debug'), false);
  });
});
