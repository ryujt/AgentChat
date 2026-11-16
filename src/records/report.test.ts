// V-U5: 최종 보고서. 분류별 구역과 건수, 거절된 호출, 방 ID 원문 없음, 경로와 권한, 구조를 깨는 글.

import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { refOf } from '../protocol/index.js';
import type { StateRecord } from '../protocol/index.js';
import type { RecordsMeta, ReportInput, TranscriptEntry } from './contract.js';
import { openTranscript, writeReport } from './index.js';
import { summarizeReport } from './report.js';
import { MIN, ROOM_ID, SEC, SID, T0, TEST_ID, collectingLog, listTree, makeHome, metaOf, modeOf, roomDirOf, sampleInput } from './testing.js';

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function home(): Promise<{ root: string; home: string }> {
  const made = await makeHome();
  cleanups.push(made.cleanup);
  return made;
}

function presence(author: string, role: string | null, at: number): TranscriptEntry {
  const record: StateRecord = {
    kind: 'presence',
    key: `presence/${author}`,
    author,
    lc: at,
    wall: at,
    body: { client: 'x', tools: [], role, status: 'ready', listening: true, note: null },
  };
  return { kind: 'state', origin: author === 'alice' ? 'local' : 'remote', from: author === 'alice' ? null : author, record };
}

function testStarted(testId: string, at: number): TranscriptEntry {
  return {
    kind: 'state',
    origin: 'local',
    from: null,
    record: { kind: 'test', key: 'test', author: 'alice', lc: at, wall: at, body: { test_id: testId, request: 'r', started_wall: at, max_duration_min: 60, max_scenarios: 2 } },
  };
}

/** 한 번의 입장이 남기는 기록 파일을 제품 코드로 쓴다. */
async function session(dir: string, meta: RecordsMeta, startAt: number, entries: readonly TranscriptEntry[]): Promise<string> {
  let clock = startAt;
  const opened = await openTranscript({ dir, meta, now: () => clock, log: collectingLog() });
  assert.ok(opened.ok, opened.ok ? '' : opened.detail);
  for (const entry of entries) {
    clock += 10 * SEC;
    assert.deepEqual(await opened.transcript.append(entry), { ok: true });
  }
  await opened.transcript.close();
  return opened.transcript.path;
}

const CURRENT_SESSION: TranscriptEntry[] = [
  presence('alice', null, T0 + 10 * SEC),
  presence('bob', '수강생', T0 + 20 * SEC),
  testStarted(TEST_ID, T0 + MIN),
  presence('alice', '강사', T0 + 2 * MIN),
  presence('bob', '강사', T0 + 11 * MIN),
  // 같은 역할을 다시 쓴 것(주기적 재기록)은 변화가 아니다.
  presence('alice', '강사', T0 + 11 * MIN + SEC),
  presence('alice', '수강생', T0 + 11 * MIN + 2 * SEC),
  { kind: 'chat_in', id: 'bbbbbbbbbbbb-1', from: 'bob', to: 'room', text: '역할을 바꿉시다' },
  { kind: 'peer', name: 'carol', change: 'joined', reason: null },
  { kind: 'peer', name: 'bob', change: 'role', reason: null },
  { kind: 'peer', name: 'bob', change: 'ready', reason: null },
  { kind: 'peer', name: 'carol', change: 'disconnected', reason: 'ping_timeout' },
  { kind: 'peer', name: 'carol', change: 'unreachable', reason: 'no_response' },
  { kind: 'peer', name: 'carol', change: 'reconnected', reason: null },
  { kind: 'rule', tool: 'record_verification', code: 'SELF_VERIFY_FORBIDDEN' },
  { kind: 'rule', tool: 'start_scenario', code: 'TEST_STOPPED' },
  { kind: 'rule', tool: 'start_test', code: 'TEST_ENDED' },
];

async function written(dir: string, input: ReportInput = sampleInput(), meta: RecordsMeta = metaOf(), now = T0 + 30 * MIN) {
  const log = collectingLog();
  const result = await writeReport({ dir, input, meta, now: () => now, log });
  assert.ok(result.ok, result.ok ? '' : result.detail);
  return { ...result, text: await readFile(result.path, 'utf8'), log };
}

/** `## 제목` 으로 시작하는 구역의 본문. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `구역이 없다: ${title}`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start + 1, next < 0 ? undefined : next);
}

/** 표 한 줄을 칸으로 나눈다. 막은 구분자(`\|`)는 칸 안의 글이다. */
function cells(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((value) => value.trim());
}

const SECTION_TITLES = ['요약', '참가자와 역할', '시나리오별 결과', '실패 항목과 재현 절차', '미확인 항목', '중단 뒤 기록', '실행 통제 기록'];

