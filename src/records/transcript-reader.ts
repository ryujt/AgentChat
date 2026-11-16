// 보고서가 기록 파일에서 뽑는 것 (mcp-interface.md 9절): 거절된 호출, 연결 사건, 역할 변화 이력.
// 복제본에는 마지막 역할만 있고, 거절된 호출은 이 프로세스만 안다. 그래서 기록 파일에서 읽는다.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { errorCode, openForRead } from './paths.js';
import { TRANSCRIPT_FILE_PATTERN } from './transcript.js';

export interface RuleFact {
  readonly ts: string | null;
  readonly tool: string;
  readonly code: string;
}

export interface PeerFact {
  readonly ts: string | null;
  readonly name: string;
  readonly change: string;
  readonly reason: string | null;
}

export interface RoleFact {
  readonly role: string | null;
  /** 그 presence 를 쓴 참가자의 벽시계. */
  readonly wall: number;
}

export interface TranscriptFacts {
  readonly rules: readonly RuleFact[];
  readonly peers: readonly PeerFact[];
  /** 참가자별 역할 변화. 같은 역할이 이어지면 처음 것만 둔다. */
  readonly roles: ReadonlyMap<string, readonly RoleFact[]>;
  /** 읽은 기록 파일 수. */
  readonly files: number;
  /** 읽지 못한 것이 있으면 그 사유(오류 코드). 없으면 null. */
  readonly problem: string | null;
}

const CHUNK_BYTES = 64 * 1024;
/** 이보다 긴 줄은 기록 파일의 줄이 아니다(채팅 16KB, 상태 기록 32KB). 메모리를 지키려고 건너뛴다. */
const MAX_LINE_CHARS = 1024 * 1024;

/** 줄 단위로 읽는다. 기록 파일에는 크기 상한이 없어 통째로 읽지 않는다. */
async function eachLine(file: string, handle: (line: string) => void): Promise<void> {
  const source = await openForRead(file);
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let carry = '';
    let skipping = false;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const parts = (carry + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      carry = parts.pop() ?? '';
      for (const part of parts) {
        if (skipping) skipping = false;
        else if (part !== '') handle(part);
      }
      if (carry.length > MAX_LINE_CHARS) {
        carry = '';
        skipping = true;
      }
    }
    // 끝에 줄바꿈이 없는 조각은 쓰다 만 줄이다. 넘기지 않는다.
  } finally {
    await source.close();
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface FileFacts {
  readonly rules: RuleFact[];
  readonly peers: PeerFact[];
  readonly roles: { readonly name: string; readonly fact: RoleFact }[];
  mentionsTest: boolean;
}

function readLine(line: string, testId: string, into: FileFacts): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const entry = asObject(parsed);
  if (entry === null) return;
  const ts = asText(entry['ts']);
  if (entry['kind'] === 'rule') {
    const tool = asText(entry['tool']);
    const code = asText(entry['code']);
    if (tool !== null && code !== null) into.rules.push({ ts, tool, code });
  } else if (entry['kind'] === 'peer') {
    const name = asText(entry['name']);
    const change = asText(entry['change']);
    if (name !== null && change !== null) into.peers.push({ ts, name, change, reason: asText(entry['reason']) });
  } else if (entry['kind'] === 'state') {
    const record = asObject(entry['record']);
    const body = asObject(record?.['body']);
    if (record === null || body === null) return;
    if (body['test_id'] === testId) into.mentionsTest = true;
    if (record['kind'] !== 'presence') return;
    const author = asText(record['author']);
    const wall = record['wall'];
    const role = body['role'];
    if (author !== null && typeof wall === 'number' && (role === null || typeof role === 'string')) {
      into.roles.push({ name: author, fact: { role, wall } });
    }
  }
}

/**
 * 같은 디렉터리의 기록 파일에서 보고서의 재료를 모은다. 파일 이름(시각) 순으로 읽는다.
 * 이번 입장의 파일과, 이 테스트의 기록이 들어 있는 파일만 쓴다. 같은 방 ID 로 방을 다시 만들면
 * 예전 테스트의 기록 파일이 같은 디렉터리에 남아 있는데, 그것이 이번 보고서에 섞이면 안 된다.
 * 읽지 못해도 던지지 않는다. 읽은 데까지와 사유를 돌려준다.
 */
export async function readTranscriptFacts(dir: string, sid: string, testId: string): Promise<TranscriptFacts> {
  const rules: RuleFact[] = [];
  const peers: PeerFact[] = [];
  const roles = new Map<string, RoleFact[]>();
  let files = 0;
  let problem: string | null = null;

  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => TRANSCRIPT_FILE_PATTERN.test(name)).sort();
  } catch (error) {
    return { rules, peers, roles, files, problem: errorCode(error) };
  }

  for (const name of names) {
    const facts: FileFacts = { rules: [], peers: [], roles: [], mentionsTest: false };
    try {
      await eachLine(path.join(dir, name), (line) => readLine(line, testId, facts));
    } catch (error) {
      problem ??= errorCode(error);
      continue;
    }
    const current = TRANSCRIPT_FILE_PATTERN.exec(name)?.[1] === sid;
    if (!current && !facts.mentionsTest) continue;
    files += 1;
    // 줄 수에 상한이 없어 펼쳐 넣지 않는다.
    for (const rule of facts.rules) rules.push(rule);
    for (const peer of facts.peers) peers.push(peer);
    for (const { name: peer, fact } of facts.roles) {
      const history = roles.get(peer) ?? [];
      if (history.length === 0) roles.set(peer, history);
      if (history.length === 0 || history[history.length - 1]?.role !== fact.role) history.push(fact);
    }
  }
  return { rules, peers, roles, files, problem };
}
