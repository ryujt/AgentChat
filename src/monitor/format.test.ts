// V-U12 (monitor): 터미널 안전, 사건 한 줄, 처음 요약, JSON 줄 (architecture.md 3.14 의 출력 형식).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InboxEvent, PeerChange } from '../inbox/contract.js';
import type { RoomObserved } from '../room-session/contract.js';
import type { MonitorBook, MonitorStyle } from './contract.js';
import { CONTENT_COLUMN, displayWidth, formatEvent, formatNotice, formatSnapshot, jsonLine, kindLabel, liveHeader, toTerminalText } from './format.js';
import { eventLine } from './sink.js';

const ROOM = 'k3x9q0ab12cdx7p2';
const ESC = '\u001b';
const TS = '2026-11-16T05:01:10.000Z';
const utcClock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const PLAIN: MonitorStyle = { color: false, clock: utcClock };
const COLOR: MonitorStyle = { color: true, clock: utcClock };
const BOOK: MonitorBook = {
  scenarioIndex: (id) => (id === 'k3x9q0ab12cd-2' ? 2 : null),
  claimAuthor: (id) => (id === 'k3x9q0ab12cd-9' ? 'codex-b' : null),
};
const EMPTY_BOOK: MonitorBook = { scenarioIndex: () => null, claimAuthor: () => null };

/** 터미널을 조작할 수 있는 글자 표본: ESC 순서, C0, DEL, C1, 양방향 제어, 줄·문단 구분. */
const HOSTILE = `색\u001b[31m빨강\u001b]0;제목\u0007 지우기\u001b[2J 커서\u001b[10;10H 벨\u0007 백\u0008 DEL\u007f C1\u0085\u009b31m 반전\u202e 격리\u2066\u2069 LRM\u200e 줄\u2028문단\u2029 끝`;
// 정규식 리터럴 대신 문자열로 만든다(소스에 보이지 않는 글자를 두지 않는다).
const BAD_CHARS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'u');

const PEER_CHANGES: readonly PeerChange[] = [
  'joined',
  'left',
  'disconnected',
  'reconnected',
  'unreachable',
  'role',
  'ready',
  'status',
  'observer_joined',
  'observer_left',
];

function base(text: string): Pick<InboxEvent, 'id' | 'from' | 'to' | 'ts' | 'text'> {
  return { id: null, from: 'codex-b', to: 'room', ts: TS, text };
}

/** 사건 종류·change 의 모든 값. 다른 참가자가 쓴 글 칸에는 HOSTILE 을 넣는다. */
function everyEvent(text = HOSTILE): InboxEvent[] {
  const events: InboxEvent[] = [
    { kind: 'chat', change: null, data: {}, ...base(text) },
    { kind: 'chat', change: null, data: {}, ...base(text), to: 'you' },
  ];
  for (const change of PEER_CHANGES) {
    events.push({ kind: 'peer', change, ...base('summary'), data: { role: text, status: 'working', tools: [], reason: change === 'unreachable' ? 'no_route' : 'bye_shutdown' } });
  }
  const limits = { max_duration_min: 60, max_scenarios: 20 };
  events.push(
    { kind: 'test', change: 'started', ...base('s'), data: { test_id: 'k3x9q0ab12cd-1', request: text, limits, reason: null, by: 'codex-b', detail: null } },
    { kind: 'test', change: 'replaced', ...base('s'), data: { test_id: 'k3x9q0ab12cd-1', request: text, limits, reason: null, by: 'codex-b', detail: null } },
    { kind: 'test', change: 'stopped', ...base('s'), data: { test_id: 'k3x9q0ab12cd-1', request: text, limits, reason: 'user', by: 'codex-b', detail: text } },
    { kind: 'test', change: 'stopped', ...base('s'), data: { test_id: 'k3x9q0ab12cd-1', request: text, limits, reason: 'time_limit', by: 'codex-b', detail: '' } },
    { kind: 'scenario', change: 'started', ...base('s'), data: { scenario_id: 'k3x9q0ab12cd-2', title: text, by: 'codex-b', plan: text, actor: 'codex-b', verifier: null } },
    { kind: 'scenario', change: 'over_limit', ...base('s'), data: { scenario_id: 'k3x9q0ab12cd-5', title: text, by: 'codex-b', plan: null, actor: null, verifier: null } },
    {
      kind: 'claim',
      change: null,
      ...base('s'),
      data: { claim_id: 'k3x9q0ab12cd-9', scenario_id: 'k3x9q0ab12cd-2', by: 'codex-b', action: text, expected: text, observed: text, steps: text, outcome: 'fail', late: true },
    },
    { kind: 'verification', change: null, ...base('s'), data: { claim_id: 'k3x9q0ab12cd-9', result: 'confirmed', by: 'claude-c', claim_status: 'confirmed' } },
  );
  for (const code of ['inbox_dropped', 'signaling_blocked', 'signaling_detached', 'name_conflict', 'state_diverged', 'record_failed', 'clock_skew', 'observer_unaware'] as const) {
    events.push({ kind: 'system', change: null, ...base(text), from: 'system', to: 'you', data: { code, peer: 'codex-b', count: 3, reason: 'ROOM_FULL' } });
  }
  return events;
}

