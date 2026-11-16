// ICE 서버 설정 검증과 relay 후보 판별 (protocol.md 7절).
// TURN URL 을 받지 않는 것이 relay 를 막는 유일하게 확실한 수단이라 여기서 전부 거절한다.

import { err, ok, type Result } from './result.js';

/** AGENT_CHAT_ICE_SERVERS 를 주지 않았을 때 쓰는 값. */
export const DEFAULT_ICE_SERVERS = 'stun:stun.l.google.com:19302';

/** STUN 없이 host 후보만 쓰겠다는 설정 값. */
export const ICE_SERVERS_NONE = 'none';

/** STUN URL 에 포트가 없을 때의 포트 (RFC 8489). */
export const STUN_DEFAULT_PORT = 3478;

/**
 * 검증을 통과한 STUN 서버 하나.
 * WebRTC 라이브러리에는 `url` 이 아니라 `{hostname, port}` 를 넘긴다. 고정한 node-datachannel 0.33.6 은
 * 대괄호가 든 IPv6 URL 문자열을 받지 못하고 예외를 던진다(실측. tests/test-history/2026-11-15-w0-contracts.md 의 W0-36).
 */
export interface IceServer {
  /** 정규화한 URL. `stun:<host>[:<port>]`. 표시용이다. IPv6 는 대괄호를 포함한다. */
  readonly url: string;
  /** 소문자 호스트. IPv6 는 대괄호 없이 적는다. */
  readonly hostname: string;
  /** URL 에 없었으면 STUN_DEFAULT_PORT. */
  readonly port: number;
}

export type IceServers = readonly IceServer[];

const URL_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s;
const HOST_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/;
const HOST_NAME_MAX = 253;
const PORT = /^[0-9]{1,5}$/;

function reject(detail: string): Result<never, 'ICE_CONFIG_REJECTED'> {
  return err('ICE_CONFIG_REJECTED', detail);
}

function canonicalIpv6(inner: string): string | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(inner)) return null;
  try {
    return new URL(`http://[${inner}]/`).hostname;
  } catch {
    return null;
  }
}

interface HostPort {
  /** URL 에 적는 모양. IPv6 는 대괄호를 포함한다. */
  readonly hostText: string;
  /** 대괄호 없는 호스트. */
  readonly hostname: string;
  readonly port: number | null;
}

function parseHostPort(rest: string): HostPort | null {
  let hostText: string;
  let portText: string | null;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return null;
    const canonical = canonicalIpv6(rest.slice(1, close));
    if (canonical === null) return null;
    hostText = canonical;
    const after = rest.slice(close + 1);
    if (after === '') portText = null;
    else if (after.startsWith(':')) portText = after.slice(1);
    else return null;
  } else {
    const colon = rest.indexOf(':');
    const name = colon < 0 ? rest : rest.slice(0, colon);
    portText = colon < 0 ? null : rest.slice(colon + 1);
    if (name.length === 0 || name.length > HOST_NAME_MAX || !HOST_NAME.test(name)) return null;
    hostText = name.toLowerCase();
  }
  const hostname = hostText.startsWith('[') ? hostText.slice(1, -1) : hostText;
  if (portText === null) return { hostText, hostname, port: null };
  if (!PORT.test(portText)) return null;
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > 65535) return null;
  return { hostText, hostname, port };
}

/**
 * 쉼표로 구분한 ICE 서버 목록을 검증한다.
 * - 생략 또는 빈 값: 기본 STUN 서버 하나.
 * - `none`: 빈 목록(host 후보만).
 * - `stun:` 이 아닌 항목이 하나라도 있으면 목록 전체를 거절한다.
 *   일부만 걸러 쓰거나 기본값으로 바꾸면 사용자가 고른 설정이 조용히 달라진다.
 * - `stuns:` 도 거절한다. 고정한 WebRTC 라이브러리가 받지 않고, 평문 STUN 으로 바꿔 쓰면
 *   사용자가 고른 설정이 조용히 달라지기 때문이다.
 * 거절 사유에는 항목의 원문을 싣지 않는다(TURN URL 에 자격 증명이 들어 있을 수 있다).
 */
export function parseIceServers(
  input: string | undefined | null,
): Result<IceServers, 'ICE_CONFIG_REJECTED'> {
  const raw = (input ?? '').trim();
  if (raw.toLowerCase() === ICE_SERVERS_NONE) return ok([]);
  const entries = (raw === '' ? DEFAULT_ICE_SERVERS : raw).split(',');

  const servers: IceServer[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = (entries[i] ?? '').trim();
    const where = `entry ${i + 1}`;
    if (entry === '') return reject(`${where} is empty`);
    if (entry.toLowerCase() === ICE_SERVERS_NONE) {
      return reject(`${where}: "none" cannot be combined with other entries`);
    }
    const shape = URL_SHAPE.exec(entry);
    if (shape === null) return reject(`${where} is not a stun: URL`);
    const scheme = (shape[1] ?? '').toLowerCase();
    if (scheme === 'turn' || scheme === 'turns') {
      return reject(`${where} is a TURN server; relays are not allowed, only stun:`);
    }
    if (scheme === 'stuns') {
      return reject(`${where} is a stuns: URL; STUN over TLS is not supported by the WebRTC library of this build, use stun:`);
    }
    if (scheme !== 'stun') return reject(`${where} has a scheme other than stun:`);
    const target = parseHostPort(shape[2] ?? '');
    if (target === null) return reject(`${where} must be stun:<host> or stun:<host>:<port>`);
    const port = target.port ?? STUN_DEFAULT_PORT;
    // 포트를 생략한 것과 기본 포트를 적은 것은 같은 서버다.
    const identity = `${target.hostname} ${port}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const url = `stun:${target.hostText}${target.port === null ? '' : `:${target.port}`}`;
    servers.push({ url, hostname: target.hostname, port });
  }
  return ok(servers);
}

// 후보 문법은 공백으로 나눈 토큰이라 "typ" 과 "relay" 사이의 공백이 여러 칸이어도
// 라이브러리는 relay 로 읽는다. 그래서 공백 한 칸의 고정 문자열로 견주지 않는다.
const RELAY_MARK = /\styp\s+relay/i;

/**
 * candidate 문자열이나 SDP 에 TURN 중계 후보가 들어 있는지 본다.
 * 클라이언트 mesh 는 보내기 전과 넣기 전에, 서버는 signal 을 전달하기 전에 쓴다.
 */
export function isRelayCandidate(text: string): boolean {
  return RELAY_MARK.test(text);
}
