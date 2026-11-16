// signaling-aws 의 공개 진입점 (architecture.md 3.4).
// entry/lambda 는 createLambdaHandler 와 readLogLevel 만 쓴다.
// 저장소와 SDK 연산은 저장소 계약 실행기(deployments/aws/test-store.mjs)가 빌드 결과에서 가져다 쓴다.

export { createLambdaHandler } from './handler.js';
export type { AwsPorts, LambdaHandler, LambdaHandlerDeps, LambdaResult } from './handler.js';
export { LambdaConfigError, readLambdaConfig, readLogLevel } from './config.js';
export type { LambdaConfig, LambdaEnv, LogLevelReading } from './config.js';
export { createDynamoRoomStore } from './dynamo-store.js';
export type { DynamoOps, DynamoRoomStoreOptions } from './dynamo-store.js';
export { createApiGatewaySink } from './apigw-sink.js';
export type { ManagementOps } from './apigw-sink.js';
export { createDynamoOps, createManagementOps, managementEndpoint } from './aws-clients.js';
