// tool 15개의 입력 스키마와 등록 (mcp-interface.md 2~3절). 구현 뒤에는 이 파일의 스키마가 원본이다.
// 방 로직은 없다. 입력의 상한을 걸고, room-session 과 inbox 를 불러, 결과를 JSON 한 덩어리로 옮긴다.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { LogPort } from '../diagnostics/log-port.js';
import type { Inbox, InboxNotice } from '../inbox/contract.js';
import { CLAIM_OUTCOMES, LIMITS, VERIFICATION_RESULTS, utf8ByteLength } from '../protocol/index.js';
import type { Now } from '../protocol/index.js';
import type { RoomSession, SessionFailure, SessionResult } from '../room-session/contract.js';
import type {
  ConfigProblem,
  McpConfig,
  MonitorLauncher,
  ToolContracts,
  ToolErrorCode,
  ToolName,
  ToolNotice,
  ToolWarning,
} from './contract.js';
import { TOOL_INPUT_LIMITS } from './limits.js';
import { monitorCommand } from './monitor-command.js';
import {
  CONFIRM_REJECTED_MESSAGE,
  PAUSED_HINT,
  PRIVATE_MESSAGE_HINT,
  TOOL_ERROR_MESSAGES,
  WAIT_HINTS,
  createdTellUser,
  directConnectHint,
  enterHint,
  notListeningHint,
  pingHint,
  signalingErrorMessage,
  signalingNoticeHint,
} from './messages.js';

export interface ToolDeps {
  readonly session: RoomSession;
  readonly inbox: Inbox;
  readonly config: McpConfig;
  readonly problems: readonly ConfigProblem[];
  readonly now: Now;
  readonly log: LogPort;
  /** 프로세스 종료가 시작되면 취소된다. 대기 중인 wait 을 커서를 옮기지 않고 끝낸다. */
  readonly shutdownSignal: AbortSignal;
  /** 관전 명령(monitor_command)을 만드는 진입점. null 이면 monitor_command 가 null 이다. */
  readonly monitorLauncher: MonitorLauncher | null;
  /** tool 호출 하나가 끝났다(결과를 돌려주기 직전). 수신 상태 파일을 맞춘다. 던지면 무시한다. */
  readonly onToolDone?: (name: ToolName, ok: boolean) => void;
}

/** tool 이름. AGENT_CHAT_CHANNEL=off 면 confirm_channel 을 뺀다. */
export const TOOL_NAMES: readonly ToolName[] = Object.freeze([
  'create_room',
  'join_room',
  'leave_room',
  'get_status',
  'set_status',
  'send_message',
  'ping_room',
  'wait_for_messages',
  'confirm_channel',
  'start_test',
  'stop_test',
  'start_scenario',
  'record_claim',
  'record_verification',
  'write_report',
]);

// ── 입력 스키마 ─────────────────────────────────────────────────────────────
// 형식 오류는 SDK 가 핸들러보다 먼저 거절한다(-32602, isError). 오류 글에 받은 값을 싣지 않는다.

const L = TOOL_INPUT_LIMITS;
/** 이름, 방 ID, 기록 ID 같은 식별자의 형식은 room-session 이 본다. 여기서는 길이만 막는다. */
const ID_MAX_CHARS = 64;
const SERVER_MAX_CHARS = 512;
const TOKEN_MAX_CHARS = 64;
const CURSOR_PATTERN = /^[0-9]{1,15}$/;

function bytesMax(max: number): z.ZodString {
  return z.string().refine((text) => utf8ByteLength(text) <= max, { message: `must be at most ${max} bytes in UTF-8` });
}

const textField = (): z.ZodString => bytesMax(LIMITS.STATE_TEXT_FIELD_MAX_BYTES);
const TEXT_LIMIT = `At most ${LIMITS.STATE_TEXT_FIELD_MAX_BYTES} bytes.`;

const enterShape = {
  server: z
    .string()
    .max(SERVER_MAX_CHARS)
    .optional()
    .describe('Signaling server address. Omit to use the configured default (the public server).'),
  name: z
    .string()
    .max(ID_MAX_CHARS)
    .optional()
    .describe('Your participant name in this room: 1-32 letters, digits, "_" or "-". Omit to use the configured default.'),
};

