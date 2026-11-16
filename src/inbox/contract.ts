// inbox 의 공개 계약 (architecture.md 3.8). 사건 형식은 mcp-interface.md 6절, 전달 모드는 7절이 정한다.
// 에이전트에게 전할 사건을 순서대로 보관하고, 한 번에 한 경로(poll 또는 channel)로만 내준다.
// 사건의 내용은 만들지 않는다(누락 알림만 스스로 넣는다). 이 파일에는 타입만 있다.
// 사건의 필드 이름은 tool 결과에 그대로 실리는 이름이다.

import type { LogPort } from '../diagnostics/log-port.js';
import type {
  ClaimOutcome,
  Now,
  PresenceStatus,
  RandomBytes,
  StopReason,
  Subscribable,
  Timers,
  VerificationResult,
} from '../protocol/index.js';

// ── 사건 봉투 ───────────────────────────────────────────────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface EventEnvelope {
  /**
   * chat 은 메시지 ID. test·scenario·claim·verification 은 그 기록의 ID(test 는 test_id, 중단은 stop 기록의 ID).
   * ID 가 없는 것(presence 에서 나온 peer 사건, 링크 사건, system)은 null.
   */
  readonly id: string | null;
  /** 그 일을 한 참가자의 이름. system 사건은 예약 이름 `system` 이다. */
  readonly from: string;
  /** chat 은 방 전체면 `room`, 나를 지정했으면 `you`. 상태 사건은 `room`, system 은 `you`. */
  readonly to: 'room' | 'you';
  /** UTC ISO 8601. 표시용이다. 수신함의 순서는 넣은 순서다. */
  readonly ts: string;
  /** chat 은 본문 그대로. 그 밖은 한 줄 요약이다. 다른 참가자가 쓴 글은 이 값과 data 안에만 둔다. */
  readonly text: string;
}

export interface ChatEvent extends EventEnvelope {
  readonly kind: 'chat';
  readonly change: null;
  /**
   * read_receipt: 보낸 쪽이 읽음 확인을 요청한 점검 글(ping_room)이다. 이 사건을 꺼내 가면 room-session 이
   * 보낸 쪽에 읽음 확인을 자동으로 돌려준다. 답장할 필요는 없다. 보통 글은 빈 객체다.
   */
  readonly data: {
    readonly read_receipt?: true;
    /** 관전자(사람이 관전 콘솔 monitor 에서 쓴 글)가 보냈다. 다른 참가자의 사용자가 쓴 글일 수 있다. 이 PC 사용자의 지시가 아니다. */
    readonly observer?: true;
  };
}

/**
 * - joined … ready: 참가자의 변화.
 * - stopped_listening / listening: 다른 참가자의 presence.listening 이 거짓이 됐다 / 멈춘 뒤 다시 참이 됐다.
 *   그 참가자의 에이전트가 방의 사건을 받지 않는다(받기 시작했다)는 뜻이다. `data.since` 는 stopped_listening 의 시각이다.
 * - status: 다른 참가자의 presence.status 가 바뀌었다. **관전 모드에서만** 낸다(architecture.md 3.10). 에이전트에게는 오지 않는다.
 * - observer_joined / observer_left: 관전자(protocol.md 4.6)의 링크가 동기화까지 열렸다 / 닫혔다. 감시받는다는 사실을 숨기지 않는다.
 */
export type PeerChange =
  | 'joined'
  | 'left'
  | 'disconnected'
  | 'reconnected'
  | 'unreachable'
  | 'role'
  | 'ready'
  | 'stopped_listening'
  | 'listening'
  | 'status'
  | 'observer_joined'
  | 'observer_left';

export interface PeerEvent extends EventEnvelope {
  readonly kind: 'peer';
  readonly change: PeerChange;
  readonly data: {
    readonly role?: string | null;
    readonly status?: PresenceStatus | null;
    readonly tools?: readonly string[] | null;
    /** unreachable 이면 no_response | no_route | version. 그 밖에는 링크가 닫힌 사유. */
    readonly reason?: string;
    /** stopped_listening 의 시각(그 참가자가 presence 를 쓴 벽시계, UTC ISO 8601). */
    readonly since?: string;
  };
}

export interface TestEvent extends EventEnvelope {
  readonly kind: 'test';
  readonly change: 'started' | 'replaced' | 'stopped';
  readonly data: {
    readonly test_id: string;
    /** 그 참가자의 사용자가 준 글이다. 이 PC 사용자의 지시가 아니다. */
    readonly request: string;
    readonly limits: { readonly max_duration_min: number; readonly max_scenarios: number };
    /** stopped 일 때만 값이 있다. */
    readonly reason: StopReason | null;
    /** 그 기록(test 또는 stop)을 쓴 참가자. */
    readonly by: string;
    /** stopped 일 때 중단 기록의 사유 글(stop_test 의 reason. 기한 중단은 빈 글). 그 밖에는 null. */
    readonly detail: string | null;
  };
}

