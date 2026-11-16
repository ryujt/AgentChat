// 채널 확인 기록 파일 (architecture.md 3.13). 실제 파일 시스템의 임시 폴더에 쓴다.
// 읽는 쪽(setup)과 같은 스키마(protocol.parseChannelCheck)로 다시 읽어 확인한다.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createFakeClock, createRecordingLog } from '../inbox/testing.js';
import { CHANNEL_CHECK_FILE_NAME, parseChannelCheck } from '../protocol/index.js';
import { createChannelCheckWriter } from './channel-check.js';
import type { HostInfo } from './channel-check.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-w5-check-'));
  roots.push(root);
  return root;
}

function setup(home: string, host: HostInfo | null = { name: 'claude-code', version: '2.1.325' }) {
  const clock = createFakeClock(Date.UTC(2026, 10, 15, 3, 0, 0));
  const log = createRecordingLog();
  const writer = createChannelCheckWriter({ home, now: clock.now, log, host: () => host });
  const read = () => parseChannelCheck(readFileSync(join(home, CHANNEL_CHECK_FILE_NAME), 'utf8'));
  return { clock, log, writer, read };
}

describe('channel-check.json', () => {
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('확인하면 호스트 정보와 확인 시각을 쓴다. 읽는 쪽의 스키마를 통과한다', async () => {
    const home = tempRoot();
    const { writer, read, log } = setup(home);
    writer.confirmed();
    await writer.idle();
    assert.deepEqual(read(), {
      ok: true,
      value: { v: 1, host: 'claude-code', host_version: '2.1.325', confirmed_at: '2026-11-15T03:00:00.000Z', fallback_at: null },
    });
    assert.deepEqual(log.named('channel_check.write').map((entry) => entry.fields), [{ outcome: 'confirmed' }]);
  });

  it('파일은 0600 이고 임시 파일이 남지 않는다', async () => {
    const home = tempRoot();
    const { writer } = setup(home);
    writer.confirmed();
    await writer.idle();
    assert.equal(statSync(join(home, CHANNEL_CHECK_FILE_NAME)).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(home), [CHANNEL_CHECK_FILE_NAME]);
  });

  it('poll 로 되돌아가면 확인 시각은 두고 되돌아간 시각을 쓴다', async () => {
    const home = tempRoot();
    const { writer, read, clock } = setup(home);
    writer.confirmed();
    clock.advance(125_000);
    writer.fellBack();
    await writer.idle();
    const result = read();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confirmed_at, '2026-11-15T03:00:00.000Z');
    assert.equal(result.value.fallback_at, '2026-11-15T03:02:05.000Z');
  });

  it('다시 확인하면 되돌아간 기록이 지워진다', async () => {
    const home = tempRoot();
    const { writer, read, clock } = setup(home);
    writer.confirmed();
    clock.advance(125_000);
    writer.fellBack();
    clock.advance(5_000);
    writer.confirmed();
    await writer.idle();
    const result = read();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confirmed_at, '2026-11-15T03:02:10.000Z');
    assert.equal(result.value.fallback_at, null);
    assert.deepEqual(readdirSync(home), [CHANNEL_CHECK_FILE_NAME]);
  });

  it('이 프로세스에서 확인한 적이 없으면 되돌아간 기록을 쓰지 않는다', async () => {
    const home = tempRoot();
    const { writer } = setup(home);
    writer.fellBack();
    await writer.idle();
    assert.deepEqual(readdirSync(home), []);
  });

  it('홈 디렉터리가 없으면 0700 으로 만든다', async () => {
    const home = join(tempRoot(), 'nested', 'agent-chat');
    const { writer, read } = setup(home);
    writer.confirmed();
    await writer.idle();
    assert.equal(read().ok, true);
    assert.equal(statSync(home).mode & 0o777, 0o700);
  });

  it('호스트 정보를 모르면 unknown 으로 쓴다. 제어 문자는 지우고 길이를 자른다', async () => {
    const home = tempRoot();
    const first = setup(home, null);
    first.writer.confirmed();
    await first.writer.idle();
    const unknown = first.read();
    assert.equal(unknown.ok && unknown.value.host, 'unknown');
    assert.equal(unknown.ok && unknown.value.host_version, 'unknown');

    const second = setup(home, { name: `host\u0000\n${'x'.repeat(500)}`, version: '' });
    second.writer.confirmed();
    await second.writer.idle();
    const cleaned = second.read();
    assert.equal(cleaned.ok, true);
    if (!cleaned.ok) return;
    assert.equal(cleaned.value.host.length, 200);
    assert.equal(/[\u0000-\u001f]/.test(cleaned.value.host), false);
    assert.equal(cleaned.value.host_version, 'unknown');
  });

  it('쓸 수 없는 경로면 던지지 않고 로그만 남긴다', async () => {
    const root = tempRoot();
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const { writer, log } = setup(join(blocker, 'home'));
    assert.doesNotThrow(() => writer.confirmed());
    await assert.doesNotReject(writer.idle());
    const failures = log.named('channel_check.write').filter((entry) => entry.fields.outcome === 'failed');
    assert.equal(failures.length, 1);
    assert.equal(typeof failures[0]?.fields.error_code, 'string');
    assert.equal(log.events.every((entry) => entry.level !== 'error'), true);
  });

  it('실패한 뒤에도 다음 쓰기는 된다', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    writeFileSync(home, 'x');
    const { writer, read } = setup(home);
    writer.confirmed();
    await writer.idle();
    rmSync(home);
    writer.confirmed();
    await writer.idle();
    assert.equal(read().ok, true);
  });
});
