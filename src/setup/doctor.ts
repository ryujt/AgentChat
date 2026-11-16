// 연결 점검 doctor (architecture.md 3.13 "연결 점검"). D1~D8 을 차례로 본다.
// 등록된 명령과 환경 그대로 MCP 프로세스 두 개를 띄워 tool 을 부른다. 모델도 사람도 필요 없다.
// 네트워크에는 직접 닿지 않는다. 제품 경로를 그대로 지나게 하려는 것이다.

import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { randomLowerAlnum, type Now, type RandomBytes, type Timers } from '../protocol/index.js';
import type { HostCli } from './host-cli.js';
import type { LaunchMcp, McpProcess } from './mcp-process.js';
import { readGeminiRegistration, type GeminiSettingsPaths } from './gemini-config.js';
import { getArgs, launchOf, mcpEntryPath, parseGet, type LaunchCommand, type Lookup } from './registration.js';
import { HOST_LABEL, MIN_NODE_MAJOR, nodeMajorOf, type HostKind, type Outcome, type Reporter, type StepNote } from './types.js';

export interface DoctorLimits {
  /** D3: 초기화와 tool 목록. */
  readonly initMs: number;
  /** D4: create_room. */
  readonly createMs: number;
  /** D5: 두 번째 프로세스의 초기화와 join_room. */
  readonly joinMs: number;
  /** D6: 한 방향의 전송과 수신. */
  readonly messageMs: number;
  /** D7: srflx 후보를 기다리는 시간(DOCTOR_SRFLX_WAIT_MS)과 다시 보는 간격. */
  readonly srflxWaitMs: number;
  readonly srflxPollMs: number;
  /** D8: leave_room 뒤 프로세스가 끝나기까지. */
  readonly exitMs: number;
}

export const DOCTOR_LIMITS: DoctorLimits = {
  initMs: 10_000,
  createMs: 15_000,
  joinMs: 40_000,
  messageMs: 10_000,
  srflxWaitMs: 3_000,
  srflxPollMs: 500,
  exitMs: 2_000,
};

/** D6 에서 wait_for_messages 한 번이 기다리는 시간(초). tool 이 받는 가장 짧은 대기 상한과 같다. */
const WAIT_SEC = 5;
const LEAVE_MS = 5_000;
const REQUIRED_TOOLS: readonly string[] = ['create_room', 'join_room', 'send_message', 'wait_for_messages', 'get_status', 'leave_room'];

const CHECKS = [
  ['D1', 'Node 와 빌드'],
  ['D2', '등록'],
  ['D3', 'MCP 초기화'],
  ['D4', '시그널링'],
  ['D5', '직접 연결'],
  ['D6', '메시지 왕복'],
  ['D7', '주소 탐색'],
  ['D8', '정리'],
] as const;
type CheckId = (typeof CHECKS)[number][0];

export interface DoctorDeps {
  readonly appRoot: string;
  /** 점검을 실행하는 Node 의 버전(`process.versions.node`). */
  readonly nodeVersion: string;
  /** 등록을 볼 호스트 CLI. 없는 호스트는 넣어도 된다(D2 가 건너뛴다). */
  readonly hosts: readonly HostCli[];
  /** Gemini CLI 의 등록을 읽을 설정 파일. 생략하면 Gemini CLI 의 등록은 없는 것으로 본다. */
  readonly geminiSettings?: GeminiSettingsPaths;
  /** create_room 에 줄 서버 주소. null 이면 주지 않는다(등록된 환경 또는 공용 서버). */
  readonly server: string | null;
  readonly launch: LaunchMcp;
  readonly now: Now;
  readonly timers: Timers;
  readonly reporter: Reporter;
  readonly randomBytes?: RandomBytes;
  readonly limits?: Partial<DoctorLimits>;
}

export interface DoctorResult {
  /** D1~D6, D8 이 통과했는가. D7 은 경고로만 낸다. */
  readonly ok: boolean;
}

type ToolOutcome =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly details: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  if (isRecord(error) && typeof error['code'] === 'number') return error['code'] === -32001 ? 'TIMEOUT' : `MCP_${error['code']}`;
  return error instanceof Error && error.name !== 'Error' ? error.name : 'MCP_ERROR';
}

