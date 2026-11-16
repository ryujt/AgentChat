// 시험 전용: 가짜 호스트 CLI 와 가짜 MCP 서버. 제품 코드는 이 파일을 import 하지 않는다.
// 가짜 호스트 CLI 는 host-cli.ts 와 같은 허용 목록을 거친 인자만 받고, 실제 CLI 가 내는 출력 형식을 흉내 낸다.
// 가짜 MCP 서버는 프로세스를 띄우지 않고 메모리 전송으로 붙는다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LogFields, LogLevel, LogModule, LogPort } from '../diagnostics/log-port.js';
import type { Timers } from '../protocol/index.js';
import { checkHostCliArgs, type HostCli, type HostCliResult } from './host-cli.js';
import type { LaunchMcp, McpLaunchSpec } from './mcp-process.js';
import { SERVER_NAME, type HostKind } from './types.js';

export const realTimers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface LoggedEvent {
  readonly level: LogLevel;
  readonly module: LogModule;
  readonly event: string;
  readonly fields: LogFields;
}

export function createMemoryLog(): LogPort & { readonly events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return { events, event: (level, module, event, fields = {}) => void events.push({ level, module, event, fields }) };
}

// ── 가짜 호스트 CLI ─────────────────────────────────────────────────────────

interface StoredServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface FakeHostOptions {
  /** `--version` 이 내는 글. null 이면 실행 파일이 없는 것으로 답한다. */
  readonly version?: string | null;
  /** Claude Code 의 `auth status` 출력. 'fail' 이면 읽을 수 없는 출력과 종료 코드 1. */
  readonly auth?: unknown;
  /** Codex 가 등록을 쓰는 설정 파일. */
  readonly configPath?: string;
  /** Codex 가 `tool_timeout_sec` 을 출력에 싣지 않는다(고친 파일을 읽지 못한 것처럼). */
  readonly hideTimeout?: boolean;
  /** `mcp add` 가 실패한다. */
  readonly failAdd?: boolean;
  /** `mcp get` 이 등록과 다른 경로를 답한다. */
  readonly reportPath?: string;
  /**
   * Codex 의 `mcp get` 이 설정 파일의 표준 표 대신 이 등록을 답한다. 실제 CLI 가 다른 표기(인라인 표, 점 키)로 적힌 등록을
   * 읽는 것을 흉내 낸다(검토 2차 BOUNDARY-R2-01). 이 가짜는 그 표기를 고치지 못하므로, 설치가 remove/add 를 부르면 파일이 바뀐다.
   */
  readonly registeredAs?: { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };
}

export interface FakeHost extends HostCli {
  /** 실행한 인자 묶음(거절된 것은 들지 않는다). */
  readonly calls: string[][];
  /** Claude Code 의 등록. 범위별로 하나씩. */
  readonly scopes: Map<'user' | 'local' | 'project', StoredServer>;
}

function done(code: number, stdout = '', stderr = ''): HostCliResult {
  return { outcome: 'exit', code, stdout, stderr, detail: '' };
}

function parseAdd(args: readonly string[], envFlag: string): StoredServer {
  const split = args.indexOf('--');
  const env: Record<string, string> = {};
  args.slice(0, split).forEach((arg, index, all) => {
    if (arg !== envFlag) return;
    const pair = all[index + 1] ?? '';
    env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
  });
  return { command: args[split + 1] ?? '', args: args.slice(split + 2), env };
}

const CODEX_TABLE = `[mcp_servers.${SERVER_NAME}]`;
const CODEX_ENV_TABLE = `[mcp_servers.${SERVER_NAME}.env]`;

function readCodexServer(path: string): (StoredServer & { toolTimeoutSec: number | null; extra: Record<string, unknown> }) | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.indexOf(CODEX_TABLE);
  if (start < 0) return null;
  // extra: 표에 적힌 그 밖의 키(사용자가 더한 disabled_tools, startup_timeout_sec 등). 실제 CLI 처럼 get --json 에 일부만 낸다.
  const server = { command: '', args: [] as string[], env: {} as Record<string, string>, toolTimeoutSec: null as number | null, extra: {} as Record<string, unknown> };
  let inEnv = false;
  for (const line of lines.slice(start + 1)) {
    if (line === CODEX_ENV_TABLE) {
      inEnv = true;
      continue;
    }
    if (line.startsWith('[')) break;
    const match = /^([A-Za-z0-9_]+) = (.*)$/.exec(line);
    if (match === null) continue;
    const value: unknown = JSON.parse(match[2] as string);
    if (inEnv) server.env[match[1] as string] = String(value);
    else if (match[1] === 'command') server.command = String(value);
    else if (match[1] === 'args') server.args = value as string[];
    else if (match[1] === 'tool_timeout_sec') server.toolTimeoutSec = Number(value);
    else server.extra[match[1] as string] = value;
  }
  return server;
}

