// Lambda 핸들러: 게이트웨이 이벤트를 core 호출로 바꾸는 부분(대역). SDK 자리에는 가짜를 둔다.
// 실제 게이트웨이와 테이블에 붙인 확인은 배포 뒤 verify.mjs(V-P1)가 한다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeClientMessage, newResumeKey, newRoomId, newSid } from '../protocol/index.js';
import type { ClientMessage } from '../protocol/index.js';
import { LambdaConfigError } from './config.js';
import { createLambdaHandler } from './handler.js';
import type { AwsPorts } from './handler.js';
import { createFakeDynamo, createFakeManagement, createLogRecorder, sdkError } from './testing.js';
import type { FakeDynamo, FakeManagement } from './testing.js';

const T0 = 1_800_000_000_000;
const API_ID = 'abc123defg';
const CONN = 'Ab12Cd34Ef56GhI=';
const ENV = { TABLE_NAME: 'agent-chat-signaling-table', AWS_REGION: 'ap-northeast-2' };
const ENDPOINT = `https://${API_ID}.execute-api.ap-northeast-2.amazonaws.com/prod`;

interface Setup {
  readonly handler: ReturnType<typeof createLambdaHandler>;
  readonly dynamo: FakeDynamo;
  readonly management: FakeManagement;
  readonly endpoints: string[];
  readonly regions: string[];
  readonly log: ReturnType<typeof createLogRecorder>;
}

function setup(env: Record<string, string> = ENV): Setup {
  const dynamo = createFakeDynamo();
  const management = createFakeManagement();
  const endpoints: string[] = [];
  const regions: string[] = [];
  // 빈 저장소처럼 답한다: 건수는 1, 등록 없음, 참가자 없음.
  dynamo.respond('update', (input) =>
    input['ReturnValues'] === 'ALL_NEW' ? { Attributes: { [input['ExpressionAttributeNames']['#window']]: 1 } } : {},
  );
  dynamo.respond('query', () => ({ Items: [] }));
  const aws: AwsPorts = {
    dynamo(region) {
      regions.push(region);
      return dynamo;
    },
    management(endpoint, region) {
      endpoints.push(endpoint);
      regions.push(region);
      return management;
    },
  };
  const log = createLogRecorder();
  const handler = createLambdaHandler({ now: () => T0, log, env, aws });
  return { handler, dynamo, management, endpoints, regions, log };
}

function event(eventType: 'CONNECT' | 'MESSAGE' | 'DISCONNECT', more: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return {
    requestContext: {
      routeKey: eventType === 'CONNECT' ? '$connect' : eventType === 'DISCONNECT' ? '$disconnect' : '$default',
      eventType,
      stage: 'prod',
      apiId: API_ID,
      connectionId: CONN,
      // 사용자 지정 도메인으로 들어온 연결이다. 연결 관리 API 주소는 이 값으로 만들지 않는다.
      domainName: 'agent-chat.tools.camp',
      requestId: 'req-1',
      identity: { sourceIp: '198.51.100.7' },
      ...context,
    },
    isBase64Encoded: false,
    ...more,
  };
}

const message = (value: ClientMessage) => {
  const encoded = encodeClientMessage(value);
  assert.ok(encoded.ok);
  return event('MESSAGE', { body: encoded.value });
};

const posted = (management: FakeManagement) => management.posts.map((post) => ({ to: post.connectionId, ...JSON.parse(post.data) }));

