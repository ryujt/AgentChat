// mcp-server 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다(V-U8 의 import-testing).
// room-session 을 대신하는 가짜 세션과, SDK 클라이언트를 메모리 전송으로 붙이는 도구를 준다.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Inbox, ToolCallInfo } from '../inbox/contract.js';
import { createInbox, DEFAULT_INBOX_LIMITS } from '../inbox/index.js';
import { createFakeClock, createRecordingLog } from '../inbox/testing.js';
import type { FakeClock, RecordingLog } from '../inbox/testing.js';
import type {
  ChatSent,
  CommandOutputs,
  ParticipantView,
  PingSent,
  ReportWritten,
  RoomEntered,
  RoomLeft,
  RoomObserved,
  RoomSession,
  SessionCommand,
  SessionFailure,
  SessionNotice,
  SessionResult,
  SessionStatus,
} from '../room-session/contract.js';
import { loadConfig } from './config.js';
import type { ConfigProblem, McpConfig, McpServerDeps, MonitorLauncher } from './contract.js';
import { DEFAULT_MCP_SERVER_LIMITS } from './limits.js';
import { createMcpApp } from './server.js';
import type { McpApp } from './server.js';

export interface FakeSessionCall {
  readonly method: string;
  readonly args: unknown;
}

type Responses = {
  create?: SessionResult<RoomEntered>;
  join?: SessionResult<RoomEntered>;
  leave?: SessionResult<RoomLeft>;
  sendChat?: SessionResult<ChatSent>;
  ping?: SessionResult<PingSent>;
  command?: SessionResult<CommandOutputs[keyof CommandOutputs]>;
  status?: SessionResult<SessionStatus>;
  writeReport?: SessionResult<ReportWritten>;
};

export interface FakeSession extends RoomSession {
  readonly calls: FakeSessionCall[];
  /** 정해 두면 그 호출이 이 값을 돌려준다. 없으면 성공 표본을 돌려준다. */
  readonly responses: Responses;
  /** 방에 있을 때 notice() 가 돌려주는 값. */
  noticeValue: SessionNotice;
  inRoom: boolean;
  /** 정해 두면 다음 호출이 이 값을 던진다(결함 흉내). */
  throwNext: Error | null;
  /** shutdown 이 받은 예산. */
  readonly shutdownBudgets: number[];
  /** 참이면 shutdown 이 끝나지 않는다. */
  hangOnShutdown: boolean;
}

export const SAMPLE_SERVER = 'wss://agent-chat.tools.camp';
export const SAMPLE_ROOM_ID = 'k3x9q0ab12cd7f3k';

const SELF: ParticipantView = {
  name: 'claude-4kq2',
  client: 'claude-code',
  tools: [],
  role: null,
  status: 'joined',
  link: 'none',
  listening: false,
  shown_as: 'not_ready',
};

export function sampleStatus(): SessionStatus {
  return {
    room: { room_id: SAMPLE_ROOM_ID, server: SAMPLE_SERVER, name: SELF.name, signaling: 'connected', net: { stun: true, srflx_seen: false } },
    participants: [
      { name: 'codex-7f3k', client: 'codex', tools: ['browser'], role: '수강생 A', status: 'ready', link: 'open', listening: true, shown_as: 'ready' },
    ],
    observers: [],
    test: null,
    claims: { confirmed: 0, refuted: 0, unverified: 0, late: 0, waiting_for_you: [] },
    warnings: [],
  };
}

