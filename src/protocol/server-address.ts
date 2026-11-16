// 서버 주소 정규화 (protocol.md 6절).
// 결과 문자열이 접속 URL 이자 방을 구분하는 서버 키라서, 같은 서버는 항상 같은 문자열이 돼야 한다.

import { err, ok, type Result } from './result.js';

/** server 인자와 AGENT_CHAT_SERVER 가 모두 없을 때 쓰는 공용 서버. */
export const DEFAULT_SERVER_URL = 'wss://agent-chat.tools.camp';

/** 스킴 없이 IP 나 localhost 를 줬을 때 붙이는 자체 호스팅 기본 포트. */
export const SELF_HOST_DEFAULT_PORT = 8787;

export interface ServerAddress {
  /** 접속 URL. 경로와 쿼리에 방 ID·이름·key 를 싣지 않는다. */
  readonly url: string;
  /** 방을 구분하는 서버 키. 정규화한 URL 문자열과 같다. */
  readonly serverKey: string;
  /** wss 인가. 거짓이면 방 ID 와 SDP 가 평문으로 지나간다. */
  readonly secure: boolean;
}

type Scheme = 'ws' | 'wss';

const EXPLICIT_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f\\]/;
const PORT = /^[0-9]{1,5}$/;
const IPV4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;
const DEFAULT_PORT: Readonly<Record<Scheme, number>> = { ws: 80, wss: 443 };

function invalid(detail: string): Result<never, 'INVALID_ARGUMENT'> {
  return err('INVALID_ARGUMENT', detail);
}

interface Authority {
  /** URL 에 넣을 호스트 원문. IPv6 는 대괄호를 포함한다. */
  readonly hostText: string;
  readonly port: number | null;
}

function parseAuthority(authority: string): Result<Authority, 'INVALID_ARGUMENT'> {
  if (authority.includes('@')) return invalid('server address must not contain user info');
  // URL 해석기는 호스트의 %XX 를 풀어 다른 이름으로 만든다. 눈에 보이는 이름과 접속하는 이름이 달라지지 않게 막는다.
  if (authority.includes('%')) return invalid('server address has an invalid host');
  let hostText: string;
  let portText: string | null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return invalid('server address has an unclosed "["');
    hostText = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after === '') portText = null;
    else if (after.startsWith(':')) portText = after.slice(1);
    else return invalid('server address has unexpected text after "]"');
  } else {
    const first = authority.indexOf(':');
    if (first >= 0 && authority.indexOf(':', first + 1) >= 0) {
      // 대괄호 없는 IPv6 는 주소와 포트의 경계가 모호하다(`::1:8787` 은 그대로도 올바른 주소다).
      // 추측해서 감싸지 않는다. 입력에서도 대괄호를 요구한다(protocol.md 6절).
      return invalid('an IPv6 server address must be written in brackets, e.g. [2001:db8::1]:8787');
    }
    hostText = first < 0 ? authority : authority.slice(0, first);
    portText = first < 0 ? null : authority.slice(first + 1);
  }
  if (hostText === '' || hostText === '[]') return invalid('server address has an empty host');
  if (portText === null) return ok({ hostText, port: null });
  if (!PORT.test(portText)) return invalid('server address has an invalid port');
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > 65535) return invalid('server address has an invalid port');
  return ok({ hostText, port });
}

/**
 * `server` 인자나 AGENT_CHAT_SERVER 값을 접속 URL 로 바꾼다.
 * 규칙은 protocol.md 6절의 표를 위에서부터 처음 맞는 행으로 적용한 것이다.
 */
export function normalizeServerAddress(
  input: string | undefined | null,
): Result<ServerAddress, 'INVALID_ARGUMENT'> {
  const raw = (input ?? '').trim();
  if (raw === '') {
    return ok({ url: DEFAULT_SERVER_URL, serverKey: DEFAULT_SERVER_URL, secure: true });
  }
  if (UNSAFE_CHARS.test(raw)) {
    return invalid('server address must not contain spaces, control characters or backslashes');
  }
  if (raw.includes('?')) return invalid('server address must not contain a query');
  if (raw.includes('#')) return invalid('server address must not contain a fragment');

  let scheme: Scheme | null = null;
  let rest = raw;
  const explicit = EXPLICIT_SCHEME.exec(raw);
  if (explicit !== null) {
    switch ((explicit[1] ?? '').toLowerCase()) {
      case 'ws':
      case 'http':
        scheme = 'ws';
        break;
      case 'wss':
      case 'https':
        scheme = 'wss';
        break;
      default:
        return invalid('server address scheme must be ws, wss, http or https');
    }
    rest = raw.slice(explicit[0].length);
  }

  const slash = rest.indexOf('/');
  const authorityText = slash < 0 ? rest : rest.slice(0, slash);
  const pathText = slash < 0 ? '' : rest.slice(slash);

  const authority = parseAuthority(authorityText);
  if (!authority.ok) return authority;

  // 호스트의 소문자화, IPv6·IPv4 표기 정리, 금지 문자 거절은 URL 해석기에 맡긴다.
  let hostname: string;
  try {
    hostname = new URL(`ws://${authority.value.hostText}/`).hostname;
  } catch {
    return invalid('server address has an invalid host');
  }
  if (hostname === '') return invalid('server address has an empty host');

  let port = authority.value.port;
  if (scheme === null) {
    const isAddress = hostname.startsWith('[') || IPV4.test(hostname) || hostname === 'localhost';
    if (isAddress) {
      // IP 주소에는 보통 유효한 TLS 인증서가 없다. 평문과 자체 호스팅 기본 포트를 고른다.
      scheme = 'ws';
      port ??= SELF_HOST_DEFAULT_PORT;
    } else if (port === null || port === DEFAULT_PORT.wss) {
      // 호스트 이름만 주면 TLS 종단 뒤에 있다고 본다.
      scheme = 'wss';
    } else {
      scheme = 'ws';
    }
  }

  const portText = port === null || port === DEFAULT_PORT[scheme] ? '' : `:${port}`;
  let pathname: string;
  try {
    const parsed = new URL(`${scheme}://${hostname}${portText}${pathText}`);
    if (parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      return invalid('server address must not contain a query, fragment or user info');
    }
    pathname = parsed.pathname.replace(/\/+$/, '');
  } catch {
    return invalid('server address has an invalid path');
  }

  const url = `${scheme}://${hostname}${portText}${pathname}`;
  return ok({ url, serverKey: url, secure: scheme === 'wss' });
}
