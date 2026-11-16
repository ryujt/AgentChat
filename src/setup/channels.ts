// Channels 가능 여부 판정 (architecture.md 3.13 "Channels 판정표").
// 가능/불가/불명 가운데 하나와, 어느 행으로 판정했는지를 돌려준다. 호스트를 띄우거나 설정을 바꾸지 않는다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL_CHECK_FILE_NAME, parseChannelCheck, type ChannelCheck } from '../protocol/index.js';
import type { HostCliResult } from './host-cli.js';
import type { HostKind } from './types.js';

export type ChannelsResult = 'possible' | 'impossible' | 'unknown';

export const CHANNELS_LABEL: Readonly<Record<ChannelsResult, string>> = {
  possible: '가능',
  impossible: '불가',
  unknown: '불명',
};

/** 개발 채널 플래그로 시작하는 명령(mcp-interface.md 7.3). 설치는 안내만 하고 대신 실행하지 않는다. */
export const CHANNEL_START_COMMAND = 'claude --dangerously-load-development-channels server:agent-chat';

export type Version = readonly [number, number, number];

/** 채널을 지원하기 시작한 버전. */
const CHANNELS_MIN_VERSION: Version = [2, 1, 80];
/** API 키 로그인에서 채널을 쓸 수 있게 된 버전. */
const API_KEY_MIN_VERSION: Version = [2, 1, 128];

export type AuthInfo = { readonly kind: 'known'; readonly authMethod: string } | { readonly kind: 'unreadable' };

export type ManagedSettings =
  | { readonly kind: 'absent' }
  /** channelsEnabled 가 불리언이 아니면 undefined 다(키가 없거나 파일을 읽지 못했다). */
  | { readonly kind: 'present'; readonly channelsEnabled: boolean | undefined };

export interface ChannelsInput {
  readonly host: HostKind;
  /** `claude --version` 에서 읽은 버전. 읽지 못했으면 null. */
  readonly version: Version | null;
  /** 설치를 실행한 환경에 있는 공급자 변수의 이름. */
  readonly providerFlags: readonly string[];
  readonly auth: AuthInfo;
  readonly managed: ManagedSettings;
  /** `<AGENT_CHAT_HOME>/channel-check.json`. 없거나 읽지 못했으면 null. */
  readonly check: ChannelCheck | null;
}

export interface ChannelsVerdict {
  readonly result: ChannelsResult;
  /** 판정표의 행 번호. Codex 는 표를 쓰지 않아 null 이다. */
  readonly row: number | null;
  readonly reason: string;
  /** 결과에 붙이는 안내 문장. */
  readonly guidance: string;
}

export function parseVersion(text: string): Version | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function below(version: Version, limit: Version): boolean {
  for (let index = 0; index < 3; index += 1) {
    const left = version[index] as number;
    const right = limit[index] as number;
    if (left !== right) return left < right;
  }
  return false;
}

function text(version: Version): string {
  return version.join('.');
}

const GUIDE_POLL = 'poll 로 동작한다. 에이전트가 wait_for_messages 를 되풀이해 받는다.';
const GUIDE_UNKNOWN =
  `쓰려면 개발 채널 플래그(${CHANNEL_START_COMMAND})로 시작해 경고를 읽고 직접 승인한다. ` +
  "입장 뒤 점검이 통하면 다음 설치 점검부터 '가능'으로 나온다. 그 전까지는 poll 로 동작한다.";

function impossible(row: number, reason: string): ChannelsVerdict {
  return { result: 'impossible', row, reason, guidance: GUIDE_POLL };
}

function unknown(row: number, reason: string): ChannelsVerdict {
  return { result: 'unknown', row, reason, guidance: GUIDE_UNKNOWN };
}

