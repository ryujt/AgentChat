// V-U5: 기록 파일. 위치와 이름, 권한, 경로 탈출 방지, 줄 형식과 순서, 실패를 결과로 알리는 것.

import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { StateRecord } from '../protocol/index.js';
import type { RecordsMeta, TranscriptEntry } from './contract.js';
import { openTranscript } from './index.js';
import { checkMeta, ensureRoomDir, isoTime, serverKeySlug, utcStamp } from './paths.js';
import { MIN, ROOM_ID, SEC, SID, T0, collectingLog, listTree, makeHome, metaOf, modeOf, roomDirOf } from './testing.js';
import { TRANSCRIPT_FILE_PATTERN, createTranscriptWriter, type LineSink } from './transcript.js';

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function home(): Promise<{ root: string; home: string }> {
  const made = await makeHome();
  cleanups.push(made.cleanup);
  return made;
}

async function linesOf(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, 'utf8');
  assert.ok(text.endsWith('\n'), '마지막 줄도 줄바꿈으로 끝난다');
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const PRESENCE: StateRecord = {
  kind: 'presence',
  key: 'presence/bob',
  author: 'bob',
  lc: T0,
  wall: T0,
  body: { client: 'codex', tools: ['browser'], role: '강사', status: 'ready', listening: true, note: null },
};

const ENTRIES: TranscriptEntry[] = [
  { kind: 'mode', from: 'poll', to: 'channel', cause: 'confirmed' },
  { kind: 'peer', name: 'bob', change: 'joined', reason: null },
  { kind: 'state', origin: 'remote', from: 'bob', record: PRESENCE },
  { kind: 'chat_out', id: `${SID}-1`, to: null, text: '안녕하세요\n두 번째 줄 "따옴표"  ', delivered: ['bob'], undelivered: [{ name: 'carol', reason: 'ack_timeout' }] },
  { kind: 'chat_in', id: 'bbbbbbbbbbbb-1', from: 'bob', to: 'you', text: '네, 보입니다' },
  { kind: 'rule', tool: 'start_scenario', code: 'TEST_STOPPED' },
  { kind: 'end', reason: 'leave' },
];

describe('records: 위치와 이름', () => {
  it('서버 키 슬러그는 허용 글자 밖을 _ 로 바꾼다', () => {
    assert.equal(serverKeySlug('wss://agent-chat.tools.camp'), 'wss_agent-chat.tools.camp', 'mcp-interface.md 8.1 의 예');
    assert.equal(serverKeySlug('ws://127.0.0.1:8787'), 'ws_127.0.0.1_8787');
    assert.equal(serverKeySlug('ws://[::1]:8787'), 'ws_1_8787');
    assert.equal(serverKeySlug('wss://example.com/../../etc'), 'wss_example.com_.._.._etc', '구분자가 없으므로 한 디렉터리 이름이다');
    for (const bad of ['', '.', '..', '...', 5, null, undefined]) assert.equal(serverKeySlug(bad), null, String(bad));
    assert.equal(serverKeySlug('/'), '_');
    assert.match(serverKeySlug('wss://한글.example') ?? '', /^[A-Za-z0-9._-]+$/);
  });

  it('파일 이름의 시각은 UTC 연월일T시분초Z 다', () => {
    assert.equal(utcStamp(T0), '20261115T080000Z');
    assert.equal(utcStamp(T0 + 61 * SEC + 999), '20261115T080101Z');
    assert.equal(utcStamp(Date.UTC(2027, 0, 2, 3, 4, 5)), '20270102T030405Z');
    assert.equal(utcStamp(Number.NaN), null);
    assert.equal(utcStamp(8.64e15 + 1), null);
    assert.equal(isoTime(T0), '2026-11-15T08:00:00.000Z');
    assert.equal(isoTime(Number.POSITIVE_INFINITY), null);
  });

  it('입장 한 번에 파일 하나: <dir>/rooms/<슬러그>/<room_id>/<name>/transcript-<시각>-<sid>.jsonl', async () => {
    const { home: dir } = await home();
    const log = collectingLog();
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log });
    assert.ok(opened.ok);
    const file = opened.transcript.path;
    assert.equal(file, path.join(dir, 'rooms', 'wss_agent-chat.tools.camp', ROOM_ID, 'alice', `transcript-20261115T080000Z-${SID}.jsonl`));
    assert.ok(path.isAbsolute(file));
    assert.match(path.basename(file), TRANSCRIPT_FILE_PATTERN);
    await opened.transcript.close();

    // 다시 들어오면 sid 와 시각이 다른 새 파일이다.
    const again = await openTranscript({ dir, meta: metaOf({ sid: 'zzzzzzzzzzzz' }), now: () => T0 + MIN, log });
    assert.ok(again.ok);
    await again.transcript.close();
    assert.deepEqual((await readdir(roomDirOf(dir))).sort(), [`transcript-20261115T080000Z-${SID}.jsonl`, 'transcript-20261115T080100Z-zzzzzzzzzzzz.jsonl']);
  });

  it('상대 경로로 준 dir 도 절대 경로가 된다', async () => {
    const { home: dir } = await home();
    const relative = path.relative(process.cwd(), dir);
    const opened = await openTranscript({ dir: relative, meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.ok(opened.ok);
    assert.ok(path.isAbsolute(opened.transcript.path));
    assert.equal(opened.transcript.path, path.join(roomDirOf(dir), `transcript-20261115T080000Z-${SID}.jsonl`));
    await opened.transcript.close();
  });
});

