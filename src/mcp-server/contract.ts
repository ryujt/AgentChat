// mcp-server 의 공개 계약 (architecture.md 3.11). 에이전트가 보는 면은 mcp-interface.md 가 정한다.
// 설정 타입과, 방 동작의 결과를 tool 결과로 옮기는 표만 둔다. 방 로직을 갖지 않는다.
// 아래 모듈은 이 파일의 타입을 쓰지 않는다. 이 파일에는 타입만 있다.

import type { LogLevel, LogPort } from '../diagnostics/log-port.js';
import type { DeliveredEvent, DeliveryMode, Inbox, InboxNotice } from '../inbox/contract.js';
import type { Now, RandomBytes, Timers } from '../protocol/index.js';
import type {
  AppInfo,
  ChatSent,
  CommandOutputs,
  CreateRoomArgs,
  JoinRoomArgs,
  PingSent,
  ReportWritten,
  RoomEntered,
  RoomLeft,
  RoomSession,
  RoomSessionConfig,
  SendChatArgs,
  SessionCommand,
  SessionErrorCode,
  SessionNotice,
  SessionStatus,
  SessionWarning,
} from '../room-session/contract.js';

// ── 설정 ────────────────────────────────────────────────────────────────────

/** MCP 프로세스가 읽는 환경 변수(architecture.md 5절). 설치기만 읽는 것은 여기에 없다. */
export type ConfigEnvName =
  | 'AGENT_CHAT_SERVER'
  | 'AGENT_CHAT_NAME'
  | 'AGENT_CHAT_CLIENT'
  | 'AGENT_CHAT_ICE_SERVERS'
  | 'AGENT_CHAT_CHANNEL'
  | 'AGENT_CHAT_WAIT_MAX_SEC'
  | 'AGENT_CHAT_HOME'
  | 'AGENT_CHAT_LOG_LEVEL';

/** off 면 채널 capability 를 선언하지 않고 confirm_channel 도 등록하지 않는다. */
export type ChannelSetting = 'auto' | 'off';

export interface McpConfig {
  /** room-session 에 그대로 넘긴다. */
  readonly session: RoomSessionConfig;
  readonly channel: ChannelSetting;
  /** wait_for_messages 한 번의 최대 대기(초). 5~540. */
  readonly waitMaxSec: number;
  /** 조립이 로거를 만들 때 넘긴다(diagnostics 의 FileLoggerOptions.level). */
  readonly logLevel: LogLevel;
}

/**
 * 받아들이지 못한 환경 변수 하나. 값 원문은 싣지 않는다.
 * - default_used: 기본값으로 동작 중이다(NAME, CLIENT, CHANNEL, WAIT_MAX_SEC, LOG_LEVEL).
 *   notice.config 와 get_status.warnings 로 알린다.
 * - rejected_on_use: 기본값으로 바꾸지 않았다(ICE_SERVERS, SERVER). 쓰는 tool 이 오류를 돌려준다.
 * 둘 다 진단 로그 config.problem 에 남긴다.
 * AGENT_CHAT_HOME 은 여기서 검사하지 않는다. 쓸 수 없는 경로면 기록 쓰기가 실패해 notice.record_failed 로 드러난다.
 */
export interface ConfigProblem {
  readonly name: ConfigEnvName;
  /** 짧은 사유. 예: `not an integer`, `out of range 5-540`. */
  readonly reason: string;
  readonly effect: 'default_used' | 'rejected_on_use';
}

export interface LoadConfigResult {
  readonly config: McpConfig;
  readonly problems: readonly ConfigProblem[];
}

export interface LoadConfigOptions {
  /** 기본 이름 `agent-<무작위 6자>` 를 만들 때 쓴다. 생략하면 node:crypto. */
  readonly randomBytes?: RandomBytes;
  /** AGENT_CHAT_HOME 이 없을 때 `~` 로 쓸 디렉터리. 생략하면 OS 의 홈. */
  readonly homeDir?: string;
}

