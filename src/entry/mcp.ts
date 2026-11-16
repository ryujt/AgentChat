#!/usr/bin/env node
// agent-chat-mcp 의 조립 (architecture.md 1~3절, S13). 참가자 한 명의 MCP 프로세스다.
// 순서: loadConfig → 진단 로거(파일. stdout 에 쓰지 않는다) → 수신함 → room-session(하위 모듈을 만드는 함수 주입) → startMcpServer.
// 환경 변수는 process.env 를 통째로 loadConfig 에 넘긴다. 이 파일은 값을 직접 읽지 않는다.
// stdout 에는 MCP 메시지만 나간다. 이 파일은 stdout 과 console 을 쓰지 않는다.
//
// 종료 (S13): startMcpServer 가 stdin end/close, stdout error, SIGINT/SIGTERM/SIGHUP 을 직접 받는다.
// 호스트가 SIGKILL 되면 stdin 이 닫혀 같은 길로 끝난다(고아로 남지 않는다 [실측 PRE-MCP-09]).
// 프로세스 전체의 종료 예산은 SHUTDOWN_BUDGET_MS(400ms)이고, 그 안에 로그 닫기와 process.exit 까지 든다.
// 그래서 mcp-server 에는 예산에서 EXIT_RESERVE_MS 를 뺀 값을 넘기고, 남은 시간으로 로그를 닫는다.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileLogger } from '../diagnostics/index.js';
import type { Logger } from '../diagnostics/contract.js';
import { DEFAULT_INBOX_LIMITS, createInbox } from '../inbox/index.js';
import { DEFAULT_MCP_SERVER_LIMITS, loadConfig, startMcpServer } from '../mcp-server/index.js';
import type { McpServerLimits, MonitorLauncher } from '../mcp-server/contract.js';
import { createMesh } from '../mesh/index.js';
import type { Now, Timers } from '../protocol/index.js';
import { openTranscript, writeReport } from '../records/index.js';
import { DEFAULT_ROOM_SESSION_LIMITS, createRoomSession } from '../room-session/index.js';
import type { AppInfo } from '../room-session/contract.js';
import { createReplica } from '../shared-state/index.js';
import { createSignalingClient } from '../signaling-client/index.js';

/** MCP 등록 이름이자 hello.client·기록 파일 첫 줄의 패키지 이름. */
const APP_NAME = 'agent-chat';
/** package.json 을 읽지 못했을 때의 버전. 프로세스는 떠야 한다. */
const UNKNOWN_VERSION = '0.0.0-unknown';
/**
 * 종료 예산 가운데 조립이 쓰는 몫(로그 닫기, process.exit, 네이티브 정리의 꼬리).
 * mcp-server 는 SHUTDOWN_BUDGET_MS − 이 값 안에 세션을 정리하고 closed 를 resolve 한다.
 * 값은 V-L7(나)의 실측으로 정했다(tests/test-history/2026-11-15-w9-assembly.md).
 */
const EXIT_RESERVE_MS = 80;
/** 로그 닫기에 줄 최소 시간. 예산을 다 썼어도 버퍼의 마지막 줄을 쓸 기회를 한 번 준다. */
const LOG_CLOSE_MIN_MS = 10;
/** process.exit 이 걸리는 시간으로 남겨 두는 몫. 로그 닫기는 이것을 뺀 나머지만 쓴다. */
const EXIT_MARGIN_MS = 20;

// 전역 시계와 타이머는 조립에서만 부른다. 모듈에는 주입한다.
const now: Now = () => Date.now();
const timers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// 이 파일은 <패키지 뿌리>/dist/entry/mcp.js 로 실행된다.
const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function readAppInfo(): AppInfo {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
    const version = (parsed as { version?: unknown } | null)?.version;
    return { name: APP_NAME, version: typeof version === 'string' && version !== '' ? version : UNKNOWN_VERSION };
  } catch {
    return { name: APP_NAME, version: UNKNOWN_VERSION };
  }
}