describe('records: 보고서의 위치와 결과', () => {
  it('report-<test_id>-<UTC 시각>.md 를 기록 디렉터리에 0600 으로 쓰고 path 와 summary 를 돌려준다', async () => {
    const { home: dir } = await home();
    await session(dir, metaOf(), T0, CURRENT_SESSION);
    const result = await written(dir);
    assert.equal(result.path, path.join(roomDirOf(dir), `report-${TEST_ID}-20261115T083000Z.md`));
    assert.ok(path.isAbsolute(result.path));
    assert.equal(await modeOf(result.path), 0o600);
    assert.equal(await modeOf(roomDirOf(dir)), 0o700);
    assert.deepEqual(result.summary, { scenarios: 3, passed: 1, failed: 2, unverified: 5, late: 1 });
    assert.deepEqual(result.log.events.map((event) => [event.level, event.event, event.fields?.outcome]), [['info', 'report.write', 'ok']]);
    assert.ok(!JSON.stringify(result.log.events).includes(ROOM_ID), '진단 로그에 방 ID 원문을 남기지 않는다');
  });

  it('기록 파일이 없어도(기록 디렉터리가 없어도) 보고서를 쓴다', async () => {
    const { home: dir } = await home();
    const result = await written(dir);
    assert.equal(await modeOf(roomDirOf(dir)), 0o700);
    assert.match(section(result.text, '실행 통제 기록'), /- 거절된 호출\(이 참가자\): 없음\n/);
    assert.match(section(result.text, '실행 통제 기록'), /- 연결 사건: 없음\n/);
  });

  it('한 번 부를 때마다 파일 하나다. 같은 초에 다시 부르면 같은 이름에 새 내용을 쓴다', async () => {
    const { home: dir } = await home();
    const first = await written(dir, sampleInput(), metaOf(), T0 + 30 * MIN);
    const second = await written(dir, sampleInput(), metaOf(), T0 + 31 * MIN);
    assert.notEqual(first.path, second.path);
    const again = await written(dir, sampleInput({ fingerprint: 'aaaaaaaaaaaa' }), metaOf(), T0 + 31 * MIN + 400);
    assert.equal(again.path, second.path);
    assert.match(again.text, /상태 지문: aaaaaaaaaaaa/);
    assert.equal((await readdir(roomDirOf(dir))).filter((name) => name.startsWith('report-')).length, 2);
  });

  it('umask 가 0 이어도 보고서는 0600 이다', async () => {
    const { home: dir } = await home();
    const previous = process.umask(0);
    try {
      const result = await written(dir);
      assert.equal(await modeOf(result.path), 0o600);
    } finally {
      process.umask(previous);
    }
  });
});