export function fail(code: Exclude<SessionFailure['code'], 'SIGNALING_ERROR' | 'DIRECT_CONNECT_FAILED' | 'PEER_VERSION_MISMATCH' | 'CHAT_RATE_LIMITED'>, detail?: string): SessionFailure {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

/** room-session 의 계약에 맞춘 가짜. 방 기능은 없다. 부른 것을 적고 정해 둔 값을 돌려준다. */
export function createFakeSession(inbox?: Pick<Inbox, 'discardAll'>): FakeSession {
  const calls: FakeSessionCall[] = [];
  const responses: Responses = {};
  const shutdownBudgets: number[] = [];

  function note(method: string, args: unknown): void {
    calls.push({ method, args });
    if (session.throwNext !== null) {
      const error = session.throwNext;
      session.throwNext = null;
      throw error;
    }
  }

  function entered(args: { room_id?: string; server?: string; name?: string }): SessionResult<RoomEntered> {
    session.inRoom = true;
    const name = args.name ?? SELF.name;
    return {
      ok: true,
      room_id: args.room_id ?? SAMPLE_ROOM_ID,
      server: SAMPLE_SERVER,
      name,
      participants: [{ ...SELF, name }],
      observers: [],
      test: null,
      you: { role: null, tools: [], status: 'joined', note: null, rejoined: false },
    };
  }

  function commandSample(command: SessionCommand): SessionResult<CommandOutputs[keyof CommandOutputs]> {
    switch (command.type) {
      case 'set_status':
        return {
          ok: true,
          presence: {
            client: 'claude-code',
            tools: [...(command.tools ?? [])],
            role: command.role ?? null,
            status: command.status ?? 'joined',
            listening: false,
            note: command.note ?? null,
          },
        };
      case 'start_test':
        return {
          ok: true,
          test_id: 'k3x9q0ab12cd-1',
          limits: { max_duration_min: command.max_duration_min, max_scenarios: command.max_scenarios },
          sent_to: ['codex-7f3k'],
          not_connected: [],
        };
      case 'stop_test':
        return { ok: true, stopped: true, test_id: 'k3x9q0ab12cd-1', sent_to: ['codex-7f3k'], not_connected: [] };
      case 'start_scenario':
        return { ok: true, scenario_id: 'k3x9q0ab12cd-3', index: 1, remaining: 19 };
      case 'record_claim':
        return { ok: true, claim_id: 'k3x9q0ab12cd-4', status: 'unverified', late: false };
      case 'record_verification':
        return { ok: true, verification_id: 'k3x9q0ab12cd-5', claim_status: 'confirmed' };
    }
  }

  const session: FakeSession = {
    calls,
    responses,
    noticeValue: {},
    inRoom: false,
    throwNext: null,
    shutdownBudgets,
    hangOnShutdown: false,
    async create(args) {
      note('create', args);
      if (responses.create !== undefined) {
        session.inRoom = responses.create.ok;
        return responses.create;
      }
      return entered(args);
    },
    async join(args) {
      note('join', args);
      if (responses.join !== undefined) {
        session.inRoom = responses.join.ok;
        return responses.join;
      }
      return entered(args);
    },
    async leave() {
      note('leave', undefined);
      if (responses.leave !== undefined) return responses.leave;
      if (!session.inRoom) return fail('NOT_IN_ROOM');
      session.inRoom = false;
      return { ok: true, left: true, transcript_path: '/home/agent-chat/rooms/transcript.jsonl', undelivered_events: inbox?.discardAll() ?? 0 };
    },
    async sendChat(args) {
      note('sendChat', args);
      if (responses.sendChat !== undefined) return responses.sendChat;
      if (!session.inRoom) return fail('NOT_IN_ROOM');
      return { ok: true, message_id: 'k3x9q0ab12cd-9', delivered: ['codex-7f3k'], undelivered: [] };
    },
    async ping(args) {
      note('ping', args);
      if (responses.ping !== undefined) return responses.ping;
      if (!session.inRoom) return fail('NOT_IN_ROOM');
      return {
        ok: true,
        message_id: 'k3x9q0ab12cd-10',
        participants: [{ name: 'codex-7f3k', outcome: 'read', delivered_ms: 12, read_ms: 340, listening: true }],
        not_listening: [],
      };
    },
    async command(command) {
      note('command', command);
      const result = responses.command ?? (session.inRoom ? commandSample(command) : fail('NOT_IN_ROOM'));
      return result as never;
    },
    async observe(args) {
      // mcp-server 는 관전하지 않는다. 부르면 기록에 남아 시험이 알아챈다.
      note('observe', args);
      return fail('NOT_IN_ROOM');
    },
    observed(): SessionResult<RoomObserved> {
      note('observed', undefined);
      return fail('NOT_IN_ROOM');
    },
    status() {
      note('status', undefined);
      if (responses.status !== undefined) return responses.status;
      return session.inRoom ? { ok: true, ...sampleStatus() } : fail('NOT_IN_ROOM');
    },
    async writeReport() {
      note('writeReport', undefined);
      if (responses.writeReport !== undefined) return responses.writeReport;
      if (!session.inRoom) return fail('NOT_IN_ROOM');
      return { ok: true, path: '/home/agent-chat/rooms/report.md', summary: { scenarios: 1, passed: 1, failed: 0, unverified: 0, late: 0 } };
    },
    notice: () => (session.inRoom ? session.noticeValue : null),
    shutdown(budgetMs) {
      shutdownBudgets.push(budgetMs);
      session.inRoom = false;
      return session.hangOnShutdown ? new Promise(() => {}) : Promise.resolve();
    },
  };
  return session;
}

export interface TestBed {
  readonly deps: McpServerDeps;
  readonly inbox: Inbox;
  readonly session: FakeSession;
  readonly clock: FakeClock;
  readonly log: RecordingLog;
  /** inbox.noteToolCall 이 받은 호출. */
  readonly noted: ToolCallInfo[];
  readonly config: McpConfig;
  readonly problems: readonly ConfigProblem[];
}

export interface TestBedOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** 생략하면 SAMPLE_MONITOR_LAUNCHER. */
  readonly monitorLauncher?: MonitorLauncher | null;
}

