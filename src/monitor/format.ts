// 사람용 출력 (architecture.md 3.14 의 "출력 형식 — 사람용"). 한 사건 한 줄. `시각  종류  보낸이  내용`.
// 본문은 다른 참가자가 쓴 글이다. 터미널을 조작하는 글자(ESC, C0, C1, 양방향 제어)를 보이는 글자로 바꾼다.
// 색은 이 모듈이 넣는 것만 나간다. 방 ID 는 출력하지 않는다(RoomObserved 와 InboxEvent 에 방 ID 칸이 없다).
// 순수 함수들이다. 시각 문자열은 주입받은 style.clock 으로 만든다.

import type { InboxEvent } from '../inbox/contract.js';
import type { ObservedClaim, ParticipantView, RoomObserved } from '../room-session/contract.js';
import type { MonitorBook, MonitorStyle } from './contract.js';

/** 종류 칸의 표시 폭(한글 2칸). 가장 긴 이름(시나리오초과, 12칸)도 들어간다. */
export const KIND_WIDTH = 12;
/** 보낸이 칸의 표시 폭(뒤의 띄움 포함). 17칸까지의 이름이 맞춰진다. 넘으면 칸을 늘리지 않고 한 칸 띄운다. */
export const WHO_WIDTH = 18;
/** 시각(8) + 두 칸 + 종류 + 보낸이. 여러 줄 본문의 다음 줄은 여기서 `│ ` 로 잇는다. */
export const CONTENT_COLUMN = 8 + 2 + KIND_WIDTH + WHO_WIDTH;

// ── 터미널 안전 ─────────────────────────────────────────────────────────────

/**
 * 터미널이 해석하는 글자. 제어 문자(Cc: C0, DEL, C1. ESC 포함), 줄·문단 구분(U+2028, U+2029),
 * 양방향 제어(Bidi_Control: LRM·RLM·ALM, U+202A–U+202E, U+2066–U+2069).
 * 유니코드 속성으로 고른다. 소스에 보이지 않는 글자를 두지 않는다.
 */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;

/**
 * 다른 참가자가 쓴 글을 터미널에 그대로 써도 되는 글로 바꾼다. 줄바꿈(LF)은 남긴다(부르는 쪽이 다음 줄을 들여 잇는다).
 * CRLF 는 LF 로, 탭은 공백 두 칸으로 바꾼다. 나머지 제어 문자는 `\u{1b}` 처럼 보이는 글자로 바꾼다. 한글·이모지는 그대로다.
 */
export function toTerminalText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(UNSAFE, (char) => (char === '\n' ? char : `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`));
}

/**
 * JSON Lines 의 한 줄. JSON.stringify 는 C0 만 이스케이프하고 DEL, C1, U+2028·U+2029, 양방향 제어는 그대로 둔다.
 * 그 글자도 `\u00XX` 로 바꾼다(JSON 문자열 안의 이스케이프라 되읽으면 원래 글이다). 터미널로 흘려 보내도 안전하다.
 */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(UNSAFE, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);
}

/** 한 칸 안에 쓰는 글(이름, 역할, 제목). 줄바꿈도 보이는 글자로 바꾼다. */
export function oneLine(text: string): string {
  return toTerminalText(text).replace(/\n/g, '↵');
}

// ── 표시 폭 ─────────────────────────────────────────────────────────────────

const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const ZERO = /[\u0300-\u036F\u200B-\u200D\uFE00-\uFE0F]/u;

/** 터미널에서 차지하는 칸 수(동아시아 넓은 글자와 이모지는 2칸, 결합 문자는 0칸). 대략값이다. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (ZERO.test(char)) continue;
    width += WIDE.test(char) ? 2 : 1;
  }
  return width;
}

/** 표시 폭 width 까지 공백으로 채운다. 이미 넘으면 공백 하나를 붙인다(min 칸). */
export function padCell(text: string, width: number, min = 1): string {
  const used = displayWidth(text);
  return text + ' '.repeat(Math.max(min, width - used));
}

