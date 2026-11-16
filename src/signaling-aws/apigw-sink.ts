// 공용 조립의 ConnectionSink 구현 (architecture.md 3.4, deployment.md 2.2). API Gateway 연결 관리 API 다.
// 응답과 전달이 모두 이 길로 나간다. 그 연결이 없다는 것(HTTP 410)과 스로틀(HTTP 429)을 결과로 바꾸고, 그 밖의 실패는 던진다.

import type { ConnectionSink } from '../signaling-core/index.js';

/**
 * 연결 관리 API 의 연산 셋(PostToConnection, GetConnection, DeleteConnection).
 * 실물은 SDK 클라이언트를 감싼 것(aws-clients.ts)이고 시험은 가짜(testing.ts)다.
 * 연결이 없으면 이름이 GoneException 이거나 HTTP 상태가 410 인 오류로 reject 한다.
 */
export interface ManagementOps {
  post(connectionId: string, data: string): Promise<void>;
  /** 연결이 열려 있으면 resolve 한다. 돌려주는 값(접속 주소 등)은 쓰지 않는다. */
  get(connectionId: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

const GONE_STATUS = 410;
const THROTTLED_STATUS = 429;
/** 스로틀을 뜻하는 오류 이름. 스테이지 스로틀은 연결 관리 API 의 POST 에도 걸린다(deployment.md 2.5 관찰 3). */
const THROTTLED_NAMES: ReadonlySet<string> = new Set(['LimitExceededException', 'TooManyRequestsException', 'ThrottlingException']);

type Shaped = { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;

function isGone(error: unknown): boolean {
  const shaped = error as Shaped;
  return shaped?.name === 'GoneException' || shaped?.$metadata?.httpStatusCode === GONE_STATUS;
}

function isThrottled(error: unknown): boolean {
  const shaped = error as Shaped;
  return shaped?.$metadata?.httpStatusCode === THROTTLED_STATUS || (typeof shaped?.name === 'string' && THROTTLED_NAMES.has(shaped.name));
}

export function createApiGatewaySink(ops: ManagementOps): ConnectionSink {
  return {
    async send(connId, text) {
      try {
        await ops.post(connId, text);
        return 'ok';
      } catch (error) {
        if (isGone(error)) return 'gone';
        if (isThrottled(error)) return 'throttled';
        throw error;
      }
    },

    async isOpen(connId) {
      try {
        await ops.get(connId);
        return true;
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }
    },

    async close(connId) {
      try {
        await ops.delete(connId);
      } catch (error) {
        // 이미 없으면 아무 일이 없다.
        if (!isGone(error)) throw error;
      }
    },
  };
}
