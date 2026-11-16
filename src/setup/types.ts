// setup 안에서 함께 쓰는 값과 타입 (architecture.md 3.13).

import type { LogPort } from '../diagnostics/log-port.js';

/** 설치가 다루는 에이전트 호스트. */
export type HostKind = 'claude' | 'codex' | 'gemini';

export const HOSTS: readonly HostKind[] = ['claude', 'codex', 'gemini'];

/** 사람에게 보이는 호스트 이름. */
export const HOST_LABEL: Readonly<Record<HostKind, string>> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };

/** MCP 등록 이름. 채널 플래그의 `server:<이름>` 과 같아야 한다(mcp-interface.md 1절). */
export const SERVER_NAME = 'agent-chat';

/** 패키지 뿌리 기준 MCP 진입점. */
export const MCP_ENTRY_SEGMENTS: readonly string[] = ['dist', 'entry', 'mcp.js'];

export const MIN_NODE_MAJOR = 22;

/** 단계 결과. warn 은 doctor 의 D7 만 쓴다(실패가 아니다). */
export type Outcome = 'pass' | 'fail' | 'skip' | 'action' | 'warn';

export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  pass: '통과',
  fail: '실패',
  skip: '건너뜀',
  action: '사용자 조치 필요',
  warn: '경고',
};

export interface StepNote {
  readonly host?: HostKind;
  /** 결과 뒤에 붙이는 짧은 설명. 환경 변수 값과 토큰을 넣지 않는다. */
  readonly detail?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

/** 단계 결과를 사람에게 보이고 진단 로그에 남긴다. */
export interface Reporter {
  step(id: string, title: string, outcome: Outcome, note?: StepNote): void;
  check(id: string, title: string, outcome: Outcome, note?: StepNote): void;
  line(text?: string): void;
  /** 지금까지의 결과 수. */
  count(outcome: Outcome): number;
}

export function createReporter(out: (line: string) => void, log: LogPort): Reporter {
  const counts: Record<Outcome, number> = { pass: 0, fail: 0, skip: 0, action: 0, warn: 0 };
  /** shown 은 줄 머리에 보이는 번호(`[6]`, `  D3`), id 는 로그에 남기는 번호다. */
  const emit = (event: 'setup.step' | 'doctor.check', shown: string, id: string, title: string, outcome: Outcome, note: StepNote): void => {
    counts[outcome] += 1;
    const subject = note.host === undefined ? title : `${title} (${HOST_LABEL[note.host]})`;
    const detail = note.detail === undefined || note.detail === '' ? '' : ` — ${note.detail}`;
    out(`${shown} ${subject}: ${OUTCOME_LABEL[outcome]}${detail}`);
    // 실패도 info 로 남긴다. 파일 로거는 warn 이상을 stderr 에도 쓰는데, 설치의 실패는 이미 위 줄로 사람에게 보였다.
    log.event('info', 'setup', event, {
      step: id,
      outcome,
      host: note.host,
      error_code: note.errorCode,
      duration_ms: note.durationMs,
    });
  };
  return {
    step: (id, title, outcome, note = {}) => emit('setup.step', `[${id}]`, id, title, outcome, note),
    check: (id, title, outcome, note = {}) => emit('doctor.check', `  ${id}`, id, title, outcome, note),
    line: (text = '') => out(text),
    count: (outcome) => counts[outcome],
  };
}

/** `22.4.1` 같은 버전 글에서 큰 번호를 얻는다. 읽지 못하면 null. */
export function nodeMajorOf(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version);
  return match === null ? null : Number(match[1]);
}