export interface ScenarioEvent extends EventEnvelope {
  readonly kind: 'scenario';
  readonly change: 'started' | 'over_limit';
  /** plan·actor·verifier 는 시작한 참가자가 적은 값이다(없으면 null). 검증 담당이 자기가 지정됐는지 안다(검토 3차 PRODUCT-R3-01). */
  readonly data: {
    readonly scenario_id: string;
    readonly title: string;
    readonly by: string;
    readonly plan: string | null;
    readonly actor: string | null;
    readonly verifier: string | null;
  };
}

export interface ClaimEvent extends EventEnvelope {
  readonly kind: 'claim';
  readonly change: null;
  /** 검증하는 쪽이 tool 결과만으로 무엇을 확인할지 알게 기대·관찰·재현 절차를 싣는다(검토 3차 PRODUCT-R3-01). */
  readonly data: {
    readonly claim_id: string;
    readonly scenario_id: string;
    readonly by: string;
    readonly action: string;
    readonly expected: string | null;
    readonly observed: string;
    readonly steps: string;
    readonly outcome: ClaimOutcome;
    readonly late: boolean;
  };
}

export interface VerificationEvent extends EventEnvelope {
  readonly kind: 'verification';
  readonly change: null;
  readonly data: {
    readonly claim_id: string;
    readonly result: VerificationResult;
    readonly by: string;
    readonly claim_status: 'confirmed' | 'refuted' | 'unverified';
  };
}

/**
 * - inbox_dropped: 전달하지 못한 사건을 버렸다. `data.count`. inbox 가 스스로 넣는 유일한 사건이다.
 * - signaling_blocked: 재접속이 NAME_IN_USE·ROOM_FULL 로 막혔다. 계속 시도 중이다. `data.reason`.
 * - signaling_detached: 재접속을 멈췄다.
 * - name_conflict: 같은 이름의 다른 세션이 서버에 등록됐다.
 * - state_diverged: 한 참가자와 스냅샷을 주고받아도 복제본이 맞춰지지 않는다. `data.peer`.
 * - record_failed: 로컬 기록 쓰기에 실패했다.
 * - clock_skew: 한 참가자와 시계 차이가 크다. `data.peer`.
 * - observer_unaware: 관전자를 모르는 구버전 참가자다(hello.observer 가 없다). 그쪽에는 관전 사실이 표시되지 않는다. `data.peer`.
 *   **관전 모드에서만** 낸다. 에이전트에게는 오지 않는다.
 *
 * 전달 모드의 변화는 사건으로 넣지 않는다. 그 변화는 언제나 이 에이전트의 tool 호출 안에서 일어나고,
 * 그 호출의 결과(confirm_channel 의 delivery_mode, notice.delivery)가 알린다. 사건으로도 넣으면 channel 로 바뀐 직후
 * "확인 안 된" 사건이 하나 생겨, 방이 조용해도 확인 호출이 없으면 수신 불명이 된다.
 */
export type SystemEventCode =
  | 'inbox_dropped'
  | 'signaling_blocked'
  | 'signaling_detached'
  | 'name_conflict'
  | 'state_diverged'
  | 'record_failed'
  | 'clock_skew'
  | 'observer_unaware';

export interface SystemEvent extends EventEnvelope {
  readonly kind: 'system';
  readonly change: null;
  readonly data: { readonly code: SystemEventCode; readonly [key: string]: JsonValue };
}

/** 수신함에 넣는 사건 하나. poll 과 channel 에서 같은 내용으로 나간다. */
export type InboxEvent =
  | ChatEvent
  | PeerEvent
  | TestEvent
  | ScenarioEvent
  | ClaimEvent
  | VerificationEvent
  | SystemEvent;

export type InboxEventKind = InboxEvent['kind'];

/**
 * 내준 사건. cursor 는 이 프로세스의 수신함 순번(10진수 문자열, 1부터)이다. 다른 참가자와 공유되지 않는다.
 * received_at 은 이 PC 의 수신함에 들어온 시각(이 PC 시계, UTC ISO 8601)이다. `received_at - ts` 는 전송 지연,
 * `읽은 시각 - received_at` 은 읽기 지연이다. ts 는 보낸 쪽 시계라 시계 차이(clock_skew)가 있으면 앞의 값은 믿을 수 없다.
 */
