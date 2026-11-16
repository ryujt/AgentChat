import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SERVER_URL, SELF_HOST_DEFAULT_PORT, normalizeServerAddress } from './server-address.js';

function url(input: string | undefined | null): string {
  const result = normalizeServerAddress(input);
  assert.equal(result.ok, true, `${String(input)} → ${result.ok ? '' : result.detail}`);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.value.serverKey, result.value.url, '서버 키는 정규화한 URL 문자열이다');
  assert.equal(result.value.secure, result.value.url.startsWith('wss://'));
  return result.value.url;
}

function rejected(input: string): string {
  const result = normalizeServerAddress(input);
  assert.equal(result.ok, false, `${input} → ${result.ok ? result.value.url : ''}`);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.code, 'INVALID_ARGUMENT');
  return result.detail;
}

describe('서버 주소 정규화: 6절 표의 행', () => {
  it('생략 또는 빈 값 → 공용 서버', () => {
    assert.equal(DEFAULT_SERVER_URL, 'wss://agent-chat.tools.camp');
    assert.equal(url(undefined), 'wss://agent-chat.tools.camp');
    assert.equal(url(null), 'wss://agent-chat.tools.camp');
    assert.equal(url(''), 'wss://agent-chat.tools.camp');
    assert.equal(url('   '), 'wss://agent-chat.tools.camp');
  });

  it('ws://, wss:// 로 시작 → 그대로', () => {
    assert.equal(url('ws://10.0.0.5:9000'), 'ws://10.0.0.5:9000');
    assert.equal(url('wss://chat.example.com'), 'wss://chat.example.com');
    assert.equal(url('ws://chat.example.com'), 'ws://chat.example.com');
    assert.equal(url('wss://203.0.113.5:8443'), 'wss://203.0.113.5:8443');
    // 스킴을 직접 쓰면 IP 여도 자체 호스팅 기본 포트를 붙이지 않는다
    assert.equal(url('ws://203.0.113.5'), 'ws://203.0.113.5');
  });

  it('http://, https:// 로 시작 → ws://, wss:// 로 바꾼다', () => {
    assert.equal(url('https://chat.example.com'), 'wss://chat.example.com');
    assert.equal(url('http://chat.example.com'), 'ws://chat.example.com');
    assert.equal(url('http://10.0.0.5:9000'), 'ws://10.0.0.5:9000');
    assert.equal(url('https://chat.example.com:8443/signal'), 'wss://chat.example.com:8443/signal');
  });

  it('스킴 없음, 호스트가 IP 또는 localhost → ws://, 포트 생략 시 8787', () => {
    assert.equal(SELF_HOST_DEFAULT_PORT, 8787);
    assert.equal(url('203.0.113.5'), 'ws://203.0.113.5:8787');
    assert.equal(url('[2001:db8::1]:9000'), 'ws://[2001:db8::1]:9000');
    assert.equal(url('[2001:db8::1]'), 'ws://[2001:db8::1]:8787');
    assert.equal(url('203.0.113.5:9000'), 'ws://203.0.113.5:9000');
    assert.equal(url('localhost'), 'ws://localhost:8787');
    assert.equal(url('localhost:3000'), 'ws://localhost:3000');
    assert.equal(url('127.0.0.1'), 'ws://127.0.0.1:8787');
    // 표의 위에서부터 처음 맞는 행을 쓴다: IP 는 포트가 443 이어도 이 행이다
    assert.equal(url('203.0.113.5:443'), 'ws://203.0.113.5:443');
  });

  it('스킴 없음, 호스트 이름, 포트 생략 또는 443 → wss://', () => {
    assert.equal(url('chat.example.com'), 'wss://chat.example.com');
    assert.equal(url('chat.example.com:443'), 'wss://chat.example.com');
    assert.equal(url('agent-chat.tools.camp'), 'wss://agent-chat.tools.camp');
    assert.equal(url('intranet-host'), 'wss://intranet-host');
  });

  it('스킴 없음, 호스트 이름, 다른 포트 → ws://', () => {
    assert.equal(url('chat.example.com:8787'), 'ws://chat.example.com:8787');
    assert.equal(url('chat.example.com:8443'), 'ws://chat.example.com:8443');
    assert.equal(url('chat.example.com:80'), 'ws://chat.example.com');
  });
});

