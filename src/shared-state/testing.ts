// shared-state 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다(V-U8 의 import-testing).
// 시험끼리 함께 쓰는 것만 둔다: 시드가 있는 난수, 참가자 한 명의 대역, 스냅샷 교환, 복제본의 비교용 요약.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { canonicalJson } from '../protocol/index.js';
import type { StateRecord } from '../protocol/index.js';
import type { MergeRemoteResult, Replica, StateChange, StateCommand } from './contract.js';
import { createReplica } from './replica.js';

/** 시험의 기준 시각(2026-11 무렵의 epoch ms). */
export const T0 = 1_794_700_000_000;
export const SEC = 1_000;
export const MIN = 60_000;

/** 시드가 같으면 같은 수열을 낸다(mulberry32). 0 이상 1 미만. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 무작위 시험이 쓸 시드. 고정 시드 셋에 실행마다 새로 뽑은 시드 하나를 더한다.
 * 실패를 다시 보려면 AGENT_CHAT_TEST_SEED=<시드> 로 그 시드만 돌린다.
 */
export function seedsForRun(): number[] {
  const forced = process.env['AGENT_CHAT_TEST_SEED'];
  if (forced !== undefined && forced !== '') {
    const seed = Number(forced);
    assert.ok(Number.isInteger(seed) && seed >= 0, 'AGENT_CHAT_TEST_SEED 는 0 이상의 정수여야 한다');
    return [seed];
  }
  return [1, 20261115, 3141592653, randomInt(2 ** 32)];
}

export interface Peer {
  readonly name: string;
  readonly sid: string;
  readonly replica: Replica;
}

/** 이름에서 sid 를 만든다(소문자·숫자 12자). 시험에서 기록 ID 를 읽기 쉽게 하려는 것이다. */
export function sidOf(name: string, generation = 0): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${base}${String(generation)}`.padEnd(12, '0').slice(0, 12);
}

export function makePeer(name: string, options: { generation?: number; selfNames?: readonly string[] } = {}): Peer {
  const sid = sidOf(name, options.generation ?? 0);
  return { name, sid, replica: createReplica({ self: { peer: name, sid }, selfNames: options.selfNames ?? [name] }) };
}

export interface Applied {
  readonly records: readonly StateRecord[];
  readonly record: StateRecord;
  readonly changes: readonly StateChange[];
}

/** 성공해야 하는 로컬 명령. 기록 하나를 만든 경우에 쓴다. */
export function apply(peer: Peer, command: StateCommand, now: number): Applied {
  const result = peer.replica.applyLocal(command, now);
  assert.ok(result.ok, `${peer.name} 의 ${command.type} 이 거절됐다: ${result.ok ? '' : `${result.code} ${result.detail}`}`);
  assert.equal(result.records.length, 1, `${command.type} 이 기록 하나를 만들어야 한다`);
  return { records: result.records, record: result.records[0] as StateRecord, changes: result.changes };
}

/** 거절돼야 하는 로컬 명령. 오류 코드를 돌려준다. */
export function refuse(peer: Peer, command: StateCommand, now: number): string {
  const before = peer.replica.fingerprint();
  const count = peer.replica.snapshot().length;
  const result = peer.replica.applyLocal(command, now);
  assert.equal(result.ok, false, `${peer.name} 의 ${command.type} 이 거절돼야 한다`);
  assert.equal(peer.replica.fingerprint(), before, '거절하면 지문이 그대로다');
  assert.equal(peer.replica.snapshot().length, count, '거절하면 기록 수가 그대로다');
  return result.ok ? '' : result.code;
}

/** 작성자가 자기 링크로 보내는 변경. */
export function sendChange(from: Peer, to: Peer, records: readonly StateRecord[], now: number): MergeRemoteResult {
  return to.replica.mergeRemote(records, { from: from.name, snapshot: false }, now);
}

/** 한쪽이 가진 모든 기록을 스냅샷으로 준다. */
export function sendSnapshot(from: Peer, to: Peer, now: number): MergeRemoteResult {
  return to.replica.mergeRemote(from.replica.snapshot(), { from: from.name, snapshot: true }, now);
}

/** 스냅샷 교환 한 번. 양쪽이 받기 전에 뜬 스냅샷을 서로 준다(protocol.md 5.4). */
export function exchange(a: Peer, b: Peer, now: number): { readonly toA: MergeRemoteResult; readonly toB: MergeRemoteResult } {
  const fromA = a.replica.snapshot();
  const fromB = b.replica.snapshot();
  const toB = b.replica.mergeRemote(fromA, { from: a.name, snapshot: true }, now);
  const toA = a.replica.mergeRemote(fromB, { from: b.name, snapshot: true }, now);
  return { toA, toB };
}

/**
 * 복제본을 견줄 수 있는 글로 바꾼다. 지문, 기록 전체, 파생 판정이 들어 있다.
 * 경과 시간은 뺀다. 참가자마다 따로 재는 값이라 같은 기록 집합이어도 다르다.
 */
export function signature(replica: Replica, now: number = T0): string {
  const view = replica.view(now);
  const test = view.test === null ? null : { ...view.test, elapsed_ms: 0, remaining_ms: 0 };
  return canonicalJson({
    fingerprint: replica.fingerprint(),
    records: replica.snapshot().map((record) => canonicalJson(record)).sort(),
    view: { ...view, test },
  });
}

export function changeTypes(changes: readonly StateChange[]): string[] {
  return changes.map((change) => change.type);
}

/** 테스트를 시작한다. 제한의 기본값은 60분, 시나리오 20개다. */
export function startTest(peer: Peer, now: number, limits: { minutes?: number; scenarios?: number } = {}): Applied & { readonly testId: string } {
  const applied = apply(
    peer,
    { type: 'start_test', request: '손들기 기능을 강사와 수강생 역할로 확인한다', max_duration_min: limits.minutes ?? 60, max_scenarios: limits.scenarios ?? 20 },
    now,
  );
  assert.equal(applied.record.kind, 'test');
  const testId = applied.record.kind === 'test' ? applied.record.body.test_id : '';
  return { ...applied, testId };
}

export function startScenario(peer: Peer, now: number, title = '시나리오'): Applied & { readonly scenarioId: string } {
  const applied = apply(peer, { type: 'start_scenario', title }, now);
  return { ...applied, scenarioId: applied.record.kind === 'scenario' ? applied.record.rid : '' };
}

export function recordClaim(peer: Peer, scenarioId: string, now: number, outcome: 'pass' | 'fail' = 'pass'): Applied & { readonly claimId: string } {
  const applied = apply(
    peer,
    { type: 'record_claim', scenario_id: scenarioId, action: '손들기 버튼을 눌렀다', observed: '강사 화면에 손 표시가 떴다', outcome, steps: '1. 수업에 들어간다\n2. 손들기를 누른다' },
    now,
  );
  return { ...applied, claimId: applied.record.kind === 'claim' ? applied.record.rid : '' };
}

export function recordVerification(
  peer: Peer,
  claimId: string,
  now: number,
  result: 'confirmed' | 'refuted' | 'unable' = 'confirmed',
): Applied {
  return apply(peer, { type: 'record_verification', claim_id: claimId, result, evidence: '내 화면에서 같은 표시를 봤다' }, now);
}
