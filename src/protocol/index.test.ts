import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as protocol from './index.js';

describe('protocol 공개 진입점 (architecture.md 3.1)', () => {
  it('설계가 적은 진입점이 모두 있다', () => {
    const functions = [
      'parseClientMessage',
      'parseServerMessage',
      'parseP2PFrame',
      'encodeClientMessage',
      'encodeP2PFrame',
      'newRoomId',
      'isPeerName',
      'normalizeServerAddress',
      'parseIceServers',
      'isRelayCandidate',
    ] as const;
    for (const name of functions) {
      assert.equal(typeof protocol[name], 'function', name);
    }
    assert.equal(typeof protocol.stateRecordSchema.safeParse, 'function');
    assert.equal(protocol.LIMITS.ROOM_MAX_PEERS, 8);
  });

  it('다른 모듈이 쓰는 함수가 모두 있다', () => {
    // 다른 모듈은 이 파일만 import 한다. 여기서 빠지면 그 모듈이 쓸 길이 없다.
    const functions = [
      'encodeServerMessage',
      'signalCarriesRelay',
      'isSignalMessageTooLarge',
      'isSignalErrorCode',
      'packStateFrames',
      'parseStateRecord',
      'stateFingerprint',
      'canonicalJson',
      'compareCanonical',
      'recordByteSize',
      'recordIdentity',
      'presenceKey',
      'isLinkFailure',
      'isOfferSide',
      'comparePeerNames',
      'checkPeerName',
      'makeCid',
      'parseCid',
      'makeEntryId',
      'parseEntryId',
      'newSid',
      'newResumeKey',
      'refOf',
      'utf8ByteLength',
      'parseChannelCheck',
      'serializeChannelCheck',
    ] as const;
    for (const name of functions) {
      assert.equal(typeof protocol[name], 'function', name);
    }
    assert.equal(protocol.STATE_CLOCK_MAX, Number.MAX_SAFE_INTEGER);
  });

  it('공개 이름에 undefined 가 없다 (다시 내보내기의 오타를 잡는다)', () => {
    for (const [name, value] of Object.entries(protocol)) {
      assert.notEqual(value, undefined, name);
    }
  });

  it('결과는 {ok:true, value} 또는 {ok:false, code, detail} 이다', () => {
    const good = [
      protocol.parseClientMessage('{"action":"ping","id":"p1"}'),
      protocol.parseServerMessage('{"type":"pong","re":"p1","members":[]}'),
      protocol.parseP2PFrame('{"v":1,"t":"pong","n":1}'),
      protocol.normalizeServerAddress('chat.example.com'),
      protocol.parseIceServers('stun:stun.example.com'),
      protocol.parseChannelCheck({ v: 1, host: 'h', host_version: '1', confirmed_at: '2026-11-15T03:00:00Z', fallback_at: null }),
    ];
    for (const result of good) {
      assert.equal(result.ok, true);
      assert.ok('value' in result);
    }
    const bad = [
      protocol.parseClientMessage('nope'),
      protocol.parseServerMessage('nope'),
      protocol.parseP2PFrame('nope'),
      protocol.normalizeServerAddress('ftp://x'),
      protocol.parseIceServers('turn:x'),
      protocol.parseStateRecord({}),
      protocol.parseChannelCheck('nope'),
      protocol.makeCid('bad', 1),
      protocol.checkPeerName('system'),
    ];
    for (const result of bad) {
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(typeof result.code, 'string');
      assert.ok(result.code.length > 0);
      assert.equal(typeof result.detail, 'string');
      assert.ok(result.detail.length > 0);
    }
  });

  it('해석 함수는 어떤 문자열에도 예외를 던지지 않는다', () => {
    const nasty = [
      '',
      ' ',
      '\u0000',
      '\ud800',
      '{}',
      '[]',
      'null',
      '0',
      '"',
      '{"a":',
      '{"__proto__":{"x":1}}',
      '{"constructor":{"prototype":{}}}',
      `{"action":"join","v":1,"id":"a","room":${'['.repeat(200)}${']'.repeat(200)}}`,
      `{"v":1,"t":"state","records":[${Array(50).fill('{"kind":"claim"}').join(',')}]}`,
      '{"type":"joined","re":"a","members":[{"peer":{"toString":"x"},"sid":[]}]}',
      'x'.repeat(70000),
      '가'.repeat(30000),
    ];
    const parsers: ((text: string) => { ok: boolean })[] = [
      protocol.parseClientMessage,
      protocol.parseServerMessage,
      protocol.parseP2PFrame,
      protocol.normalizeServerAddress,
      protocol.parseIceServers,
      protocol.parseChannelCheck,
      protocol.parseStateRecord,
      protocol.parseCid,
      protocol.parseEntryId,
      protocol.checkPeerName,
    ];
    for (const parse of parsers) {
      for (const text of nasty) {
        assert.doesNotThrow(() => parse(text), `${parse.name}(${JSON.stringify(text.slice(0, 40))})`);
        assert.equal(typeof parse(text).ok, 'boolean');
      }
    }
  });

  it('바이트 길이는 UTF-8 로 잰다', () => {
    assert.equal(protocol.utf8ByteLength(''), 0);
    assert.equal(protocol.utf8ByteLength('abc'), 3);
    assert.equal(protocol.utf8ByteLength('가'), 3);
    assert.equal(protocol.utf8ByteLength('😀'), 4);
  });
});
