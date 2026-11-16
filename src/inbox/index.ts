// inbox 모듈의 공개 진입점. 다른 모듈은 이 파일과 contract.ts 만 import 한다.

export { createInbox, DEFAULT_INBOX_LIMITS } from './inbox.js';
export type * from './contract.js';