function observedSample(text = '강의실 손들기'): RoomObserved {
  return {
    server: 'wss://agent-chat.tools.camp',
    name: 'observer-4k2q',
    signaling: 'connected',
    participants: [
      { name: 'claude-a', client: 'claude-code', tools: [], role: '강사', status: 'ready', link: 'open', listening: true, shown_as: 'ready' },
      { name: 'codex-b', client: 'codex', tools: ['browser'], role: text, status: 'working', link: 'open', listening: true, shown_as: 'working' },
      { name: 'claude-c', client: null, tools: null, role: null, status: null, link: 'connecting', listening: null, shown_as: 'connecting' },
    ],
    observers: [{ name: 'observer-9zz1', link: 'open', since: TS }],
    unaware: ['old-peer'],
    test: {
      test_id: 'k3x9q0ab12cd-1',
      request: `${text}\n두 번째 줄`,
      by: 'claude-a',
      started: TS,
      max_duration_min: 60,
      remaining_min: 41,
      stopped: { reason: 'user', by: 'claude-a', at: TS, detail: text },
      scenarios: { used: 2, max: 20, items: [], items_omitted: 0 },
    },
    scenarios: [
      { scenario_id: 'k3x9q0ab12cd-2', index: 1, title: text, by: 'claude-a', plan: null, actor: 'codex-b', verifier: 'claude-a', over_limit: false, wall: TS },
      { scenario_id: 'k3x9q0ab12cd-3', index: 2, title: '손들기', by: 'codex-b', plan: text, actor: null, verifier: null, over_limit: true, wall: TS },
    ],
    claims: [
      {
        claim_id: 'k3x9q0ab12cd-7',
        scenario_id: 'k3x9q0ab12cd-2',
        by: 'codex-b',
        outcome: 'pass',
        action: text,
        expected: null,
        observed: text,
        steps: text,
        status: 'confirmed',
        late: false,
        wall: TS,
        verifications: [{ by: 'claude-a', result: 'confirmed', evidence: text, counted: true, wall: TS }],
      },
      { claim_id: 'k3x9q0ab12cd-8', scenario_id: 'zz', by: 'codex-b', outcome: 'fail', action: 'x', expected: 'y', observed: 'z', steps: 's', status: 'unverified', late: true, wall: TS, verifications: [] },
    ],
  };
}

/** 색 순서(이 모듈이 넣는 SGR)를 뺀 글. 그 뒤에 ESC 가 남으면 본문이 터미널을 조작할 수 있다는 뜻이다. */
const withoutSgr = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('toTerminalText: 터미널을 조작하는 글자를 보이는 글자로', () => {
  it('ESC·C0·DEL·C1·양방향 제어·U+2028/2029 가 하나도 그대로 나가지 않는다', () => {
    const out = toTerminalText(HOSTILE);
    assert.equal(BAD_CHARS.test(out), false, JSON.stringify(out));
    assert.ok(out.includes('\\u{1b}[31m빨강'));
    assert.ok(out.includes('\\u{202e}'));
    assert.ok(out.includes('\\u{2028}'));
    assert.ok(out.includes('\\u{85}'));
    assert.ok(out.includes('\\u{7f}'));
  });

  it('모든 제어 문자(U+0000–U+009F)를 하나씩 넣어도 줄바꿈 말고는 그대로 나가지 않는다', () => {
    for (let code = 0; code <= 0x9f; code += 1) {
      if (code >= 0x20 && code < 0x7f) continue;
      const out = toTerminalText(`a${String.fromCodePoint(code)}b`);
      if (code === 0x0a) assert.equal(out, 'a\nb');
      else if (code === 0x09) assert.equal(out, 'a  b');
      else assert.equal(out, `a\\u{${code.toString(16)}}b`, `U+${code.toString(16)}`);
    }
  });

  it('줄바꿈은 남기고 CRLF 는 LF 로. 한글·이모지·따옴표는 그대로다', () => {
    assert.equal(toTerminalText('한 줄\r\n두 줄\n😀 "인용" \'작은\' \\역슬래시'), '한 줄\n두 줄\n😀 "인용" \'작은\' \\역슬래시');
  });

  it('표시 폭: 한글과 이모지는 2칸', () => {
    assert.equal(displayWidth('codex-b'), 7);
    assert.equal(displayWidth('채팅'), 4);
    assert.equal(displayWidth('😀a'), 3);
  });
});

