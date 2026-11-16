// V-U12 (monitor): runMonitor — 세션 호출 목록, 입장 실패의 종료 코드와 안내, 종료(bye, 130), 시그널링 알림, 로그 규칙.
// 앞쪽은 가짜 세션, 뒤쪽은 실제 room-session 을 가짜 하위 모듈(room-session/testing.ts) 위에 세운다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InboxEvent } from '../inbox/contract.js';
import type { RoomObserved, RoomSession, SessionFailure, SessionResult } from '../room-session/contract.js';
import { FakeClock, FakeLog, ROOM, SEC, createTestBed, presenceRecord, sidOf } from '../room-session/testing.js';
import { parseMonitorArgs } from './args.js';
import type { MonitorOptions, MonitorStyle } from './contract.js';
import { MONITOR_POLL_MS, MONITOR_SHUTDOWN_BUDGET_MS, runMonitor } from './run.js';
import { createMonitorSink } from './sink.js';

const STYLE: MonitorStyle = { color: false, clock: (ms) => new Date(ms).toISOString().slice(11, 19) };
const SECRET = '비밀-본문-7f3k';

function optionsFor(argv: readonly string[]): MonitorOptions {
  const parsed = parseMonitorArgs([ROOM, 'ws://127.0.0.1:8787', '--name', 'zz-watch', ...argv], {}, false, { homeDir: '/nonexistent' });
  assert.ok(parsed.kind === 'run');
  return parsed.options;
}

function observedSample(overrides: Partial<RoomObserved> = {}): RoomObserved {
  return {
    server: 'ws://127.0.0.1:8787',
    name: 'zz-watch',
    signaling: 'connected',
    participants: [{ name: 'A', client: 'codex', tools: [], role: null, status: 'ready', link: 'open', listening: true, shown_as: 'ready' }],
    observers: [],
    unaware: [],
    test: null,
    scenarios: [],
    claims: [],
    ...overrides,
  };
}

/** 관전 도구가 부르면 안 되는 것까지 모두 가진 가짜 세션. 부른 것을 적는다. */
class FakeSession implements RoomSession {
  readonly calls: string[] = [];
  readonly shutdownBudgets: number[] = [];
  observeResult: SessionResult<RoomObserved> | 'wait_abort' = { ok: true, ...observedSample() };
  observedValue: RoomObserved = observedSample();
  hangShutdown = false;
  signal: AbortSignal | undefined;

  private refuse(method: string): SessionFailure {
    this.calls.push(method);
    return { ok: false, code: 'NOT_IN_ROOM' };
  }

  async observe(args: Parameters<RoomSession['observe']>[0]) {
    this.calls.push('observe');
    this.signal = args.signal;
    const result = this.observeResult;
    if (result !== 'wait_abort') return result;
    return new Promise<SessionResult<RoomObserved>>((resolve) => {
      args.signal?.addEventListener('abort', () => resolve({ ok: false, code: 'CANCELLED', detail: 'cancelled' }), { once: true });
    });
  }
  observed(): SessionResult<RoomObserved> {
    this.calls.push('observed');
    return { ok: true, ...this.observedValue };
  }
  shutdown(budgetMs: number): Promise<void> {
    this.calls.push('shutdown');
    this.shutdownBudgets.push(budgetMs);
    return this.hangShutdown ? new Promise(() => undefined) : Promise.resolve();
  }
  async create() {
    return this.refuse('create');
  }
  async join() {
    return this.refuse('join');
  }
  async leave() {
    return this.refuse('leave');
  }
  async ping() {
    return this.refuse('ping');
  }
  readonly sent: unknown[] = [];
  sendResult: Awaited<ReturnType<RoomSession['sendChat']>> = {
    ok: true,
    message_id: 'k3x9q0ab12cd-7',
    delivered: ['A'],
    undelivered: [{ name: 'B', reason: 'not_connected' }],
    not_listening: [{ name: 'A', since: '2026-11-16T05:00:00.000Z' }],
  };
  async sendChat(args: Parameters<RoomSession['sendChat']>[0]) {
    this.calls.push('sendChat');
    this.sent.push(args);
    return this.sendResult;
  }
  async command() {
    return this.refuse('command') as never;
  }
  status() {
    return this.refuse('status');
  }
  async writeReport() {
    return this.refuse('writeReport');
  }
  notice() {
    this.calls.push('notice');
    return null;
  }
}

