// V-U12 (monitor): createMonitorSink — start() 전 보관, 넘침 알림, 버리기, 표 갱신 (architecture.md 3.14).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InboxEvent } from '../inbox/contract.js';
import type { RoomObserved, SessionInbox } from '../room-session/contract.js';
import type { MonitorStyle } from './contract.js';
import { MONITOR_HOLD_MAX, createMonitorSink } from './sink.js';

const TS = '2026-11-16T05:01:10.000Z';
const STYLE: MonitorStyle = { color: false, clock: (ms) => new Date(ms).toISOString().slice(11, 19) };
const NOW = Date.parse('2026-11-16T05:02:00.000Z');

function chat(index: number): InboxEvent {
  return { kind: 'chat', change: null, id: `k3x9q0ab12cd-${index.toString(36)}`, from: 'codex-b', to: 'room', ts: TS, text: `글 ${index}`, data: {} };
}

function observed(scenarios: readonly [string, number][] = [], claims: readonly [string, string][] = []): RoomObserved {
  return {
    server: 'wss://agent-chat.tools.camp',
    name: 'observer-4k2q',
    signaling: 'connected',
    participants: [],
    observers: [],
    unaware: [],
    test: null,
    scenarios: scenarios.map(([scenario_id, index]) => ({ scenario_id, index, title: 't', by: 'a', plan: null, actor: null, verifier: null, over_limit: false, wall: TS })),
    claims: claims.map(([claim_id, by]) => ({
      claim_id,
      scenario_id: 's',
      by,
      outcome: 'pass',
      action: 'a',
      expected: null,
      observed: 'o',
      steps: 's',
      status: 'unverified',
      late: false,
      wall: TS,
      verifications: [],
    })),
  };
}

function rig(json = false, refresh?: () => RoomObserved | null) {
  const lines: string[] = [];
  const sink = createMonitorSink({ write: (line) => lines.push(line), style: STYLE, json, now: () => NOW, ...(refresh === undefined ? {} : { refresh }) });
  return { sink, lines };
}

describe('createMonitorSink', () => {
  it('room-session 의 수신함 자리(SessionInbox)에 맞는다. 수신 중이 아니고 poll 이다', () => {
    const { sink } = rig();
    const inbox: SessionInbox = sink;
    assert.equal(inbox.mode(), 'poll');
    assert.equal(inbox.listening(), false);
    const off = inbox.on('listening-changed', () => undefined);
    off();
  });

  it('start() 전 사건은 들고 있다가 start() 에서 순서대로 쓰고, 이후로는 바로 쓴다', () => {
    const { sink, lines } = rig();
    sink.push(chat(1));
    sink.push(chat(2));
    assert.deepEqual(lines, []);
    sink.start();
    sink.push(chat(3));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((line: string) => line.slice(-3)), ['글 1', '글 2', '글 3']);
    assert.equal(sink.written(), 3);
    assert.equal(sink.dropped(), 0);
  });

  it(`${MONITOR_HOLD_MAX}건을 넘으면 버리고, start() 에서 버린 수를 한 줄로 알린다`, () => {
    const { sink, lines } = rig();
    for (let i = 1; i <= MONITOR_HOLD_MAX + 7; i += 1) sink.push(chat(i));
    sink.start();
    assert.equal(sink.dropped(), 7);
    assert.equal(lines.length, MONITOR_HOLD_MAX + 1);
    assert.match(lines.at(-1) ?? '', /^05:02:00 {2}알림 {8}system {12}출력하지 못하고 버린 사건이 7건 있다$/);
    const json = rig(true);
    for (let i = 1; i <= MONITOR_HOLD_MAX + 2; i += 1) json.sink.push(chat(i));
    json.sink.start();
    const last = JSON.parse(json.lines.at(-1) ?? '{}') as { type: string; kind: string; data: { code: string; count: number } };
    assert.deepEqual([last.type, last.kind, last.data.code, last.data.count], ['event', 'system', 'inbox_dropped', 2]);
  });

  it('discardAll 은 들고 있던 것을 버리고 그 수를 돌려준다(입장 실패·취소). close 뒤에는 쓰지 않는다', () => {
    const { sink, lines } = rig();
    sink.push(chat(1));
    sink.push(chat(2));
    assert.equal(sink.discardAll(), 2);
    sink.start();
    assert.deepEqual(lines, []);
    sink.push(chat(3));
    sink.close();
    sink.push(chat(4));
    sink.start();
    assert.equal(lines.length, 1);
  });

  it('JSON 이면 사건마다 {"type":"event",...} 한 줄이다', () => {
    const { sink, lines } = rig(true);
    sink.start();
    sink.push(chat(1));
    assert.deepEqual(JSON.parse(lines[0] ?? ''), { type: 'event', ...chat(1) });
  });

  it('표: 요약으로 채우고, 모르는 시나리오·주장을 만나면 refresh 로 다시 받는다', () => {
    let refreshed = 0;
    const { sink, lines } = rig(false, () => {
      refreshed += 1;
      return observed([['k3x9q0ab12cd-4', 3]], [['k3x9q0ab12cd-6', 'codex-b']]);
    });
    sink.seed(observed([['k3x9q0ab12cd-2', 1]]));
    sink.start();
    const scenario = (id: string): InboxEvent => ({
      kind: 'scenario',
      change: 'started',
      id,
      from: 'claude-a',
      to: 'room',
      ts: TS,
      text: 's',
      data: { scenario_id: id, title: '손들기', by: 'claude-a', plan: null, actor: null, verifier: null },
    });
    sink.push(scenario('k3x9q0ab12cd-2'));
    assert.equal(refreshed, 0, '아는 시나리오는 다시 받지 않는다');
    sink.push(scenario('k3x9q0ab12cd-4'));
    assert.equal(refreshed, 1);
    assert.match(lines[0] ?? '', /#1 손들기/);
    assert.match(lines[1] ?? '', /#3 손들기/);
    sink.push({
      kind: 'verification',
      change: null,
      id: 'v',
      from: 'claude-c',
      to: 'room',
      ts: TS,
      text: 'v',
      data: { claim_id: 'k3x9q0ab12cd-6', result: 'confirmed', by: 'claude-c', claim_status: 'confirmed' },
    });
    assert.match(lines[2] ?? '', /주장 k3x9q0ab12cd-6\(codex-b\) → 확인됨/);
  });
});