describe('서버 주소 정규화: 공통 규칙', () => {
  it('호스트와 스킴을 소문자로 바꾼다', () => {
    assert.equal(url('Chat.Example.COM'), 'wss://chat.example.com');
    assert.equal(url('WSS://Chat.Example.COM'), 'wss://chat.example.com');
    assert.equal(url('HTTPS://CHAT.EXAMPLE.COM'), 'wss://chat.example.com');
    assert.equal(url('LOCALHOST'), 'ws://localhost:8787');
  });

  it('IPv6 는 대괄호로 감싸고 표기를 하나로 맞춘다', () => {
    assert.equal(url('ws://[2001:DB8:0:0:0:0:0:1]:9000'), 'ws://[2001:db8::1]:9000');
    assert.equal(url('[2001:DB8::1]'), 'ws://[2001:db8::1]:8787');
    assert.equal(url('ws://[::1]:8787'), 'ws://[::1]:8787');
  });

  it('기본 포트(ws 80, wss 443)는 지운다', () => {
    assert.equal(url('ws://chat.example.com:80'), 'ws://chat.example.com');
    assert.equal(url('wss://chat.example.com:443'), 'wss://chat.example.com');
    assert.equal(url('https://chat.example.com:443'), 'wss://chat.example.com');
    assert.equal(url('http://chat.example.com:80'), 'ws://chat.example.com');
    // 다른 스킴의 기본 포트는 그대로 둔다
    assert.equal(url('ws://chat.example.com:443'), 'ws://chat.example.com:443');
    assert.equal(url('wss://chat.example.com:80'), 'wss://chat.example.com:80');
  });

  it('끝의 / 는 지운다', () => {
    assert.equal(url('wss://chat.example.com/'), 'wss://chat.example.com');
    assert.equal(url('chat.example.com/'), 'wss://chat.example.com');
    assert.equal(url('wss://chat.example.com/signal/'), 'wss://chat.example.com/signal');
    assert.equal(url('203.0.113.5/'), 'ws://203.0.113.5:8787');
  });

  it('경로는 있으면 유지한다', () => {
    assert.equal(url('wss://chat.example.com/signal'), 'wss://chat.example.com/signal');
    assert.equal(url('chat.example.com/a/b'), 'wss://chat.example.com/a/b');
    assert.equal(url('203.0.113.5:9000/ws'), 'ws://203.0.113.5:9000/ws');
    assert.equal(url('wss://chat.example.com/Signal'), 'wss://chat.example.com/Signal');
  });

  it('같은 서버를 가리키는 여러 표기가 같은 서버 키가 된다', () => {
    const forms = [
      'chat.example.com',
      'CHAT.example.com',
      'chat.example.com:443',
      'chat.example.com/',
      'wss://chat.example.com',
      'wss://chat.example.com:443/',
      'https://chat.example.com',
      '  wss://chat.example.com  ',
    ];
    assert.deepEqual([...new Set(forms.map(url))], ['wss://chat.example.com']);
  });

  it('정규화한 결과를 다시 넣어도 그대로다', () => {
    for (const input of [
      undefined,
      '203.0.113.5',
      '[2001:db8::1]:9000',
      'chat.example.com',
      'chat.example.com:8787',
      'https://chat.example.com/signal/',
      'localhost',
    ]) {
      const once = url(input);
      assert.equal(url(once), once);
    }
  });
});

describe('서버 주소 정규화: 오류 입력은 INVALID_ARGUMENT', () => {
  it('쿼리, 조각, 사용자 정보', () => {
    assert.match(rejected('wss://chat.example.com/?room=abc'), /query/);
    assert.match(rejected('chat.example.com?x=1'), /query/);
    assert.match(rejected('wss://chat.example.com/?'), /query/);
    assert.match(rejected('wss://chat.example.com/#frag'), /fragment/);
    assert.match(rejected('chat.example.com#'), /fragment/);
    assert.match(rejected('wss://user@chat.example.com'), /user info/);
    assert.match(rejected('wss://user:pass@chat.example.com'), /user info/);
    assert.match(rejected('user@chat.example.com'), /user info/);
    assert.match(rejected('ws://@chat.example.com'), /user info/);
  });

  it('다른 스킴', () => {
    for (const input of ['ftp://chat.example.com', 'stun://stun.example.com', 'file:///etc/hosts', 'turn://relay.example.com']) {
      assert.match(rejected(input), /scheme/, input);
    }
  });

  it('빈 호스트', () => {
    for (const input of ['ws://', 'wss:///path', 'https://:8787', ':8787', '/', '//', '[]']) {
      rejected(input);
    }
  });

  it('잘못된 포트', () => {
    for (const input of ['chat.example.com:0', 'chat.example.com:65536', 'chat.example.com:abc', 'chat.example.com:', 'ws://h:99999', '[::1]:', '203.0.113.5:-1']) {
      assert.match(rejected(input), /port/, input);
    }
  });

  it('대괄호 없는 IPv6 는 주소와 포트를 가를 수 없어 거절한다 (입력에서도 대괄호가 필요하다)', () => {
    assert.match(rejected('2001:db8::1'), /brackets/);
    assert.match(rejected('::1'), /brackets/);
    assert.match(rejected('ws://2001:db8::1'), /brackets/);
    // 아래 둘은 그대로도 올바른 IPv6 주소라, 끝의 숫자가 포트인지 주소의 일부인지 알 수 없다.
    assert.match(rejected('::1:8787'), /brackets/);
    assert.match(rejected('2001:db8::1:9000'), /brackets/);
    // 대괄호로 적으면 받는다
    assert.equal(normalizeServerAddress('[::1]').ok, true);
    assert.equal(normalizeServerAddress('[::1]:8787').ok, true);
  });

  it('잘못된 호스트', () => {
    for (const input of ['[::1', '[::1]x', '[not-ipv6]', '999.1.1.1', '1.2.3.4.5', 'exa%6dple.com', 'ws://ex ample.com', 'a b', 'chat.example.com\\path', 'chat\texample.com']) {
      rejected(input);
    }
  });

  it('스킴 표기가 어긋난 것을 호스트로 받아들이지 않는다', () => {
    rejected('ws:chat.example.com');
    rejected('wss:/chat.example.com');
    rejected('stun:stun.l.google.com:19302');
  });

  it('거절해도 공용 서버로 바꿔 돌려주지 않는다', () => {
    const result = normalizeServerAddress('ftp://chat.example.com');
    assert.deepEqual(Object.keys(result).sort(), ['code', 'detail', 'ok']);
  });
});