function rig(argv: readonly string[] = []) {
  const clock = new FakeClock();
  const log = new FakeLog();
  const session = new FakeSession();
  const out: string[] = [];
  const err: string[] = [];
  const options = optionsFor(argv);
  const sink = createMonitorSink({ write: (line) => out.push(line), style: STYLE, json: options.json, now: clock.now });
  const start = () => runMonitor({ session, sink, options, out: (line) => out.push(line), err: (line) => err.push(line), style: STYLE, now: clock.now, timers: clock.timers, log: log.port });
  return { clock, log, session, out, err, sink, options, start };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function chat(text: string): InboxEvent {
  return { kind: 'chat', change: null, id: 'k3x9q0ab12cd-1', from: 'A', to: 'room', ts: '2026-11-16T05:01:10.000Z', text, data: {} };
}

describe('runMonitor: 콘솔 입력으로 에이전트들에게 지시', () => {
  it('글은 방 전체로, @이름 글은 그 참가자에게 보내고 전달 결과를 한 줄로 쓴다', async () => {
    const r = rig();
    const handle = r.start();
    await settle();
    await handle.input('다음 시나리오를 시작해 줘');
    await handle.input('@A,B 역할을 바꿔 줘');
    await handle.input('   ');
    assert.deepEqual(r.session.sent, [{ text: '다음 시나리오를 시작해 줘' }, { text: '역할을 바꿔 줘', to: ['A', 'B'] }]);
    const sentLines = r.out.filter((line) => line.includes('보냄'));
    assert.equal(sentLines.length, 2);
    assert.match(sentLines[0] ?? '', /나 → 전체.*다음 시나리오를 시작해 줘.*전달 A · 미전달 B\(not_connected\) · 듣지 않음 A/);
    assert.match(sentLines[1] ?? '', /나 → A,B/);
    await handle.input('/help');
    assert.ok(r.err.some((line) => line.startsWith('입력 안내')));
    await handle.input('/quit');
    assert.ok(r.err.some((line) => line.includes('모르는 명령')));
    assert.equal(r.session.sent.length, 2);
    handle.stop('interrupted');
    assert.equal(await handle.done, 0);
  });

  it('--json 이면 sent 줄, --read-only 면 보내지 않는다, 들어가기 전에는 보내지 않는다', async () => {
    const json = rig(['--json']);
    const handle = json.start();
    await settle();
    await handle.input('hello');
    const sent = json.out.map((line) => JSON.parse(line)).find((line) => line.type === 'sent');
    assert.deepEqual([sent?.text, sent?.to, sent?.delivered], ['hello', null, ['A']]);
    handle.stop('interrupted');
    await handle.done;

    const quiet = rig(['--read-only']);
    const quietHandle = quiet.start();
    await settle();
    await quietHandle.input('hello');
    assert.deepEqual(quiet.session.sent, []);
    assert.match(quiet.err[1] ?? '', /읽기 전용이다/);
    quietHandle.stop('interrupted');
    await quietHandle.done;

    const early = rig();
    early.session.observeResult = 'wait_abort';
    const earlyHandle = early.start();
    await earlyHandle.input('hello');
    assert.deepEqual(early.session.sent, []);
    assert.ok(early.err.some((line) => line.includes('아직 방에 들어가지 않았다')));
    earlyHandle.stop('interrupted');
    await earlyHandle.done;
  });
});

describe('runMonitor (가짜 세션)', () => {
  it('들어가면 요약, 실시간 머리줄, 사건 순서로 쓴다. 세션에서 부르는 것은 observe·observed·shutdown 뿐이다', async () => {
    const r = rig();
    const handle = r.start();
    await settle();
    r.sink.push(chat(SECRET));
    await r.clock.advance(MONITOR_POLL_MS * 3);
    handle.stop('interrupted');
    assert.equal(await handle.done, 0);
    const text = r.out.join('\n');
    assert.match(r.out[0] ?? '', /^== 지금 방 상태 \(/);
    assert.ok(r.out.some((line) => /여기부터 실시간/.test(line)));
    assert.ok(text.indexOf('여기부터 실시간') < text.indexOf(SECRET), '사건은 머리줄 뒤에 나온다');
    assert.match(r.err[0] ?? '', /방에 들어가는 중/);
    assert.match(r.err[1] ?? '', /관전자 zz-watch 로 들어왔다\. 서버 ws:\/\/127\.0\.0\.1:8787\. 글을 입력하고 Enter/);
    assert.match(r.err.at(-1) ?? '', /끝냈다\. 방에 bye 를 보냈다/);
    assert.deepEqual([...new Set(r.session.calls)].sort(), ['observe', 'observed', 'shutdown']);
    assert.deepEqual(r.session.shutdownBudgets, [MONITOR_SHUTDOWN_BUDGET_MS]);
    assert.equal(text.includes(ROOM), false, '출력에 방 ID 가 없다');
  });

  it('--json: snapshot, event, end 줄. 방 ID 가 없다', async () => {
    const r = rig(['--json']);
    const handle = r.start();
    await settle();
    r.sink.push(chat(SECRET));
    handle.stop('interrupted');
    assert.equal(await handle.done, 0);
    const lines = r.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => line['type']), ['snapshot', 'event', 'end']);
    assert.equal('ok' in (lines[0] ?? {}), false);
    assert.equal(lines[0]?.['name'], 'zz-watch');
    assert.equal(lines[1]?.['text'], SECRET);
    assert.deepEqual([lines[2]?.['reason'], typeof lines[2]?.['at']], ['interrupted', 'string']);
    assert.equal(r.out.join('\n').includes(ROOM), false);
  });

  it('stdout 이 닫혀 끝나면 end.reason 은 stdout_closed 이고 종료 코드 0', async () => {
    const r = rig(['--json']);
    const handle = r.start();
    await settle();
    handle.stop('stdout_closed');
    assert.equal(await handle.done, 0);
    assert.equal((JSON.parse(r.out.at(-1) ?? '{}') as { reason?: string }).reason, 'stdout_closed');
  });

  it('정리 중의 두 번째 stop 은 기다리지 않고 130 이다', async () => {
    const r = rig();
    r.session.hangShutdown = true;
    const handle = r.start();
    await settle();
    handle.stop('interrupted');
    handle.stop('interrupted');
    assert.equal(await handle.done, 130);
  });

  it('입장 중의 stop 은 observe 를 취소하고 종료 코드 0 이다(shutdown 을 부르지 않는다. 정리는 입장 실패와 같다)', async () => {
    const r = rig(['--json']);
    r.session.observeResult = 'wait_abort';
    const handle = r.start();
    await settle();
    assert.equal(r.session.signal?.aborted, false);
    handle.stop('interrupted');
    assert.equal(await handle.done, 0);
    assert.equal(r.session.signal?.aborted, true);
    assert.equal(r.session.calls.includes('shutdown'), false);
    assert.deepEqual(JSON.parse(r.out.at(-1) ?? '{}').type, 'end');
  });

  const failures: readonly { readonly result: SessionFailure; readonly code: number; readonly text: RegExp }[] = [
    { result: { ok: false, code: 'SIGNALING_ERROR', details: { server_code: 'ROOM_NOT_FOUND' } }, code: 1, text: /SIGNALING_ERROR\/ROOM_NOT_FOUND.*방이 없다/ },
    { result: { ok: false, code: 'SIGNALING_ERROR', details: { server_code: 'ROOM_FULL' } }, code: 1, text: /관전자도 정원을 하나 차지한다/ },
    { result: { ok: false, code: 'SIGNALING_ERROR', details: { server_code: 'NAME_IN_USE' } }, code: 1, text: /--name 으로 다른 이름/ },
    {
      result: {
        ok: false,
        code: 'DIRECT_CONNECT_FAILED',
        details: { timeout_ms: 20_000, peers: [{ name: 'A', stage: 'ice', reason: 'ice_timeout', ice_state: 'checking', candidates: null, resends: 0 }] },
      },
      code: 1,
      text: /A\(ice\/ice_timeout\).*중계 없이/,
    },
    { result: { ok: false, code: 'PEER_VERSION_MISMATCH', details: { peers: [{ name: 'A', theirs: 2 }], mine: 1 } }, code: 1, text: /P2P 버전이 다른 참가자가 있다: A/ },
    { result: { ok: false, code: 'SERVER_UNREACHABLE' }, code: 1, text: /시그널링 서버에 접속하지 못했다/ },
    { result: { ok: false, code: 'NATIVE_LOAD_FAILED' }, code: 1, text: /node-datachannel/ },
    { result: { ok: false, code: 'ICE_CONFIG_REJECTED' }, code: 2, text: /AGENT_CHAT_ICE_SERVERS/ },
    { result: { ok: false, code: 'INVALID_ARGUMENT', detail: 'name is reserved' }, code: 2, text: /인자가 틀렸다: name is reserved/ },
  ];

  for (const failure of failures) {
    const label = failure.result.code === 'SIGNALING_ERROR' ? `${failure.result.code}/${failure.result.details.server_code}` : failure.result.code;
    it(`입장 실패 ${label}: 종료 코드 ${failure.code}, 안내와 JSON error 줄`, async () => {
      const r = rig(['--json']);
      r.session.observeResult = failure.result;
      const handle = r.start();
      assert.equal(await handle.done, failure.code);
      assert.match(r.err.at(-1) ?? '', failure.text);
      const error = JSON.parse(r.out[0] ?? '{}') as { type?: string; code?: string; details?: unknown };
      assert.deepEqual([error.type, error.code], ['error', failure.result.code]);
      if ('details' in failure.result) assert.deepEqual(error.details, failure.result.details);
      assert.equal(r.session.calls.includes('shutdown'), false);
      const started = r.log.named('monitor.start')[0];
      assert.equal(started?.fields.outcome, 'failed');
    });
  }

  it('시그널링 상태가 바뀌면 알림 한 줄. 참가자가 모두 끊기면 "관전자만 남았다"를 한 번', async () => {
    const r = rig();
    const handle = r.start();
    await settle();
    const before = r.out.length;
    r.session.observedValue = observedSample({ signaling: 'reconnecting' });
    await r.clock.advance(MONITOR_POLL_MS);
    r.session.observedValue = observedSample({ signaling: 'connected' });
    await r.clock.advance(MONITOR_POLL_MS);
    r.session.observedValue = observedSample({ participants: [{ ...observedSample().participants[0]!, link: 'none', shown_as: 'left' }] });
    await r.clock.advance(MONITOR_POLL_MS * 3);
    const notices = r.out.slice(before);
    assert.equal(notices.length, 3, notices.join('\n'));
    assert.match(notices[0] ?? '', /알림 +system +시그널링 재접속 중이다\. 열린 링크로 계속 본다/);
    assert.match(notices[1] ?? '', /시그널링 서버에 다시 붙었다/);
    assert.match(notices[2] ?? '', /관전자만 남았다/);
    handle.stop('interrupted');
    assert.equal(await handle.done, 0);
  });

  it('--json 의 알림은 notice 줄이다', async () => {
    const r = rig(['--json']);
    const handle = r.start();
    await settle();
    r.session.observedValue = observedSample({ signaling: 'detached' });
    await r.clock.advance(MONITOR_POLL_MS);
    const notice = JSON.parse(r.out.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual([notice['type'], notice['code'], notice['state']], ['notice', 'signaling', 'detached']);
    handle.stop('interrupted');
    await handle.done;
  });

  it('진단 로그에는 사건 본문과 방 ID 가 없다. monitor.start·monitor.end 만 남긴다', async () => {
    const r = rig();
    const handle = r.start();
    await settle();
    r.sink.push(chat(SECRET));
    handle.stop('interrupted');
    await handle.done;
    const text = JSON.stringify(r.log.events);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(ROOM), false);
    assert.deepEqual(r.log.events.map((entry) => entry.event), ['monitor.start', 'monitor.end']);
    const end = r.log.named('monitor.end')[0]?.fields;
    assert.deepEqual([end?.reason, end?.events, end?.events_dropped], ['interrupted', 1, 0]);
    assert.equal(typeof end?.room_ref, 'string');
  });
});

