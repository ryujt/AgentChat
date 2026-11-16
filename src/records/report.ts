// 최종 보고서 (mcp-interface.md 9절). 받은 판정으로 구역을 나누고 센다. 판정을 다시 계산하지 않는다.
// 보고서는 남에게 건네는 자료다. 방 ID 원문을 쓰지 않고, 다른 참가자가 쓴 글이 보고서의 구조를 바꾸지 못하게 한다.

import path from 'node:path';
import { isEntryId, utf8ByteLength } from '../protocol/index.js';
import type {
  RecordsMeta,
  ReportClaim,
  ReportInput,
  ReportParticipant,
  ReportScenario,
  ReportSummary,
  ReportVerification,
  WriteReportOptions,
  WriteReportResult,
} from './contract.js';
import { ensureRoomDir, errorCode, failure, isoTime, utcStamp, writePrivateFile } from './paths.js';
import { readTranscriptFacts, type TranscriptFacts } from './transcript-reader.js';

const CLASS_LABEL: Readonly<Record<ReportClaim['classification'], string>> = Object.freeze({
  passed: '성공',
  failed: '실패',
  unverified: '미확인',
  late: '중단 뒤 기록',
});

const REASON_LABEL: Readonly<Record<NonNullable<ReportClaim['unverified_reason']>, string>> = Object.freeze({
  no_verification: '검증 없음',
  unable: 'unable (확인하지 못함)',
  verifier_disconnected: '검증자 연결 끊김',
  over_limit: '한도 초과 시나리오',
});

/** 연결 사건으로 싣지 않는 peer 사건. 역할과 준비 상태는 "참가자와 역할"에 있다. */
const NOT_CONNECTION_CHANGES: ReadonlySet<string> = new Set(['role', 'ready']);

const ACTION_SUMMARY_CHARS = 80;

// ── 글 넣기 ─────────────────────────────────────────────────────────────────

/** 초 단위의 UTC 시각. 날짜로 바뀌지 않는 값(다른 참가자가 보낸 wall)은 그대로 적지 않는다. */
function time(ms: number): string {
  const iso = isoTime(ms);
  return iso === null ? '시각 불명' : `${iso.slice(0, 19)}Z`;
}

/** 기록 파일의 ts(이 프로세스가 쓴 ISO 문자열)를 같은 모양으로 줄인다. */
function stamp(ts: string | null): string {
  return ts !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts) ? `${ts.slice(0, 19)}Z` : '시각 불명';
}

/** 보고서에 글을 넣는 방법. 사람이나 참가자가 정한 글은 모두 이것을 거친다. */
interface Pen {
  /** HTML 로 해석될 글자를 막는다. 한 줄 안에 넣는 모든 글에 쓴다. */
  inline(text: string): string;
  /** 한 줄로 만든다. 제목처럼 줄바꿈이 구조를 바꾸는 자리에 쓴다. */
  oneLine(text: string): string;
  /** 표의 칸. 칸 구분자와 줄바꿈이 표를 깨지 못하게 한다. */
  cell(text: string | null): string;
  /**
   * 목록 항목에 글을 넣는다. 여러 줄이면 줄마다 인용 표시를 붙여 항목 아래에 둔다.
   * 그대로 이어 붙이면 `## 요약` 같은 줄이 보고서의 구역으로 읽힌다.
   */
  bullet(label: string, text: string | null): string[];
  summarize(text: string): string;
  /** 방 ID 의 앞 4자와 줄임표. */
  readonly maskedRoom: string;
}

function createPen(roomId: string): Pen {
  const maskedRoom = `${roomId.slice(0, 4)}…`;
  const inline = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const oneLine = (text: string): string => inline(text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
  const cell = (text: string | null): string => {
    if (text === null || text === '') return '—';
    return inline(text)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r\n?|\n/g, '<br>');
  };
  const bullet = (label: string, text: string | null): string[] => {
    if (text === null || text.trim() === '') return [`- ${label}: —`];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1) return [`- ${label}: ${inline(lines[0] ?? '')}`];
    return [`- ${label}:`, ...lines.map((line) => `  > ${inline(line)}`)];
  };
  const summarize = (text: string): string => {
    // 자른 뒤에 글자를 바꾼다. 바꾼 뒤에 자르면 `&amp;` 같은 표기가 중간에서 끊긴다.
    const chars = [...(text.trim().split(/\r?\n/)[0] ?? '').trim()];
    return chars.length > ACTION_SUMMARY_CHARS ? `${inline(chars.slice(0, ACTION_SUMMARY_CHARS).join(''))}…` : inline(chars.join(''));
  };
  return { inline, oneLine, cell, bullet, summarize, maskedRoom };
}