describe('Lambda 핸들러: $connect', () => {
  it('Origin 헤더가 없으면 200 이고 저장도 전송도 하지 않는다', async () => {
    const s = setup();
    assert.deepEqual(await s.handler(event('CONNECT', { headers: { Host: 'agent-chat.tools.camp' } })), { statusCode: 200 });
    assert.equal(s.dynamo.calls.length, 0);
    assert.equal(s.management.posts.length + s.management.gets.length + s.management.deletes.length, 0);
  });

  it('Origin 헤더가 있으면(대소문자 무관, 값이 비어도) 403 이고 저장도 전송도 하지 않는다', async () => {
    for (const headers of [{ Origin: 'https://example.com' }, { origin: '' }, { ORIGIN: 'null' }]) {
      const s = setup();
      assert.deepEqual(await s.handler(event('CONNECT', { headers })), { statusCode: 403 });
      assert.equal(s.dynamo.calls.length, 0);
      assert.equal(s.management.posts.length, 0);
      const refused = s.log.events.find((entry) => entry.event === 'conn.refused');
      assert.equal(refused?.fields.reason, 'origin');
      assert.equal(JSON.stringify(s.log.events).includes(CONN), false, '연결 ID 원문을 남기지 않는다');
    }
    const s = setup();
    assert.deepEqual(await s.handler(event('CONNECT', { multiValueHeaders: { Origin: ['https://example.com'] } })), { statusCode: 403 });
  });
});

describe('Lambda 핸들러: $default', () => {
  it('본문을 core 에 넘기고, 응답은 사용자 지정 도메인이 아니라 execute-api 주소의 연결 관리 API 로 보낸다', async () => {
    const s = setup();
    assert.deepEqual(await s.handler(message({ action: 'ping', id: 'p1' })), { statusCode: 200 });
    assert.deepEqual(s.endpoints, [ENDPOINT]);
    assert.deepEqual(s.regions, ['ap-northeast-2', 'ap-northeast-2']);
    assert.deepEqual(s.dynamo.callsOf('update')[0]?.['Key'], { pk: `CONN#${CONN}`, sk: 'CONN' });
    assert.deepEqual(posted(s.management), [{ to: CONN, type: 'error', code: 'NOT_JOINED', message: 'connection is not joined', re: 'p1' }]);
  });

  it('join(create) 이 빈 방에 등록되고 joined 가 그 연결로 간다. 로그에 방 ID·이름·key·연결 ID 원문이 없다', async () => {
    const s = setup();
    const room = newRoomId();
    const key = newResumeKey();
    const sid = newSid();
    await s.handler(message({ action: 'join', v: 1, id: 'j1', room, peer: 'alice-secret', sid, key, mode: 'create', seq: 1 }));
    const [reply] = posted(s.management);
    assert.equal(reply?.type, 'joined');
    assert.equal(reply?.re, 'j1');
    assert.deepEqual(reply?.members, []);
    assert.equal(s.dynamo.callsOf('put').length, 1);
    const stored = JSON.stringify(s.dynamo.calls);
    assert.equal(stored.includes(room), false, '테이블에 방 ID 원문을 쓰지 않는다');
    assert.equal(stored.includes(key), false, '테이블에 key 원문을 쓰지 않는다');
    const logged = JSON.stringify(s.log.events);
    for (const secret of [room, key, 'alice-secret', CONN]) assert.equal(logged.includes(secret), false, secret);
    assert.ok(s.log.events.some((entry) => entry.event === 'conn.join' && entry.fields.outcome === 'joined'));
  });

  it('바이너리 프레임(isBase64Encoded)과 본문 없는 메시지는 빈 글로 넘겨 BAD_MESSAGE 로 답한다', async () => {
    for (const more of [{ body: 'AAECAw==', isBase64Encoded: true }, {}]) {
      const s = setup();
      await s.handler(event('MESSAGE', more));
      const [reply] = posted(s.management);
      assert.equal(reply?.code, 'BAD_MESSAGE');
      assert.equal(reply?.re, undefined);
    }
  });

  it('저장소가 실패하면 그 요청의 SERVER_ERROR 로 답하고 핸들러는 200 을 돌려준다', async () => {
    const s = setup();
    s.dynamo.respond('update', () => {
      throw sdkError('ProvisionedThroughputExceededException', 400);
    });
    assert.deepEqual(await s.handler(message({ action: 'ping', id: 'p9' })), { statusCode: 200 });
    assert.deepEqual(posted(s.management).map((reply) => [reply.code, reply.re]), [['SERVER_ERROR', 'p9']]);
  });

  it('전송까지 실패해도 핸들러는 200 이다(게이트웨이가 오류 프레임을 보내지 않게)', async () => {
    const s = setup();
    s.management.failPostWith = sdkError('InternalServerError', 500);
    assert.deepEqual(await s.handler(message({ action: 'ping', id: 'p2' })), { statusCode: 200 });
  });

  it('주소가 같은 동안 연결 관리 클라이언트를 다시 쓰고, 스테이지가 바뀌면 새로 만든다', async () => {
    const s = setup();
    await s.handler(message({ action: 'ping', id: 'a' }));
    await s.handler(message({ action: 'ping', id: 'b' }));
    await s.handler(event('MESSAGE', { body: '{"action":"ping","id":"c"}' }, { stage: 'beta' }));
    assert.deepEqual(s.endpoints, [ENDPOINT, `https://${API_ID}.execute-api.ap-northeast-2.amazonaws.com/beta`]);
  });
});

