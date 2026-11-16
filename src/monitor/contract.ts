// monitor 의 공개 계약 (architecture.md 3.14). 사람이 콘솔에서 방에 관전자로 들어가 방에서 오가는 것을 보게 한다.
// 연결·동기화·사건 만들기는 room-session 이 한다. 이 모듈은 인자 해석, 출력, 종료만 맡는다.
// stdout·stderr·시계·타이머·로그는 주입받는다. 생성과 주입은 entry/monitor 가 한다. 이 파일에는 타입만 있다.

import type { LogLevel, LogPort } from '../diagnostics/log-port.js';
import type { InboxEvent } from '../inbox/contract.js';
import type { Now, RandomBytes, Timers } from '../protocol/index.js';
import type { RoomObserved, RoomSession, RoomSessionConfig, SessionInbox } from '../room-session/contract.js';

// ── 인자 ────────────────────────────────────────────────────────────────────

/** 해석한 실행 설정. 방 ID 원문이 들어 있다. 출력과 로그에 싣지 않는다. */
export interface MonitorOptions {
  readonly roomId: string;
  /** observe 에 넘길 서버 주소 원문(검증을 통과한 값). 인자, AGENT_CHAT_SERVER, 공용 서버 순이다. */
  readonly server: string;
  /** 정규화한 서버 키. 출력에 쓴다. */
  readonly serverKey: string;
  readonly name: string;
  /** stdout 에 JSON Lines 만 쓴다. */
  readonly json: boolean;
  /** 사람용 출력에 색을 쓴다. stdout 이 TTY 이고 --json·--no-color·NO_COLOR 가 없을 때만 참이다. */
  readonly color: boolean;
  /** stdin 의 줄을 채팅으로 보낸다(--read-only 면 거짓). */
  readonly input: boolean;
  /** room-session 에 그대로 넘긴다(client 는 monitor). */
  readonly session: RoomSessionConfig;
  /** 진단 로그 수준(AGENT_CHAT_LOG_LEVEL). */
  readonly logLevel: LogLevel;
}

export type ParsedMonitorArgs =
  | { readonly kind: 'run'; readonly options: MonitorOptions }
  /** -h, --help. 사용법을 stdout 에 쓰고 종료 코드 0. */
  | { readonly kind: 'help'; readonly text: string }
  /** 인자·설정 오류. 종료 코드 2. json 이 참이면(--json 을 받았으면) stdout 에 error 줄도 쓴다. */
  | { readonly kind: 'error'; readonly message: string; readonly json: boolean };

export interface ParseMonitorArgsOptions {
  /** AGENT_CHAT_HOME 이 없을 때 `~` 로 쓸 디렉터리. */
  readonly homeDir?: string;
  /** 기본 이름 `observer-<무작위 4자>` 를 만들 때 쓴다. 생략하면 node:crypto. */
  readonly randomBytes?: RandomBytes;
}

/** `monitor/index.ts` 가 parseMonitorArgs 라는 이름으로 내보낸다. 환경 변수를 해석하는 곳은 이 함수 하나다. 던지지 않는다. */
export type ParseMonitorArgs = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdoutIsTty: boolean,
  options?: ParseMonitorArgsOptions,
) => ParsedMonitorArgs;

// ── 출력 ────────────────────────────────────────────────────────────────────

export interface MonitorStyle {
  readonly color: boolean;
  /** 이 PC 의 지역 시각 `HH:MM:SS`. 조립이 넘긴다(시간대를 모듈이 고르지 않는다). */
  readonly clock: (ms: number) => string;
}

/** 주장·검증 줄에 순번과 주장 작성자를 붙이려고 출력 쪽이 갖는 표. 모르면 null. */
export interface MonitorBook {
  scenarioIndex(scenarioId: string): number | null;
  claimAuthor(claimId: string): string | null;
}

/**
 * room-session 의 수신함 자리에 넣는 싱크. 받은 사건을 바로 출력한다.
 * start() 전에 받은 사건(입장 중의 채팅, system)은 들고 있다가 start() 에서 순서대로 쓴다. 최대 MONITOR_HOLD_MAX 건이다.
 */
export interface MonitorSink extends SessionInbox {
  /** 요약으로 표(MonitorBook)를 채운다. */
  seed(observed: RoomObserved): void;
  /** 들고 있던 사건을 쓰고, 이후로는 받는 대로 쓴다. 넘쳐 버린 것이 있으면 알림 한 줄을 쓴다. */
  start(): void;
  /** 더 쓰지 않는다(종료). */
  close(): void;
  /** 쓴 사건 수. */
  written(): number;
  /** 넘쳐 버린 사건 수. */
  dropped(): number;
}

export interface MonitorSinkDeps {
  /** stdout 한 줄 쓰기(줄바꿈은 부르는 쪽이 붙인다). */
  readonly write: (line: string) => void;
  readonly style: MonitorStyle;
  readonly json: boolean;
  /** 넘쳐 버린 것을 알리는 줄의 시각. */
  readonly now: Now;
  /** 표에 없는 시나리오·주장을 만났을 때 지금 요약을 다시 받는다(runMonitor 가 session.observed 로 준다). */
  readonly refresh?: () => RoomObserved | null;
}

// ── 실행 ────────────────────────────────────────────────────────────────────

/** 0 사용자가 끝냄·stdout 닫힘, 1 입장 실패·예상 못 한 예외, 2 인자·설정 오류, 130 정리 중 두 번째 신호. */
export type MonitorExitCode = 0 | 1 | 2 | 130;

/** interrupted: SIGINT·SIGTERM·SIGHUP. stdout_closed: 파이프의 읽는 쪽이 끝났다(EPIPE). */
export type MonitorEndReason = 'interrupted' | 'stdout_closed';

export interface MonitorDeps {
  /**
   * 관전 도구가 세션에서 부르는 것은 이 넷뿐이다. sendChat 은 사람이 콘솔에 입력한 글을 보낼 때만 부른다.
   * 명령·보고서(공유 상태 쓰기)는 부르지 않는다(V-U12).
   */
  readonly session: Pick<RoomSession, 'observe' | 'observed' | 'shutdown' | 'sendChat'>;
  readonly sink: MonitorSink;
  readonly options: MonitorOptions;
  /** stdout 한 줄. 실패해도 던지지 않는다. */
  readonly out: (line: string) => void;
  /** stderr 한 줄(사람용 안내). 실패해도 던지지 않는다. */
  readonly err: (line: string) => void;
  readonly style: MonitorStyle;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
}

export interface MonitorHandle {
  /** 끝나면 종료 코드로 resolve 한다. reject 하지 않는다. */
  readonly done: Promise<MonitorExitCode>;
  /** 첫 번째는 bye 를 보내고 정리한다. 정리 중의 두 번째는 기다리지 않고 130 으로 끝낸다. */
  stop(reason: MonitorEndReason): void;
  /** 사람이 입력한 한 줄. 관전 중이면 채팅으로 보내고 결과를 쓴다. options.input 이 거짓이면 무시한다. */
  input(line: string): Promise<void>;
}

export type RunMonitor = (deps: MonitorDeps) => MonitorHandle;

/** 사람용 사건 한 줄을 만드는 함수의 모양. 여러 줄이면 줄바꿈으로 잇는다. */
export type FormatEvent = (event: InboxEvent, style: MonitorStyle, book: MonitorBook) => string;
