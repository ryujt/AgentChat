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
