// 전 구간 시나리오(V-L2~V-L9)가 함께 쓰는 도구. 제품 코드가 아니다. src 는 이 파일을 import 하지 않는다.
// 조립한 MCP 진입점(dist/entry/mcp.js)을 실제 프로세스로 띄우고, MCP SDK 클라이언트로 실제 stdio 를 붙여 tool 로 조종한다.
//
// ── 쓰는 법 (시나리오 스크립트 안에서) ───────────────────────────────────────
//
//   import { startStack, scenarioOptions, newRoomId, until } from './harness.mjs';
//
//   const options = scenarioOptions();                   // --server <주소>, --ice <값>, --keep-home
//   const stack = await startStack({ label: 'v-l2', proxy: true, ...options });
//   const room = newRoomId();
//   const anna = await stack.agent('anna');             // MCP 프로세스를 띄우고 SDK 클라이언트로 붙는다(아직 방에 없다)
//   const created = await anna.ok('create_room', { room_id: room });   // 실패면 던진다. 결과 JSON
//   anna.pump();                                         // wait_for_messages 를 계속 불러 사건을 모은다
//   await bert.event((e) => e.kind === 'chat');          // 모은 사건에서 찾는다(기한 있음)
//   stack.relayCount()                                   // 자체 호스팅 서버가 남긴 relay{outcome: ok} 줄 수
//   await stack.close();                                 // 남은 프로세스가 있으면 던진다. 임시 폴더를 지운다
//
// 서버: 기본은 자체 호스팅 서버를 빈 포트로 띄운다(dist/entry/server.js). `--server <주소>` 를 주면 그 서버를 쓴다.
//   공용 서버 기본값(wss://agent-chat.tools.camp)을 주면 AGENT_CHAT_SERVER 도 server 인자도 넣지 않는다.
//   tool 이 인자 없이 공용 서버로 가는 제품의 길 그대로다(V-P2 는 V-L2 를 이렇게 다시 돈다).
//   그때는 서버 로그와 프록시가 없다. 그것에 기대는 확인은 "미실행"으로 출력한다.
// ICE: 기본은 제품 기본값(AGENT_CHAT_ICE_SERVERS 를 넣지 않는다 → 공개 STUN). `--ice none` 이면 host 후보만 쓴다.
//
// 모든 MCP 프로세스는 임시 HOME 과 임시 AGENT_CHAT_HOME 으로 뜬다. 실제 사용자 홈(~/.agent-chat, ~/.claude*, ~/.codex)을 쓰지 않는다.
// 임시 폴더는 os.tmpdir() 아래에 만든다. 실행할 때 TMPDIR 로 위치를 정한다.
// 빌드 결과는 <저장소>/dist 에서 읽는다. 다른 폴더면 AGENT_CHAT_DIST 로 준다(tests/support/proc.mjs).
// 출력에 방 ID 원문, 채팅 본문, SDP, candidate 를 남기지 않는다.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { createProcTracker, delay, distPath, isPidAlive } from '../../support/proc.mjs';
import { startSignalProxy } from '../../support/signal-proxy.mjs';

export { delay, isPidAlive };

export const PUBLIC_SERVER = 'wss://agent-chat.tools.camp';
export const CHANNEL_METHOD = 'notifications/claude/channel';
const MCP_ENTRY = () => distPath('entry', 'mcp.js');

/** 부모의 설정이 자식에게 새지 않게 지울 변수(undefined 는 "지운다"는 뜻이다. proc.mjs). */
const CLEARED_ENV = Object.fromEntries(
  [
    'AGENT_CHAT_SERVER',
    'AGENT_CHAT_NAME',
    'AGENT_CHAT_CLIENT',
    'AGENT_CHAT_ICE_SERVERS',
    'AGENT_CHAT_CHANNEL',
    'AGENT_CHAT_WAIT_MAX_SEC',
    'AGENT_CHAT_HOME',
    'AGENT_CHAT_LOG_LEVEL',
  ].map((name) => [name, undefined]),
);

const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 무작위 방 ID(16자). 기록과 출력에 남기지 않는다. */
export function newRoomId() {
  let text = '';
  while (text.length < 16) {
    for (const byte of randomBytes(32)) {
      if (byte >= 252) continue;
      text += ALNUM[byte % 36];
      if (text.length === 16) break;
    }
  }
  return text;
}

