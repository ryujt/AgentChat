// shared-state 모듈의 공개 진입점. 계약은 contract.ts, 규칙은 docs/design/protocol.md 5절에 있다.

export { createReplica } from './replica.js';
export type * from './contract.js';
