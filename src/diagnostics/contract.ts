// diagnostics 의 공개 계약 (architecture.md 3.12, 6.3). 로거를 만드는 함수와 닫는 손잡이의 타입이다.
// 로거를 만드는 곳은 조립뿐이다(entry/mcp, entry/server, entry/lambda, entry/cli 와 그것이 부르는 조립 모듈).
// 다른 모듈은 log-port.ts 의 LogPort 만 주입받는다. 이 파일에는 타입만 있다.

import type { Now, RandomBytes, Timers } from '../protocol/index.js';
import type { LogLevel, LogPort, LogService } from './log-port.js';

interface LoggerOptions {
  /** 줄마다 붙는 svc. server·lambda 면 출력기가 peer 필드를 버린다. */
  readonly service: LogService;
  /** 이 수준보다 낮은 사건은 쓰지 않는다. MCP 프로세스는 AGENT_CHAT_LOG_LEVEL 에서 온 값이다. */
  readonly level: LogLevel;
  /** 줄의 ts 와 파일 이름의 시간 구간을 정한다. */
  readonly now: Now;
  /** 줄마다 붙는 proc(무작위 6자)을 만들 때 쓴다. 생략하면 node:crypto. */
  readonly randomBytes?: RandomBytes;
}

export interface FileLoggerOptions extends LoggerOptions {
  /** 로그 디렉터리(`<AGENT_CHAT_HOME>/logs`, 서버는 `--log-dir`). 없으면 0700 으로 만든다. */
  readonly dir: string;
  /** 버퍼 쓰기와 보존 정리(시작 때 1회, 이후 1시간마다)의 타이머. */
  readonly timers: Timers;
  /**
   * warn 이상의 줄을 stderr 에도 쓰는가. 생략하면 참이다.
   * 관전 도구(svc monitor)는 거짓을 준다. 그 콘솔은 사람이 읽는 출력이라 JSON 로그 줄이 섞이면 안 된다(architecture.md 3.12).
   */
  readonly stderrCopy?: boolean;
}

/** stdout 에 JSON 한 줄씩 쓴다(자체 호스팅의 기본, Lambda). 보존은 수집기가 맡는다. */
export type StdoutLoggerOptions = LoggerOptions;

export interface Logger extends LogPort {
  /** 이 로거의 줄마다 붙는 proc. 파일 로거는 파일 이름에도 같은 값이 든다. */
  readonly proc: string;

  /**
   * 버퍼에 남은 줄을 예산 안에서 쓰고 타이머를 지운다(종료 절차의 "로그를 닫고").
   * 예산을 넘기면 남은 줄을 버리고 끝낸다. reject 하지 않는다. 여러 번 불러도 된다.
   * 닫은 뒤의 event 는 버린다.
   */
  close(budgetMs: number): Promise<void>;
}

/**
 * `diagnostics/index.ts` 가 `createFileLogger` 라는 이름으로 내보낸다. 던지지 않는다.
 * 디렉터리를 쓸 수 없으면 아무 것도 쓰지 않는 로거를 돌려준다(로그 실패가 호출자를 멈추지 않는다).
 */
export type CreateFileLogger = (options: FileLoggerOptions) => Logger;

/** `diagnostics/index.ts` 가 `createStdoutLogger` 라는 이름으로 내보낸다. 던지지 않는다. */
export type CreateStdoutLogger = (options: StdoutLoggerOptions) => Logger;
