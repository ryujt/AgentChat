// 공유 상태 복제본 (architecture.md 3.7, protocol.md 5절).
// 전송·파일·시계에 닿지 않는다. 시각은 호출마다 인자로 받는다.

import {
  LIMITS,
  STATE_CLOCK_MAX,
  TEST_KEY,
  canonicalJson,
  compareCanonical,
  isKeyRecord,
  makeEntryId,
  parseStateRecord,
  presenceKey,
  stateFingerprint,
  utf8ByteLength,
} from '../protocol/index.js';
import type { AppendRecord, KeyRecord, PresenceRecord, StateRecord } from '../protocol/index.js';
import { diffChanges, type ChangeMemory, type PresenceDelta } from './changes.js';
import type {
  ApplyLocalResult,
  CommandErrorCode,
  MergeOrigin,
  MergeRemoteResult,
  PresenceBody,
  PresenceView,
  Replica,
  ReplicaDeps,
  ReplicaView,
  StateCommand,
} from './contract.js';
import { claimView, compareText, derive, scenarioView, testView, type Derived } from './derive.js';

interface Held<R extends StateRecord> {
  readonly record: R;
  /** 정규 직렬화. 같은 식별자의 기록이 다시 왔을 때 내용을 견주는 데 쓴다. */
  readonly canon: string;
  readonly bytes: number;
}

type Rejection = { readonly ok: false; readonly code: CommandErrorCode; readonly detail: string };
/** 규칙을 통과한 명령이 쓸 기록의 재료. null 이면 쓸 것이 없다(이미 중단된 테스트의 stop_test). */
type Draft = { readonly ok: true; readonly draft: ((id: string) => Record<string, unknown>) | null };

/** 상한과 무관하게 쓸 수 있는 종류. 꽉 찼다고 중단 요청이나 입장이 막히면 안 된다(protocol.md 5.1). */
const UNCAPPED_KINDS: ReadonlySet<string> = new Set(['presence', 'test', 'stop']);

/** 자기 presence 가 아직 없을 때 빠진 필드를 채우는 값(contract.ts 의 PresencePatch). */
function defaultPresence(): PresenceBody {
  return { client: 'unknown', tools: [], role: null, status: 'joined', listening: false, note: null };
}

