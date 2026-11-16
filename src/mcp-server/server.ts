// MCP 서버의 조립과 stdio 수명 (architecture.md 3.11, S13).
// stdout 에는 MCP 메시지만 나간다. 이 파일은 stdout 에 직접 쓰지 않고, SDK 의 stdio 전송만 쓴다.
// SDK 는 stdin 종료, 깨진 파이프, 신호를 처리해 주지 않는다. 여기서 직접 건다.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';
import { createChannelCheckWriter } from './channel-check.js';
import type { ChannelCheckWriter } from './channel-check.js';
import { CHANNEL_CAPABILITY, CHANNEL_NOTIFICATION_METHOD, toChannelNotification } from './channel.js';
import type { McpServerClosed, McpServerDeps, McpServerHandle, ShutdownCause, StartMcpServer, ToolName } from './contract.js';
import { INSTRUCTIONS } from './instructions.js';
import { createListenStateWriter } from './listen-state.js';
import type { ListenStateWriter } from './listen-state.js';
import { registerTools } from './tools.js';

export interface McpApp {
  readonly mcp: McpServer;
  /** 등록한 tool 이름. */
  readonly toolNames: readonly ToolName[];
  readonly channelCheck: ChannelCheckWriter;
  /** 수신 상태 파일. deps.listenState 가 없으면 null. */
  readonly listenState: ListenStateWriter | null;
  /** 종료가 시작됐다. 대기 중인 wait 을 끝내고, 이후의 tool 호출을 CANCELLED 로 돌려준다. */
  beginShutdown(): void;
}