/**
 * `mcp-server/index.ts` 가 `loadConfig` 라는 이름으로 내보낸다. 환경 변수를 해석하는 곳은 이 함수 하나다.
 * 실패하지 않는다. 잘못된 값이 있어도 프로세스는 떠야 한다.
 */
export type LoadConfig = (
  env: Readonly<Record<string, string | undefined>>,
  options?: LoadConfigOptions,
) => LoadConfigResult;

// ── 서버 ────────────────────────────────────────────────────────────────────

export interface McpServerLimits {
  /** 종료를 시작한 뒤 이 시간이 지나면 남은 정리를 기다리지 않는다. */
  readonly SHUTDOWN_BUDGET_MS: number;
}

/** 제품 기본값(architecture.md 5절). `mcp-server/index.ts` 가 이 타입의 상수 `DEFAULT_MCP_SERVER_LIMITS` 를 내보낸다. */
export interface DefaultMcpServerLimits extends McpServerLimits {
  readonly SHUTDOWN_BUDGET_MS: 400;
}

/**
 * 이 PC 에서 사람이 방을 콘솔로 지켜보는 진입점(architecture.md 3.14). 조립(entry/mcp)이 패키지 뿌리로 만든다.
 * - sh: `scripts/monitor.sh` 를 sh 로 실행한다(POSIX).
 * - node: `dist/entry/monitor.js` 를 node 로 실행한다(Windows. sh 가 없다).
 * mcp-server 의 순수 함수 monitorCommand 가 이것으로 create_room 과 get_status 의 monitor_command 를 만든다.
 */
export interface MonitorLauncher {
  readonly kind: 'sh' | 'node';
  /** 실행할 파일의 절대 경로. */
  readonly path: string;
}

export interface McpServerDeps {
  readonly session: RoomSession;
  readonly inbox: Inbox;
  readonly config: McpConfig;
  readonly problems: readonly ConfigProblem[];
  readonly limits: McpServerLimits;
  /** MCP 초기화 응답의 서버 정보. 등록 이름은 `agent-chat` 이다. */
  readonly app: AppInfo;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
  /** 관전 명령을 만드는 진입점. 생략하거나 null 이면 monitor_command 가 null 이다(시험). */
  readonly monitorLauncher?: MonitorLauncher | null;
  /**
   * 수신 상태 파일(`<home>/listen/<pid>.json`)에 적을 이 프로세스와 부모의 번호. 선택형 Stop hook 이 읽는다.
   * 생략하거나 null 이면 파일을 쓰지 않는다(시험).
   */
  readonly listenState?: { readonly pid: number; readonly ppid: number } | null;
}

export type ShutdownCause =
  | 'stdin_end'
  | 'stdin_close'
  | 'stdout_error'
  | 'SIGINT'
  | 'SIGTERM'
  | 'SIGHUP';

export interface McpServerClosed {
  readonly cause: ShutdownCause;
  /** 예산을 넘겨 정리를 다 하지 못했다. */
  readonly forced: boolean;
  readonly duration_ms: number;
}

export interface McpServerHandle {
  /**
   * 종료 절차(대기 중인 wait 끝내기 → session.shutdown → inbox.close)가 끝나거나 예산을 넘기면 resolve 한다.
   * reject 하지 않는다. 프로세스를 끝내는 일(로그 닫기, 종료 코드)은 조립이 한다.
   */
  readonly closed: Promise<McpServerClosed>;
}

/**
 * `mcp-server/index.ts` 가 `startMcpServer` 라는 이름으로 내보낸다.
 * stdio 로 MCP 서버를 띄운다. stdout 에는 MCP 메시지만 쓴다.
 * stdin end/close, stdout error, stderr error, SIGINT/SIGTERM/SIGHUP 을 직접 처리한다.
 */
export type StartMcpServer = (deps: McpServerDeps) => McpServerHandle;

// ── tool 입력의 상한 ────────────────────────────────────────────────────────

/**
 * tool 입력 스키마가 거는 값(mcp-interface.md 3절). 숫자를 타입으로 고정해 둔다.
 * 바이트 상한(text 16384, 글자 필드 4096)은 protocol.LIMITS 를 쓴다.
 */
