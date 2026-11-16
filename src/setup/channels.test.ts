// Channels 판정표의 모든 행 (architecture.md 3.13). 위에서부터 처음 맞는 행으로 판정한다.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ChannelCheck } from '../protocol/index.js';
import {
  CHANNEL_START_COMMAND,
  judgeChannels,
  managedSettingsPath,
  parseAuthStatus,
  parseVersion,
  readChannelCheck,
  readManagedSettings,
  type ChannelsInput,
} from './channels.js';
import type { HostCliResult } from './host-cli.js';

const CHECK: ChannelCheck = { v: 1, host: 'claude-code', host_version: '2.1.325', confirmed_at: '2026-11-15T03:00:00Z', fallback_at: null };

/** 어느 행에도 걸리지 않는 입력. 9행(그 밖)으로 간다. */
const BASE: ChannelsInput = {
  host: 'claude',
  version: [2, 1, 325],
  providerFlags: [],
  auth: { kind: 'known', authMethod: 'claude.ai' },
  managed: { kind: 'absent' },
  check: null,
};

function judge(overrides: Partial<ChannelsInput>): { result: string; row: number | null } {
  const verdict = judgeChannels({ ...BASE, ...overrides });
  assert.notEqual(verdict.reason, '');
  assert.notEqual(verdict.guidance, '');
  return { result: verdict.result, row: verdict.row };
}

describe('channels: 판정표', () => {
  it('1행: 2.1.80 미만이면 불가', () => {
    assert.deepEqual(judge({ version: [2, 1, 79] }), { result: 'impossible', row: 1 });
    assert.deepEqual(judge({ version: [2, 0, 999] }), { result: 'impossible', row: 1 });
    assert.deepEqual(judge({ version: [1, 9, 0] }), { result: 'impossible', row: 1 });
    assert.equal(judge({ version: [2, 1, 80] }).row, 9);
  });

  it('2행: 공급자 변수가 있으면 불가', () => {
    for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      assert.deepEqual(judge({ providerFlags: [flag] }), { result: 'impossible', row: 2 }, flag);
    }
  });

  it('3행: 로그인 방식이 third_party 면 불가', () => {
    assert.deepEqual(judge({ auth: { kind: 'known', authMethod: 'third_party' } }), { result: 'impossible', row: 3 });
  });

  it('4행: API 키 로그인이고 2.1.128 미만이면 불가', () => {
    for (const authMethod of ['api_key', 'api_key_helper']) {
      assert.deepEqual(judge({ auth: { kind: 'known', authMethod }, version: [2, 1, 127] }), { result: 'impossible', row: 4 }, authMethod);
      assert.equal(judge({ auth: { kind: 'known', authMethod }, version: [2, 1, 128] }).row, 9, authMethod);
    }
    assert.equal(judge({ auth: { kind: 'known', authMethod: 'claude.ai' }, version: [2, 1, 127] }).row, 9);
  });

  it('5행: 로그인하지 않았거나 로그인 상태를 읽지 못하면 불명', () => {
    assert.deepEqual(judge({ auth: { kind: 'known', authMethod: 'none' } }), { result: 'unknown', row: 5 });
    assert.deepEqual(judge({ auth: { kind: 'unreadable' } }), { result: 'unknown', row: 5 });
  });

  it('6행: 관리형 설정이 channelsEnabled: false 면 불가', () => {
    assert.deepEqual(judge({ managed: { kind: 'present', channelsEnabled: false } }), { result: 'impossible', row: 6 });
  });

  it('7행: 관리형 설정 파일이 있는데 channelsEnabled 가 없으면 불명', () => {
    assert.deepEqual(judge({ managed: { kind: 'present', channelsEnabled: undefined } }), { result: 'unknown', row: 7 });
    assert.equal(judge({ managed: { kind: 'present', channelsEnabled: true } }).row, 9);
  });

  it('8행: 같은 호스트 버전의 확인 기록이 있고 그 뒤 되돌아간 기록이 없으면 가능', () => {
    const verdict = judgeChannels({ ...BASE, check: CHECK });
    assert.deepEqual({ result: verdict.result, row: verdict.row }, { result: 'possible', row: 8 });
    assert.match(verdict.guidance, /2026-11-15T03:00:00Z/);
    // 되돌아간 뒤에 다시 확인한 기록도 가능이다.
    assert.equal(judge({ check: { ...CHECK, fallback_at: '2026-11-15T02:00:00Z' } }).row, 8);
    assert.equal(judge({ check: CHECK, managed: { kind: 'present', channelsEnabled: true } }).row, 8);
  });

  it('9행: 그 밖은 불명', () => {
    assert.deepEqual(judge({}), { result: 'unknown', row: 9 });
    assert.deepEqual(judge({ check: { ...CHECK, host_version: '2.1.300' } }), { result: 'unknown', row: 9 });
    assert.deepEqual(judge({ check: { ...CHECK, fallback_at: '2026-11-15T04:00:00Z' } }), { result: 'unknown', row: 9 });
    assert.deepEqual(judge({ check: { ...CHECK, fallback_at: CHECK.confirmed_at } }), { result: 'unknown', row: 9 });
    assert.deepEqual(judge({ check: { ...CHECK, host: 'codex' } }), { result: 'unknown', row: 9 });
    assert.deepEqual(judge({ version: null, check: CHECK }), { result: 'unknown', row: 9 });
  });

  it('위에서부터 처음 맞는 행을 쓴다', () => {
    const all: Partial<ChannelsInput> = {
      version: [2, 1, 70],
      providerFlags: ['CLAUDE_CODE_USE_BEDROCK'],
      auth: { kind: 'known', authMethod: 'third_party' },
      managed: { kind: 'present', channelsEnabled: false },
      check: CHECK,
    };
    assert.equal(judge(all).row, 1);
    assert.equal(judge({ ...all, version: [2, 1, 100] }).row, 2);
    assert.equal(judge({ ...all, version: [2, 1, 100], providerFlags: [] }).row, 3);
    assert.equal(judge({ ...all, version: [2, 1, 100], providerFlags: [], auth: { kind: 'known', authMethod: 'api_key' } }).row, 4);
    assert.equal(judge({ ...all, version: [2, 1, 325], providerFlags: [], auth: { kind: 'unreadable' } }).row, 5);
    assert.equal(judge({ ...all, version: [2, 1, 325], providerFlags: [], auth: { kind: 'known', authMethod: 'claude.ai' } }).row, 6);
    assert.equal(judge({ ...BASE, managed: { kind: 'present', channelsEnabled: undefined }, check: CHECK }).row, 7);
  });

  it('불명의 안내에는 개발 채널 플래그가, 불가의 안내에는 poll 이 든다', () => {
    assert.ok(judgeChannels(BASE).guidance.includes(CHANNEL_START_COMMAND));
    assert.match(judgeChannels({ ...BASE, version: [2, 1, 0] }).guidance, /poll/);
  });

  it('Codex 는 항상 불가이고 행 번호가 없다', () => {
    const verdict = judgeChannels({ ...BASE, host: 'codex', check: CHECK });
    assert.deepEqual({ result: verdict.result, row: verdict.row }, { result: 'impossible', row: null });
    assert.match(`${verdict.reason} ${verdict.guidance}`, /채널이 없다.*poll/);
  });
});

