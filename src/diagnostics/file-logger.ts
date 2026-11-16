// 파일 로거 (architecture.md 3.12, 6.3). MCP·설치 CLI 와, `--log-dir` 를 준 자체 호스팅 서버가 쓴다.
// stdout 에는 쓰지 않는다. MCP 프로세스의 stdout 에는 MCP 메시지만 나가야 한다.
// 파일과 stderr 는 FileLoggerEnv 로 받는다. 실제 것은 index.ts 가 넣는다.

import { join } from 'node:path';
import { randomLowerAlnum, utf8ByteLength } from '../protocol/index.js';
import type { TimerHandle } from '../protocol/index.js';
import type { FileLoggerOptions, Logger } from './contract.js';
import { PROC_LENGTH, buildLine, passesLevel } from './fields.js';
import type { LogFields, LogLevel, LogModule } from './log-port.js';
import { CLEANUP_INTERVAL_MS, MAX_DIR_BYTES, cleanupLogDir, hourKeyOf, logFileName } from './retention.js';
import type { CleanupIo } from './retention.js';

export const MAX_BUFFER_LINES = 1000;
export const MAX_HOUR_FILE_BYTES = 20 * 1024 * 1024;
/** 첫 줄이 버퍼에 든 뒤 파일에 덧붙이기까지의 대기. 짧은 시간에 몰린 줄을 한 번에 쓴다. */
export const FLUSH_DELAY_MS = 200;

export interface FileLoggerIo extends CleanupIo {
  /** 디렉터리가 없으면 0700 으로 만들고, 쓸 수 있는지 확인한다. 안 되면 던진다. */
  prepareDir(dir: string): void;
  /** 파일 끝에 덧붙인다. 없으면 0600 으로 만든다. */
  append(path: string, text: string): Promise<void>;
}

export interface StderrSink {
  write(text: string): void;
  /** stderr 의 error 를 받아 둔다(받는 곳이 없으면 프로세스가 죽는다). 돌려준 함수로 뗀다. */
  guard(): () => void;
}

export interface FileLoggerLimits {
  readonly maxBufferLines: number;
  readonly maxHourFileBytes: number;
  readonly maxDirBytes: number;
}

export interface FileLoggerEnv {
  readonly io: FileLoggerIo;
  readonly stderr: StderrSink;
  readonly limits?: Partial<FileLoggerLimits>;
}

interface Pending {
  readonly file: string;
  readonly text: string;
}

function silentLogger(proc: string): Logger {
  return { proc, event: () => undefined, close: () => Promise.resolve() };
}

