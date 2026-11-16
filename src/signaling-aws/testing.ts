// signaling-aws 의 시험 전용 대역. 제품 코드는 이 파일을 import 하지 않는다.
// SDK 연산 자리에 놓는 가짜다. DynamoDB 의 의미(조건식, 갱신식)를 흉내 내지 않는다.
// 그것은 배포한 테이블에 계약 묶음을 돌리는 `npm run test:store` 가 본다. 여기서는 부른 모양과 결과의 변환만 본다.

import type { LogLevel, LogModule, ServerLogFields, ServerLogPort } from '../diagnostics/log-port.js';
import type { ManagementOps } from './apigw-sink.js';
import type { DynamoOps } from './dynamo-store.js';

export type DynamoOpName = keyof DynamoOps;

export interface DynamoCall {
  readonly op: DynamoOpName;
  // 시험이 입력의 각 칸을 들여다본다. 모양은 SDK 의 입력 타입과 같다.
  readonly input: Record<string, any>;
}

type Responder = (input: Record<string, any>) => unknown;

export interface FakeDynamo extends DynamoOps {
  readonly calls: DynamoCall[];
  /** 그 연산의 답을 정한다. 던지면 reject 한다. 정하지 않은 연산은 빈 답을 돌려준다. */
  respond(op: DynamoOpName, responder: Responder): void;
  callsOf(op: DynamoOpName): Record<string, any>[];
}

export function createFakeDynamo(): FakeDynamo {
  const calls: DynamoCall[] = [];
  const responders = new Map<DynamoOpName, Responder>();
  const run = async (op: DynamoOpName, input: object): Promise<any> => {
    const recorded = input as Record<string, any>;
    calls.push({ op, input: recorded });
    const responder = responders.get(op);
    return responder === undefined ? { $metadata: {} } : { $metadata: {}, ...(responder(recorded) as object) };
  };
  return {
    calls,
    respond(op, responder) {
      responders.set(op, responder);
    },
    callsOf(op) {
      return calls.filter((call) => call.op === op).map((call) => call.input);
    },
    get: (input) => run('get', input),
    put: (input) => run('put', input),
    update: (input) => run('update', input),
    delete: (input) => run('delete', input),
    query: (input) => run('query', input),
  };
}

/** SDK 오류의 모양(이름과 HTTP 상태). */
export function sdkError(name: string, httpStatusCode?: number): Error {
  const error = new Error(`${name} (시험)`);
  error.name = name;
  if (httpStatusCode !== undefined) Object.assign(error, { $metadata: { httpStatusCode } });
  return error;
}

export interface FakeManagement extends ManagementOps {
  readonly posts: { connectionId: string; data: string }[];
  readonly gets: string[];
  readonly deletes: string[];
  /** 이 연결 ID 들은 닫힌 것으로 본다(410). */
  readonly gone: Set<string>;
  /** 정하면 post 가 이 오류로 reject 한다. */
  failPostWith: Error | null;
}

export function createFakeManagement(): FakeManagement {
  const fake: FakeManagement = {
    posts: [],
    gets: [],
    deletes: [],
    gone: new Set<string>(),
    failPostWith: null,
    async post(connectionId, data) {
      if (fake.failPostWith !== null) throw fake.failPostWith;
      if (fake.gone.has(connectionId)) throw sdkError('GoneException', 410);
      fake.posts.push({ connectionId, data });
    },
    async get(connectionId) {
      fake.gets.push(connectionId);
      if (fake.gone.has(connectionId)) throw sdkError('GoneException', 410);
    },
    async delete(connectionId) {
      fake.deletes.push(connectionId);
      if (fake.gone.has(connectionId)) throw sdkError('GoneException', 410);
      fake.gone.add(connectionId);
    },
  };
  return fake;
}

export interface LoggedEvent {
  readonly level: LogLevel;
  readonly module: LogModule;
  readonly event: string;
  readonly fields: ServerLogFields;
}

export function createLogRecorder(): ServerLogPort & { readonly events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return {
    events,
    event(level, module, event, fields = {}) {
      events.push({ level, module, event, fields });
    },
  };
}