function verificationsCell(pen: Pen, verifications: readonly ReportVerification[]): string {
  if (verifications.length === 0) return '없음';
  return verifications
    .map((verification) => {
      const note = verification.counted ? '' : ' (자기 검증, 판정에서 뺌)';
      return pen.cell(`${verification.by}: ${verification.result}${note} — ${verification.evidence}`);
    })
    .join('<br>');
}

// ── 세기 ────────────────────────────────────────────────────────────────────

export function summarizeReport(input: ReportInput): ReportSummary {
  const summary = { scenarios: input.scenarios.length, passed: 0, failed: 0, unverified: 0, late: 0 };
  for (const scenario of input.scenarios) {
    for (const claim of scenario.claims) summary[claim.classification] += 1;
  }
  return summary;
}

// ── 구역 ────────────────────────────────────────────────────────────────────

function header(pen: Pen, input: ReportInput, meta: RecordsMeta, roomRef: string, now: number): string[] {
  const { inline, bullet } = pen;
  const { test } = input;
  const end = test.stop === null ? time(now) : time(test.stop.wall);
  const reason = test.stop === null ? '진행 중(중간 보고)' : test.stop.reason === 'time_limit' ? '시간 제한' : '사용자 중단';
  const request = /[\r\n]/.test(test.request)
    ? bullet(`테스트 요청 (요청자 ${inline(test.requested_by)})`, test.request)
    : [`- 테스트 요청: "${inline(test.request)}" (요청자 ${inline(test.requested_by)})`];
  return [
    '# Agent Chat 테스트 보고서',
    '',
    // 방 ID 는 접근 수단이다. 앞 4자와 해시만 적는다.
    `- 방: ${pen.maskedRoom} (${roomRef}) @ ${inline(meta.server_key)}`,
    `- 작성: ${inline(meta.name)}, ${time(now)} (이 참가자의 복제본 기준)`,
    ...request,
    `- 기간: ${time(test.started_wall)} ~ ${end}`,
    `- 종료 사유: ${reason}`,
    `- 제한: 시간 ${test.max_duration_min}분, 시나리오 ${test.scenarios_used}/${test.max_scenarios}`,
    `- 상태 지문: ${inline(input.fingerprint)}`,
  ];
}

function summarySection(summary: ReportSummary): string[] {
  return [
    '## 요약',
    '',
    '| 구분 | 건수 |',
    '|---|---|',
    `| 성공 (다른 참가자가 확인) | ${summary.passed} |`,
    `| 실패 (확인된 실패 + 반박된 성공 주장) | ${summary.failed} |`,
    `| 미확인 | ${summary.unverified} |`,
    `| 중단 뒤 기록 (성공·실패에 세지 않음) | ${summary.late} |`,
  ];
}

function roleHistory(pen: Pen, participant: ReportParticipant, facts: TranscriptFacts): string {
  const { cell } = pen;
  const history = facts.roles.get(participant.name) ?? [];
  const parts = history.map((fact) => `${cell(fact.role ?? '(없음)')} (${time(fact.wall)})`);
  // 기록 파일에 없거나 읽지 못했으면 지금 역할만 적는다.
  if (history.length === 0 || history[history.length - 1]?.role !== participant.role) {
    parts.push(cell(participant.role ?? '(없음)'));
  }
  return parts.join(' → ');
}

function participantsSection(pen: Pen, input: ReportInput, facts: TranscriptFacts): string[] {
  const { cell } = pen;
  const rows = input.participants.map((participant) => {
    const status = participant.status ?? '알 수 없음';
    const shown = participant.shown_as === null ? '' : ` (표시: ${participant.shown_as})`;
    const tools = participant.tools === null || participant.tools.length === 0 ? '—' : participant.tools.map((tool) => cell(tool)).join(', ');
    return `| ${cell(participant.name)} | ${cell(participant.client)} | ${tools} | ${roleHistory(pen, participant, facts)} | ${cell(`${status}${shown}`)} |`;
  });
  return [
    '## 참가자와 역할',
    '',
    '| 이름 | 클라이언트 | 도구 | 역할 변화(시각 순) | 마지막 상태 |',
    '|---|---|---|---|---|',
    ...rows,
    ...(facts.problem === null ? [] : ['', '역할 변화 이력은 기록 파일을 읽지 못해 일부가 빠졌을 수 있다.']),
  ];
}

