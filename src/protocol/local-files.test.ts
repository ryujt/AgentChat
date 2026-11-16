import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHANNEL_CHECK_FILE_NAME,
  CHANNEL_CHECK_VERSION,
  parseChannelCheck,
  serializeChannelCheck,
  type ChannelCheck,
} from './local-files.js';

const DOC_SAMPLE = `{ "v": 1, "host": "claude-code", "host_version": "2.1.325",
  "confirmed_at": "2026-11-15T03:00:00Z", "fallback_at": null }`;

const sample: ChannelCheck = {
  v: 1,
  host: 'claude-code',
  host_version: '2.1.325',
  confirmed_at: '2026-11-15T03:00:00Z',
  fallback_at: null,
};

function rejected(input: unknown): void {
  const result = parseChannelCheck(input);
  assert.equal(result.ok, false, typeof input === 'string' ? input : JSON.stringify(input));
  assert.equal(result.ok ? '' : result.code, 'BAD_FILE');
}

describe('확인 기록 파일 channel-check.json', () => {
  it('파일 이름과 형식 버전', () => {
    assert.equal(CHANNEL_CHECK_FILE_NAME, 'channel-check.json');
    assert.equal(CHANNEL_CHECK_VERSION, 1);
  });

  it('설계 문서의 예시를 그대로 읽는다', () => {
    assert.deepEqual(parseChannelCheck(DOC_SAMPLE), { ok: true, value: sample });
  });

  it('이미 파싱한 객체도 받는다', () => {
    assert.deepEqual(parseChannelCheck({ ...sample }), { ok: true, value: sample });
  });

  it('poll 로 되돌아간 시각이 있는 기록을 읽는다', () => {
    const withFallback = { ...sample, fallback_at: '2026-11-15T04:30:00.123Z' };
    assert.deepEqual(parseChannelCheck(JSON.stringify(withFallback)), { ok: true, value: withFallback });
  });

  it('Date 의 ISO 문자열을 시각으로 받는다', () => {
    const now = new Date(Date.UTC(2026, 10, 15, 3, 0, 0)).toISOString();
    assert.equal(parseChannelCheck({ ...sample, confirmed_at: now, fallback_at: now }).ok, true);
  });

  it('모르는 필드는 버린다', () => {
    assert.deepEqual(parseChannelCheck({ ...sample, note: 'x' }), { ok: true, value: sample });
  });

  it('필드가 빠지면 거절한다', () => {
    for (const field of ['v', 'host', 'host_version', 'confirmed_at', 'fallback_at']) {
      const broken: Record<string, unknown> = { ...sample };
      delete broken[field];
      rejected(broken);
    }
  });

  it('다른 형식 버전을 거절한다', () => {
    rejected({ ...sample, v: 2 });
    rejected({ ...sample, v: '1' });
  });

  it('시각이 UTC ISO 8601 이 아니면 거절한다', () => {
    rejected({ ...sample, confirmed_at: '2026-11-15 03:00:00' });
    rejected({ ...sample, confirmed_at: '2026-11-15T03:00:00+09:00' });
    rejected({ ...sample, confirmed_at: '2026-11-15' });
    rejected({ ...sample, confirmed_at: 1794700000000 });
    rejected({ ...sample, confirmed_at: null });
    rejected({ ...sample, fallback_at: 'yesterday' });
    rejected({ ...sample, fallback_at: '' });
  });

  it('호스트 정보가 문자열이 아니면 거절한다', () => {
    rejected({ ...sample, host: 5 });
    rejected({ ...sample, host_version: null });
  });

  it('JSON 이 아니거나 객체가 아니면 거절한다', () => {
    for (const input of ['', 'not json', '{', '[]', 'null', '"x"', null, undefined, 42, [sample]]) {
      rejected(input);
    }
  });

  it('쓴 내용을 다시 읽으면 같은 값이다', () => {
    const fallback: ChannelCheck = { ...sample, fallback_at: '2026-11-15T05:00:00Z' };
    for (const value of [sample, fallback]) {
      const text = serializeChannelCheck(value);
      assert.equal(text.ok, true);
      if (!text.ok) continue;
      assert.equal(text.value.endsWith('\n'), true);
      assert.deepEqual(parseChannelCheck(text.value), { ok: true, value });
    }
  });

  it('읽는 쪽이 거절할 내용은 쓰지 않는다', () => {
    const broken = { ...sample, confirmed_at: 'now' } as ChannelCheck;
    const result = serializeChannelCheck(broken);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'BAD_FILE');
  });
});
