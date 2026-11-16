// stdout 로거 (architecture.md 6.3). 자체 호스팅 서버의 기본 출력과 Lambda 가 쓴다.
// MCP 프로세스의 조립은 이 로거를 만들지 않는다. 보존은 수집기(journald, CloudWatch)가 맡는다.

import { randomLowerAlnum } from '../protocol/index.js';
import type { Logger, StdoutLoggerOptions } from './contract.js';
import { PROC_LENGTH, buildLine, passesLevel } from './fields.js';
import type { LogFields, LogLevel, LogModule } from './log-port.js';

export interface LineSink {
  /** 개행 없는 JSON 한 줄을 받는다. */
  writeLine(line: string): void;
  /** 출력 스트림의 error 를 받아 둔다. 돌려준 함수로 뗀다. */
  guard(): () => void;
}

export function createStdoutLoggerWith(options: StdoutLoggerOptions, sink: LineSink): Logger {
  let proc = '000000';
  let unguard: () => void = () => undefined;
  let closed = false;
  try {
    proc = randomLowerAlnum(PROC_LENGTH, options.randomBytes);
    unguard = sink.guard();
  } catch {
    // 받아 두지 못해도 로그는 쓴다.
  }
  const { service, level: threshold, now } = options;

  return {
    proc,
    event(level: LogLevel, module: LogModule, event: string, fields?: LogFields): void {
      try {
        if (closed || !passesLevel(level, threshold)) return;
        const line = buildLine({ service, proc, tsMs: now(), level, module, event, fields });
        if (line !== null) sink.writeLine(line);
      } catch {
        // 로그 실패가 호출자를 멈추지 않는다.
      }
    },
    close(): Promise<void> {
      // 버퍼가 없다. 줄은 event 안에서 이미 넘겼다.
      if (!closed) {
        closed = true;
        try {
          unguard();
        } catch {
          // 닫는 길에서는 아무 것도 던지지 않는다.
        }
      }
      return Promise.resolve();
    },
  };
}