function scenarioSection(pen: Pen, scenario: ReportScenario): string[] {
  const { inline, oneLine, cell } = pen;
  const lines = [`### ${scenario.index}. ${oneLine(scenario.title)} (시작: ${inline(scenario.by)}, ${time(scenario.wall)})`, ''];
  if (scenario.over_limit) lines.push('한도 초과 시나리오다. 주장을 받지 않는다.', '');
  if (scenario.claims.length === 0) {
    lines.push('주장 없음.');
    return lines;
  }
  lines.push('| 주장 ID | 행동한 참가자 | 행동 | 기대 | 관찰 | 작성자 판단 | 검증 | 분류 |', '|---|---|---|---|---|---|---|---|');
  for (const claim of scenario.claims) {
    lines.push(
      `| ${cell(claim.claim_id)} | ${cell(claim.by)} | ${cell(claim.action)} | ${cell(claim.expected)} | ${cell(claim.observed)} | ${claim.outcome} | ${verificationsCell(pen, claim.verifications)} | ${CLASS_LABEL[claim.classification]} |`,
    );
  }
  return lines;
}

function scenariosSection(pen: Pen, input: ReportInput): string[] {
  const lines = ['## 시나리오별 결과', ''];
  if (input.scenarios.length === 0) return [...lines, '시나리오 없음.'];
  input.scenarios.forEach((scenario, i) => {
    if (i > 0) lines.push('');
    lines.push(...scenarioSection(pen, scenario));
  });
  return lines;
}

function claimsOf(input: ReportInput, classification: ReportClaim['classification']): ReportClaim[] {
  return input.scenarios.flatMap((scenario) => scenario.claims.filter((claim) => claim.classification === classification));
}

function failedSection(pen: Pen, input: ReportInput): string[] {
  const { inline, oneLine, bullet, summarize } = pen;
  const lines = ['## 실패 항목과 재현 절차', ''];
  const failed = claimsOf(input, 'failed');
  if (failed.length === 0) return [...lines, '없음.'];
  failed.forEach((claim, i) => {
    if (i > 0) lines.push('');
    lines.push(`### ${oneLine(claim.claim_id)} ${summarize(claim.action)}`, '');
    lines.push(`- 행동한 참가자: ${inline(claim.by)}, ${time(claim.wall)} (작성자 판단: ${claim.outcome})`);
    lines.push(...bullet('관찰', claim.observed));
    lines.push(...bullet('재현 절차', claim.steps));
    if (claim.verifications.length === 0) lines.push('- 검증: 없음');
    // 확인과 반박이 함께 있으면 두 증거를 모두 싣는다.
    for (const verification of claim.verifications) {
      const note = verification.counted ? '' : ' (자기 검증, 판정에서 뺌)';
      lines.push(...bullet(`검증: ${inline(verification.by)} — ${verification.result}${note}, 증거`, verification.evidence));
    }
  });
  return lines;
}

function unverifiedSection(pen: Pen, input: ReportInput): string[] {
  const { cell } = pen;
  const lines = ['## 미확인 항목', ''];
  const unverified = claimsOf(input, 'unverified');
  if (unverified.length === 0) return [...lines, '없음.'];
  lines.push('| 주장 ID | 이유 (검증 없음 / unable / 검증자 연결 끊김 / 한도 초과 시나리오) | 재현 절차 |', '|---|---|---|');
  for (const claim of unverified) {
    const reason = claim.unverified_reason === null ? '이유가 기록되지 않음' : REASON_LABEL[claim.unverified_reason];
    lines.push(`| ${cell(claim.claim_id)} | ${reason} | ${cell(claim.steps)} |`);
  }
  return lines;
}

function lateSection(pen: Pen, input: ReportInput): string[] {
  const { cell } = pen;
  const lines = ['## 중단 뒤 기록', ''];
  const late = claimsOf(input, 'late');
  if (late.length === 0) return [...lines, '없음.'];
  lines.push('성공·실패에 세지 않는다. 확인을 받은 것도 같다.', '');
  lines.push('| 주장 ID | 행동한 참가자 | 행동 | 작성자 판단 | 검증 |', '|---|---|---|---|---|');
  for (const claim of late) {
    lines.push(`| ${cell(claim.claim_id)} | ${cell(claim.by)} | ${cell(claim.action)} | ${claim.outcome} | ${verificationsCell(pen, claim.verifications)} |`);
  }
  return lines;
}