describe('channels: 입력 읽기', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-channels-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const exit = (code: number, stdout: string): HostCliResult => ({ outcome: 'exit', code, stdout, stderr: '', detail: '' });

  it('claude --version 의 버전을 읽는다', () => {
    assert.deepEqual(parseVersion('2.1.325 (Claude Code)'), [2, 1, 325]);
    assert.deepEqual(parseVersion('codex-cli 0.169.0'), [0, 169, 0]);
    assert.equal(parseVersion('unknown'), null);
  });

  it('claude auth status 의 authMethod 를 읽는다. 종료 코드가 1 이어도 출력이 있으면 읽는다', () => {
    assert.deepEqual(parseAuthStatus(exit(0, '{"loggedIn":true,"authMethod":"claude.ai","email":"x"}')), { kind: 'known', authMethod: 'claude.ai' });
    assert.deepEqual(parseAuthStatus(exit(1, '{"loggedIn":false,"authMethod":"none"}')), { kind: 'known', authMethod: 'none' });
    for (const output of ['', 'Not logged in', '{"loggedIn":true}', '{"authMethod":5}', '[]']) {
      assert.deepEqual(parseAuthStatus(exit(0, output)), { kind: 'unreadable' }, output);
    }
    assert.deepEqual(parseAuthStatus({ outcome: 'not-found', code: null, stdout: '', stderr: '', detail: '' }), { kind: 'unreadable' });
  });

  it('관리형 설정 파일을 읽는다', () => {
    const file = (name: string, content: string): string => {
      const path = join(root, name);
      writeFileSync(path, content);
      return path;
    };
    assert.deepEqual(readManagedSettings(join(root, 'none.json')), { kind: 'absent' });
    assert.deepEqual(readManagedSettings(file('off.json', '{"channelsEnabled":false}')), { kind: 'present', channelsEnabled: false });
    assert.deepEqual(readManagedSettings(file('on.json', '{"channelsEnabled":true}')), { kind: 'present', channelsEnabled: true });
    assert.deepEqual(readManagedSettings(file('other.json', '{"permissions":{}}')), { kind: 'present', channelsEnabled: undefined });
    assert.deepEqual(readManagedSettings(file('broken.json', '{')), { kind: 'present', channelsEnabled: undefined });
    assert.deepEqual(readManagedSettings(file('text.json', '{"channelsEnabled":"no"}')), { kind: 'present', channelsEnabled: undefined });
    mkdirSync(join(root, 'dir.json'));
    assert.deepEqual(readManagedSettings(join(root, 'dir.json')), { kind: 'present', channelsEnabled: undefined });
  });

  it('관리형 설정 파일의 위치는 OS 마다 다르다', () => {
    assert.equal(managedSettingsPath('darwin'), '/Library/Application Support/ClaudeCode/managed-settings.json');
    assert.equal(managedSettingsPath('linux'), '/etc/claude-code/managed-settings.json');
    assert.match(managedSettingsPath('win32'), /ClaudeCode\\managed-settings\.json$/);
  });

  it('확인 기록 파일을 읽는다. 없거나 형식이 틀리면 null 이다', () => {
    const home = join(root, 'home');
    mkdirSync(home);
    assert.equal(readChannelCheck(home), null);
    writeFileSync(join(home, 'channel-check.json'), JSON.stringify(CHECK));
    assert.deepEqual(readChannelCheck(home), CHECK);
    writeFileSync(join(home, 'channel-check.json'), '{"v":2}');
    assert.equal(readChannelCheck(home), null);
  });
});
