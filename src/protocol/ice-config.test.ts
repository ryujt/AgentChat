import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_ICE_SERVERS, STUN_DEFAULT_PORT, isRelayCandidate, parseIceServers } from './ice-config.js';

function urls(input: string | undefined | null): string[] {
  const result = parseIceServers(input);
  assert.equal(result.ok, true, `${String(input)} → ${result.ok ? '' : result.detail}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value.map((server) => server.url);
}

function rejected(input: string): string {
  const result = parseIceServers(input);
  assert.equal(result.ok, false, input);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.code, 'ICE_CONFIG_REJECTED');
  assert.deepEqual(Object.keys(result).sort(), ['code', 'detail', 'ok'], '거절하면 쓸 수 있는 목록을 돌려주지 않는다');
  return result.detail;
}

describe('ICE 서버 설정: 허용', () => {
  it('생략하거나 비우면 기본 STUN 서버 하나다', () => {
    assert.equal(DEFAULT_ICE_SERVERS, 'stun:stun.l.google.com:19302');
    assert.deepEqual(urls(undefined), ['stun:stun.l.google.com:19302']);
    assert.deepEqual(urls(null), ['stun:stun.l.google.com:19302']);
    assert.deepEqual(urls(''), ['stun:stun.l.google.com:19302']);
    assert.deepEqual(urls('  '), ['stun:stun.l.google.com:19302']);
  });

  it('none 이면 STUN 없이 host 후보만 쓴다 (빈 목록)', () => {
    assert.deepEqual(urls('none'), []);
    assert.deepEqual(urls(' none '), []);
    assert.deepEqual(urls('NONE'), []);
  });

  it('stun: 을 받는다. 포트는 있어도 되고 없어도 된다(없으면 3478)', () => {
    assert.equal(STUN_DEFAULT_PORT, 3478);
    assert.deepEqual(parseIceServers('stun:stun.example.com:19302'), {
      ok: true,
      value: [{ url: 'stun:stun.example.com:19302', hostname: 'stun.example.com', port: 19302 }],
    });
    assert.deepEqual(parseIceServers('stun:stun.example.com'), {
      ok: true,
      value: [{ url: 'stun:stun.example.com', hostname: 'stun.example.com', port: 3478 }],
    });
    assert.deepEqual(urls('stun:192.0.2.10:3478'), ['stun:192.0.2.10:3478']);
    assert.deepEqual(urls('stun:a:1'), ['stun:a:1']);
    assert.deepEqual(urls('stun:a:65535'), ['stun:a:65535']);
  });

  it('IPv6 는 url 에는 대괄호째, 라이브러리에 넘길 hostname 에는 대괄호 없이 준다', () => {
    assert.deepEqual(parseIceServers('stun:[2001:db8::1]:3478'), {
      ok: true,
      value: [{ url: 'stun:[2001:db8::1]:3478', hostname: '2001:db8::1', port: 3478 }],
    });
    assert.deepEqual(parseIceServers('stun:[2001:DB8::1]'), {
      ok: true,
      value: [{ url: 'stun:[2001:db8::1]', hostname: '2001:db8::1', port: 3478 }],
    });
    assert.deepEqual(parseIceServers('stun:[::1]:5000'), {
      ok: true,
      value: [{ url: 'stun:[::1]:5000', hostname: '::1', port: 5000 }],
    });
  });

  it('통과한 값의 hostname 에는 대괄호와 콜론 뒤 포트가 섞이지 않는다', () => {
    for (const input of ['stun:a.example.com', 'stun:a.example.com:1', 'stun:192.0.2.1', 'stun:[2001:db8::1]', 'stun:[::ffff:192.0.2.1]:9']) {
      const result = parseIceServers(input);
      assert.equal(result.ok, true, input);
      if (!result.ok) continue;
      for (const server of result.value) {
        assert.equal(/[[\]]/.test(server.hostname), false, input);
        assert.ok(Number.isInteger(server.port) && server.port >= 1 && server.port <= 65535, input);
        assert.ok(server.url.startsWith('stun:'), input);
      }
    }
  });

  it('쉼표로 여러 개를 준다. 순서를 지키고 앞뒤 공백을 버린다', () => {
    assert.deepEqual(urls('stun:a.example.com:3478, stun:b.example.com:5349 ,stun:c.example.com'), [
      'stun:a.example.com:3478',
      'stun:b.example.com:5349',
      'stun:c.example.com',
    ]);
  });

  it('스킴과 호스트는 소문자로 맞추고 같은 서버는 한 번만 남긴다', () => {
    assert.deepEqual(urls('STUN:Stun.Example.COM:3478,stun:stun.example.com:3478'), ['stun:stun.example.com:3478']);
    // 포트를 생략한 것과 기본 포트를 적은 것은 같은 서버다. 먼저 적은 모양이 남는다.
    assert.deepEqual(urls('stun:a.example.com,stun:a.example.com:3478'), ['stun:a.example.com']);
    assert.deepEqual(urls('stun:a.example.com:3478,stun:a.example.com:3479'), ['stun:a.example.com:3478', 'stun:a.example.com:3479']);
  });
});

describe('ICE 서버 설정: 거절', () => {
  it('turn: 과 turns: 는 거절한다', () => {
    for (const input of [
      'turn:relay.example.com:3478',
      'turns:relay.example.com:5349',
      'TURN:relay.example.com',
      'Turns:relay.example.com',
      'turn:relay.example.com:3478?transport=tcp',
      'turn:user:pass@relay.example.com',
    ]) {
      assert.match(rejected(input), /TURN/, input);
    }
  });

  it('stuns: 는 거절한다. 고정한 WebRTC 라이브러리가 받지 않는다', () => {
    for (const input of ['stuns:stun.example.com', 'stuns:stun.example.com:5349', 'STUNS:stun.example.com', 'stuns:[2001:db8::1]:5349']) {
      const detail = rejected(input);
      assert.match(detail, /stuns:/, input);
      assert.doesNotMatch(detail, /TURN/, input);
      assert.equal(detail.includes('example.com'), false, input);
    }
    assert.match(rejected('stun:a.example.com,stuns:b.example.com'), /entry 2/);
    rejected('stuns:b.example.com,stun:a.example.com');
  });

  it('섞인 목록은 전체를 거절한다. 일부만 걸러 쓰지 않는다', () => {
    rejected('stun:stun.example.com:3478,turn:relay.example.com:3478');
    rejected('turn:relay.example.com:3478,stun:stun.example.com:3478');
    rejected('stun:a.example.com,stun:b.example.com,turns:relay.example.com,stun:c.example.com');
    assert.match(rejected('stun:stun.example.com:3478,turn:relay.example.com:3478'), /entry 2/);
  });

  it('그 밖의 모든 스킴을 거절한다', () => {
    for (const input of ['http://stun.example.com', 'https:stun.example.com', 'ws:stun.example.com', 'relay:x', 'stunx:a', 'xstun:a']) {
      rejected(input);
    }
  });

  it('스킴이 없거나 호스트가 없는 항목을 거절한다', () => {
    for (const input of ['stun.example.com', 'stun.example.com:3478', 'stun:', 'stuns:', 'stun::3478', 'stun:::1', 'stun:2001:db8::1', 'stun://stun.example.com', '192.0.2.10']) {
      rejected(input);
    }
  });

  it('STUN URL 에 없는 부분(쿼리, 사용자 정보, 경로)과 잘못된 포트를 거절한다', () => {
    for (const input of [
      'stun:stun.example.com?transport=udp',
      'stun:user@stun.example.com',
      'stun:stun.example.com/path',
      'stun:stun.example.com:0',
      'stun:stun.example.com:65536',
      'stun:stun.example.com:abc',
      'stun:stun.example.com:',
      'stun:[::1',
      'stun:[zz]',
      'stun:bad host',
      'stun:-bad.example.com',
    ]) {
      rejected(input);
    }
  });

  it('빈 항목과 none 을 섞은 목록을 거절한다', () => {
    assert.match(rejected('stun:a.example.com,,stun:b.example.com'), /entry 2/);
    rejected('stun:a.example.com,');
    rejected(',');
    rejected('none,stun:a.example.com');
    rejected('stun:a.example.com,none');
  });

  it('거절 사유에 항목의 원문을 싣지 않는다 (TURN URL 의 자격 증명이 새지 않게)', () => {
    const detail = rejected('turn:alice:s3cr3t-pass@relay.example.com:3478');
    assert.equal(detail.includes('s3cr3t'), false);
    assert.equal(detail.includes('alice'), false);
    assert.equal(detail.includes('relay.example.com'), false);
    const other = rejected('stun:stun.example.com:3478,https://token-abc@host.example.com');
    assert.equal(other.includes('token-abc'), false);
  });

  it('어떤 입력에도 예외를 던지지 않는다', () => {
    for (const input of [':', '::', '[', 'stun:[', 'stun:]', '\u0000', 'stun:\u0000', ',,,,', 'stun:' + 'a'.repeat(5000)]) {
      assert.doesNotThrow(() => parseIceServers(input), input);
      assert.equal(parseIceServers(input).ok, false, input);
    }
  });
});

describe('relay 후보 판별', () => {
  const host = 'candidate:1 1 UDP 2122317823 192.0.2.10 50000 typ host';
  const srflx = 'candidate:2 1 UDP 1686109951 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0';
  const prflx = 'candidate:4 1 UDP 1686109951 203.0.113.9 50003 typ prflx raddr 0.0.0.0 rport 0';
  const relay = 'candidate:3 1 UDP 8331007 198.51.100.7 50002 typ relay raddr 0.0.0.0 rport 0';

  it('typ relay 후보만 참이다', () => {
    assert.equal(isRelayCandidate(relay), true);
    assert.equal(isRelayCandidate(`a=${relay}`), true);
    assert.equal(isRelayCandidate(host), false);
    assert.equal(isRelayCandidate(srflx), false);
    assert.equal(isRelayCandidate(prflx), false);
    assert.equal(isRelayCandidate(''), false);
  });

  it('SDP 안에 relay 후보 줄이 하나라도 있으면 참이다', () => {
    const clean = `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=${host}\r\na=${srflx}\r\na=end-of-candidates\r\n`;
    assert.equal(isRelayCandidate(clean), false);
    assert.equal(isRelayCandidate(`${clean}a=${relay}\r\n`), true);
  });

  it('공백이 여러 칸이거나 탭이어도 relay 로 본다', () => {
    assert.equal(isRelayCandidate('candidate:3 1 UDP 8331007 198.51.100.7 50002 typ  relay'), true);
    assert.equal(isRelayCandidate('candidate:3 1 UDP 8331007 198.51.100.7 50002\ttyp\trelay'), true);
    assert.equal(isRelayCandidate('candidate:3 1 UDP 8331007 198.51.100.7 50002 TYP RELAY'), true);
  });

  it('relay 라는 글자가 다른 자리에 있는 것은 relay 후보가 아니다', () => {
    assert.equal(isRelayCandidate('candidate:relay 1 UDP 1 192.0.2.10 50000 typ host'), false);
    assert.equal(isRelayCandidate('s=relay session\r\n'), false);
    assert.equal(isRelayCandidate('typrelay'), false);
  });
});