/** 전송에 붙이기 전의 MCP 서버를 만든다. capability, instructions, tool, 채널 전송, 확인 기록을 잇는다. */
export function createMcpApp(deps: McpServerDeps): McpApp {
  const { inbox, config, log } = deps;
  const channelDeclared = config.channel === 'auto';
  const shutdownController = new AbortController();

  for (const problem of deps.problems) {
    log.event('warn', 'mcp-server', 'config.problem', { name: problem.name, reason: problem.reason });
  }

  const mcp = new McpServer(
    { name: deps.app.name, version: deps.app.version },
    {
      // 채널 capability 만 선언한다. 방의 다른 참가자가 이 PC 의 tool 승인에 관여할 길(승인 중계)은 선언하지 않는다.
      capabilities: channelDeclared ? { tools: {}, experimental: { [CHANNEL_CAPABILITY]: {} } } : { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );
  mcp.server.onerror = (error) => {
    log.event('warn', 'mcp-server', 'mcp.error', { error_code: error.name });
  };

  // 선택형 Stop hook 이 읽는 수신 상태 파일(개선안 P5). 조립이 프로세스 번호를 줄 때만 쓴다.
  const listenState =
    deps.listenState === undefined || deps.listenState === null
      ? null
      : createListenStateWriter({ home: config.session.home, ...deps.listenState, now: deps.now, log });
  let enteredAt: string | null = null;
  let reportWritten = false;
  const syncListenState = (): void => {
    if (listenState === null) return;
    const notice = deps.session.notice();
    listenState.update({
      in_room: notice !== null,
      delivery_mode: inbox.mode(),
      listening: inbox.listening(),
      paused: inbox.paused(),
      report_written: reportWritten,
      test_stopped: notice?.test_stopped !== undefined,
      entered_at: notice === null ? null : enteredAt,
    });
  };
  if (listenState !== null) {
    inbox.on('listening-changed', syncListenState);
    inbox.on('mode-changed', syncListenState);
  }

  const registered = registerTools(mcp, {
    session: deps.session,
    inbox,
    config,
    problems: deps.problems,
    now: deps.now,
    log,
    shutdownSignal: shutdownController.signal,
    monitorLauncher: deps.monitorLauncher ?? null,
    onToolDone: (name, ok) => {
      if (listenState === null) return;
      if (ok && (name === 'create_room' || name === 'join_room')) {
        enteredAt = new Date(deps.now()).toISOString();
        reportWritten = false;
      }
      if (ok && name === 'write_report') reportWritten = true;
      if (ok && name === 'leave_room') enteredAt = null;
      syncListenState();
    },
  });

  const channelCheck = createChannelCheckWriter({
    home: config.session.home,
    now: deps.now,
    log,
    host: () => {
      const client = mcp.server.getClientVersion();
      return client === undefined ? null : { name: client.name, version: client.version };
    },
  });

  if (channelDeclared) {
    inbox.setChannelSender((item) =>
      // 스펙에 없는 알림이다. 메서드 이름과 params 는 호스트의 채널 계약이다.
      mcp.server.notification({ method: CHANNEL_NOTIFICATION_METHOD, params: toChannelNotification(item) }),
    );
    inbox.on('mode-changed', (change) => {
      if (change.cause === 'confirmed') channelCheck.confirmed();
      else channelCheck.fellBack();
    });
  }

  return {
    mcp,
    toolNames: registered.names,
    channelCheck,
    listenState,
    beginShutdown: () => shutdownController.abort(),
  };
}

// ── stdio 수명 ──────────────────────────────────────────────────────────────

type SignalName = Extract<ShutdownCause, `SIG${string}`>;

const SIGNALS: readonly SignalName[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** 프로세스에서 쓰는 부분. 시험은 가짜 스트림과 가짜 신호원을 넣는다. */
export interface StdioEnvironment {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: { on(event: 'error', listener: (error: Error) => void): unknown };
  readonly signals: { on(signal: SignalName, listener: () => void): unknown };
}

export function startOnStdio(deps: McpServerDeps, io: StdioEnvironment): McpServerHandle {
  const { session, inbox, limits, now, timers, log } = deps;
  const app = createMcpApp(deps);
  const transport = new StdioServerTransport(io.stdin, io.stdout);

  let shuttingDown = false;
  let resolveClosed: (closed: McpServerClosed) => void = () => {};
  const closed = new Promise<McpServerClosed>((resolve) => {
    resolveClosed = resolve;
  });

  function shutdown(cause: ShutdownCause): void {
    if (shuttingDown) return;
    shuttingDown = true;
    const startedAt = now();
    let finished = false;
    const finish = (forced: boolean): void => {
      if (finished) return;
      finished = true;
      timers.clearTimeout(forceTimer);
      // 예산을 넘겼어도 수신함의 타이머는 지운다. 여러 번 불러도 된다.
      inbox.close();
      app.listenState?.remove();
      const duration = now() - startedAt;
      log.event(forced ? 'warn' : 'info', 'mcp-server', 'shutdown', { cause, duration_ms: duration, forced });
      resolveClosed({ cause, forced, duration_ms: duration });
    };
    // 호스트가 주는 종료 유예가 짧다. 예산을 넘기면 남은 정리를 기다리지 않는다.
    const forceTimer = timers.setTimeout(() => finish(true), limits.SHUTDOWN_BUDGET_MS);

    const run = async (): Promise<void> => {
      // 대기 중인 wait 을 끝낸다. 커서는 그대로다.
      app.beginShutdown();
      await session.shutdown(Math.max(0, limits.SHUTDOWN_BUDGET_MS - (now() - startedAt)));
      inbox.close();
      await app.mcp.close();
    };
    run()
      .catch(() => {
        log.event('warn', 'mcp-server', 'shutdown.error', { cause });
      })
      .then(() => finish(false));
  }

  // 호스트가 죽으면 stdin 이 닫힌다. 이것을 듣지 않으면 프로세스가 고아로 남는다.
  io.stdin.on('end', () => shutdown('stdin_end'));
  io.stdin.on('close', () => shutdown('stdin_close'));
  // 호스트가 죽은 뒤의 쓰기는 EPIPE 다. 리스너가 없으면 잡히지 않는 예외가 된다.
  io.stdout.on('error', () => shutdown('stdout_error'));
  // stderr 가 깨져도 죽지 않는다. 진단 로그의 원본은 파일이다.
  io.stderr.on('error', () => {});
  for (const signal of SIGNALS) io.signals.on(signal, () => shutdown(signal));
  // 전송이 스스로 닫히면(읽기 버퍼 초과 등) 더 받을 수 없다. stdin 이 닫힌 것과 같이 다룬다.
  app.mcp.server.onclose = () => shutdown('stdin_close');

  app.mcp.connect(transport).catch(() => {
    log.event('error', 'mcp-server', 'mcp.connect', { outcome: 'failed' });
    shutdown('stdin_close');
  });

  return { closed };
}

export const startMcpServer: StartMcpServer = (deps) =>
  startOnStdio(deps, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signals: process });
