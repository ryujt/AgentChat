# tests/e2e/mcp — MCP 표면 단독 시험 (W5)

제품의 `mcp-server` 와 `inbox` 에 **가짜 세션**을 붙여 실제 프로세스로 띄우고, 실제 stdio 로 붙어 본다. 방 기능(시그널링, WebRTC, 공유 상태)은 없다. 이 폴더의 통과는 방 기능의 증거가 아니다.

| 파일 | 하는 일 |
|---|---|
| `fake-entry.mjs` | 시험 진입점. `loadConfig` → `createInbox` → 가짜 세션 → `startMcpServer`. **제품 진입점이 아니다**(제품은 `dist/entry/mcp.js`). 최소판이기도 하다 |
| `fake-session.mjs` | `room-session` 계약에 맞춘 가짜. 입장은 그 자리에서 성공한다. 규칙 판정은 흉내만 낸다 |
| `peer-script.mjs` | "다른 참가자"의 글을 넣고, MCP 프로세스가 남긴 기록을 본다. 파일(조종 폴더)로만 주고받는다 |
| `sdk-host.mjs` | 호스트 흉내. 부모 SIGKILL 시험에서 죽는 쪽이다 |
| `live-peer.mjs` | **실제 방**(공용 서버)의 상대 참가자. 설치된 제품 진입점을 띄워 방을 만들고, 세션이 들어오면 정해진 간격으로 글을 보내 답이 오기까지 잰다. 헤드리스 세션(`claude -p`, `codex exec`)을 직접 띄우거나(`--host claude\|codex`), 사람이 띄운 세션을 기다린다(`--host none`). `V-I2`~`V-I4`·`V-I6` 의 `peer-script` 역할. 쓰는 법은 파일 머리말과 [이력 2026-11-16-final-sessions](../../test-history/2026-11-16-final-sessions.md) |
| `harness.mjs` | 시험이 함께 쓰는 도구(임시 폴더, SDK 클라이언트 연결, 줄 단위 JSON-RPC 연결) |
| `v-l7a.test.mjs` | `V-L7`(가). 로컬 실물 |
| `minimal.test.mjs` | 최소판("점검 알림 → `confirm_channel` → 시험 사건 전달")을 SDK 클라이언트로 미리 돌려 본다 |

## 실행

```sh
npx tsc -p tsconfig.json --outDir .work/w5/dist          # 또는 npm run build (그러면 AGENT_CHAT_DIST 를 주지 않는다)
AGENT_CHAT_DIST=.work/w5/dist node --test tests/e2e/mcp/v-l7a.test.mjs tests/e2e/mcp/minimal.test.mjs
```

- 프로세스는 임시 `HOME` 과 임시 `AGENT_CHAT_HOME` 으로 뜬다. 실제 홈에 쓰지 않는다. 포트를 열지 않는다.
- 시험마다 자기가 띄운 프로세스가 남지 않았는지 확인한다.

## 최소판을 실제 호스트에 붙여 보기 (A-MCP-1, 2, 8, 9. 사람이 필요하다)

통합 담당이 사용자와 함께 한다. 끝나면 등록을 지운다. 아래에서 `<저장소>` 는 이 저장소의 절대 경로, `<임시>` 는 비어 있는 임시 폴더의 절대 경로다.

1. 빌드: `npm run build`
2. 등록(채널을 쓰는 쪽):

   ```sh
   claude mcp add --scope user agent-chat \
     -e AGENT_CHAT_HOME=<임시>/home -e AGENT_CHAT_NAME=claude-min -e AGENT_CHAT_CLIENT=claude-code -e AGENT_CHAT_WAIT_MAX_SEC=100 \
     -- node <저장소>/tests/e2e/mcp/fake-entry.mjs --control <임시>/control
   ```

3. **A-MCP-1 (채널 등록, 유휴 세션 깨우기)**. 호스트를 개발 채널 플래그로 시작하고 경고를 사람이 승인한다.

   ```sh
   claude --dangerously-load-development-channels server:agent-chat
   ```

   - 세션에 한 번만 말한다: "agent-chat 의 create_room 을 부르고, 안내대로 방의 글을 받아서 오는 글마다 send_message 로 짧게 답해 줘."
   - 볼 것 ①: 점검 알림 뒤 `confirm_channel` 이 사람 입력 없이 불리는가. 다른 터미널에서 `node tests/e2e/mcp/peer-script.mjs --control <임시>/control log` 로 `delivery.probe{sent}` → `tool.call{confirm_channel}` → `delivery.mode{to: channel}` 의 시각을 적는다.
   - 볼 것 ②: 세션이 유휴가 된 뒤 `node tests/e2e/mcp/peer-script.mjs --control <임시>/control chat "안녕하세요. 답해 주세요"` 를 넣는다. 사람 입력 없이 턴이 시작되고 `send_message` 가 불리는가. `… sent` 로 답을 본다.
4. **A-MCP-2 (채널 알림이 보이는 시점)**. 3번의 ①에서 `tool.call{wait_for_messages}` 가 `confirm_channel` 보다 먼저 몇 번 있었는지, `confirm_channel` 이 대기 반복 도중에 불렸는지 턴이 끝난 뒤에 불렸는지를 `log` 의 시각으로 적는다. 반복 도중에 불리지 않았으면 "대기를 멈추고 턴을 끝내라"고 말한 뒤 점검 알림이 새 턴을 시작시키는지 본다([mcp-interface.md 7.3](../../../docs/design/mcp-interface.md#73-호스트별-조건-설치가-안내한다)).
5. **A-MCP-8 (본문 안의 채널 태그)**. channel 모드에서 `… peer-script.mjs --control <임시>/control tag` 를 넣고, 모델에게 "방금 받은 채널 글을 글자 그대로 보여 줘"라고 묻는다. 서버는 `<\channel`, `<\/channel` 로 바꿔 보낸다.
6. **A-MCP-9 (tool 결과 크기)**. 채널 플래그 **없이** `claude` 를 시작한다(poll). "agent-chat 의 create_room 을 부르고 wait_for_messages 를 한 번 불러 줘"라고 한 뒤 대기 중에 `… peer-script.mjs --control <임시>/control big 24000` 을 넣는다. 명령이 출력한 표지(`END-…`)를 모델이 받은 마지막 글의 끝에서 읽어 낼 수 있는지 묻는다. 이어서 `… huge` (사건 하나로 약 28KB)를 넣어 한도를 넘겼을 때의 모습을 적는다. Codex 도 같은 방법으로 본다(`codex mcp add agent-chat --env … -- node …`).
7. 끝나면: `claude mcp remove --scope user agent-chat`, `<임시>` 폴더 삭제.

기록할 것: 호스트 버전, 각 단계의 시각과 `log` 출력 요약, 판정. 본문과 토큰은 진단 기록(`log.jsonl`)에 남지 않는다. `sent.jsonl` 에는 에이전트가 보낸 글이 남는다.
