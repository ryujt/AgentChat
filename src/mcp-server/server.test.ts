// stdio 수명: stdin 종료, 깨진 파이프, 신호, 종료 예산 (architecture.md 3.11, S13).
// 가짜 스트림과 가짜 신호원을 넣어 제품의 수명 처리(startOnStdio)를 본다. 증거 수준은 대역이다.
// 실제 프로세스와 실제 파이프로 보는 것은 tests/e2e/mcp 의 V-L7(가)다.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { numberedChat } from '../inbox/testing.js';
import type { McpServerClosed, ShutdownCause } from './contract.js';
import { startMcpServer } from './index.js';
import { DEFAULT_MCP_SERVER_LIMITS } from './limits.js';
import { startOnStdio } from './server.js';
import { createTestBed, flush } from './testing.js';
import type { TestBed, TestBedOptions } from './testing.js';

const BUDGET = DEFAULT_MCP_SERVER_LIMITS.SHUTDOWN_BUDGET_MS;

interface Running extends TestBed {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: EventEmitter;
  readonly signals: EventEmitter;
  readonly closed: Promise<McpServerClosed>;
  /** stdout 에 나온 줄. */
  readonly lines: string[];
  /** JSON-RPC 요청 한 줄을 stdin 에 쓰고 그 id 의 응답을 기다린다. */
  request(id: number, method: string, params?: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  initialize(): Promise<void>;
  callTool(id: number, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function start(options: TestBedOptions = {}): Running {
  const bed = createTestBed(options);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new EventEmitter();
  const signals = new EventEmitter();
  const lines: string[] = [];
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      lines.push(line);
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message['id'];
      if (typeof id === 'number') waiting.get(id)?.(message);
    }
  });
  const handle = startOnStdio(bed.deps, { stdin, stdout, stderr, signals });

  const running: Running = {
    ...bed,
    stdin,
    stdout,
    stderr,
    signals,
    closed: handle.closed,
    lines,
    request(id, method, params) {
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async initialize() {
      await running.request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-host', version: '1.0.0' },
      });
      running.notify('notifications/initialized');
      await flush();
    },
    async callTool(id, name, args = {}) {
      const response = await running.request(id, 'tools/call', { name, arguments: args });
      const result = response['result'] as { content: { text: string }[]; isError?: boolean };
      return { ...(JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>), isError: result.isError === true };
    },
  };
  return running;
}

/** closed 를 기다리되, 몇 틱 안에 resolve 하지 않으면 멈추지 않고 실패한다. */
async function closedSoon(running: Running): Promise<McpServerClosed> {
  const box: { value: McpServerClosed | null } = { value: null };
  void running.closed.then((value) => {
    box.value = value;
  });
  for (let tick = 0; tick < 50 && box.value === null; tick += 1) await flush();
  assert.ok(box.value !== null, 'closed 가 resolve 하지 않았다');
  return box.value;
}