function removeCodexServer(path: string): void {
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.indexOf(CODEX_TABLE);
  let end = start + 1;
  while (end < lines.length && (lines[end] === CODEX_ENV_TABLE || !(lines[end] as string).startsWith('['))) end += 1;
  // 파일 끝의 줄바꿈은 남긴다. 등록하기 전의 바이트로 돌아가야 한다.
  if (end === lines.length && lines[end - 1] === '') end -= 1;
  const from = start > 0 && lines[start - 1] === '' ? start - 1 : start;
  lines.splice(from, end - from);
  writeFileSync(path, lines.join('\n'));
}

function appendCodexServer(path: string, server: StoredServer): void {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const block = [
    CODEX_TABLE,
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    '',
    CODEX_ENV_TABLE,
    ...Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    '',
  ];
  writeFileSync(path, `${before}${before === '' ? '' : '\n'}${block.join('\n')}`);
}

export function createFakeHost(host: HostKind, options: FakeHostOptions = {}): FakeHost {
  const calls: string[][] = [];
  const scopes = new Map<'user' | 'local' | 'project', StoredServer>();
  const version =
    options.version === undefined ? (host === 'claude' ? '2.1.325 (Claude Code)' : host === 'codex' ? 'codex-cli 0.169.0' : '0.66.0') : options.version;
  const absent = (): HostCliResult =>
    host === 'claude'
      ? done(1, '', `No MCP server named "${SERVER_NAME}". Configured servers: other\n`)
      : done(1, '', `Error: No MCP server named '${SERVER_NAME}' found.\n`);

  const claude = (args: readonly string[]): HostCliResult => {
    const [first, second] = args;
    if (first === 'auth') {
      return options.auth === 'fail' ? done(1, 'not json') : done(0, JSON.stringify(options.auth ?? { loggedIn: true, authMethod: 'claude.ai' }));
    }
    if (second === 'get') {
      const scope = (['local', 'project', 'user'] as const).find((candidate) => scopes.has(candidate));
      const server = scope === undefined ? undefined : scopes.get(scope);
      if (scope === undefined || server === undefined) return absent();
      const label = { user: 'User config (available in all your projects)', local: 'Local config (private to you in this project)', project: 'Project config (shared via .mcp.json)' }[scope];
      return done(
        0,
        [
          `${SERVER_NAME}:`,
          `  Scope: ${label}`,
          '  Status: ✔ Connected',
          '  Type: stdio',
          `  Command: ${server.command}`,
          `  Args: ${(options.reportPath === undefined ? server.args : [options.reportPath]).join(' ')}`,
          '  Environment:',
          ...Object.entries(server.env).map(([key, value]) => `    ${key}=${value}`),
          '',
          `To remove this server, run: claude mcp remove ${SERVER_NAME} -s ${scope}`,
          '',
        ].join('\n'),
      );
    }
    if (second === 'add') {
      if (options.failAdd === true) return done(1, '', 'add failed\n');
      if (scopes.has('user')) return done(1, '', `MCP server ${SERVER_NAME} already exists in user config\n`);
      scopes.set('user', parseAdd(args, '-e'));
      return done(0, `Added stdio MCP server ${SERVER_NAME} to user config\n`);
    }
    if (second === 'remove') {
      if (!scopes.delete('user')) return done(1, '', `No user-scoped MCP server found with name: ${SERVER_NAME}\n`);
      return done(0, `Removed MCP server ${SERVER_NAME} from user config\n`);
    }
    return done(0, 'No MCP servers configured.\n');
  };

  const codex = (args: readonly string[]): HostCliResult => {
    const path = options.configPath ?? '';
    const [, second] = args;
    if (second === 'get') {
      const listed = options.registeredAs;
      const server =
        listed === undefined
          ? readCodexServer(path)
          : { command: listed.command, args: [...listed.args], env: { ...listed.env }, toolTimeoutSec: null, extra: {} as Record<string, unknown> };
      if (server === null) return absent();
      return done(
        0,
        JSON.stringify({
          name: SERVER_NAME,
          enabled: server.extra['enabled'] ?? true,
          disabled_reason: null,
          transport: {
            type: 'stdio',
            command: server.command,
            args: options.reportPath === undefined ? server.args : [options.reportPath],
            env: server.env,
            env_vars: server.extra['env_vars'] ?? [],
            cwd: server.extra['cwd'] ?? null,
          },
          enabled_tools: server.extra['enabled_tools'] ?? null,
          disabled_tools: server.extra['disabled_tools'] ?? null,
          startup_timeout_sec: server.extra['startup_timeout_sec'] ?? null,
          // 실제 CLI 는 실수로 낸다(600.0). JSON 에서는 600 과 같다.
          tool_timeout_sec: options.hideTimeout === true ? null : server.toolTimeoutSec,
          // default_tools_approval_mode 와 도구별 approval_mode 는 실제 CLI 처럼 내지 않는다.
        }),
      );
    }
    if (second === 'add') {
      if (options.failAdd === true) return done(1, '', 'add failed\n');
      if (readCodexServer(path) !== null) removeCodexServer(path);
      appendCodexServer(path, parseAdd(args, '--env'));
      return done(0, `Added global MCP server '${SERVER_NAME}'.\n`);
    }
    if (second === 'remove') {
      if (readCodexServer(path) === null) return done(0, `No MCP server named '${SERVER_NAME}' found.\n`);
      removeCodexServer(path);
      return done(0, `Removed global MCP server '${SERVER_NAME}'.\n`);
    }
    return done(0, '[]\n');
  };

  /** Gemini CLI: 사용자 설정 파일(options.configPath)의 mcpServers 를 고친다. 같은 이름을 다시 넣으면 항목을 통째로 바꾼다(실제 0.66.0 과 같다). */
  const gemini = (args: readonly string[]): HostCliResult => {
    const path = options.configPath ?? '';
    const read = (): Record<string, unknown> => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {});
    const write = (settings: Record<string, unknown>): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(settings, null, 2));
    };
    const [, second] = args;
    if (second === 'add') {
      if (options.failAdd === true) return done(1, '', 'add failed\n');
      const env: Record<string, string> = {};
      let index = 4;
      while (args[index] === '-e') {
        const pair = args[index + 1] ?? '';
        env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
        index += 2;
      }
      const [, command, ...rest] = args.slice(index);
      const settings = read();
      const servers = { ...((settings['mcpServers'] as Record<string, unknown> | undefined) ?? {}) };
      servers[SERVER_NAME] = { command, args: rest, env };
      write({ ...settings, mcpServers: servers });
      return done(0, `MCP server "${SERVER_NAME}" added to user settings. (stdio)\n`);
    }
    if (second === 'remove') {
      const settings = read();
      const servers = { ...((settings['mcpServers'] as Record<string, unknown> | undefined) ?? {}) };
      if (!(SERVER_NAME in servers)) return done(0, `Server "${SERVER_NAME}" not found in user settings.\n`);
      delete servers[SERVER_NAME];
      write({ ...settings, mcpServers: servers });
      return done(0, `Server "${SERVER_NAME}" removed from user settings.\n`);
    }
    return done(0, 'No MCP servers configured.\n');
  };

  return {
    host,
    bin: host,
    calls,
    scopes,
    run: (args) => {
      const rejected = checkHostCliArgs(host, args);
      if (rejected !== null) return Promise.resolve({ outcome: 'rejected', code: null, stdout: '', stderr: '', detail: rejected });
      if (version === null) return Promise.resolve({ outcome: 'not-found', code: null, stdout: '', stderr: '', detail: 'executable not found' });
      calls.push([...args]);
      if (args[0] === '--version') return Promise.resolve(done(0, `${version}\n`));
      return Promise.resolve(host === 'claude' ? claude(args) : host === 'codex' ? codex(args) : gemini(args));
    },
  };
}