/** 서버 로그의 peer_ref 와 견줄 값(SHA-256 앞 12자리). */
export function refOf(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** 조건이 참이 될 때까지 기다린다. 기한을 넘기면 던진다. 조건이 돌려준 참인 값을 돌려준다. */
export async function until(condition, what, timeoutMs = 10_000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`);
    await delay(pollMs);
  }
}

/** 시나리오 공통 인자. --server <주소>, --ice <값>, --keep-home. */
export function scenarioOptions(argv = process.argv.slice(2)) {
  const options = { server: null, ice: undefined, keepHome: false, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--server') options.server = argv[++i];
    else if (arg === '--ice') options.ice = argv[++i];
    else if (arg === '--keep-home') options.keepHome = true;
    else options.rest.push(arg);
  }
  return options;
}

/** 인자 이름의 값(시나리오 전용 인자를 읽을 때). */
export function argValue(rest, name, fallback) {
  const index = rest.indexOf(`--${name}`);
  return index < 0 ? fallback : rest[index + 1];
}

// ── 확인 기록 ───────────────────────────────────────────────────────────────

/**
 * 확인 하나하나를 [판정] 줄로 출력하고 모은다. 마지막 summary() 가 통과·실패·미실행 수를 낸다.
 * 실패는 바로 던지지 않는다. 시나리오가 다음 확인으로 갈 수 있으면 간다.
 */
export function createReport(title) {
  const items = [];
  const startedAt = Date.now();
  process.stdout.write(`\n=== ${title} ===\n`);
  const add = (verdict, id, text, detail) => {
    items.push({ verdict, id, text, detail });
    const tail = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    process.stdout.write(`[${verdict}] ${id} ${text}${tail}\n`);
  };
  return {
    items,
    pass: (id, text, detail) => add('통과', id, text, detail),
    fail: (id, text, detail) => add('실패', id, text, detail),
    partial: (id, text, detail) => add('부분', id, text, detail),
    skip: (id, text, detail) => add('미실행', id, text, detail),
    /** 조건이 참이면 통과, 아니면 실패. */
    check(id, ok, text, detail) {
      (ok ? this.pass : this.fail)(id, text, detail);
      return ok;
    },
    note: (text) => process.stdout.write(`  · ${text}\n`),
    summary() {
      const count = (verdict) => items.filter((item) => item.verdict === verdict).length;
      const result = { pass: count('통과'), fail: count('실패'), partial: count('부분'), skipped: count('미실행'), seconds: Math.round((Date.now() - startedAt) / 100) / 10 };
      process.stdout.write(`=== 요약 ${title}: 통과 ${result.pass}, 실패 ${result.fail}, 부분 ${result.partial}, 미실행 ${result.skipped} (${result.seconds}초) ===\n`);
      return result;
    },
  };
}

// ── MCP 프로세스와 stdio 전송 ───────────────────────────────────────────────

/**
 * proc.mjs 로 띄운 프로세스의 stdio 를 SDK 의 Transport 로 쓴다.
 * SDK 의 StdioClientTransport 대신 이것을 쓰는 이유: 종료 코드와 종료 시각, stdout 의 JSON 이 아닌 줄, 프로세스 그룹을 직접 본다.
 */
class ProcTransport {
  constructor(proc) {
    this.proc = proc;
    this.buffer = new ReadBuffer();
    /** stdout 에 나온 JSON-RPC 가 아닌 줄의 수. 0 이어야 stdout 이 깨끗한 것이다. */
    this.badLines = 0;
    this.closed = false;
  }

  async start() {
    this.proc.child.stdout.on('data', (chunk) => {
      this.buffer.append(Buffer.from(chunk, 'utf8'));
      for (;;) {
        let message;
        try {
          message = this.buffer.readMessage();
        } catch (error) {
          this.badLines += 1;
          this.onerror?.(error);
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.proc.child.once('close', () => {
      this.closed = true;
      this.onclose?.();
    });
  }

  async send(message) {
    if (this.closed) throw new Error('프로세스가 끝났다');
    this.proc.stdin.write(serializeMessage(message));
  }

  async close() {
    try {
      this.proc.stdin.end();
    } catch {
      // 이미 닫혔다.
    }
  }
}

function parseReply(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content[0]?.text ?? '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result?.isError === true, text, json, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 오류 결과를 짧게(코드와 단계·사유만). 본문은 싣지 않는다. */
export function errorSummary(reply) {
  if (!reply.isError) return 'ok';
  const error = reply.json?.error;
  if (error === undefined) return reply.text.slice(0, 120);
  const peers = error.details?.peers?.map((peer) => `${peer.name}:${peer.stage}/${peer.reason}`).join(',');
  return `${error.code}${error.details?.server_code ? `/${error.details.server_code}` : ''}${peers ? ` [${peers}]` : ''}`;
}

/**
 * MCP 프로세스 하나를 띄우고 SDK 클라이언트로 붙인다.
 * @param {object} options
 * @param {ReturnType<typeof createProcTracker>} options.tracker
 * @param {string} options.name 참가자 이름(AGENT_CHAT_NAME)
 * @param {string} options.home 이 프로세스의 AGENT_CHAT_HOME
 * @param {Record<string, string|undefined>} options.env 더 넣을 환경 변수
 */
export async function spawnAgent({ tracker, name, home, homeRoot, env = {}, label = name, connect = true }) {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch {
    // 쓸 수 없는 AGENT_CHAT_HOME 을 일부러 줄 때다(V-L7 나). 프로세스는 그래도 떠야 한다.
  }
  const proc = tracker.spawnNode(MCP_ENTRY(), [], {
    name: `mcp-${label}`,
    env: { ...CLEARED_ENV, HOME: path.join(homeRoot, 'home'), AGENT_CHAT_HOME: home, ...env },
  });
  const transport = new ProcTransport(proc);
  const client = new Client({ name: 'w9-e2e-host', version: '9.9.9' }, { capabilities: {} });
  const channel = [];
  const otherNotifications = [];
  const clientErrors = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === CHANNEL_METHOD) channel.push({ ...notification.params, seenAt: Date.now() });
    else otherNotifications.push(notification.method);
  };
  client.onerror = (error) => clientErrors.push(String(error?.name ?? 'Error'));
  if (connect) await client.connect(transport);
  return wrapAgent({ proc, transport, client, channel, otherNotifications, clientErrors, name, home });
}

/** 그 AGENT_CHAT_HOME 의 진단 로그(diag-*.jsonl) 줄 전부. */
export function readDiagLogs(home) {
  const dir = path.join(home, 'logs');
  if (!existsSync(dir)) return [];
  const lines = [];
  for (const file of readdirSync(dir).filter((entry) => entry.startsWith('diag-') && entry.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line === '') continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // 쓰는 중인 줄이다.
      }
    }
  }
  return lines;
}

function wrapAgent({ proc, transport, client, channel, otherNotifications, clientErrors, name, home }) {
  /** pump 가 모은 사건. seenAt 은 이 시험 프로세스가 받은 시각이다. */
  const events = [];
  const waiters = new Set();
  let cursor = null;
  let pumping = null;

  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  proc.child.once('exit', notify);

  const agent = {
    name,
    home,
    proc,
    pid: proc.pid,
    client,
    transport,
    channel,
    otherNotifications,
    clientErrors,
    events,
    get cursor() {
      return cursor;
    },

    /** tool 을 부른다. {isError, json, text, bytes}. */
    async call(tool, args = {}, { timeoutMs = 60_000, signal } = {}) {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs, signal });
      return parseReply(result);
    },

    /** tool 을 부르고 실패면 던진다. 성공 결과의 JSON 을 돌려준다. */
    async ok(tool, args = {}, options = {}) {
      const reply = await agent.call(tool, args, options);
      if (reply.isError) throw new Error(`${name}.${tool} 실패: ${errorSummary(reply)}`);
      return reply.json;
    },

    status: () => agent.ok('get_status'),

    /** 그 참가자의 get_status 행. */
    async participant(other) {
      const status = await agent.status();
      return status.participants.find((entry) => entry.name === other) ?? null;
    },

    /**
     * wait_for_messages 를 계속 불러 사건을 모은다. 커서를 이어 넘긴다.
     * 방에 없으면(NOT_IN_ROOM) 잠깐 쉬고 다시 부른다. stopPump() 로 멈춘다(걸린 호출은 취소한다).
     */
    pump({ timeoutSec = 5 } = {}) {
      if (pumping !== null) return;
      const controller = new AbortController();
      const state = { controller, done: null };
      pumping = state;
      state.done = (async () => {
        while (pumping === state && proc.exit === null) {
          let reply;
          try {
            reply = await agent.call('wait_for_messages', { timeout_sec: timeoutSec, ...(cursor === null ? {} : { cursor }) }, {
              timeoutMs: (timeoutSec + 30) * 1000,
              signal: controller.signal,
            });
          } catch {
            if (pumping !== state) break;
            await delay(200);
            continue;
          }
          if (reply.isError || reply.json === null) {
            await delay(200);
            continue;
          }
          if (Array.isArray(reply.json.events)) {
            for (const event of reply.json.events) events.push({ ...event, seenAt: Date.now() });
          }
          if (typeof reply.json.next_cursor === 'string') cursor = reply.json.next_cursor;
          notify();
        }
      })();
    },

    async stopPump() {
      const state = pumping;
      if (state === null) return;
      pumping = null;
      state.controller.abort();
      await state.done;
    },

    /** 모은 사건에서 조건에 맞는 것을 찾는다. 없으면 나올 때까지 기다린다. from 번째부터 본다. */
    event(match, { timeoutMs = 20_000, what = '사건', from = 0 } = {}) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const finish = (settle, value) => {
          waiters.delete(check);
          if (timer !== null) clearTimeout(timer);
          settle(value);
        };
        const check = () => {
          const found = events.slice(from).find(match);
          if (found !== undefined) finish(resolve, found);
          else if (proc.exit !== null) finish(reject, new Error(`${name}: ${what} 이(가) 나오기 전에 프로세스가 끝났다`));
        };
        waiters.add(check);
        timer = setTimeout(() => finish(reject, new Error(`${name}: ${timeoutMs}ms 안에 ${what} 이(가) 나오지 않았다`)), timeoutMs);
        check();
      });
    },

    /** 진단 로그(파일)의 줄. 이름을 주면 그 사건만. */
    logs: (event) => {
      const lines = readDiagLogs(home);
      return event === undefined ? lines : lines.filter((line) => line.event === event);
    },

    alive: () => proc.exit === null && isPidAlive(proc.pid),

    /** 연결을 닫는다(stdin 종료). 프로세스가 끝날 때까지 걸린 시간과 종료 결과를 돌려준다. */
    async close({ timeoutMs = 5_000 } = {}) {
      await agent.stopPump();
      if (proc.exit !== null) return { ms: 0, exit: proc.exit };
      const startedAt = Date.now();
      await client.close().catch(() => {});
      const exit = await proc.waitForExit({ timeoutMs });
      return { ms: Date.now() - startedAt, exit };
    },

    /** 신호를 보내고 끝나기를 기다린다. stopMs 는 신호를 보낸 뒤 프로세스가 죽을 때까지다. */
    async stop(signal = 'SIGTERM', { timeoutMs = 5_000 } = {}) {
      const state = pumping;
      pumping = null;
      state?.controller.abort();
      return proc.stop({ signal, timeoutMs });
    },

    /** bye 도 leave 도 없이 죽인다. */
    async kill() {
      pumping = null;
      proc.killTree('SIGKILL');
      await proc.waitForExit({ timeoutMs: 5_000 }).catch(() => {});
    },

    /** SIGSTOP / SIGCONT. */
    pause: () => process.kill(proc.pid, 'SIGSTOP'),
    resume: () => process.kill(proc.pid, 'SIGCONT'),
  };
  return agent;
}

// ── 서버와 스택 ─────────────────────────────────────────────────────────────

/** 자체 호스팅 서버를 띄운다. stdout 의 JSONL 로그를 줄마다 세어 둔다. */
async function startServer(procs, { port = 0, maxConnectionsPerIp = 200 } = {}) {
  const proc = procs.spawnDist('entry/server.js', ['--host', '127.0.0.1', '--port', String(port), '--max-connections-per-ip', String(maxConnectionsPerIp)], {
    name: 'server',
    stdin: 'ignore',
  });
  const counts = new Map();
  /** 등록과 해제의 기록(conn.join, conn.closed). 참가자 이름은 서버 로그에 peer_ref(SHA-256 앞 12자리)로만 있다. */
  const registrations = [];
  let buffer = '';
  proc.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      try {
        const value = JSON.parse(line);
        const key = `${value.event}|${value.outcome ?? ''}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if ((value.event === 'conn.join' || value.event === 'conn.closed') && typeof value.peer_ref === 'string') {
          registrations.push({ at: Date.now(), event: value.event, outcome: value.outcome, peer_ref: value.peer_ref, reason: value.reason });
        }
      } catch {
        // 로그가 아닌 줄이다.
      }
    }
  });
  const ready = await proc.waitForOutput(/listening on (ws:\/\/\S+)/, { timeoutMs: 10_000 });
  return { proc, url: ready[1], count: (event, outcome = '') => counts.get(`${event}|${outcome}`) ?? 0, counts, registrations };
}

