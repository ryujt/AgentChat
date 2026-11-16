#!/usr/bin/env node
// 관전 도구의 조립 (architecture.md 3.14, S16). 사람이 콘솔에서 방에 읽기 전용 관전자로 들어가 방에서 오가는 것을 본다.
// 순서: parseMonitorArgs(process.env 를 통째로) → 진단 로거(파일. stderr 사본 없음) → 싱크(수신함 자리) →
//       room-session(하위 모듈을 만드는 함수 주입) → runMonitor. 신호를 받으면 bye 를 보내고 process.exit 한다.
// 실행 길: `node dist/entry/monitor.js …`, `sh scripts/monitor.sh …`(exec 로 이 파일), `agent-chat monitor …`(entry/cli 가 main 을 부른다),
//          bin `agent-chat-monitor`. 이 파일이 직접 실행됐을 때만 스스로 main 을 부른다.
// stdout 에는 관전 출력(사람용 줄 또는 JSON Lines)만, stderr 에는 사람용 안내만 쓴다. 진단 로그는 파일에만 간다.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileLogger } from '../diagnostics/index.js';
import { createMesh } from '../mesh/index.js';
import { createLineSplitter, createMonitorSink, jsonLine, parseMonitorArgs, runMonitor } from '../monitor/index.js';
import type { MonitorStyle } from '../monitor/contract.js';
import type { Now, Timers } from '../protocol/index.js';
import { openTranscript, writeReport } from '../records/index.js';
import { DEFAULT_ROOM_SESSION_LIMITS, createRoomSession } from '../room-session/index.js';
import type { AppInfo } from '../room-session/contract.js';
import { createReplica } from '../shared-state/index.js';
import { createSignalingClient } from '../signaling-client/index.js';

/** hello.client 의 패키지 이름. MCP 프로세스와 같다. */
const APP_NAME = 'agent-chat';
const UNKNOWN_VERSION = '0.0.0-unknown';
/** 로그를 닫는 예산. 끝낼 때 쓰지 못한 줄은 버린다. */
const LOG_CLOSE_BUDGET_MS = 500;
/** 두 번째 Ctrl-C 로 바로 끝낼 때의 로그 예산. */
const LOG_CLOSE_FAST_MS = 100;
/** stdout 이 비워지기를 기다리는 최대 시간(파이프의 읽는 쪽이 멈춰 있어도 끝난다). */
const STDOUT_FLUSH_MS = 1_000;

const now: Now = () => Date.now();
const timers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// 이 파일은 <패키지 뿌리>/dist/entry/monitor.js 로 실행된다.
const thisFile = fileURLToPath(import.meta.url);
const appRoot = dirname(dirname(dirname(thisFile)));

function readAppInfo(): AppInfo {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
    const version = (parsed as { version?: unknown } | null)?.version;
    return { name: APP_NAME, version: typeof version === 'string' && version !== '' ? version : UNKNOWN_VERSION };
  } catch {
    return { name: APP_NAME, version: UNKNOWN_VERSION };
  }
}