// ── 색 ──────────────────────────────────────────────────────────────────────

const SGR = {
  dim: '2',
  bold: '1',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
} as const;

type Tone = keyof typeof SGR;

function paint(style: MonitorStyle, tone: Tone | null, text: string): string {
  if (!style.color || tone === null || text === '') return text;
  return `\u001b[${SGR[tone]}m${text}\u001b[0m`;
}

// ── 사건 한 줄 ──────────────────────────────────────────────────────────────

const PEER_LABELS: Readonly<Record<string, string>> = {
  joined: '입장',
  left: '퇴장',
  disconnected: '끊김',
  reconnected: '재연결',
  unreachable: '닿지않음',
  role: '역할',
  ready: '준비',
  stopped_listening: '수신멈춤',
  listening: '수신재개',
  status: '상태',
  observer_joined: '관전입장',
  observer_left: '관전퇴장',
};

const CLAIM_STATUS: Readonly<Record<string, string>> = { confirmed: '확인됨', refuted: '반박됨', unverified: '미확인' };

/** 종류 칸의 이름. 사건 종류·change 의 모든 값에 이름이 있다. */
export function kindLabel(event: InboxEvent): string {
  switch (event.kind) {
    case 'chat':
      return '채팅';
    case 'peer':
      return PEER_LABELS[event.change] ?? '참가자';
    case 'test':
      return event.change === 'started' ? '테스트시작' : event.change === 'replaced' ? '테스트교체' : '중단';
    case 'scenario':
      return event.change === 'started' ? '시나리오' : '시나리오초과';
    case 'claim':
      return '주장';
    case 'verification':
      return '검증';
    case 'system':
      return '알림';
  }
}

function kindTone(event: InboxEvent): Tone {
  switch (event.kind) {
    case 'chat':
      return 'cyan';
    case 'peer':
      return event.change === 'observer_joined' || event.change === 'observer_left' ? 'magenta' : 'yellow';
    case 'test':
      return event.change === 'stopped' ? 'red' : 'magenta';
    case 'scenario':
      return 'blue';
    case 'claim':
      return event.data.outcome === 'fail' ? 'red' : 'green';
    case 'verification':
      return event.data.claim_status === 'refuted' ? 'red' : 'green';
    case 'system':
      return 'red';
  }
}

function roleSuffix(role: string | null | undefined): string {
  return role === null || role === undefined || role === '' ? '' : ` (역할 ${oneLine(role)})`;
}

function reasonSuffix(reason: string | undefined): string {
  return reason === undefined ? '' : ` (${oneLine(reason)})`;
}

function scenarioRef(book: MonitorBook, scenarioId: string): string {
  const index = book.scenarioIndex(scenarioId);
  return index === null ? `[${oneLine(scenarioId)}]` : `#${index}`;
}

/** 보낸이 칸. 채팅은 `보낸이 → 전체|나`. */
function whoOf(event: InboxEvent): string {
  if (event.kind === 'chat') {
    const from = event.data.observer === true ? `${oneLine(event.from)}(관전)` : oneLine(event.from);
    return `${from} → ${event.to === 'you' ? '나' : '전체'}`;
  }
  return oneLine(event.from);
}

