# 2026-11-18 브라우저 WebSocket 출처 검증

macOS arm64, Node.js 26.12.1, npm 11.20.0에서 공용 Lambda와 자체 호스팅 서버의 접속 조건을 확인했다. 관련 이력은 [AWS 시그널링](2026-11-15-w2.md), [자체 호스팅 시그널링](2026-11-15-w1.md)이다.

| 실행 | 결과 |
|---|---|
| `npm run build` 뒤 `node --test dist/signaling-aws/handler.test.js dist/signaling-selfhost/server.test.js tests/wire/server-entry.test.mjs` | 42/42 통과. Lambda 이벤트 대역과 실제 로컬 WebSocket 접속에서 허용한 출처를 받고, 다른 출처는 HTTP 403을 돌려준다. 출처 없는 연결과 자체 호스팅의 기본값도 확인했다. |
| `npm run build:lambda` | 번들 빌드 성공. |
| `npm test` | 1차 1696/1697. V-U8의 개발 의존성 목록에 브라우저 번들의 `@noble/hashes`가 빠져 있었다. 목록 반영 뒤 1697/1697 통과. |
| `npm run build:browser` | 브라우저 타입 검사와 ESM 번들 생성 통과. tools.camp에 포함된 번들을 동일한 입력으로 재생성해 바이트 일치를 확인했다. |
| 로컬 Chrome, 자체 호스팅, MCP 프로세스 2개 | 관전자 입장, 에이전트 이름·역할, 양방향 채팅, 대상 지정과 전체 메시지의 전달 확인, 테스트·시나리오 활동, 모니터를 닫았을 때 퇴장을 확인했다. |
| 공용 서버 Lambda 코드 배포 후 `node deployments/aws/verify.mjs --domain agent-chat.tools.camp --rounds 2 --no-flood` | 25건 통과, 부하 시험 1건 생략. 별도 핸드셰이크에서 Origin 없음과 `https://tools.camp`는 101, 다른 출처는 403을 확인했다. |
| 공개 tools.camp 페이지, Chrome, 공용 시그널링과 MCP 프로세스 2개 | 홈 카드에서 페이지를 열고 같은 URL에서 관전자로 입장했다. 에이전트 역할, 테스트·시나리오 활동, 양방향 채팅과 전달 확인, 창을 닫았을 때 퇴장을 확인했다. 에이전트와 브라우저는 같은 PC에서 실행했다. |
