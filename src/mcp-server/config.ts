// 환경 변수 해석 (architecture.md 5절). MCP 프로세스에서 환경 변수를 해석하는 곳은 이 파일 하나다.
// 값이 잘못돼도 실패하지 않는다. 시작이 실패하면 호스트에는 "서버 연결 실패"만 보인다.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LogLevel } from '../diagnostics/log-port.js';
import { checkPeerName, normalizeServerAddress, parseIceServers, randomLowerAlnum } from '../protocol/index.js';
import type { ChannelSetting, ConfigEnvName, ConfigProblem, LoadConfig } from './contract.js';
import { TOOL_INPUT_LIMITS } from './limits.js';

const DEFAULT_CLIENT = 'unknown';
const DEFAULT_CHANNEL: ChannelSetting = 'auto';
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_HOME_DIR_NAME = '.agent-chat';
const DEFAULT_NAME_PREFIX = 'agent-';
const DEFAULT_NAME_RANDOM_LENGTH = 6;

/** presence.client 는 다른 참가자에게 보인다. 짧은 식별자만 받는다. */
const CLIENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INTEGER_PATTERN = /^[0-9]{1,9}$/;
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function fallbackHome(homeDir: string | undefined): string {
  if (homeDir !== undefined && homeDir !== '') return join(homeDir, DEFAULT_HOME_DIR_NAME);
  try {
    return join(homedir(), DEFAULT_HOME_DIR_NAME);
  } catch {
    // 홈을 알 수 없는 환경이다. 기록 쓰기가 실패하면 notice.record_failed 로 드러난다.
    return DEFAULT_HOME_DIR_NAME;
  }
}

export const loadConfig: LoadConfig = (env, options = {}) => {
  const problems: ConfigProblem[] = [];
  /** 없거나 빈 값이면 null. 앞뒤 공백은 뗀다. */
  const read = (name: ConfigEnvName): string | null => {
    const value = env[name];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const defaulted = (name: ConfigEnvName, reason: string): void => {
    problems.push({ name, reason, effect: 'default_used' });
  };

  // 잘못된 서버 주소를 공용 서버로 바꿔 접속하지 않는다. server 인자 없이 부른 tool 이 거절한다.
  const defaultServer = read('AGENT_CHAT_SERVER');
  if (defaultServer !== null) {
    const address = normalizeServerAddress(defaultServer);
    if (!address.ok) problems.push({ name: 'AGENT_CHAT_SERVER', reason: address.detail, effect: 'rejected_on_use' });
  }

  let name: string | null = read('AGENT_CHAT_NAME');
  if (name !== null) {
    const checked = checkPeerName(name);
    if (!checked.ok) {
      defaulted('AGENT_CHAT_NAME', checked.detail);
      name = null;
    }
  }
  name ??= `${DEFAULT_NAME_PREFIX}${randomLowerAlnum(DEFAULT_NAME_RANDOM_LENGTH, options.randomBytes)}`;

  let client = read('AGENT_CHAT_CLIENT') ?? DEFAULT_CLIENT;
  if (!CLIENT_PATTERN.test(client)) {
    defaulted('AGENT_CHAT_CLIENT', 'must be 1-64 characters of letters, digits, ".", "_" or "-"');
    client = DEFAULT_CLIENT;
  }

  // ICE 설정은 기본값으로 바꾸지 않는다. 사용자가 고른 설정이 조용히 달라지면 안 된다.
  const iceRaw = read('AGENT_CHAT_ICE_SERVERS');
  const iceParsed = parseIceServers(iceRaw);
  if (!iceParsed.ok) {
    problems.push({ name: 'AGENT_CHAT_ICE_SERVERS', reason: iceParsed.detail, effect: 'rejected_on_use' });
  }

  let channel: ChannelSetting = DEFAULT_CHANNEL;
  const channelRaw = read('AGENT_CHAT_CHANNEL')?.toLowerCase();
  if (channelRaw === 'auto' || channelRaw === 'off') channel = channelRaw;
  else if (channelRaw !== undefined) defaulted('AGENT_CHAT_CHANNEL', 'must be auto or off');

  const waitRange = TOOL_INPUT_LIMITS.WAIT_MAX_SEC;
  let waitMaxSec: number = waitRange.default;
  const waitRaw = read('AGENT_CHAT_WAIT_MAX_SEC');
  if (waitRaw !== null) {
    if (!INTEGER_PATTERN.test(waitRaw)) {
      defaulted('AGENT_CHAT_WAIT_MAX_SEC', 'not an integer');
    } else {
      const parsed = Number.parseInt(waitRaw, 10);
      if (parsed < waitRange.min || parsed > waitRange.max) {
        defaulted('AGENT_CHAT_WAIT_MAX_SEC', `out of range ${waitRange.min}-${waitRange.max}`);
      } else {
        waitMaxSec = parsed;
      }
    }
  }

  let logLevel: LogLevel = DEFAULT_LOG_LEVEL;
  const levelRaw = read('AGENT_CHAT_LOG_LEVEL')?.toLowerCase();
  const level = LOG_LEVELS.find((candidate) => candidate === levelRaw);
  if (level !== undefined) logLevel = level;
  else if (levelRaw !== undefined) defaulted('AGENT_CHAT_LOG_LEVEL', 'must be debug, info, warn or error');

  // AGENT_CHAT_HOME 은 검사하지 않는다. 쓸 수 없는 경로면 기록 쓰기가 실패해 드러난다.
  const home = read('AGENT_CHAT_HOME') ?? fallbackHome(options.homeDir);

  return {
    config: {
      session: { defaultServer, name, client, iceServers: { raw: iceRaw, parsed: iceParsed }, home },
      channel,
      waitMaxSec,
      logLevel,
    },
    problems,
  };
};
