// 연결 관리 API 전송(ConnectionSink)의 결과 변환과, 연결 관리 API 주소(대역).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApiGatewaySink } from './apigw-sink.js';
import { MANAGEMENT_CALL_LIMITS, managementEndpoint } from './aws-clients.js';
import { createFakeManagement, sdkError } from './testing.js';

describe('API Gateway 전송', () => {
  it('send 는 성공하면 ok, 연결이 없으면(GoneException 또는 HTTP 410) gone 이다', async () => {
    const ops = createFakeManagement();
    const sink = createApiGatewaySink(ops);
    assert.equal(await sink.send('c1', '{"type":"pong"}'), 'ok');
    assert.deepEqual(ops.posts, [{ connectionId: 'c1', data: '{"type":"pong"}' }]);

    ops.gone.add('c2');
    assert.equal(await sink.send('c2', 'x'), 'gone');
    ops.failPostWith = sdkError('Unknown', 410);
    assert.equal(await sink.send('c3', 'x'), 'gone', '이름이 달라도 상태가 410 이면 연결 없음');
  });

  it('send 의 그 밖의 실패(413, 망 오류)는 던진다', async () => {
    const ops = createFakeManagement();
    const sink = createApiGatewaySink(ops);
    for (const error of [sdkError('Unknown', 413), sdkError('TimeoutError'), sdkError('InternalServerError', 500)]) {
      ops.failPostWith = error;
      await assert.rejects(sink.send('c1', 'x'), { name: error.name });
    }
  });

  it('(검토 1차 SERVER-R1-03) send 가 스로틀(HTTP 429, 또는 이름이 스로틀)에 걸리면 던지지 않고 throttled 다', async () => {
    const ops = createFakeManagement();
    const sink = createApiGatewaySink(ops);
    for (const error of [sdkError('LimitExceededException', 429), sdkError('Unknown', 429), sdkError('TooManyRequestsException'), sdkError('ThrottlingException')]) {
      ops.failPostWith = error;
      assert.equal(await sink.send('c1', 'x'), 'throttled', error.name);
    }
  });

  it('isOpen 은 GetConnection 이 되면 true, 410 이면 false, 그 밖의 오류는 던진다', async () => {
    const ops = createFakeManagement();
    const sink = createApiGatewaySink(ops);
    assert.equal(await sink.isOpen('c1'), true);
    ops.gone.add('c1');
    assert.equal(await sink.isOpen('c1'), false);
    assert.deepEqual(ops.gets, ['c1', 'c1']);
    ops.get = async () => {
      throw sdkError('ForbiddenException', 403);
    };
    await assert.rejects(sink.isOpen('c1'), { name: 'ForbiddenException' });
  });

  it('close 는 DeleteConnection 을 부르고, 이미 없으면 아무 일이 없다', async () => {
    const ops = createFakeManagement();
    const sink = createApiGatewaySink(ops);
    await sink.close('c1');
    await sink.close('c1');
    assert.deepEqual(ops.deletes, ['c1', 'c1']);
    ops.delete = async () => {
      throw sdkError('InternalServerError', 500);
    };
    await assert.rejects(sink.close('c1'), { name: 'InternalServerError' });
  });
});

describe('연결 관리 API 주소', () => {
  it('사용자 지정 도메인이 아니라 execute-api 주소로 만든다', () => {
    assert.equal(managementEndpoint('abc123defg', 'ap-northeast-2', 'prod'), 'https://abc123defg.execute-api.ap-northeast-2.amazonaws.com/prod');
  });

  it('API ID 와 스테이지의 형식이 틀리면 null 이다(주소에 다른 글이 끼지 않게)', () => {
    for (const [apiId, stage] of [
      ['', 'prod'],
      ['abc/../x', 'prod'],
      ['ABC123', 'prod'],
      ['abc123', ''],
      ['abc123', 'prod/@connections'],
      ['abc123', 'prod?x=1'],
    ] as const) {
      assert.equal(managementEndpoint(apiId, 'ap-northeast-2', stage), null, `${apiId} ${stage}`);
    }
  });
});

describe('연결 관리 API 클라이언트 설정 (검토 1차 SERVER-R1-03)', () => {
  it('연결 관리 API 는 다시 시도하지 않는다(스로틀 429 를 SDK 가 또 보내 요구량을 늘리지 않는다). 기한은 그대로다', () => {
    assert.equal(MANAGEMENT_CALL_LIMITS.maxAttempts, 1);
    assert.deepEqual(MANAGEMENT_CALL_LIMITS.requestHandler, { connectionTimeout: 2_000, requestTimeout: 3_000, throwOnRequestTimeout: true });
  });
});
