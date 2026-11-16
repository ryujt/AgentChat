#!/usr/bin/env node
// 시험 진입점: 제품의 mcp-server 와 inbox 에 가짜 세션(fake-session.mjs)을 붙여 stdio MCP 서버로 띄운다.
// 제품 진입점이 아니다(제품은 dist/entry/mcp.js). 방 기능이 없다. 시그널링에 접속하지 않고 WebRTC 를 열지 않는다.
// 되는 것: 초기화 응답, tool 표면, "점검 알림 → confirm_channel → 시험 사건 전달", 대기와 커서, stdio 수명.
//
// 쓰는 곳:
//   - V-L7(가): v-l7a.test.mjs 가 MCP SDK 클라이언트로 stdio 를 붙인다.
//   - 최소판: 실제 호스트(Claude Code)에 `agent-chat` 이름으로 잠시 등록해 A-MCP-1·2·9 를 본다(README.md).
//
// 인자:
//   --control <폴더>          조종 폴더. 그 안의 in/*.json 을 읽어 "다른 참가자"의 사건을 넣고(peer-script.mjs 가 쓴다),
//                              log.jsonl(진단 사건)과 sent.jsonl(에이전트가 보낸 글)을 남긴다. 생략하면 <AGENT_CHAT_HOME>/fake-control.
//   --inbox-limits <JSON>     수신함 상한을 덮어쓴다. 예: {"CHANNEL_SEEN_GRACE_MS":1500}
//   --echo-ms <ms>            send_message 마다 그 시간 뒤에 가짜 참가자가 "echo: …" 로 답한다.
//   --shutdown-delay-ms <ms>  가짜 세션의 종료가 걸리는 시간.
//   --shutdown-hang           가짜 세션의 종료가 끝나지 않는다(종료 예산 초과를 만든다).
//   --poll-ms <ms>            조종 폴더를 읽는 주기. 기본 50.
//
// 빌드 결과는 tests/support/proc.mjs 의 규칙대로 찾는다(환경 변수 AGENT_CHAT_DIST, 기본 <저장소>/dist).
// stdout 에는 아무 것도 쓰지 않는다. MCP 메시지만 나가야 한다.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { distUrl } from '../../support/proc.mjs';
import { createFakeSession } from './fake-session.mjs';

const { createInbox, DEFAULT_INBOX_LIMITS } = await import(distUrl('inbox/index.js'));
const { loadConfig, startMcpServer, DEFAULT_MCP_SERVER_LIMITS } = await import(distUrl('mcp-server/index.js'));

function parseArgs(argv) {
  const options = { control: null, inboxLimits: {}, echoMs: null, shutdownDelayMs: 0, shutdownHang: false, pollMs: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} 에 값이 없다`);
      return argv[i];
    };
    if (arg === '--control') options.control = path.resolve(value());
    else if (arg === '--inbox-limits') options.inboxLimits = JSON.parse(value());
    else if (arg === '--echo-ms') options.echoMs = Number(value());
    else if (arg === '--shutdown-delay-ms') options.shutdownDelayMs = Number(value());
    else if (arg === '--shutdown-hang') options.shutdownHang = true;
    else if (arg === '--poll-ms') options.pollMs = Number(value());
    else throw new Error(`모르는 인자: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
// 환경 변수는 제품과 같이 통째로 loadConfig 에 넘긴다. 이 파일은 값을 직접 읽지 않는다.
const { config, problems } = loadConfig(process.env);
const controlDir = options.control ?? path.join(config.session.home, 'fake-control');
const inDir = path.join(controlDir, 'in');
const logFile = path.join(controlDir, 'log.jsonl');
const sentFile = path.join(controlDir, 'sent.jsonl');

let fileOk = true;
try {
  mkdirSync(inDir, { recursive: true, mode: 0o700 });
} catch {
  fileOk = false;
}

function appendLine(file, value) {
  if (!fileOk) return;
  try {
    appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // 조종 폴더에 못 써도 서버는 돈다. 제품과 같이 "잘못된 설정으로도 뜬다".
    fileOk = false;
  }
}

const LEVELS = ['debug', 'info', 'warn', 'error'];
const minLevel = LEVELS.indexOf(config.logLevel);
/** 시험용 로그 포트. 제품의 diagnostics 가 아니다. 줄마다 바로 쓴다(종료 직전의 사건을 잃지 않으려는 것). */
const log = {
  event(level, module, event, fields) {
    if (LEVELS.indexOf(level) < minLevel) return;
    appendLine(logFile, { ts: new Date().toISOString(), level, pid: process.pid, mod: module, event, ...fields });
  },
};

const now = () => Date.now();
const timers = { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle) };

// 제품 조립(src/entry/mcp.ts)과 같게 cursor 를 프로세스 시작 시각(ms) 다음부터 센다(검토 2차 PRODUCT-R2-01).
const inbox = createInbox({ limits: { ...DEFAULT_INBOX_LIMITS, ...options.inboxLimits }, now, timers, log, cursorBase: now() });
const session = createFakeSession({
  inbox,
  config: config.session,
  now,
  timers,
  log,
  options: {
    shutdownDelayMs: options.shutdownDelayMs,
    shutdownHang: options.shutdownHang,
    echoDelayMs: options.echoMs ?? undefined,
    onSent: (entry) => appendLine(sentFile, entry),
  },
});

// "다른 참가자"의 사건은 조종 폴더로 들어온다. 이름 순서대로 읽고 지운다.
function drainControl() {
  let names;
  try {
    names = readdirSync(inDir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(inDir, name);
    let outcome = 'bad_file';
    try {
      const op = JSON.parse(readFileSync(file, 'utf8'));
      outcome = session.inject(op) ? 'ok' : 'ignored';
      log.event('info', 'entry', 'control.op', { kind: String(op.op), outcome });
    } catch {
      log.event('warn', 'entry', 'control.op', { outcome });
    }
    rmSync(file, { force: true });
  }
}
const controlTimer = setInterval(drainControl, Math.max(10, options.pollMs));

log.event('info', 'entry', 'start', { mode: 'fake-session', name: config.session.name });

const handle = startMcpServer({
  session,
  inbox,
  config,
  problems,
  limits: DEFAULT_MCP_SERVER_LIMITS,
  app: { name: 'agent-chat', version: '0.1.0-fake-session' },
  now,
  timers,
  log,
});

const closed = await handle.closed;
clearInterval(controlTimer);
// 취소된 호출의 마무리(진단 사건 쓰기)가 끝나도록 한 틱을 준다. 제품 조립은 이 자리에서 로그를 닫는다.
await new Promise((resolve) => setImmediate(resolve));
log.event('info', 'entry', 'exit', { cause: closed.cause, forced: closed.forced, duration_ms: closed.duration_ms });
process.exit(0);
