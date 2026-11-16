// tests/e2e/mcp 의 시험이 함께 쓰는 도구. 제품 코드가 아니다.
// fake-entry.mjs 를 실제 프로세스로 띄우고 실제 stdio 로 붙는다. 붙는 방법은 둘이다.
//   connectSdk: MCP SDK 의 클라이언트와 stdio 전송(프로세스를 SDK 가 띄운다). 호스트가 붙는 방식과 같다.
//   connectRaw: 프로세스를 직접 띄우고 JSON-RPC 줄을 손으로 주고받는다. 종료 코드, stdout 원문, 깨진 파이프를 볼 때 쓴다.
// 모든 프로세스는 임시 HOME 과 임시 AGENT_CHAT_HOME 으로 뜬다. 실제 사용자 홈에 쓰지 않는다.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { delay, distRoot, isPidAlive } from '../../support/proc.mjs';
import { readLog } from './peer-script.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_ENTRY = path.join(HERE, 'fake-entry.mjs');
export const SDK_HOST = path.join(HERE, 'sdk-host.mjs');
export const PEER_SCRIPT = path.join(HERE, 'peer-script.mjs');

export const CHANNEL_METHOD = 'notifications/claude/channel';

const CONFIG_ENV_NAMES = [
  'AGENT_CHAT_SERVER',
  'AGENT_CHAT_NAME',
  'AGENT_CHAT_CLIENT',
  'AGENT_CHAT_ICE_SERVERS',
  'AGENT_CHAT_CHANNEL',
  'AGENT_CHAT_WAIT_MAX_SEC',
  'AGENT_CHAT_LOG_LEVEL',
];