/** tool 을 부르고 결과의 JSON 을 읽는다(mcp-interface.md 2절). 던지지 않는다. */
async function callTool(client: Client, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolOutcome> {
  let result: unknown;
  try {
    result = await client.callTool({ name, arguments: args }, undefined, { timeout: Math.max(1, timeoutMs) });
  } catch (error) {
    return { ok: false, code: errorName(error), message: 'no result from the MCP process', details: null };
  }
  const content = isRecord(result) && Array.isArray(result['content']) ? result['content'] : [];
  const first: unknown = content[0];
  const text = isRecord(first) && typeof first['text'] === 'string' ? first['text'] : '';
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 아래에서 형식 오류로 돌려준다.
  }
  if (isRecord(body) && body['ok'] === true && !(isRecord(result) && result['isError'] === true)) return { ok: true, data: body };
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : null;
  return {
    ok: false,
    code: error !== null && typeof error['code'] === 'string' ? error['code'] : 'BAD_TOOL_RESULT',
    message: error !== null && typeof error['message'] === 'string' ? error['message'] : '',
    details: error === null ? null : (error['details'] ?? null),
  };
}

/** DIRECT_CONNECT_FAILED 의 피어별 단계와 사유. */
function describePeers(details: unknown): string {
  const peers = isRecord(details) && Array.isArray(details['peers']) ? details['peers'] : [];
  return peers
    .filter(isRecord)
    .map((peer) => `stage=${String(peer['stage'])} reason=${String(peer['reason'])}`)
    .join(', ');
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}

interface Session {
  readonly proc: McpProcess;
  readonly client: Client;
  readonly name: string;
  inRoom: boolean;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult> {
  const { reporter, now, timers } = deps;
  const limits: DoctorLimits = { ...DOCTOR_LIMITS, ...deps.limits };
  const sessions: Session[] = [];
  const state = { failed: false, next: 0 };

  const report = (id: CheckId, outcome: Outcome, note: StepNote = {}): void => {
    const index = CHECKS.findIndex(([check]) => check === id);
    if (outcome === 'fail') state.failed = true;
    state.next = index + 1;
    reporter.check(id, (CHECKS[index] as (typeof CHECKS)[number])[1], outcome, note);
  };
  /** 앞 점검이 실패해 하지 못한 점검을 건너뜀으로 적는다. D8(정리)은 따로 판정한다. */
  const skipUntilCleanup = (): void => {
    for (const [id] of CHECKS.slice(state.next, CHECKS.length - 1)) report(id, 'skip', { detail: '앞 점검이 실패했다' });
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, ms));

  const start = async (launch: LaunchCommand, label: string, budgetMs: number): Promise<Session | { readonly error: string; readonly code: string }> => {
    const startedAt = now();
    const proc = deps.launch(launch);
    const client = new Client({ name: 'agent-chat-doctor', version: '1' });
    const session: Session = { proc, client, name: `doctor-${label}-${randomLowerAlnum(4, deps.randomBytes)}`, inRoom: false };
    sessions.push(session);
    try {
      await client.connect(proc.transport, { timeout: Math.max(1, budgetMs) });
      // 전송은 닫히면 pid 를 잊는다. 정리 때 남은 프로세스를 보려면 지금 읽어 둔다.
      proc.pid();
      const listed = await client.listTools(undefined, { timeout: Math.max(1, budgetMs - (now() - startedAt)) });
      const names = listed.tools.map((tool) => tool.name);
      const missing = REQUIRED_TOOLS.filter((tool) => !names.includes(tool));
      if (missing.length > 0) return { error: `tool 이 없다: ${missing.join(', ')}`, code: 'TOOLS_MISSING' };
      return session;
    } catch (error) {
      proc.pid();
      const tail = lastLine(proc.stderrTail());
      return { error: tail === '' ? 'MCP 프로세스가 초기화에 답하지 않았다' : tail, code: errorName(error) };
    }
  };

  /** 받는 쪽이 보낸 쪽의 글을 수신함에서 꺼낼 때까지 기다린다. */
  const receive = async (receiver: Session, from: string, text: string, deadline: number): Promise<boolean> => {
    let cursor: unknown;
    while (now() < deadline) {
      const args: Record<string, unknown> = { timeout_sec: WAIT_SEC };
      if (typeof cursor === 'string') args['cursor'] = cursor;
      const waited = await callTool(receiver.client, 'wait_for_messages', args, WAIT_SEC * 1000 + 5_000);
      if (!waited.ok) return false;
      const events = Array.isArray(waited.data['events']) ? waited.data['events'] : [];
      if (events.some((event) => isRecord(event) && event['kind'] === 'chat' && event['from'] === from && event['text'] === text)) return true;
      cursor = waited.data['next_cursor'];
    }
    return false;
  };

