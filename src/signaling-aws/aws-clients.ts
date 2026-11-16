// AWS SDK 클라이언트를 만드는 곳. 이 모듈에서 SDK 객체를 만드는 파일은 이것 하나다.
// 번들에서는 `@aws-sdk/*` 를 외부로 두고 Lambda 런타임의 내장 SDK 를 쓴다(deployment.md 2.3).
// 로컬에서는 devDependency 의 같은 패키지를 쓴다(`npm run test:store`).

import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GetConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ManagementOps } from './apigw-sink.js';
import type { DynamoOps } from './dynamo-store.js';

/**
 * 호출 하나의 기한과 시도 횟수. 함수 제한 시간(10초) 안에 실패를 돌려받아 core 가 SERVER_ERROR 로 답하게 한다.
 * 기한이 없으면 멈춘 호출이 함수 제한 시간까지 가고, 클라이언트는 아무 답도 받지 못한다.
 */
const CALL_LIMITS = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 2_000, requestTimeout: 3_000, throwOnRequestTimeout: true },
} as const;

/**
 * 연결 관리 API 는 다시 시도하지 않는다. 스테이지 스로틀은 서버 → 클라이언트 POST 에도 걸리고(HTTP 429),
 * SDK 는 429 를 스로틀로 보고 500ms 뒤 한 번 더 보낸다. 스로틀 중에 요구량과 함수 실행 시간을 스스로 늘리는 셈이다.
 * 사라진 글은 클라이언트의 재전송(시그널 3초, join 1~3초, ping 5초)이 메운다(검토 1차 SERVER-R1-03).
 */
export const MANAGEMENT_CALL_LIMITS = { ...CALL_LIMITS, maxAttempts: 1 } as const;

/** 스테이지 이름과 API ID 는 주소에 들어간다. 게이트웨이가 주는 값이지만 형식을 본 뒤에 쓴다. */
const API_ID = /^[a-z0-9]{1,32}$/;
const STAGE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 연결 관리 API 의 주소. 사용자 지정 도메인이 아니라 execute-api 주소로 만든다(deployment.md 2.3).
 * 사용자 지정 도메인으로 들어온 연결의 이벤트에서도 apiId 와 stage 는 API 의 값이다. 형식이 틀리면 null.
 */
export function managementEndpoint(apiId: string, region: string, stage: string): string | null {
  if (!API_ID.test(apiId) || !STAGE.test(stage)) return null;
  return `https://${apiId}.execute-api.${region}.amazonaws.com/${stage}`;
}

export function createDynamoOps(region: string): DynamoOps {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, ...CALL_LIMITS }));
  return {
    get: (input) => client.send(new GetCommand(input)),
    put: (input) => client.send(new PutCommand(input)),
    update: (input) => client.send(new UpdateCommand(input)),
    delete: (input) => client.send(new DeleteCommand(input)),
    query: (input) => client.send(new QueryCommand(input)),
  };
}

export function createManagementOps(endpoint: string, region: string): ManagementOps {
  const client = new ApiGatewayManagementApiClient({ endpoint, region, ...MANAGEMENT_CALL_LIMITS });
  return {
    async post(connectionId, data) {
      await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
    },
    async get(connectionId) {
      // 응답에는 접속 주소(IP)가 든다. 읽지 않고 버린다.
      await client.send(new GetConnectionCommand({ ConnectionId: connectionId }));
    },
    async delete(connectionId) {
      await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    },
  };
}
