// 수신함이 내준 것을 채널 알림(notifications/claude/channel)으로 옮긴다 (mcp-interface.md 6.2).
// 호스트는 알림을 확인해 주지 않는다. 보냈다는 것은 전달의 증거가 아니다.

import type { ChannelItem, DeliveredEvent } from '../inbox/contract.js';

export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';
/** 초기화 응답의 experimental 에 싣는 채널 capability 의 이름. */
export const CHANNEL_CAPABILITY = 'claude/channel';

export const PROBE_CONTENT = 'Agent Chat channel check. Call the confirm_channel tool with this token.';

/**
 * 호스트는 `^[a-zA-Z_][a-zA-Z0-9_]*$` 에 맞지 않는 meta 키를 조용히 버린다. 그래서 쓰는 키를 여기 고정한다.
 * ref 는 그 사건이 가리키는 기록이다(claim 은 시나리오, verification 은 주장).
 */
export type ChannelMetaKey = 'kind' | 'change' | 'msg_id' | 'from' | 'to' | 'ts' | 'cursor' | 'ref' | 'token';

export type ChannelMeta = { readonly [K in ChannelMetaKey]?: string };

/** 알림의 params. SDK 의 알림 타입(색인 서명)에 그대로 들어가도록 interface 가 아니라 type 으로 둔다. */
export type ChannelNotificationParams = {
  readonly content: string;
  readonly meta: ChannelMeta;
};

const TAG_OPEN = /<(\/?)(?=channel)/gi;
const META_UNSAFE = /[^A-Za-z0-9_.:+\-]/g;
const META_VALUE_MAX = 128;

/** 본문 안의 `<channel`, `</channel` 이 태그로 읽히지 않게 `<` 뒤에 `\` 를 넣는다. */
export function neutralizeChannelTags(text: string): string {
  return text.replace(TAG_OPEN, '<\\$1');
}

/** meta 값은 태그의 속성으로 들어간다. 식별자와 시각에 쓰는 글자만 남긴다. */
function metaValue(value: string): string {
  return value.replace(META_UNSAFE, '_').slice(0, META_VALUE_MAX);
}

function referenceOf(event: DeliveredEvent): string | null {
  if (event.kind === 'claim') return event.data.scenario_id;
  if (event.kind === 'verification') return event.data.claim_id;
  return null;
}

function eventContent(event: DeliveredEvent): string {
  // chat 은 본문 그대로. 상태 사건은 한 줄 요약 뒤에 data 의 JSON 한 줄.
  if (event.kind === 'chat') return neutralizeChannelTags(event.text);
  const summary = event.text.replace(/[\r\n]+/g, ' ');
  return neutralizeChannelTags(`${summary}\n${JSON.stringify(event.data)}`);
}

export function toChannelNotification(item: ChannelItem): ChannelNotificationParams {
  if (item.type === 'probe') {
    return { content: PROBE_CONTENT, meta: { kind: 'probe', token: metaValue(item.token) } };
  }
  const event = item.event;
  const meta: { -readonly [K in ChannelMetaKey]?: string } = { kind: event.kind };
  if (event.change !== null) meta.change = metaValue(event.change);
  if (event.id !== null) meta.msg_id = metaValue(event.id);
  meta.from = metaValue(event.from);
  meta.to = event.to;
  meta.ts = metaValue(event.ts);
  meta.cursor = metaValue(event.cursor);
  const reference = referenceOf(event);
  if (reference !== null) meta.ref = metaValue(reference);
  return { content: eventContent(event), meta };
}