  const exchange = async (sender: Session, receiver: Session): Promise<string | null> => {
    const text = `agent-chat doctor ${sender.name}`;
    const startedAt = now();
    const sent = await callTool(sender.client, 'send_message', { text }, limits.messageMs);
    if (!sent.ok) return sent.code;
    const delivered = Array.isArray(sent.data['delivered']) ? sent.data['delivered'] : [];
    if (!delivered.includes(receiver.name)) return 'NOT_DELIVERED';
    return (await receive(receiver, sender.name, text, startedAt + limits.messageMs)) ? null : 'NOT_RECEIVED';
  };

  /** D7. 통과면 'pass', STUN 을 쓰지 않으면 'skip', 기한까지 못 봤으면 'warn'. */
  const watchSrflx = async (): Promise<Outcome> => {
    const deadline = now() + limits.srflxWaitMs;
    for (;;) {
      for (const session of sessions) {
        const status = await callTool(session.client, 'get_status', {}, limits.srflxWaitMs);
        const room = status.ok && isRecord(status.data['room']) ? status.data['room'] : null;
        const net = room !== null && isRecord(room['net']) ? room['net'] : null;
        if (net !== null && net['stun'] === false) return 'skip';
        if (net !== null && net['srflx_seen'] === true) return 'pass';
      }
      if (now() + limits.srflxPollMs > deadline) return 'warn';
      await sleep(limits.srflxPollMs);
    }
  };

  /** 방을 나가고 프로세스를 닫는다. 남은 프로세스는 강제로 끝낸다. 문제를 돌려준다(없으면 null). */
  const cleanup = async (): Promise<string | null> => {
    let problem: string | null = null;
    for (const session of sessions) {
      if (!session.inRoom) continue;
      const left = await callTool(session.client, 'leave_room', {}, LEAVE_MS);
      if (!left.ok) problem ??= `leave_room: ${left.code}`;
    }
    const startedAt = now();
    await Promise.all(sessions.map((session) => session.client.close().catch(() => undefined)));
    const elapsed = now() - startedAt;
    const leftover = sessions.filter((session) => session.proc.alive());
    for (const session of leftover) session.proc.kill();
    if (leftover.length > 0) problem ??= `프로세스 ${leftover.length}개가 남아 강제로 끝냈다`;
    else if (elapsed > limits.exitMs) problem ??= `프로세스가 ${limits.exitMs}ms 안에 끝나지 않았다(${elapsed}ms)`;
    return problem;
  };