describe('records: 보고서의 분류', () => {
  it('머리말과 구역이 정해진 순서로 있다', async () => {
    const { home: dir } = await home();
    await session(dir, metaOf(), T0, CURRENT_SESSION);
    const { text } = await written(dir);
    const head = text.slice(0, text.indexOf('\n## '));
    assert.deepEqual(head.trimEnd().split('\n'), [
      '# Agent Chat 테스트 보고서',
      '',
      `- 방: k3x9… (${refOf(ROOM_ID)}) @ wss://agent-chat.tools.camp`,
      '- 작성: alice, 2026-11-15T08:30:00Z (이 참가자의 복제본 기준)',
      '- 테스트 요청: "손들기 기능을 강사와 수강생 역할로 확인한다" (요청자 alice)',
      '- 기간: 2026-11-15T08:01:00Z ~ 2026-11-15T08:20:00Z',
      '- 종료 사유: 사용자 중단',
      '- 제한: 시간 60분, 시나리오 2/2',
      '- 상태 지문: 8bf49d06f0a5',
    ]);
    assert.deepEqual(text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3)), SECTION_TITLES);
    assert.equal(text.split('\n').filter((line) => line.startsWith('# ')).length, 1);
  });

  it('요약은 받은 분류로 센다: 성공, 실패, 미확인, 중단 뒤 기록', async () => {
    const { home: dir } = await home();
    const { text, summary } = await written(dir);
    assert.deepEqual(section(text, '요약').trimEnd().split('\n').slice(2), [
      '| 구분 | 건수 |',
      '|---|---|',
      '| 성공 (다른 참가자가 확인) | 1 |',
      '| 실패 (확인된 실패 + 반박된 성공 주장) | 2 |',
      '| 미확인 | 5 |',
      '| 중단 뒤 기록 (성공·실패에 세지 않음) | 1 |',
    ]);
    assert.deepEqual(summary, summarizeReport(sampleInput()));
  });

  it('판정을 다시 계산하지 않는다. 확인받은 pass 주장도 받은 분류가 late 면 중단 뒤 기록이다', async () => {
    const { home: dir } = await home();
    const input = sampleInput();
    // 내용만 보면 성공처럼 보이는 주장을 부르는 쪽이 다르게 분류했다.
    const reclassified: ReportInput = {
      ...input,
      scenarios: input.scenarios.map((scenario) => ({
        ...scenario,
        claims: scenario.claims.map((claim) => (claim.classification === 'passed' ? { ...claim, classification: 'late' as const } : claim)),
      })),
    };
    const { text, summary } = await written(dir, reclassified);
    assert.deepEqual(summary, { scenarios: 3, passed: 0, failed: 2, unverified: 5, late: 2 });
    assert.match(section(text, '중단 뒤 기록'), /zzzz1111yyyy-10/);
    assert.match(section(text, '요약'), /\| 성공 \(다른 참가자가 확인\) \| 0 \|/);
  });

  it('시나리오별 결과: 주장마다 행동·기대·관찰·작성자 판단·검증·분류를 싣는다', async () => {
    const { home: dir } = await home();
    const { text } = await written(dir);
    const body = section(text, '시나리오별 결과');
    assert.deepEqual(body.split('\n').filter((line) => line.startsWith('### ')), [
      '### 1. 수강생이 손을 든다 (시작: alice, 2026-11-15T08:02:00Z)',
      '### 2. 강사가 손을 내린다 (시작: bob, 2026-11-15T08:10:00Z)',
      '### 3. 동시에 시작해 밀려난 시나리오 (시작: carol, 2026-11-15T08:10:00Z)',
    ]);
    const rows = body.split('\n').filter((line) => line.startsWith('| zzzz1111yyyy-')).map(cells);
    assert.deepEqual(rows.map((row) => [row[0], row[1], row[5], row[7]]), [
      ['zzzz1111yyyy-10', 'alice', 'pass', '성공'],
      ['zzzz1111yyyy-11', 'bob', 'fail', '실패'],
      ['zzzz1111yyyy-12', 'alice', 'pass', '실패'],
      ['zzzz1111yyyy-13', 'alice', 'pass', '미확인'],
      ['zzzz1111yyyy-14', 'alice', 'pass', '미확인'],
      ['zzzz1111yyyy-15', 'alice', 'pass', '미확인'],
      ['zzzz1111yyyy-16', 'alice', 'pass', '미확인'],
      ['zzzz1111yyyy-20', 'bob', 'pass', '중단 뒤 기록'],
      ['zzzz1111yyyy-30', 'carol', 'pass', '미확인'],
    ]);
    assert.ok(rows.every((row) => row.length === 8), '모든 줄이 여덟 칸이다');
    assert.deepEqual(rows[0]?.slice(2, 5), ['손들기 버튼을 눌렀다', '강사 화면에 손 표시', '강사 화면에 손 표시가 떴다']);
    assert.equal(rows[0]?.[6], 'bob: confirmed — 강사 화면 캡처에서 손 표시를 봤다');
    // 확인과 반박이 함께 있으면 둘 다 싣는다.
    assert.equal(rows[2]?.[6], 'bob: confirmed — bob 의 화면에는 떴다<br>carol: refuted — carol 의 화면에는 뜨지 않았다');
    assert.equal(rows[3]?.[6], '없음');
    assert.equal(rows[6]?.[6], 'alice: confirmed (자기 검증, 판정에서 뺌) — 내가 봤다');
    assert.match(body, /### 3\. .*\n\n한도 초과 시나리오다\./);
  });

  it('실패 항목과 재현 절차: 확인된 실패와 반박된 성공 주장을 관찰·재현 절차·모든 증거와 함께 싣는다', async () => {
    const { home: dir } = await home();
    const { text } = await written(dir);
    const body = section(text, '실패 항목과 재현 절차');
    assert.deepEqual(body.split('\n').filter((line) => line.startsWith('### ')), [
      '### zzzz1111yyyy-11 손 내리기를 눌렀다',
      '### zzzz1111yyyy-12 채팅을 보냈다',
    ]);
    assert.ok(body.includes(['- 관찰: 손 표시가 그대로 남았다', '- 재현 절차:', '  > 1. 손을 든다', '  > 2. 손 내리기를 누른다', '  > 3. 강사 화면을 본다', '- 검증: alice — confirmed, 증거: 내 화면에서도 남아 있었다'].join('\n')));
    assert.ok(body.includes('- 검증: bob — confirmed, 증거: bob 의 화면에는 떴다\n- 검증: carol — refuted, 증거: carol 의 화면에는 뜨지 않았다'));
    assert.ok(!body.includes('zzzz1111yyyy-10'), '성공한 주장은 여기에 없다');
    assert.ok(!body.includes('zzzz1111yyyy-20'), '중단 뒤 기록은 여기에 없다');
  });

  it('미확인 항목: 이유(검증 없음, unable, 검증자 연결 끊김, 한도 초과 시나리오)와 재현 절차를 싣는다', async () => {
    const { home: dir } = await home();
    const { text } = await written(dir);
    const rows = section(text, '미확인 항목').split('\n').filter((line) => line.startsWith('| zzzz1111yyyy-')).map(cells);
    assert.deepEqual(rows.map((row) => [row[0], row[1]]), [
      ['zzzz1111yyyy-13', '검증 없음'],
      ['zzzz1111yyyy-14', 'unable (확인하지 못함)'],
      ['zzzz1111yyyy-15', '검증자 연결 끊김'],
      ['zzzz1111yyyy-16', '이유가 기록되지 않음'],
      ['zzzz1111yyyy-30', '한도 초과 시나리오'],
    ]);
    assert.ok(rows.every((row) => row.length === 3 && row[2] === '1. 수업에 들어간다<br>2. 손들기를 누른다'));
  });

  it('중단 뒤 기록: 확인을 받았어도 따로 싣고 성공·실패에 세지 않는다', async () => {
    const { home: dir } = await home();
    const { text, summary } = await written(dir);
    const rows = section(text, '중단 뒤 기록').split('\n').filter((line) => line.startsWith('| zzzz1111yyyy-')).map(cells);
    assert.deepEqual(rows, [['zzzz1111yyyy-20', 'bob', '중단 뒤에 적은 행동', 'pass', 'alice: confirmed — 확인은 했다']]);
    assert.equal(summary.passed, 1, '확인받은 중단 뒤 기록은 성공에 들지 않는다');
    assert.ok(!section(text, '실패 항목과 재현 절차').includes('중단 뒤에 적은 행동'));
    assert.ok(!section(text, '미확인 항목').includes('zzzz1111yyyy-20'));
  });

  it('해당 항목이 없는 구역은 "없음"으로 남긴다. 구역을 빼지 않는다', async () => {
    const { home: dir } = await home();
    const input = sampleInput({ scenarios: [] });
    const { text, summary } = await written(dir, input);
    assert.deepEqual(summary, { scenarios: 0, passed: 0, failed: 0, unverified: 0, late: 0 });
    assert.deepEqual(text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3)), SECTION_TITLES);
    assert.match(section(text, '시나리오별 결과'), /시나리오 없음\./);
    for (const title of ['실패 항목과 재현 절차', '미확인 항목', '중단 뒤 기록']) assert.match(section(text, title), /\n없음\.\n/);
    assert.match(section(text, '실행 통제 기록'), /- 한도 초과 시나리오: 없음\n/);
  });

  it('중간 보고: 중단 전이면 진행 중으로 적고 기간의 끝은 작성 시각이다', async () => {
    const { home: dir } = await home();
    const base = sampleInput();
    const { text } = await written(dir, { ...base, test: { ...base.test, stop: null, scenarios_used: 1 } });
    assert.match(text, /- 기간: 2026-11-15T08:01:00Z ~ 2026-11-15T08:30:00Z\n/);
    assert.match(text, /- 종료 사유: 진행 중\(중간 보고\)\n/);
    assert.match(text, /- 제한: 시간 60분, 시나리오 1\/2\n/);
    assert.match(section(text, '실행 통제 기록'), /- 중단: 없음 \(진행 중\)\n/);

    const limited = await written(dir, { ...base, test: { ...base.test, stop: { by: 'carol', wall: T0 + 61 * MIN, reason: 'time_limit', detail: '' } } }, metaOf(), T0 + 62 * MIN);
    assert.match(limited.text, /- 종료 사유: 시간 제한\n/);
    assert.match(section(limited.text, '실행 통제 기록'), /- 중단: carol, 2026-11-15T09:01:00Z, 시간 제한\n/);
  });
});

