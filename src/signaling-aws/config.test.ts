// Lambda 환경 변수 해석(대역).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LambdaConfigError, readLambdaConfig, readLogLevel } from './config.js';

describe('Lambda 환경 변수', () => {
  it('TABLE_NAME 과 AWS_REGION 을 읽는다', () => {
    assert.deepEqual(readLambdaConfig({ TABLE_NAME: 'agent-chat-signaling-table', AWS_REGION: 'ap-northeast-2' }), {
      tableName: 'agent-chat-signaling-table',
      region: 'ap-northeast-2',
    });
  });

  it('필수 변수가 없거나 형식이 틀리면 변수 이름만 실은 오류를 던진다(값은 싣지 않는다)', () => {
    const cases: [Record<string, string>, string][] = [
      [{ AWS_REGION: 'ap-northeast-2' }, 'TABLE_NAME'],
      [{ TABLE_NAME: 'x', AWS_REGION: 'ap-northeast-2' }, 'TABLE_NAME'],
      [{ TABLE_NAME: 'table name with space', AWS_REGION: 'ap-northeast-2' }, 'TABLE_NAME'],
      [{ TABLE_NAME: 'agent-chat-table' }, 'AWS_REGION'],
      [{ TABLE_NAME: 'agent-chat-table', AWS_REGION: 'https://evil.example' }, 'AWS_REGION'],
    ];
    for (const [env, variable] of cases) {
      assert.throws(
        () => readLambdaConfig(env),
        (error: unknown) => error instanceof LambdaConfigError && error.variable === variable && !error.message.includes('evil'),
      );
    }
  });

  it('LOG_LEVEL 은 없으면 info, 모르는 값이면 info 로 돌고 invalid 로 알린다', () => {
    assert.deepEqual(readLogLevel({}), { level: 'info', invalid: false });
    assert.deepEqual(readLogLevel({ LOG_LEVEL: 'DEBUG' }), { level: 'debug', invalid: false });
    assert.deepEqual(readLogLevel({ LOG_LEVEL: 'warn' }), { level: 'warn', invalid: false });
    assert.deepEqual(readLogLevel({ LOG_LEVEL: 'verbose' }), { level: 'info', invalid: true });
  });
});