export type DeliveredEvent = InboxEvent & { readonly cursor: string; readonly received_at: string };

// ── 전달 모드와 상한 ────────────────────────────────────────────────────────

/** 프로세스가 뜨면 항상 poll 이다. 저장하지 않는다. */
export type DeliveryMode = 'poll' | 'channel';

export interface InboxLimits {
  /** 대기열의 최대 건수. 넘치면 이미 전달한 것부터 버린다. */
  readonly INBOX_MAX_EVENTS: number;
  /** wait 과 confirm 한 번이 주는 최대 건수. */
  readonly WAIT_MAX_EVENTS: number;
  /**
   * wait 과 confirm 한 번이 주는 최대 바이트. 사건 하나가 더 크면 그것 하나만 준다.
   * 내준 사건(cursor 포함)을 JSON.stringify 한 UTF-8 길이의 합으로 잰다.
   */
  readonly WAIT_MAX_RESULT_BYTES: number;
  /** poll: 마지막 대기가 끝난 뒤 이 시간 동안 수신 중으로 본다. */
  readonly LISTEN_GRACE_MS: number;
  /** channel: 채널로 보낸 사건의 확인을 이 시간까지 기다린다. */
  readonly CHANNEL_SEEN_GRACE_MS: number;
}

/** 제품 기본값(architecture.md 5절). `inbox/index.ts` 가 이 타입의 상수 `DEFAULT_INBOX_LIMITS` 를 내보낸다. */
export interface DefaultInboxLimits extends InboxLimits {
  readonly INBOX_MAX_EVENTS: 1000;
  readonly WAIT_MAX_EVENTS: 20;
  readonly WAIT_MAX_RESULT_BYTES: 24000;
  readonly LISTEN_GRACE_MS: 120000;
  readonly CHANNEL_SEEN_GRACE_MS: 120000;
}

export interface InboxDeps {
  readonly limits: InboxLimits;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
  /** 점검 토큰(무작위 16자)을 만들 때 쓴다. 생략하면 node:crypto. */
  readonly randomBytes?: RandomBytes;
  /**
   * cursor 순번의 시작값. 첫 사건의 cursor 는 이 값 + 1 이다. 생략하거나 쓸 수 없는 값(음수, 수가 아님, 1e14 초과)이면 0 이다.
   * 제품 조립(entry/mcp)은 프로세스 시작 시각(ms)을 준다. MCP 프로세스가 다시 떠도(호스트의 재연결, crash 뒤 재시작)
   * 새 사건의 cursor 가 앞 프로세스의 cursor 와 겹치지 않게 하려는 것이다. 에이전트는 cursor 로 중복을 거른다(검토 2차 PRODUCT-R2-01).
   */
  readonly cursorBase?: number;
}

// ── wait, confirm ───────────────────────────────────────────────────────────

export interface WaitOptions {
  /**
   * 이전 결과의 next_cursor. 주면 그 뒤의 사건을 준다(이미 준 것도 다시 준다). 생략하면 마지막으로 준 곳 뒤부터다.
   * 아직 준 적 없는 곳을 가리키면 마지막으로 준 곳으로 본다. 이미 버린 구간이면 남은 가장 오래된 사건부터 준다.
   */
  readonly cursor?: string;
  /** 사건이 없을 때 기다리는 시간. channel 모드에서는 쓰지 않는다. */
  readonly timeoutMs: number;
  /** 호스트의 취소나 프로세스 종료. 취소되면 커서를 옮기지 않는다. */
  readonly signal?: AbortSignal;
}

export interface WaitResult {
  /**
   * - events: 사건이 있다.
   * - timeout: 기한까지 없었다. 뒤에 온 wait 에 밀려 끝난 경우도 이것이다(빈 결과).
   * - channel_mode: channel 모드이고 다시 줄 사건이 없다. 대기 중에 모드가 channel 로 바뀐 경우도 이것이다.
   * - cancelled: signal 이 취소됐거나 close() 됐다. 커서는 그대로다.
   */
  readonly status: 'events' | 'timeout' | 'channel_mode' | 'cancelled';
  readonly events: readonly DeliveredEvent[];
  /** 다음 호출에 넘길 값. 사건이 없으면 받은(또는 현재) 커서 그대로다. */
  readonly next_cursor: string;
  /** 상한 때문에 남은 사건이 있다. */
  readonly more: boolean;
}

export type ConfirmResult =
  /** channel 모드가 됐다. events 는 그때까지 전달하지 않은 사건(상한까지)이다. 나머지와 이후 사건은 채널로 간다. */
  | { readonly ok: true; readonly events: readonly DeliveredEvent[]; readonly next_cursor: string }
  /** 모르는 토큰. 모드는 그대로다. */
  | { readonly ok: false; readonly code: 'INVALID_ARGUMENT' };