describe('records: 보고서가 기록 파일에서 뽑는 것', () => {
  it('실행 통제 기록: 중단, 거절된 호출, 한도 초과 시나리오, 연결 사건', async () => {
    const { home: dir } = await home();
    await session(dir, metaOf(), T0, CURRENT_SESSION);
    const { text } = await written(dir);
    assert.deepEqual(section(text, '실행 통제 기록').trimEnd().split('\n').slice(2), [
      '- 중단: bob, 2026-11-15T08:20:00Z, 사용자 중단 — "사용자가 멈추라고 했다"',
      '- 거절된 호출(이 참가자): 3건',
      '  - record_verification, SELF_VERIFY_FORBIDDEN, 2026-11-15T08:02:30Z',
      '  - start_scenario, TEST_STOPPED, 2026-11-15T08:02:40Z',
      '  - start_test, TEST_ENDED, 2026-11-15T08:02:50Z',
      '- 한도 초과 시나리오: 1건',
      '  - 3. 동시에 시작해 밀려난 시나리오 (시작: carol)',
      '- 연결 사건: 4건',
      '  - 2026-11-15T08:01:30Z: carol joined',
      '  - 2026-11-15T08:02:00Z: carol disconnected (ping_timeout)',
      '  - 2026-11-15T08:02:10Z: carol unreachable (no_response)',
      '  - 2026-11-15T08:02:20Z: carol reconnected',
    ]);
  });

  it('참가자와 역할: 역할 변화를 기록 파일의 presence 줄에서 시각 순으로 뽑는다', async () => {
    const { home: dir } = await home();
    await session(dir, metaOf(), T0, CURRENT_SESSION);
    const { text } = await written(dir);
    const rows = section(text, '참가자와 역할').split('\n').slice(4).filter((line) => line.startsWith('|')).map(cells);
    assert.deepEqual(rows, [
      ['alice', 'claude-code', 'browser, shell', '(없음) (2026-11-15T08:00:10Z) → 강사 (2026-11-15T08:02:00Z) → 수강생 (2026-11-15T08:11:02Z)', 'ready'],
      ['bob', 'codex', 'browser', '수강생 (2026-11-15T08:00:20Z) → 강사 (2026-11-15T08:11:00Z)', 'working (표시: working)'],
      // presence 를 받지 못한 참가자. 기록 파일에도 없으면 지금 값만 적는다.
      ['carol', '—', '—', '(없음)', '알 수 없음 (표시: disconnected)'],
    ]);
  });

  it('같은 테스트의 앞선 입장은 싣고, 다른 테스트의 기록 파일은 섞지 않는다', async () => {
    const { home: dir } = await home();
    // 같은 방 ID 로 예전에 한 다른 테스트. 같은 디렉터리에 남아 있다.
    await session(dir, metaOf({ sid: 'oldoldoldold' }), T0 - 24 * 60 * MIN, [
      testStarted('oldoldoldold-1', T0 - 24 * 60 * MIN),
      presence('bob', '예전 역할', T0 - 24 * 60 * MIN),
      { kind: 'rule', tool: 'start_test', code: 'TEST_ALREADY_ACTIVE' },
      { kind: 'peer', name: 'dave', change: 'disconnected', reason: 'old' },
    ]);
    // 이 테스트 도중의 앞선 입장(나갔다가 다시 들어왔다).
    await session(dir, metaOf({ sid: 'prevprevprev' }), T0, [
      testStarted(TEST_ID, T0 + MIN),
      presence('bob', '수강생', T0 + MIN),
      { kind: 'rule', tool: 'record_claim', code: 'UNKNOWN_SCENARIO' },
      { kind: 'peer', name: 'bob', change: 'disconnected', reason: 'bye' },
    ]);
    // 이번 입장. 스냅샷으로 받은 기록에는 test 기록이 없을 수도 있다. 그래도 이번 입장의 파일은 싣는다.
    await session(dir, metaOf(), T0 + 15 * MIN, [
      presence('bob', '강사', T0 + 16 * MIN),
      { kind: 'rule', tool: 'start_scenario', code: 'TEST_STOPPED' },
      { kind: 'peer', name: 'bob', change: 'reconnected', reason: null },
    ]);

    const { text, log } = await written(dir);
    const control = section(text, '실행 통제 기록');
    assert.match(control, /거절된 호출\(이 참가자\): 2건\n {2}- record_claim, UNKNOWN_SCENARIO, 2026-11-15T08:00:30Z\n {2}- start_scenario, TEST_STOPPED, 2026-11-15T08:15:20Z\n/);
    assert.match(control, /연결 사건: 2건\n {2}- 2026-11-15T08:00:40Z: bob disconnected \(bye\)\n {2}- 2026-11-15T08:15:30Z: bob reconnected\n/);
    assert.ok(!text.includes('TEST_ALREADY_ACTIVE') && !text.includes('dave') && !text.includes('예전 역할'), '다른 테스트의 기록은 섞이지 않는다');
    assert.match(section(text, '참가자와 역할'), /\| bob \| codex \| browser \| 수강생 \(2026-11-15T08:01:00Z\) → 강사 \(2026-11-15T08:16:00Z\) \|/);
    assert.deepEqual(log.events.map((event) => event.event), ['report.write'], '읽지 못한 파일이 없다');
  });

  it('다른 참가자 이름의 디렉터리에 있는 기록 파일은 읽지 않는다', async () => {
    const { home: dir } = await home();
    await session(dir, metaOf({ name: 'bob', sid: 'bobbobbobbob' }), T0, [testStarted(TEST_ID, T0), { kind: 'rule', tool: 'start_test', code: 'TEST_ENDED' }]);
    const { text } = await written(dir);
    assert.match(section(text, '실행 통제 기록'), /거절된 호출\(이 참가자\): 없음/);
  });

  it('깨진 줄, 쓰다 만 줄, 형식이 다른 줄은 건너뛰고 나머지를 싣는다', async () => {
    const { home: dir } = await home();
    const file = await session(dir, metaOf(), T0, [{ kind: 'rule', tool: 'start_scenario', code: 'TEST_STOPPED' }]);
    await appendFile(
      file,
      [
        'not json',
        '[]',
        '{"ts":"2026-11-15T08:05:00.000Z","kind":"rule","tool":5,"code":"X"}',
        '{"ts":"2026-11-15T08:05:00.000Z","kind":"state","record":null}',
        '{"ts":"2026-11-15T08:05:00.000Z","kind":"state","record":{"kind":"presence","author":"bob","wall":"x","body":{"role":"강사"}}}',
        '{"ts":12345,"kind":"rule","tool":"record_claim","code":"STATE_FULL"}',
        `{"ts":"2026-11-15T08:06:00.000Z","kind":"chat_in","text":"${'x'.repeat(2 * 1024 * 1024)}"}`,
        '{"ts":"2026-11-15T08:07:00.000Z","kind":"rule","tool":"start_test","code":"TEST_ENDED"}',
        '{"ts":"2026-11-15T08:08:00.000Z","kind":"rule","tool":"stop_test","code":"NO_',
      ].join('\n'),
    );
    const { text } = await written(dir);
    const control = section(text, '실행 통제 기록').split('\n');
    const rejected = control.slice(control.findIndex((line) => line.startsWith('- 거절된 호출')) + 1, control.findIndex((line) => line.startsWith('- 한도 초과')));
    assert.deepEqual(rejected, [
      '  - start_scenario, TEST_STOPPED, 2026-11-15T08:00:10Z',
      '  - record_claim, STATE_FULL, 시각 불명',
      '  - start_test, TEST_ENDED, 2026-11-15T08:07:00Z',
    ]);
  });

  it('기록 파일을 읽지 못해도 보고서는 쓰고, 빠졌을 수 있다고 적는다', async () => {
    const { root, home: dir } = await home();
    await session(dir, metaOf(), T0, CURRENT_SESSION);
    // 형식이 맞는 이름의 심볼릭 링크. 링크를 따라가 읽지 않는다.
    const outside = path.join(root, 'outside.jsonl');
    await writeFile(outside, '{"ts":"2026-11-15T08:00:00.000Z","kind":"rule","tool":"leaked","code":"LEAKED"}\n');
    await symlink(outside, path.join(roomDirOf(dir), 'transcript-20261115T070000Z-linklinklink.jsonl'));

    const { text, log } = await written(dir);
    assert.ok(!text.includes('LEAKED'));
    assert.match(section(text, '실행 통제 기록'), /거절된 호출\(이 참가자\): 3건 \(기록 파일을 읽지 못해 일부가 빠졌을 수 있다\)/);
    assert.match(section(text, '참가자와 역할'), /역할 변화 이력은 기록 파일을 읽지 못해 일부가 빠졌을 수 있다\./);
    assert.deepEqual(log.events.map((event) => [event.level, event.event]), [['warn', 'report.transcript_read'], ['info', 'report.write']]);
  });
});

