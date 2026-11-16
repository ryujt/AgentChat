// API Gateway WebSocket 이벤트를 signaling-core 호출로 바꾼다 (architecture.md 3.4, deployment.md 2.2~2.3).
// 함수 하나가 세 라우트를 받고 requestContext.eventType 으로 가린다.
//   CONNECT    Origin 헤더가 있으면 403, 없으면 200. 저장도 전송도 하지 않는다.
//   MESSAGE    본문을 core.onMessage 에 넘긴다.
//   DISCONNECT core.onDisconnect.
// 호출 사이에 메모리 상태를 믿지 않는다. 남겨 두는 것은 SDK 클라이언트(와 그것을 잡은 core)뿐이다.

import type { ServerLogPort } from '../diagnostics/log-port.js';
import { refOf } from '../protocol/index.js';
import type { Now } from '../protocol/index.js';
import { createSignalingCore } from '../signaling-core/index.js';
import type { SignalingCore } from '../signaling-core/index.js';
import type { ManagementOps } from './apigw-sink.js';
import { createApiGatewaySink } from './apigw-sink.js';
import { createDynamoOps, createManagementOps, managementEndpoint } from './aws-clients.js';
import { readLambdaConfig, readLogLevel } from './config.js';
import type { LambdaEnv } from './config.js';
import type { DynamoOps } from './dynamo-store.js';
import { createDynamoRoomStore } from './dynamo-store.js';

/** AWS 에 닿는 두 길. 생략하면 실제 SDK 클라이언트를 만든다. 시험은 가짜를 준다. */
export interface AwsPorts {
  dynamo(region: string): DynamoOps;
  management(endpoint: string, region: string): ManagementOps;
}

export interface LambdaHandlerDeps {
  readonly now: Now;
  /** 서버 로그다. 참가자 이름과 연결 ID 는 해시로만 남긴다. */
  readonly log: ServerLogPort;
  /** Lambda 환경 변수. 생략하면 process.env 다. */
  readonly env?: LambdaEnv;
  readonly aws?: AwsPorts;
}

export interface LambdaResult {
  readonly statusCode: number;
}

/** Lambda 진입점. 이벤트는 게이트웨이가 주는 값이라 모양을 믿지 않고 읽는다. reject 하지 않는다. */
export type LambdaHandler = (event: unknown) => Promise<LambdaResult>;

const OK: LambdaResult = Object.freeze({ statusCode: 200 });
const FORBIDDEN: LambdaResult = Object.freeze({ statusCode: 403 });

const realAws: AwsPorts = { dynamo: createDynamoOps, management: createManagementOps };

type EventType = 'CONNECT' | 'MESSAGE' | 'DISCONNECT';

interface Incoming {
  readonly eventType: EventType;
  readonly connectionId: string;
  readonly apiId: string;
  readonly stage: string;
  readonly hasOrigin: boolean;
  /**
   * 텍스트 프레임의 본문. 바이너리 프레임과 본문 없는 이벤트는 빈 문자열이다(core 가 BAD_MESSAGE 로 답한다).
   * 바이너리 프레임은 API Gateway 가 1003 으로 닫아 여기 오지 않는다(실측 W2). 혹시 오면 위처럼 막는다.
   */
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 헤더 이름은 대소문자를 가리지 않는다. 값이 비어 있어도 헤더가 있으면 있는 것이다. */
function hasHeader(headers: unknown, name: string): boolean {
  return isRecord(headers) && Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function readEvent(event: unknown): Incoming | null {
  if (!isRecord(event) || !isRecord(event['requestContext'])) return null;
  const context = event['requestContext'];
  const { eventType, connectionId, apiId, stage } = context;
  if (eventType !== 'CONNECT' && eventType !== 'MESSAGE' && eventType !== 'DISCONNECT') return null;
  if (typeof connectionId !== 'string' || connectionId === '' || typeof apiId !== 'string' || typeof stage !== 'string') return null;
  const body = event['body'];
  return {
    eventType,
    connectionId,
    apiId,
    stage,
    hasOrigin: hasHeader(event['headers'], 'origin') || hasHeader(event['multiValueHeaders'], 'origin'),
    text: event['isBase64Encoded'] === true || typeof body !== 'string' ? '' : body,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error && typeof error.name === 'string' && error.name !== '' ? error.name : 'Error';
}

/**
 * Lambda 핸들러를 만든다. 필수 환경 변수(TABLE_NAME, AWS_REGION)가 잘못됐으면 여기서 던진다.
 * 돌려준 함수는 Origin 거절(403)을 빼고 항상 200 을 돌려준다. 게이트웨이가 오류 프레임을 클라이언트에 보내지 않게 한다.
 */
export function createLambdaHandler(deps: LambdaHandlerDeps): LambdaHandler {
  const { now, log } = deps;
  const env = deps.env ?? process.env;
  const aws = deps.aws ?? realAws;
  const config = readLambdaConfig(env);
  if (readLogLevel(env).invalid) log.event('warn', 'signaling-aws', 'config.problem', { name: 'LOG_LEVEL', reason: 'invalid' });

  const store = createDynamoRoomStore({ ops: aws.dynamo(config.region), tableName: config.tableName, now });

  // 연결 관리 API 의 주소는 이벤트가 와야 안다(apiId, stage). 주소가 같은 동안 클라이언트를 다시 쓴다.
  const reuse: { endpoint: string; core: SignalingCore | null } = { endpoint: '', core: null };
  const coreFor = (endpoint: string): SignalingCore => {
    if (reuse.core === null || reuse.endpoint !== endpoint) {
      const sink = createApiGatewaySink(aws.management(endpoint, config.region));
      reuse.endpoint = endpoint;
      reuse.core = createSignalingCore({ store, sink, now, log });
    }
    return reuse.core;
  };

  return async function handler(event) {
    const incoming = readEvent(event);
    if (incoming === null) {
      log.event('error', 'signaling-aws', 'event.invalid', { reason: 'shape' });
      return OK;
    }
    const conn_ref = refOf(incoming.connectionId);

    if (incoming.eventType === 'CONNECT') {
      // 판단만 한다. 이 단계에서는 그 연결로 보낼 수 없고(410), 거절한 연결에는 종료 통지가 오지 않아 저장한 항목이 남는다.
      if (incoming.hasOrigin) {
        log.event('info', 'signaling-aws', 'conn.refused', { conn_ref, reason: 'origin', error_code: String(FORBIDDEN.statusCode) });
        return FORBIDDEN;
      }
      return OK;
    }

    try {
      const endpoint = managementEndpoint(incoming.apiId, config.region, incoming.stage);
      if (endpoint === null) {
        log.event('error', 'signaling-aws', 'event.invalid', { conn_ref, reason: 'endpoint' });
        return OK;
      }
      const core = coreFor(endpoint);
      if (incoming.eventType === 'MESSAGE') await core.onMessage(incoming.connectionId, incoming.text);
      else await core.onDisconnect(incoming.connectionId);
    } catch (error) {
      // core 는 예상 가능한 실패로 reject 하지 않는다. 여기 오는 것은 결함이다. 그래도 200 을 돌려준다.
      log.event('error', 'signaling-aws', 'handler.failed', { conn_ref, kind: incoming.eventType, reason: errorName(error) });
    }
    return OK;
  };
}
