// room-session 모듈의 공개 진입점. 계약은 contract.ts, 규칙은 docs/design/architecture.md 3.10 에 있다.
// 하위 모듈(signaling-client, mesh, shared-state, inbox, records)은 만드는 함수로 주입받는다. 조립은 src/entry/mcp.ts 가 한다.

export { DEFAULT_ROOM_SESSION_LIMITS, createRoomSession } from './session.js';
export type * from './contract.js';