describe('records: 보고서에 방 ID 원문이 없다', () => {
  it('머리말에는 앞 4자와 room_ref 만 있다', async () => {
    const { home: dir } = await home();
    await session(dir, metaOf(), T0, CURRENT_SESSION);
    const { text } = await written(dir);
    assert.ok(!text.includes(ROOM_ID));
    assert.ok(text.includes(`- 방: ${ROOM_ID.slice(0, 4)}… (${refOf(ROOM_ID)})`));
    assert.match(refOf(ROOM_ID), /^[0-9a-f]{12}$/);
    for (let length = 5; length <= ROOM_ID.length; length += 1) {
      assert.ok(!text.includes(ROOM_ID.slice(0, length)), `방 ID 의 앞 ${length}자`);
    }
  });

  it('참가자가 쓴 글과 기록 파일의 값에 방 ID 가 들어 있어도 가린다', async () => {
    const { home: dir } = await home();
    await session(dir, metaOf(), T0, [
      presence('bob', `강사 ${ROOM_ID}`, T0 + MIN),
      { kind: 'rule', tool: `tool-${ROOM_ID}`, code: `CODE_${ROOM_ID}` },
      { kind: 'peer', name: 'bob', change: 'disconnected', reason: `방 ${ROOM_ID} 에서 끊김` },
    ]);
    const base = sampleInput();
    const leak = `방 ${ROOM_ID} 에 들어가서\n${ROOM_ID}${ROOM_ID} 를 다시 넣었다`;
    const input: ReportInput = {
      ...base,
      fingerprint: ROOM_ID.slice(0, 12),
      test: { ...base.test, request: leak, stop: { by: 'bob', wall: T0 + 20 * MIN, reason: 'user', detail: leak } },
      participants: base.participants.map((participant) => ({ ...participant, client: `client ${ROOM_ID}`, tools: [ROOM_ID], role: `역할 ${ROOM_ID}` })),
      scenarios: base.scenarios.map((scenario) => ({
        ...scenario,
        title: `제목 ${ROOM_ID}`,
        claims: scenario.claims.map((claim) => ({
          ...claim,
          action: leak,
          expected: leak,
          observed: leak,
          steps: leak,
          verifications: claim.verifications.map((verification) => ({ ...verification, evidence: leak })),
        })),
      })),
    };
    const { text } = await written(dir, input);
    assert.ok(!text.includes(ROOM_ID), '방 ID 원문이 어디에도 없다');
    assert.ok(text.includes('방 k3x9… 에 들어가서'), '가린 자리에 앞 4자를 남긴다');
    assert.ok(text.includes('k3x9…k3x9… 를 다시 넣었다'));
    assert.ok(text.includes('tool-k3x9…, CODE_k3x9…'));
  });

  it('방 ID 가 보고서의 고정 낱말과 같아도 원문을 남기지 않는다', async () => {
    const { home: dir } = await home();
    const meta = metaOf({ room_id: 'confirmed' });
    const { text } = await written(dir, sampleInput(), meta);
    assert.ok(!text.includes('confirmed'));
    assert.ok(text.includes('conf…'));
  });

  it('참가자 이름이나 서버 키가 방 ID 를 담고 있어도 가린다', async () => {
    const { home: dir } = await home();
    const meta = metaOf({ name: ROOM_ID, server_key: `wss://${ROOM_ID}.example.com` });
    const { text } = await written(dir, sampleInput(), meta);
    assert.ok(!text.includes(ROOM_ID));
  });
});