const SHAPES = {
  create_room: {
    ...enterShape,
    room_id: z
      .string()
      .max(ID_MAX_CHARS)
      .optional()
      .describe('8-32 lowercase letters and digits. Omit to get a random id (recommended: a chosen id can be guessed).'),
  },
  join_room: {
    room_id: z.string().max(ID_MAX_CHARS).describe('The room_id the creator of the room gave you.'),
    ...enterShape,
  },
  leave_room: {},
  get_status: {},
  set_status: {
    status: z
      .enum(['joined', 'ready', 'working'])
      .optional()
      .describe('"ready" when you can start, "working" while you act, "joined" otherwise.'),
    role: z
      .string()
      .max(L.ROLE_MAX_CHARS)
      .nullable()
      .optional()
      .describe(`Your current role in the test, at most ${L.ROLE_MAX_CHARS} characters. null clears it.`),
    tools: z
      .array(z.string().max(L.TOOL_ITEM_MAX_CHARS))
      .max(L.TOOLS_MAX_ITEMS)
      .optional()
      .describe(`What you can test with (e.g. "browser"). At most ${L.TOOLS_MAX_ITEMS} items of ${L.TOOL_ITEM_MAX_CHARS} characters.`),
    note: z
      .string()
      .max(L.NOTE_MAX_CHARS)
      .nullable()
      .optional()
      .describe(`A short note for the other participants, at most ${L.NOTE_MAX_CHARS} characters. null clears it.`),
    listening: z
      .literal(false)
      .optional()
      .describe(
        'Pass false only right before you have to end your turn without waiting (your user gave you other work). The room sees at once that you are not listening. Your next wait_for_messages resumes listening.',
      ),
  },
  send_message: {
    text: bytesMax(LIMITS.CHAT_MAX_TEXT_BYTES).describe(
      `The message. At most ${LIMITS.CHAT_MAX_TEXT_BYTES} bytes in UTF-8. Ignored when resend_of is given.`,
    ),
    to: z
      .array(z.string().max(ID_MAX_CHARS))
      .max(LIMITS.ROOM_MAX_PEERS)
      .optional()
      .describe(
        'Normally omit: the message then goes to the whole room, and you address one participant by starting the text with @name. Pass names here only for a private message your user asked for: only they receive it, and the other participants and the people watching the room cannot see it.',
      ),
    resend_of: z
      .string()
      .max(ID_MAX_CHARS)
      .optional()
      .describe('message_id of an earlier send whose result had ack_timeout. Sends the same message again under the same id.'),
  },
  ping_room: {
    timeout_sec: z
      .number()
      .int()
      .min(L.PING_TIMEOUT_SEC.min)
      .max(L.PING_TIMEOUT_SEC.max)
      .optional()
      .describe(
        `How long to wait for read receipts from listening participants, ${L.PING_TIMEOUT_SEC.min}-${L.PING_TIMEOUT_SEC.max} seconds. Default ${L.PING_TIMEOUT_SEC.default}.`,
      ),
  },
  wait_for_messages: {
    timeout_sec: z
      .number()
      .min(0)
      .optional()
      .describe('How long to wait when there is nothing yet. Omit for the configured maximum; larger values are capped to it.'),
    cursor: z
      .string()
      .regex(CURSOR_PATTERN)
      .optional()
      .describe('next_cursor of your previous result (or the cursor of the last channel block you saw). Events after it are returned, again if needed.'),
  },
  confirm_channel: {
    token: z.string().min(1).max(TOKEN_MAX_CHARS).describe('The token attribute of the channel block with kind="probe".'),
  },
  start_test: {
    request: textField().describe(`Your user's test request, in their words. ${TEXT_LIMIT}`),
    max_duration_min: z
      .number()
      .int()
      .min(L.TEST_DURATION_MIN.min)
      .max(L.TEST_DURATION_MIN.max)
      .optional()
      .describe(`Time limit in minutes, ${L.TEST_DURATION_MIN.min}-${L.TEST_DURATION_MIN.max}. Default ${L.TEST_DURATION_MIN.default}.`),
    max_scenarios: z
      .number()
      .int()
      .min(L.TEST_SCENARIOS.min)
      .max(L.TEST_SCENARIOS.max)
      .optional()
      .describe(`Limit on the number of scenarios, ${L.TEST_SCENARIOS.min}-${L.TEST_SCENARIOS.max}. Default ${L.TEST_SCENARIOS.default}.`),
  },
  stop_test: {
    reason: z
      .string()
      .max(L.STOP_REASON_MAX_CHARS)
      .describe(`Why your user stopped the test, at most ${L.STOP_REASON_MAX_CHARS} characters.`),
  },
  start_scenario: {
    title: z.string().max(L.SCENARIO_TITLE_MAX_CHARS).describe(`Short title, at most ${L.SCENARIO_TITLE_MAX_CHARS} characters.`),
    plan: textField().optional().describe(`What will be done and checked. ${TEXT_LIMIT}`),
    actor: z.string().max(ID_MAX_CHARS).optional().describe('Name of the participant agreed to act. A note, not enforced.'),
    verifier: z.string().max(ID_MAX_CHARS).optional().describe('Name of the participant agreed to verify. A note, not enforced.'),
  },
  record_claim: {
    scenario_id: z.string().max(ID_MAX_CHARS).describe('scenario_id from start_scenario or from a scenario event.'),
    action: textField().describe(`What you did. ${TEXT_LIMIT}`),
    expected: textField().optional().describe(`What should have happened. ${TEXT_LIMIT}`),
    observed: textField().describe(`What you actually saw. ${TEXT_LIMIT}`),
    outcome: z.enum(CLAIM_OUTCOMES).describe('"pass" if it behaved as expected, "fail" if you found a problem.'),
    steps: textField().describe(`Steps to reproduce. ${TEXT_LIMIT}`),
  },
  record_verification: {
    claim_id: z.string().max(ID_MAX_CHARS).describe('claim_id of another participant\'s claim.'),
    result: z.enum(VERIFICATION_RESULTS).describe('"confirmed", "refuted", or "unable" if you could not check.'),
    evidence: textField().describe(`What you checked it with and how. ${TEXT_LIMIT}`),
  },
  write_report: {},
} as const;