describe('formatEvent: 사건 한 줄', () => {
  it('사건 종류·change 의 모든 값에 한 줄이 나온다. 색을 끈 출력에 ESC 와 제어 문자가 0개다', () => {
    const events = everyEvent();
    assert.equal(events.length, 2 + PEER_CHANGES.length + 8 + 8);
    for (const event of events) {
      const line = formatEvent(event, PLAIN, BOOK);
      assert.ok(line.startsWith('05:01:10  '), line);
      assert.ok(line.includes(kindLabel(event)), line);
      assert.equal(line.includes(ESC), false, line);
      assert.equal(BAD_CHARS.test(line.replace(/\n/g, '')), false, JSON.stringify(line));
      const colored = formatEvent(event, COLOR, BOOK);
      assert.ok(colored.includes(ESC), '색을 켜면 SGR 이 들어간다');
      assert.equal(BAD_CHARS.test(withoutSgr(colored).replace(/\n/g, '')), false, '색 말고는 ESC 가 없다');
      assert.equal(withoutSgr(colored), line, '색을 빼면 같은 글이다');
    }
  });

  it('종류 이름이 서로 다르다(peer 의 change 마다)', () => {
    const labels = PEER_CHANGES.map((change) => kindLabel({ kind: 'peer', change, ...base('x'), data: {} }));
    assert.equal(new Set(labels).size, PEER_CHANGES.length);
    assert.deepEqual(labels, ['입장', '퇴장', '끊김', '재연결', '닿지않음', '역할', '준비', '상태', '관전입장', '관전퇴장']);
  });

  it('채팅: 보낸이 → 전체|나, 본문 그대로. 여러 줄은 내용 칸에 맞춰 │ 로 잇는다', () => {
    const line = formatEvent({ kind: 'chat', change: null, data: {}, ...base('강사 화면에서 손들기 표시가 보입니다\n두 번째 줄') }, PLAIN, EMPTY_BOOK);
    const [first, second] = line.split('\n');
    assert.equal(first, '05:01:10  채팅        codex-b → 전체    강사 화면에서 손들기 표시가 보입니다');
    assert.equal(second, `${' '.repeat(CONTENT_COLUMN)}│ 두 번째 줄`);
    assert.equal(displayWidth((first ?? '').slice(0, (first ?? '').indexOf('강사'))), CONTENT_COLUMN);
    const toMe = formatEvent({ kind: 'chat', change: null, data: {}, ...base('관전자에게'), to: 'you' }, PLAIN, EMPTY_BOOK);
    assert.ok(toMe.includes('codex-b → 나'));
  });

  it('상태·중단·주장·검증 줄은 설계의 예와 같은 내용을 싣는다', () => {
    const status = formatEvent({ kind: 'peer', change: 'status', ...base('x'), data: { role: '수강생 A', status: 'working', tools: [] } }, PLAIN, EMPTY_BOOK);
    assert.ok(status.endsWith('codex-b           working (역할 수강생 A)'), status);
    const stop = formatEvent(
      { kind: 'test', change: 'stopped', ...base('x'), from: 'claude-a', data: { test_id: 't', request: 'r', limits: { max_duration_min: 60, max_scenarios: 20 }, reason: 'user', by: 'claude-a', detail: '그만하자' } },
      PLAIN,
      EMPTY_BOOK,
    );
    assert.ok(stop.endsWith('사용자 중단: 그만하자'), stop);
    const verification = formatEvent(
      { kind: 'verification', change: null, ...base('x'), from: 'claude-c', data: { claim_id: 'k3x9q0ab12cd-9', result: 'confirmed', by: 'claude-c', claim_status: 'confirmed' } },
      PLAIN,
      BOOK,
    );
    assert.ok(verification.endsWith('confirmed  주장 k3x9q0ab12cd-9(codex-b) → 확인됨'), verification);
    const unknownAuthor = formatEvent(
      { kind: 'verification', change: null, ...base('x'), data: { claim_id: 'other', result: 'refuted', by: 'claude-c', claim_status: 'refuted' } },
      PLAIN,
      BOOK,
    );
    assert.ok(unknownAuthor.endsWith('refuted  주장 other → 반박됨'), unknownAuthor);
    const claim = formatEvent(everyEvent('행동')[2 + PEER_CHANGES.length + 6] as InboxEvent, PLAIN, BOOK);
    assert.ok(claim.includes('#2 fail  행동 → 행동 [k3x9q0ab12cd-9] (중단 뒤 기록)'), claim);
  });

  it('잘못된 ts 는 --:--:-- 로 쓴다', () => {
    const line = formatEvent({ kind: 'chat', change: null, data: {}, ...base('x'), ts: 'not a date' }, PLAIN, EMPTY_BOOK);
    assert.ok(line.startsWith('--:--:--  '));
  });

  it('알림 줄과 실시간 머리줄', () => {
    assert.ok(formatNotice('시그널링 재접속 중이다', Date.parse(TS), PLAIN).startsWith('05:01:10  알림        system'));
    assert.equal(formatNotice(HOSTILE, 0, PLAIN).includes(ESC), false);
    assert.match(liveHeader(PLAIN), /여기부터 실시간/);
  });
});

