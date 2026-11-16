// 수신 상태 파일 (개선안 P5): mcp-server 가 tool 호출과 수신 상태 변화마다 맞추고, 종료 때 지운다.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LISTEN_STATE_DIR_NAME, parseListenState } from '../protocol/index.js';
import type { ListenState } from '../protocol/index.js';
import { createRecordingLog } from '../inbox/testing.js';
import { createListenStateWriter } from './listen-state.js';
import { createMcpApp } from './server.js';
import { createTestBed } from './testing.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-chat-listen-'));
  dirs.push(dir);
  return dir;
}

function read(home: string, pid: number): ListenState {
  const parsed = parseListenState(readFileSync(join(home, LISTEN_STATE_DIR_NAME, `${pid}.json`), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}

describe('수신 상태 파일', () => {
  it('바뀔 때만 쓰고, remove 뒤에는 쓰지 않는다', () => {
    const home = tempHome();
    const log = createRecordingLog();
    const writer = createListenStateWriter({ home, pid: 42, ppid: 7, now: () => 1_000, log });
    const facts = {
      in_room: true,
      delivery_mode: 'poll' as const,
      listening: true,
      paused: false,
      report_written: false,
      test_stopped: false,
      entered_at: '2026-11-16T01:00:00.000Z',
    };
    writer.update(facts);
    assert.deepEqual(read(home, 42), { v: 1, pid: 42, ppid: 7, updated_at: new Date(1_000).toISOString(), ...facts });
    writer.remove();
    assert.equal(existsSync(join(home, LISTEN_STATE_DIR_NAME, '42.json')), false);
    writer.update({ ...facts, listening: false });
    assert.equal(existsSync(join(home, LISTEN_STATE_DIR_NAME, '42.json')), false);
  });

  it('입장, 멈춤, 보고서, 퇴장을 따라 적는다', async () => {
    const home = tempHome();
    const bed = createTestBed({ home });
    const app = createMcpApp({ ...bed.deps, listenState: { pid: 4242, ppid: 77 } });
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-host', version: '1' }, { capabilities: {} });
    await app.mcp.connect(serverSide);
    await client.connect(clientSide);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

    await call('create_room');
    let state = read(home, 4242);
    assert.deepEqual([state.ppid, state.in_room, state.paused, state.report_written], [77, true, false, false]);
    assert.notEqual(state.entered_at, null);
    await call('wait_for_messages', { timeout_sec: 0 });
    assert.equal(read(home, 4242).listening, true);
    await call('set_status', { listening: false });
    state = read(home, 4242);
    assert.deepEqual([state.listening, state.paused], [false, true]);
    await call('write_report');
    assert.equal(read(home, 4242).report_written, true);
    await call('leave_room');
    state = read(home, 4242);
    assert.deepEqual([state.in_room, state.entered_at], [false, null]);

    await client.close();
    await app.mcp.close();
    bed.inbox.close();
  });
});