describe('stdio 수명: 종료를 시작하는 사건', () => {
  const triggers: [ShutdownCause, (running: Running) => void][] = [
    ['stdin_end', (running) => running.stdin.end()],
    ['stdin_close', (running) => running.stdin.destroy()],
    ['stdout_error', (running) => running.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))],
    ['SIGINT', (running) => running.signals.emit('SIGINT')],
    ['SIGTERM', (running) => running.signals.emit('SIGTERM')],
    ['SIGHUP', (running) => running.signals.emit('SIGHUP')],
  ];

  for (const [cause, trigger] of triggers) {
    it(`${cause}: 세션을 예산 안에서 끝내고 수신함을 닫은 뒤 closed 가 resolve 한다`, async () => {
      const running = start();
      await running.initialize();
      trigger(running);
      await flush();
      // 종료를 시작하지 않았으면 closed 를 기다리다 멈추지 않고 여기서 걸린다.
      assert.deepEqual(running.session.shutdownBudgets, [BUDGET], '종료를 시작했다');
      const closed = await closedSoon(running);
      assert.deepEqual(closed, { cause, forced: false, duration_ms: 0 });
      assert.equal((await running.inbox.wait({ timeoutMs: 1000 })).status, 'cancelled', '수신함이 닫혔다');
      assert.equal(running.clock.pending(), 0, '타이머가 남지 않는다');
      assert.deepEqual(running.log.named('shutdown').map((entry) => entry.fields), [{ cause, duration_ms: 0, forced: false }]);
    });
  }

  it('처음 온 사건만 원인으로 남는다. 뒤따르는 신호와 stdin 닫힘은 무시한다', async () => {
    const running = start();
    await running.initialize();
    running.signals.emit('SIGINT');
    running.signals.emit('SIGTERM');
    running.stdin.end();
    const closed = await closedSoon(running);
    assert.equal(closed.cause, 'SIGINT');
    await flush();
    running.signals.emit('SIGTERM');
    assert.deepEqual(running.session.shutdownBudgets, [BUDGET], '세션 종료는 한 번만 부른다');
    assert.equal(running.log.named('shutdown').length, 1);
  });

  it('초기화 전에 stdin 이 닫혀도 끝난다', async () => {
    const running = start();
    running.stdin.end();
    await flush();
    assert.equal(running.session.shutdownBudgets.length, 1, '종료를 시작했다');
    assert.equal((await closedSoon(running)).cause, 'stdin_end');
  });

  it('stderr 가 깨져도 던지지 않고 종료를 시작하지 않는다', async () => {
    const running = start();
    await running.initialize();
    assert.doesNotThrow(() => running.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    await flush();
    assert.deepEqual(running.session.shutdownBudgets, []);
    const reply = await running.callTool(2, 'create_room');
    assert.equal(reply['ok'], true);
    running.stdin.end();
    await closedSoon(running);
  });
});

describe('stdio 수명: 종료 예산', () => {
  it('세션 종료가 예산을 넘기면 기다리지 않고 forced 로 끝낸다', async () => {
    const running = start();
    await running.initialize();
    running.session.hangOnShutdown = true;
    running.signals.emit('SIGTERM');
    await flush();
    let settled = false;
    void running.closed.then(() => {
      settled = true;
    });
    running.clock.advance(BUDGET - 1);
    await flush();
    assert.equal(settled, false);
    running.clock.advance(1);
    await flush();
    assert.equal(settled, true, '예산이 차면 기다리지 않는다');
    const closed = await closedSoon(running);
    assert.deepEqual(closed, { cause: 'SIGTERM', forced: true, duration_ms: BUDGET });
    assert.deepEqual(running.log.named('shutdown').map((entry) => [entry.level, entry.fields]), [
      ['warn', { cause: 'SIGTERM', duration_ms: BUDGET, forced: true }],
    ]);
    assert.equal((await running.inbox.wait({ timeoutMs: 1000 })).status, 'cancelled', '예산을 넘겨도 수신함의 타이머는 지운다');
    assert.equal(running.clock.pending(), 0);
  });

  it('세션에는 남은 예산을 준다. 종료를 시작한 뒤 세션 종료를 부르기까지 기다리는 일이 없으므로 예산 전체다', async () => {
    const running = start();
    await running.initialize();
    running.signals.emit('SIGINT');
    await closedSoon(running);
    assert.deepEqual(running.session.shutdownBudgets, [BUDGET]);
  });

  it('세션 종료가 던져도 closed 는 reject 하지 않는다', async () => {
    const running = start();
    await running.initialize();
    running.session.shutdown = () => Promise.reject(new Error('boom'));
    running.signals.emit('SIGTERM');
    const closed = await closedSoon(running);
    assert.equal(closed.forced, false);
    assert.equal(running.log.named('shutdown.error').length, 1);
    assert.equal(JSON.stringify(running.log.events).includes('boom'), false);
  });
});