// ── 채널 ────────────────────────────────────────────────────────────────────

/** 채널로 내보낼 것 하나. 알림의 content·meta 로 옮기는 일은 받는 쪽(mcp-server)이 한다. */
export type ChannelItem =
  | { readonly type: 'probe'; readonly token: string }
  | { readonly type: 'event'; readonly event: DeliveredEvent };

/**
 * 채널 알림을 보내는 함수. inbox 는 한 번에 하나씩, 앞의 것이 끝난 뒤에 다음 것을 넘긴다.
 * reject 해도 inbox 는 멈추지 않는다. 호스트는 받았다고 알려 주지 않으므로 성공도 전달의 증거가 아니다.
 */
export type ChannelSender = (item: ChannelItem) => Promise<void>;

/** noteToolCall 에 알리는 tool 호출 하나. */
export interface ToolCallInfo {
  /** tool 이름. 예: `wait_for_messages`. */
  readonly name: string;
  /** wait_for_messages 의 cursor 인자. 주지 않았거나 다른 tool 이면 생략한다. */
  readonly cursor?: string | undefined;
}

/**
 * 아직 한 번도 내주지 않은 사건(poll 모드). 에이전트가 듣지 않던 사이에 밀린 양이다.
 * - oldest_ts: 그중 가장 오래된 사건의 ts(보낸 쪽 시각).
 * - oldest_age_sec: 그 사건이 이 PC 수신함에 들어온 뒤 지난 초(이 PC 시계. 시계 차이와 무관하다).
 */
export interface UnreadNotice {
  readonly count: number;
  readonly oldest_ts: string;
  readonly oldest_age_sec: number;
}

/** tool 결과의 notice 에 그대로 붙이는 조각. */
export interface InboxNotice {
  /** poll 모드에서 wait_for_messages·confirm_channel 이 아닌 호출에, 내주지 않은 사건이 있으면 붙는다. */
  readonly unread?: UnreadNotice;
  /** channel 모드에서 앞선 tool 호출 뒤 채널로 보낸 사건 수와, 그 사건들 바로 앞의 커서. */
  readonly pushed_since_last_call?: { readonly count: number; readonly after_cursor: string };
  /** 이번 호출로 channel 에서 poll 로 되돌아갔다. after_cursor 부터 다시 받는다. */
  readonly delivery?: {
    readonly mode: 'poll';
    readonly reason: 'channel_unconfirmed';
    readonly after_cursor: string;
  };
}

export interface ModeChanged {
  readonly from: DeliveryMode;
  readonly to: DeliveryMode;
  /** confirmed: 맞는 토큰이 돌아왔다. channel_unconfirmed: 확인이 끊겨 되돌아갔다. */
  readonly cause: 'confirmed' | 'channel_unconfirmed';
}

export interface InboxEvents {
  /** listening() 의 값이 바뀌었다. */
  'listening-changed': (listening: boolean) => void;
  'mode-changed': (change: ModeChanged) => void;
  /**
   * 사건을 처음으로 에이전트에게 내줬다(wait·confirm 의 결과, 채널). 다시 준 것은 싣지 않는다.
   * room-session 이 읽음 확인(read_receipt 가 있는 chat)을 돌려줄 때 쓴다.
   */
  handed: (events: readonly DeliveredEvent[]) => void;
}

export interface InboxStats {
  /** 대기열에 있는 사건 수. */
  readonly queued: number;
  /** 아직 한 번도 내주지 않은 사건 수. */
  readonly undelivered: number;
  /** 전달하지 못하고 버린 사건의 누계. */
  readonly dropped: number;
  /** channel 모드에서 채널로 보냈지만 확인되지 않은 사건 수. */
  readonly unconfirmed: number;
}

// ── inbox ───────────────────────────────────────────────────────────────────

/**
 * 프로세스에 하나다. 방은 입장마다 새로 생기지만 수신함은 이어 쓴다. 사건에는 방을 가리키는 칸이 없다.
 * 그래서 방을 나갈 때 room-session 이 discardAll() 로 비운다. 한 방의 사건이 다른 방의 사건으로 나가지 않는다.
 *
 * 부르는 쪽이 나뉜다.
 * - room-session: push, discardAll, mode, listening, 이벤트.
 * - mcp-server: wait, startProbe, confirm, setChannelSender, noteToolCall, mode, stats, 이벤트, close.
 *
 * 사건은 자동으로는 한 경로로 한 번만 나간다. 확인 전에는 사건을 채널로 보내지 않는다(점검 알림만 간다).
 */