  const run = async (): Promise<void> => {
    // D1
    const major = nodeMajorOf(deps.nodeVersion);
    const entry = mcpEntryPath(deps.appRoot);
    if (major === null || major < MIN_NODE_MAJOR) {
      report('D1', 'fail', { detail: `Node ${MIN_NODE_MAJOR} 이상이 필요하다(지금 ${deps.nodeVersion})`, errorCode: 'NODE_TOO_OLD' });
      return;
    }
    if (!existsSync(entry)) {
      report('D1', 'fail', { detail: `${entry} 가 없다. 설치가 끝나지 않았다`, errorCode: 'BUILD_MISSING' });
      return;
    }
    report('D1', 'pass', { detail: `Node ${deps.nodeVersion}` });

    // D2
    const targets: { host: HostKind; launch: LaunchCommand }[] = [];
    const notes: string[] = [];
    for (const cli of deps.hosts) {
      // Gemini CLI 는 `mcp get` 이 없어 등록을 설정 파일로 읽는다. 실행 파일이 없으면 등록도 쓰이지 않으므로 먼저 본다.
      const result = await cli.run(cli.host === 'gemini' ? ['--version'] : getArgs(cli.host));
      if (result.outcome === 'not-found') {
        notes.push(`${HOST_LABEL[cli.host]}: CLI 없음`);
        continue;
      }
      const lookup: Lookup =
        cli.host === 'gemini'
          ? deps.geminiSettings === undefined
            ? { state: 'absent' }
            : readGeminiRegistration(deps.geminiSettings)
          : parseGet(cli.host, result);
      const launch = lookup.state === 'present' ? launchOf(lookup.registration, deps.appRoot) : null;
      if (launch !== null) {
        targets.push({ host: cli.host, launch });
        notes.push(`${HOST_LABEL[cli.host]}: 이 설치`);
      } else {
        const why = lookup.state === 'absent' ? '등록 없음' : lookup.state === 'present' ? '다른 경로' : '등록을 읽지 못함';
        notes.push(`${HOST_LABEL[cli.host]}: ${why}`);
      }
    }
    const first = targets[0];
    if (first === undefined) {
      report('D2', 'fail', { detail: `이 설치를 가리키는 등록이 없다(${notes.join(', ') || '호스트 없음'})`, errorCode: 'NOT_REGISTERED' });
      return;
    }
    report('D2', 'pass', { detail: notes.join(', ') });
    const second = targets[1] ?? first;

    // D3
    const startedA = now();
    const a = await start(first.launch, 'a', limits.initMs);
    if ('error' in a) {
      report('D3', 'fail', { host: first.host, detail: a.error, errorCode: a.code, durationMs: now() - startedA });
      return;
    }
    report('D3', 'pass', { host: first.host, durationMs: now() - startedA });

    // D4
    const startedCreate = now();
    const createArgs: Record<string, unknown> = { name: a.name };
    if (deps.server !== null) createArgs['server'] = deps.server;
    const created = await callTool(a.client, 'create_room', createArgs, limits.createMs);
    if (!created.ok) {
      report('D4', 'fail', { detail: `${created.code} ${created.message}`.trim(), errorCode: created.code, durationMs: now() - startedCreate });
      return;
    }
    a.inRoom = true;
    const roomId = created.data['room_id'];
    const server = created.data['server'];
    if (typeof roomId !== 'string') {
      report('D4', 'fail', { detail: 'create_room 결과에 room_id 가 없다', errorCode: 'BAD_TOOL_RESULT' });
      return;
    }
    report('D4', 'pass', { detail: typeof server === 'string' ? server : undefined, durationMs: now() - startedCreate });

    // D5
    const startedJoin = now();
    const b = await start(second.launch, 'b', limits.joinMs);
    if ('error' in b) {
      report('D5', 'fail', { host: second.host, detail: b.error, errorCode: b.code, durationMs: now() - startedJoin });
      return;
    }
    const joinArgs: Record<string, unknown> = { room_id: roomId, name: b.name };
    if (typeof server === 'string') joinArgs['server'] = server;
    const joined = await callTool(b.client, 'join_room', joinArgs, limits.joinMs - (now() - startedJoin));
    if (!joined.ok) {
      const peers = describePeers(joined.details);
      report('D5', 'fail', {
        host: second.host,
        detail: [joined.code, peers, joined.message].filter((part) => part !== '').join(' — '),
        errorCode: joined.code,
        durationMs: now() - startedJoin,
      });
      return;
    }
    b.inRoom = true;
    report('D5', 'pass', { host: second.host, durationMs: now() - startedJoin });

    // D6
    const startedChat = now();
    const forward = await exchange(a, b);
    const backward = forward === null ? await exchange(b, a) : null;
    const chatProblem = forward ?? backward;
    if (chatProblem !== null) {
      report('D6', 'fail', { detail: `${forward === null ? 'B → A' : 'A → B'}: ${chatProblem}`, errorCode: chatProblem, durationMs: now() - startedChat });
      return;
    }
    report('D6', 'pass', { durationMs: now() - startedChat });

    // D7
    const srflx = await watchSrflx();
    if (srflx === 'warn') {
      report('D7', 'warn', { detail: 'STUN 에 닿지 않는다. 다른 망의 PC 와는 연결되지 않을 수 있다', errorCode: 'NO_SRFLX' });
    } else {
      report('D7', srflx, srflx === 'skip' ? { detail: 'STUN 을 쓰지 않게 설정돼 있다' } : {});
    }
  };

  try {
    await run();
  } catch {
    // 예상하지 못한 오류도 실패로 적는다. 띄운 프로세스는 아래에서 정리한다.
    const next = CHECKS[Math.min(state.next, CHECKS.length - 2)] as (typeof CHECKS)[number];
    report(next[0], 'fail', { detail: '점검 도중 오류가 났다', errorCode: 'INTERNAL_ERROR' });
  }
  const completed = state.next === CHECKS.length - 1 && !state.failed;
  if (!completed) skipUntilCleanup();
  const startedCleanup = now();
  const problem = await cleanup();
  if (problem !== null) report('D8', 'fail', { detail: problem, errorCode: 'CLEANUP_FAILED', durationMs: now() - startedCleanup });
  else if (completed) report('D8', 'pass', { durationMs: now() - startedCleanup });
  else report('D8', 'skip', { detail: sessions.length === 0 ? '띄운 프로세스가 없다' : '띄운 프로세스를 정리했다' });
  return { ok: !state.failed };
}
