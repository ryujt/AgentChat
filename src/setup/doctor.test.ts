// 연결 점검 doctor 의 D1~D8 (architecture.md 3.13). MCP 서버는 메모리 전송의 가짜다.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runDoctor, type DoctorDeps } from './doctor.js';
import { createFakeHost, createFakeHub, createMemoryLog, realTimers, type FakeHost, type FakeHub, type FakeHubOptions } from './testing.js';
import { createReporter } from './types.js';

const root = mkdtempSync(join(tmpdir(), 'agent-chat-doctor-'));
const appRoot = join(root, 'agent chat home', 'app');
const entry = join(appRoot, 'dist', 'entry', 'mcp.js');
mkdirSync(join(appRoot, 'dist', 'entry'), { recursive: true });
writeFileSync(entry, '// 가짜 진입점\n');
after(() => rmSync(root, { recursive: true, force: true }));

const NODE = '/opt/node dir/bin/node';
const CLAUDE_ENV = { AGENT_CHAT_CLIENT: 'claude-code', AGENT_CHAT_NAME: 'claude-4kq2', AGENT_CHAT_WAIT_MAX_SEC: '100' };

function registeredClaude(path = entry): FakeHost {
  const host = createFakeHost('claude');
  host.scopes.set('user', { command: NODE, args: [path], env: { ...CLAUDE_ENV } });
  return host;
}

interface Run {
  readonly ok: boolean;
  readonly lines: string[];
  readonly hub: FakeHub;
  readonly outcomes: Record<string, string>;
  readonly events: ReturnType<typeof createMemoryLog>['events'];
}

async function doctor(hubOptions: FakeHubOptions = {}, overrides: Partial<DoctorDeps> = {}): Promise<Run> {
  const lines: string[] = [];
  const log = createMemoryLog();
  const hub = createFakeHub(hubOptions);
  const result = await runDoctor({
    appRoot,
    nodeVersion: '26.12.1',
    hosts: [registeredClaude()],
    server: null,
    launch: hub.launch,
    now: Date.now,
    timers: realTimers,
    reporter: createReporter((line) => void lines.push(line), log),
    limits: { messageMs: 150, srflxWaitMs: 120, srflxPollMs: 40 },
    ...overrides,
  });
  const outcomes: Record<string, string> = {};
  for (const line of lines) {
    const match = /^ {2}(D\d) [^:]+: (통과|실패|건너뜀|경고)/.exec(line);
    if (match !== null) outcomes[match[1] as string] = match[2] as string;
  }
  return { ok: result.ok, lines, hub, outcomes, events: log.events };
}

const ALL_PASS = { D1: '통과', D2: '통과', D3: '통과', D4: '통과', D5: '통과', D6: '통과', D7: '통과', D8: '통과' };