export interface Inbox extends Subscribable<InboxEvents> {
  /** 사건을 대기열 끝에 넣는다. 던지지 않는다. */
  push(event: InboxEvent): void;

  /**
   * 대기열을 비운다. 방을 나갈 때(퇴장, 입장 실패, 입장 취소) room-session 이 부른다. 던지지 않는다.
   * - 이미 내준 사건과 아직 내주지 않은 사건을 모두 버린다. 다시 받을 수 없다(본문은 기록 파일에 있다).
   * - 돌려주는 값은 그 가운데 어느 경로로도(wait·confirm 의 결과, 채널) 한 번도 내주지 않은 사건의 수다.
   * - 넘쳐서 버린 것이 아니다. inbox_dropped 사건을 넣지 않고 stats().dropped 에 더하지 않는다.
   * - 순번은 이어 간다. 1 로 돌아가지 않는다. 비우기 전의 cursor 로 온 wait 은 그 뒤에 넣은 사건을 처음부터 받는다.
   * - channel 모드의 "확인 안 된" 사건과 pushed_since_last_call 의 집계도 함께 없어진다.
   * - 전달 모드와 점검 토큰은 그대로다. 대기 중인 wait 은 끝내지 않는다.
   * - 버린 것이 있으면 로그 `inbox.discarded` 에 내주지 않은 수(`unseen`)를 남긴다.
   */
  discardAll(): number;

  /**
   * 새 사건을 기다린다. reject 하지 않는다. 동시에 대기 중인 wait 은 하나다. 두 번째가 오면 첫 번째를 빈 timeout 으로 끝낸다.
   * channel 모드에서는 기다리지 않는다. cursor 까지를 확인된 것으로 치고, 그 뒤에 채널로 보낸 사건이 있으면 바로 다시 준다.
   * 수신 불명 상태에서 cursor 없이 불린 경우는 이 함수에 오기 전에 noteToolCall 이 poll 로 되돌린다.
   * 그래서 여기서는 poll 로 동작해 확인 안 된 사건부터 준다(channel_mode 를 돌려주지 않는다).
   */
  wait(options: WaitOptions): Promise<WaitResult>;

  /**
   * 채널 점검을 시작한다. 토큰이 없으면 만들고 점검 알림을 채널 전송 함수로 보낸다.
   * create_room·join_room 이 성공한 직후에 mcp-server 가 부른다. 전송 함수가 없거나 이미 channel 모드면 아무 것도 하지 않는다.
   */
  startProbe(): void;

  confirm(token: string): ConfirmResult;

  /** 채널 capability 를 선언했을 때만 준다. null 이면 채널로 아무 것도 보내지 않는다. */
  setChannelSender(sender: ChannelSender | null): void;

  /**
   * 모든 tool 호출을 처리 전에 알린다(wait_for_messages, confirm_channel 포함).
   * 수신 불명 상태에서는 여기서 poll 로 되돌아간다. 예외는 cursor 를 준 wait_for_messages 하나다(확인으로 친다).
   * cursor 없는 wait_for_messages 와 confirm_channel 도 되돌아가는 호출이다(mcp-interface.md 7.1).
   * 되돌아갈 때 새 점검 토큰을 만들어 보내고 앞 토큰은 버린다. 그래서 같은 호출의 confirm 은
   * 앞 토큰이면 INVALID_ARGUMENT 다. 돌려준 조각을 그 tool 결과의 notice 에 붙인다.
   */
  noteToolCall(call: ToolCallInfo): InboxNotice;

  mode(): DeliveryMode;

  /** 이 참가자의 에이전트가 방의 사건을 받고 있다고 볼 근거가 있는가(mcp-interface.md 7.1). */
  listening(): boolean;

  /**
   * 에이전트가 지금부터 듣지 않는다고 알렸다(set_status{listening: false}). 유예를 기다리지 않고 listening() 을 거짓으로 한다.
   * 다음 wait 이 시작되면 풀린다. 방을 나가도(discardAll) 풀린다.
   */
  pauseListening(): void;

  /** pauseListening 뒤 아직 wait 이 오지 않았다. */
  paused(): boolean;

  stats(): InboxStats;

  /** 타이머를 지우고 대기 중인 wait 을 cancelled 로 끝낸다. 여러 번 불러도 된다. 이후 이벤트를 내지 않는다. */
  close(): void;
}

/** `inbox/index.ts` 가 `createInbox` 라는 이름으로 내보낸다. */
export type CreateInbox = (deps: InboxDeps) => Inbox;