describe('records: 다른 참가자가 쓴 글이 보고서의 구조를 바꾸지 못한다', () => {
  it('줄바꿈, 표 구분자, 제목 표시, HTML 이 든 글을 넣어도 구역과 표가 그대로다', async () => {
    const { home: dir } = await home();
    const evil = '끝 |\n\n## 요약\n\n| 구분 | 건수 |\n|---|---|\n| 성공 (다른 참가자가 확인) | 99 |\n# 가짜 보고서\n<script>alert(1)</script> \\| a & b\r\n```\n- 중단: 없음';
    await session(dir, metaOf(), T0, [
      presence('bob', evil, T0 + MIN),
      { kind: 'rule', tool: evil, code: evil },
      { kind: 'peer', name: 'bob', change: 'disconnected', reason: evil },
    ]);
    const base = sampleInput();
    const input: ReportInput = {
      ...base,
      test: { ...base.test, request: evil, stop: { by: 'bob', wall: T0 + 20 * MIN, reason: 'user', detail: evil } },
      participants: base.participants.map((participant) => ({ ...participant, client: evil, tools: [evil, evil], role: evil })),
      scenarios: base.scenarios.map((scenario) => ({
        ...scenario,
        title: evil,
        claims: scenario.claims.map((claim) => ({
          ...claim,
          action: evil,
          expected: evil,
          observed: evil,
          steps: evil,
          verifications: claim.verifications.map((verification) => ({ ...verification, evidence: evil })),
        })),
      })),
    };
    const { text, summary } = await written(dir, input);
    const lines = text.split('\n');
    assert.deepEqual(lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3)), SECTION_TITLES, '구역이 늘지 않는다');
    assert.equal(lines.filter((line) => line.startsWith('# ')).length, 1);
    assert.ok(!text.includes('<script>'), 'HTML 로 읽히지 않는다');
    // 꺾쇠는 이 모듈이 넣은 줄바꿈 표시(<br>)와 인용 표시뿐이다.
    for (const line of lines) assert.ok(!/[<>]/.test(line.replace(/^ {2}> /, '').replaceAll('<br>', '')), `막지 않은 꺾쇠: ${line.slice(0, 60)}`);
    assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && text.includes('a &amp; b'));
    assert.ok(!text.includes('\r'));
    assert.deepEqual(summary, { scenarios: 3, passed: 1, failed: 2, unverified: 5, late: 1 });
    assert.match(section(text, '요약'), /\| 성공 \(다른 참가자가 확인\) \| 1 \|/);
    assert.ok(!/^\| 성공 \(다른 참가자가 확인\) \| 99 \|/m.test(text), '가짜 요약 줄이 표의 줄로 서지 않는다');

    // 표의 모든 줄이 머리 줄과 같은 칸 수다.
    for (const [title, columns] of [['참가자와 역할', 5], ['시나리오별 결과', 8], ['미확인 항목', 3], ['중단 뒤 기록', 5]] as const) {
      const rows = section(text, title).split('\n').filter((line) => line.startsWith('|'));
      assert.ok(rows.length >= 3, title);
      for (const row of rows) assert.equal(cells(row).length, columns, `${title}: ${row.slice(0, 60)}`);
    }
    // 표 밖의 줄은 정해진 모양으로만 시작한다. 글이 새 줄머리를 만들지 못한다.
    const allowed = /^(?:$|# Agent Chat 테스트 보고서$|## |### \d+\. |### zzzz1111yyyy-\d+ |\| |\|---|- | {2}> | {2}- |한도 초과 시나리오다\.|성공·실패에 세지 않는다\.|없음\.$|시나리오 없음\.$|주장 없음\.$)/;
    for (const line of lines) assert.match(line, allowed, `뜻밖의 줄머리: ${line.slice(0, 60)}`);
    // 목록 항목 안의 여러 줄은 줄마다 인용 표시가 붙는다.
    assert.ok(text.includes('  > ## 요약'));
    assert.ok(text.includes('  > # 가짜 보고서'));
  });
});

