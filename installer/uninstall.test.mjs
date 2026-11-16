// installer/uninstall.sh: Stop hook 끄기, MCP 등록 제거, --purge 의 기록 지우기.
// 임시 HOME·설정 폴더와 없는 호스트 CLI 로 실행한다. 실제 사용자 홈과 호스트 등록을 건드리지 않는다.
// 실행: 빌드한 뒤 `node --test installer/uninstall.test.mjs`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./uninstall.sh', import.meta.url));
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'agent chat uninstall '));
  roots.push(root);
  const data = join(root, 'data');
  const claude = join(root, 'claude');
  mkdirSync(join(data, 'rooms'), { recursive: true });
  mkdirSync(claude);
  const settings = join(claude, 'settings.json');
  const ours = { type: 'command', command: "exec '/usr/bin/node' '/x/dist/entry/cli.js' stop-hook check --max-min 60" };
  const other = { type: 'command', command: 'echo done' };
  writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [ours] }, { hooks: [other] }] } }));
  const env = {
    ...process.env,
    HOME: root,
    AGENT_CHAT_HOME: data,
    CLAUDE_CONFIG_DIR: claude,
    AGENT_CHAT_CLAUDE_BIN: join(root, 'no-claude'),
    AGENT_CHAT_CODEX_BIN: join(root, 'no-codex'),
  };
  const run = (...args) => spawnSync('/bin/sh', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { root, data, settings, other, env, run };
}

describe('installer/uninstall.sh', () => {
  test('POSIX sh, set -eu 이고 실행 권한이 있다. 문법 검사를 통과한다', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    assert.ok(text.startsWith('#!/bin/sh\n'));
    assert.match(text, /\nset -eu\n/);
    assert.equal(statSync(SCRIPT).mode & 0o111, 0o111);
    assert.equal(spawnSync('/bin/sh', ['-n', SCRIPT]).status, 0);
  });

  test('모르는 인자는 사용법과 함께 1 로 끝나고 아무 것도 바꾸지 않는다', () => {
    const box = sandbox();
    const before = readFileSync(box.settings, 'utf8');
    for (const args of [['--bogus'], ['--client'], ['--client', 'vim']]) {
      const result = box.run(...args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /사용법: uninstall\.sh/);
    }
    assert.equal(readFileSync(box.settings, 'utf8'), before);
  });

  test('Stop hook 만 빼고 다른 설정과 hook 은 남긴다. 기록은 기본으로 남긴다', () => {
    const box = sandbox();
    const result = box.run();
    assert.match(result.stdout, /Stop hook 을 껐다/);
    assert.deepEqual(JSON.parse(readFileSync(box.settings, 'utf8')), { model: 'opus', hooks: { Stop: [{ hooks: [box.other] }] } });
    assert.ok(existsSync(box.data), '--purge 없이는 기록을 지우지 않는다');
    assert.match(result.stdout, /기록은 남겼다/);
  });

  test('--client codex 는 Claude Code 의 Stop hook 을 건드리지 않는다', () => {
    const box = sandbox();
    const before = readFileSync(box.settings, 'utf8');
    box.run('--client', 'codex');
    assert.equal(readFileSync(box.settings, 'utf8'), before);
  });

  test('--purge 는 AGENT_CHAT_HOME 을 지운다. 홈 폴더 자체는 지우지 않는다', () => {
    const box = sandbox();
    box.run('--purge');
    assert.equal(existsSync(box.data), false);

    const unsafe = sandbox();
    const result = spawnSync('/bin/sh', [SCRIPT, '--purge'], { encoding: 'utf8', env: { ...unsafe.env, AGENT_CHAT_HOME: unsafe.root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /안전하지 않은 경로/);
    assert.ok(existsSync(unsafe.root));
  });
});
