// 출력기의 허용 필드 필터와 줄 만들기 (architecture.md 6.2).
// 호출 지점이 허용 필드만 넘기는 것이 첫 겹이고, 이 파일이 둘째 겹이다.
// 채팅 본문·SDP·candidate 같은 값이 잘못 넘어와도 줄에 실리지 않게 한다.

import type { LogFieldName, LogLevel, LogModule, LogService } from './log-port.js';

/** 빠진 이름이 있으면 컴파일이 실패한다. log-port.ts 에 필드를 더하면 여기에도 더한다. */
const ALLOWED_FIELDS: Record<LogFieldName, true> = {
  outcome: true,
  error_code: true,
  duration_ms: true,
  attempt: true,
  room_ref: true,
  conn_ref: true,
  ip_ref: true,
  sid: true,
  cid: true,
  msg_id: true,
  test_id: true,
  peer: true,
  peer_ref: true,
  stage: true,
  reason: true,
  pc_state: true,
  ice_state: true,
  cand_local_host: true,
  cand_local_srflx: true,
  cand_remote_host: true,
  cand_remote_srflx: true,
  kind: true,
  cause: true,
  resends: true,
  queued_applied: true,
  dup_ignored: true,
  frame_len: true,
  state: true,
  backoff_ms: true,
  misses: true,
  seq: true,
  last_alive_age_ms: true,
  open_ms: true,
  targets: true,
  delivered: true,
  undelivered: true,
  bytes: true,
  dup: true,
  via: true,
  more: true,
  from: true,
  to: true,
  unseen: true,
  tool: true,
  by: true,
  sent_to: true,
  not_connected: true,
  applied: true,
  ignored: true,
  anomalies: true,
  snapshot: true,
  gap_ms: true,
  records: true,
  forced: true,
  links: true,
  name: true,
  mode: true,
  takeover: true,
  seq_stale: true,
  members: true,
  connections: true,
  rooms: true,
  rejected: true,
  loop_lag_ms: true,
  rss_mb: true,
  step: true,
  host: true,
  events: true,
  events_dropped: true,
  read: true,
  not_listening: true,
};

const KNOWN_MODULES: Record<LogModule, true> = {
  protocol: true,
  diagnostics: true,
  'signaling-core': true,
  'signaling-selfhost': true,
  'signaling-aws': true,
  'signaling-client': true,
  mesh: true,
  'shared-state': true,
  inbox: true,
  records: true,
  'room-session': true,
  'mcp-server': true,
  setup: true,
  monitor: true,
  entry: true,
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 줄마다 붙는 proc 의 길이(architecture.md 6.2). */
export const PROC_LENGTH = 6;

/** 값은 짧은 식별자다. 길게 넘어온 글(본문이 섞였을 수 있다)은 잘라 줄 크기와 노출을 묶는다. */
export const MAX_STRING_CHARS = 256;
export const MAX_EVENT_CHARS = 64;
export const MAX_LIST_ITEMS = 64;

// C0·DEL·C1 제어 문자(Cc)와 줄·문단 구분 문자(Zl, Zp). 한 사건이 한 줄을 벗어나지 않게 한다.
const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LEVEL_ORDER, value);
}

/** level 이 threshold 이상인가. 모르는 수준은 쓰지 않는다. */
export function passesLevel(level: unknown, threshold: LogLevel): boolean {
  if (!isLogLevel(level)) return false;
  return LEVEL_ORDER[level] >= (LEVEL_ORDER[threshold] ?? LEVEL_ORDER.info);
}

export function isAllowedField(name: string): name is LogFieldName {
  return Object.hasOwn(ALLOWED_FIELDS, name);
}

function cleanText(text: string, maxChars: number): string {
  const cut = text.length > maxChars ? text.slice(0, maxChars) : text;
  return cut.replace(CONTROL_CHARS, ' ');
}

type Scalar = string | number | boolean | null;

/** 오류 객체는 이름과 코드만 남긴다. message 와 stack 에는 피어 입력이 섞일 수 있다. */
function errorLabel(error: Error): string {
  const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error';
  const code = (error as { code?: unknown }).code;
  const withCode = typeof code === 'string' || typeof code === 'number' ? `${name}:${String(code)}` : name;
  return cleanText(withCode, MAX_EVENT_CHARS);
}

function cleanScalar(value: unknown): Scalar | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return cleanText(value, MAX_STRING_CHARS);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (value instanceof Error) return errorLabel(value);
  return undefined;
}

/** 허용 목록의 키와 스칼라(또는 스칼라 목록)만 남긴다. 객체·함수·기호는 키째 버린다. */
export function filterFields(fields: unknown, service: LogService): Record<string, Scalar | Scalar[]> {
  const out: Record<string, Scalar | Scalar[]> = {};
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return out;
  const dropPeer = service === 'server' || service === 'lambda';
  for (const key of Object.keys(fields)) {
    if (!isAllowedField(key)) continue;
    // 서버 로그는 운영자가 본다. 참가자 이름 원문은 싣지 않는다.
    if (dropPeer && key === 'peer') continue;
    const value: unknown = (fields as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      const items: Scalar[] = [];
      for (const item of value.slice(0, MAX_LIST_ITEMS)) {
        const cleaned = cleanScalar(item);
        if (cleaned !== undefined) items.push(cleaned);
      }
      out[key] = items;
      continue;
    }
    const cleaned = cleanScalar(value);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export interface LineInput {
  readonly service: LogService;
  readonly proc: string;
  readonly tsMs: number;
  readonly level: LogLevel;
  readonly module: unknown;
  readonly event: unknown;
  readonly fields: unknown;
  /** 이 줄 앞에서 버린 줄 수. 0 이면 싣지 않는다. */
  readonly dropped?: number;
  /** 로거가 스스로 남기는 사건(log.cleanup)의 수치. 호출 지점의 필드가 아니라 허용 목록을 거치지 않는다. */
  readonly own?: Readonly<Record<string, number>>;
}

/**
 * JSON 한 줄(개행 없음). 만들 수 없으면 null 이다. 던지지 않는다.
 * 로거가 붙이는 칸(ts, level, svc, proc, mod, event)은 호출 지점의 필드보다 앞에 두고 덮어쓰이지 않는다.
 */
export function buildLine(input: LineInput): string | null {
  try {
    if (!Number.isFinite(input.tsMs)) return null;
    const mod = typeof input.module === 'string' && Object.hasOwn(KNOWN_MODULES, input.module) ? input.module : 'unknown';
    const event = typeof input.event === 'string' && input.event !== '' ? cleanText(input.event, MAX_EVENT_CHARS) : 'unknown';
    const line: Record<string, unknown> = {
      ts: new Date(input.tsMs).toISOString(),
      level: input.level,
      svc: input.service,
      proc: input.proc,
      mod,
      event,
      ...filterFields(input.fields, input.service),
    };
    if (input.own !== undefined) {
      for (const [key, value] of Object.entries(input.own)) if (Number.isFinite(value)) line[key] = value;
    }
    if (input.dropped !== undefined && input.dropped > 0) line['dropped'] = input.dropped;
    return JSON.stringify(line);
  } catch {
    // 값을 읽다 던지는 입력(getter, Proxy)이나 범위를 벗어난 시각이다. 줄 하나를 버리고 호출자는 계속 간다.
    return null;
  }
}