/** 판정표를 위에서부터 보고 처음 맞는 행을 돌려준다. */
export function judgeChannels(input: ChannelsInput): ChannelsVerdict {
  if (input.host === 'codex') {
    return { result: 'impossible', row: null, reason: '채널이 없다', guidance: 'poll 로 받는다.' };
  }
  const { version, auth, managed, check } = input;
  if (version !== null && below(version, CHANNELS_MIN_VERSION)) {
    return impossible(1, `Claude Code ${text(version)} 은 ${text(CHANNELS_MIN_VERSION)} 미만이다`);
  }
  if (input.providerFlags.length > 0) {
    return impossible(2, `${input.providerFlags.join(', ')} 가 설정돼 있다`);
  }
  if (auth.kind === 'known' && auth.authMethod === 'third_party') {
    return impossible(3, '로그인 방식이 third_party 다');
  }
  if (auth.kind === 'known' && (auth.authMethod === 'api_key' || auth.authMethod === 'api_key_helper') && version !== null && below(version, API_KEY_MIN_VERSION)) {
    return impossible(4, `로그인 방식이 ${auth.authMethod} 이고 Claude Code ${text(version)} 은 ${text(API_KEY_MIN_VERSION)} 미만이다`);
  }
  if (auth.kind === 'unreadable' || auth.authMethod === 'none') {
    return unknown(5, '로그인 상태를 알 수 없다');
  }
  if (managed.kind === 'present' && managed.channelsEnabled === false) {
    return impossible(6, '관리형 설정이 channelsEnabled: false 다');
  }
  if (managed.kind === 'present' && managed.channelsEnabled === undefined) {
    return unknown(7, '관리형 설정 파일이 있고 channelsEnabled 가 없다. 조직 정책이 막을 수 있다');
  }
  if (check !== null && version !== null && /claude/i.test(check.host) && check.host_version === text(version)) {
    // 되돌아간 뒤에 다시 확인했으면 확인 시각이 더 늦다.
    const fellBack = check.fallback_at !== null && Date.parse(check.fallback_at) >= Date.parse(check.confirmed_at);
    if (!fellBack) {
      return {
        result: 'possible',
        row: 8,
        reason: `이 PC 에서 Claude Code ${text(version)} 로 채널 점검이 통했다`,
        guidance: `마지막 확인 시각: ${check.confirmed_at}`,
      };
    }
  }
  return unknown(9, '서버 관리형 정책, 계정 종류, 기능 공개 여부는 로컬에서 알 수 없다');
}

/** `claude auth status` 의 JSON 출력에서 로그인 방식을 읽는다. 로그인하지 않았으면 종료 코드가 1 이어도 출력은 있다. */
export function parseAuthStatus(result: HostCliResult): AuthInfo {
  if (result.outcome !== 'exit') return { kind: 'unreadable' };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === 'object' && parsed !== null && 'authMethod' in parsed) {
      const method = (parsed as { authMethod: unknown }).authMethod;
      if (typeof method === 'string' && method !== '') return { kind: 'known', authMethod: method };
    }
  } catch {
    // 아래에서 읽지 못한 것으로 돌려준다.
  }
  return { kind: 'unreadable' };
}

/** 관리형 설정 파일의 위치. OS 마다 다르다. */
export function managedSettingsPath(platform: string): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/** 관리형 설정 파일을 읽기만 한다. */
export function readManagedSettings(path: string): ManagedSettings {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    // 파일은 있는데 읽지 못하면 "있다"로 본다. 정책이 있는데 없다고 보고하지 않는다.
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'present', channelsEnabled: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'channelsEnabled' in parsed) {
      const value = (parsed as { channelsEnabled: unknown }).channelsEnabled;
      if (typeof value === 'boolean') return { kind: 'present', channelsEnabled: value };
    }
  } catch {
    // 형식이 틀린 파일도 "있다"로 본다.
  }
  return { kind: 'present', channelsEnabled: undefined };
}

/** 확인 기록 파일을 읽는다. 없거나 형식이 틀리면 null. */
export function readChannelCheck(home: string): ChannelCheck | null {
  try {
    const parsed = parseChannelCheck(readFileSync(join(home, CHANNEL_CHECK_FILE_NAME), 'utf8'));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}