describe('runMonitor + 실제 room-session (가짜 망)', () => {
  it('관전자로 들어가 요약을 쓰고, 방 전체 글을 출력하고, 대상 지정 글(남에게)은 출력하지 않고, stop 에 bye 를 보낸다', async () => {
    const bed = createTestBed();
    const out: string[] = [];
    const err: string[] = [];
    const options = optionsFor(['--json']);
    let session: RoomSession | null = null;
    const sink = createMonitorSink({
      write: (line) => out.push(line),
      style: STYLE,
      json: true,
      now: bed.clock.now,
      refresh: () => {
        const observed = session?.observed();
        if (observed === undefined || !observed.ok) return null;
        const { ok: _ok, ...rest } = observed;
        return rest;
      },
    });
    const sut = bed.session({ name: 'zz-watch', deps: { inbox: sink } });
    session = sut.session;
    bed.net.register(ROOM, 'A', sidOf('A'));
    const handle = runMonitor({ session: sut.session, sink, options, out: (line) => out.push(line), err: (line) => err.push(line), style: STYLE, now: bed.clock.now, timers: bed.clock.timers, log: sut.log.port });
    await bed.settle();
    const a = bed.remote('zz-watch', 'A');
    a.sync([presenceRecord('A', bed.clock.now() - SEC, { status: 'ready', listening: true })]);
    await bed.settle();
    a.chat(`${sidOf('A')}-1`, `${SECRET} 방 전체`);
    a.chat(`${sidOf('A')}-2`, `${SECRET} B 에게만`, ['B']);
    await bed.settle();
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines[0]?.['type'], 'snapshot');
    assert.deepEqual((lines[0]?.['participants'] as { name: string }[]).map((participant) => participant.name), ['A']);
    const chats = lines.filter((line) => line['type'] === 'event' && line['kind'] === 'chat');
    assert.deepEqual(chats.map((line) => line['text']), [`${SECRET} 방 전체`]);
    const hello = a.frames().find((frame) => frame.t === 'hello');
    assert.ok(hello?.t === 'hello' && hello.observer === true);
    a.take();
    handle.stop('interrupted');
    for (let i = 0; i < 20; i += 1) await bed.settle();
    assert.equal(await handle.done, 0);
    const after = a.take();
    assert.ok(after.some((frame) => frame.t === 'bye' && frame.reason === 'shutdown'));
    assert.ok(after.every((frame) => frame.t !== 'chat' && !(frame.t === 'state' && frame.snap !== true)), '채팅과 변경을 보내지 않았다');
    assert.equal(JSON.parse(out.at(-1) ?? '{}').type, 'end');
    assert.equal(out.join('\n').includes(ROOM), false);
    assert.equal(sut.records.transcripts.length, 0);
    assert.equal(JSON.stringify(sut.log.events).includes(SECRET), false, '진단 로그에 본문이 없다');
  });
});