const SYSTEM_TEXT: Readonly<Record<string, (data: Readonly<Record<string, unknown>>) => string>> = {
  inbox_dropped: (data) => `출력하지 못하고 버린 사건이 ${String(data['count'] ?? '?')}건 있다`,
  signaling_blocked: (data) => `시그널링 재접속이 막혔다${reasonSuffix(typeof data['reason'] === 'string' ? data['reason'] : undefined)}. 계속 시도한다. 열린 링크로 계속 본다`,
  signaling_detached: () => '시그널링 재접속을 멈췄다. 열린 링크로 계속 본다. 새 참가자는 보이지 않을 수 있다',
  name_conflict: () => '같은 이름의 다른 세션이 서버에 등록됐다',
  state_diverged: (data) => `${oneLine(String(data['peer'] ?? '?'))} 와 공유 상태가 맞춰지지 않는다`,
  record_failed: () => '로컬 기록 쓰기에 실패했다',
  clock_skew: (data) => `${oneLine(String(data['peer'] ?? '?'))} 의 시계가 60초 넘게 다르다. 시각이 어긋나 보일 수 있다`,
  observer_unaware: (data) =>
    `${oneLine(String(data['peer'] ?? '?'))} 는 관전자를 모르는 구버전이다. 그쪽에는 관전 사실이 표시되지 않는다`,
};

/** 사건의 내용 칸(여러 줄일 수 있다). */
function contentOf(event: InboxEvent, book: MonitorBook): string {
  switch (event.kind) {
    case 'chat':
      return toTerminalText(event.text);
    case 'peer': {
      const data = event.data;
      switch (event.change) {
        case 'joined':
          return `방에 들어왔다${roleSuffix(data.role)}${data.status ? ` 상태 ${oneLine(data.status)}` : ''}`;
        case 'left':
          return `방에서 나갔다${reasonSuffix(data.reason)}`;
        case 'disconnected':
          return `링크가 끊겼다${reasonSuffix(data.reason)}`;
        case 'reconnected':
          return '링크가 다시 열렸다';
        case 'unreachable':
          return `직접 연결을 열지 못했다${reasonSuffix(data.reason)}. 그 참가자의 글은 보이지 않는다`;
        case 'role':
          return `역할 → ${data.role === null || data.role === undefined ? '없음' : oneLine(data.role)}`;
        case 'ready':
          return `준비됐다${roleSuffix(data.role)}`;
        case 'stopped_listening':
          return `에이전트가 방을 듣지 않는다${data.since === undefined ? '' : ` (${oneLine(data.since)} 부터)`}. 답이 늦을 수 있다`;
        case 'listening':
          return '에이전트가 다시 방을 듣는다';
        case 'status':
          return `${oneLine(data.status ?? '?')}${roleSuffix(data.role)}`;
        case 'observer_joined':
          return '관전을 시작했다(읽기 전용)';
        case 'observer_left':
          return `관전을 끝냈다${reasonSuffix(data.reason)}`;
      }
      // 모든 change 를 위에서 다룬다. 새 값이 생기면 컴파일이 여기서 알린다.
      return event satisfies never;
    }
    case 'test': {
      const data = event.data;
      if (event.change === 'stopped') {
        return data.reason === 'time_limit' ? '기한에 닿아 중단됐다' : `사용자 중단: ${toTerminalText(data.detail ?? '')}`;
      }
      const head = event.change === 'replaced' ? '테스트가 바뀌었다. ' : '';
      return `${head}제한 ${data.limits.max_duration_min}분·시나리오 ${data.limits.max_scenarios}개 [${oneLine(data.test_id)}]\n요청: ${toTerminalText(data.request)}`;
    }
    case 'scenario': {
      const data = event.data;
      const head = `${scenarioRef(book, data.scenario_id)} ${oneLine(data.title)}`;
      if (event.change === 'over_limit') return `${head}  시나리오 한도를 넘어 주장을 붙일 수 없다`;
      const roles = `행동=${data.actor === null ? '-' : oneLine(data.actor)} 검증=${data.verifier === null ? '-' : oneLine(data.verifier)}`;
      return data.plan === null ? `${head}  ${roles}` : `${head}  ${roles}\n계획: ${toTerminalText(data.plan)}`;
    }
    case 'claim': {
      const data = event.data;
      const late = data.late ? ' (중단 뒤 기록)' : '';
      const lines = [`${scenarioRef(book, data.scenario_id)} ${data.outcome}  ${toTerminalText(data.action)} → ${toTerminalText(data.observed)} [${oneLine(data.claim_id)}]${late}`];
      if (data.expected !== null) lines.push(`기대: ${toTerminalText(data.expected)}`);
      if (data.steps !== '') lines.push(`절차: ${toTerminalText(data.steps)}`);
      return lines.join('\n');
    }
    case 'verification': {
      const data = event.data;
      const author = book.claimAuthor(data.claim_id);
      const claim = `주장 ${oneLine(data.claim_id)}${author === null ? '' : `(${oneLine(author)})`}`;
      return `${data.result}  ${claim} → ${CLAIM_STATUS[data.claim_status] ?? data.claim_status}`;
    }
    case 'system': {
      const make = SYSTEM_TEXT[event.data.code];
      return make === undefined ? toTerminalText(event.text) : make(event.data);
    }
  }
}

