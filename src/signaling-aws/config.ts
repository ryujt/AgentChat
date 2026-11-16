// Lambda 환경 변수의 해석 (deployment.md 2.3). 공용 서버에서 환경 변수를 읽는 곳은 이 모듈뿐이다.
// 값은 인자로 받는다. process.env 를 넘기는 것은 handler.ts 와 index.ts 의 기본값이다.

import type { LogLevel } from '../diagnostics/log-port.js';

export type LambdaEnv = Readonly<Record<string, string | undefined>>;

export interface LambdaConfig {
  /** 참가자·연결 항목을 두는 DynamoDB 테이블. 템플릿이 TABLE_NAME 으로 넣는다. */
  readonly tableName: string;
  /** 런타임이 넣는 AWS_REGION. 연결 관리 API 주소를 만들 때 쓴다. */
  readonly region: string;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
/** DynamoDB 테이블 이름의 형식(3~255자). */
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/;

/** 필수 변수가 없거나 형식이 틀리면 던진다. 이름만 싣고 값은 싣지 않는다. */
export class LambdaConfigError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Lambda 환경 변수가 없거나 형식이 틀렸다: ${variable}`);
    this.name = 'LambdaConfigError';
    this.variable = variable;
  }
}

/**
 * 필수 변수 둘을 읽는다. 잘못됐으면 던진다.
 * 초기화에서 던지면 모든 호출이 실패하고 배포 검증(verify.mjs 1번)이 바로 잡는다. 틀린 설정으로 조용히 돌지 않게 한다.
 */
export function readLambdaConfig(env: LambdaEnv): LambdaConfig {
  const tableName = env['TABLE_NAME'];
  if (tableName === undefined || !TABLE_NAME.test(tableName)) throw new LambdaConfigError('TABLE_NAME');
  const region = env['AWS_REGION'];
  if (region === undefined || !REGION.test(region)) throw new LambdaConfigError('AWS_REGION');
  return { tableName, region };
}

export interface LogLevelReading {
  readonly level: LogLevel;
  /** LOG_LEVEL 에 모르는 값이 있어 기본값을 썼다. */
  readonly invalid: boolean;
}

/** LOG_LEVEL 을 읽는다. 없으면 info, 모르는 값이어도 info 로 돌고 invalid 로 알린다. */
export function readLogLevel(env: LambdaEnv): LogLevelReading {
  const raw = env['LOG_LEVEL'];
  if (raw === undefined || raw === '') return { level: DEFAULT_LOG_LEVEL, invalid: false };
  const level = LOG_LEVELS.find((candidate) => candidate === raw.toLowerCase());
  return level === undefined ? { level: DEFAULT_LOG_LEVEL, invalid: true } : { level, invalid: false };
}