describe('records: 권한', () => {
  it('디렉터리는 0700, 파일은 0600 이다. umask 가 0 이어도 같다', async () => {
    const { home: dir } = await home();
    const previous = process.umask(0);
    try {
      const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
      assert.ok(opened.ok);
      await opened.transcript.append({ kind: 'end', reason: 'leave' });
      await opened.transcript.close();
      assert.equal(await modeOf(opened.transcript.path), 0o600);
      let current = path.join(dir, 'rooms');
      for (const segment of ['', 'wss_agent-chat.tools.camp', ROOM_ID, 'alice']) {
        current = path.join(current, segment);
        assert.equal(await modeOf(current), 0o700, current.slice(dir.length));
      }
    } finally {
      process.umask(previous);
    }
  });

  it('umask 가 077 보다 넓게 깎아도(0777) 소유자 권한을 갖는다', async () => {
    const { home: dir } = await home();
    await mkdir(dir, { recursive: true });
    const previous = process.umask(0o777);
    try {
      const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
      assert.ok(opened.ok, opened.ok ? '' : opened.detail);
      await opened.transcript.close();
      assert.equal(await modeOf(opened.transcript.path), 0o600);
      assert.equal(await modeOf(roomDirOf(dir)), 0o700);
    } finally {
      process.umask(previous);
    }
  });

  it('이미 있는 디렉터리와 파일의 넓은 권한을 좁힌다. AGENT_CHAT_HOME 자체는 건드리지 않는다', async () => {
    const { home: dir } = await home();
    const target = roomDirOf(dir);
    await mkdir(target, { recursive: true, mode: 0o755 });
    for (const loose of [target, path.dirname(target), path.join(dir, 'rooms')]) await chmod(loose, 0o755);
    await chmod(dir, 0o755);
    const file = path.join(target, `transcript-20261115T080000Z-${SID}.jsonl`);
    await writeFile(file, '{"ts":"x","kind":"session"}\n', { mode: 0o644 });
    await chmod(file, 0o644);

    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.ok(opened.ok);
    await opened.transcript.close();
    assert.equal(await modeOf(file), 0o600);
    assert.equal(await modeOf(target), 0o700);
    assert.equal(await modeOf(path.join(dir, 'rooms')), 0o700);
    assert.equal(await modeOf(dir), 0o755, '다른 모듈도 쓰는 디렉터리다');
    // 덧붙이기만 한다. 있던 줄을 고쳐 쓰지 않는다.
    const text = await readFile(file, 'utf8');
    assert.ok(text.startsWith('{"ts":"x","kind":"session"}\n{"ts":"2026-11-15T08:00:00.000Z","kind":"session"'));
  });
});

