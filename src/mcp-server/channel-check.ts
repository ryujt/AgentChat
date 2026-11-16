// 채널 확인 기록 파일 `<AGENT_CHAT_HOME>/channel-check.json` 을 쓴다 (architecture.md 3.13).
// 읽는 쪽은 설치 점검(setup)이다. 스키마는 protocol 이 갖는다.
// 쓰기 실패는 무시하고 로그만 남긴다. tool 결과를 기다리게 하지 않는다.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogPort } from '../diagnostics/log-port.js';
import {
  CHANNEL_CHECK_FILE_NAME,
  CHANNEL_CHECK_VERSION,
  randomLowerAlnum,
  serializeChannelCheck,
} from '../protocol/index.js';
import type { ChannelCheck, Now, RandomBytes } from '../protocol/index.js';

export interface HostInfo {
  readonly name: string;
  readonly version: string;
}

export interface ChannelCheckWriterDeps {
  /** AGENT_CHAT_HOME. 이 디렉터리 밖에는 쓰지 않는다. */
  readonly home: string;
  readonly now: Now;
  readonly log: LogPort;
  /** MCP 초기화 때 호스트가 준 클라이언트 정보. 아직 모르면 null. */
  readonly host: () => HostInfo | null;
  readonly randomBytes?: RandomBytes;
}

export interface ChannelCheckWriter {
  /** confirm_channel 이 성공했다. */
  confirmed(): void;
  /** 그 뒤 poll 로 되돌아갔다. */
  fellBack(): void;
  /** 걸려 있는 쓰기가 끝나면 resolve 한다. reject 하지 않는다. */
  idle(): Promise<void>;
}

const HOST_TEXT_MAX = 200;
const UNKNOWN_HOST = 'unknown';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function hostText(value: string | undefined): string {
  if (typeof value !== 'string') return UNKNOWN_HOST;
  // 호스트가 준 글을 그대로 믿지 않는다. 제어 문자를 지우고 길이를 자른다.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, HOST_TEXT_MAX);
  return cleaned === '' ? UNKNOWN_HOST : cleaned;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export function createChannelCheckWriter(deps: ChannelCheckWriterDeps): ChannelCheckWriter {
  const { home, now, log } = deps;
  const target = join(home, CHANNEL_CHECK_FILE_NAME);
  let confirmedAt: string | null = null;
  // 쓰기는 순서대로 한다. 확인 직후의 복귀가 앞의 쓰기를 덮어써야 한다.
  let chain: Promise<void> = Promise.resolve();

  function iso(): string {
    return new Date(now()).toISOString();
  }

  async function write(record: ChannelCheck): Promise<void> {
    const text = serializeChannelCheck(record);
    if (!text.ok) {
      log.event('warn', 'mcp-server', 'channel_check.write', { outcome: 'failed', error_code: text.code });
      return;
    }
    await mkdir(home, { recursive: true, mode: DIR_MODE });
    // 임시 파일에 쓰고 이름을 바꾼다. 읽는 쪽이 반쯤 쓴 파일을 보지 않는다.
    const temp = `${target}.${randomLowerAlnum(8, deps.randomBytes)}.tmp`;
    try {
      await writeFile(temp, text.value, { mode: FILE_MODE, flag: 'wx' });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    log.event('info', 'mcp-server', 'channel_check.write', { outcome: record.fallback_at === null ? 'confirmed' : 'fallback' });
  }

  function enqueue(record: ChannelCheck): void {
    chain = chain
      .then(() => write(record))
      .catch((error: unknown) => {
        log.event('warn', 'mcp-server', 'channel_check.write', { outcome: 'failed', error_code: errorCode(error) });
      });
  }

  function record(confirmed: string, fallbackAt: string | null): ChannelCheck {
    const host = deps.host();
    return {
      v: CHANNEL_CHECK_VERSION,
      host: hostText(host?.name),
      host_version: hostText(host?.version),
      confirmed_at: confirmed,
      fallback_at: fallbackAt,
    };
  }

  return {
    confirmed() {
      confirmedAt = iso();
      enqueue(record(confirmedAt, null));
    },
    fellBack() {
      // 이 프로세스에서 확인한 적이 없으면 되돌아갈 것도 없다.
      if (confirmedAt === null) return;
      enqueue(record(confirmedAt, iso()));
    },
    idle: () => chain,
  };
}
