// V-U6: stdout 로거 (architecture.md 3.12, 6.3). 출력 자리는 가짜로 받는다. 실제 stdout 은 index.test.ts 가 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogFields, LogLevel, LogService } from './log-port.js';
import { createStdoutLoggerWith } from './stdout-logger.js';
import type { LineSink } from './stdout-logger.js';

const T0 = Date.UTC(2026, 10, 15, 9, 30, 0);

function rig(service: LogService = 'server', level: LogLevel = 'info') {
  const lines: string[] = [];
  const state = { guards: 0, fail: false };
  const sink: LineSink = {
    writeLine(line) {
      if (state.fail) throw new Error('EPIPE');
      lines.push(line);
    },
    guard() {
      state.guards += 1;
      return () => {
        state.guards -= 1;
      };
    },
  };
  const logger = createStdoutLoggerWith({ service, level, now: () => T0, randomBytes: (size) => new Uint8Array(size).fill(3) }, sink);
  return { logger, lines, state, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('V-U6 stdout 로거', () => {
  it('사건 하나를 JSON 한 줄로 쓰고 모든 줄에 proc 이 있다', () => {
    const r = rig();
    r.logger.event('info', 'signaling-core', 'room.join', { room_ref: '0123456789ab', members: 2 });
    r.logger.event('warn', 'signaling-selfhost', 'conn.reject', { reason: 'a\nb' });
    assert.equal(r.lines.length, 2);
    for (const line of r.lines) assert.ok(!line.includes('\n'));
    assert.match(r.logger.proc, /^[0-9a-z]{6}$/);
    assert.deepEqual(r.parsed()[0], {
      ts: '2026-11-15T09:30:00.000Z',
      level: 'info',
      svc: 'server',
      proc: r.logger.proc,
      mod: 'signaling-core',
      event: 'room.join',
      room_ref: '0123456789ab',
      members: 2,
    });
    assert.equal(r.parsed()[1]?.['proc'], r.logger.proc);
    assert.equal(r.parsed()[1]?.['reason'], 'a b');
  });

  it('svc 가 server·lambda 면 peer 를 출력하지 않고 mcp·cli 면 출력한다', () => {
    for (const [service, shown] of [['server', false], ['lambda', false], ['mcp', true], ['cli', true]] as const) {
      const r = rig(service);
      r.logger.event('info', 'signaling-core', 'x', { peer: 'alice', peer_ref: '0123456789ab' } as LogFields);
      assert.equal('peer' in (r.parsed()[0] ?? {}), shown, service);
      assert.equal(r.parsed()[0]?.['peer_ref'], '0123456789ab');
    }
  });

  it('level 보다 낮은 사건은 쓰지 않는다', () => {
    const r = rig('server', 'warn');
    for (const each of ['debug', 'info', 'warn', 'error'] as const) r.logger.event(each, 'signaling-core', each);
    assert.deepEqual(r.parsed().map((line) => line['level']), ['warn', 'error']);
  });

  it('허용 목록에 없는 필드는 쓰지 않는다', () => {
    const r = rig();
    r.logger.event('info', 'signaling-core', 'x', { sdp: 'v=0', frame: { body: 'x' }, kind: 'offer' } as LogFields);
    assert.deepEqual(Object.keys(r.parsed()[0] ?? {}), ['ts', 'level', 'svc', 'proc', 'mod', 'event', 'kind']);
  });

  it('close 뒤의 사건은 버리고 리스너를 뗀다. 여러 번 닫아도 된다', async () => {
    const r = rig();
    assert.equal(r.state.guards, 1);
    r.logger.event('info', 'signaling-core', 'before');
    await r.logger.close(100);
    await r.logger.close(0);
    r.logger.event('error', 'signaling-core', 'after');
    assert.deepEqual(r.parsed().map((line) => line['event']), ['before']);
    assert.equal(r.state.guards, 0);
  });

  it('출력이 던져도 호출자는 계속 간다', () => {
    const r = rig();
    r.state.fail = true;
    assert.doesNotThrow(() => r.logger.event('error', 'signaling-core', 'x'));
    r.state.fail = false;
    r.logger.event('info', 'signaling-core', 'y');
    assert.equal(r.lines.length, 1);
  });
});