describe('records: 경로 탈출 방지', () => {
  const BAD_METAS: [string, Partial<RecordsMeta>][] = [
    ['이름에 상위 경로', { name: '../escape' }],
    ['이름에 구분자', { name: 'a/b' }],
    ['이름이 ..', { name: '..' }],
    ['이름이 비었다', { name: '' }],
    ['이름에 공백', { name: 'a b' }],
    ['이름이 33자', { name: 'a'.repeat(33) }],
    ['이름에 널 문자', { name: 'a\u0000b' }],
    ['예약 이름', { name: 'room' }],
    ['이름이 문자열이 아니다', { name: 42 as unknown as string }],
    ['방 ID 에 상위 경로', { room_id: '../../../../etc' }],
    ['방 ID 에 구분자', { room_id: 'abcd/efgh' }],
    ['방 ID 에 대문자', { room_id: 'ABCDEFGH' }],
    ['방 ID 가 짧다', { room_id: 'abc' }],
    ['방 ID 가 33자', { room_id: 'a'.repeat(33) }],
    ['sid 에 상위 경로', { sid: '../../../x' }],
    ['sid 가 짧다', { sid: 'abc' }],
    ['서버 키가 ..', { server_key: '..' }],
    ['서버 키가 비었다', { server_key: '' }],
  ];

  it('형식 검증을 통과하지 못한 값은 RECORD_FAILED 이고 아무 것도 만들지 않는다', async () => {
    const { root, home: dir } = await home();
    for (const [label, overrides] of BAD_METAS) {
      const log = collectingLog();
      const opened = await openTranscript({ dir, meta: metaOf(overrides), now: () => T0, log });
      assert.equal(opened.ok, false, label);
      assert.equal(opened.ok ? '' : opened.code, 'RECORD_FAILED', label);
      assert.equal(checkMeta(metaOf(overrides)).ok, false, label);
      assert.equal(log.events.length, 1, '실패를 진단 로그에 남긴다');
      assert.equal(log.events[0]?.level, 'error');
      assert.deepEqual(log.events[0]?.fields, { room_ref: undefined, outcome: 'failed', reason: 'invalid_meta', error_code: undefined }, '사유는 짧은 이름으로만 남긴다');
    }
    // 디렉터리를 만들기 전에 거절한다. 임시 폴더 안팎에 생긴 것이 없다.
    assert.deepEqual(await listTree(root), []);
  });

  it('서버 키의 경로 글자는 슬러그가 되어 한 디렉터리 안에 머문다', async () => {
    const { root, home: dir } = await home();
    const opened = await openTranscript({ dir, meta: metaOf({ server_key: 'wss://example.com/../../../../outside' }), now: () => T0, log: collectingLog() });
    assert.ok(opened.ok);
    await opened.transcript.close();
    assert.ok(opened.transcript.path.startsWith(path.join(dir, 'rooms', 'wss_example.com_.._.._.._.._outside', ROOM_ID, 'alice') + path.sep));
    assert.deepEqual((await listTree(root)).filter((entry) => !entry.startsWith('home')), [], 'home 밖에 생긴 것이 없다');
  });

  it('경로 중간이 심볼릭 링크면 따라가지 않고 실패한다', async () => {
    for (const depth of [1, 2, 3, 4]) {
      const { root, home: dir } = await home();
      const outside = path.join(root, 'outside');
      await mkdir(outside, { recursive: true });
      const segments = ['rooms', 'wss_agent-chat.tools.camp', ROOM_ID, 'alice'].slice(0, depth);
      const link = path.join(dir, ...segments);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(outside, link);

      const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
      assert.equal(opened.ok, false, `깊이 ${depth}`);
      assert.equal(opened.ok ? '' : opened.code, 'RECORD_FAILED');
      assert.deepEqual(await readdir(outside), [], `깊이 ${depth}: 링크가 가리키는 곳에 쓰지 않는다`);
      const direct = await ensureRoomDir(dir, metaOf());
      assert.equal(direct.ok, false);
    }
  });

  it('기록 파일 자리에 심볼릭 링크가 있으면 따라가지 않고 실패한다', async () => {
    const { root, home: dir } = await home();
    const target = roomDirOf(dir);
    await mkdir(target, { recursive: true });
    const victim = path.join(root, 'victim.txt');
    await writeFile(victim, 'keep\n');
    await symlink(victim, path.join(target, `transcript-20261115T080000Z-${SID}.jsonl`));

    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.equal(opened.ok, false);
    assert.equal(await readFile(victim, 'utf8'), 'keep\n');
  });

  it('디렉터리 자리에 파일이 있으면 실패를 결과로 알린다(던지지 않는다)', async () => {
    const { home: dir } = await home();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'rooms'), 'not a directory');
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.deepEqual({ ok: opened.ok, code: opened.ok ? '' : opened.code }, { ok: false, code: 'RECORD_FAILED' });

    const empty = await openTranscript({ dir: '', meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.equal(empty.ok, false);
    const badClock = await openTranscript({ dir: path.join(dir, 'other'), meta: metaOf(), now: () => Number.NaN, log: collectingLog() });
    assert.equal(badClock.ok, false);
  });
});

