// 선택형 Stop hook (개선안 P5): 판정, 설정 파일 편집, 명령 인자.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LISTEN_STATE_DIR_NAME } from '../protocol/index.js';
import type { ListenState } from '../protocol/index.js';
import { parseCliArgs } from './cli.js';
import {
  STOP_HOOK_MARKER,
  applyStopHook,
  decideStop,
  installedStopHook,
  parseCheckArgs,
  readListenStates,
  runStopHookCommand,
  stopHookCommand,
} from './stop-hook.js';

const NOW = Date.parse('2026-11-16T02:00:00.000Z');
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-chat-hook-'));
  dirs.push(dir);
  return dir;
}

function state(overrides: Partial<ListenState> = {}): ListenState {
  return {
    v: 1,
    pid: 500,
    ppid: 100,
    updated_at: '2026-11-16T01:59:00.000Z',
    in_room: true,
    delivery_mode: 'poll',
    listening: false,
    paused: false,
    report_written: false,
    test_stopped: false,
    entered_at: '2026-11-16T01:30:00.000Z',
    ...overrides,
  };
}

const decide = (states: ListenState[], hostPid = 100, maxMin = 60) =>
  decideStop({ states, hostPid, alive: () => true, now: NOW, maxMin });

describe('Stop hook 판정', () => {
  it('같은 호스트의 MCP 가 poll 로 방에 있으면 막는다. 보고서를 썼거나 테스트가 끝나도 퇴실 전까지는 막는다', () => {
    const decision = decide([state()]);
    assert.equal(decision.block, true);
    assert.equal(decide([state({ report_written: true, test_stopped: true })]).block, true);
    assert.ok(decision.block && decision.reason.includes('wait_for_messages'));
  });

  it('끝낼 조건이면 막지 않는다', () => {
    const cases: [Partial<ListenState>, string][] = [
      [{ in_room: false, entered_at: null }, 'not_in_room'],
      [{ delivery_mode: 'channel' }, 'channel_mode'],
      [{ paused: true }, 'paused'],
      [{ entered_at: '2026-11-16T00:59:59.000Z' }, 'max_time'],
    ];
    for (const [overrides, why] of cases) assert.deepEqual(decide([state(overrides)]), { block: false, why });
  });

  it('다른 호스트(다른 세션)의 파일이나 죽은 프로세스의 파일은 보지 않는다', () => {
    assert.deepEqual(decide([state({ ppid: 999 })]), { block: false, why: 'no_session' });
    assert.deepEqual(decideStop({ states: [state()], hostPid: 100, alive: () => false, now: NOW, maxMin: 60 }), {
      block: false,
      why: 'no_session',
    });
  });

  it('상태 파일을 읽고 죽은 프로세스의 파일은 지운다', () => {
    const home = tempDir();
    const dir = join(home, LISTEN_STATE_DIR_NAME);
    mkdirSync(dir);
    writeFileSync(join(dir, '500.json'), JSON.stringify(state()));
    writeFileSync(join(dir, '501.json'), JSON.stringify(state({ pid: 501 })));
    writeFileSync(join(dir, '502.json'), '{broken');
    const states = readListenStates(home, (pid) => pid === 500);
    assert.deepEqual(states.map((entry) => entry.pid), [500]);
    assert.deepEqual(readdirSync(dir).sort(), ['500.json', '502.json']);
    assert.deepEqual(readListenStates(join(home, 'missing')), []);
  });

  it('check 인자: 잘못된 값은 기본값으로 둔다', () => {
    assert.deepEqual(parseCheckArgs(['--home', '/h', '--max-min', '30'], '/d'), { home: '/h', maxMin: 30 });
    assert.deepEqual(parseCheckArgs(['--max-min', 'x'], '/d'), { home: '/d', maxMin: 60 });
  });
});

describe('Stop hook 설정', () => {
  const command = stopHookCommand('/usr/bin/node', "/opt/agent chat/dist/entry/cli.js", "/home/o'neil/.agent-chat", 45);

  it('명령은 exec 로 node 를 띄우고 경로를 따옴표로 감싼다', () => {
    assert.equal(
      command,
      `exec '/usr/bin/node' '/opt/agent chat/dist/entry/cli.js' ${STOP_HOOK_MARKER} --home '/home/o'\\''neil/.agent-chat' --max-min 45`,
    );
  });

  it('넣고 빼도 다른 설정과 다른 hook 은 그대로다. 두 번 넣어도 하나다', () => {
    const other = { hooks: [{ type: 'command', command: 'echo done' }] };
    const base = { model: 'opus', hooks: { Stop: [other], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
    const once = applyStopHook(base, command);
    const twice = applyStopHook(once, command);
    assert.deepEqual(twice, once);
    assert.equal(installedStopHook(twice), command);
    assert.equal((twice['hooks'] as { Stop: unknown[] }).Stop.length, 2);
    const removed = applyStopHook(twice, null);
    assert.deepEqual(removed, base);
    assert.deepEqual(applyStopHook({ hooks: { Stop: [] } }, null), {});
  });

  it('on / status / off 는 설정 파일을 고치고, 고치기 전 파일을 백업한다', () => {
    const root = tempDir();
    const settingsPath = join(root, 'claude', 'settings.json');
    const lines: string[] = [];
    const deps = {
      settingsPath,
      backupDir: join(root, 'backups'),
      home: join(root, 'home'),
      nodePath: '/usr/bin/node',
      cliPath: '/app/dist/entry/cli.js',
      platform: 'darwin',
      now: NOW,
      out: (line: string) => lines.push(line),
    };
    assert.equal(runStopHookCommand(deps, { kind: 'on', maxMin: 30 }), 0);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(installedStopHook(written)?.includes('--max-min 30'));
    assert.equal(existsSync(deps.backupDir), false, '없던 파일은 백업할 것이 없다');
    assert.equal(runStopHookCommand(deps, { kind: 'status' }), 0);
    assert.ok(lines.some((line) => line.startsWith('Stop hook: 켜짐')));
    assert.equal(runStopHookCommand(deps, { kind: 'off' }), 0);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {});
    assert.equal(readdirSync(deps.backupDir).length, 1);
    writeFileSync(settingsPath, '{oops');
    assert.equal(runStopHookCommand(deps, { kind: 'on', maxMin: 30 }), 1);
    assert.equal(readFileSync(settingsPath, 'utf8'), '{oops', '읽지 못한 설정은 바꾸지 않는다');
    assert.equal(runStopHookCommand({ ...deps, platform: 'win32', settingsPath: join(root, 'w.json') }, { kind: 'on', maxMin: 30 }), 1);
  });

  it('CLI 인자', () => {
    assert.deepEqual(parseCliArgs(['stop-hook', 'on']), { kind: 'stop-hook', action: { kind: 'on', maxMin: 60 } });
    assert.deepEqual(parseCliArgs(['stop-hook', 'on', '--max-min', '90']), { kind: 'stop-hook', action: { kind: 'on', maxMin: 90 } });
    assert.deepEqual(parseCliArgs(['stop-hook', 'off']), { kind: 'stop-hook', action: { kind: 'off' } });
    assert.equal(parseCliArgs(['stop-hook', 'on', '--max-min', '0']).kind, 'invalid');
    assert.equal(parseCliArgs(['stop-hook']).kind, 'invalid');
  });
});