/**
 * 서버(또는 주어진 주소), 프록시(선택), 임시 폴더를 준비한다.
 * @param {object} options
 * @param {string} options.label
 * @param {string|null} [options.server] 주어지면 그 서버를 쓴다(서버를 띄우지 않는다).
 * @param {boolean} [options.proxy] 시험용 프록시를 세운다(자체 호스팅에서만).
 * @param {string} [options.ice] AGENT_CHAT_ICE_SERVERS. 생략하면 넣지 않는다(제품 기본값).
 * @param {boolean} [options.keepHome]
 */
export async function startStack(options) {
  const label = options.label ?? 'scenario';
  const procs = createProcTracker({ label });
  const homeRoot = mkdtempSync(path.join(os.tmpdir(), `agent-chat-${label}-`));
  const external = options.server !== null && options.server !== undefined;
  const publicDefault = external && options.server.replace(/\/+$/, '') === PUBLIC_SERVER;
  let server = null;
  let proxy = null;
  const agents = [];
  const removeHome = () => {
    if (!options.keepHome) rmSync(homeRoot, { recursive: true, force: true });
  };
  try {
    if (!external) {
      server = await startServer(procs, { maxConnectionsPerIp: options.maxConnectionsPerIp ?? 200 });
      if (options.proxy) proxy = await startSignalProxy({ upstream: server.url });
    }
    const url = external ? options.server : proxy !== null ? proxy.url : server.url;

    const stack = {
      procs,
      homeRoot,
      external,
      /** 자체 호스팅이면 참. 서버 로그·프록시에 기대는 확인은 이것이 참일 때만 한다. */
      selfHosted: !external,
      get server() {
        return server;
      },
      proxy,
      /** 참가자에게 주는 주소. 공용 서버 기본값이면 null(server 인자도 환경 변수도 넣지 않는다). */
      url: publicDefault ? null : url,
      agents,

      /** 그 이름의 임시 AGENT_CHAT_HOME. */
      home: (name) => path.join(homeRoot, 'agents', name),

      /**
       * MCP 프로세스를 띄운다. 아직 방에 없다.
       * @param {string} name 참가자 이름(AGENT_CHAT_NAME)
       * @param {object} [opts] env: 더 넣을 환경 변수, label: 프로세스 이름(같은 이름을 두 번 띄울 때), home
       */
      async agent(name, opts = {}) {
        const env = {
          AGENT_CHAT_NAME: name,
          AGENT_CHAT_CLIENT: 'e2e',
          AGENT_CHAT_WAIT_MAX_SEC: '10',
          AGENT_CHAT_LOG_LEVEL: 'debug',
          ...(stack.url === null ? {} : { AGENT_CHAT_SERVER: stack.url }),
          ...(options.ice === undefined ? {} : { AGENT_CHAT_ICE_SERVERS: options.ice }),
          ...opts.env,
        };
        const agent = await spawnAgent({
          tracker: procs,
          name,
          label: opts.label ?? name,
          home: opts.home ?? stack.home(opts.label ?? name),
          homeRoot,
          env,
          connect: opts.connect ?? true,
        });
        agents.push(agent);
        return agent;
      },

      /** 서버가 남긴 relay{outcome: ok} 줄 수(서버가 전달한 시그널 수). 자체 호스팅에서만. */
      relayCount: () => (server === null ? null : server.count('relay', 'ok')),

      /**
       * 서버 로그로 본, 그 이름의 등록이 지금 서버에 있는가(마지막 conn.join{joined} 뒤에 conn.closed{removed} 가 없으면 참).
       * 자체 호스팅에서만. 서버를 다시 띄우면 새 서버의 기록만 본다. 이름이 겹치지 않는 시나리오에서 쓴다.
       */
      /** 그 이름의 등록·해제 기록(서버 로그). {at, event, outcome, reason}. 자체 호스팅에서만. */
      registrationEvents(name) {
        if (server === null) return null;
        const ref = refOf(name);
        return server.registrations.filter((entry) => entry.peer_ref === ref);
      },

      registered(name) {
        if (server === null) return null;
        const ref = refOf(name);
        let present = false;
        for (const entry of server.registrations) {
          if (entry.peer_ref !== ref) continue;
          if (entry.event === 'conn.join' && entry.outcome === 'joined') present = true;
          if (entry.event === 'conn.closed' && entry.outcome === 'removed') present = false;
        }
        return present;
      },
      serverCount: (event, outcome) => (server === null ? null : server.count(event, outcome)),

      /** 자체 호스팅 서버를 같은 포트로 다시 띄운다. 멈춘 동안의 시간을 downMs 로 줄 수 있다. */
      async restartServer({ downMs = 0 } = {}) {
        if (server === null) throw new Error('자체 호스팅이 아니다');
        const port = Number(new URL(server.url).port);
        const stopped = await server.proc.stop({ signal: 'SIGTERM', timeoutMs: 6_000 });
        if (downMs > 0) await delay(downMs);
        server = await startServer(procs, { port, maxConnectionsPerIp: options.maxConnectionsPerIp ?? 200 });
        return stopped;
      },

      /** 서버 프로세스를 멈춘다(SIGSTOP)·잇는다(SIGCONT). */
      pauseServer: () => process.kill(server.proc.pid, 'SIGSTOP'),
      resumeServer: () => process.kill(server.proc.pid, 'SIGCONT'),

      /** 참가자를 모두 닫고, 프록시와 서버를 닫고, 띄운 프로세스가 남지 않았는지 확인한다. 남아 있으면 지운 뒤 던진다. */
      async close() {
        for (const agent of agents) {
          if (agent.proc.exit === null) {
            try {
              await agent.close();
            } catch {
              await agent.kill();
            }
          }
        }
        if (proxy !== null) await proxy.close();
        let serverExit = null;
        if (server !== null) serverExit = await server.proc.stop({ signal: 'SIGTERM', timeoutMs: 5_000 });
        let leftover = null;
        try {
          await procs.assertNoneLeft({ graceMs: 3_000 });
        } catch (error) {
          leftover = error;
        }
        const killed = await procs.dispose();
        removeHome();
        if (leftover !== null) throw leftover;
        if (killed.length > 0) throw new Error(`정리하면서 죽여야 했던 프로세스: ${killed.map((entry) => entry.name).join(', ')}`);
        return { serverExit };
      },

      /** 실패했을 때의 정리. 남은 프로세스를 모두 지운다. */
      async abort() {
        if (proxy !== null) await proxy.close().catch(() => {});
        const killed = await procs.dispose();
        removeHome();
        return killed;
      },
    };
    return stack;
  } catch (error) {
    if (proxy !== null) await proxy.close().catch(() => {});
    await procs.dispose();
    removeHome();
    throw error;
  }
}