describe('records: 기록 파일의 줄', () => {
  it('첫 줄은 session 이고, 덧붙인 줄은 부른 순서대로 ts 와 kind 를 앞에 두고 한 줄씩 쓴다', async () => {
    const { home: dir } = await home();
    let clock = T0;
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => clock, log: collectingLog() });
    assert.ok(opened.ok);
    const { transcript } = opened;

    // 기다리지 않고 이어서 부른다. 부른 순서대로 써야 한다.
    const results = ENTRIES.map((entry) => {
      clock += SEC;
      return transcript.append(entry);
    });
    for (const result of await Promise.all(results)) assert.deepEqual(result, { ok: true });
    await transcript.close();

    const raw = await readFile(transcript.path, 'utf8');
    assert.equal(raw.split('\n').length, ENTRIES.length + 2, '줄바꿈이 든 글도 한 줄이다');
    for (const line of raw.slice(0, -1).split('\n')) assert.match(line, /^\{"ts":"2026-11-15T08:00:\d\d\.000Z","kind":"[a-z_]+"/);

    const lines = await linesOf(transcript.path);
    assert.deepEqual(lines[0], {
      ts: '2026-11-15T08:00:00.000Z',
      kind: 'session',
      server: 'wss://agent-chat.tools.camp',
      room_id: ROOM_ID,
      name: 'alice',
      sid: SID,
      package_version: '0.1.0',
      format_version: 1,
    });
    assert.deepEqual(lines.slice(1), ENTRIES.map((entry, i) => ({ ts: `2026-11-15T08:00:0${i + 1}.000Z`, ...entry })));
    assert.deepEqual(lines.map((line) => line['kind']), ['session', 'mode', 'peer', 'state', 'chat_out', 'chat_in', 'rule', 'end']);
  });

  it('많은 줄을 한꺼번에 불러도 순서가 지켜지고 줄이 섞이지 않는다', async () => {
    const { home: dir } = await home();
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.ok(opened.ok);
    const big = '가'.repeat(5_000);
    const pending = Array.from({ length: 300 }, (_, i) => opened.transcript.append({ kind: 'chat_in', id: `bbbbbbbbbbbb-${i.toString(36)}`, from: 'bob', to: 'room', text: `${i} ${big}` }));
    const closing = opened.transcript.close();
    assert.ok((await Promise.all(pending)).every((result) => result.ok), '닫기 전에 부른 줄은 모두 쓴다');
    await closing;
    const lines = await linesOf(opened.transcript.path);
    assert.equal(lines.length, 301);
    assert.deepEqual(lines.slice(1).map((line) => Number(String(line['text']).split(' ')[0])), Array.from({ length: 300 }, (_, i) => i));
  });

  it('close 뒤의 append 는 실패 결과다. close 는 여러 번 불러도 된다', async () => {
    const { home: dir } = await home();
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.ok(opened.ok);
    await opened.transcript.append({ kind: 'end', reason: 'leave' });
    await opened.transcript.close();
    await opened.transcript.close();
    await Promise.all([opened.transcript.close(), opened.transcript.close()]);
    const late = await opened.transcript.append({ kind: 'chat_in', id: 'bbbbbbbbbbbb-1', from: 'bob', to: 'room', text: '늦은 글' });
    assert.deepEqual({ ok: late.ok, code: late.ok ? '' : late.code }, { ok: false, code: 'RECORD_FAILED' });
    assert.equal((await linesOf(opened.transcript.path)).length, 2);
  });

  it('직렬화할 수 없는 줄은 실패 결과이고 다음 줄은 쓴다', async () => {
    const { home: dir } = await home();
    const log = collectingLog();
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log });
    assert.ok(opened.ok);
    const bad = await opened.transcript.append({ kind: 'end', reason: 10n as unknown as string });
    assert.equal(bad.ok, false);
    const missing = await opened.transcript.append(null as unknown as TranscriptEntry);
    assert.equal(missing.ok, false);
    assert.deepEqual(await opened.transcript.append({ kind: 'end', reason: 'leave' }), { ok: true });
    await opened.transcript.close();
    assert.deepEqual((await linesOf(opened.transcript.path)).map((line) => line['kind']), ['session', 'end']);
  });

  it('넘겨받은 값이 ts 와 kind 를 덮지 못한다', async () => {
    const { home: dir } = await home();
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log: collectingLog() });
    assert.ok(opened.ok);
    await opened.transcript.append({ kind: 'end', reason: 'leave', ts: '1999-01-01T00:00:00.000Z' } as unknown as TranscriptEntry);
    await opened.transcript.close();
    const lines = await linesOf(opened.transcript.path);
    assert.deepEqual(lines[1], { ts: '2026-11-15T08:00:00.000Z', kind: 'end', reason: 'leave' });
  });

  it('진단 로그에 방 ID 원문과 글 본문을 남기지 않는다', async () => {
    const { home: dir } = await home();
    const log = collectingLog();
    const opened = await openTranscript({ dir, meta: metaOf(), now: () => T0, log });
    assert.ok(opened.ok);
    for (const entry of ENTRIES) await opened.transcript.append(entry);
    await opened.transcript.close();
    await openTranscript({ dir, meta: metaOf({ name: '../x' }), now: () => T0, log });

    const logged = JSON.stringify(log.events);
    assert.ok(!logged.includes(ROOM_ID), '방 ID 원문');
    assert.ok(!logged.includes('안녕하세요') && !logged.includes('보입니다'), '채팅 본문');
    assert.ok(!logged.includes(dir), '경로(방 ID 가 들어 있다)');
    assert.deepEqual(log.events.map((event) => [event.level, event.event, event.fields?.outcome]), [
      ['info', 'transcript.open', 'ok'],
      ['info', 'transcript.close', 'ok'],
      ['error', 'transcript.open', 'failed'],
    ]);
    assert.ok(log.events.every((event) => event.module === 'records'));
    assert.match(String(log.events[0]?.fields?.room_ref), /^[0-9a-f]{12}$/);
  });
});

