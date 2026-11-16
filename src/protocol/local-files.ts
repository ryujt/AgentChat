// 두 모듈이 함께 쓰는 로컬 파일의 스키마 (architecture.md 3.13).
// channel-check.json 은 mcp-server 가 쓰고 setup 이 읽는다. 형제 모듈끼리 타입을 주고받지 않게 여기에 둔다.
// 파일을 읽고 쓰는 일은 하지 않는다.

import { z } from 'zod';
import { err, ok, type Result } from './result.js';
import { describeIssues, isPlainObject, parseJson } from './util.js';

/** `<AGENT_CHAT_HOME>/channel-check.json` */
export const CHANNEL_CHECK_FILE_NAME = 'channel-check.json';
export const CHANNEL_CHECK_VERSION = 1;

const utcTimestamp = z.iso.datetime();

export const channelCheckSchema = z.object({
  v: z.literal(CHANNEL_CHECK_VERSION),
  /** MCP 초기화 때 호스트가 준 클라이언트 이름. */
  host: z.string(),
  /** MCP 초기화 때 호스트가 준 클라이언트 버전. */
  host_version: z.string(),
  /** confirm_channel 이 성공한 시각 (UTC ISO 8601). */
  confirmed_at: utcTimestamp,
  /** 그 뒤 poll 로 되돌아간 시각. 되돌아간 적이 없으면 null. */
  fallback_at: utcTimestamp.nullable(),
});

export type ChannelCheck = z.infer<typeof channelCheckSchema>;

/** 파일 내용(문자열) 또는 이미 파싱한 객체를 검증한다. 모르는 필드는 버린다. */
export function parseChannelCheck(input: unknown): Result<ChannelCheck, 'BAD_FILE'> {
  let value = input;
  if (typeof input === 'string') {
    const json = parseJson(input);
    if (!json.ok) return err('BAD_FILE', 'file is not valid JSON');
    value = json.value;
  }
  if (!isPlainObject(value)) return err('BAD_FILE', 'file is not a JSON object');
  const parsed = channelCheckSchema.safeParse(value);
  if (!parsed.success) return err('BAD_FILE', describeIssues(parsed.error));
  return ok(parsed.data);
}

/** 파일에 쓸 내용. 쓰기 전에 같은 스키마로 검증해 읽는 쪽이 거절할 내용을 남기지 않는다. */
export function serializeChannelCheck(value: ChannelCheck): Result<string, 'BAD_FILE'> {
  const parsed = channelCheckSchema.safeParse(value);
  if (!parsed.success) return err('BAD_FILE', describeIssues(parsed.error));
  return ok(`${JSON.stringify(parsed.data, null, 2)}\n`);
}

// ── 수신 상태 파일 (선택형 Stop hook) ───────────────────────────────────────
// `<AGENT_CHAT_HOME>/listen/<MCP pid>.json`. mcp-server 가 쓰고, Claude Code 의 Stop hook(setup 의 stop-hook)이 읽는다.
// hook 은 자기 조상 프로세스 가운데 ppid 가 가장 가까운 파일을 자기 세션의 것으로 본다(MCP 와 hook 은 같은 호스트 프로세스의 자식이다).

/** `<AGENT_CHAT_HOME>/listen` */
export const LISTEN_STATE_DIR_NAME = 'listen';
export const LISTEN_STATE_VERSION = 1;

export const listenStateSchema = z.object({
  v: z.literal(LISTEN_STATE_VERSION),
  /** 이 파일을 쓴 MCP 프로세스. */
  pid: z.number().int().min(1),
  /** 그 부모(호스트 프로세스). */
  ppid: z.number().int().min(0),
  updated_at: utcTimestamp,
  in_room: z.boolean(),
  delivery_mode: z.enum(['poll', 'channel']),
  /** 지금 inbox.listening(). */
  listening: z.boolean(),
  /** 에이전트가 set_status{listening: false} 로 듣지 않겠다고 알렸고 아직 다시 기다리지 않았다. */
  paused: z.boolean(),
  /** 이 방에서 write_report 가 성공했다. */
  report_written: z.boolean(),
  /** 이 방의 테스트가 중단됐다(notice.test_stopped). */
  test_stopped: z.boolean(),
  /** 이 방에 들어간 시각. 방에 없으면 null. */
  entered_at: utcTimestamp.nullable(),
});

export type ListenState = z.infer<typeof listenStateSchema>;

export function parseListenState(input: unknown): Result<ListenState, 'BAD_FILE'> {
  let value = input;
  if (typeof input === 'string') {
    const json = parseJson(input);
    if (!json.ok) return err('BAD_FILE', 'file is not valid JSON');
    value = json.value;
  }
  if (!isPlainObject(value)) return err('BAD_FILE', 'file is not a JSON object');
  const parsed = listenStateSchema.safeParse(value);
  if (!parsed.success) return err('BAD_FILE', describeIssues(parsed.error));
  return ok(parsed.data);
}

export function serializeListenState(value: ListenState): Result<string, 'BAD_FILE'> {
  const parsed = listenStateSchema.safeParse(value);
  if (!parsed.success) return err('BAD_FILE', describeIssues(parsed.error));
  return ok(`${JSON.stringify(parsed.data)}\n`);
}