// ── 가짜 MCP 서버 ───────────────────────────────────────────────────────────

export interface FakeHubOptions {
  /** create_room 이 이 오류로 실패한다. */
  readonly createError?: { readonly code: string; readonly message?: string; readonly details?: unknown };
  readonly joinError?: { readonly code: string; readonly message?: string; readonly details?: unknown };
  /** send_message 가 아무에게도 전달하지 못한다. */
  readonly undelivered?: boolean;
  /** 전달했다고 답하지만 받는 쪽 수신함에 넣지 않는다. */
  readonly dropChat?: boolean;
  /** `get_status.room.net`. 기본은 둘 다 참. */
  readonly stun?: boolean;
  readonly srflxSeen?: boolean;
  /** 이 tool 을 목록에서 뺀다. */
  readonly withoutTools?: readonly string[];
  /** 닫아도 프로세스가 남은 것처럼 군다. */
  readonly staysAlive?: boolean;
  /** leave_room 이 실패한다. */
  readonly leaveError?: boolean;
}

interface ChatEvent {
  readonly cursor: string;
  readonly kind: 'chat';
  readonly from: string;
  readonly to: 'room';
  readonly text: string;
}

export interface FakeHub {
  readonly launch: LaunchMcp;
  /** 띄울 때 받은 실행 정보. */
  readonly launches: McpLaunchSpec[];
  /** 받은 tool 호출. */
  readonly toolCalls: { readonly name: string; readonly args: Record<string, unknown> }[];
  /** 강제로 끝낸 횟수. */
  readonly kills: number[];
  /** 아직 닫히지 않은 가짜 프로세스 수. */
  open(): number;
}