describe('Lambda 핸들러: $disconnect 와 잘못된 이벤트', () => {
  it('$disconnect 는 연결 항목을 지우고, 등록이 있었으면 참가자 기록을 연결 ID 조건부로 지운다', async () => {
    const s = setup();
    s.dynamo.respond('delete', (input) =>
      input['Key']['sk'] === 'CONN' ? { Attributes: { roomKey: '0123456789abcdef0123456789abcdef', peer: 'alice', sid: 'abcdefghijkl' } } : {},
    );
    assert.deepEqual(await s.handler(event('DISCONNECT', { body: undefined })), { statusCode: 200 });
    const deletes = s.dynamo.callsOf('delete');
    assert.deepEqual(deletes[0]?.['Key'], { pk: `CONN#${CONN}`, sk: 'CONN' });
    assert.deepEqual(deletes[1]?.['Key'], { pk: 'ROOM#0123456789abcdef0123456789abcdef', sk: 'PEER#alice' });
    assert.deepEqual(deletes[1]?.['ExpressionAttributeValues'], { ':connId': CONN });
    assert.equal(s.management.posts.length, 0, '닫힌 연결로 보내지 않는다');
  });

  it('모양이 틀린 이벤트는 아무 것도 하지 않고 200 을 돌려주며 로그를 남긴다', async () => {
    for (const bad of [null, 'x', {}, { requestContext: {} }, event('MESSAGE', {}, { eventType: 'OTHER' }), event('MESSAGE', {}, { connectionId: '' })]) {
      const s = setup();
      assert.deepEqual(await s.handler(bad), { statusCode: 200 });
      assert.equal(s.dynamo.calls.length, 0);
      assert.ok(s.log.events.some((entry) => entry.event === 'event.invalid' && entry.fields.reason === 'shape'));
    }
  });

  it('API ID 나 스테이지의 형식이 틀리면 연결 관리 API 를 만들지 않고 로그를 남긴다', async () => {
    const s = setup();
    assert.deepEqual(await s.handler(event('MESSAGE', { body: '{}' }, { apiId: 'evil.example.com/x' })), { statusCode: 200 });
    assert.deepEqual(s.endpoints, []);
    assert.equal(s.dynamo.calls.length, 0);
    assert.ok(s.log.events.some((entry) => entry.event === 'event.invalid' && entry.fields.reason === 'endpoint'));
  });
});

describe('Lambda 핸들러: 설정', () => {
  it('필수 환경 변수가 틀리면 만들 때 던진다(틀린 설정으로 조용히 돌지 않는다)', () => {
    assert.throws(() => setup({ AWS_REGION: 'ap-northeast-2' }), LambdaConfigError);
    assert.throws(() => setup({ TABLE_NAME: 'agent-chat-table' }), LambdaConfigError);
  });

  it('LOG_LEVEL 이 모르는 값이면 경고 한 줄을 남기고 돈다', () => {
    const s = setup({ ...ENV, LOG_LEVEL: 'loud' });
    assert.deepEqual(
      s.log.events.map((entry) => [entry.level, entry.event, entry.fields.name]),
      [['warn', 'config.problem', 'LOG_LEVEL']],
    );
  });
});