/** 방 생성·입장 인자. 서버 주소는 환경 변수(AGENT_CHAT_SERVER)로 이미 준다. */
export function roomArgs(room, extra = {}) {
  return { room_id: room, ...extra };
}

/** 여러 참가자를 차례로 입장시킨다(첫 참가자가 만든다). 각자 pump 를 건다. */
export async function enterAll(agents, room) {
  const results = [];
  for (const [index, agent] of agents.entries()) {
    const tool = index === 0 ? 'create_room' : 'join_room';
    results.push(await agent.ok(tool, roomArgs(room)));
    agent.pump();
  }
  return results;
}

/** 시나리오 스크립트의 마무리. 요약을 내고 실패가 있으면 종료 코드 1. */
export async function finish(report, stack, error) {
  if (error !== undefined && error !== null) {
    report.fail('ABORT', '시나리오가 중간에 멈췄다', String(error?.stack ?? error).split('\n').slice(0, 6).join(' | '));
  }
  if (stack !== null && stack !== undefined) {
    try {
      if (error !== undefined && error !== null) {
        const killed = await stack.abort();
        if (killed.length > 0) report.note(`실패 뒤 정리로 지운 프로세스 ${killed.length}개`);
      } else {
        await stack.close();
        report.pass('PROC', '띄운 프로세스가 남지 않았다');
      }
    } catch (closeError) {
      report.fail('PROC', '띄운 프로세스가 남지 않았다', String(closeError?.message ?? closeError).slice(0, 300));
    }
  }
  const result = report.summary();
  process.exitCode = result.fail > 0 ? 1 : 0;
  return result;
}