describe('records: 쓰기 실패 (가짜 파일)', () => {
  function failingSink(failOn: ReadonlySet<number>): LineSink & { readonly written: string[]; closed: number } {
    const written: string[] = [];
    let calls = 0;
    return {
      written,
      closed: 0,
      async write(text: string) {
        calls += 1;
        // 늦게 끝나는 쓰기. 다음 줄이 앞지르면 안 된다.
        await new Promise((resolve) => setImmediate(resolve));
        if (failOn.has(calls)) throw Object.assign(new Error(`ENOSPC: no space left on device, write '/secret/${ROOM_ID}/file'`), { code: 'ENOSPC' });
        written.push(text);
      },
      async close() {
        this.closed += 1;
        if (failOn.has(-1)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    };
  }

  it('쓰기 실패는 결과로 알리고 reject 하지 않는다. 다음 줄은 다시 쓴다', async () => {
    const sink = failingSink(new Set([2, 3]));
    const log = collectingLog();
    const writer = createTranscriptWriter({ path: '/nowhere/transcript.jsonl', sink, now: () => T0, log, roomRef: 'abcdef012345' });
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((text, i) => writer.append({ kind: 'chat_in', id: `bbbbbbbbbbbb-${i}`, from: 'bob', to: 'room', text })),
    );
    assert.deepEqual(results.map((result) => result.ok), [true, false, false, true]);
    const failed = results[1];
    assert.ok(failed !== undefined && !failed.ok);
    assert.equal(failed.code, 'RECORD_FAILED');
    assert.match(failed.detail, /ENOSPC/);
    assert.ok(!failed.detail.includes(ROOM_ID), '오류 문구의 경로(방 ID)를 결과에 싣지 않는다');
    assert.deepEqual(sink.written.map((line) => (JSON.parse(line) as { text: string }).text), ['a', 'd']);

    const warnings = log.events.filter((event) => event.level === 'warn');
    assert.equal(warnings.length, 2);
    assert.deepEqual(warnings[0]?.fields, { room_ref: 'abcdef012345', kind: 'chat_in', outcome: 'failed', error_code: 'ENOSPC' });
    assert.ok(!JSON.stringify(log.events).includes(ROOM_ID));
  });

  it('닫기 실패도 삼킨다. 밀린 쓰기를 끝낸 뒤에 한 번만 닫는다', async () => {
    const sink = failingSink(new Set([-1]));
    const log = collectingLog();
    const writer = createTranscriptWriter({ path: '/nowhere/transcript.jsonl', sink, now: () => T0, log, roomRef: 'abcdef012345' });
    const pending = writer.append({ kind: 'end', reason: 'shutdown' });
    await Promise.all([writer.close(), writer.close()]);
    assert.deepEqual(await pending, { ok: true });
    assert.equal(sink.written.length, 1, '닫기 전에 부른 줄을 먼저 쓴다');
    assert.equal(sink.closed, 1);
    assert.deepEqual(log.events.map((event) => [event.level, event.event, event.fields?.error_code]), [['warn', 'transcript.close', 'EIO']]);
  });
});