/** 시험 하나가 쓰는 임시 폴더 묶음. 끝나면 cleanup() 으로 지운다. */
export function createSandbox(label = 'mcp') {
  const root = mkdtempSync(path.join(tmpdir(), `agent-chat-w5-${label}-`));
  const home = path.join(root, 'agent-chat-home');
  const control = path.join(root, 'control');
  return {
    root,
    home,
    control,
    /** 자식 프로세스에 줄 환경. 실제 홈을 가리키는 값을 임시 폴더로 바꾼다. */
    env(extra = {}) {
      // 시험을 돌리는 사람의 AGENT_CHAT_* 설정이 자식에게 새지 않게 먼저 지운다(undefined 는 "지운다"는 뜻이다).
      const cleared = Object.fromEntries(CONFIG_ENV_NAMES.map((name) => [name, undefined]));
      return { ...cleared, HOME: path.join(root, 'home'), AGENT_CHAT_HOME: home, AGENT_CHAT_DIST: distRoot(), ...extra };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function entryArgs(sandbox, args = []) {
  return [FAKE_ENTRY, '--control', sandbox.control, ...args];
}

function parseReply(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content[0]?.text ?? '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json, blocks: content.length, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 조건이 참이 될 때까지 기다린다. 기한을 넘기면 던진다. 고정 대기를 쓰지 않으려는 것이다. */
export async function waitFor(check, { timeoutMs = 5000, pollMs = 10, what = '조건' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 안에 ${what} 이(가) 채워지지 않았다`);
    await delay(pollMs);
  }
}

/** 그 pid 가 사라질 때까지 걸린 시간(ms). 기한을 넘기면 던진다. */
export async function waitGone(pid, { timeoutMs = 3000 } = {}) {
  const startedAt = Date.now();
  await waitFor(() => !isPidAlive(pid), { timeoutMs, pollMs: 2, what: `pid ${pid} 종료` });
  return Date.now() - startedAt;
}

/**
 * MCP SDK 클라이언트로 fake-entry 를 띄워 붙인다.
 * @param {object} options
 * @param {ReturnType<typeof createSandbox>} options.sandbox
 * @param {ReturnType<import('../../support/proc.mjs').createProcTracker>} options.tracker
 * @param {Record<string, string>} [options.env] AGENT_CHAT_* 환경 변수.
 * @param {string[]} [options.args] fake-entry 의 인자.
 */
export async function connectSdk({ sandbox, tracker, env = {}, args = [] }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: entryArgs(sandbox, args),
    env: sandbox.env(env),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'w5-e2e-host', version: '1.2.3' }, { capabilities: {} });
  const channel = [];
  const otherNotifications = [];
  /** SDK 는 stdout 의 JSON 이 아닌 줄마다 onerror 를 부른다. 비어 있어야 stdout 이 깨끗한 것이다. */
  const errors = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === CHANNEL_METHOD) channel.push(notification.params);
    else otherNotifications.push(notification.method);
  };
  client.onerror = (error) => errors.push(String(error?.message ?? error));
  await client.connect(transport);
  const pid = transport.pid;
  tracker.trackPid(pid, 'fake-entry');

  const server = {
    client,
    transport,
    pid,
    channel,
    otherNotifications,
    errors,
    stderr: () => stderr,
    log: () => readLog(sandbox.control),
    async call(name, toolArgs = {}, options = {}) {
      return parseReply(await client.callTool({ name, arguments: toolArgs }, undefined, options));
    },
    probes: () => channel.filter((item) => item.meta?.kind === 'probe'),
    channelEvents: () => channel.filter((item) => item.meta?.kind !== 'probe'),
    /** 가장 최근 점검 알림의 토큰. 올 때까지 기다린다. */
    async probeToken({ after = 0 } = {}) {
      await waitFor(() => server.probes().length > after, { what: '점검 알림' });
      return server.probes().at(-1).meta.token;
    },
    /** 연결을 닫고(stdin 종료) 프로세스가 사라질 때까지 걸린 시간을 돌려준다. */
    async close() {
      const startedAt = Date.now();
      await client.close();
      await waitGone(pid);
      return Date.now() - startedAt;
    },
  };
  return server;
}

/**
 * fake-entry 를 직접 띄우고 JSON-RPC 줄을 손으로 주고받는다.
 * @returns 프로세스 손잡이(proc.mjs)와 요청 도구.
 */
export async function connectRaw({ sandbox, tracker, env = {}, args = [], initialize = true }) {
  const proc = tracker.spawnNode(FAKE_ENTRY, ['--control', sandbox.control, ...args], { name: 'fake-entry', env: sandbox.env(env) });
  let nextId = 1;
  let consumed = 0;
  const messages = [];
  /** stdout 에 나온 줄 가운데 JSON 이 아니었던 것. */
  const badLines = [];

  function readMessages() {
    const text = proc.stdout();
    for (;;) {
      const end = text.indexOf('\n', consumed);
      if (end < 0) break;
      const line = text.slice(consumed, end);
      consumed = end + 1;
      if (line === '') continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        badLines.push(line);
      }
    }
    return messages;
  }

  const raw = {
    proc,
    pid: proc.pid,
    messages: readMessages,
    badLines: () => {
      readMessages();
      return badLines;
    },
    log: () => readLog(sandbox.control),
    send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async request(method, params, { timeoutMs = 5000 } = {}) {
      const id = nextId;
      nextId += 1;
      raw.send({ jsonrpc: '2.0', id, method, params });
      return waitFor(() => readMessages().find((message) => message.id === id), { timeoutMs, what: `${method} 응답` });
    },
    /** 응답을 기다리지 않는 요청. id 를 돌려준다. */
    post(method, params) {
      const id = nextId;
      nextId += 1;
      raw.send({ jsonrpc: '2.0', id, method, params });
      return id;
    },
    async call(name, toolArgs = {}, options = {}) {
      const response = await raw.request('tools/call', { name, arguments: toolArgs }, options);
      return parseReply(response.result ?? {});
    },
    notifications: () => readMessages().filter((message) => message.method !== undefined && message.id === undefined),
    async probeToken() {
      const probe = await waitFor(
        () => raw.notifications().filter((message) => message.method === CHANNEL_METHOD && message.params?.meta?.kind === 'probe').at(-1),
        { what: '점검 알림' },
      );
      return probe.params.meta.token;
    },
  };

  if (initialize) {
    const response = await raw.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'w5-raw-host', version: '0.0.1' },
    });
    raw.initializeResult = response.result;
    raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  return raw;
}

/** 진단 사건 가운데 그 이름의 것. */
export function logged(entries, event) {
  return entries.filter((entry) => entry.event === event);
}
