// 공용 서버 Lambda 의 조립 (architecture.md 3.4, deployment.md 2.3).
// 전역 시계를 읽고 stdout 로거(svc: lambda)를 만들어 signaling-aws 에 넘긴다. 돌려받은 함수가 Lambda 진입점 handler 다.
// esbuild 가 이 파일을 build/lambda/index.mjs 하나로 묶는다(npm run build:lambda). @aws-sdk/* 는 런타임 내장분을 쓴다.

import { createStdoutLogger } from '../diagnostics/index.js';
import type { Now } from '../protocol/index.js';
import { createLambdaHandler, readLogLevel } from '../signaling-aws/index.js';
import type { LambdaHandler } from '../signaling-aws/index.js';

const now: Now = () => Date.now();
const log = createStdoutLogger({ service: 'lambda', level: readLogLevel(process.env).level, now });

// 초기화에서 던지면(필수 환경 변수가 틀림) 모든 호출이 실패하고 배포 검증이 바로 잡는다.
export const handler: LambdaHandler = createLambdaHandler({ now, log, env: process.env, allowedOrigin: 'https://tools.camp' });