describe('doctor', () => {
  it('D1~D8 이 모두 통과하면 성공이고 띄운 프로세스가 남지 않는다', async () => {
    const run = await doctor();
    assert.deepEqual(run.outcomes, ALL_PASS, run.lines.join('\n'));
    assert.equal(run.ok, true);
    assert.equal(run.hub.open(), 0);
    assert.deepEqual(run.hub.kills, []);
    // 진단 로그에는 점검 ID 와 결과만 남는다.
    const checks = run.events.filter((event) => event.event === 'doctor.check');
    assert.deepEqual(checks.map((event) => event.fields.step), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']);
    for (const event of checks) {
      assert.equal(event.module, 'setup');
      assert.deepEqual(Object.keys(event.fields).filter((key) => event.fields[key as keyof typeof event.fields] !== undefined).sort().filter((key) => !['step', 'outcome', 'host', 'duration_ms'].includes(key)), []);
    }
  });

  it('등록된 명령·인자·환경 그대로 프로세스 둘을 띄운다', async () => {
    const run = await doctor();
    assert.deepEqual(run.hub.launches, [
      { command: NODE, args: [entry], env: CLAUDE_ENV },
      { command: NODE, args: [entry], env: CLAUDE_ENV },
    ]);
  });

  it('호스트 둘이 등록돼 있으면 한 프로세스씩 각 등록으로 띄운다', async () => {
    const codexConfig = join(root, 'codex-config.toml');
    const codex = createFakeHost('codex', { configPath: codexConfig });
    await codex.run(['mcp', 'add', 'agent-chat', '--env', 'AGENT_CHAT_CLIENT=codex', '--env', 'AGENT_CHAT_CHANNEL=off', '--', NODE, entry]);
    const run = await doctor({}, { hosts: [registeredClaude(), codex] });
    assert.equal(run.ok, true, run.lines.join('\n'));
    assert.deepEqual(run.hub.launches.map((launch) => launch.env['AGENT_CHAT_CLIENT']), ['claude-code', 'codex']);
    assert.deepEqual(run.hub.launches[1], { command: NODE, args: [entry], env: { AGENT_CHAT_CLIENT: 'codex', AGENT_CHAT_CHANNEL: 'off' } });
  });

  it('두 프로세스에 서로 다른 점검용 이름을 주고, 방 ID 와 서버는 만든 쪽의 결과를 넘긴다', async () => {
    const run = await doctor();
    const create = run.hub.toolCalls.find((call) => call.name === 'create_room');
    const join_ = run.hub.toolCalls.find((call) => call.name === 'join_room');
    assert.deepEqual(Object.keys(create?.args ?? {}), ['name'], 'server 를 주지 않으면 create_room 에 넣지 않는다');
    assert.match(String(create?.args['name']), /^doctor-a-[a-z0-9]{4}$/);
    assert.match(String(join_?.args['name']), /^doctor-b-[a-z0-9]{4}$/);
    assert.equal(join_?.args['room_id'], 'room1abcdefgh');
    assert.equal(join_?.args['server'], 'wss://agent-chat.tools.camp');
    // 양방향으로 보내고, 둘 다 나간다.
    assert.equal(run.hub.toolCalls.filter((call) => call.name === 'send_message').length, 2);
    assert.equal(run.hub.toolCalls.filter((call) => call.name === 'leave_room').length, 2);
  });

  it('서버 주소를 주면 create_room 의 server 인자로 넘긴다', async () => {
    const run = await doctor({}, { server: 'ws://127.0.0.1:8787' });
    assert.equal(run.hub.toolCalls.find((call) => call.name === 'create_room')?.args['server'], 'ws://127.0.0.1:8787');
    assert.equal(run.hub.launches.every((launch) => !('AGENT_CHAT_SERVER' in launch.env)), true, '서버 주소를 환경에 넣지 않는다');
  });

  it('D1: Node 가 22 미만이거나 빌드 결과가 없으면 실패하고 아무 것도 띄우지 않는다', async () => {
    const old = await doctor({}, { nodeVersion: '20.11.0' });
    assert.equal(old.ok, false);
    assert.equal(old.outcomes['D1'], '실패');
    const unbuilt = await doctor({}, { appRoot: join(root, 'nowhere') });
    assert.equal(unbuilt.outcomes['D1'], '실패');
    for (const run of [old, unbuilt]) {
      assert.equal(run.hub.launches.length, 0);
      assert.deepEqual([run.outcomes['D2'], run.outcomes['D7'], run.outcomes['D8']], ['건너뜀', '건너뜀', '건너뜀']);
    }
  });

  it('D2: 등록이 없거나 다른 경로를 가리키면 실패한다', async () => {
    const cases: [string, FakeHost[]][] = [
      ['등록 없음', [createFakeHost('claude')]],
      ['다른 경로', [registeredClaude('/elsewhere/dist/entry/mcp.js')]],
      ['CLI 없음', [createFakeHost('claude', { version: null }), createFakeHost('codex', { version: null })]],
      ['호스트 없음', []],
    ];
    for (const [expected, hosts] of cases) {
      const run = await doctor({}, { hosts });
      assert.equal(run.ok, false, expected);
      assert.equal(run.outcomes['D2'], '실패', expected);
      assert.ok(run.lines.join('\n').includes(expected), `${expected}: ${run.lines.join('\n')}`);
      assert.equal(run.hub.launches.length, 0);
    }
  });

  it('D2: 한 호스트만 이 설치를 가리켜도 통과한다', async () => {
    const run = await doctor({}, { hosts: [createFakeHost('codex', { version: null }), registeredClaude()] });
    assert.deepEqual(run.outcomes, ALL_PASS);
  });

  it('D3: tool 목록이 모자라면 실패하고 띄운 프로세스를 정리한다', async () => {
    const run = await doctor({ withoutTools: ['join_room'] });
    assert.equal(run.ok, false);
    assert.equal(run.outcomes['D3'], '실패');
    assert.match(run.lines.join('\n'), /join_room/);
    assert.equal(run.outcomes['D4'], '건너뜀');
    assert.equal(run.hub.open(), 0);
  });

  it('D4: create_room 의 오류 코드를 그대로 보여 준다', async () => {
    for (const code of ['SERVER_UNREACHABLE', 'NATIVE_LOAD_FAILED', 'ICE_CONFIG_REJECTED']) {
      const run = await doctor({ createError: { code, message: 'details here' } });
      assert.equal(run.ok, false);
      assert.equal(run.outcomes['D4'], '실패');
      assert.ok(run.lines.some((line) => line.includes('D4') && line.includes(code)), code);
      assert.equal(run.events.find((event) => event.fields.step === 'D4')?.fields.error_code, code);
      assert.equal(run.outcomes['D5'], '건너뜀');
      assert.equal(run.hub.launches.length, 1, '두 번째 프로세스를 띄우지 않는다');
    }
  });

  it('D5: DIRECT_CONNECT_FAILED 의 단계와 사유를 보여 준다', async () => {
    const run = await doctor({
      joinError: { code: 'DIRECT_CONNECT_FAILED', details: { peers: [{ name: 'doctor-a-xxxx', stage: 'ice', reason: 'ice_timeout' }] } },
    });
    assert.equal(run.ok, false);
    const line = run.lines.find((candidate) => candidate.includes('D5')) ?? '';
    assert.match(line, /실패.*DIRECT_CONNECT_FAILED.*stage=ice reason=ice_timeout/);
    assert.equal(run.outcomes['D6'], '건너뜀');
    // 방을 만든 쪽은 나가고, 둘 다 정리된다.
    assert.equal(run.hub.toolCalls.filter((call) => call.name === 'leave_room').length, 1);
    assert.equal(run.hub.open(), 0);
  });

  it('D6: 전달되지 않았거나 받는 쪽 수신함에 오지 않으면 실패한다', async () => {
    const undelivered = await doctor({ undelivered: true });
    assert.equal(undelivered.outcomes['D6'], '실패');
    assert.match(undelivered.lines.join('\n'), /A → B: NOT_DELIVERED/);
    const dropped = await doctor({ dropChat: true });
    assert.equal(dropped.outcomes['D6'], '실패');
    assert.match(dropped.lines.join('\n'), /A → B: NOT_RECEIVED/);
    for (const run of [undelivered, dropped]) {
      assert.equal(run.ok, false);
      assert.equal(run.outcomes['D7'], '건너뜀');
      assert.equal(run.hub.open(), 0);
    }
  });

  it('D7: srflx 를 기한까지 못 보면 경고이고 실패가 아니다', async () => {
    const run = await doctor({ srflxSeen: false });
    assert.equal(run.outcomes['D7'], '경고');
    assert.equal(run.outcomes['D8'], '통과');
    assert.equal(run.ok, true);
    // 한 번만 보지 않고 기한까지 다시 본다.
    assert.ok(run.hub.toolCalls.filter((call) => call.name === 'get_status').length >= 4);
  });

  it('D7: STUN 을 쓰지 않게 설정했으면 건너뛴다', async () => {
    const run = await doctor({ stun: false, srflxSeen: false });
    assert.equal(run.outcomes['D7'], '건너뜀');
    assert.equal(run.ok, true);
  });

  it('D8: 프로세스가 남으면 실패하고 강제로 끝낸다', async () => {
    const run = await doctor({ staysAlive: true });
    assert.equal(run.outcomes['D8'], '실패');
    assert.equal(run.ok, false);
    assert.equal(run.hub.kills.length, 2);
    assert.equal(run.hub.open(), 0);
  });

  it('D8: leave_room 이 실패하면 실패한다', async () => {
    const run = await doctor({ leaveError: true });
    assert.equal(run.outcomes['D8'], '실패');
    assert.equal(run.ok, false);
  });

  it('출력에 방 ID 와 환경 변수 값이 나오지 않는다', async () => {
    const run = await doctor();
    const text = run.lines.join('\n');
    assert.doesNotMatch(text, /room1abcdefgh|claude-4kq2/);
    assert.doesNotMatch(JSON.stringify(run.events), /room1abcdefgh|claude-4kq2|doctor-a-/);
  });
});