/** 이 PC 의 지역 시각 HH:MM:SS. */
function localClock(ms: number): string {
  const date = new Date(ms);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** 한 줄 쓰기. 닫힌 파이프(EPIPE)여도 던지지 않는다. 닫힘은 stream 의 error 사건으로 따로 안다. */
function lineWriter(stream: NodeJS.WriteStream): (line: string) => void {
  return (line) => {
    try {
      stream.write(`${line}\n`);
    } catch {
      // 읽는 쪽이 끝났다.
    }
  };
}

/** 쓴 것이 다 나가기를 기다린다. 파이프에서는 쓰기가 비동기일 수 있다. */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, STDOUT_FLUSH_MS);
    try {
      stream.write('', () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function exitWith(code: number): Promise<never> {
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit(code);
}

/** 관전 도구를 실행한다. 끝나면 process.exit 으로 끝낸다(네이티브 핸들이 남는다). 돌아오지 않는다. */
export async function main(argv: readonly string[]): Promise<never> {
  const out = lineWriter(process.stdout);
  const err = lineWriter(process.stderr);
  // 닫힌 파이프에 쓴 오류가 프로세스를 죽이지 않게 먼저 받는다. 실제 처리는 아래에서 단다.
  const ignore = (): void => undefined;
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);

  const parsed = parseMonitorArgs(argv, process.env, process.stdout.isTTY === true);
  if (parsed.kind === 'help') {
    out(parsed.text);
    return exitWith(0);
  }
  if (parsed.kind === 'error') {
    if (parsed.json) out(jsonLine({ type: 'error', code: 'INVALID_ARGUMENT', detail: parsed.message }));
    err(`agent-chat monitor: ${parsed.message}`);
    err('사용법: agent-chat monitor <room_id> [서버] [--name <이름>] [--json] [--no-color]  (-h 로 자세히)');
    return exitWith(2);
  }
  const { options } = parsed;

  // 관전 출력은 사람이 읽는 콘솔이다. warn 이상의 로그 줄을 stderr 에 베끼지 않는다. 로그 파일에는 본문과 방 ID 원문이 없다.
  const logger = createFileLogger({
    dir: join(options.session.home, 'logs'),
    service: 'monitor',
    level: options.logLevel,
    now,
    timers,
    stderrCopy: false,
  });

  const style: MonitorStyle = { color: options.color, clock: localClock };
  // 싱크가 요약에 없는 시나리오를 만나면 세션의 지금 요약을 다시 받는다. 세션은 아래에서 만든다.
  let session: ReturnType<typeof createRoomSession> | null = null;
  const sink = createMonitorSink({
    write: out,
    style,
    json: options.json,
    now,
    refresh: () => {
      const observed = session?.observed();
      if (observed === undefined || !observed.ok) return null;
      const { ok: _ok, ...rest } = observed;
      return rest;
    },
  });
  session = createRoomSession({
    config: options.session,
    app: readAppInfo(),
    limits: DEFAULT_ROOM_SESSION_LIMITS,
    // 수신함 자리에 싱크를 넣는다. room-session 이 넣는 사건이 바로 콘솔로 나간다.
    inbox: sink,
    createSignalingClient,
    createMesh,
    createReplica,
    // 관전 모드는 기록 파일과 보고서를 쓰지 않는다. 계약을 채우려고 넘긴다.
    openTranscript,
    writeReport,
    now,
    timers,
    log: logger,
  });

  const handle = runMonitor({ session, sink, options, out, err, style, now, timers, log: logger });

  // 예상하지 못한 예외는 이름만 남기고 끝낸다. 예외 글(피어 입력이 섞일 수 있다)은 남기지 않는다.
  const onCrash = (error: unknown): void => {
    logger.event('error', 'entry', 'process.error', { error_code: error instanceof Error ? error.name : typeof error });
    err('agent-chat monitor: 예상하지 못한 오류로 멈췄다.');
    void (async () => {
      await session?.shutdown(500);
      await logger.close(LOG_CLOSE_FAST_MS);
      process.exit(1);
    })();
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => handle.stop('interrupted'));
  // 읽는 쪽이 끝났다(예: `| head`). 남은 출력은 갈 곳이 없다. 방에 bye 를 보내고 끝낸다.
  // 한 번만 받는다. 그 뒤의 쓰기도 같은 오류를 내는데, 그것을 두 번째 신호(130)로 읽으면 안 된다.
  process.stdout.once('error', () => handle.stop('stdout_closed'));

  // 사람이 콘솔에 입력한 줄을 에이전트들에게 보낸다(--read-only 면 받지 않는다). stdin 이 끝나도(파이프, /dev/null) 관전은 계속한다.
  if (options.input) {
    const lines = createLineSplitter((line) => {
      void handle.input(line);
    });
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => lines.push(chunk));
    process.stdin.on('end', () => lines.end());
    process.stdin.on('error', () => undefined);
  }

  const code = await handle.done;
  await logger.close(code === 130 ? LOG_CLOSE_FAST_MS : LOG_CLOSE_BUDGET_MS);
  return exitWith(code);
}

/** 이 파일을 직접 실행했는가(node dist/entry/monitor.js, sh scripts/monitor.sh, bin 의 링크). entry/cli 가 import 했으면 거짓이다. */
function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(thisFile);
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main(process.argv.slice(2));
