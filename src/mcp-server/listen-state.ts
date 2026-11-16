// 수신 상태 파일 `<AGENT_CHAT_HOME>/listen/<pid>.json` 을 쓴다(개선안 P5, mcp-interface.md 7.4).
// 읽는 쪽은 사용자가 켠 Claude Code 의 Stop hook(setup 의 stop-hook)이다. 스키마는 protocol 이 갖는다.
// 쓰기 실패는 무시하고 로그만 남긴다. tool 결과를 기다리게 하지 않는다. 내용이 바뀔 때만 쓴다.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogPort } from '../diagnostics/log-port.js';
import { LISTEN_STATE_DIR_NAME, LISTEN_STATE_VERSION, serializeListenState } from '../protocol/index.js';
import type { ListenState, Now } from '../protocol/index.js';

/** 파일에 싣는 값 가운데 시각과 프로세스 번호를 뺀 것. */
export type ListenFacts = Omit<ListenState, 'v' | 'pid' | 'ppid' | 'updated_at'>;

export interface ListenStateWriterDeps {
  /** AGENT_CHAT_HOME. 이 디렉터리 밖에는 쓰지 않는다. */
  readonly home: string;
  readonly pid: number;
  readonly ppid: number;
  readonly now: Now;
  readonly log: LogPort;
}

export interface ListenStateWriter {
  /** 지금 값을 쓴다. 앞에 쓴 값과 같으면 쓰지 않는다. */
  update(facts: ListenFacts): void;
  /** 파일을 지운다(프로세스 종료). 이후의 update 는 쓰지 않는다. */
  remove(): void;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export function createListenStateWriter(deps: ListenStateWriterDeps): ListenStateWriter {
  const dir = join(deps.home, LISTEN_STATE_DIR_NAME);
  const target = join(dir, `${deps.pid}.json`);
  let last = '';
  let removed = false;

  return {
    update(facts) {
      if (removed) return;
      const key = JSON.stringify(facts);
      if (key === last) return;
      const text = serializeListenState({
        v: LISTEN_STATE_VERSION,
        pid: deps.pid,
        ppid: deps.ppid,
        updated_at: new Date(deps.now()).toISOString(),
        ...facts,
      });
      if (!text.ok) {
        deps.log.event('warn', 'mcp-server', 'listen_state.write', { outcome: 'failed', error_code: text.code });
        return;
      }
      // 작은 파일이고 hook 이 바로 읽는다. 동기로 쓰고 이름을 바꿔, 반쯤 쓴 파일이나 뒤바뀐 순서가 없게 한다.
      const temp = `${target}.tmp`;
      try {
        mkdirSync(dir, { recursive: true, mode: DIR_MODE });
        writeFileSync(temp, text.value, { mode: FILE_MODE });
        renameSync(temp, target);
        last = key;
      } catch (error) {
        rmSync(temp, { force: true });
        deps.log.event('warn', 'mcp-server', 'listen_state.write', { outcome: 'failed', error_code: errorCode(error) });
      }
    },
    remove() {
      if (removed) return;
      removed = true;
      try {
        rmSync(target, { force: true });
      } catch {
        // 종료 중이다. 남은 파일은 hook 이 프로세스가 없다고 보고 무시한다.
      }
    },
  };
}
