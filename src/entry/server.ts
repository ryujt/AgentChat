#!/usr/bin/env node
// agent-chat-server 의 조립 (architecture.md 1절, deployment.md 3절).
// 실행 옵션을 읽고, 전역 시계·타이머·로거를 만들어 signaling-selfhost 에 넘긴다. 환경 변수는 읽지 않는다.
// 준비 문구는 신호 처리기를 건 뒤에 출력한다. 문구를 본 쪽이 바로 SIGTERM 을 보내도 정상 종료 절차를 탄다.

import { parseArgs } from 'node:util';
import type { Logger } from '../diagnostics/contract.js';
import { createFileLogger, createStdoutLogger } from '../diagnostics/index.js';
import { SELF_HOST_DEFAULT_PORT } from '../protocol/index.js';
import type { Now, Timers } from '../protocol/index.js';
import { DEFAULT_SELF_HOST_LIMITS, startSelfHostServer } from '../signaling-selfhost/index.js';
import type { SelfHostLimits, SelfHostServer } from '../signaling-selfhost/index.js';

const DEFAULT_HOST = '0.0.0.0';
/** SIGTERM 뒤 이 시간이 지나도 끝나지 않으면 종료 코드 1 로 끊는다. 정상 종료는 5초 안에 끝나야 한다. */
const FORCE_EXIT_MS = 4_800;
const LOG_CLOSE_BUDGET_MS = 300;

const USAGE = `사용법: agent-chat-server [옵션]

  --host <주소>                    바인드 주소 (기본 ${DEFAULT_HOST}. 프록시 뒤에서는 127.0.0.1)
  --port <포트>                    포트 (기본 ${SELF_HOST_DEFAULT_PORT}. 0 이면 빈 포트를 고른다)
  --max-connections <수>           총 연결 수 (기본 ${DEFAULT_SELF_HOST_LIMITS.maxConnections}). 넘으면 HTTP 503
  --max-connections-per-ip <수>    주소별 연결 수 (기본 ${DEFAULT_SELF_HOST_LIMITS.maxConnectionsPerIp}). 넘으면 HTTP 429
  --join-deadline-ms <ms>          연결 뒤 이 시간 안에 join 이 없으면 닫는다 (기본 ${DEFAULT_SELF_HOST_LIMITS.joinDeadlineMs})
  --trust-proxy                    X-Forwarded-For 의 주소로 주소별 제한을 건다. 프록시 뒤에서만 켠다
  --allow-origin <출처>            WebSocket 접속을 허용할 브라우저 출처 하나 (예: https://tools.camp)
  --log-dir <디렉터리>             로그를 그 디렉터리의 시간 단위 파일에 쓰고 7일 지난 파일을 지운다 (기본 stdout)
  --help                           이 안내를 출력한다
`;

interface ServerArgs {
  readonly host: string;
  readonly port: number;
  readonly limits: SelfHostLimits;
  readonly allowedOrigin: string | undefined;
  readonly logDir: string | null;
}

type ParsedArgs = { readonly kind: 'run'; readonly args: ServerArgs } | { readonly kind: 'help' } | { readonly kind: 'error'; readonly message: string };

function integerOption(name: string, raw: string | undefined, fallback: number, min: number, max: number): number | string {
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) return `--${name} 의 값은 정수여야 한다`;
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) return `--${name} 의 값은 ${min} 이상 ${max} 이하여야 한다`;
  return value;
}