function controlSection(pen: Pen, input: ReportInput, facts: TranscriptFacts): string[] {
  const { inline, oneLine } = pen;
  const lines = ['## 실행 통제 기록', ''];
  const { stop } = input.test;
  if (stop === null) {
    lines.push('- 중단: 없음 (진행 중)');
  } else {
    const reason = stop.reason === 'time_limit' ? '시간 제한' : '사용자 중단';
    const detail = stop.detail.trim() === '' ? '' : ` — "${oneLine(stop.detail)}"`;
    lines.push(`- 중단: ${inline(stop.by)}, ${time(stop.wall)}, ${reason}${detail}`);
  }

  const unread = facts.problem === null ? '' : ' (기록 파일을 읽지 못해 일부가 빠졌을 수 있다)';
  if (facts.rules.length === 0) {
    lines.push(`- 거절된 호출(이 참가자): 없음${unread}`);
  } else {
    lines.push(`- 거절된 호출(이 참가자): ${facts.rules.length}건${unread}`);
    for (const rule of facts.rules) lines.push(`  - ${oneLine(rule.tool)}, ${oneLine(rule.code)}, ${stamp(rule.ts)}`);
  }

  const over = input.scenarios.filter((scenario) => scenario.over_limit);
  if (over.length === 0) {
    lines.push('- 한도 초과 시나리오: 없음');
  } else {
    lines.push(`- 한도 초과 시나리오: ${over.length}건`);
    for (const scenario of over) lines.push(`  - ${scenario.index}. ${oneLine(scenario.title)} (시작: ${inline(scenario.by)})`);
  }

  const events = facts.peers.filter((peer) => !NOT_CONNECTION_CHANGES.has(peer.change));
  if (events.length === 0) {
    lines.push(`- 연결 사건: 없음${unread}`);
  } else {
    lines.push(`- 연결 사건: ${events.length}건${unread}`);
    for (const event of events) {
      const reason = event.reason === null || event.reason === '' ? '' : ` (${oneLine(event.reason)})`;
      lines.push(`  - ${stamp(event.ts)}: ${oneLine(event.name)} ${oneLine(event.change)}${reason}`);
    }
  }
  return lines;
}

/** 보고서 본문. 파일에 닿지 않는다. */
export function renderReport(input: ReportInput, meta: RecordsMeta, roomRef: string, facts: TranscriptFacts, now: number): string {
  const pen = createPen(meta.room_id);
  const sections = [
    header(pen, input, meta, roomRef, now),
    summarySection(summarizeReport(input)),
    participantsSection(pen, input, facts),
    scenariosSection(pen, input),
    failedSection(pen, input),
    unverifiedSection(pen, input),
    lateSection(pen, input),
    controlSection(pen, input, facts),
  ];
  const text = `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
  // 참가자가 쓴 글(요청문, 관찰, 증거, 이름)에 방 ID 가 들어 있을 수 있다. 방 ID 는 접근 수단이므로 어디에 있든 가린다.
  // 방 ID 는 소문자와 숫자뿐이라 위의 글자 바꿈이 그것을 쪼개지 않는다. 그래서 다 만든 글에서 한 번에 가린다.
  // 방 ID 가 보고서의 고정 낱말과 같으면 그 낱말도 가려진다. 원문이 없다는 것이 먼저다.
  return text.split(meta.room_id).join(pen.maskedRoom);
}

export async function writeReport(options: WriteReportOptions): Promise<WriteReportResult> {
  let roomRef: string | undefined;
  // 진단 로그에는 짧은 사유와 오류 코드만 남긴다. detail 은 호출자에게 가는 글이다.
  const fail = (reason: string, detail: string, code?: string): WriteReportResult => {
    try {
      options.log.event('error', 'records', 'report.write', { room_ref: roomRef, outcome: 'failed', reason, error_code: code });
    } catch {
      // 로그 실패가 호출자를 멈추면 안 된다.
    }
    return failure(detail);
  };

  try {
    const { input, meta, log } = options;
    const room = await ensureRoomDir(options.dir, meta);
    if (!room.ok) return fail(room.reason, room.detail, room.errorCode);
    roomRef = room.roomRef;

    // test_id 는 테스트를 시작한 참가자가 정한 값이다. 형식이 맞을 때만 파일 이름에 쓴다.
    const testId = input?.test?.test_id;
    if (!isEntryId(testId)) return fail('invalid_test_id', 'test_id has an invalid format');
    const now = options.now();
    const stampText = utcStamp(now);
    if (stampText === null) return fail('bad_clock', 'the clock returned an invalid time');

    const facts = await readTranscriptFacts(room.dir, meta.sid, testId);
    if (facts.problem !== null) {
      log.event('warn', 'records', 'report.transcript_read', { room_ref: roomRef, test_id: testId, outcome: 'failed', error_code: facts.problem });
    }

    const text = renderReport(input, meta, room.roomRef, facts, now);
    const file = path.join(room.dir, `report-${testId}-${stampText}.md`);
    try {
      await writePrivateFile(file, text);
    } catch (error) {
      const code = errorCode(error);
      return fail('write_failed', `cannot write the report: ${code}`, code);
    }
    const summary = summarizeReport(input);
    log.event('info', 'records', 'report.write', { room_ref: roomRef, test_id: testId, bytes: utf8ByteLength(text), outcome: 'ok' });
    return { ok: true, path: file, summary };
  } catch (error) {
    const code = errorCode(error);
    return fail('unexpected', `cannot write the report: ${code}`, code);
  }
}