describe('formatSnapshot: 처음 요약', () => {
  it('참가자, 관전자, 구버전, 테스트, 시나리오, 주장을 싣는다', () => {
    const lines = formatSnapshot(observedSample(), PLAIN, Date.parse(TS));
    const text = lines.join('\n');
    assert.equal(lines[0], '== 지금 방 상태 (05:01:10) ==');
    assert.match(text, /참가자 3명/);
    assert.match(text, /claude-a\s+claude-code\s+역할=강사\s+상태=ready\s+링크=open\s+표시=ready/);
    assert.match(text, /다른 관전자 1명: observer-9zz1\(open\)/);
    assert.match(text, /관전자를 모르는 구버전 참가자: old-peer/);
    assert.match(text, /테스트 k3x9q0ab12cd-1 {2}시작=claude-a {2}제한=60분·시나리오 20개 {2}남은=41분 {2}시나리오=2\/20 {2}중단=예 \(claude-a, 사용자: 강의실 손들기\)/);
    assert.match(text, / {2}요청: 강의실 손들기\n {4}│ 두 번째 줄/);
    assert.match(text, /시나리오 2건/);
    assert.match(text, /#2 {2}손들기.*\(한도 초과\)/);
    assert.match(text, /주장 2건 \(확인 1, 반박 0, 미확인 0, 중단 뒤 1\)/);
    assert.match(text, /k3x9q0ab12cd-7 {2}#1 {2}codex-b/);
    assert.match(text, /k3x9q0ab12cd-8 {2}#\? {2}codex-b/);
  });

  it('테스트가 없고 관전자가 없는 방', () => {
    const lines = formatSnapshot({ ...observedSample(), test: null, observers: [], unaware: [], scenarios: [], claims: [] }, PLAIN, 0);
    assert.ok(lines.includes('테스트 없음'));
    assert.ok(lines.includes('다른 관전자 없음'));
  });

  it('본문의 제어 문자가 요약에 그대로 나가지 않는다(색을 켜도)', () => {
    for (const style of [PLAIN, COLOR]) {
      const text = formatSnapshot(observedSample(HOSTILE), style, 0).join('\n');
      assert.equal(BAD_CHARS.test(withoutSgr(text).replace(/\n/g, '')), false);
      if (!style.color) assert.equal(text.includes(ESC), false);
    }
  });
});

describe('방 ID 가 출력 어디에도 없다', () => {
  it('요약·사건(사람용, JSON) 어디에도 시험이 넣은 방 ID 가 0건이다', () => {
    // RoomObserved 와 InboxEvent 에는 방 ID 칸이 없다. 방 ID 를 아는 곳(옵션)의 값이 새어 나오지 않는지 본다.
    const outputs = [
      ...formatSnapshot(observedSample(), PLAIN, 0),
      ...formatSnapshot(observedSample(), COLOR, 0),
      JSON.stringify({ type: 'snapshot', ...observedSample() }),
      ...everyEvent('본문').map((event) => formatEvent(event, PLAIN, BOOK)),
      ...everyEvent('본문').map(eventLine),
      jsonLine({ type: 'snapshot', ...observedSample() }),
    ];
    assert.equal(outputs.filter((output) => output.includes(ROOM)).length, 0);
  });
});

describe('JSON Lines', () => {
  it('event 줄은 JSON.parse 로 되읽어 원래 사건과 같다. 제어 문자는 이스케이프된다', () => {
    for (const event of everyEvent()) {
      const line = eventLine(event);
      assert.equal(line.includes('\n'), false);
      assert.equal(line.includes(ESC), false);
      assert.equal(BAD_CHARS.test(line), false, 'C0 는 JSON.stringify 가, DEL·C1·U+2028·양방향 제어는 jsonLine 이 이스케이프한다');
      assert.deepEqual(JSON.parse(line), { type: 'event', ...event });
    }
  });
});