export interface ToolInputLimits {
  readonly ROLE_MAX_CHARS: 64;
  readonly TOOLS_MAX_ITEMS: 20;
  readonly TOOL_ITEM_MAX_CHARS: 64;
  readonly NOTE_MAX_CHARS: 200;
  readonly STOP_REASON_MAX_CHARS: 200;
  readonly SCENARIO_TITLE_MAX_CHARS: 200;
  readonly TEST_DURATION_MIN: { readonly min: 1; readonly max: 480; readonly default: 60 };
  readonly TEST_SCENARIOS: { readonly min: 1; readonly max: 100; readonly default: 20 };
  readonly WAIT_MAX_SEC: { readonly min: 5; readonly max: 540; readonly default: 50 };
  /** ping_room 이 읽음 확인을 기다리는 시간(초). */
  readonly PING_TIMEOUT_SEC: { readonly min: 1; readonly max: 60; readonly default: 15 };
}

// ── tool 결과로 옮기는 표 ───────────────────────────────────────────────────

/**
 * tool 핸들러에서 예상하지 못한 예외가 났을 때의 코드. 결함이다.
 * room-session 과 inbox 는 예상 가능한 실패를 던지지 않으므로 정상 흐름에서는 나오지 않는다.
 * SDK 의 기본 처리에 맡기면 결과가 JSON 이 아니고, 예외 글(피어 입력이 섞일 수 있다)이 그대로 나간다.
 * 그래서 mcp-server 가 잡아 이 코드와 고정 글만 돌려준다. 예외 글은 결과와 로그에 싣지 않는다.
 */
export type InternalErrorCode = 'INTERNAL_ERROR';

/** room-session 의 결과 코드를 같은 이름으로 옮긴다. inbox 의 INVALID_ARGUMENT 도 이 안에 있다. INTERNAL_ERROR 만 mcp-server 가 더한다. */
export type ToolErrorCode = SessionErrorCode | InternalErrorCode;

/** 코드마다 에이전트에게 줄 글. 표는 구현 파일에 두고, 모든 코드를 빠짐없이 채워야 컴파일된다. */
export type ToolErrorMessages = { readonly [C in ToolErrorCode]: string };

/** DIRECT_CONNECT_FAILED 의 details.hint. ice 단계가 하나라도 있으면 그 안내를 쓴다. */
export type DirectConnectHints = { readonly [S in 'signaling' | 'ice' | 'session']: string };

export interface ToolNotice extends SessionNotice, InboxNotice {
  /** 재접속이 막혔거나 멈췄을 때의 복구 방법은 mcp-server 가 붙인다. */
  readonly signaling?: NonNullable<SessionNotice['signaling']> & { readonly hint?: string };
  /** 무시한 설정 값(effect 가 default_used 인 것). */
  readonly config?: readonly { readonly name: ConfigEnvName; readonly reason: string }[];
}

/** tool 결과는 텍스트 한 덩어리의 JSON 이다. 성공 결과. */
export type ToolSuccess<T> = { readonly ok: true; readonly notice?: ToolNotice } & T;

/** 실패 결과. MCP 의 isError 를 참으로 준다. */
export interface ToolFailure {
  readonly ok: false;
  readonly error: {
    readonly code: ToolErrorCode;
    readonly message: string;
    /** room-session 이 준 details 그대로. DIRECT_CONNECT_FAILED 에는 hint 를 더한다. */
    readonly details?: unknown;
  };
  readonly notice?: ToolNotice;
}

type Entered = RoomEntered & { readonly delivery_mode: DeliveryMode; readonly hint: string };

/** 사람이 이 방을 콘솔에서 지켜보는 명령 한 줄(mcp-interface.md 3.4). 방 ID 가 들어 있다. 진입점을 모르면 null. */
type MonitorCommand = { readonly monitor_command: string | null };

type CommandInput<T extends SessionCommand['type']> = Omit<Extract<SessionCommand, { type: T }>, 'type'>;