function reject(code: CommandErrorCode, detail: string): Rejection {
  return { ok: false, code, detail };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

function hold<R extends StateRecord>(record: R): Held<R> {
  const canon = canonicalJson(record);
  return { record: deepFreeze(record), canon, bytes: utf8ByteLength(canon) };
}

/** 스냅샷의 순서. 여러 프레임으로 나뉘어도 받는 쪽이 쓰인 순서에 가깝게 받는다. 병합 결과는 순서와 무관하다. */
function compareForSnapshot(a: StateRecord, b: StateRecord): number {
  return (
    a.lc - b.lc ||
    compareText(a.author, b.author) ||
    compareText(isKeyRecord(a) ? a.key : a.rid, isKeyRecord(b) ? b.key : b.rid)
  );
}

export function createReplica(deps: ReplicaDeps): Replica {
  const self = deps.self;
  // 지금 이름도 넣는다. 나갔다가 다른 이름으로 들어와 자기 주장을 검증하는 것을 막는다.
  const selfNames: ReadonlySet<string> = new Set([...deps.selfNames, self.peer]);
  const selfKey = presenceKey(self.peer);

  const keyed = new Map<string, Held<KeyRecord>>();
  const appended = new Map<string, Held<AppendRecord>>();
  let totalBytes = 0;
  /** 지금까지 본 가장 큰 lc. 아직 본 것이 없으면 -1 이다. */
  let maxLc = -1;
  /** 다음 기록 ID 의 순번. */
  let seq = 1;

  /** 현재 테스트의 경과 시간 = base + (now − ref). 두 값은 함께만 바꾼다(protocol.md 5.5). */
  let elapsed: { readonly testId: string; readonly base: number; readonly ref: number } | null = null;
  const memory: ChangeMemory = { stoppedTestId: null, overAnnounced: new Set() };

  let derivedCache: Derived | null = null;
  let snapshotCache: readonly StateRecord[] | null = null;
  let fingerprintCache: string | null = null;

  const invalidate = (): void => {
    derivedCache = null;
    snapshotCache = null;
    fingerprintCache = null;
  };

  const count = (): number => keyed.size + appended.size;

  const keyRecords = (): Map<string, KeyRecord> => {
    const out = new Map<string, KeyRecord>();
    for (const [key, held] of keyed) out.set(key, held.record);
    return out;
  };

  function* appendRecords(): Generator<AppendRecord> {
    for (const held of appended.values()) yield held.record;
  }

  const derived = (): Derived => {
    derivedCache ??= derive(keyRecords(), appendRecords());
    return derivedCache;
  };

  const elapsedAt = (now: number): number | null => {
    if (elapsed === null) return null;
    // 벽시계가 뒤로 가면 음수가 될 수 있다. 0 으로 센다.
    return Math.max(0, elapsed.base + (now - elapsed.ref));
  };

  /**
   * 기록 하나를 병합 규칙(protocol.md 5.3)으로 넣는다. 결과가 도착 순서에 기대지 않아야 한다.
   * changed 는 복제본이 바뀌었는가, anomaly 는 식별자가 같은데 내용이 다른 기록이었는가.
   */
  const put = (record: StateRecord, presences: Map<string, PresenceDelta>): { changed: boolean; anomaly: boolean } => {
    const incoming = hold(record);
    if (record.lc > maxLc) maxLc = record.lc;

    let current: Held<StateRecord> | undefined;
    let wins: boolean;
    let anomaly = false;
    if (isKeyRecord(record)) {
      current = keyed.get(record.key);
      if (current === undefined) {
        wins = true;
      } else {
        const order = record.lc - current.record.lc || compareText(record.author, current.record.author);
        if (order !== 0) {
          wins = order > 0;
        } else if (incoming.canon === current.canon) {
          wins = false;
        } else {
          // (lc, author) 까지 같은데 내용이 다르다. 먼저 온 쪽을 남기면 참가자마다 달라지므로 바이트가 작은 쪽을 남긴다.
          anomaly = true;
          wins = compareCanonical(record, current.record) < 0;
        }
      }
    } else {
      current = appended.get(record.rid);
      if (current === undefined) {
        wins = true;
      } else if (incoming.canon === current.canon) {
        wins = false;
      } else {
        anomaly = true;
        wins = compareCanonical(record, current.record) < 0;
      }
    }
    if (!wins) return { changed: false, anomaly };

    totalBytes += incoming.bytes - (current?.bytes ?? 0);
    if (isKeyRecord(record)) {
      keyed.set(record.key, incoming as Held<KeyRecord>);
      if (record.kind === 'presence') {
        // 한 묶음에서 같은 이름이 여러 번 바뀌어도 변화는 묶음 전의 값에서 마지막 값으로 한 번이다.
        const first = presences.get(record.author);
        const previous =
          first !== undefined ? first.previous : current?.record.kind === 'presence' ? current.record.body : null;
        presences.set(record.author, { previous, current: incoming.record as PresenceRecord });
      }
    } else {
      appended.set(record.rid, incoming as Held<AppendRecord>);
    }
    invalidate();
    return { changed: true, anomaly };
  };

  /** 넣은 뒤의 마무리: 현재 테스트가 바뀌었으면 경과 시간을 0 에서 다시 세고, 변화를 계산한다. */
  const settle = (before: Derived, presences: Map<string, PresenceDelta>, now: number) => {
    const after = derived();
    if (after.test !== null && after.test.body.test_id !== before.test?.body.test_id) {
      // 내가 시작했든, 변경이나 스냅샷으로 받았든, 진 쪽에서 넘어왔든 같다.
      elapsed = { testId: after.test.body.test_id, base: 0, ref: now };
    }
    return diffChanges(before, after, presences.values(), elapsedAt(now) ?? 0, memory);
  };

  /** 규칙을 본다. 통과하면 기록의 재료를 돌려준다. 아무 것도 바꾸지 않는다. */
  const check = (command: StateCommand, state: Derived, now: number): Rejection | Draft => {
    const test = state.test;
    switch (command.type) {
      case 'set_presence': {
        const base = keyed.get(selfKey)?.record;
        const body: Record<string, unknown> = { ...(base?.kind === 'presence' ? base.body : defaultPresence()) };
        for (const [field, value] of Object.entries(command.patch)) {
          if (value !== undefined) body[field] = Array.isArray(value) ? [...value] : value;
        }
        return { ok: true, draft: () => ({ kind: 'presence', key: selfKey, body }) };
      }
      case 'start_test': {
        if (test !== null) {
          // 방 하나에 테스트는 한 번이다. 다시 시작할 수 있으면 제한을 스스로 풀 수 있다.
          return state.stop !== null
            ? reject('TEST_ENDED', 'the test in this room has already been stopped; start a new test in a new room')
            : reject('TEST_ALREADY_ACTIVE', 'a test is already in progress in this room');
        }
        return {
          ok: true,
          draft: (id) => ({
            kind: 'test',
            key: TEST_KEY,
            body: {
              test_id: id,
              request: command.request,
              started_wall: Number.isFinite(now) ? Math.floor(now) : now,
              max_duration_min: command.max_duration_min,
              max_scenarios: command.max_scenarios,
            },
          }),
        };
      }
      case 'stop_test': {
        if (test === null) return reject('NO_ACTIVE_TEST', 'there is no test in this room');
        // 이미 중단됐으면 쓰지 않는다. stop 은 참가자마다 많아야 하나다.
        if (state.stop !== null) return { ok: true, draft: null };
        return {
          ok: true,
          draft: (id) => ({
            kind: 'stop',
            rid: id,
            body: { test_id: test.body.test_id, reason: command.reason, detail: command.detail },
          }),
        };
      }
      case 'start_scenario': {
        if (test === null) return reject('NO_ACTIVE_TEST', 'there is no test in this room');
        if (state.stop !== null) return reject('TEST_STOPPED', 'the test has been stopped');
        if ((elapsedAt(now) ?? 0) >= test.body.max_duration_min * 60_000) {
          return reject('TIME_LIMIT_REACHED', 'the time limit of the test has been reached');
        }
        if (state.validScenarios >= test.body.max_scenarios) {
          return reject('SCENARIO_LIMIT_REACHED', 'the scenario limit of the test has been reached');
        }
        return {
          ok: true,
          draft: (id) => ({
            kind: 'scenario',
            rid: id,
            body: {
              test_id: test.body.test_id,
              title: command.title,
              plan: command.plan ?? null,
              ...(command.actor === undefined ? {} : { actor: command.actor }),
              ...(command.verifier === undefined ? {} : { verifier: command.verifier }),
            },
          }),
        };
      }
      case 'record_claim': {
        if (test === null) return reject('NO_ACTIVE_TEST', 'there is no test in this room');
        const scenario = state.scenarioById.get(command.scenario_id);
        if (scenario === undefined) return reject('UNKNOWN_SCENARIO', 'the current test has no such scenario');
        if (scenario.overLimit) return reject('SCENARIO_OVER_LIMIT', 'the scenario is over the scenario limit');
        // 중단 뒤에도 받는다. 중단 전에 한 행동을 마저 적을 수 있어야 한다. 분류는 파생 판정이 한다.
        return {
          ok: true,
          draft: (id) => ({
            kind: 'claim',
            rid: id,
            body: {
              test_id: test.body.test_id,
              scenario: command.scenario_id,
              action: command.action,
              expected: command.expected ?? null,
              observed: command.observed,
              outcome: command.outcome,
              steps: command.steps,
            },
          }),
        };
      }
      case 'record_verification': {
        const claim = state.claimById.get(command.claim_id);
        if (test === null || claim === undefined) return reject('UNKNOWN_CLAIM', 'the current test has no such claim');
        if (selfNames.has(claim.record.author)) {
          return reject('SELF_VERIFY_FORBIDDEN', 'a claim cannot be verified by the participant who made it');
        }
        return {
          ok: true,
          draft: (id) => ({
            kind: 'verification',
            rid: id,
            body: { test_id: test.body.test_id, claim: command.claim_id, result: command.result, evidence: command.evidence },
          }),
        };
      }
    }
  };

  const applyLocal = (command: StateCommand, now: number): ApplyLocalResult => {
    const before = derived();
    const checked = check(command, before, now);
    if (!checked.ok) return checked;
    if (checked.draft === null) return { ok: true, records: [], changes: [] };

    if (maxLc >= STATE_CLOCK_MAX) {
      // 본 값 + 1 을 만들 수 없다. 접거나 낮춰 쓰면 "본 뒤에 쓴 기록은 더 크다"가 조용히 깨진다(protocol.md 5.2).
      return reject(
        'INVALID_ARGUMENT',
        'lc: the logical clock of this room has reached its end; no record can be written here any more',
      );
    }
    const wall = Number.isFinite(now) ? Math.floor(now) : now;
    const lc = Math.max(maxLc + 1, wall);

    // 받은 기록이 같은 sid 의 ID 를 이미 쓰고 있으면(결함이나 위조) 건너뛴다. 덮어쓰지 않는다.
    let nextSeq = seq;
    let id = makeEntryId(self.sid, nextSeq);
    while (id.ok && appended.has(id.value)) {
      nextSeq += 1;
      id = makeEntryId(self.sid, nextSeq);
    }
    if (!id.ok) return reject('INVALID_ARGUMENT', `id: ${id.detail}`);

    // 받는 쪽과 같은 검증을 통과한 값만 넣는다. 그래야 스냅샷이 packStateFrames 에 걸리지 않는다.
    const parsed = parseStateRecord({ ...checked.draft(id.value), author: self.peer, lc, wall });
    if (!parsed.ok) return reject('INVALID_ARGUMENT', parsed.detail);
    const record = parsed.value;

    if (!UNCAPPED_KINDS.has(record.kind)) {
      // 상한은 로컬 쓰기에만 건다. 병합에 걸면 참가자마다 다른 기록을 버려 복제본이 갈린다.
      if (count() + 1 > LIMITS.STATE_MAX_RECORDS) {
        return reject('STATE_FULL', `the shared state holds ${count()} records; the limit is ${LIMITS.STATE_MAX_RECORDS}`);
      }
      const bytes = utf8ByteLength(canonicalJson(record));
      if (totalBytes + bytes > LIMITS.STATE_MAX_BYTES) {
        return reject('STATE_FULL', `the shared state would exceed ${LIMITS.STATE_MAX_BYTES} bytes`);
      }
    }

    const presences = new Map<string, PresenceDelta>();
    put(record, presences);
    // presence 는 키로 식별하므로 순번을 쓰지 않는다.
    if (record.kind !== 'presence') seq = nextSeq + 1;
    const changes = settle(before, presences, now);
    const stored = isKeyRecord(record) ? keyed.get(record.key)?.record : appended.get(record.rid)?.record;
    return { ok: true, records: [stored ?? record], changes };
  };

  const mergeRemote = (records: readonly StateRecord[], origin: MergeOrigin, now: number): MergeRemoteResult => {
    let ignored = 0;
    let anomalies = 0;

    const accepted: StateRecord[] = [];
    const fresh = new Set<string>();
    for (const raw of records) {
      // 부르는 쪽이 이미 본 값이지만 다시 본다. 걸리는 기록이 하나라도 들어오면 스냅샷 전체를 보낼 수 없게 된다.
      const parsed = parseStateRecord(raw);
      if (!parsed.ok) {
        ignored += 1;
        anomalies += 1;
        continue;
      }
      const record = parsed.value;
      if (!origin.snapshot && record.author !== origin.from) {
        // 변경은 작성자가 자기 링크로만 보낸다. 남의 기록은 스냅샷으로만 온다.
        ignored += 1;
        anomalies += 1;
        continue;
      }
      accepted.push(record);
      if (isKeyRecord(record)) {
        if (!keyed.has(record.key)) fresh.add(`k ${record.key}`);
      } else if (!appended.has(record.rid)) {
        fresh.add(`r ${record.rid}`);
      }
    }

    if (count() + fresh.size > LIMITS.STATE_MERGE_MAX_RECORDS) {
      // 규칙을 따르는 참가자끼리는 닿지 않는 수다. 묶음을 통째로 넣지 않는다.
      return { applied: [], ignored: records.length, anomalies: anomalies + 1, changes: [], overflow: true };
    }

    const before = derived();
    const presences = new Map<string, PresenceDelta>();
    const applied: StateRecord[] = [];
    for (const record of accepted) {
      const outcome = put(record, presences);
      if (outcome.anomaly) anomalies += 1;
      if (outcome.changed) {
        const stored = isKeyRecord(record) ? keyed.get(record.key)?.record : appended.get(record.rid)?.record;
        applied.push(stored ?? record);
      } else {
        ignored += 1;
      }
    }
    const changes = applied.length > 0 ? settle(before, presences, now) : [];
    return { applied, ignored, anomalies, changes, overflow: false };
  };

  const snapshot = (): readonly StateRecord[] => {
    if (snapshotCache === null) {
      const all: StateRecord[] = [];
      for (const held of keyed.values()) all.push(held.record);
      for (const held of appended.values()) all.push(held.record);
      snapshotCache = Object.freeze(all.sort(compareForSnapshot));
    }
    return snapshotCache;
  };

  const view = (now: number): ReplicaView => {
    const state = derived();
    const presences: PresenceView[] = [];
    for (const held of keyed.values()) {
      const record = held.record;
      if (record.kind === 'presence') presences.push({ ...record.body, peer: record.author, lc: record.lc, wall: record.wall });
    }
    presences.sort((a, b) => compareText(a.peer, b.peer));
    return {
      presences,
      test: state.test === null ? null : testView({ ...state, test: state.test }, elapsedAt(now) ?? 0),
      scenarios: state.scenarios.map(scenarioView),
      claims: state.claims.map(claimView),
    };
  };

  const fingerprint = (): string => {
    fingerprintCache ??= stateFingerprint(snapshot());
    return fingerprintCache;
  };

  const adoptElapsed = (testId: string, ms: number, now: number): boolean => {
    if (elapsed === null || elapsed.testId !== testId) return false;
    if (!Number.isFinite(ms)) return false;
    const mine = elapsedAt(now);
    // 클 때만 따른다. 기준 시각을 그대로 두고 흐른 시간만 바꾸면 (지금 − 기준 시각)이 한 번 더 더해진다.
    if (mine === null || !(ms > mine)) return false;
    elapsed = { testId, base: ms, ref: now };
    return true;
  };

  return { applyLocal, mergeRemote, snapshot, view, fingerprint, testElapsed: elapsedAt, adoptElapsed };
}