/** 여러 줄 본문의 다음 줄을 내용 칸에 맞춰 `│ ` 로 들여 잇는다. */
function continueLines(content: string, style: MonitorStyle): string {
  const [first = '', ...rest] = content.split('\n');
  const indent = `${' '.repeat(CONTENT_COLUMN)}${paint(style, 'dim', '│')} `;
  return [first, ...rest.map((line) => `${indent}${line}`)].join('\n');
}

/** 사건 하나를 사람용 한 줄(본문이 여러 줄이면 이어지는 줄 포함)로 만든다. 사건의 ts 를 이 PC 의 지역 시각으로 쓴다. */
export function formatEvent(event: InboxEvent, style: MonitorStyle, book: MonitorBook): string {
  const at = Date.parse(event.ts);
  const time = Number.isNaN(at) ? '--:--:--' : style.clock(at);
  const kind = paint(style, kindTone(event), padCell(kindLabel(event), KIND_WIDTH, 2));
  const who = paint(style, event.kind === 'system' ? 'dim' : 'bold', padCell(whoOf(event), WHO_WIDTH));
  return `${paint(style, 'dim', time)}  ${kind}${who}${continueLines(contentOf(event, book), style)}`;
}

/** runMonitor 가 쓰는 알림 한 줄(시그널링 상태, 관전자만 남음). 사건과 같은 칸을 쓴다. */
export function formatNotice(text: string, at: number, style: MonitorStyle): string {
  return `${paint(style, 'dim', style.clock(at))}  ${paint(style, 'red', padCell('알림', KIND_WIDTH, 2))}${paint(style, 'dim', padCell('system', WHO_WIDTH))}${toTerminalText(text)}`;
}

/** 관전 콘솔에서 보낸 글 한 줄. 받은 채팅과 같은 칸을 쓰고, 끝에 전달 결과를 붙인다. */
export function formatSent(target: string, text: string, result: string, at: number, style: MonitorStyle): string {
  return `${paint(style, 'dim', style.clock(at))}  ${paint(style, 'cyan', padCell('보냄', KIND_WIDTH, 2))}${padCell(`나 → ${oneLine(target)}`, WHO_WIDTH)}${continueLines(toTerminalText(text), style)}  ${paint(style, 'dim', `[${result}]`)}`;
}

// ── 처음 요약 ───────────────────────────────────────────────────────────────

function participantLine(participant: ParticipantView): string {
  return [
    '  ',
    padCell(oneLine(participant.name), 14),
    padCell(oneLine(participant.client ?? '-'), 13),
    padCell(`역할=${participant.role === null ? '-' : oneLine(participant.role)}`, 16),
    padCell(`상태=${participant.status ?? '-'}`, 15),
    padCell(`링크=${participant.link}`, 17),
    `표시=${participant.shown_as}`,
  ].join('');
}

function claimLine(claim: ObservedClaim, index: number | null): string {
  const late = claim.late ? '  (중단 뒤)' : '';
  return `  ${padCell(oneLine(claim.claim_id), 16, 2)}${padCell(index === null ? '#?' : `#${index}`, 4)}${padCell(oneLine(claim.by), 14)}${padCell(claim.outcome, 6)}${padCell(CLAIM_STATUS[claim.status] ?? claim.status, 8)}${oneLine(claim.action)}${late}`;
}