/** 시험의 관전 진입점. 경로에 공백과 작은따옴표를 넣어 인용을 본다. */
export const SAMPLE_MONITOR_LAUNCHER = { kind: 'sh', path: "/opt/agent chat/it's/scripts/monitor.sh" } as const;

/** 가짜 시계, 실제 수신함, 가짜 세션으로 McpServerDeps 를 만든다. */
export function createTestBed(options: TestBedOptions = {}): TestBed {
  const clock = createFakeClock();
  const log = createRecordingLog();
  const realInbox = createInbox({ limits: DEFAULT_INBOX_LIMITS, now: clock.now, timers: clock.timers, log });
  const noted: ToolCallInfo[] = [];
  const inbox: Inbox = {
    ...realInbox,
    noteToolCall(call) {
      noted.push(call);
      return realInbox.noteToolCall(call);
    },
  };
  const session = createFakeSession(inbox);
  const { config, problems } = loadConfig(
    { AGENT_CHAT_NAME: 'claude-4kq2', AGENT_CHAT_HOME: options.home ?? '/nonexistent/agent-chat-home', ...options.env },
    { homeDir: '/nonexistent' },
  );
  const deps: McpServerDeps = {
    session,
    inbox,
    config,
    problems,
    limits: DEFAULT_MCP_SERVER_LIMITS,
    app: { name: 'agent-chat', version: '0.1.0' },
    now: clock.now,
    timers: clock.timers,
    log,
    monitorLauncher: options.monitorLauncher === undefined ? SAMPLE_MONITOR_LAUNCHER : options.monitorLauncher,
  };
  return { deps, inbox, session, clock, log, noted, config, problems };
}

export interface ChannelNotification {
  readonly content: string;
  readonly meta: Readonly<Record<string, string>>;
}

export interface ToolReply {
  readonly isError: boolean;
  /** 결과의 텍스트 한 덩어리. */
  readonly text: string;
  /** text 를 JSON 으로 읽은 값. JSON 이 아니면 null. */
  readonly json: Record<string, unknown> | null;
  /** content 의 덩어리 수. */
  readonly blocks: number;
}

export interface Harness extends TestBed {
  readonly app: McpApp;
  readonly client: Client;
  /** 클라이언트가 받은 채널 알림. */
  readonly channel: ChannelNotification[];
  /** 클라이언트가 받은 그 밖의 알림의 method. */
  readonly otherNotifications: string[];
  call(name: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ToolReply>;
  close(): Promise<void>;
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 제품의 MCP 서버를 메모리 전송으로 SDK 클라이언트에 붙인다. */
export async function connectHarness(options: TestBedOptions = {}): Promise<Harness> {
  const bed = createTestBed(options);
  const app = createMcpApp(bed.deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '9.9.9' }, { capabilities: {} });
  const channel: ChannelNotification[] = [];
  const otherNotifications: string[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/claude/channel') {
      channel.push(notification.params as unknown as ChannelNotification);
    } else {
      otherNotifications.push(notification.method);
    }
  };
  await app.mcp.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    ...bed,
    app,
    client,
    channel,
    otherNotifications,
    async call(name, args = {}, callOptions = {}) {
      const result = await client.callTool({ name, arguments: args }, undefined, callOptions);
      const content = result.content as { type: string; text?: string }[];
      const text = content[0]?.text ?? '';
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      } catch {
        json = null;
      }
      return { isError: result.isError === true, text, json, blocks: content.length };
    },
    async close() {
      await client.close();
      await app.mcp.close();
      bed.inbox.close();
    },
  };
}
