// V-U8 정적 검사 (verification-plan.md 3.1, architecture.md 2절).
// 모든 소스의 import 와 금지 문자열을 읽어 모듈 경계를 어긴 곳을 찾는다.
// 아직 없는 모듈 폴더는 그냥 지나간다. 구현이 들어오면 그때부터 검사한다.
// 검사기 자체는 아래 "검사기 자체 시험"이 가짜 위반으로 확인한다.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { IceServer as NativeIceServer } from 'node-datachannel';
import type { FileLoggerOptions, Logger } from './diagnostics/contract.js';
import type { LogPort, ServerLogFields, ServerLogPort } from './diagnostics/log-port.js';
import type { Inbox, VerificationEvent } from './inbox/contract.js';
import type { McpConfig, ToolContracts, ToolErrorCode } from './mcp-server/contract.js';
import type { AttemptFailed, Mesh, PingInfo, SendSignal } from './mesh/contract.js';
import { CLIENT_ACTIONS, P2P_FRAME_TYPES, SIGNAL_KINDS, packStateFrames, parseClientMessage } from './protocol/index.js';
import type { IceServer, ServerSignalMessage, StateRecord } from './protocol/index.js';
import type { RecordsMeta, ReportClaim, ReportSummary, TranscriptEntry } from './records/contract.js';
import type {
  CommandOutputs,
  FailedPeer,
  ReportWritten,
  RoomLeft,
  RoomSession,
  RoomSessionDeps,
  SessionCommand,
  SessionErrorCode,
  SessionInbox,
} from './room-session/contract.js';
import type {
  ApplyLocalResult,
  ClaimClass,
  ClaimStatus,
  CommandErrorCode,
  PresencePatch,
  Replica,
  StateCommand,
} from './shared-state/contract.js';
import type { SignalingClient, SignalingClientDeps, SignalingClientEvents } from './signaling-client/contract.js';
import type { ConnBinding, ConnectionSink, RoomStore, SignalingCoreDeps } from './signaling-core/contract.js';

// ── 계약끼리 맞물리는지 (컴파일로 확인) ──────────────────────────────────────
// 형제 모듈은 서로의 타입을 쓰지 않는다. 그래서 room-session 과 조립이 잇는 자리의 타입이
// 실제로 이어지는지를 여기서 본다. 맞지 않으면 `npm run build` 가 실패한다.

type Expect<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Payload<F> = F extends (payload: infer P) => void ? P : never;
type Passthrough = 'start_test' | 'start_scenario' | 'record_claim' | 'record_verification';

export type ContractWiring = [
  // signaling-client 의 signal 이벤트 → mesh.handleSignal
  Expect<Assignable<Payload<SignalingClientEvents['signal']>, Parameters<Mesh['handleSignal']>[0]>>,
  // signaling-client 의 relay-error 이벤트 → mesh.handleRelayError
  Expect<Assignable<Payload<SignalingClientEvents['relay-error']>, Parameters<Mesh['handleRelayError']>[0]>>,
  // signaling-client.sendSignal → mesh 가 주입받는 전송 함수
  Expect<Assignable<SignalingClient['sendSignal'], SendSignal>>,
  // 복제본의 기록 수와 지문 → mesh 의 pingInfo
  Expect<Assignable<{ sc: ReturnType<Replica['snapshot']>['length']; sf: ReturnType<Replica['fingerprint']> }, PingInfo>>,
  // mesh 의 실패 진단 → join 실패 details 의 칸
  Expect<Assignable<AttemptFailed['diag']['local'], NonNullable<FailedPeer['candidates']>['local']>>,
  Expect<Assignable<AttemptFailed['stage'], FailedPeer['stage']>>,
  Expect<Assignable<AttemptFailed['reason'], FailedPeer['reason']>>,
  // tool 이 그대로 넘기는 네 명령 → shared-state 의 명령
  Expect<Assignable<Extract<SessionCommand, { type: Passthrough }>, StateCommand>>,
  // set_status 의 입력 → presence 고치기
  Expect<Assignable<Omit<Extract<SessionCommand, { type: 'set_status' }>, 'type'>, PresencePatch>>,
  // shared-state 의 규칙 오류 → room-session 의 결과 코드 → tool 오류 코드
  Expect<Assignable<CommandErrorCode, SessionErrorCode>>,
  Expect<Assignable<SessionErrorCode, ToolErrorCode>>,
  // 예상 못 한 예외의 코드는 mcp-server 만 더한다. room-session 의 결과 코드에는 없다
  Expect<Assignable<'INTERNAL_ERROR', ToolErrorCode>>,
  Expect<Not<Assignable<'INTERNAL_ERROR', SessionErrorCode>>>,
  // room-session 이 넘기는 접속 순번 공급 함수 → signaling-client 가 받는 자리
  Expect<Assignable<() => number, NonNullable<SignalingClientDeps['nextSeq']>>>,
  // ping 의 갱신 조건에는 "아직 오래되지 않음"의 기준 시각이 든다
  Expect<Assignable<{ readonly connId: string; readonly seenSince: number }, Parameters<RoomStore['touchPeer']>[2]>>,
  Expect<Not<Assignable<{ readonly connId: string }, Parameters<RoomStore['touchPeer']>[2]>>>,
  // 복제본에 반영한 기록 → 기록 파일의 state 줄
  Expect<Assignable<Extract<ApplyLocalResult, { ok: true }>['records'][number], Extract<TranscriptEntry, { kind: 'state' }>['record']>>,
  Expect<Assignable<StateRecord, Extract<TranscriptEntry, { kind: 'state' }>['record']>>,
  // shared-state 의 분류와 상태 → 보고서 입력, 수신함 사건
  Expect<Assignable<ClaimClass, ReportClaim['classification']>>,
  Expect<Assignable<ClaimStatus, VerificationEvent['data']['claim_status']>>,
  Expect<Assignable<ClaimStatus, CommandOutputs['record_verification']['claim_status']>>,
  // records 의 보고서 결과 → write_report 결과
  Expect<Assignable<ReportSummary, ReportWritten['summary']>>,
  Expect<Assignable<ReportWritten, ToolContracts['write_report']['output']>>,
  // inbox → room-session 이 쓰는 부분
  Expect<Assignable<Inbox, SessionInbox>>,
  // loadConfig 의 결과 → room-session 의 설정
  Expect<Assignable<McpConfig['session'], RoomSessionDeps['config']>>,
  // room-session 이 기록 파일에 주는 값은 문자열과 버전뿐이다
  Expect<Assignable<{ server_key: string; room_id: string; name: string; sid: string; package_version: string }, RecordsMeta>>,
  // 조립이 넘기는 세션과 저장소 포트
  Expect<Assignable<RoomSession, { shutdown(budgetMs: number): Promise<void> }>>,
  Expect<Assignable<SignalingCoreDeps['store'], RoomStore>>,
  Expect<Assignable<SignalingCoreDeps['sink'], ConnectionSink>>,
  // 검증을 통과한 ICE 서버 → 라이브러리가 받는 객체 형태(url 문자열로 넘기지 않는다)
  Expect<Assignable<Pick<IceServer, 'hostname' | 'port'>, NativeIceServer>>,
  // 연결 등록의 sid → 서버가 signal 에 붙이는 sid
  Expect<Assignable<ConnBinding['sid'], ServerSignalMessage['sid']>>,
  // wait_for_messages 의 cursor → 수신함에 알리는 tool 호출
  Expect<Assignable<{ name: 'wait_for_messages'; cursor: ToolContracts['wait_for_messages']['input']['cursor'] }, Parameters<Inbox['noteToolCall']>[0]>>,
  // 조립이 만든 로거 → 모듈이 주입받는 포트. 서버 쪽 포트에도 그대로 넘긴다
  Expect<Assignable<Logger, LogPort>>,
  Expect<Assignable<LogPort, ServerLogPort>>,
  Expect<Assignable<LogPort, SignalingCoreDeps['log']>>,
  // 서버 로그 필드는 참가자 이름 원문을 받지 않는다
  Expect<Not<Assignable<{ readonly peer: string }, ServerLogFields>>>,
  Expect<Assignable<{ readonly peer_ref: string; readonly room_ref: string }, ServerLogFields>>,
  // loadConfig 의 로그 수준 → 로거 생성 옵션
  Expect<Assignable<McpConfig['logLevel'], FileLoggerOptions['level']>>,
  // 방을 나갈 때 수신함을 비운 수 → leave 결과 → leave_room 결과
  Expect<Assignable<ReturnType<SessionInbox['discardAll']>, RoomLeft['undelivered_events']>>,
  Expect<Assignable<RoomLeft, ToolContracts['leave_room']['output']>>,
  // 실패한 시도의 피어 이름 → 입장 기한에 그 시도를 끝내는 호출
  Expect<Assignable<AttemptFailed['peer'], Parameters<Mesh['expireAttempt']>[0]>>,
  // 복제본이 만든 기록과 스냅샷 → state 프레임으로 나눠 담는 함수
  Expect<Assignable<Extract<ApplyLocalResult, { ok: true }>['records'], Parameters<typeof packStateFrames>[0]>>,
  Expect<Assignable<ReturnType<Replica['snapshot']>, Parameters<typeof packStateFrames>[0]>>,
];

// ── 소스 읽기 ───────────────────────────────────────────────────────────────

export interface Scanned {
  /** 주석을 공백으로 바꾼 소스. 문자열은 그대로다. 길이와 줄바꿈은 원본과 같다. */
  readonly code: string;
  /** 주석과, 문자열·템플릿·정규식의 내용을 공백으로 바꾼 소스. */
  readonly bare: string;
  /** 끝까지 읽지 못한 곳. 있으면 검사 결과를 믿을 수 없다. */
  readonly problems: readonly { readonly index: number; readonly message: string }[];
}

const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/** 주석, 문자열, 템플릿, 정규식을 가려 읽는다. 문법 전체를 해석하지 않는다. */
export function scanSource(source: string): Scanned {
  const code = source.split('');
  const bare = source.split('');
  const problems: { index: number; message: string }[] = [];
  const blank = (target: string[], from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (target[k] !== '\n' && target[k] !== '\r') target[k] = ' ';
  };
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

  /** 템플릿의 `${` 안에 들어갈 때마다 바깥의 중괄호 깊이를 쌓는다. */
  const templateDepths: number[] = [];
  let depth = 0;
  let lastWord = '';
  /** 직전의 뜻 있는 글자. 'v' 는 값(이름, 수, 문자열)이 끝났다는 표시다. */
  let lastSig = '';
  const n = source.length;
  let i = 0;
  if (source.startsWith('#!')) {
    // 실행 파일 머리줄은 주석처럼 지운다.
    while (i < n && source[i] !== '\n') i += 1;
    blank(code, 0, i);
    blank(bare, 0, i);
  }

  const readTemplate = (start: number): number => {
    // start 는 여는 ` 의 다음 또는 `}` 의 다음이다. `${` 를 만나면 코드로 돌아간다.
    let k = start;
    while (k < n) {
      const ch = source[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '`') {
        blank(bare, start, k);
        lastSig = 'v';
        lastWord = '';
        return k + 1;
      }
      if (ch === '$' && source[k + 1] === '{') {
        blank(bare, start, k);
        templateDepths.push(depth);
        depth = 0;
        lastSig = '(';
        lastWord = '';
        return k + 2;
      }
      k += 1;
    }
    problems.push({ index: start, message: '템플릿 문자열이 닫히지 않았다' });
    blank(bare, start, n);
    return n;
  };

  while (i < n) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      let k = i;
      while (k < n && source[k] !== '\n') k += 1;
      blank(code, i, k);
      blank(bare, i, k);
      i = k;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      if (end < 0) problems.push({ index: i, message: '블록 주석이 닫히지 않았다' });
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let k = i + 1;
      let closed = false;
      while (k < n) {
        const c = source[k];
        if (c === '\\') {
          k += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === ch) {
          closed = true;
          break;
        }
        k += 1;
      }
      if (!closed) problems.push({ index: i, message: '문자열이 줄 안에서 닫히지 않았다' });
      blank(bare, i + 1, Math.min(k, n));
      i = closed ? k + 1 : k;
      lastSig = 'v';
      lastWord = '';
      continue;
    }
    if (ch === '`') {
      i = readTemplate(i + 1);
      continue;
    }
    if (ch === '{') {
      depth += 1;
      lastSig = '{';
      lastWord = '';
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0 && templateDepths.length > 0) {
        depth = templateDepths.pop() as number;
        i = readTemplate(i + 1);
        continue;
      }
      depth = Math.max(0, depth - 1);
      lastSig = '}';
      lastWord = '';
      i += 1;
      continue;
    }
    if (ch === '/') {
      const afterValue = lastSig === 'v' || lastSig === ')' || lastSig === ']' || lastSig === '}';
      const regexAllowed = lastWord !== '' ? REGEX_AFTER_WORD.has(lastWord) : !afterValue;
      if (regexAllowed) {
        let k = i + 1;
        let inClass = false;
        let closed = false;
        while (k < n) {
          const c = source[k];
          if (c === '\\') {
            k += 2;
            continue;
          }
          if (c === '\n') break;
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            closed = true;
            break;
          }
          k += 1;
        }
        if (closed) {
          blank(bare, i + 1, k);
          k += 1;
          while (k < n && /[a-z]/.test(source[k] as string)) k += 1;
          i = k;
          lastSig = 'v';
          lastWord = '';
          continue;
        }
      }
      lastSig = '/';
      lastWord = '';
      i += 1;
      continue;
    }
    if (isWord(ch)) {
      let k = i;
      while (k < n && isWord(source[k])) k += 1;
      lastWord = source.slice(i, k);
      lastSig = 'v';
      i = k;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastSig = ch;
      lastWord = '';
    }
    i += 1;
  }
  if (templateDepths.length > 0) problems.push({ index: n, message: '템플릿의 ${ 가 닫히지 않았다' });
  return { code: code.join(''), bare: bare.join(''), problems };
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k += 1) if (text[k] === '\n') line += 1;
  return line;
}