const TOOLS = ['create_room', 'join_room', 'leave_room', 'get_status', 'send_message', 'wait_for_messages'];

export function createFakeHub(options: FakeHubOptions = {}): FakeHub {
  const launches: McpLaunchSpec[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const kills: number[] = [];
  const rooms = new Map<string, Map<string, ChatEvent[]>>();
  const live = new Set<number>();

  const launch: LaunchMcp = (spec) => {
    launches.push(spec);
    const pid = 90_000 + launches.length;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: SERVER_NAME, version: '0.0.0' }, { capabilities: { tools: {} } });
    const self: { room: string | null; name: string } = { room: null, name: '' };
    const ok = (data: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }] });
    const fail = (error: { code: string; message?: string; details?: unknown }) => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { message: '', ...error } }) }],
    });

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: TOOLS.filter((name) => !(options.withoutTools ?? []).includes(name)).map((name) => ({ name, inputSchema: { type: 'object' as const } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      toolCalls.push({ name, args });
      const members = self.room === null ? undefined : rooms.get(self.room);
      if (name === 'create_room') {
        if (options.createError !== undefined) return fail(options.createError);
        self.room = `room${rooms.size + 1}abcdefgh`;
        self.name = String(args['name']);
        rooms.set(self.room, new Map([[self.name, []]]));
        return ok({ room_id: self.room, server: typeof args['server'] === 'string' ? args['server'] : 'wss://agent-chat.tools.camp', name: self.name });
      }
      if (name === 'join_room') {
        const room = rooms.get(String(args['room_id']));
        if (options.joinError !== undefined) return fail(options.joinError);
        if (room === undefined) return fail({ code: 'SIGNALING_ERROR', details: { server_code: 'ROOM_NOT_FOUND' } });
        self.room = String(args['room_id']);
        self.name = String(args['name']);
        room.set(self.name, []);
        return ok({ room_id: self.room, name: self.name });
      }
      if (members === undefined) return fail({ code: 'NOT_IN_ROOM' });
      if (name === 'send_message') {
        const others = [...members.keys()].filter((member) => member !== self.name);
        if (options.undelivered === true) return ok({ message_id: 'm', delivered: [], undelivered: others.map((member) => ({ name: member, reason: 'not_connected' })) });
        if (options.dropChat !== true) {
          for (const member of others) {
            const inbox = members.get(member) as ChatEvent[];
            inbox.push({ cursor: String(inbox.length + 1), kind: 'chat', from: self.name, to: 'room', text: String(args['text']) });
          }
        }
        return ok({ message_id: 'm', delivered: others, undelivered: [] });
      }
      if (name === 'wait_for_messages') {
        const inbox = members.get(self.name) ?? [];
        const after = typeof args['cursor'] === 'string' ? Number(args['cursor']) : 0;
        const events = inbox.slice(after);
        return ok({ status: events.length > 0 ? 'events' : 'timeout', events, next_cursor: String(inbox.length), more: false });
      }
      if (name === 'get_status') {
        return ok({ room: { room_id: self.room, net: { stun: options.stun ?? true, srflx_seen: options.srflxSeen ?? true } }, participants: [] });
      }
      if (name === 'leave_room') {
        if (options.leaveError === true) return fail({ code: 'CANCELLED' });
        members.delete(self.name);
        self.room = null;
        return ok({ left: true, undelivered_events: 0 });
      }
      return fail({ code: 'INVALID_ARGUMENT' });
    });

    live.add(pid);
    clientSide.onclose = () => {
      if (options.staysAlive !== true) live.delete(pid);
    };
    void server.connect(serverSide);
    return {
      transport: clientSide,
      pid: () => pid,
      alive: () => live.has(pid),
      kill: () => {
        kills.push(pid);
        live.delete(pid);
      },
      stderrTail: () => '',
    };
  };

  return { launch, launches, toolCalls, kills, open: () => live.size };
}