describe('stdio 수명: 진행 중인 호출', () => {
  it('대기 중인 wait_for_messages 를 커서를 옮기지 않고 끝낸다', async () => {
    const running = start();
    await running.initialize();
    await running.callTool(2, 'create_room');
    running.inbox.push(numberedChat(1));
    const first = await running.callTool(3, 'wait_for_messages');
    assert.equal(first['next_cursor'], '1');

    // 세션 종료가 불린 순간에 사건을 넣어 본다. 대기가 아직 걸려 있었다면 그 사건을 꺼내 갔을 것이다.
    const undeliveredAtShutdown: number[] = [];
    const originalShutdown = running.session.shutdown.bind(running.session);
    running.session.shutdown = (budget) => {
      running.inbox.push(numberedChat(2));
      undeliveredAtShutdown.push(running.inbox.stats().undelivered);
      return originalShutdown(budget);
    };
    let waitSettled = false;
    void running.request(4, 'tools/call', { name: 'wait_for_messages', arguments: {} }).then(() => {
      waitSettled = true;
    });
    await flush();
    assert.equal(running.inbox.listening(), true);

    running.signals.emit('SIGTERM');
    await closedSoon(running);
    await flush();
    assert.deepEqual(undeliveredAtShutdown, [1], '세션 종료를 부르기 전에 대기가 끝나 있었다. 사건을 꺼내 가지 않았다');
    assert.equal(running.log.named('tool.call').at(-1)?.fields.error_code, 'CANCELLED');
    assert.equal(waitSettled, false, '끝나는 프로세스는 취소된 호출에 응답을 쓰지 않는다');
  });

  it('종료가 시작된 뒤의 호출은 세션을 부르지 않는다', async () => {
    const running = start();
    await running.initialize();
    await running.callTool(2, 'create_room');
    running.session.hangOnShutdown = true;
    running.signals.emit('SIGTERM');
    await flush();
    const before = running.session.calls.length;
    void running.request(5, 'tools/call', { name: 'send_message', arguments: { text: 'late' } });
    await flush();
    assert.equal(running.session.calls.length, before);
    running.clock.advance(BUDGET);
    await closedSoon(running);
  });
});

describe('stdio 수명: stdout', () => {
  it('stdout 에는 줄마다 JSON-RPC 메시지 하나만 나간다. 로그는 섞이지 않는다', async () => {
    const running = start({ env: { AGENT_CHAT_WAIT_MAX_SEC: 'abc', AGENT_CHAT_LOG_LEVEL: 'debug' } });
    await running.initialize();
    await running.request(2, 'tools/list');
    await running.callTool(3, 'create_room');
    await flush();
    running.inbox.push(numberedChat(1));
    await running.callTool(4, 'wait_for_messages');
    await running.callTool(5, 'get_status');
    await running.callTool(6, 'leave_room');
    await running.callTool(7, 'leave_room');
    running.stdin.end();
    await closedSoon(running);
    await flush();

    assert.ok(running.lines.length >= 8, `stdout ${running.lines.length}줄`);
    for (const line of running.lines) {
      const message = JSON.parse(line) as Record<string, unknown>;
      assert.equal(message['jsonrpc'], '2.0', line.slice(0, 120));
      assert.ok('id' in message || 'method' in message, line.slice(0, 120));
    }
    const methods = running.lines.map((line) => (JSON.parse(line) as { method?: string }).method).filter((method) => method !== undefined);
    assert.deepEqual([...new Set(methods)], ['notifications/claude/channel'], '서버가 스스로 보내는 것은 채널 알림뿐이다');
    assert.ok(running.log.events.length > 5, '진단은 로그 포트로만 남는다');
  });

  it('초기화 응답이 stdio 를 거쳐도 capability 와 instructions 를 싣는다', async () => {
    const running = start();
    const response = await running.request(1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'raw-host', version: '1.0.0' },
    });
    const result = response['result'] as { protocolVersion: string; capabilities: Record<string, unknown>; instructions: string; serverInfo: unknown };
    assert.notEqual(result.protocolVersion, '2026-07-28');
    assert.deepEqual(result.capabilities['experimental'], { 'claude/channel': {} });
    assert.ok(result.instructions.startsWith('Agent Chat connects you with other AI agents'));
    assert.deepEqual(result.serverInfo, { name: 'agent-chat', version: '0.1.0' });
    running.stdin.end();
    await closedSoon(running);
  });

  it('깨진 JSON 한 줄이 와도 죽지 않고 다음 요청에 답한다', async () => {
    const running = start();
    await running.initialize();
    running.stdin.write('this is not json\n');
    await flush();
    const reply = await running.callTool(2, 'get_status');
    assert.equal((reply['error'] as { code: string }).code, 'NOT_IN_ROOM');
    assert.deepEqual(running.session.shutdownBudgets, []);
    running.stdin.end();
    await closedSoon(running);
  });
});

describe('startMcpServer', () => {
  it('공개 진입점은 함수이고 프로세스의 stdio 에 붙는다(실제 프로세스 확인은 V-L7)', () => {
    assert.equal(typeof startMcpServer, 'function');
    assert.equal(startMcpServer.length, 1);
  });
});
