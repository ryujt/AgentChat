// records 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다(V-U8 의 import-testing).
// 임시 디렉터리, 사건을 모으는 로그 포트, 보고서 입력 표본을 둔다.

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LogFields, LogLevel, LogModule, LogPort } from '../diagnostics/log-port.js';
import type { RecordsMeta, ReportClaim, ReportInput, ReportScenario } from './contract.js';

/** 시험의 기준 시각. 2026-11-15T08:00:00Z 다. */
export const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);
export const SEC = 1_000;
export const MIN = 60_000;

export const ROOM_ID = 'k3x9q0ab12cdwxyz';
export const SID = 'a1b2c3d4e5f6';
export const TEST_ID = 'zzzz1111yyyy-1';

export function metaOf(overrides: Partial<RecordsMeta> = {}): RecordsMeta {
  return { server_key: 'wss://agent-chat.tools.camp', room_id: ROOM_ID, name: 'alice', sid: SID, package_version: '0.1.0', ...overrides };
}

export interface LoggedEvent {
  readonly level: LogLevel;
  readonly module: LogModule;
  readonly event: string;
  readonly fields: LogFields | undefined;
}

export function collectingLog(): LogPort & { readonly events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return {
    events,
    event(level, module, event, fields) {
      events.push({ level, module, event, fields });
    },
  };
}

/** 시험마다 새 임시 디렉터리. 위치는 TMPDIR 로 바꾼다. */
export async function makeHome(): Promise<{ readonly root: string; readonly home: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-chat-records-'));
  return { root, home: path.join(root, 'home'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function modeOf(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

/** 디렉터리 아래의 모든 경로(상대 경로, 정렬). 밖에 쓴 것이 없는지 볼 때 쓴다. */
export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      out.push(relative);
      const info = await stat(path.join(current, name)).catch(() => null);
      if (info?.isDirectory()) await walk(path.join(current, name), relative);
    }
  };
  await walk(dir, '');
  return out;
}

export function roomDirOf(home: string, meta: RecordsMeta = metaOf()): string {
  return path.join(home, 'rooms', 'wss_agent-chat.tools.camp', meta.room_id, meta.name);
}

function claim(id: string, overrides: Partial<ReportClaim>): ReportClaim {
  return {
    claim_id: `zzzz1111yyyy-${id}`,
    by: 'alice',
    wall: T0 + 5 * MIN,
    action: '손들기 버튼을 눌렀다',
    expected: '강사 화면에 손 표시',
    observed: '강사 화면에 손 표시가 떴다',
    outcome: 'pass',
    steps: '1. 수업에 들어간다\n2. 손들기를 누른다',
    classification: 'unverified',
    unverified_reason: 'no_verification',
    verifications: [],
    ...overrides,
  };
}

/** 분류 넷과 미확인 사유 다섯 가지가 모두 든 보고서 입력. 중단된 테스트다. */
export function sampleInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const scenarios: ReportScenario[] = [
    {
      scenario_id: 'zzzz1111yyyy-2',
      index: 1,
      title: '수강생이 손을 든다',
      by: 'alice',
      wall: T0 + 2 * MIN,
      over_limit: false,
      claims: [
        claim('10', {
          classification: 'passed',
          unverified_reason: null,
          verifications: [{ by: 'bob', wall: T0 + 6 * MIN, result: 'confirmed', evidence: '강사 화면 캡처에서 손 표시를 봤다', counted: true }],
        }),
        claim('11', {
          by: 'bob',
          action: '손 내리기를 눌렀다',
          observed: '손 표시가 그대로 남았다',
          outcome: 'fail',
          steps: '1. 손을 든다\n2. 손 내리기를 누른다\n3. 강사 화면을 본다',
          classification: 'failed',
          unverified_reason: null,
          verifications: [{ by: 'alice', wall: T0 + 7 * MIN, result: 'confirmed', evidence: '내 화면에서도 남아 있었다', counted: true }],
        }),
        claim('12', {
          action: '채팅을 보냈다',
          observed: '상대 화면에 떴다',
          classification: 'failed',
          unverified_reason: null,
          verifications: [
            { by: 'bob', wall: T0 + 8 * MIN, result: 'confirmed', evidence: 'bob 의 화면에는 떴다', counted: true },
            { by: 'carol', wall: T0 + 9 * MIN, result: 'refuted', evidence: 'carol 의 화면에는 뜨지 않았다', counted: true },
          ],
        }),
        claim('13', { action: '확인을 받지 못한 행동', unverified_reason: 'no_verification' }),
        claim('14', {
          action: '확인하지 못한 행동',
          unverified_reason: 'unable',
          verifications: [{ by: 'bob', wall: T0 + 9 * MIN, result: 'unable', evidence: '권한이 없어 볼 수 없었다', counted: true }],
        }),
        claim('15', { action: '검증자가 끊긴 행동', unverified_reason: 'verifier_disconnected' }),
        claim('16', {
          action: '자기 검증만 있는 행동',
          unverified_reason: null,
          verifications: [{ by: 'alice', wall: T0 + 9 * MIN, result: 'confirmed', evidence: '내가 봤다', counted: false }],
        }),
      ],
    },
    {
      scenario_id: 'zzzz1111yyyy-3',
      index: 2,
      title: '강사가 손을 내린다',
      by: 'bob',
      wall: T0 + 10 * MIN,
      over_limit: false,
      claims: [
        claim('20', {
          by: 'bob',
          wall: T0 + 21 * MIN,
          action: '중단 뒤에 적은 행동',
          classification: 'late',
          unverified_reason: null,
          verifications: [{ by: 'alice', wall: T0 + 22 * MIN, result: 'confirmed', evidence: '확인은 했다', counted: true }],
        }),
      ],
    },
    {
      scenario_id: 'zzzz1111yyyy-4',
      index: 3,
      title: '동시에 시작해 밀려난 시나리오',
      by: 'carol',
      wall: T0 + 10 * MIN,
      over_limit: true,
      claims: [claim('30', { by: 'carol', action: '밀려나기 전에 적은 행동', unverified_reason: 'over_limit' })],
    },
  ];
  return {
    fingerprint: '8bf49d06f0a5',
    test: {
      test_id: TEST_ID,
      request: '손들기 기능을 강사와 수강생 역할로 확인한다',
      requested_by: 'alice',
      started_wall: T0 + MIN,
      max_duration_min: 60,
      max_scenarios: 2,
      scenarios_used: 2,
      stop: { by: 'bob', wall: T0 + 20 * MIN, reason: 'user', detail: '사용자가 멈추라고 했다' },
    },
    participants: [
      { name: 'alice', client: 'claude-code', tools: ['browser', 'shell'], role: '수강생', status: 'ready', shown_as: null },
      { name: 'bob', client: 'codex', tools: ['browser'], role: '강사', status: 'working', shown_as: 'working' },
      { name: 'carol', client: null, tools: null, role: null, status: null, shown_as: 'disconnected' },
    ],
    scenarios,
    ...overrides,
  };
}