function readArgs(argv: readonly string[]): ParsedArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        'max-connections': { type: 'string' },
        'max-connections-per-ip': { type: 'string' },
        'join-deadline-ms': { type: 'string' },
        'trust-proxy': { type: 'boolean' },
        'allow-origin': { type: 'string' },
        'log-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch {
    return { kind: 'error', message: '모르는 옵션이거나 값이 빠졌다' };
  }
  if (values['help'] === true) return { kind: 'help' };

  const text = (name: string): string | undefined => (typeof values[name] === 'string' ? (values[name] as string) : undefined);
  const port = integerOption('port', text('port'), SELF_HOST_DEFAULT_PORT, 0, 65_535);
  const maxConnections = integerOption('max-connections', text('max-connections'), DEFAULT_SELF_HOST_LIMITS.maxConnections, 1, 1_000_000);
  const maxConnectionsPerIp = integerOption(
    'max-connections-per-ip',
    text('max-connections-per-ip'),
    DEFAULT_SELF_HOST_LIMITS.maxConnectionsPerIp,
    1,
    1_000_000,
  );
  const joinDeadlineMs = integerOption('join-deadline-ms', text('join-deadline-ms'), DEFAULT_SELF_HOST_LIMITS.joinDeadlineMs, 1, 3_600_000);
  for (const value of [port, maxConnections, maxConnectionsPerIp, joinDeadlineMs]) {
    if (typeof value === 'string') return { kind: 'error', message: value };
  }
  const host = text('host') ?? DEFAULT_HOST;
  const logDir = text('log-dir') ?? null;
  const allowedOrigin = text('allow-origin');
  if (host === '') return { kind: 'error', message: '--host 의 값이 비었다' };
  if (logDir === '') return { kind: 'error', message: '--log-dir 의 값이 비었다' };
  if (allowedOrigin !== undefined && (
    !/^https?:\/\//.test(allowedOrigin) || !URL.canParse(allowedOrigin) || new URL(allowedOrigin).origin !== allowedOrigin
  )) {
    return { kind: 'error', message: '--allow-origin 의 값은 경로 없는 HTTP(S) 출처여야 한다' };
  }

  return {
    kind: 'run',
    args: {
      host,
      port: port as number,
      limits: {
        maxConnections: maxConnections as number,
        maxConnectionsPerIp: maxConnectionsPerIp as number,
        joinDeadlineMs: joinDeadlineMs as number,
        trustProxy: values['trust-proxy'] === true,
      },
      allowedOrigin,
      logDir,
    },
  };
}

function urlOf(host: string, port: number, family: string): string {
  return family === 'IPv6' ? `ws://[${host}]:${port}` : `ws://${host}:${port}`;
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'Error';
}

async function main(): Promise<void> {
  const parsed = readArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const { host, port, limits, allowedOrigin, logDir } = parsed.args;

  // 전역 시계와 타이머는 조립에서만 부른다.
  const now: Now = () => Date.now();
  const timers: Timers = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
  const logger: Logger =
    logDir === null
      ? createStdoutLogger({ service: 'server', level: 'info', now })
      : createFileLogger({ dir: logDir, service: 'server', level: 'info', now, timers });

  let server: SelfHostServer | null = null;
  let stopping = false;
  const stop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), FORCE_EXIT_MS);
    const closed = server === null ? Promise.resolve() : server.close();
    void closed
      .then(() => logger.close(LOG_CLOSE_BUDGET_MS))
      .then(() => {
        clearTimeout(force);
        // 남은 출력이 나가도록 이벤트 루프가 비워지기를 기다린다.
        process.exitCode = exitCode;
      });
  };

  try {
    server = await startSelfHostServer({
      host,
      port,
      limits,
      allowedOrigin,
      log: logger,
      now,
      timers,
      onListenerError: () => stop(1),
    });
  } catch (error) {
    process.stderr.write(`서버를 시작하지 못했다(${errorCodeOf(error)}): ${host}:${port}\n`);
    await logger.close(LOG_CLOSE_BUDGET_MS);
    process.exitCode = 1;
    return;
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => stop(0));

  const { address } = server;
  logger.event('info', 'entry', 'server.start', { outcome: 'ok' });
  process.stdout.write(`agent-chat-server 준비됨. listening on ${urlOf(address.host, address.port, address.family)}\n`);
}

void main();