const DESCRIPTIONS: { readonly [N in ToolName]: string } = Object.freeze({
  create_room:
    'Create a new Agent Chat room and enter it as the first participant. Returns room_id and server: give both to the other agents so they can join. Show tell_user from the result to your user word for word before you wait for messages.',
  join_room:
    'Enter an existing room and open a direct connection to every participant already there. It fails as a whole if any direct connection cannot be opened; data is never sent through a server or another participant. Can take up to about 40 seconds.',
  leave_room:
    'Leave the room. Events not yet delivered to you are discarded (the count is returned; their text stays in the local transcript file). Leaving the service under test is not a reason to call this.',
  get_status:
    'Show the room, the participants and how each is shown (shown_as), the observers watching read-only (observers), the current test with its recent scenarios (test.scenarios.items), claim counts, the claims waiting for your verification with what to check (claims.waiting_for_you), the delivery mode and warnings. room.monitor_command is the command your user can run to watch this room from a console. A waiting claim with text_omitted=true has its text left out to keep the result small: verify the earlier ones first, then call again.',
  set_status:
    'Tell the room your own tools, role and state. Only the fields you pass change. You cannot set anything for another participant. listening=false tells the room right away that you stop listening (use it only when you must end your turn without waiting).',
  send_message:
    'Send a chat message. By default omit `to`: it goes to the whole room, where every participant and the people watching the room can read it. To address one participant, still omit `to` and start the text with @name. Pass `to` only when your user asked for a private message: it reaches only the named participants and nobody else can see it. It goes directly to each recipient. "delivered" means the recipient process stored it, not that its agent has read it; not_listening lists recipients whose agent is not waiting for room messages now, so a reply may be late. For a recipient with ack_timeout the outcome is unknown: call again with resend_of.',
  ping_room:
    'Check, without help from anyone, whether messages reach each participant and whether its agent is listening. Sends a fixed check message that needs no reply; reading it sends a read receipt automatically. Returns per participant delivered_ms (its process stored it), read_ms (its agent read it) and outcome (read, not_listening, not_read, no_ack, not_connected). Use it when your user asks whether the chat works or why replies are slow.',
  wait_for_messages:
    'Wait for the next room events: chat, participant changes, and test, scenario, claim and verification changes. Returns at once when events are pending. A "timeout" result is normal: call again with next_cursor. At most 20 events per call; when more=true call again right away.',
  confirm_channel:
    'Call this only when you see a channel block with kind="probe", passing its token. It switches delivery to channel mode and returns the events not yet delivered to you.',
  start_test:
    'Share the test request of your user and its limits (time, number of scenarios) with the room. A room has exactly one test: the limits cannot be changed and the test cannot be started again in the same room. Call it only when your user asked for the test.',
  stop_test:
    'Stop the test for everyone because your user asked to stop. It cannot be undone. Tell your user who it reached (sent_to) and who it did not (not_connected), exactly as returned.',
  start_scenario:
    'Record the start of a scenario before you act. This is the only gate for new work: it is refused after a stop, after the time limit, and beyond the scenario limit.',
  record_claim:
    'Record what you did and what you saw in a scenario, with steps to reproduce. A claim stays unverified until another participant verifies it. Use outcome "fail" to report a problem you found.',
  record_verification:
    'Record the result of checking the claim of another participant with your own screen and tools. You cannot verify your own claim. Use "unable" if you could not check.',
  write_report: 'Write the report (final, or interim before the stop) from your local copy of the shared state to a local Markdown file. Returns its path and a summary.',
});

