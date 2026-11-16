// records 모듈의 공개 진입점. 계약은 contract.ts, 위치와 형식은 docs/design/mcp-interface.md 8~9절에 있다.

export { openTranscript } from './transcript.js';
export { writeReport } from './report.js';
export type * from './contract.js';