describe('records: 보고서의 실패', () => {
  it('형식에 맞지 않는 값은 RECORD_FAILED 이고 아무 것도 쓰지 않는다(던지지 않는다)', async () => {
    const { root, home: dir } = await home();
    const base = sampleInput();
    const cases: [string, ReportInput, RecordsMeta][] = [
      ['test_id 에 상위 경로', { ...base, test: { ...base.test, test_id: '../../../escape' } }, metaOf()],
      ['test_id 에 구분자', { ...base, test: { ...base.test, test_id: 'zzzz1111yyyy-1/x' } }, metaOf()],
      ['test_id 가 비었다', { ...base, test: { ...base.test, test_id: '' } }, metaOf()],
      ['이름에 상위 경로', base, metaOf({ name: '../../escape' })],
      ['방 ID 에 상위 경로', base, metaOf({ room_id: '../../escape' })],
      ['sid 가 틀렸다', base, metaOf({ sid: 'x' })],
      ['입력이 없다', null as unknown as ReportInput, metaOf()],
    ];
    for (const [label, input, meta] of cases) {
      const log = collectingLog();
      const result = await writeReport({ dir, input, meta, now: () => T0, log });
      assert.deepEqual({ ok: result.ok, code: result.ok ? '' : result.code }, { ok: false, code: 'RECORD_FAILED' }, label);
      assert.equal(log.events.at(-1)?.level, 'error', label);
      assert.match(String(log.events.at(-1)?.fields?.reason), /^(?:invalid_meta|invalid_test_id|unexpected)$/, label);
    }
    assert.deepEqual((await listTree(root)).filter((entry) => entry.endsWith('.md')), [], '보고서 파일이 생기지 않는다');
    assert.deepEqual((await listTree(root)).filter((entry) => !entry.startsWith('home')), [], 'home 밖에 생긴 것이 없다');
  });

  it('보고서 자리에 심볼릭 링크가 있으면 따라가지 않고 실패한다', async () => {
    const { root, home: dir } = await home();
    await mkdir(roomDirOf(dir), { recursive: true });
    const victim = path.join(root, 'victim.md');
    await writeFile(victim, 'keep\n');
    await symlink(victim, path.join(roomDirOf(dir), `report-${TEST_ID}-20261115T083000Z.md`));
    const result = await writeReport({ dir, input: sampleInput(), meta: metaOf(), now: () => T0 + 30 * MIN, log: collectingLog() });
    assert.equal(result.ok, false);
    assert.equal(await readFile(victim, 'utf8'), 'keep\n');
  });

  it('시계가 틀린 값을 줘도, 기록의 wall 이 날짜가 아니어도 던지지 않는다', async () => {
    const { home: dir } = await home();
    const badClock = await writeReport({ dir, input: sampleInput(), meta: metaOf(), now: () => Number.NaN, log: collectingLog() });
    assert.equal(badClock.ok, false);

    const base = sampleInput();
    // wall 은 다른 참가자가 보낸 값이다. 2^53 − 1 까지 올 수 있고 그것은 날짜가 아니다.
    const input: ReportInput = {
      ...base,
      test: { ...base.test, started_wall: Number.MAX_SAFE_INTEGER, stop: { by: 'bob', wall: Number.MAX_SAFE_INTEGER, reason: 'user', detail: '' } },
      scenarios: base.scenarios.map((scenario) => ({ ...scenario, wall: Number.MAX_SAFE_INTEGER })),
    };
    const { text } = await written(dir, input);
    assert.match(text, /- 기간: 시각 불명 ~ 시각 불명\n/);
    assert.match(text, /### 1\. 수강생이 손을 든다 \(시작: alice, 시각 불명\)/);
  });
});