/**
 * observe 의 결과로 처음 요약을 만든다(줄 목록). 참가자, 관전자, 관전자를 모르는 참가자, 테스트, 시나리오, 주장.
 * at 은 요약을 만든 때(이 PC 의 시계)다.
 */
export function formatSnapshot(observed: RoomObserved, style: MonitorStyle, at: number): string[] {
  const lines: string[] = [];
  const heading = (text: string): string => paint(style, 'bold', text);
  lines.push(heading(`== 지금 방 상태 (${style.clock(at)}) ==`));
  lines.push(`참가자 ${observed.participants.length}명`);
  for (const participant of observed.participants) lines.push(participantLine(participant));
  lines.push(
    observed.observers.length === 0
      ? '다른 관전자 없음'
      : `다른 관전자 ${observed.observers.length}명: ${observed.observers.map((observer) => `${oneLine(observer.name)}(${observer.link})`).join(', ')}`,
  );
  if (observed.unaware.length > 0) {
    lines.push(`관전자를 모르는 구버전 참가자: ${observed.unaware.map(oneLine).join(', ')} (그쪽에는 관전 사실이 표시되지 않는다)`);
  }
  const test = observed.test;
  if (test === null) {
    lines.push('테스트 없음');
  } else {
    const stopped =
      test.stopped === null
        ? '아니오'
        : `예 (${oneLine(test.stopped.by)}, ${test.stopped.reason === 'time_limit' ? '기한' : `사용자: ${oneLine(test.stopped.detail)}`})`;
    lines.push(
      `테스트 ${oneLine(test.test_id)}  시작=${oneLine(test.by)}  제한=${test.max_duration_min}분·시나리오 ${test.scenarios.max}개  남은=${test.remaining_min}분  시나리오=${test.scenarios.used}/${test.scenarios.max}  중단=${stopped}`,
    );
    lines.push(continueSummary(`  요청: ${toTerminalText(test.request)}`));
  }
  lines.push(`시나리오 ${observed.scenarios.length}건`);
  const indexOf = new Map(observed.scenarios.map((scenario) => [scenario.scenario_id, scenario.index]));
  for (const scenario of observed.scenarios) {
    const over = scenario.over_limit ? '  (한도 초과)' : '';
    lines.push(
      `  ${padCell(`#${scenario.index}`, 4)}${padCell(oneLine(scenario.title), 20)}시작=${oneLine(scenario.by)}  행동=${scenario.actor === null ? '-' : oneLine(scenario.actor)}  검증=${scenario.verifier === null ? '-' : oneLine(scenario.verifier)}${over}`,
    );
  }
  const counted = observed.claims.filter((claim) => !claim.late);
  const count = (status: string): number => counted.filter((claim) => claim.status === status).length;
  lines.push(
    `주장 ${observed.claims.length}건 (확인 ${count('confirmed')}, 반박 ${count('refuted')}, 미확인 ${count('unverified')}, 중단 뒤 ${observed.claims.length - counted.length})`,
  );
  for (const claim of observed.claims) lines.push(claimLine(claim, indexOf.get(claim.scenario_id) ?? null));
  return lines;
}

/** 요약 안의 여러 줄 글. 다음 줄을 네 칸 들여 `│ ` 로 잇는다. */
function continueSummary(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  return [first, ...rest.map((line) => `    │ ${line}`)].join('\n');
}

/** 요약 뒤에 쓰는 줄. 여기부터가 실시간이고 무엇이 보이지 않는지 알린다. */
export function liveHeader(style: MonitorStyle): string {
  return paint(style, 'bold', '== 여기부터 실시간. 들어오기 전의 채팅과 남끼리 주고받는 대상 지정 채팅은 보이지 않는다 ==');
}