// ── 결과 ────────────────────────────────────────────────────────────────────

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ToolErrorCode; readonly message: string; readonly details?: unknown };

function success<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function failure(code: ToolErrorCode, message: string = TOOL_ERROR_MESSAGES[code], details?: unknown): Outcome<never> {
  return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };
}

function failureFromSession(result: SessionFailure): Outcome<never> {
  const base = result.code === 'SIGNALING_ERROR' ? signalingErrorMessage(result.details.server_code) : TOOL_ERROR_MESSAGES[result.code];
  // detail 은 room-session 이 적은 짧은 원인이다. 다른 참가자가 쓴 글이 아니다.
  const message = result.detail === undefined || result.detail === '' ? base : `${base} Detail: ${result.detail}`;
  switch (result.code) {
    case 'DIRECT_CONNECT_FAILED':
      return failure(result.code, message, { ...result.details, hint: directConnectHint(result.details.peers) });
    case 'SIGNALING_ERROR':
    case 'PEER_VERSION_MISMATCH':
    case 'CHAT_RATE_LIMITED':
      return failure(result.code, message, result.details);
    default:
      return failure(result.code, message);
  }
}

function fromSession<T>(result: SessionResult<T>): Outcome<T> {
  if (!result.ok) return failureFromSession(result);
  const { ok: _ok, ...value } = result;
  return success(value as unknown as T);
}

/** 값이 없는 키를 뺀다. "준 필드만 바꾼다"가 키의 유무로 판정돼도 맞게 한다. */
function withoutUndefined<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = entry;
  return result as T;
}

/** 오류의 이름만 남긴다. 글(message, stack)은 피어 입력이 섞일 수 있어 남기지 않는다. */
function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) : '';
  return name === '' ? 'unknown' : name;
}

// ── 등록 ────────────────────────────────────────────────────────────────────

export interface RegisteredTools {
  /** 등록한 tool 이름. */
  readonly names: readonly ToolName[];
}