/** mcp-server 가 get_status 에 더하는 경고. */
export type ToolWarning =
  | SessionWarning
  /** 수신함 누락. */
  | { readonly code: 'inbox_dropped'; readonly count: number }
  /** 무시한 설정 값. */
  | { readonly code: 'config'; readonly name: ConfigEnvName; readonly reason: string };

/**
 * tool 마다의 입력, 부르는 곳, 성공 결과. 입력의 선택 필드에 기본값을 채워 부른다.
 *
 * | tool | 부르는 곳 |
 * |---|---|
 * | create_room, join_room | session.create, session.join. 성공하면 inbox.startProbe() |
 * | leave_room | session.leave |
 * | get_status | session.status + inbox.mode() + inbox.stats() |
 * | set_status, start_test, stop_test, start_scenario, record_claim, record_verification | session.command (type 은 tool 이름) |
 * | send_message | session.sendChat |
 * | wait_for_messages | session.notice() 가 null 이면 NOT_IN_ROOM. 아니면 inbox.wait |
 * | confirm_channel | inbox.confirm. `AGENT_CHAT_CHANNEL=off` 면 등록하지 않는다 |
 * | write_report | session.writeReport |
 *
 * 모든 호출은 처리 전에 inbox.noteToolCall({name, cursor}) 를 부르고, 결과에 그 조각과 session.notice() 를 붙인다.
 * cursor 는 wait_for_messages 가 받은 인자 그대로다. 없으면 싣지 않는다.
 */
export interface ToolContracts {
  create_room: { input: Omit<CreateRoomArgs, 'signal'>; output: Entered & MonitorCommand };
  join_room: { input: Omit<JoinRoomArgs, 'signal'>; output: Entered };
  leave_room: { input: Record<string, never>; output: RoomLeft };
  get_status: {
    input: Record<string, never>;
    output: Omit<SessionStatus, 'warnings' | 'room'> & {
      readonly room: SessionStatus['room'] & MonitorCommand;
      readonly delivery_mode: DeliveryMode;
      readonly warnings: readonly ToolWarning[];
    };
  };
  /** listening: false 면 결과에 hint(사용자에게 할 말)를 더한다. */
  set_status: { input: CommandInput<'set_status'>; output: CommandOutputs['set_status'] & { readonly hint?: string } };
  /** not_listening 이 있으면 hint 를 더한다. */
  send_message: { input: SendChatArgs; output: ChatSent & { readonly hint?: string } };
  /** 수신 점검(개선안 P6). 결과에 hint 를 늘 싣는다. */
  ping_room: { input: { readonly timeout_sec?: number }; output: PingSent & { readonly hint: string } };
  wait_for_messages: {
    input: { readonly timeout_sec?: number; readonly cursor?: string };
    output: {
      readonly status: 'events' | 'timeout' | 'channel_mode';
      readonly events: readonly DeliveredEvent[];
      readonly next_cursor: string;
      readonly more: boolean;
      readonly hint?: string;
    };
  };
  confirm_channel: {
    input: { readonly token: string };
    output: {
      readonly delivery_mode: 'channel';
      readonly events: readonly DeliveredEvent[];
      readonly next_cursor: string;
    };
  };
  start_test: {
    input: {
      readonly request: string;
      readonly max_duration_min?: number;
      readonly max_scenarios?: number;
    };
    output: CommandOutputs['start_test'];
  };
  stop_test: { input: CommandInput<'stop_test'>; output: CommandOutputs['stop_test'] };
  start_scenario: { input: CommandInput<'start_scenario'>; output: CommandOutputs['start_scenario'] };
  record_claim: { input: CommandInput<'record_claim'>; output: CommandOutputs['record_claim'] };
  record_verification: {
    input: CommandInput<'record_verification'>;
    output: CommandOutputs['record_verification'];
  };
  write_report: { input: Record<string, never>; output: ReportWritten };
}

export type ToolName = keyof ToolContracts;

/** tool 하나의 결과. */
export type ToolResult<T extends ToolName> = ToolSuccess<ToolContracts[T]['output']> | ToolFailure;