export interface ImportRef {
  readonly specifier: string;
  readonly index: number;
}

/**
 * import, export … from, import(), require() 가 가리키는 곳.
 * 자리는 문자열 내용을 지운 소스에서 찾고 이름은 원본에서 읽는다. 문자열 안에 적힌 import 문을 세지 않으려는 것이다.
 * 문자열이 아닌 동적 import 는 specifier 가 빈 문자열이다.
 */
export function findImports(scanned: Scanned): ImportRef[] {
  const { code, bare } = scanned;
  const found = new Map<number, string>();
  /** pattern 의 1번은 따옴표, 2번은 지워진 내용(공백)이다. */
  const take = (pattern: RegExp): void => {
    for (const match of bare.matchAll(pattern)) {
      const quote = match[1] ?? '';
      const content = match[2] ?? '';
      const at = (match.index ?? 0) + match[0].lastIndexOf(`${quote}${content}${quote}`) + 1;
      found.set(at, code.slice(at, at + content.length));
    }
  };
  take(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])( *)\1/g);
  take(/\bimport\s*(['"])( *)\1/g);
  take(/\brequire\s*\(\s*(['"`])( *)\1\s*\)/g);
  for (const match of bare.matchAll(/\bimport\s*\(/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const literal = /^\s*(['"`])( *)\1\s*[,)]/.exec(bare.slice(start, start + 400));
    if (literal === null) {
      found.set(match.index ?? 0, '');
    } else {
      const at = start + literal[0].indexOf(literal[1] ?? '') + 1;
      found.set(at, code.slice(at, at + (literal[2] ?? '').length));
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([index, specifier]) => ({ specifier, index }));
}

// ── 규칙 표 ─────────────────────────────────────────────────────────────────

const MODULES = [
  'protocol',
  'diagnostics',
  'signaling-core',
  'signaling-selfhost',
  'signaling-aws',
  'signaling-client',
  'mesh',
  'shared-state',
  'inbox',
  'records',
  'room-session',
  'mcp-server',
  'setup',
  'monitor',
  'entry',
] as const;
type ModuleName = (typeof MODULES)[number];

type Allowed = Partial<Record<ModuleName, readonly string[]>>;

const PROTOCOL: Allowed = { protocol: ['index.ts'] };
/** 모든 모듈은 protocol 과 로그 포트(타입)에 의존할 수 있다. */
const BASE: Allowed = { ...PROTOCOL, diagnostics: ['log-port.ts'] };
/** 조립 성격의 모듈은 로거를 만들 수 있다. */
const BASE_WITH_LOGGER: Allowed = { ...PROTOCOL, diagnostics: ['log-port.ts', 'contract.ts', 'index.ts'] };
const CORE_PUBLIC = ['index.ts', 'contract.ts', 'ports.ts'] as const;
const PUBLIC = ['index.ts', 'contract.ts'] as const;

/**
 * 제품 코드가 다른 모듈에서 import 할 수 있는 파일.
 * room-session 과 mcp-server 는 하위 모듈을 주입받으므로 계약(타입)만 가져온다. 생성과 주입은 entry 에서만 한다.
 */
const DEPENDS: Record<Exclude<ModuleName, 'entry'>, Allowed> = {
  protocol: {},
  diagnostics: PROTOCOL,
  'signaling-core': BASE,
  'signaling-selfhost': { ...BASE_WITH_LOGGER, 'signaling-core': CORE_PUBLIC },
  'signaling-aws': { ...BASE_WITH_LOGGER, 'signaling-core': CORE_PUBLIC },
  'signaling-client': BASE,
  mesh: BASE,
  'shared-state': BASE,
  inbox: BASE,
  records: BASE,
  'room-session': {
    ...BASE,
    'signaling-client': ['contract.ts'],
    mesh: ['contract.ts'],
    'shared-state': ['contract.ts'],
    inbox: ['contract.ts'],
    records: ['contract.ts'],
  },
  'mcp-server': { ...BASE, 'room-session': ['contract.ts'], inbox: ['contract.ts'] },
  setup: BASE_WITH_LOGGER,
  // 관전 도구(architecture.md 3.14). mcp-server 와 같은 자리다. 세션과 사건의 계약(타입)만 가져온다.
  monitor: { ...BASE, 'room-session': ['contract.ts'], inbox: ['contract.ts'] },
};

/** 조립 파일마다 붙일 수 있는 모듈. 파일 이름의 첫 마디(mcp, server, lambda, cli, monitor)로 고른다. */
const ENTRY_DEPENDS: Record<string, Allowed> = {
  mcp: {
    ...BASE_WITH_LOGGER,
    'mcp-server': PUBLIC,
    'room-session': PUBLIC,
    'signaling-client': PUBLIC,
    mesh: PUBLIC,
    'shared-state': PUBLIC,
    inbox: PUBLIC,
    records: PUBLIC,
  },
  // 관전 조립. entry/mcp 의 목록에서 mcp-server·inbox 를 빼고 monitor 를 더한 것이다(수신함 자리에 monitor 의 싱크가 들어간다).
  monitor: {
    ...BASE_WITH_LOGGER,
    monitor: PUBLIC,
    'room-session': PUBLIC,
    'signaling-client': PUBLIC,
    mesh: PUBLIC,
    'shared-state': PUBLIC,
    records: PUBLIC,
  },
  server: { ...BASE_WITH_LOGGER, 'signaling-selfhost': PUBLIC },
  lambda: { ...BASE_WITH_LOGGER, 'signaling-aws': PUBLIC },
  cli: { ...BASE_WITH_LOGGER, setup: PUBLIC },
};

/** 외부 SDK 는 정해진 모듈에만 닿는다. 여기에 없는 패키지는 어디서도 쓸 수 없다(의존성 목록 밖). */
const EXTERNAL: Record<ModuleName, readonly string[]> = {
  protocol: ['zod'],
  diagnostics: [],
  'signaling-core': [],
  'signaling-selfhost': ['ws'],
  'signaling-aws': ['@aws-sdk/*'],
  'signaling-client': ['ws'],
  mesh: ['node-datachannel'],
  'shared-state': [],
  inbox: [],
  records: [],
  'room-session': [],
  'mcp-server': ['@modelcontextprotocol/sdk', 'zod'],
  setup: ['@modelcontextprotocol/sdk'],
  monitor: [],
  entry: [],
};

/**
 * MCP SDK 는 하위 경로까지 가린다. 서버 쪽은 mcp-server, 클라이언트 쪽은 setup 만 쓰고, 전송은 stdio 뿐이다.
 * 패키지 이름만 보면 mcp-server 가 클라이언트 전송으로 다른 프로세스를 띄우거나 HTTP 리스너를 열어도 지나간다.
 * 시험 파일은 이 표를 따르지 않는다(가짜 클라이언트를 붙여 본다).
 */
const MCP_SDK = '@modelcontextprotocol/sdk';
const MCP_SDK_PATHS: Partial<Record<ModuleName, readonly string[]>> = {
  'mcp-server': ['server', 'server/index.js', 'server/mcp.js', 'server/stdio.js', 'server/completable.js', 'types.js', 'shared/*'],
  setup: ['client', 'client/index.js', 'client/stdio.js', 'types.js', 'shared/*'],
};

/**
 * SDK 의 클라이언트 stdio 전송은 프로세스를 띄운다. setup 에서 그것을 쓰는 유일한 파일이다.
 * 등록된 명령과 환경 그대로 MCP 프로세스를 띄우는 일만 한다. 옆의 시험이 그것을 고정한다.
 */
const MCP_PROCESS_FILE = 'setup/mcp-process.ts';
const MCP_PROCESS_TEST = 'setup/mcp-process.test.ts';
const MCP_CLIENT_STDIO = 'client/stdio.js';

/** node-datachannel 은 네이티브 API 만 쓴다. polyfill 은 failed 가 closed 로만 보이고 cleanup() 없이 끝나지 않는다. */
const NATIVE_RTC = 'node-datachannel';

/**
 * 제품 코드가 import 할 수 있는 Node 내장 모듈. 여기에 없는 것은 조립 파일을 포함해 어디서도 쓰지 않는다.
 * 금지 목록이 아니라 허용 목록이다. 놓친 모듈(dns, vm, inspector, perf_hooks)이나 새로 생긴 모듈이 규칙 없이 들어오지 않는다.
 * fs, 네트워크, child_process, console, timers 는 아래에서 모듈별로 다시 가린다.
 */
const ALLOWED_BUILTINS: readonly string[] = [
  'assert', 'buffer', 'child_process', 'console', 'crypto', 'events', 'fs', 'os', 'path', 'stream', 'string_decoder',
  'timers', 'url', 'util', 'net', 'dgram', 'http', 'https', 'http2', 'tls',
];

/** I/O 가 없어야 하는 모듈이 쓸 수 있는 Node 내장 모듈. */
const PURE_BUILTINS: Partial<Record<ModuleName, readonly string[]>> = {
  protocol: ['crypto'],
  'shared-state': ['crypto'],
  'signaling-core': ['crypto'],
};

/**
 * 네트워크에 닿는 Node 내장 모듈과, 그것을 쓸 수 있는 모듈.
 * 소켓은 ws(시그널링)와 node-datachannel(P2P)로만 연다. 그 밖의 길로 글이 서버나 다른 곳으로 나가지 않게 한다.
 */
const NETWORK_BUILTINS: readonly string[] = ['net', 'dgram', 'http', 'https', 'http2', 'tls'];
const NETWORK_MODULES: readonly ModuleName[] = ['signaling-selfhost', 'signaling-client'];

/**
 * 파일을 읽고 쓸 수 있는 모듈. 기록 파일은 records, 진단 로그는 diagnostics, 확인 기록 파일은 mcp-server 가 쓴다.
 * 조립 파일(entry)은 패키지 정보를 읽는다.
 */
const FS_MODULES: readonly ModuleName[] = ['records', 'diagnostics', 'mcp-server', 'setup', 'signaling-selfhost', 'entry'];

/** console 과 stdout 에 직접 쓸 수 있는 모듈. MCP 프로세스의 stdout 에는 MCP 메시지만 나가야 한다. */
const STDOUT_MODULES: readonly ModuleName[] = ['diagnostics', 'setup'];
/** 조립 파일 가운데 console 과 stdout 을 쓸 수 있는 것(설치 CLI 의 출력, 서버의 시작 안내, 관전 출력). */
const STDOUT_ENTRIES: readonly string[] = ['cli', 'server', 'monitor'];

/** 호스트 CLI(claude, codex)를 실행하는 유일한 파일. 허용 하위 명령은 옆의 시험이 고정한다. */
const HOST_CLI_FILE = 'setup/host-cli.ts';
const HOST_CLI_TEST = 'setup/host-cli.test.ts';

/** room-session 에서 시그널 전송 함수를 다루는 유일한 파일(joined 전 보관, mesh 에 넘기기). */
const SIGNAL_GATE_FILE = 'room-session/signal-gate.ts';

/**
 * 환경 변수를 읽을 수 있는 모듈. MCP 프로세스의 환경 변수는 조립이 통째로 loadConfig 에 넘긴다.
 * mcp-server 도 process.env 를 직접 읽지 않는다(loadConfig 는 인자로 받는다).
 * setup 은 설치기 변수(architecture.md 3.13), signaling-aws 는 Lambda 변수(deployment.md 2.3)를 읽는다.
 */
const ENV_READERS: readonly ModuleName[] = ['setup', 'signaling-aws'];

/**
 * 조립 파일의 환경 변수. mcp 는 process.env 를 통째로 loadConfig 에 넘기기만 한다(whole).
 * server 는 실행 옵션을 인자로만 받는다(none).
 */
const ENTRY_ENV: Record<string, 'any' | 'whole' | 'none'> = { mcp: 'whole', server: 'none', lambda: 'any', cli: 'any', monitor: 'whole' };

/** 시그널을 보내는 함수를 다룰 수 있는 모듈. */
const SIGNAL_SENDERS: readonly ModuleName[] = ['signaling-client', 'mesh', 'room-session'];

/** 서버 쪽 모듈은 시그널 전달을 relay 라고 부른다(진단 사건 이름). 그 이름은 막지 않는다. */
const SERVER_SIDE: readonly ModuleName[] = ['signaling-core', 'signaling-selfhost', 'signaling-aws'];

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'test', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

// ── 검사 ────────────────────────────────────────────────────────────────────

export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

function isModuleName(value: string): value is ModuleName {
  return (MODULES as readonly string[]).includes(value);
}

function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts') || path.endsWith('/testing.ts');
}

/** `a/b/c.ts` 에서 본 상대 경로를 src 기준 경로로 바꾼다. src 밖으로 나가면 null. */
function resolveRelative(importer: string, specifier: string): string | null {
  const parts = importer.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/').replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts');
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function allowedFor(file: string, module: ModuleName): Allowed | null {
  if (module !== 'entry') return DEPENDS[module];
  const key = (file.split('/').pop() ?? '').split('.')[0] ?? '';
  return ENTRY_DEPENDS[key] ?? null;
}

interface TextRule {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly message: string;
}

/** 조립 파일(entry)만 전역 시계와 타이머를 부른다. 다른 모든 모듈은 주입받는다. */
const CLOCK_RULES: readonly TextRule[] = [
  { rule: 'clock', pattern: /(?<![\w$.])Date\s*\.\s*now\b/g, message: 'Date.now 를 직접 부르지 않는다. 주입받은 now 를 쓴다' },
  {
    rule: 'clock',
    // 괄호가 없거나 비어 있으면 현재 시각이다. `+new Date`, `(new Date).getTime()` 도 같다.
    pattern: /\bnew\s+Date\b(?!\s*\(\s*[^)\s])/g,
    message: '인자 없는 new Date 를 쓰지 않는다(괄호를 뺀 것 포함). 주입받은 now 를 쓴다',
  },
  { rule: 'clock', pattern: /(?<!\bnew\s+)(?<![\w$.])Date\s*\(/g, message: 'new 없는 Date() 는 현재 시각을 읽는다. 주입받은 now 를 쓴다' },
  {
    rule: 'clock',
    pattern: /(?<!\btype\s+[\w$<>,\s]+)=\s*(?:Date|performance)\b(?!\s*[.(\w$])/g,
    message: 'Date 와 performance 를 다른 이름으로 받지 않는다(구조 분해 포함). 주입받은 now 를 쓴다',
  },
  {
    rule: 'clock',
    pattern: /(?<![\w$.])performance\s*\.\s*(?:now|timeOrigin)\b/g,
    message: 'performance 의 시계를 직접 읽지 않는다. 주입받은 now 를 쓴다',
  },
  {
    rule: 'clock',
    pattern: /\bprocess\s*\.\s*(?:hrtime|uptime)\b/g,
    message: 'process.hrtime 과 process.uptime 을 쓰지 않는다. 주입받은 now 를 쓴다',
  },
  {
    rule: 'clock',
    pattern: /(?<![\w$.])(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)\s*\(/g,
    message: '전역 타이머를 직접 부르지 않는다. 주입받은 timers 를 쓴다',
  },
  {
    rule: 'clock',
    pattern: /\bAbortSignal\s*\.\s*timeout\b/g,
    message: 'AbortSignal.timeout 은 숨은 타이머다. 주입받은 timers 로 기한을 건다',
  },
];

/** 전역 가변 상태. 최상위 let·var 는 따로 찾는다(topLevelMutableBindings). */
const GLOBAL_STATE_RULES: readonly TextRule[] = [
  {
    rule: 'global-state',
    pattern: /(?<![\w$.])(?:globalThis\b|global\s*\.)/g,
    message: '전역 객체에 값을 두거나 전역 객체에서 꺼내 쓰지 않는다. 필요한 것은 주입받는다',
  },
];

/** import 없이 쓸 수 있는 네트워크 전역. 어느 모듈에서도 쓰지 않는다. */
const NETWORK_GLOBAL_RULES: readonly TextRule[] = [
  { rule: 'network', pattern: /(?<![\w$.])fetch\s*\(/g, message: '전역 fetch 를 쓰지 않는다. 네트워크는 ws 와 node-datachannel 로만 닿는다' },
  { rule: 'network', pattern: /(?<![\w$.])EventSource\b/g, message: '전역 EventSource 를 쓰지 않는다' },
];
/** ws 패키지를 import 하지 않은 파일의 WebSocket 은 Node 의 전역 WebSocket 이다. */
const GLOBAL_WEBSOCKET = /(?<![\w$.])WebSocket\b/g;

const STDOUT_RULES: readonly TextRule[] = [
  { rule: 'stdout', pattern: /(?<![\w$.])console\s*\./g, message: 'console 을 쓰지 않는다. 진단은 주입받은 로그 포트로 남긴다' },
  {
    rule: 'stdout',
    pattern: /\bprocess\s*\.\s*stdout\s*\.\s*(?:write|end|cork)\b/g,
    message: 'stdout 에 직접 쓰지 않는다. MCP 프로세스의 stdout 에는 MCP 메시지만 나간다',
  },
];

/** 에이전트 호스트를 다른 권한으로 띄우는 실행 옵션. 문자열로도 두지 않는다. */
const PERMISSION_FLAGS =
  /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--permission-mode|bypassPermissions|--allowed-?[Tt]ools|--full-auto|--yolo|--ask-for-approval/g;

const ENV_RULES: readonly { readonly on: 'bare' | 'code'; readonly pattern: RegExp }[] = [
  { on: 'bare', pattern: /\bprocess\s*(?:\?\s*)?\.\s*env\b/g },
  { on: 'code', pattern: /\bprocess\s*\[\s*['"`]env['"`]\s*\]/g },
  { on: 'bare', pattern: /\{[^{}]*\benv\b[^{}]*\}\s*=\s*process\b/g },
  { on: 'code', pattern: /\bimport\s*\{[^}]*\benv\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/g },
];

/** TURN 서버와 그 자격 증명, 중계 강제 옵션의 이름. 어느 모듈에도 없어야 한다. */
const TURN_RULES: readonly TextRule[] = [
  { rule: 'relay', pattern: /\brelay[-_]?type\b/gi, message: 'TURN 중계 종류를 고르는 설정을 두지 않는다' },
  { rule: 'relay', pattern: /\bice[-_]?transport[-_]?policy\b/gi, message: 'ICE 전송 정책(relay 강제) 설정을 두지 않는다' },
  {
    rule: 'relay',
    // 뒤에 경계를 두지 않는다. TurnServerUrl 처럼 이어 쓴 이름도 잡는다.
    pattern: /\bturn[-_]?(?:server|url|uri|host|port|user(?:name)?|pass(?:word)?|credential|secret)/gi,
    message: 'TURN 서버 설정 항목을 두지 않는다',
  },
  { rule: 'relay', pattern: /AGENT_CHAT_\w*(?:TURN|RELAY)/g, message: 'TURN·중계 환경 변수를 두지 않는다' },
];

/** 클라이언트 쪽의 중계 경로를 가리키는 이름. */
const RELAY_PATH_RULES: readonly TextRule[] = [
  {
    rule: 'relay',
    pattern: /\b(?:force|use|enable|allow|via|through)[-_]?relay\b/gi,
    message: '중계 경로를 켜는 이름을 두지 않는다',
  },
  {
    rule: 'relay',
    pattern: /\brelay[-_]?(?:only|fallback|via|through|chat|message|frame|data|peer)s?\b/gi,
    message: '채팅이나 데이터를 다른 곳을 거쳐 보내는 경로를 두지 않는다',
  },
  { rule: 'relay', pattern: /\bforward[-_]?chats?\b/gi, message: '받은 채팅을 다른 참가자에게 넘기는 경로를 두지 않는다' },
];

const TURN_URL = /\bturns?:/g;
const PERMISSION_CAPABILITY = /claude\/channel\/permission/g;
const TYPE_ONLY_FILES = /(?:^|\/)(?:contract|ports|log-port)\.ts$/;
const RUNTIME_STATEMENT = /^[ \t]*(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class|enum|namespace|async\s+function)\b/gm;
const VALUE_IMPORT = /^[ \t]*import\s+(?!type\b)/gm;
const VALUE_EXPORT = /^[ \t]*export\s+(?:default\b|\*|\{)/gm;

/** 소스 묶음(src 기준 경로 → 내용)을 검사한다. 디스크를 읽지 않는다. */
export function analyze(files: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = [];

  for (const [file, source] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const report = (rule: string, index: number, message: string): void => {
      violations.push({ rule, file, line: lineOf(source, index), message });
    };
    const segments = file.split('/');
    const test = isTestFile(file);
    const top = segments[0] ?? '';

    if (segments.length === 1) {
      // src 바로 아래에는 이 검사 같은 시험 파일만 둔다. 제품 코드는 모듈 폴더에 둔다.
      if (!test) report('layout', 0, 'src 바로 아래에는 시험 파일만 둔다');
    } else if (!isModuleName(top)) {
      report('layout', 0, `모르는 모듈 폴더다: ${top}. 모듈 목록과 의존 규칙에 먼저 더한다`);
      continue;
    }
    const module: ModuleName | null = segments.length > 1 && isModuleName(top) ? top : null;

    const scanned = scanSource(source);
    for (const problem of scanned.problems) report('scan', problem.index, `소스를 끝까지 읽지 못했다: ${problem.message}`);
    const { code, bare } = scanned;
    const each = (text: string, pattern: RegExp, handle: (index: number, match: string) => void): void => {
      for (const match of text.matchAll(pattern)) handle(match.index ?? 0, match[0]);
    };

    // 계약 파일은 타입만 둔다.
    if (TYPE_ONLY_FILES.test(file)) {
      each(bare, RUNTIME_STATEMENT, (index) => report('contract-types-only', index, '계약 파일에는 타입만 둔다'));
      each(bare, VALUE_IMPORT, (index) => report('contract-types-only', index, '계약 파일은 import type 만 쓴다'));
      each(bare, VALUE_EXPORT, (index) => report('contract-types-only', index, '계약 파일은 export type 만 쓴다'));
    }

    const allowed = module === null ? null : allowedFor(file, module);
    if (module === 'entry' && allowed === null) {
      report('layout', 0, 'entry 에는 mcp, server, lambda, cli, monitor 조립 파일만 둔다');
    }
    const entryKey = (segments[segments.length - 1] ?? '').split('.')[0] ?? '';
    const stdoutAllowed =
      module !== null && (module === 'entry' ? STDOUT_ENTRIES.includes(entryKey) : STDOUT_MODULES.includes(module));
    if (file === HOST_CLI_FILE && !files.has(HOST_CLI_TEST)) {
      report('layout', 0, `${HOST_CLI_FILE} 에는 허용하는 하위 명령을 고정하는 시험(${HOST_CLI_TEST})이 있어야 한다`);
    }
    if (file === MCP_PROCESS_FILE && !files.has(MCP_PROCESS_TEST)) {
      report('layout', 0, `${MCP_PROCESS_FILE} 에는 등록된 명령만 띄운다는 것을 고정하는 시험(${MCP_PROCESS_TEST})이 있어야 한다`);
    }

    // ── import ──
    for (const ref of findImports(scanned)) {
      const { specifier, index } = ref;
      if (specifier === '') {
        if (!test) report('import-dynamic', index, '동적 import 의 대상은 문자열이어야 한다');
        continue;
      }
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        if (target === null || /(?:^|\/)tests\//.test(specifier)) {
          report('import-outside', index, `src 밖을 import 하지 않는다: ${specifier}`);
          continue;
        }
        const targetSegments = target.split('/');
        const targetTop = targetSegments[0] ?? '';
        const targetModule = targetSegments.length > 1 && isModuleName(targetTop) ? targetTop : null;
        const targetName = targetSegments.slice(1).join('/');
        if (!test && isTestFile(target)) {
          report('import-testing', index, `제품 코드는 시험 전용 파일을 import 하지 않는다: ${specifier}`);
          continue;
        }
        if (targetModule === null) {
          report('import-internal', index, `모듈 폴더 밖의 파일을 import 하지 않는다: ${specifier}`);
          continue;
        }
        if (targetModule === module) continue;

        // 다른 모듈로 가는 import
        if (module === null) {
          // src 바로 아래의 시험 파일은 어느 모듈이든 공개 파일만 본다.
          if (![...CORE_PUBLIC, 'log-port.ts', 'testing.ts'].includes(targetName)) {
            report('import-internal', index, `다른 모듈의 내부 파일을 import 하지 않는다: ${specifier}`);
          }
          continue;
        }
        if (allowed === null) continue;
        const targets = allowed[targetModule];
        if (targets === undefined) {
          report('import-direction', index, `${module} 은(는) ${targetModule} 을(를) import 할 수 없다(타입도 안 된다)`);
          continue;
        }
        // 시험 파일은 붙을 수 있는 모듈의 구현(index)과 시험 전용 진입점도 쓴다. protocol 은 index 와 testing 뿐이다.
        const permitted = !test
          ? targets
          : targetModule === 'protocol'
            ? [...targets, 'testing.ts']
            : [...new Set([...targets, ...PUBLIC, 'testing.ts'])];
        if (!permitted.includes(targetName)) {
          report(
            'import-internal',
            index,
            `${module} 이(가) ${targetModule} 에서 가져올 수 있는 파일은 ${permitted.join(', ')} 뿐이다: ${specifier}`,
          );
        }
        continue;
      }
      if (specifier.startsWith('/') || /^[a-z]+:\/\//i.test(specifier) || specifier.startsWith('file:')) {
        report('import-outside', index, `절대 경로를 import 하지 않는다: ${specifier}`);
        continue;
      }

      const builtin = specifier.startsWith('node:')
        ? (specifier.slice(5).split('/')[0] ?? '')
        : NODE_BUILTINS.has(packageNameOf(specifier))
          ? packageNameOf(specifier)
          : null;
      if (builtin !== null) {
        if (test || module === null) continue;
        if (builtin === 'test') {
          report('builtin', index, 'node:test 는 시험 파일에서만 쓴다');
        } else if (builtin === 'child_process' || builtin === 'worker_threads' || builtin === 'cluster') {
          if (!(builtin === 'child_process' && file === HOST_CLI_FILE)) {
            report('builtin', index, `${builtin} 은 호스트 CLI 를 실행하는 ${HOST_CLI_FILE} 밖에서 쓰지 않는다`);
          }
        } else if (builtin === 'module') {
          // createRequire 로 부른 모듈은 import 를 읽는 이 검사에 보이지 않는다.
          report('builtin', index, 'node:module 을 쓰지 않는다. 모듈은 import 로만 불러온다(createRequire 로 부르면 이 검사를 비켜 간다)');
        } else if (builtin === 'process') {
          // 다른 이름으로 받은 process 는 env·stdout·시계 규칙에 걸리지 않는다.
          report('builtin', index, 'node:process 를 import 하지 않는다. 전역 process 를 쓴다(다른 이름으로 받으면 env·stdout·시계 검사를 비켜 간다)');
        } else if (!ALLOWED_BUILTINS.includes(builtin)) {
          report('builtin', index, `node:${builtin} 은 쓸 수 있는 내장 모듈 목록에 없다. 필요하면 목록과 설계에 먼저 더한다`);
        }
        const pure = PURE_BUILTINS[module];
        if (pure !== undefined && !pure.includes(builtin)) {
          report('builtin', index, `${module} 은(는) I/O 가 없는 모듈이다. node:${builtin} 을 쓰지 않는다`);
        }
        if (NETWORK_BUILTINS.includes(builtin) && !NETWORK_MODULES.includes(module)) {
          report('network', index, `node:${builtin} 은 ${NETWORK_MODULES.join(', ')} 밖에서 쓰지 않는다. 네트워크는 정해진 모듈만 닿는다`);
        }
        if (builtin === 'fs' && pure === undefined && !FS_MODULES.includes(module)) {
          report('builtin', index, `${module} 은(는) 파일을 직접 읽고 쓰지 않는다. 기록은 records, 로그는 diagnostics 가 쓴다`);
        }
        if (builtin === 'console' && !stdoutAllowed) {
          report('stdout', index, 'node:console 을 쓰지 않는다. 진단은 주입받은 로그 포트로 남긴다');
        }
        if (builtin === 'timers' && module !== 'entry') {
          report('clock', index, 'node:timers 를 import 하지 않는다. 주입받은 timers 를 쓴다');
        }
        continue;
      }

      if (module === null) continue;
      const name = packageNameOf(specifier);
      const known = Object.values(EXTERNAL).flat();
      const matches = (entry: string): boolean => (entry.endsWith('/*') ? name.startsWith(entry.slice(0, -1)) : entry === name);
      if (!known.some(matches)) {
        report('external-package', index, `의존성 목록 밖의 패키지다: ${name}`);
      } else if (!EXTERNAL[module].some(matches)) {
        report('external-package', index, `${name} 은(는) ${module} 에서 쓸 수 없다. 외부 SDK 는 정해진 모듈에만 닿는다`);
      } else if (name === NATIVE_RTC && specifier !== NATIVE_RTC) {
        report('external-package', index, `${NATIVE_RTC} 은 네이티브 API 만 쓴다. 하위 경로(polyfill)를 import 하지 않는다: ${specifier}`);
      } else if (name === MCP_SDK && !test) {
        const subpath = specifier.slice(MCP_SDK.length + 1);
        const paths = MCP_SDK_PATHS[module] ?? [];
        const permitted = paths.some((entry) => (entry.endsWith('/*') ? subpath.startsWith(entry.slice(0, -1)) : entry === subpath));
        if (!permitted) {
          report(
            'external-package',
            index,
            `${module} 이(가) MCP SDK 에서 쓸 수 있는 경로는 ${paths.join(', ')} 뿐이다(전송은 stdio 만): ${specifier}`,
          );
        } else if (subpath === MCP_CLIENT_STDIO && file !== MCP_PROCESS_FILE) {
          report('external-package', index, `SDK 의 클라이언트 stdio 전송(프로세스를 띄운다)은 ${MCP_PROCESS_FILE} 밖에서 쓰지 않는다`);
        }
      }
    }

    if (test || module === null) continue;

    // ── 환경 변수 ──
    const envAccess = module === 'entry' ? (ENTRY_ENV[entryKey] ?? 'none') : ENV_READERS.includes(module) ? 'any' : 'none';
    if (envAccess === 'none') {
      for (const rule of ENV_RULES) {
        each(rule.on === 'bare' ? bare : code, rule.pattern, (index) =>
          report('env', index, `${module} 은(는) 환경 변수를 읽지 않는다. 조립이 통째로 loadConfig 에 넘기고, 해석한 값을 주입받는다`),
        );
      }
    } else if (envAccess === 'whole') {
      for (const rule of ENV_RULES.slice(1)) {
        each(rule.on === 'bare' ? bare : code, rule.pattern, (index) =>
          report('env', index, '조립은 process.env 를 통째로 loadConfig 에 넘긴다. 값을 직접 읽지 않는다'),
        );
      }
      each(bare, /\bprocess\s*(?:\?\s*)?\.\s*env\s*(?:\?\s*)?[.[]/g, (index) =>
        report('env', index, '조립은 process.env 를 통째로 loadConfig 에 넘긴다. 값을 직접 읽지 않는다'),
      );
    }

    // ── 시계와 타이머 ── 조립 파일만 전역을 부른다.
    if (module !== 'entry') {
      for (const rule of CLOCK_RULES) each(bare, rule.pattern, (index) => report(rule.rule, index, rule.message));
    }

    // ── 전역 가변 상태 ──
    for (const rule of GLOBAL_STATE_RULES) each(bare, rule.pattern, (index) => report(rule.rule, index, rule.message));
    for (const index of topLevelMutableBindings(bare)) {
      report('global-state', index, '모듈 최상위에 let·var 를 두지 않는다. 상태는 만드는 함수 안에 둔다');
    }

    // ── import 없이 닿는 네트워크 ──
    for (const rule of NETWORK_GLOBAL_RULES) each(bare, rule.pattern, (index) => report(rule.rule, index, rule.message));
    if (!findImports(scanned).some((ref) => packageNameOf(ref.specifier) === 'ws')) {
      each(bare, GLOBAL_WEBSOCKET, (index) =>
        report('network', index, '전역 WebSocket 을 쓰지 않는다. 소켓은 ws 패키지를 쓰는 모듈만 연다'),
      );
    }
    each(bare, /\bgetBuiltinModule\b/g, (index) =>
      report('builtin', index, '내장 모듈은 import 로만 불러온다. process.getBuiltinModule 을 쓰지 않는다'),
    );

    // ── stdout ──
    if (!stdoutAllowed) {
      for (const rule of STDOUT_RULES) each(bare, rule.pattern, (index) => report(rule.rule, index, rule.message));
    }

    // ── TURN 과 중계 ──
    for (const rule of TURN_RULES) each(code, rule.pattern, (index) => report(rule.rule, index, rule.message));
    if (!SERVER_SIDE.includes(module)) {
      for (const rule of RELAY_PATH_RULES) each(code, rule.pattern, (index) => report(rule.rule, index, rule.message));
    }
    if (file !== 'protocol/ice-config.ts') {
      // 문자열 안의 것만 본다. `turns: number` 같은 필드 이름(에이전트의 턴)은 주소가 아니다.
      each(code, TURN_URL, (index) => {
        if (bare[index] === ' ') report('relay', index, 'turn: 과 turns: 주소를 코드에 두지 않는다');
      });
    }

    // ── 권한 ──
    each(code, PERMISSION_CAPABILITY, (index) =>
      report('permission', index, 'permission relay capability 를 선언하지 않는다. 문자열도 두지 않는다'),
    );
    each(code, PERMISSION_FLAGS, (index) =>
      report('permission', index, '에이전트 호스트의 권한을 넓히는 실행 옵션을 두지 않는다. 문자열도 두지 않는다'),
    );

    // ── 시그널로 채팅을 보내는 길 ──
    const contractFile = TYPE_ONLY_FILES.test(file);
    const outsideGate = module === 'room-session' && file !== SIGNAL_GATE_FILE && !contractFile;
    if (!SIGNAL_SENDERS.includes(module) || outsideGate) {
      const message = outsideGate
        ? `room-session 에서 시그널 전송 함수는 ${SIGNAL_GATE_FILE} 만 다룬다. 다른 파일은 그 이름을 쓰지 않는다`
        : `${module} 은(는) 시그널 전송 함수를 다루지 않는다`;
      each(bare, /\b[sS]endSignal\b/g, (index) => report('signal-chat', index, message));
      each(code, /['"`]sendSignal['"`]/g, (index) => report('signal-chat', index, message));
    }
    const chatPart = module === 'room-session' && /chat/i.test(segments[segments.length - 1] ?? '');
    if (chatPart) {
      for (const ref of findImports(scanned)) {
        if (/(?:^|\/)signaling-client\//.test(ref.specifier)) {
          report('signal-chat', ref.index, '채팅 전달 부분은 signaling-client 를 import 하지 않는다');
        }
      }
    }
  }
  return violations;
}

/** 모듈 최상위(어느 괄호에도 들지 않은 자리)의 let·var 선언 위치. 인자는 주석과 문자열 내용을 지운 소스다. */
export function topLevelMutableBindings(bare: string): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let i = 0; i < bare.length; i += 1) {
    const ch = bare[i] as string;
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === 'l' || ch === 'v')) {
      const match = /^(?:let|var)\s+[\w${[]/.exec(bare.slice(i, i + 8));
      const before = i === 0 ? '' : (bare[i - 1] as string);
      if (match !== null && !/[\w$.]/.test(before)) found.push(i);
    }
  }
  return found;
}

// ── src 밖의 설정과 스크립트 ────────────────────────────────────────────────
// 금지 범위는 "TURN·서버 중계와 관련된 코드나 설정 항목"이다. 배포 템플릿과 설치 스크립트에도 같은 이름을 두지 않는다.
// 권한을 넓히는 실행 옵션도 같다. 설치는 MCP 등록만 하고 호스트를 다른 권한으로 띄우지 않는다(mcp-interface.md 10절).

/** 저장소 뿌리 기준으로 읽는 폴더. 시험 폴더(tests/)는 거절 표본으로 TURN 주소를 쓰므로 보지 않는다. */
const EXTRA_DIRS: readonly string[] = ['deployments', 'scripts', 'installer'];
const EXTRA_SKIP = /(?:^|\/)(?:node_modules|dist|build|\.work)\/|\.md$|\.test\.[cm]?[jt]s$/;
const SCRIPT_FILE = /\.[cm]?[jt]s$/;

/**
 * 설정·스크립트 묶음(저장소 기준 경로 → 내용)에서 TURN·중계 설정과 권한을 넓히는 실행 옵션을 찾는다. 디스크를 읽지 않는다.
 * 설치 진입점(installer, scripts)은 호스트를 가장 쉽게 띄울 수 있는 곳이다. src 와 같은 권한 규칙을 건다.
 */
export function analyzeExtra(files: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = [];
  for (const [file, source] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (EXTRA_SKIP.test(file)) continue;
    const report = (rule: string, index: number, message: string): void => {
      violations.push({ rule, file, line: lineOf(source, index), message });
    };
    // 스크립트는 주석을 지우고 본다(주소는 문자열 안의 것만). 셸과 그 밖의 글 파일은 있는 그대로 본다.
    const scanned = SCRIPT_FILE.test(file) ? scanSource(source) : null;
    if (scanned !== null) {
      for (const problem of scanned.problems) report('scan', problem.index, `소스를 끝까지 읽지 못했다: ${problem.message}`);
    }
    const text = scanned === null ? source : scanned.code;
    for (const rule of TURN_RULES) {
      for (const match of text.matchAll(rule.pattern)) report('relay', match.index ?? 0, rule.message);
    }
    for (const match of text.matchAll(TURN_URL)) {
      const index = match.index ?? 0;
      if (scanned === null || scanned.bare[index] === ' ') report('relay', index, 'turn: 과 turns: 주소를 설정과 스크립트에 두지 않는다');
    }
    for (const match of text.matchAll(PERMISSION_FLAGS)) {
      report('permission', match.index ?? 0, '에이전트 호스트의 권한을 넓히는 실행 옵션을 설정과 스크립트에 두지 않는다. 문자열도 두지 않는다');
    }
    for (const match of text.matchAll(PERMISSION_CAPABILITY)) {
      report('permission', match.index ?? 0, 'permission relay capability 문자열을 설정과 스크립트에 두지 않는다');
    }
  }
  return violations;
}

// ── 실제 소스 ───────────────────────────────────────────────────────────────

function findRepoRoot(): string {
  const override = process.env['AGENT_CHAT_REPO_ROOT'];
  if (override !== undefined && override !== '') return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'protocol', 'index.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('저장소 뿌리를 찾지 못했다. AGENT_CHAT_REPO_ROOT 로 알려 준다');
}

function readSources(srcRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) files.set(relative, readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  walk(srcRoot, '');
  return files;
}

function readExtras(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        const content = readFileSync(join(dir, entry.name));
        // 글 파일만 본다. NUL 이 든 파일은 글이 아니다.
        if (!content.includes(0)) files.set(relative, content.toString('utf8'));
      }
    }
  };
  for (const dir of EXTRA_DIRS) {
    if (existsSync(join(root, dir))) walk(join(root, dir), dir);
  }
  return files;
}

function describeViolations(violations: readonly Violation[], prefix = 'src/'): string {
  return violations.map((v) => `  [${v.rule}] ${prefix}${v.file}:${v.line} ${v.message}`).join('\n');
}

const repoRoot = findRepoRoot();
const sources = readSources(join(repoRoot, 'src'));
const extras = readExtras(repoRoot);

describe('V-U8 모듈 경계 (실제 소스)', () => {
  it('W0 의 계약 파일이 모두 있다', () => {
    const expected = [
      'protocol/index.ts',
      'diagnostics/log-port.ts',
      'diagnostics/contract.ts',
      'signaling-core/ports.ts',
      'signaling-core/contract.ts',
      'signaling-client/contract.ts',
      'mesh/contract.ts',
      'shared-state/contract.ts',
      'inbox/contract.ts',
      'records/contract.ts',
      'room-session/contract.ts',
      'mcp-server/contract.ts',
    ];
    for (const file of expected) assert.ok(sources.has(file), `src/${file} 이 없다`);
  });

  it('소스에 경계 위반이 없다', () => {
    const violations = analyze(sources);
    assert.equal(violations.length, 0, `경계 위반 ${violations.length}건\n${describeViolations(violations)}`);
  });

  it('배포 템플릿과 설치 스크립트(deployments, scripts, installer)에 TURN·중계 설정과 권한을 넓히는 실행 옵션이 없다', () => {
    const violations = analyzeExtra(extras);
    assert.equal(violations.length, 0, `위반 ${violations.length}건\n${describeViolations(violations, '')}`);
  });

  it('src 에는 TypeScript 소스만 있다', () => {
    const others = [...sources.keys()].filter((file) => !file.endsWith('.ts'));
    assert.deepEqual(others, []);
  });
});

/** 이 revision 으로 붙은 서버는 채널로 등록되지 않는다(mcp-interface.md 1절). SDK 를 올릴 때 여기서 걸린다. */
const BLOCKED_REVISION = '2026-07-28';

export function supportsBlockedRevision(versions: readonly string[]): boolean {
  return versions.includes(BLOCKED_REVISION);
}

describe('V-U8 의존성과 SDK', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('의존성은 설계의 목록 그대로이고 버전이 고정돼 있다', () => {
    assert.deepEqual(manifest.dependencies, {
      '@modelcontextprotocol/sdk': '1.32.2',
      'node-datachannel': '0.33.6',
      ws: '8.23.0',
      zod: '4.6.7',
    });
    const allowedDev = [
      '@aws-sdk/client-apigatewaymanagementapi',
      '@aws-sdk/client-dynamodb',
      '@aws-sdk/lib-dynamodb',
      '@types/node',
      '@types/ws',
      'esbuild',
      'typescript',
    ];
    for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
      assert.ok(allowedDev.includes(name), `개발 의존성 목록 밖의 패키지: ${name}`);
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} 의 버전이 고정돼 있지 않다`);
    }
  });

  it('설치된 MCP SDK 는 1.32.2 이고 revision 2026-07-28 을 지원하지 않는다', () => {
    const installed = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'),
    ) as { version: string };
    assert.equal(installed.version, '1.32.2');
    assert.ok(SUPPORTED_PROTOCOL_VERSIONS.length > 0);
    assert.equal(supportsBlockedRevision(SUPPORTED_PROTOCOL_VERSIONS), false, '채널 등록이 막히는 revision 을 지원한다');
    assert.equal(supportsBlockedRevision([LATEST_PROTOCOL_VERSION]), false);
  });

  it('revision 판정은 목록에 그 값이 있으면 참이다', () => {
    assert.equal(supportsBlockedRevision(['2025-11-25', '2026-07-28']), true);
    assert.equal(supportsBlockedRevision(['2025-11-25', '2025-06-18']), false);
    assert.equal(supportsBlockedRevision([]), false);
  });
});

describe('V-U8 시그널로 채팅을 보낼 길이 없다 (와이어 스키마)', () => {
  const join = '{"action":"join","v":1,"id":"j1","room":"abcdefgh","peer":"a","sid":"aaaaaaaaaaaa","key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","mode":"create","seq":1}';

  it('서버가 받는 action 과 signal 의 kind 는 연결 정보뿐이다', () => {
    assert.deepEqual([...CLIENT_ACTIONS], ['join', 'signal', 'ping', 'leave']);
    assert.deepEqual([...SIGNAL_KINDS], ['offer-request', 'offer', 'answer', 'candidate']);
    assert.equal(parseClientMessage(join).ok, true);
    for (const action of ['chat', 'state', 'message', 'relay', 'broadcast']) {
      const result = parseClientMessage(JSON.stringify({ action, id: 'x1', to: 'b', text: 'hello' }));
      assert.equal(result.ok, false, action);
      if (!result.ok) assert.equal(result.code, 'BAD_MESSAGE');
    }
    for (const kind of ['chat', 'state', 'text', 'data']) {
      const result = parseClientMessage(JSON.stringify({ action: 'signal', id: 'x1', to: 'b', kind, data: { text: 'hello' } }));
      assert.equal(result.ok, false, kind);
    }
  });

  it('signal 에 얹은 다른 필드는 전달되지 않는다', () => {
    const result = parseClientMessage(
      JSON.stringify({ action: 'signal', id: 'x1', to: 'b', kind: 'offer-request', data: { text: 'hello' }, text: 'hello', chat: { text: 'hello' } }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(JSON.stringify(result.value).includes('hello'), false);
    assert.deepEqual(Object.keys(result.value).sort(), ['action', 'data', 'id', 'kind', 'to']);
  });

  it('채팅은 P2P 프레임에만 있다', () => {
    assert.ok(P2P_FRAME_TYPES.includes('chat'));
    assert.ok(!(CLIENT_ACTIONS as readonly string[]).includes('chat'));
  });
});

// ── 검사기 자체 시험 ────────────────────────────────────────────────────────

function check(files: Record<string, string>): Violation[] {
  return analyze(new Map(Object.entries(files)));
}

function rulesOf(files: Record<string, string>): string[] {
  return [...new Set(check(files).map((violation) => violation.rule))].sort();
}

describe('V-U8 검사기 자체 시험: 소스 읽기', () => {
  it('주석은 지우고 문자열은 남긴다', () => {
    const source = "const a = 'x // y'; // tail\n/* block\n more */ const b = \"/* z */\";\n";
    const { code, bare, problems } = scanSource(source);
    assert.deepEqual(problems, []);
    assert.equal(code.length, source.length);
    assert.ok(code.includes("'x // y'"));
    assert.ok(code.includes('"/* z */"'));
    assert.ok(!code.includes('tail'));
    assert.ok(!code.includes('block'));
    assert.ok(!bare.includes('x // y'));
    assert.equal(code.split('\n').length, source.split('\n').length);
  });

  it('템플릿 안의 코드, 정규식, 나눗셈을 가려 읽는다', () => {
    const source = [
      'const t = `a ${ fn({ k: `in ${1 + 2}` }) } // not a comment`;',
      "const r = /['\"`/]+\\//g.test(x) ? a / b / c : d;",
      'const u = "ws://host"; const v = x /* c */ / 2;',
      "if (ok) { y = z.replace(/\\/\\*/g, '') }",
      'const done = 1;',
    ].join('\n');
    const { code, bare, problems } = scanSource(source);
    assert.deepEqual(problems, []);
    assert.ok(code.includes('// not a comment'));
    assert.ok(code.includes('"ws://host"'));
    assert.ok(bare.includes('const done = 1;'));
    assert.ok(bare.includes('fn({ k:'));
    assert.ok(!bare.includes('not a comment'));
    assert.ok(!bare.includes('ws://host'));
  });

  it('실행 파일 머리줄은 코드로 읽지 않는다', () => {
    const { code, bare, problems } = scanSource("#!/usr/bin/env node\nimport { run } from '../setup/index.js';\nrun();\n");
    assert.deepEqual(problems, []);
    assert.ok(!code.includes('usr/bin'));
    assert.ok(bare.includes('run();'));
  });

  it('끝까지 읽지 못하면 알린다', () => {
    assert.equal(scanSource("const a = 'open\nconst b = 1;").problems.length, 1);
    assert.equal(scanSource('/* never closed').problems.length, 1);
    assert.equal(scanSource('const a = `open ${x').problems.length, 1);
    assert.deepEqual(rulesOf({ 'mesh/broken.ts': "export const a = 'open\n" }), ['scan']);
  });

  it('import 의 모든 모양을 찾는다', () => {
    const source = [
      "import a from './a.js';",
      "import type { B } from '../b/contract.js';",
      "import {\n  c,\n  d,\n} from 'pkg-c';",
      "import 'side-effect';",
      "export * from './e.js';",
      "export type { F } from './f.js';",
      "const g = await import('node:fs');",
      "const h = require('h-pkg');",
      'const i = await import(name);',
      "// import z from './commented.js';",
      "const text = \"import q from './in-string.js'\";",
      "type J = typeof import('./j.js');",
    ].join('\n');
    const specifiers = findImports(scanSource(source)).map((ref) => ref.specifier);
    assert.deepEqual(specifiers, ['./a.js', '../b/contract.js', 'pkg-c', 'side-effect', './e.js', './f.js', 'node:fs', 'h-pkg', '', './j.js']);
  });
});

describe('V-U8 검사기 자체 시험: 가짜 위반을 잡는다', () => {
  const ok: Record<string, string> = {
    'protocol/index.ts': "export { z } from 'zod';\nexport * from './limits.js';\n",
    'protocol/limits.ts': "import { createHash } from 'node:crypto';\nexport const LIMITS = { a: createHash('sha256') };\n",
    'protocol/testing.ts': "import { it } from 'node:test';\nexport const defineSubscribableContractTests = () => it;\n",
    'diagnostics/log-port.ts': 'export interface LogPort { event(level: string): void }\n',
    'diagnostics/contract.ts': "import type { LogPort } from './log-port.js';\nexport interface Logger extends LogPort { close(budgetMs: number): Promise<void> }\nexport type CreateStdoutLogger = (options: { now: () => number }) => Logger;\n",
    'diagnostics/index.ts': "import { mkdirSync } from 'node:fs';\nimport type { CreateStdoutLogger } from './contract.js';\nexport const createStdoutLogger: CreateStdoutLogger = (options) => ({ event: () => { process.stdout.write(String(options.now())); console.error(mkdirSync); }, close: async () => {} });\n",
    'mesh/contract.ts': "import type { LogPort } from '../diagnostics/log-port.js';\nexport interface Mesh { log: LogPort }\nexport type SendSignal = (to: string) => boolean;\n",
    'mesh/index.ts': "import nodeDataChannel from 'node-datachannel';\nimport { LIMITS } from '../protocol/index.js';\nimport type { Mesh } from './contract.js';\nexport const lib = [nodeDataChannel, LIMITS] as unknown as Mesh;\n",
    'mesh/mesh.test.ts': "import { describe } from 'node:test';\nimport { spawn } from 'node:child_process';\nimport { defineSubscribableContractTests } from '../protocol/testing.js';\nlet shared = 0;\nexport const t = [describe, spawn, defineSubscribableContractTests, setTimeout(() => { shared += 1; }, 1), process.env.X, console.log];\n",
    'shared-state/contract.ts': 'export interface Replica { fingerprint(): string }\n',
    'shared-state/index.ts': "import type { Replica } from './contract.js';\nexport const make = (): Replica => ({ fingerprint: () => '' });\n",
    'inbox/contract.ts': 'export interface Inbox { push(): void }\n',
    'records/contract.ts': 'export interface Transcript { close(): void }\n',
    'records/transcript.ts': "import { appendFile } from 'node:fs/promises';\nexport type Stamp = Date;\nconst TABLE = new Map<string, number>();\nfor (let i = 0; i < 2; i += 1) TABLE.set(String(i), i);\nexport const line = (now: () => number) => { let count = 0; count += 1; return [appendFile, TABLE, count, new Date(now()).toISOString(), Date.UTC(2026, 0, 1), Date.parse('2026-01-01')]; };\n",
    'signaling-client/contract.ts': 'export interface SignalingClient { sendSignal(to: string): boolean }\n',
    'signaling-client/index.ts': "import type { ClientRequest } from 'node:http';\nimport WebSocket from 'ws';\nexport const open = (url: string) => [new WebSocket(url), null as ClientRequest | null];\n",
    'signaling-core/ports.ts': 'export interface RoomStore { getPeer(): void }\n',
    'signaling-core/contract.ts': "export type { RoomStore } from './ports.js';\n",
    'signaling-core/index.ts': "import type { RoomStore } from './ports.js';\nexport const create = (store: RoomStore) => ({ relayMessage: () => store });\n",
    'signaling-core/testing.ts': "import { it } from 'node:test';\nimport type { RoomStore } from './ports.js';\nexport const define = (s: RoomStore) => it('x', () => { void s; });\n",
    'signaling-selfhost/index.ts': "import { readFileSync } from 'node:fs';\nimport { createServer } from 'node:http';\nimport { WebSocketServer } from 'ws';\nimport { create } from '../signaling-core/index.js';\nimport type { RoomStore } from '../signaling-core/ports.js';\nexport const start = (s: RoomStore, timers: { setTimeout: (f: () => void, ms: number) => unknown }) => [readFileSync, createServer, WebSocketServer, create(s), timers.setTimeout(() => {}, 1)];\n",
    'signaling-selfhost/store.test.ts': "import { define } from '../signaling-core/testing.js';\nexport const t = define;\n",
    'signaling-aws/index.ts': "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nexport const createHandler = (deps: { now: () => number }) => [DynamoDBClient, process.env.TABLE_NAME, deps.now()];\n",
    'room-session/contract.ts': "import type { Mesh } from '../mesh/contract.js';\nimport type { Replica } from '../shared-state/contract.js';\nexport interface RoomSession { mesh: Mesh; replica: Replica }\n",
    'room-session/signal-gate.ts': "import type { SendSignal } from '../mesh/contract.js';\nimport type { SignalingClient } from '../signaling-client/contract.js';\nexport const gate = (client: SignalingClient): SendSignal => (to) => client.sendSignal(to);\n",
    'room-session/join.ts': "import type { SignalingClient } from '../signaling-client/contract.js';\nexport const enter = (client: SignalingClient) => client;\n",
    'room-session/chat.ts': 'export const send = (sendFrame: (peer: string, text: string) => string) => sendFrame;\n',
    'room-session/sync.test.ts': "import { make } from '../shared-state/index.js';\nexport const t = make;\n",
    'mcp-server/contract.ts': "import type { RoomSession } from '../room-session/contract.js';\nexport interface McpServerDeps { session: RoomSession }\n",
    'mcp-server/server.test.ts': "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nimport { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';\nexport const t = [Client, InMemoryTransport, new Date];\n",
    'mcp-server/config.ts': "import { z } from 'zod';\nexport const load = (env: Record<string, string | undefined>) => [z, env['AGENT_CHAT_NAME']];\n",
    'mcp-server/server.ts': "import { writeFile } from 'node:fs/promises';\nimport { homedir } from 'node:os';\nimport { join } from 'node:path';\nimport { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\nimport { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';\nexport const sdk = [StdioServerTransport, CallToolRequestSchema, homedir, join];\n// experimental['claude/channel/permission'] 은 선언하지 않는다\nexport const caps = [McpServer, writeFile, { experimental: { 'claude/channel': {} } }];\nexport const watch = (onEnd: () => void) => { process.stdin.on('end', onEnd); process.stdout.on('error', onEnd); process.on('SIGINT', onEnd); };\n",
    'setup/host-cli.ts': "import { execFile } from 'node:child_process';\nexport const runHostCli = (bin: string, args: readonly string[]) => execFile(bin, [...args]);\n",
    'setup/host-cli.test.ts': "import { runHostCli } from './host-cli.js';\nexport const t = runHostCli;\n",
    'setup/mcp-process.ts': "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';\nimport type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';\nexport const launch = (command: string, args: string[], env: Record<string, string>): Transport => new StdioClientTransport({ command, args, env });\n",
    'setup/mcp-process.test.ts': "import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';\nimport { launch } from './mcp-process.js';\nexport const t = [launch, InMemoryTransport];\n",
    'setup/index.ts': "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nimport { runHostCli } from './host-cli.js';\nexport const run = (now: () => number) => [Client, runHostCli, process.env.AGENT_CHAT_HOME, now(), console.log('ok')];\n",
    'entry/mcp.ts': "import { readFileSync } from 'node:fs';\nimport { lib } from '../mesh/index.js';\nimport { make } from '../shared-state/index.js';\nexport const main = [lib, make, readFileSync, process.env, { now: () => Date.now(), setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) }];\n",
    'entry/server.ts': "import { start } from '../signaling-selfhost/index.js';\nexport const main = [start, { now: () => Date.now() }, console.log('listening')];\n",
    'entry/cli.ts': "import { run } from '../setup/index.js';\nexport const main = [run(() => Date.now()), console.log('done')];\nexport const monitor = async (argv: string[]) => (await import('./monitor.js')).main(argv);\n",
    'monitor/contract.ts': "import type { RoomSession } from '../room-session/contract.js';\nimport type { Inbox } from '../inbox/contract.js';\nimport type { LogPort } from '../diagnostics/log-port.js';\nexport interface MonitorDeps { session: RoomSession; inbox: Inbox; log: LogPort; write: (line: string) => void }\n",
    'monitor/run.ts': "import { LIMITS } from '../protocol/index.js';\nimport type { MonitorDeps } from './contract.js';\nexport const run = (deps: MonitorDeps, env: Record<string, string | undefined>) => { deps.write(String(LIMITS)); return env['NO_COLOR']; };\n",
    'entry/monitor.ts': "import { readFileSync } from 'node:fs';\nimport { run } from '../monitor/index.js';\nimport { lib } from '../mesh/index.js';\nexport const main = (argv: string[]) => [run, lib, argv, readFileSync, process.env, process.stdout.write('x'), { now: () => Date.now() }];\n",
    'monitor/index.ts': "export { run } from './run.js';\n",
    'boundaries.test.ts': "import type { Mesh } from './mesh/contract.js';\nexport type T = Mesh;\n",
  };

  it('규칙을 지킨 묶음은 위반이 없다', () => {
    assert.equal(describeViolations(check(ok)), '');
  });

  const cases: readonly { readonly name: string; readonly rule: string; readonly files: Record<string, string> }[] = [
    {
      name: '다른 모듈의 내부 파일을 import',
      rule: 'import-internal',
      files: { 'room-session/join.ts': "import { x } from '../mesh/attempt.js';\nexport const y = x;\n" },
    },
    {
      name: 'protocol 의 내부 파일을 import',
      rule: 'import-internal',
      files: { 'mesh/util.ts': "import { LIMITS } from '../protocol/limits.js';\nexport const y = LIMITS;\n" },
    },
    {
      name: '주입받는 모듈의 구현(index)을 제품 코드가 import',
      rule: 'import-internal',
      files: { 'room-session/join.ts': "import { lib } from '../mesh/index.js';\nexport const y = lib;\n" },
    },
    {
      name: '형제 모듈의 타입을 import',
      rule: 'import-direction',
      files: { 'mesh/util.ts': "import type { SignalingClient } from '../signaling-client/contract.js';\nexport type Y = SignalingClient;\n" },
    },
    {
      name: '아래 모듈이 위 모듈을 import',
      rule: 'import-direction',
      files: { 'inbox/queue.ts': "import type { McpServerDeps } from '../mcp-server/contract.js';\nexport type Y = McpServerDeps;\n" },
    },
    {
      name: '(관전) monitor 가 mcp-server 를 import',
      rule: 'import-direction',
      files: { 'monitor/run.ts': "import type { McpServerDeps } from '../mcp-server/contract.js';\nexport type Y = McpServerDeps;\n" },
    },
    {
      name: '(관전) monitor 가 room-session 의 구현(index)을 import',
      rule: 'import-internal',
      files: { 'monitor/run.ts': "import { createRoomSession } from '../room-session/index.js';\nexport const y = createRoomSession;\n" },
    },
    {
      name: '(관전) monitor 가 mesh 를 직접 import',
      rule: 'import-direction',
      files: { 'monitor/run.ts': "import type { Mesh } from '../mesh/contract.js';\nexport type Y = Mesh;\n" },
    },
    {
      name: '(관전) monitor 가 stdout 에 직접 쓴다',
      rule: 'stdout',
      files: { 'monitor/run.ts': "export const run = (line: string) => process.stdout.write(line);\n" },
    },
    {
      name: '(관전) monitor 가 console 을 쓴다',
      rule: 'stdout',
      files: { 'monitor/run.ts': "export const run = (line: string) => console.log(line);\n" },
    },
    {
      name: '(관전) monitor 가 환경 변수를 직접 읽는다',
      rule: 'env',
      files: { 'monitor/run.ts': "export const run = () => process.env.AGENT_CHAT_SERVER;\n" },
    },
    {
      name: '(관전) monitor 가 전역 시계를 부른다',
      rule: 'clock',
      files: { 'monitor/run.ts': "export const run = () => Date.now();\n" },
    },
    {
      name: '(관전) monitor 가 파일에 쓴다',
      rule: 'builtin',
      files: { 'monitor/run.ts': "import { writeFileSync } from 'node:fs';\nexport const run = writeFileSync;\n" },
    },
    {
      name: '(관전) entry/monitor 가 환경 변수 값을 직접 읽는다(통째로만 넘긴다)',
      rule: 'env',
      files: { 'entry/monitor.ts': "export const main = () => process.env.AGENT_CHAT_SERVER;\n" },
    },
    {
      name: '(관전) entry/monitor 가 mcp-server 를 붙인다',
      rule: 'import-direction',
      files: { 'entry/monitor.ts': "import { startMcpServer } from '../mcp-server/index.js';\nexport const main = startMcpServer;\n" },
    },
    {
      name: 'mcp-server 가 shared-state 를 직접 import',
      rule: 'import-direction',
      files: { 'mcp-server/tools.ts': "import type { Replica } from '../shared-state/contract.js';\nexport type Y = Replica;\n" },
    },
    {
      name: 'signaling-core 가 조립을 import',
      rule: 'import-direction',
      files: { 'signaling-core/rules.ts': "import { start } from '../signaling-selfhost/index.js';\nexport const y = start;\n" },
    },
    {
      name: 'Lambda 조립 파일이 클라이언트 모듈을 import',
      rule: 'import-direction',
      files: { 'entry/lambda.ts': "import { lib } from '../mesh/index.js';\nexport const handler = lib;\n" },
    },
    {
      name: '제품 코드가 protocol 의 testing.ts 를 import',
      rule: 'import-testing',
      files: { 'inbox/queue.ts': "import { defineSubscribableContractTests } from '../protocol/testing.js';\nexport const y = defineSubscribableContractTests;\n" },
    },
    {
      name: '시험 파일이 protocol 의 내부 파일을 import',
      rule: 'import-internal',
      files: { 'inbox/inbox.test.ts': "import { LIMITS } from '../protocol/limits.js';\nexport const y = LIMITS;\n" },
    },
    {
      name: '조립이 아닌 모듈이 로거를 만드는 계약을 import',
      rule: 'import-internal',
      files: { 'mesh/util.ts': "import type { CreateFileLogger } from '../diagnostics/contract.js';\nexport type Y = CreateFileLogger;\n" },
    },
    {
      name: '제품 코드가 testing.ts 를 import',
      rule: 'import-testing',
      files: { 'signaling-aws/handler.ts': "import { define } from '../signaling-core/testing.js';\nexport const y = define;\n" },
    },
    {
      name: 'src 밖(tests/support)을 import',
      rule: 'import-outside',
      files: { 'mesh/mesh.test.ts': "import { spawnNode } from '../../tests/support/proc.mjs';\nexport const y = spawnNode;\n" },
    },
    {
      name: '문자열이 아닌 동적 import',
      rule: 'import-dynamic',
      files: { 'mesh/native.ts': 'export const load = (name: string) => import(name);\n' },
    },
    {
      name: '외부 SDK 를 다른 모듈에서 import',
      rule: 'external-package',
      files: { 'room-session/join.ts': "import WebSocket from 'ws';\nexport const y = WebSocket;\n" },
    },
    {
      name: 'signaling-core 가 AWS SDK 를 import',
      rule: 'external-package',
      files: { 'signaling-core/rules.ts': "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nexport const y = DynamoDBClient;\n" },
    },
    {
      name: '의존성 목록 밖의 패키지',
      rule: 'external-package',
      files: { 'records/report.ts': "import { marked } from 'marked';\nexport const y = marked;\n" },
    },
    {
      name: '동적 import 로 외부 SDK 를 불러옴',
      rule: 'external-package',
      files: { 'inbox/queue.ts': "export const load = () => import('node-datachannel');\n" },
    },
    {
      name: '실행 모듈의 child_process',
      rule: 'builtin',
      files: { 'mcp-server/tools.ts': "import { exec } from 'node:child_process';\nexport const y = exec;\n" },
    },
    {
      name: 'node: 없이 쓴 child_process',
      rule: 'builtin',
      files: { 'room-session/join.ts': "import { spawn } from 'child_process';\nexport const y = spawn;\n" },
    },
    {
      name: 'require 로 부른 child_process',
      rule: 'builtin',
      files: { 'records/report.ts': "export const y = require('node:child_process');\n" },
    },
    {
      name: 'MCP 조립 파일의 child_process',
      rule: 'builtin',
      files: { 'entry/mcp.ts': "import { spawn } from 'node:child_process';\nexport const main = spawn;\n" },
    },
    {
      name: '설치 CLI 조립 파일의 child_process',
      rule: 'builtin',
      files: { 'entry/cli.ts': "import { spawn } from 'node:child_process';\nexport const main = spawn;\n" },
    },
    {
      name: 'setup 의 다른 파일이 프로세스를 실행',
      rule: 'builtin',
      files: { 'setup/doctor.ts': "import { execFile } from 'node:child_process';\nexport const run = (bin: string) => execFile(bin, ['--version']);\n" },
    },
    {
      name: 'import 없이 내장 모듈을 꺼냄',
      rule: 'builtin',
      files: { 'inbox/queue.ts': "export const net = () => process.getBuiltinModule('node:net');\n" },
    },
    {
      name: 'room-session 이 기록 파일을 직접 씀',
      rule: 'builtin',
      files: { 'room-session/events.ts': "import { appendFileSync } from 'node:fs';\nexport const w = (p: string, s: string) => appendFileSync(p, s);\n" },
    },
    {
      name: 'mesh 가 파일을 읽음',
      rule: 'builtin',
      files: { 'mesh/util.ts': "import { readFile } from 'node:fs/promises';\nexport const y = readFile;\n" },
    },
    {
      name: '전역 WebSocket 으로 서버에 글을 보냄',
      rule: 'network',
      files: { 'room-session/chat.ts': 'export const viaServer = (url: string, text: string) => { const ws = new WebSocket(url); ws.onopen = () => ws.send(text); };\n' },
    },
    {
      name: 'ws 를 쓰는 모듈에서 import 없이 쓴 WebSocket',
      rule: 'network',
      files: { 'signaling-client/socket.ts': 'export const open = (url: string) => new WebSocket(url);\n' },
    },
    {
      name: '전역 fetch',
      rule: 'network',
      files: { 'mcp-server/tools.ts': "export const post = (url: string, body: string) => fetch(url, { method: 'POST', body });\n" },
    },
    {
      name: '전역 EventSource',
      rule: 'network',
      files: { 'inbox/queue.ts': 'export const listen = (url: string) => new EventSource(url);\n' },
    },
    {
      name: 'inbox 가 node:net 소켓을 엶',
      rule: 'network',
      files: { 'inbox/queue.ts': "import { connect } from 'node:net';\nexport const open = (port: number) => connect(port);\n" },
    },
    {
      name: 'room-session 이 node:dgram 과 node:https 를 씀',
      rule: 'network',
      files: { 'room-session/p2p.ts': "import { createSocket } from 'node:dgram';\nimport { request } from 'node:https';\nexport const y = [createSocket, request];\n" },
    },
    {
      name: 'setup 이 직접 네트워크에 닿음',
      rule: 'network',
      files: { 'setup/doctor.ts': "import { get } from 'node:http';\nexport const y = get;\n" },
    },
    {
      name: '조립 파일이 직접 네트워크에 닿음',
      rule: 'network',
      files: { 'entry/server.ts': "import { createServer } from 'node:net';\nexport const main = createServer;\n" },
    },
    {
      name: 'MCP 프로세스 모듈의 console',
      rule: 'stdout',
      files: { 'mesh/attempt.ts': 'export const dbg = (x: string) => console.log(x);\n' },
    },
    {
      name: 'stdout 에 직접 쓰기',
      rule: 'stdout',
      files: { 'room-session/p2p.ts': 'export const dbg = (x: string) => process.stdout.write(x);\n' },
    },
    {
      name: 'mcp-server 가 stdout 에 직접 쓰기',
      rule: 'stdout',
      files: { 'mcp-server/tools.ts': "export const dbg = () => process.stdout.write('x');\n" },
    },
    {
      name: 'MCP 조립 파일의 console',
      rule: 'stdout',
      files: { 'entry/mcp.ts': "export const main = () => console.error('x');\n" },
    },
    {
      name: 'node:console',
      rule: 'stdout',
      files: { 'records/report.ts': "import { Console } from 'node:console';\nexport const y = Console;\n" },
    },
    {
      name: '서버 규칙 모듈의 console',
      rule: 'stdout',
      files: { 'signaling-core/rules.ts': "export const dbg = () => console.log('x');\n" },
    },
    {
      name: '모듈 최상위의 let (숨은 싱글턴)',
      rule: 'global-state',
      files: { 'mesh/state.ts': 'let current: unknown = null;\nexport const setMesh = (m: unknown) => { current = m; };\nexport const getMesh = () => current;\n' },
    },
    {
      name: '모듈 최상위의 export let',
      rule: 'global-state',
      files: { 'inbox/queue.ts': 'export let mode = "poll";\n' },
    },
    {
      name: '모듈 최상위의 var',
      rule: 'global-state',
      files: { 'records/report.ts': 'export const a = 1;\nvar cache = new Map<string, string>();\nexport const get = () => cache;\n' },
    },
    {
      name: '조립 파일의 최상위 let',
      rule: 'global-state',
      files: { 'entry/cli.ts': "let started = false;\nexport const main = () => { started = true; return started; };\n" },
    },
    {
      name: '전역 객체에 값을 둠',
      rule: 'global-state',
      files: { 'entry/mcp.ts': 'export const registry = new Map<string, unknown>();\n(globalThis as Record<string, unknown>).agentChat = registry;\n' },
    },
    {
      name: '전역 객체에서 타이머를 꺼냄',
      rule: 'global-state',
      files: { 'mesh/util.ts': 'export const later = (f: () => void) => globalThis.setTimeout(f, 10);\n' },
    },
    {
      name: 'I/O 없는 모듈의 파일 접근',
      rule: 'builtin',
      files: { 'shared-state/replica.ts': "import { readFileSync } from 'node:fs';\nexport const y = readFileSync;\n" },
    },
    {
      name: '제품 코드의 node:test',
      rule: 'builtin',
      files: { 'inbox/queue.ts': "import { mock } from 'node:test';\nexport const y = mock;\n" },
    },
    {
      name: 'mcp-server 가 process.env 를 직접 읽음',
      rule: 'env',
      files: { 'mcp-server/tools.ts': 'export const name = () => process.env.AGENT_CHAT_NAME;\n' },
    },
    {
      name: '?. 로 읽는 환경 변수',
      rule: 'env',
      files: { 'mesh/util.ts': 'export const ice = process?.env.AGENT_CHAT_ICE_SERVERS;\n' },
    },
    {
      name: 'MCP 조립 파일이 ?. 로 환경 변수 값을 읽음',
      rule: 'env',
      files: { 'entry/mcp.ts': 'export const name = process.env?.AGENT_CHAT_NAME;\n' },
    },
    {
      name: 'mcp-server 밖에서 환경 변수 읽기',
      rule: 'env',
      files: { 'room-session/join.ts': 'export const name = process.env.AGENT_CHAT_NAME;\n' },
    },
    {
      name: '대괄호로 읽는 환경 변수',
      rule: 'env',
      files: { 'mesh/util.ts': "export const ice = process['env']['AGENT_CHAT_ICE_SERVERS'];\n" },
    },
    {
      name: '구조 분해로 읽는 환경 변수',
      rule: 'env',
      files: { 'records/report.ts': 'const { env } = process;\nexport const home = env;\n' },
    },
    {
      name: 'MCP 조립 파일이 환경 변수 값을 직접 읽음',
      rule: 'env',
      files: { 'entry/mcp.ts': 'export const name = process.env.AGENT_CHAT_NAME;\n' },
    },
    {
      name: '서버 조립 파일이 환경 변수를 읽음',
      rule: 'env',
      files: { 'entry/server.ts': 'export const port = Number(process.env["PORT"]);\n' },
    },
    {
      name: '전역 시계',
      rule: 'clock',
      files: { 'inbox/queue.ts': 'export const stamp = () => Date.now();\n' },
    },
    {
      name: '인자 없는 new Date()',
      rule: 'clock',
      files: { 'records/report.ts': 'export const stamp = () => new Date().toISOString();\n' },
    },
    {
      name: '전역 타이머',
      rule: 'clock',
      files: { 'mesh/util.ts': 'export const later = (f: () => void) => setTimeout(f, 10);\n' },
    },
    {
      name: 'node:timers',
      rule: 'clock',
      files: { 'signaling-client/loop.ts': "import { setTimeout as sleep } from 'node:timers/promises';\nexport const y = sleep;\n" },
    },
    {
      name: '숨은 타이머 AbortSignal.timeout',
      rule: 'clock',
      files: { 'signaling-client/loop.ts': 'export const deadline = (ms: number) => AbortSignal.timeout(ms);\n' },
    },
    {
      name: '숨은 시계 process.hrtime',
      rule: 'clock',
      files: { 'inbox/queue.ts': 'export const stamp = () => process.hrtime.bigint();\n' },
    },
    {
      name: '숨은 시계 process.uptime',
      rule: 'clock',
      files: { 'mesh/util.ts': 'export const stamp = () => process.uptime();\n' },
    },
    {
      name: '숨은 시계 performance.now',
      rule: 'clock',
      files: { 'mesh/util.ts': 'export const stamp = () => performance.now();\n' },
    },
    {
      name: '구조 분해로 꺼낸 Date.now',
      rule: 'clock',
      files: { 'records/report.ts': 'const { now } = Date;\nexport const stamp = () => now();\n' },
    },
    {
      name: '다른 이름으로 받은 Date',
      rule: 'clock',
      files: { 'records/report.ts': 'const Clock = Date;\nexport const stamp = () => new Clock(0);\n' },
    },
    {
      name: 'new 없는 Date()',
      rule: 'clock',
      files: { 'records/report.ts': 'export const stamp = () => Date();\n' },
    },
    {
      name: 'diagnostics 의 전역 시계',
      rule: 'clock',
      files: { 'diagnostics/file-logger.ts': 'export const stamp = () => Date.now();\n' },
    },
    {
      name: 'diagnostics 의 전역 주기 타이머',
      rule: 'clock',
      files: { 'diagnostics/file-logger.ts': 'export const tick = (f: () => void) => setInterval(f, 3600000);\n' },
    },
    {
      name: '자체 호스팅 조립 모듈의 전역 타이머',
      rule: 'clock',
      files: { 'signaling-selfhost/sweep.ts': 'export const tick = (f: () => void) => setInterval(f, 30000);\n' },
    },
    {
      name: 'Lambda 조립 모듈의 전역 시계',
      rule: 'clock',
      files: { 'signaling-aws/handler.ts': 'export const stamp = () => Date.now();\n' },
    },
    {
      name: 'setup 의 전역 시계',
      rule: 'clock',
      files: { 'setup/doctor.ts': 'export const stamp = () => Date.now();\n' },
    },
    {
      name: '괄호 없는 new Date',
      rule: 'clock',
      files: { 'inbox/queue.ts': 'export const stamp = () => +new Date;\n' },
    },
    {
      name: '괄호로 감싼 new Date',
      rule: 'clock',
      files: { 'inbox/queue.ts': 'export const stamp = () => (new Date).getTime();\n' },
    },
    {
      name: '빈 괄호 사이에 공백을 둔 new Date',
      rule: 'clock',
      files: { 'records/report.ts': 'export const stamp = () => new Date ( ).toISOString();\n' },
    },
    {
      name: 'createRequire 로 네트워크 모듈을 부름',
      rule: 'builtin',
      files: { 'room-session/p2p.ts': "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport const open = (host: string, text: string) => { const net = load('node:net'); net.connect(443, host).end(text); };\n" },
    },
    {
      name: 'createRequire 로 child_process 를 부름',
      rule: 'builtin',
      files: { 'mcp-server/tools.ts': "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport const run = (cmd: string) => load('node:child_process').execSync(cmd);\n" },
    },
    {
      name: 'createRequire 로 외부 SDK 를 부름',
      rule: 'builtin',
      files: { 'inbox/queue.ts': "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport const ws = () => load('ws');\n" },
    },
    {
      name: '조립 파일의 createRequire',
      rule: 'builtin',
      files: { 'entry/mcp.ts': "import { createRequire } from 'node:module';\nexport const main = createRequire(import.meta.url)('node:child_process');\n" },
    },
    {
      name: '다른 이름으로 받은 process 로 env·stdout·시계를 씀',
      rule: 'builtin',
      files: { 'inbox/queue.ts': "import proc from 'node:process';\nexport const a = () => [proc.env['HOME'], proc.stdout.write('x'), proc.hrtime.bigint()];\n" },
    },
    {
      name: '조립 파일이 process 를 다른 이름으로 받음',
      rule: 'builtin',
      files: { 'entry/server.ts': "import * as proc from 'node:process';\nexport const port = () => proc.env['PORT'];\n" },
    },
    {
      name: 'node:inspector 로 디버그 포트를 엶',
      rule: 'builtin',
      files: { 'records/report.ts': "import { open } from 'node:inspector';\nexport const a = () => open(9229, '0.0.0.0');\n" },
    },
    {
      name: 'node:vm 으로 글을 코드로 실행',
      rule: 'builtin',
      files: { 'records/report.ts': "import { runInThisContext } from 'node:vm';\nexport const a = (text: string) => runInThisContext(text);\n" },
    },
    {
      name: 'node:dns 로 글을 내보냄',
      rule: 'builtin',
      files: { 'room-session/p2p.ts': "import { resolveTxt } from 'node:dns/promises';\nexport const q = (text: string) => resolveTxt(text + '.example.com');\n" },
    },
    {
      name: 'perf_hooks 의 시계를 다른 이름으로 받음',
      rule: 'builtin',
      files: { 'mesh/util.ts': "import { performance as perf } from 'node:perf_hooks';\nexport const stamp = () => perf.now();\n" },
    },
    {
      name: 'node: 없이 쓴 목록 밖 내장 모듈',
      rule: 'builtin',
      files: { 'signaling-selfhost/sweep.ts': "import repl from 'repl';\nexport const y = repl;\n" },
    },
    {
      name: '설치 CLI 조립 파일의 목록 밖 내장 모듈',
      rule: 'builtin',
      files: { 'entry/cli.ts': "import { createInterface } from 'node:readline';\nexport const main = createInterface;\n" },
    },
    {
      name: 'mcp-server 가 SDK 의 클라이언트 stdio 로 프로세스를 띄움',
      rule: 'external-package',
      files: { 'mcp-server/tools.ts': "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';\nexport const launch = (command: string, args: string[]) => new StdioClientTransport({ command, args });\n" },
    },
    {
      name: 'mcp-server 가 SDK 의 HTTP 전송을 씀',
      rule: 'external-package',
      files: { 'mcp-server/tools.ts': "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';\nexport const t = StreamableHTTPServerTransport;\n" },
    },
    {
      name: 'mcp-server 가 SDK 의 SSE 전송과 인증 라우터를 씀',
      rule: 'external-package',
      files: { 'mcp-server/tools.ts': "import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';\nimport { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';\nexport const t = [SSEServerTransport, mcpAuthRouter];\n" },
    },
    {
      name: 'mcp-server 가 SDK 의 클라이언트를 씀',
      rule: 'external-package',
      files: { 'mcp-server/tools.ts': "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nexport const t = Client;\n" },
    },
    {
      name: 'setup 의 다른 파일이 SDK 로 프로세스를 띄움',
      rule: 'external-package',
      files: { 'setup/doctor.ts': "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';\nexport const spawnAgent = () => new StdioClientTransport({ command: 'claude', args: ['-p', 'do something'] });\n" },
    },
    {
      name: 'setup 이 SDK 의 네트워크 전송을 씀',
      rule: 'external-package',
      files: { 'setup/doctor.ts': "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';\nimport { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';\nexport const t = [StreamableHTTPClientTransport, WebSocketClientTransport];\n" },
    },
    {
      name: 'setup 이 SDK 의 서버 쪽을 씀',
      rule: 'external-package',
      files: { 'setup/doctor.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport const t = McpServer;\n" },
    },
    {
      name: 'mesh 가 node-datachannel 의 polyfill 을 씀',
      rule: 'external-package',
      files: { 'mesh/util.ts': "import { RTCPeerConnection } from 'node-datachannel/polyfill';\nexport const make = () => new RTCPeerConnection();\n" },
    },
    {
      name: 'mesh 시험이 polyfill 을 씀',
      rule: 'external-package',
      files: { 'mesh/polyfill.test.ts': "import { RTCPeerConnection } from 'node-datachannel/polyfill';\nexport const t = RTCPeerConnection;\n" },
    },
    {
      name: 'TURN 주소',
      rule: 'relay',
      files: { 'mesh/util.ts': "export const servers = ['turn:relay.example.com:3478'];\n" },
    },
    {
      name: 'TURN 서버 설정 항목',
      rule: 'relay',
      files: { 'mcp-server/config.ts': 'export interface C { turnServer?: string; turnPassword?: string }\n' },
    },
    {
      name: '중계 종류 옵션',
      rule: 'relay',
      files: { 'mesh/util.ts': "export const options = { relayType: 'TurnUdp' };\n" },
    },
    {
      name: 'TURN 환경 변수',
      rule: 'relay',
      files: { 'mcp-server/config.ts': "export const names = ['AGENT_CHAT_TURN_URL'];\n" },
    },
    {
      name: '채팅을 다른 참가자를 거쳐 보내는 이름',
      rule: 'relay',
      files: { 'room-session/chat.ts': 'export const relayChat = (via: string) => via;\n' },
    },
    {
      name: '받은 채팅 넘기기',
      rule: 'relay',
      files: { 'room-session/p2p.ts': 'export const forwardChat = (to: string) => to;\n' },
    },
    {
      name: 'permission relay capability',
      rule: 'permission',
      files: { 'mcp-server/server.ts': "export const caps = { experimental: { 'claude/channel/permission': {} } };\n" },
    },
    {
      name: '호스트를 다른 권한으로 띄우는 실행 옵션',
      rule: 'permission',
      files: { 'setup/host-cli.ts': "import { execFile } from 'node:child_process';\nexport const run = (bin: string, id: string) => execFile(bin, ['-p', '--resume', id, '--dangerously-skip-permissions']);\n" },
    },
    {
      name: '승인 모드를 바꾸는 실행 옵션',
      rule: 'permission',
      files: { 'setup/register.ts': "export const flags = ['--permission-mode', 'bypassPermissions'];\n" },
    },
    {
      name: 'room-session 의 다른 파일이 시그널에 글을 실음',
      rule: 'signal-chat',
      files: { 'room-session/delivery.ts': "import type { SendSignal } from '../mesh/contract.js';\nexport const send = (sendSignal: SendSignal, to: string) => sendSignal(to);\n" },
    },
    {
      name: 'room-session 의 다른 파일이 클라이언트의 시그널 전송을 부름',
      rule: 'signal-chat',
      files: { 'room-session/join.ts': "import type { SignalingClient } from '../signaling-client/contract.js';\nexport const enter = (client: SignalingClient) => client.sendSignal('b');\n" },
    },
    {
      name: '대괄호로 꺼낸 시그널 전송 함수',
      rule: 'signal-chat',
      files: { 'room-session/p2p.ts': "export const pick = (client: Record<string, unknown>) => client['sendSignal'];\n" },
    },
    {
      name: 'mcp-server 가 시그널 전송 함수를 다룸',
      rule: 'signal-chat',
      files: { 'mcp-server/tools.ts': 'export const send = (client: { sendSignal(to: string): boolean }) => client.sendSignal;\n' },
    },
    {
      name: '채팅 전달 부분이 시그널 전송 함수를 씀',
      rule: 'signal-chat',
      files: { 'room-session/chat.ts': 'export const send = (sendSignal: (to: string) => boolean) => sendSignal;\n' },
    },
    {
      name: '계약 파일의 실행 코드',
      rule: 'contract-types-only',
      files: { 'inbox/contract.ts': 'export interface Inbox { push(): void }\nexport const DEFAULT_LIMITS = { max: 1000 };\n' },
    },
    {
      name: '모르는 모듈 폴더',
      rule: 'layout',
      files: { 'relay-server/index.ts': 'export const x = 1;\n' },
    },
    {
      name: 'src 바로 아래의 제품 코드',
      rule: 'layout',
      files: { 'helpers.ts': 'export const x = 1;\n' },
    },
    {
      name: '정해지지 않은 조립 파일',
      rule: 'layout',
      files: { 'entry/daemon.ts': 'export const x = 1;\n' },
    },
  ];

  for (const { name, rule, files } of cases) {
    it(`잡는다: ${name}`, () => {
      const violations = check({ ...ok, ...files });
      const rules = [...new Set(violations.map((violation) => violation.rule))];
      assert.deepEqual(rules, [rule], describeViolations(violations));
      for (const violation of violations) assert.ok(Object.keys(files).includes(violation.file), violation.file);
    });
  }

  it('호스트 CLI 실행 파일에 시험이 없으면 잡는다', () => {
    const files = { ...ok };
    delete files['setup/host-cli.test.ts'];
    const violations = check(files);
    assert.deepEqual(violations.map((v) => [v.rule, v.file]), [['layout', 'setup/host-cli.ts']]);
  });

  it('MCP 프로세스를 띄우는 파일에 시험이 없으면 잡는다', () => {
    const files = { ...ok };
    delete files['setup/mcp-process.test.ts'];
    const violations = check(files);
    assert.deepEqual(violations.map((v) => [v.rule, v.file]), [['layout', 'setup/mcp-process.ts']]);
  });

  it('인자가 있는 new Date 와 Date 의 다른 쓰임은 시계 위반이 아니다', () => {
    const source = [
      'export type Stamp = Date;',
      'export const a = (now: () => number) => new Date(now()).toISOString();',
      "export const b = () => new Date('2026-01-01T00:00:00Z').getTime();",
      'export const c = (ms: number) => new Date( ms );',
      'export const d = (v: unknown) => v instanceof Date;',
      'export const e = () => Date.UTC(2026, 0, 1);',
      'export class DateRange { constructor(readonly from: Date) {} }',
      'export const f = (from: Date) => new DateRange(from);',
    ].join('\n');
    assert.equal(describeViolations(check({ ...ok, 'records/dates.ts': `${source}\n` })), '');
  });

  it('최상위 let·var 만 잡는다. 함수 안의 것과 최상위 반복문의 것은 잡지 않는다', () => {
    const source = [
      'const a = 1;',
      'for (let i = 0; i < 2; i += 1) { let inner = i; void inner; }',
      'export function f() { let x = 0; var y = 1; return x + y; }',
      'const t = `${(() => { let z = 1; return z; })()}`;',
      'const obj = { let: 1, var: 2 }; void obj.let;',
      'let top = 0;',
      'export var legacy = 1;',
      'let { p, q } = { p: 1, q: 2 };',
    ].join('\n');
    const lines = topLevelMutableBindings(scanSource(source).bare).map((index) => source.slice(0, index).split('\n').length);
    assert.deepEqual(lines, [6, 7, 8]);
  });

  it('턴 수를 세는 필드 이름은 TURN 주소가 아니다', () => {
    const files = { ...ok, 'inbox/stats.ts': 'export interface Stats { turns: number; turn: string }\nexport const s: Stats = { turns: 1, turn: "x" };\n' };
    assert.equal(describeViolations(check(files)), '');
    assert.deepEqual(rulesOf({ ...ok, 'inbox/stats.ts': 'export const url = `turns:${"host"}`;\n' }), ['relay']);
  });

  it('주석과 시험 파일의 같은 글자는 위반으로 세지 않는다', () => {
    const files = {
      ...ok,
      'mesh/util.ts': [
        '// turn: 주소와 process.env, Date.now(), setTimeout( 은 쓰지 않는다',
        "/* import { x } from '../signaling-client/internal.js' */",
        'export const note = 1;',
      ].join('\n'),
      'mesh/filter.test.ts': "export const samples = ['turn:example.com', 'claude/channel/permission', Date.now()];\n",
    };
    assert.equal(describeViolations(check(files)), '');
  });

  it('위반한 줄 번호를 알려 준다', () => {
    const violations = check({ ...ok, 'inbox/queue.ts': 'export const a = 1;\n\nexport const b = () => Date.now();\n' });
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.file, 'inbox/queue.ts');
    assert.equal(violations[0]?.line, 3);
  });
});

describe('V-U8 검사기 자체 시험: src 밖의 설정과 스크립트', () => {
  const extra = (files: Record<string, string>): Violation[] => analyzeExtra(new Map(Object.entries(files)));

  const clean: Record<string, string> = {
    'deployments/aws/template.yaml': 'Parameters:\n  ThrottleBurst:\n    Type: Number\nOutputs:\n  Url:\n    Value: !Sub wss://${Api}.execute-api.${AWS::Region}.amazonaws.com/prod\n',
    'deployments/aws/deploy.sh': '#!/bin/sh\nset -eu\n# 스택 이름을 인자로 받는다\naws cloudformation deploy --stack-name "$1"\n',
    'deployments/self-host/agent-chat.service': '[Service]\nRestart=on-failure\nExecStart=/usr/bin/node dist/entry/server.js --port 8787\n',
    'scripts/install.mjs': "// turn: 주소는 받지 않는다\nconst ice = 'stun:stun.l.google.com:19302';\nconst stats = { turns: 1 };\nexport { ice, stats };\n",
    'installer/install.sh': '#!/bin/sh\nset -eu\nexec "$NODE" scripts/install.mjs --client all\n',
  };

  it('규칙을 지킨 묶음은 위반이 없다', () => {
    assert.equal(describeViolations(extra(clean), ''), '');
  });

  const cases: readonly { readonly name: string; readonly rule?: string; readonly files: Record<string, string> }[] = [
    {
      name: '셸 진입점이 호스트를 권한 확인 없이 띄움',
      rule: 'permission',
      files: { 'installer/claude.sh': '#!/bin/sh\nset -eu\nclaude --dangerously-skip-permissions -p "join the room and keep waiting"\n' },
    },
    {
      name: '설치 스크립트가 호스트를 승인·샌드박스 없이 띄움',
      rule: 'permission',
      files: { 'scripts/install.mjs': "import { execFileSync } from 'node:child_process';\nexecFileSync('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', 'resume']);\n" },
    },
    {
      name: '설치 스크립트의 승인 모드 옵션',
      rule: 'permission',
      files: { 'scripts/install.mjs': "export const flags = ['--permission-mode', 'bypassPermissions'];\n" },
    },
    {
      name: '셸 진입점의 허용 목록 옵션',
      rule: 'permission',
      files: { 'installer/install.sh': '#!/bin/sh\nexec claude --allowedTools "mcp__agent-chat__*"\n' },
    },
    {
      name: '서비스 유닛의 전체 자동 승인 옵션',
      rule: 'permission',
      files: { 'deployments/self-host/agent-chat.service': '[Service]\nExecStart=/usr/bin/codex exec --full-auto\n' },
    },
    {
      name: '설치 스크립트의 permission relay capability',
      rule: 'permission',
      files: { 'scripts/install.mjs': "export const caps = { experimental: { 'claude/channel/permission': {} } };\n" },
    },
    { name: '배포 템플릿의 TURN 서버 인자', files: { 'deployments/aws/template.yaml': 'Parameters:\n  TurnServerUrl:\n    Type: String\n' } },
    { name: '배포 템플릿의 TURN 주소', files: { 'deployments/aws/template.yaml': 'Environment:\n  ICE: turn:relay.example.com:3478\n' } },
    { name: '배포 템플릿의 TURN 환경 변수', files: { 'deployments/aws/template.yaml': 'Environment:\n  AGENT_CHAT_TURN_URL: x\n' } },
    { name: '서비스 유닛의 중계 강제 옵션', files: { 'deployments/self-host/agent-chat.service': 'Environment=ICE_TRANSPORT_POLICY=relay\n' } },
    { name: '설치 스크립트 문자열의 TURN 주소', files: { 'scripts/install.mjs': "export const ice = 'turns:relay.example.com:5349';\n" } },
    { name: '설치 스크립트의 TURN 자격 증명 이름', files: { 'scripts/install.mjs': 'export const turnPassword = process.argv[2];\n' } },
    { name: '셸 진입점의 TURN 환경 변수', files: { 'installer/install.sh': '#!/bin/sh\nexport AGENT_CHAT_RELAY_SERVER=x\n' } },
    { name: '셸 진입점의 TURN 주소', files: { 'installer/codex.sh': '#!/bin/sh\nICE="turn:relay.example.com"\n' } },
  ];

  for (const { name, rule = 'relay', files } of cases) {
    it(`잡는다: ${name}`, () => {
      const violations = extra({ ...clean, ...files });
      assert.ok(violations.length > 0, '잡지 못했다');
      assert.deepEqual([...new Set(violations.map((violation) => violation.rule))], [rule]);
      for (const violation of violations) assert.ok(Object.keys(files).includes(violation.file), violation.file);
    });
  }

  it('안내 문서와 시험 파일은 보지 않는다', () => {
    const files = {
      ...clean,
      'deployments/self-host/README.md': 'TURN 은 쓰지 않는다. `turn:relay.example.com` 같은 주소를 주면 거절한다. `--dangerously-skip-permissions` 로 띄우지 않는다.\n',
      'installer/install.test.mjs': "export const rejected = ['turn:relay.example.com', '--dangerously-skip-permissions'];\n",
    };
    assert.equal(describeViolations(extra(files), ''), '');
  });

  it('스크립트의 주석은 보지 않고, 셸은 주석까지 본다', () => {
    const script = { ...clean, 'scripts/install.mjs': '// --dangerously-skip-permissions 로 띄우지 않는다\nexport const ok = 1;\n' };
    assert.equal(describeViolations(extra(script), ''), '');
    const shell = { ...clean, 'installer/install.sh': '#!/bin/sh\n# claude --dangerously-skip-permissions\n' };
    assert.deepEqual(extra(shell).map((violation) => [violation.rule, violation.file, violation.line]), [['permission', 'installer/install.sh', 2]]);
  });

  it('설치가 안내하는 등록 명령과 개발 채널 플래그는 권한 옵션이 아니다', () => {
    const files = {
      ...clean,
      'scripts/install.mjs': [
        "export const GUIDE = [",
        "  'claude mcp add --scope user agent-chat -e AGENT_CHAT_NAME=x -- node dist/entry/mcp.js',",
        "  'codex mcp add agent-chat --env AGENT_CHAT_CHANNEL=off -- node dist/entry/mcp.js',",
        "  'claude --dangerously-load-development-channels server:agent-chat',",
        "  'tool_timeout_sec = 600',",
        '];',
      ].join('\n'),
    };
    assert.equal(describeViolations(extra(files), ''), '');
  });

  it('읽지 못한 스크립트는 알린다', () => {
    assert.deepEqual(
      extra({ 'scripts/install.mjs': "export const a = 'open\n" }).map((violation) => violation.rule),
      ['scan'],
    );
  });
});