export function registerTools(mcp: McpServer, deps: ToolDeps): RegisteredTools {
  const { session, inbox, config, log, now } = deps;
  const channelDeclared = config.channel === 'auto';
  const configNotice = deps.problems
    .filter((problem) => problem.effect === 'default_used')
    .map((problem) => ({ name: problem.name, reason: problem.reason }));

  function buildNotice(inboxNotice: InboxNotice): ToolNotice | undefined {
    const fromSessionNotice = session.notice();
    const notice: { -readonly [K in keyof ToolNotice]: ToolNotice[K] } = {};
    if (fromSessionNotice !== null) {
      if (fromSessionNotice.test_stopped !== undefined) notice.test_stopped = fromSessionNotice.test_stopped;
      if (fromSessionNotice.signaling !== undefined) {
        const { state, reason } = fromSessionNotice.signaling;
        notice.signaling = { ...fromSessionNotice.signaling, hint: signalingNoticeHint(state, reason) };
      }
      if (fromSessionNotice.unreachable !== undefined && fromSessionNotice.unreachable.length > 0) {
        notice.unreachable = fromSessionNotice.unreachable;
      }
    }
    if (inboxNotice.unread !== undefined) notice.unread = inboxNotice.unread;
    if (inboxNotice.pushed_since_last_call !== undefined) notice.pushed_since_last_call = inboxNotice.pushed_since_last_call;
    if (inboxNotice.delivery !== undefined) notice.delivery = inboxNotice.delivery;
    if (fromSessionNotice?.record_failed === true) notice.record_failed = true;
    if (configNotice.length > 0) notice.config = configNotice;
    return Object.keys(notice).length === 0 ? undefined : notice;
  }

  function render(outcome: Outcome<object>, notice: ToolNotice | undefined): CallToolResult {
    const extra = notice === undefined ? {} : { notice };
    if (outcome.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...outcome.value, ...extra }) }] };
    }
    const error = { code: outcome.code, message: outcome.message, ...(outcome.details === undefined ? {} : { details: outcome.details }) };
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error, ...extra }) }], isError: true };
  }

  /**
   * 모든 tool 호출이 지나는 곳. 처리 전에 수신함에 알리고, 결과에 notice 를 붙인다.
   * run 이 끝난 뒤에는 기다리는 일 없이 바로 결과를 돌려준다. 그래야 꺼낸 사건과 응답 사이에 취소가 끼어들지 않는다.
   */
  async function handle<N extends ToolName>(
    name: N,
    cursor: string | undefined,
    run: () => Promise<Outcome<ToolContracts[N]['output']>> | Outcome<ToolContracts[N]['output']>,
  ): Promise<CallToolResult> {
    const startedAt = now();
    const inboxNotice = inbox.noteToolCall(cursor === undefined ? { name } : { name, cursor });
    let outcome: Outcome<object>;
    try {
      outcome = deps.shutdownSignal.aborted ? failure('CANCELLED') : await run();
    } catch (error) {
      // 예상 가능한 실패는 결과로 온다. 여기 오는 것은 결함이다. 오류 글은 남기지 않는다(피어 입력이 섞일 수 있다).
      log.event('error', 'mcp-server', 'tool.error', { tool: name, error_code: errorName(error) });
      outcome = failure('INTERNAL_ERROR');
    }
    let result: CallToolResult;
    try {
      result = render(outcome, buildNotice(inboxNotice));
    } catch (error) {
      log.event('error', 'mcp-server', 'tool.error', { tool: name, error_code: errorName(error) });
      outcome = failure('INTERNAL_ERROR');
      result = render(outcome, undefined);
    }
    try {
      deps.onToolDone?.(name, outcome.ok);
    } catch {
      // 상태 파일은 보조 수단이다. tool 결과를 막지 않는다.
    }
    log.event('info', 'mcp-server', 'tool.call', {
      tool: name,
      outcome: outcome.ok ? 'ok' : 'error',
      error_code: outcome.ok ? undefined : outcome.code,
      duration_ms: now() - startedAt,
    });
    return result;
  }

  const names: ToolName[] = [];
  const meta = (name: ToolName): { description: string } => {
    names.push(name);
    return { description: DESCRIPTIONS[name] };
  };

  mcp.registerTool('create_room', { ...meta('create_room'), inputSchema: SHAPES.create_room }, (args, extra) =>
    handle('create_room', undefined, async () => {
      const entered = await session.create(withoutUndefined({ ...args, signal: extra.signal }));
      if (!entered.ok) return failureFromSession(entered);
      // 입장에 성공한 직후에 채널 점검을 시작한다. 전송 함수가 없거나 이미 channel 이면 아무 일도 없다.
      inbox.startProbe();
      const deliveryMode = inbox.mode();
      return success({
        room_id: entered.room_id,
        server: entered.server,
        name: entered.name,
        you: entered.you,
        participants: entered.participants,
        observers: entered.observers,
        test: entered.test,
        delivery_mode: deliveryMode,
        // 이 PC 의 사용자가 방을 콘솔로 지켜보는 명령(관전. architecture.md 3.14).
        monitor_command: monitorCommand(deps.monitorLauncher, entered.room_id, entered.server),
        // 사용자에게 그대로 보여 줄 글. hint 가 먼저 이것을 쓰라고 한다.
        tell_user: createdTellUser(entered.room_id, entered.server, monitorCommand(deps.monitorLauncher, entered.room_id, entered.server)),
        hint: enterHint({ channelDeclared, deliveryMode, customRoomId: args.room_id !== undefined, created: true }),
      });
    }),
  );

  mcp.registerTool('join_room', { ...meta('join_room'), inputSchema: SHAPES.join_room }, (args, extra) =>
    handle('join_room', undefined, async () => {
      const entered = await session.join(withoutUndefined({ ...args, signal: extra.signal }));
      if (!entered.ok) return failureFromSession(entered);
      inbox.startProbe();
      const deliveryMode = inbox.mode();
      return success({
        room_id: entered.room_id,
        server: entered.server,
        name: entered.name,
        // 자기 presence. 재입장이면 옛 역할과 도구를 이어받았다(검토 1차 PRODUCT-R1-01). participants 는 자신을 뺀다.
        you: entered.you,
        participants: entered.participants,
        // 들어온 때 이미 방을 지켜보던 관전자. 감시받는다는 사실을 숨기지 않는다.
        observers: entered.observers,
        test: entered.test,
        delivery_mode: deliveryMode,
        hint: enterHint({ channelDeclared, deliveryMode, customRoomId: false, created: false }),
      });
    }),
  );

  mcp.registerTool('leave_room', { ...meta('leave_room'), inputSchema: SHAPES.leave_room }, () =>
    handle('leave_room', undefined, async () => fromSession(await session.leave())),
  );

  mcp.registerTool('get_status', { ...meta('get_status'), inputSchema: SHAPES.get_status }, () =>
    handle('get_status', undefined, () => {
      const status = session.status();
      if (!status.ok) return failureFromSession(status);
      const warnings: ToolWarning[] = [...status.warnings];
      const droppedCount = inbox.stats().dropped;
      if (droppedCount > 0) warnings.push({ code: 'inbox_dropped', count: droppedCount });
      for (const problem of configNotice) warnings.push({ code: 'config', name: problem.name, reason: problem.reason });
      return success({
        room: { ...status.room, monitor_command: monitorCommand(deps.monitorLauncher, status.room.room_id, status.room.server) },
        delivery_mode: inbox.mode(),
        participants: status.participants,
        observers: status.observers,
        test: status.test,
        claims: status.claims,
        warnings,
      });
    }),
  );

  mcp.registerTool('set_status', { ...meta('set_status'), inputSchema: SHAPES.set_status }, (args) =>
    handle('set_status', undefined, async () => {
      // 듣지 않는다는 알림: 방에 있을 때만 수신함을 멈춘다. presence 에는 room-session 이 그 값을 바로 쓴다.
      if (args.listening === false && session.notice() !== null) inbox.pauseListening();
      const result = fromSession(await session.command(withoutUndefined({ type: 'set_status' as const, ...args })));
      if (!result.ok || args.listening !== false) return result;
      return success({ ...result.value, hint: PAUSED_HINT });
    }),
  );

  mcp.registerTool('send_message', { ...meta('send_message'), inputSchema: SHAPES.send_message }, (args) =>
    handle('send_message', undefined, async () => {
      const result = fromSession(await session.sendChat(withoutUndefined({ ...args })));
      if (!result.ok) return result;
      const hints: string[] = [];
      // 대상 지정 글은 관전 콘솔과 다른 참가자에게 보이지 않는다. 다음부터 방 전체로 쓰라고 바로 알린다(2026-11-18).
      if (args.to !== undefined && args.resend_of === undefined) hints.push(PRIVATE_MESSAGE_HINT);
      if (result.value.not_listening !== undefined && result.value.not_listening.length > 0) {
        hints.push(notListeningHint(result.value.not_listening.map((entry) => entry.name)));
      }
      return hints.length === 0 ? result : success({ ...result.value, hint: hints.join(' ') });
    }),
  );

  mcp.registerTool('ping_room', { ...meta('ping_room'), inputSchema: SHAPES.ping_room }, (args) =>
    handle('ping_room', undefined, async () => {
      const seconds = args.timeout_sec ?? L.PING_TIMEOUT_SEC.default;
      const result = fromSession(await session.ping({ timeoutMs: seconds * 1000 }));
      if (!result.ok) return result;
      const read = result.value.participants.filter((entry) => entry.outcome === 'read').length;
      const notListening = result.value.participants.filter((entry) => entry.outcome === 'not_listening').length;
      const other = result.value.participants.length - read - notListening;
      return success({ ...result.value, hint: pingHint({ read, notListening, other }) });
    }),
  );

  mcp.registerTool('wait_for_messages', { ...meta('wait_for_messages'), inputSchema: SHAPES.wait_for_messages }, (args, extra) =>
    handle('wait_for_messages', args.cursor, async () => {
      if (session.notice() === null) return failure('NOT_IN_ROOM');
      const seconds = Math.min(args.timeout_sec ?? config.waitMaxSec, config.waitMaxSec);
      const result = await inbox.wait(
        withoutUndefined({
          cursor: args.cursor,
          timeoutMs: Math.round(seconds * 1000),
          // 호스트의 취소와 프로세스 종료. 어느 쪽이든 커서를 옮기지 않는다.
          signal: AbortSignal.any([extra.signal, deps.shutdownSignal]),
        }),
      );
      if (result.status === 'cancelled') return failure('CANCELLED');
      const hint =
        result.status === 'timeout' ? WAIT_HINTS.timeout : result.status === 'channel_mode' ? WAIT_HINTS.channel_mode : result.more ? WAIT_HINTS.more : undefined;
      return success(
        withoutUndefined({ status: result.status, events: result.events, next_cursor: result.next_cursor, more: result.more, hint }),
      );
    }),
  );

  if (channelDeclared) {
    mcp.registerTool('confirm_channel', { ...meta('confirm_channel'), inputSchema: SHAPES.confirm_channel }, (args) =>
      handle('confirm_channel', undefined, () => {
        const result = inbox.confirm(args.token);
        if (!result.ok) return failure(result.code, CONFIRM_REJECTED_MESSAGE);
        return success({ delivery_mode: 'channel' as const, events: result.events, next_cursor: result.next_cursor });
      }),
    );
  }

  mcp.registerTool('start_test', { ...meta('start_test'), inputSchema: SHAPES.start_test }, (args) =>
    handle('start_test', undefined, async () =>
      fromSession(
        await session.command({
          type: 'start_test',
          request: args.request,
          max_duration_min: args.max_duration_min ?? L.TEST_DURATION_MIN.default,
          max_scenarios: args.max_scenarios ?? L.TEST_SCENARIOS.default,
        }),
      ),
    ),
  );

  mcp.registerTool('stop_test', { ...meta('stop_test'), inputSchema: SHAPES.stop_test }, (args) =>
    handle('stop_test', undefined, async () => fromSession(await session.command({ type: 'stop_test', reason: args.reason }))),
  );

  mcp.registerTool('start_scenario', { ...meta('start_scenario'), inputSchema: SHAPES.start_scenario }, (args) =>
    handle('start_scenario', undefined, async () =>
      fromSession(await session.command(withoutUndefined({ type: 'start_scenario' as const, ...args }))),
    ),
  );

  mcp.registerTool('record_claim', { ...meta('record_claim'), inputSchema: SHAPES.record_claim }, (args) =>
    handle('record_claim', undefined, async () =>
      fromSession(await session.command(withoutUndefined({ type: 'record_claim' as const, ...args }))),
    ),
  );

  mcp.registerTool('record_verification', { ...meta('record_verification'), inputSchema: SHAPES.record_verification }, (args) =>
    handle('record_verification', undefined, async () =>
      fromSession(await session.command({ type: 'record_verification', ...args })),
    ),
  );

  mcp.registerTool('write_report', { ...meta('write_report'), inputSchema: SHAPES.write_report }, () =>
    handle('write_report', undefined, async () => fromSession(await session.writeReport())),
  );

  return { names };
}