export function createFileLoggerWith(options: FileLoggerOptions, env: FileLoggerEnv): Logger {
  let proc = '000000';
  try {
    proc = randomLowerAlnum(PROC_LENGTH, options.randomBytes);
    env.io.prepareDir(options.dir);
  } catch {
    // 로그를 쓸 수 없어도 호출자는 뜬다. 이 실패를 다시 로그로 쓰지 않는다.
    return silentLogger(proc);
  }

  const { dir, service, level: threshold, now, timers } = options;
  const stderrCopy = options.stderrCopy ?? true;
  const { io, stderr } = env;
  const maxBufferLines = env.limits?.maxBufferLines ?? MAX_BUFFER_LINES;
  const maxHourFileBytes = env.limits?.maxHourFileBytes ?? MAX_HOUR_FILE_BYTES;
  const maxDirBytes = env.limits?.maxDirBytes ?? MAX_DIR_BYTES;

  let buffer: Pending[] = [];
  /** 버퍼 넘침, 시간 파일 상한, 쓰기 실패로 버린 줄 수. 다음에 받아들인 줄에 실린다. */
  let dropped = 0;
  let hourKey = '';
  let hourBytes = 0;
  let flushTimer: TimerHandle | null = null;
  let cleanupTimer: TimerHandle | null = null;
  let writing: Promise<void> | null = null;
  let cleaning = false;
  let closed = false;
  let abandoned = false;
  let closing: Promise<void> | null = null;
  let unguard: () => void = () => undefined;

  const writeBatch = async (batch: readonly Pending[]): Promise<void> => {
    let index = 0;
    while (index < batch.length) {
      const file = (batch[index] as Pending).file;
      let text = '';
      let count = 0;
      while (index < batch.length && (batch[index] as Pending).file === file) {
        text += (batch[index] as Pending).text;
        index += 1;
        count += 1;
      }
      if (abandoned) return;
      try {
        await io.append(join(dir, file), text);
      } catch {
        dropped += count;
      }
    }
  };

  const startFlush = (): void => {
    if (writing !== null || buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    writing = writeBatch(batch).then(() => {
      writing = null;
      if (!closed && buffer.length > 0) scheduleFlush();
    });
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null || closed) return;
    flushTimer = timers.setTimeout(() => {
      flushTimer = null;
      startFlush();
    }, FLUSH_DELAY_MS);
  };

  const accept = (level: LogLevel, module: LogModule, event: string, fields: unknown, own?: Record<string, number>): void => {
    if (closed || !passesLevel(level, threshold)) return;
    const tsMs = now();
    const key = hourKeyOf(tsMs);
    if (key === null) return;
    const line = buildLine({ service, proc, tsMs, level, module, event, fields, dropped, ...(own === undefined ? {} : { own }) });
    if (line === null) return;
    const text = `${line}\n`;
    const bytes = utf8ByteLength(text);
    if (key !== hourKey) {
      hourKey = key;
      hourBytes = 0;
    }
    // 한 시간 파일이 상한을 넘으면 그 시간의 나머지는 버린다. 버퍼가 차도 버린다.
    if (hourBytes + bytes > maxHourFileBytes || buffer.length >= maxBufferLines) {
      dropped += 1;
      return;
    }
    dropped = 0;
    hourBytes += bytes;
    buffer.push({ file: logFileName(key, proc), text });
    if (stderrCopy && passesLevel(level, 'warn')) {
      try {
        stderr.write(text);
      } catch {
        // stderr 가 닫혔다. 파일에는 남는다.
      }
    }
    scheduleFlush();
  };

  const runCleanup = (): void => {
    if (closed) return;
    cleanupTimer = timers.setTimeout(runCleanup, CLEANUP_INTERVAL_MS);
    if (cleaning) return;
    cleaning = true;
    const nowMs = now();
    const key = hourKeyOf(nowMs);
    void cleanupLogDir({
      dir,
      nowMs,
      io,
      keep: key === null ? null : logFileName(key, proc),
      maxDirBytes,
      stopped: () => closed,
    }).then(
      (result) => {
        cleaning = false;
        if (result.failed === 0) return;
        try {
          // 지우지 못한 파일은 다음 주기에 다시 지운다. 여기서는 건수만 남긴다.
          accept('warn', 'diagnostics', 'log.cleanup', { outcome: 'error' }, { failed: result.failed });
        } catch {
          // 로그 실패는 삼킨다.
        }
      },
      () => {
        cleaning = false;
      },
    );
  };

  const drain = async (): Promise<void> => {
    while (!abandoned && (writing !== null || buffer.length > 0)) {
      if (writing === null) startFlush();
      if (writing !== null) await writing;
    }
  };

  try {
    unguard = stderr.guard();
  } catch {
    // 받아 두지 못해도 로그는 쓴다.
  }
  try {
    runCleanup();
  } catch {
    // 타이머를 걸지 못하면 정리 없이 간다.
  }

  return {
    proc,
    event(level: LogLevel, module: LogModule, event: string, fields?: LogFields): void {
      try {
        accept(level, module, event, fields);
      } catch {
        // 로그 실패가 호출자를 멈추지 않는다.
      }
    },
    close(budgetMs: number): Promise<void> {
      if (closing !== null) return closing;
      closed = true;
      closing = new Promise<void>((resolve) => {
        let budgetTimer: TimerHandle | null = null;
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          // 예산을 넘겼으면 남은 줄을 버린다. 이미 시작한 덧붙이기는 되돌리지 않는다.
          abandoned = true;
          buffer = [];
          try {
            if (budgetTimer !== null) timers.clearTimeout(budgetTimer);
            unguard();
          } catch {
            // 닫는 길에서는 아무 것도 던지지 않는다.
          }
          resolve();
        };
        try {
          if (flushTimer !== null) timers.clearTimeout(flushTimer);
          if (cleanupTimer !== null) timers.clearTimeout(cleanupTimer);
          flushTimer = null;
          cleanupTimer = null;
          if (!(budgetMs > 0)) {
            finish();
            return;
          }
          budgetTimer = timers.setTimeout(finish, budgetMs);
          drain().then(finish, finish);
        } catch {
          finish();
        }
      });
      return closing;
    },
  };
}