/**
 * 사람이 방을 콘솔로 지켜보는 진입점(architecture.md 3.14). get_status 와 create_room 의 monitor_command 가 된다.
 * Windows 에는 sh 가 없으므로 node 로 조립 파일을 바로 실행한다.
 */
function monitorLauncherOf(platform: NodeJS.Platform): MonitorLauncher {
  return platform === 'win32'
    ? { kind: 'node', path: join(appRoot, 'dist', 'entry', 'monitor.js') }
    : { kind: 'sh', path: join(appRoot, 'scripts', 'monitor.sh') };
}

function errorNameOf(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

async function main(): Promise<void> {
  const app = readAppInfo();
  // 값이 잘못돼도 실패하지 않는다. 잘못된 값은 problems 로 나오고 mcp-server 가 알린다.
  const { config, problems } = loadConfig(process.env);

  // MCP 프로세스는 파일 로거만 만든다. stdout 로거는 stdout 에 쓰므로 MCP 메시지를 깨뜨린다.
  // 디렉터리를 쓸 수 없으면 아무 것도 쓰지 않는 로거가 온다(로그 실패가 프로세스를 멈추지 않는다).
  const logger: Logger = createFileLogger({
    dir: join(config.session.home, 'logs'),
    service: 'mcp',
    level: config.logLevel,
    now,
    timers,
  });

  // 예상하지 못한 예외는 이름만 남기고 정상 종료 절차를 탄다. 예외 글(피어 입력이 섞일 수 있다)은 남기지 않는다.
  // 종료 절차는 startMcpServer 가 건 신호 처리기가 맡는다.
  let crashed = false;
  const onCrash = (error: unknown): void => {
    logger.event('error', 'entry', 'process.error', { error_code: errorNameOf(error) });
    if (crashed) return;
    crashed = true;
    process.kill(process.pid, 'SIGTERM');
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  // 수신함은 프로세스에 하나다. 세션과 서버에 같은 것을 넘긴다.
  // cursor 는 프로세스 시작 시각(ms) 다음부터 센다. 대화가 이어지는 채로 이 프로세스만 다시 떠도 새 사건의 cursor 가
  // 앞 프로세스의 것과 겹치지 않는다(에이전트는 cursor 로 중복을 거른다. 검토 2차 PRODUCT-R2-01).
  const inbox = createInbox({ limits: DEFAULT_INBOX_LIMITS, now, timers, log: logger, cursorBase: now() });

  const session = createRoomSession({
    config: config.session,
    app,
    limits: DEFAULT_ROOM_SESSION_LIMITS,
    inbox,
    // 하위 모듈은 입장마다 새로 만든다. room-session 은 구현을 모르고 만드는 함수만 받는다.
    createSignalingClient,
    createMesh,
    createReplica,
    openTranscript,
    writeReport,
    now,
    timers,
    log: logger,
  });

  const totalBudgetMs = DEFAULT_MCP_SERVER_LIMITS.SHUTDOWN_BUDGET_MS;
  const serverLimits: McpServerLimits = { SHUTDOWN_BUDGET_MS: totalBudgetMs - EXIT_RESERVE_MS };

  logger.event('info', 'entry', 'mcp.start', { outcome: 'ok', name: config.session.name });

  const handle = startMcpServer({
    session,
    inbox,
    config,
    problems,
    limits: serverLimits,
    app,
    now,
    timers,
    log: logger,
    monitorLauncher: monitorLauncherOf(process.platform),
    // 선택형 Stop hook 이 이 세션의 상태 파일을 찾는 데 쓴다(부모 = 호스트 프로세스).
    listenState: { pid: process.pid, ppid: process.ppid },
  });

  const closed = await handle.closed;
  // 종료를 시작한 뒤 흐른 시간은 closed.duration_ms 다. 남은 예산 안에서 로그를 닫고 끝낸다.
  const logBudgetMs = Math.max(LOG_CLOSE_MIN_MS, totalBudgetMs - closed.duration_ms - EXIT_MARGIN_MS);
  await logger.close(logBudgetMs);
  process.exit(0);
}

await main();
