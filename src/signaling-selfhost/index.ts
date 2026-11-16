// signaling-selfhost 의 공개 진입점 (architecture.md 3.3). 조립(entry/server)만 이 파일을 import 한다.
// ws 리스너와 메모리 저장소로 signaling-core 를 세운다. 시계·타이머·로거는 조립이 넘긴다.

export { DEFAULT_SELF_HOST_LIMITS, startSelfHostServer } from './server.js';
export type { SelfHostAddress, SelfHostLimits, SelfHostServer, SelfHostServerOptions } from './server.js';
