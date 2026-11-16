# 2026-11-15 구현 전 외부 가정 확인

구현을 시작하기 전에, 틀리면 설계가 달라지는 외부 가정을 조사하고 일부를 실측한 기록이다.

- 작업 ID: `2026-11-15-pre-implementation-assumptions`
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e`, 미커밋 변경은 `docs/PRD.md` 뿐. 제품 코드는 아직 없다.
- 환경: macOS arm64 한 대, Node v26.12.1, npm 11.20.0, Claude Code 2.1.325, codex-cli 0.169.0.
- 참고한 이전 이력: 없음(첫 실행).
- 증거 수준: 아래 실행은 모두 **탐색 코드**로 한 것이다. 제품 경로 검증이 아니다. 같은 항목은 제품 코드로 다시 검증해야 한다.
- 원문 증거: 실험 코드와 원시 로그는 세션 임시 폴더(표의 `<scratchpad>`)에 있었고 보존 대상이 아니다. 재현에 필요한 명령·조건·판정은 이 문서에 남겼다.
- 표기: `<repo>` 는 이 저장소, `<7pan>` 은 PRD 가 지정한 참조 프로젝트, `$B` 는 `<scratchpad>/webrtc-lib-probe` 이다.

## 요약

| 가정 | 결과 | 근거 실행 |
|---|---|---|
| Node 에서 브라우저 없이 STUN 전용 DataChannel mesh 가 된다 | 통과(한 PC, 프로세스 4개). 서로 다른 PC·실제 NAT 는 미실행 | PRE-RTC-03~05, 15, 16 |
| 라이브러리가 "응답 없음"을 스스로 실패 처리한다 | 실패. 어떤 후보도 하지 않는다 → 앱 타이머 필요 | PRE-RTC-07 |
| TURN URL 을 주지 않으면 relay candidate 가 생기지 않는다 | 통과 | PRE-RTC-04, 11 |
| 양쪽이 동시에 offer 해도 연결된다 | 실패 → "ID 가 작은 쪽만 offer" 규칙 필요 | PRE-RTC-09 |
| MCP SDK 1.x 로 채널 capability 선언과 사용자 정의 알림 전송이 된다 | 통과(SDK 클라이언트로 수신 확인). 실제 Claude Code 세션 수신은 미실행 | PRE-MCP 전체, PRE-CH-10 |
| `claude --help` 나 `--version` 으로 채널 지원을 비대화식으로 판정할 수 있다 | 실패 → 설치 점검은 가능/불가/불명으로 보고 | PRE-CH-03, 04 |
| 실제 Claude Code 세션에서 개발 채널 이벤트가 유휴 세션을 깨운다 | 미실행(대화형 세션과 사람의 승인이 필요) | PRE-CH-13 |
| 채널 없는 에이전트가 장시간 대기 tool 로 메시지를 이어 받는다 | 미실행(모델 호출 필요). 클라이언트별 타임아웃 값만 문서·소스로 확인 | PRE-ALT-11 |

## 다음 실행에서 확인할 것

- 위 "미실행" 항목과 각 조사의 "미확인으로 남은 것".
- 통과 항목도 제품 코드 경로로 다시 검증한다.

## 실행 기록

### 7pan 참조 조사

| 실행 ID | 시각(KST) | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|
| PRE-REF-01 | 2026-11-15 10:18:57 KST ~ 2026-11-15 10:19:26 KST | 7pan 소스 구조와 P2P 관련 파일을 검색해 확인 | `ls, grep -rIl RTCPeerConnection\|iceServers\|createOffer (7pan 읽기 전용)` | 시그널링 서버·클라이언트·Node 피어 파일 위치 식별 | p2p-signaling.service.ts, P2PTransport.ts, ice-server.service.ts, peer-client.mjs 등 식별 | 통과 |

미확인으로 남은 것:
- distributed-p2p-signaling.service.ts(다중 인스턴스 분산판)는 읽지 않았다
- werift 0.23.0이 현재 Node 버전과 macOS에서 DataChannel 연결을 만드는지 실행해 확인하지 않았다
- peer-client.mjs와 서버의 프로토콜 불일치는 코드 대조 결과이며 실제 실행으로 에러를 재현하지 않았다
- 운영 STUN/TURN 주소(TURN_SERVER_URLS_JSON)는 환경변수라 읽지 않았다
- 테스트 이력의 PASS 기록은 7pan 환경 문서 기준이며 재실행하지 않았다
- maxRetransmits 미지정의 신뢰성 이점과 28KB 프레임 제한이 AgentChat 메시지 크기에 충분한지는 미검증이다
- FreeSessionTransport의 동등 참가자 1:1 모델은 AgentChat의 다자 메시 요구와 달라 세부를 읽지 않았다
- docs/remaining-issues-and-recommended-work.md는 P2P 관련 키워드 검색 결과만 확인했고 전체를 읽지 않았다

### Claude Code Channels 조사

| 실행 ID | 시각(KST) | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|
| PRE-CH-01 | 2026-11-15 10:18:59 KST ~ 2026-11-15 10:19:07 KST | 로컬 Claude Code 버전과 도움말 확인 | `claude --version; claude --help; claude mcp --help; claude mcp add --help` | 버전 2.1.325, mcp add 의 scope 와 stdio 형식 확인 | `2.1.325 (Claude Code)`. mcp add: `-s, --scope <scope>` (local, user, or project, 기본 local), `-t` 기본 stdio, 예시 `claude mcp add my-server -e API_KEY=xxx -- node ./my-server.js`. mcp 하위 명령에 add-json, get, list, remove, reset-project-choices 있음 | 통과 |
| PRE-CH-02 | 2026-11-15 10:19:07 KST ~ 2026-11-15 10:23:30 KST | 공식 문서를 마크다운으로 내려받기 | `curl -sL -A docs-reader -o <page>.md https://code.claude.com/docs/en/<page>.md (channels, channels-reference, mcp, hooks, settings, cli-reference, env-vars, settings-reference, tools-reference, scheduled-tasks, headless, changelog, cross-session-messaging, plugins/components, managed-settings)` | 모든 페이지 HTTP 200 | 모든 페이지 200. channels.md 372줄, channels-reference.md 783줄, mcp.md 1919줄 등 | 통과 |
| PRE-CH-03 | 2026-11-15 10:20:45 KST ~ 2026-11-15 10:20:45 KST | 도움말에 채널 플래그가 나오는지 확인 | `claude --help 2>&1 \| grep -c -i channel` | 문서대로 0건 | 0 | 통과 |
| PRE-CH-04 | 2026-11-15 10:20:45 KST ~ 2026-11-15 10:20:45 KST | --version 과 함께 준 플래그가 검증되는지 확인 | `claude --bogus-flag-xyz --version; claude --channels plugin:x@y --version; claude --dangerously-load-development-channels server:x --version` | 지원하지 않는 플래그면 오류가 나서 플래그 지원 여부를 구분할 수 있음 | 세 명령 모두 `2.1.325 (Claude Code)` 만 출력. 가짜 플래그도 rc=0. 구분 불가 | 실패 |
| PRE-CH-05 | 2026-11-15 10:20:45 KST ~ 2026-11-15 10:20:45 KST | auth 하위 명령의 도움말 확인 (status 자체는 실행하지 않음) | `claude auth --help; claude auth status --help` | status 의 출력 형식 옵션 확인 | status 옵션: `--json Output as JSON (default)`, `--text Output as human-readable text` | 통과 |
| PRE-CH-06 | 2026-11-15 10:20:50 KST ~ 2026-11-15 10:20:50 KST | 설치된 바이너리에 채널 관련 문자열이 있는지 확인 | `LC_ALL=C grep -a -c -F -- "<문자열>" ~/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` | 채널 플래그와 알림 메서드 문자열이 존재 | dangerously-load-development-channels 11, notifications/claude/channel 8, claude/channel/permission 6, channelsEnabled 10, allowedChannelPlugins 8, MCP_PROTOCOL_NEGOTIATION 5, 2026-07-28 13 | 통과 |
| PRE-CH-07 | 2026-11-15 10:20:50 KST ~ 2026-11-15 10:22:51 KST | 바이너리에서 채널 등록 판정 함수, meta 키 정규식, 플래그 파서, 개발 채널 대화상자 문구 추출 | `python3 -I scratchpad/channels-research/ctx.py <claude.exe> <앞> <뒤> <개수> "<문자열>" ...` | 문서에 없는 판정 순서와 정규식 확인 | 판정 함수의 사유 문자열 7종, 정규식 /^[a-zA-Z_][a-zA-Z0-9_]*$/, 큐 항목 {mode:"prompt",priority:"next",origin:{kind:"channel"}}, 파서 오류 문구 'entries must be tagged', 대화상자 제목 'WARNING: Loading development channels' 확인. 처음 시도한 grep -o 정규식은 ugrep 복잡도 제한으로 실패해 스크립트로 바꿈 | 통과 |
| PRE-CH-08 | 2026-11-15 10:20:29 KST ~ 2026-11-15 10:20:29 KST | 현재 세션의 Bash 환경에 전달된 Claude Code 변수 이름 확인 | `env \| grep -i '^CLAUDE\\|^MCP_\\|^ANTHROPIC' (토큰 값은 가림)` | 문서대로 CLAUDE_CODE_MESSAGING_SOCKET 이 Bash 에 전달됨 | CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/49574.sock, CLAUDE_CODE_MESSAGING_TOKEN 존재. MCP_*, ANTHROPIC_* 변수는 없음 | 통과 |
| PRE-CH-09 | 2026-11-15 10:22:51 KST ~ 2026-11-15 10:22:51 KST | Node, Bun, MCP SDK 버전 확인 | `node --version; npm --version; bun --version; npm view @modelcontextprotocol/sdk dist-tags --json; npm view @modelcontextprotocol/server dist-tags --json` | 런타임과 SDK 최신 버전 파악 | node v26.12.1, npm 11.20.0, bun 없음(command not found). @modelcontextprotocol/sdk latest 1.32.2 (2.x 없음), @modelcontextprotocol/server latest 2.4.0 | 통과 |
| PRE-CH-10 | 2026-11-15 10:23:15 KST ~ 2026-11-15 10:23:17 KST | SDK 1.32.2 채널 서버의 핸드셰이크와 알림 전송 형태 확인 | `cd scratchpad/channels-research/probe && npm install @modelcontextprotocol/sdk@1.32.2 && node driver.mjs 2026-07-28` | 2026-07-28 요청에 이전 revision 으로 응답하고 claude/channel capability 와 알림을 그대로 내보냄 | initialize 응답 protocolVersion "2025-11-25", capabilities {"experimental":{"claude/channel":{}},"tools":{}}. 알림 {"method":"notifications/claude/channel","params":{"content":"hello from peer","meta":{"room_id":"r1","sender":"agent_b","msg_id":"m-001"}},"jsonrpc":"2.0"}. tools/list 응답 정상 | 통과 |
| PRE-CH-11 | 2026-11-15 10:23:15 KST ~ 2026-11-15 10:23:17 KST | 같은 프로브를 2025-06-18 요청으로 반복 | `node driver.mjs 2025-06-18 \| head -3` | protocolVersion 2025-06-18 로 응답 | initialize 응답 protocolVersion "2025-06-18" 확인. 이후 드라이버가 `write EPIPE` 로 죽었는데, `\| head -3` 이 파이프를 닫아서 생긴 것이다. 알림과 tools/list 줄은 이 실행에서 확인하지 못함 | 부분 검증 |
| PRE-CH-12 | 2026-11-15 10:23:38 KST ~ 2026-11-15 10:23:38 KST | 파일 기반 조직 정책과 provider 환경 변수 존재 확인 | `ls 대상: /Library/Application Support/ClaudeCode/{managed-settings.json,managed-settings.d,managed-mcp.json}; env \| grep -c -E '^(CLAUDE_CODE_USE_BEDROCK\|CLAUDE_CODE_USE_VERTEX\|CLAUDE_CODE_USE_FOUNDRY\|ANTHROPIC_API_KEY\|ANTHROPIC_BASE_URL\|DISABLE_TELEMETRY\|MCP_SDK_GENERATION\|MCP_PROTOCOL_NEGOTI` | 설치 스크립트가 쓸 점검 항목의 현재 값 파악 | 세 경로 모두 없음. 해당 환경 변수 0개 | 통과 |
| PRE-CH-13 |  ~  | 실제 Claude Code 세션에 개발 채널을 등록해 이벤트 수신 확인 | `claude --dangerously-load-development-channels server:agent-chat` | 경고 승인 후 채널 등록, 유휴 세션이 이벤트로 턴 시작 | 작업 규칙(대화형 세션 금지, 도움말·버전 출력만 실행)에 따라 실행하지 않음 | 미실행 |

미확인으로 남은 것:
- 실제 Claude Code 세션에서 `--dangerously-load-development-channels server:<name>` 으로 채널이 등록되고 이벤트가 유휴 세션의 턴을 시작하는지 (세션 실행 금지 규칙으로 실행하지 않음)
- 개발 채널 경고 대화상자가 매 실행마다 뜨는지, 한 번 승인하면 기억되는지
- 이 PC 계정의 플랜(개인 Pro/Max 인지 Team/Enterprise 인지)과 서버 관리형 channelsEnabled 값. `claude auth status` 는 실행하지 않았고 로컬 managed-settings.json 이 없다는 것만 확인
- `claude auth status` JSON 의 authMethod 외 필드 구성 (문서에 명시된 authMethod, configDirectory 외에는 미확인)
- Claude Code v2 런타임이 stdio 서버에 2026-07-28 을 묻는 실제 방식. 로컬 프로브는 initialize 의 protocolVersion 으로 가정했다
- 채널 기능 플래그가 이 계정에 켜져 있는지 (문서: "Availability is rolling out gradually")
- 작업 중 도착한 채널 이벤트가 tool 호출 사이에 전달되는지, 턴이 끝난 뒤에만 전달되는지의 정확한 시점 (문서는 "on the next turn" 이라고만 함)
- meta 값에 문자열이 아닌 값을 넣었을 때 알림 전체가 거부되는지 (코드 스키마상 그럴 것으로 보이나 실측하지 않음)
- 백그라운드로 옮겨진 일반 MCP tool 호출의 결과가 유휴 세션을 스스로 깨우는지 (문서는 MCP task 에 대해서만 명시)
- 세션 inbox 소켓에 넣는 메시지 줄의 JSON 형식, MCP 서버 프로세스 환경에 CLAUDE_CODE_MESSAGING_SOCKET 이 전달되는지
- 플러그인 monitor 의 출력 알림이 유휴 세션을 깨우는지
- `claude mcp add` 로 추가한 서버가 실행 중인 세션에 재시작 없이 반영되는지 (문서에 명시 없음. 채널 사용에는 어차피 재시작 필요)
- local/user scope 서버에 승인 프롬프트가 없다는 점 (문서 기술 범위에서의 추론)
- Windows 와 Linux 에서의 동작 (이 조사는 macOS 한 대에서만 수행)

### MCP SDK 실측

| 실행 ID | 시각(KST) | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|
| PRE-MCP-01 | 2026-11-15 10:19:02 KST ~ 2026-11-15 10:19:10 KST | SDK 패키지 메타데이터 확인 | `npm view @modelcontextprotocol/sdk version dist-tags peerDependencies peerDependenciesMeta engines type main module exports.'.' dependencies --json` | 최신 버전, zod peer 범위, engines, 모듈 형태가 나온다 | version 1.32.2, dist-tags {latest: 1.32.2}, peer zod '^3.25 \|\| ^4.0'(필수)·@cfworker/json-schema(선택), engines node >=18, type module | 통과 |
| PRE-MCP-02 | 2026-11-15 10:19:02 KST ~ 2026-11-15 10:19:10 KST | scratchpad 에 SDK 로컬 설치 | `npm init -y && npm pkg set type=module && npm install @modelcontextprotocol/sdk zod && npm ls --depth=0` | 로컬 설치 성공 | @modelcontextprotocol/sdk@1.32.2, zod@4.6.7 설치, found 0 vulnerabilities | 통과 |
| PRE-MCP-03 | 2026-11-15 10:20:47 KST ~ 2026-11-15 10:20:49 KST | 기본 흐름: initialize capabilities/instructions, tools/list, tools/call, 사용자 정의 알림 수신(fallback + typed handler) | `node client.mjs basic` | experimental capability 와 instructions 가 보이고, tool 2개가 나열·호출되고, notifications/claude/channel 이 수신된다 | serverCapabilities {experimental:{'claude/channel':{}},logging:{},tools:{listChanged:true}}, instructions 일치, tool 2개 JSON Schema 출력, 호출 성공, 잘못된 인자는 isError -32602, fallback 2건 + typed 1건 수신, close 8ms, exit=0 | 통과 |
| PRE-MCP-04 | 2026-11-15 10:20:54 KST ~ 2026-11-15 10:21:04 KST | 타임아웃·progress·취소 6종(T1~T6) | `node client.mjs timeouts` | progress 없이 타임아웃 시 -32001 과 서버 abort, reset 옵션으로 연장, maxTotalTimeout 상한, AbortSignal 취소가 서버에 전달 | T1 1002ms -32001 + 서버 abort 1003ms; T2 progress 있어도 1001ms 타임아웃; T3 reset 으로 3006ms 정상; T4 2006ms 'Maximum total timeout exceeded' 이나 서버 abort 는 2606ms 로 지연, onerror 'unknown token'; T5 702ms 취소, 서버 reason 'user pressed stop'; T6 progressToken 없음 | 통과 |
| PRE-MCP-05 | 2026-11-15 10:21:04 KST ~ 2026-11-15 10:22:09 KST | 실제 60초급 long-poll 3종 동시 실행(L1~L3) | `node client.mjs long60 > long60.out 2>&1` | 기본 타임아웃 60초에서 65초 대기는 실패, progress+reset 또는 timeout 70000 은 성공 | L1 60001ms 에 -32001 data {timeout:60000}, 서버 abort 60001ms; L2 progress 4회 후 65003ms 정상; L3 65003ms 정상; exit=0 | 통과 |
| PRE-MCP-06 | 2026-11-15 10:21:38 KST ~ 2026-11-15 10:21:39 KST | S1 stdout 오염 시 클라이언트 반응 | `PROBE_STDOUT_POLLUTE=1 node client.mjs quick` | 클라이언트에서 파싱 오류가 관찰된다 | client.onerror 'Unexpected token ... is not valid JSON' 2회, 연결은 유지되고 이후 호출·알림 정상 | 통과 |
| PRE-MCP-07 | 2026-11-15 10:21:39 KST ~ 2026-11-15 10:21:43 KST | S2/S5 stdin 종료 핸들러 유무에 따른 client.close() 시간 | `PROBE_NO_LIFECYCLE=1 node client.mjs quick ; PROBE_NO_LIFECYCLE=1 PROBE_NO_KEEPALIVE=1 node client.mjs quick` | 핸들러 없고 열린 핸들이 있으면 종료가 지연된다 | 핸들러 없음+keepalive: close 2005ms(SIGTERM 으로 종료); 핸들러 없음+keepalive 없음: 8ms; 핸들러 있음(다른 실행): 4~13ms | 통과 |
| PRE-MCP-08 | 2026-11-15 10:21:43 KST ~ 2026-11-15 10:21:45 KST | S4 진행 중 호출 도중 서버에 SIGTERM | `node client.mjs inflight-kill ; PROBE_NO_LIFECYCLE=1 node client.mjs inflight-kill` | 서버가 정리 종료하고 클라이언트 호출은 연결 종료 오류로 끝난다 | 핸들러 있음: 'shutdown: SIGTERM', 핸들러 signal abort(AbortError), 클라이언트 -32000 Connection closed; 핸들러 없음: 로그 없이 즉사, 클라이언트 동일 오류 | 통과 |
| PRE-MCP-09 | 2026-11-15 10:21:57 KST ~ 2026-11-15 10:22:09 KST | S3 부모 SIGKILL 시 자식 서버 생존 여부 3종 | `node client.mjs idle & ; kill -9 <client pid> ; sleep 3 ; kill -0 <server pid>  (기본 / PROBE_NO_LIFECYCLE=1 / PROBE_NO_LIFECYCLE=1 PROBE_PERIODIC_NOTIFY=500)` | 핸들러 있으면 종료, 없으면 고아로 남는다 | 핸들러 있음: 종료했으나 로그에 EPIPE uncaughtException 스택 다수; 핸들러 없음: 3초 뒤 생존 ppid=1; 핸들러 없음+주기적 stdout 쓰기: EPIPE 로 종료 | 부분 검증 |
| PRE-MCP-10 | 2026-11-15 10:22:19 KST ~ 2026-11-15 10:22:22 KST | S3a 재실행: stderr error 리스너 없을 때 예외 반복 규모 측정 | `PROBE_LOG_FILE=$PWD/s3.log node client.mjs idle & ; kill -9 <client pid> ; wc -l s3.log ; grep -c uncaughtException s3.log` | 정상 종료 로그 몇 줄 | uncaughtException 30,801회, s3.log 338,816줄 26,489,448바이트, 01:22:20.543Z~01:22:22.042Z 1.5초간 반복 후 강제 종료 타이머로 종료 | 실패 |
| PRE-MCP-11 | 2026-11-15 10:23:04 KST ~ 2026-11-15 10:23:07 KST | S3a' stderr error 리스너 추가 후 부모 SIGKILL 재검증 | `PROBE_LOG_FILE=$PWD/s3.log node client.mjs idle & ; kill -9 <client pid> ; sleep 1 ; kill -0 <server pid> ; wc -c s3.log` | 예외 반복 없이 1초 안에 종료 | 1초 안에 종료, 로그 5줄 461바이트('shutdown: stdin end', 'protocol onclose'), 예외 0회 | 통과 |
| PRE-MCP-12 | 2026-11-15 10:23:07 KST ~ 2026-11-15 10:23:08 KST | 저수준 Server 클래스만으로 동일 표면 구현 | `PROBE_SERVER=server-lowlevel.mjs node client.mjs quick` | experimental capability, instructions, tools, 사용자 정의 알림이 동일하게 동작 | serverCapabilities {experimental:{'claude/channel':{}},tools:{}}, instructions 일치, tool 2개, 호출 성공, 알림 수신, close 3ms | 통과 |
| PRE-MCP-13 | 2026-11-15 10:23:07 KST ~ 2026-11-15 10:23:08 KST | capability 등록 시점과 알림 메서드 검사 규칙 | `node caps-test.mjs` | connect 전 registerCapabilities 는 되고 후에는 실패, 사용자 정의 메서드는 통과, 스펙 메서드는 capability 필요 | connect 전 등록 반영; 후에는 'Cannot register capabilities after connecting to transport'; 'notifications/claude/channel'·'totally/custom' 수신; resources/updated 는 capability 없어 오류; connect 전 알림은 'Not connected' | 통과 |
| PRE-MCP-14 | 2026-11-15 10:23:23 KST ~ 2026-11-15 10:23:28 KST | raw JSON-RPC 로 wire 형식과 프로토콜 버전 협상 확인 | `(printf '%s\n' '<initialize 2025-11-25>' '<notifications/initialized>' '<tools/call send_message>'; sleep 0.8) \| node server.mjs 2>/dev/null ; 같은 방식으로 protocolVersion 2024-11-05 요청` | 줄 단위 JSON 응답과 알림이 stdout 에 나오고 stdin EOF 로 종료 | initialize 응답에 protocolVersion 2025-11-25·capabilities·instructions, tools/call 응답, 알림 2줄 출력, exit=0; 2024-11-05 요청에는 2024-11-05 로 응답 | 통과 |
| PRE-MCP-15 | 2026-11-15 10:23:23 KST ~ 2026-11-15 10:23:28 KST | TypeScript 타입 검사(사용자 정의 알림, extra.signal, progressToken, fallback 핸들러) | `npm install --no-save typescript @types/node && npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck typecheck.ts` | 타입 오류 없음 | tsc exit=0 | 통과 |
| PRE-MCP-16 | 2026-11-15 10:23:28 KST ~ 2026-11-15 10:23:34 KST | Claude Code Channels 공식 문서에서 capability·알림 형식 확인 | `curl -sL -m 20 -A "docs-reader" https://code.claude.com/docs/en/channels-reference.md -o channels-reference.md` | claude/channel capability 와 notifications/claude/channel params 정의를 찾는다 | 45,385바이트 수신. experimental['claude/channel'] = {}, params content/meta, meta 키 제약, --dangerously-load-development-channels 확인 | 통과 |
| PRE-MCP-17 | 2026-11-15 10:23:41 KST ~ 2026-11-15 10:23:44 KST | CJS require 동작과 최종 server.mjs 로 기본 흐름 재확인 | `node -e "require('@modelcontextprotocol/sdk/server/mcp.js'); require('@modelcontextprotocol/sdk/server/index.js')" ; node client.mjs basic` | require 성공, 알림 3건 수신 | 'cjs require ok function function', 알림 수신 3건(fallback 2 + typed 1), close 13ms | 통과 |
| PRE-MCP-18 | 2026-11-15 10:24:07 KST ~ 2026-11-15 10:24:12 KST | 보고서에 실은 최소 서버·클라이언트 쌍 실행 | `node minimal-client.mjs` | capabilities·instructions·tools·호출·알림 수신·타임아웃/연장이 한 번에 확인된다 | CAPS {experimental:{'claude/channel':{}},tools:{listChanged:true}}, INSTRUCTIONS 일치, TOOLS 2개, CALL 성공, NOTIFY 2건, no-progress 는 -32001 + 서버 abort, progress+reset 은 정상(progressSent 6), 'shutdown: stdin end', exit=0 | 통과 |

미확인으로 남은 것:
- Claude Code(실제 호스트)가 tools/call 에 적용하는 타임아웃 값과 progress 로 타임아웃을 리셋하는지 여부. 실측은 SDK Client 기본 동작뿐이다.
- Claude Code 가 notifications/claude/channel 을 실제로 세션에 주입하는지. 이 작업에서는 SDK Client 수신과 공식 문서 계약만 확인했다.
- Claude Code 가 stdout 오염(비 JSON 줄)을 만났을 때의 동작. SDK Client 는 연결을 유지했지만 다른 호스트는 다를 수 있다.
- Claude Code·Codex 등 실제 호스트가 종료할 때 MCP 서버에 보내는 신호 순서와 대기 시간. SDK StdioClientTransport 의 순서(stdin end → 2초 → SIGTERM → 2초 → SIGKILL)만 확인했다.
- Windows 에서의 stdin close·신호 처리·고아 프로세스 동작. macOS 에서만 실행했다.
- meta 값에 문자열이 아닌 값을 넣었을 때 Claude Code 의 처리. 문서는 Record<string,string> 으로만 명시한다.
- zod 3.25 계열과의 조합. zod 4.6.7 로만 실행했다.
- Node 18/20/22 에서의 동작. Node v26.12.1 로만 실행했다.
- maxTotalTimeout 초과 시 취소 알림 지연이 SDK 의 의도된 동작인지 버그인지. 이슈 트래커는 확인하지 않았다.

### 타 에이전트 자동 수신 조사

| 실행 ID | 시각(KST) | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|
| PRE-ALT-01 | 2026-11-15 10:19:01 KST ~ 2026-11-15 10:19:01 KST | 설치된 CLI 버전 확인 | `which codex claude; codex --version; claude --version` | 두 CLI의 경로와 버전이 출력된다 | ~/.local/bin/codex, ~/.local/bin/claude, `codex-cli 0.169.0`, `2.1.325 (Claude Code)` | 통과 |
| PRE-ALT-02 | 2026-11-15 10:19:01 KST ~ 2026-11-15 10:19:01 KST | Codex 최상위 도움말에서 서브커맨드 목록 확인 | `codex --help` | exec, mcp, app-server 등 서브커맨드가 나온다 | exec, mcp, app-server(experimental), remote-control(experimental), resume, queue, fork, features 등이 나왔다. mcp-server는 목록에 없다 | 통과 |
| PRE-ALT-03 | 2026-11-15 10:19:05 KST (추정, 10:19:01과 10:19:15 사이) ~ 2026-11-15 10:19:15 KST 이전 | Codex MCP 등록 명령과 비대화식 실행·이어가기 옵션 확인 | `codex mcp --help; codex mcp add --help; codex mcp list --help; codex exec --help; codex exec resume --help` | stdio 서버 등록 형식과 resume 인자가 출력된다 | `codex mcp add [OPTIONS] <NAME> (--url <URL> \| -- <COMMAND>...)`, `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, `--last`, `--all`, `--json` 확인. resume 도움말에 --sandbox, -C, --add-dir 없음 | 통과 |
| PRE-ALT-04 | 2026-11-15 10:19:05 KST (추정) ~ 2026-11-15 10:19:15 KST 이전 | Codex queue, app-server, remote-control, resume, features 도움말 확인 | `codex queue --help; codex app-server --help; codex remote-control --help; codex resume --help; codex features --help; codex mcp-server --help` | 각 서브커맨드의 사용법이 출력된다 | `codex queue [OPTIONS] --thread <THREAD> --message <TEXT>`와 `--resume` 확인. app-server `--listen stdio://\|unix://\|ws://IP:PORT\|off` 확인. `codex mcp-server --help`는 최상위 도움말을 출력해 해당 서브커맨드를 확인하지 못했다 | 부분 검증 |
| PRE-ALT-05 | 2026-11-15 10:19:15 KST ~ 2026-11-15 10:19:15 KST | Claude Code 도움말에서 비대화식·이어가기 옵션과 채널 플래그 표시 여부 확인 | `claude --help; claude mcp --help` | -p, --resume, --continue, --output-format이 나온다 | `-p, --print`, `-r, --resume [value]`, `-c, --continue`, `--output-format`, `--mcp-config`, `--permission-mode` 확인. `--channels`와 `--dangerously-load-development-channels`는 도움말에 없다 | 통과 |
| PRE-ALT-06 | 2026-11-15 10:19:20 KST (추정) ~ 2026-11-15 10:21 KST 이전 | Codex 추가 서브커맨드 도움말 확인 | `codex app-server daemon --help; codex app-server proxy --help; codex mcp get --help; codex exec fork --help; codex features list --help; codex agents --help` | 데몬 관리 명령이 출력된다 | `codex app-server daemon` 하위 명령 bootstrap, start, restart, update, enable-remote-control, disable-remote-control, stop, version 확인 | 통과 |
| PRE-ALT-07 | 2026-11-15 10:21 KST 경 ~ 2026-11-15 10:24:37 KST 이전 | Codex 소스에서 MCP 알림 처리, capability 선언, 타임아웃 기본값, queue 구현 확인 (읽기만) | `curl -sS https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/codex-rs/codex-mcp/src/rmcp_client.rs 등 → grep -n "DEFAULT_TOOL_TIMEOUT\\|DEFAULT_STARTUP_TIMEOUT\\|ProtocolVersion\\|capabilities\."` | 문서와 같은 60초/10초 기본값이 소스에 있다 | 태그 rust-v0.169.0에서 `DEFAULT_STARTUP_TIMEOUT = 30s`, `DEFAULT_TOOL_TIMEOUT = 300s`. 문서와 불일치. capability는 elicitation만, protocolVersion 2025-06-18 | 부분 검증 |
| PRE-ALT-08 | 2026-11-15 10:24 KST 경 ~ 2026-11-15 10:24:37 KST | Codex MCP 공식 문서 원문에서 타임아웃 기본값 재확인 | `curl -sSL "https://learn.chatgpt.com/docs/extend/mcp?surface=cli" → python3 -I 로 태그 제거 후 tool_timeout_sec 주변 문자열 추출` | `Default: 60`, `Default: 10` 문구가 있다 | `startup_timeout_sec (optional) ... Default: 10. tool_timeout_sec (optional) ... Default: 60.` 확인 | 통과 |
| PRE-ALT-09 | 2026-11-15 10:24:40 KST 경 ~ 2026-11-15 10:25:26 KST 이전 | MCP TypeScript SDK 기본 요청 타임아웃 확인 | `curl -sSL https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/{1.20.0,v1.x}/src/shared/protocol.ts \| grep -n DEFAULT_REQUEST_TIMEOUT_MSEC` | 60000 | 1.20.0과 v1.x 모두 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`. main 경로는 404 | 통과 |
| PRE-ALT-10 | 2026-11-15 10:25:26 KST ~ 2026-11-15 10:25:26 KST | 프로젝트 폴더를 건드리지 않았는지 확인 | `cd <repo> && git status --short` | 시작 시점과 같은 `?? docs/`만 나온다 | `?? docs/` | 통과 |
| PRE-ALT-11 |  ~  | 자동 수신 방안의 실제 동작 검증 (wait_for_messages 반복 호출, codex queue, codex exec resume, claude -p --resume) | `실행하지 않음` | 메시지 도착 시 에이전트가 새 턴을 시작한다 | 과금되는 모델 호출과 대화형 세션이 금지되어 실행하지 않았다 | 미실행 |

미확인으로 남은 것:
- Codex 0.169.0에서 tool_timeout_sec 미설정 시 실제 적용 시간이 60초(문서)인지 300초(소스)인지 실측하지 않았다.
- tool_timeout_sec의 상한값 존재 여부. 소스 call_tool 경로에서 상한을 찾지 못했을 뿐 전체를 확인하지 않았다.
- `codex queue --resume`이 사용자가 열어 둔 대화형 TUI 세션에 메시지를 넣었을 때 화면과 턴이 어떻게 보이는지 실행해 보지 않았다. 테스트 이름과 본문으로만 추정했다.
- `codex queue`가 요구하는 로컬 데몬이 기본으로 떠 있는지, 설치 스크립트가 `codex app-server daemon start`를 불러야 하는지 확인하지 않았다.
- `codex exec -s workspace-write resume <ID> ...`처럼 상위 `exec` 옵션을 resume 앞에 두면 적용되는지, 그리고 resume 시 원래 세션의 샌드박스·cwd 설정이 유지되는지 확인하지 않았다.
- 같은 세션 ID를 대화형 TUI와 `codex exec resume`이 동시에 쓸 때의 동작.
- Codex에서 MCP tool 호출이 `codex exec`와 대화형 각각에서 승인 없이 실행되려면 `default_tools_approval_mode`를 어떤 값으로 둬야 하는지 문서에 값 목록만 있고 각 값의 정확한 의미(특히 auto와 approve의 차이)는 확인하지 못했다.
- Codex hooks가 `codex exec`에서도 실행되는지 문서에 없다. Stop hook 연속 차단 횟수 상한도 Codex 쪽은 확인하지 못했다.
- Claude Code가 MCP sampling을 지원하지 않는다는 판단은 MCP 문서에 'sampling' 문자열이 없다는 점에서 추정한 것이다.
- Claude Code inbox socket에 외부 스크립트가 보낼 메시지 줄의 JSON 형식. 인증 줄 형식만 문서에서 확인했다.
- Claude Code에서 2분 넘게 걸려 백그라운드로 넘어간 `wait_for_messages` 호출이 끝났을 때 유휴 세션이 새 턴을 시작하는지 실행해 보지 않았다.
- Codex 외 다른 에이전트(Cursor, Gemini CLI 등)의 tool 타임아웃은 조사하지 않았다. TypeScript SDK 기본값 60초만 확인했다.
- `codex mcp-server` 서브커맨드는 0.169.0 도움말 목록에 없고 `codex mcp-server --help`가 최상위 도움말을 출력했다. 숨김 명령 여부는 확인하지 않았다.
- main 브랜치 소스(logging_client_handler.rs, queue_cmd.rs)는 2026-11-15 커밋 3b8bd2e 기준이며 0.169.0 태그와 같은지 파일별로 대조하지 않았다. 타임아웃 상수, capability 선언, queue 관련 파일은 태그에서 확인했다.

### WebRTC 라이브러리 실측

| 실행 ID | 시각(KST) | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|
| PRE-RTC-01 | 2026-11-15 10:19:02 KST ~ 2026-11-15 10:19:27 KST | 세 후보의 버전·라이선스·engines·프리빌트 패키지 조회 | `npm view node-datachannel\|werift\|@roamhq/wrtc name version license engines optionalDependencies time dist-tags scripts --json; npm view @node-datachannel/<platform> version os cpu libc; npm view @roamhq/wrtc-<platform> version os cpu` | 세 패키지의 최신 버전과 대상 5개 플랫폼 프리빌트 존재 여부 확인 | node-datachannel 0.33.6 (MPL 2.0, node>=18.20.0, 9개 플랫폼 패키지), werift 0.27.0 (MIT, node>=22), @roamhq/wrtc 0.10.0 (BSD-2-Clause, engines 없음, 5개 플랫폼 패키지) | 통과 |
| PRE-RTC-02 | 2026-11-15 10:19:27 KST ~ 2026-11-15 10:19:33 KST | 세 후보 실제 설치 (콜드 캐시)와 Node 26 로드 | `cd $B/<ndc\|werift\|wrtc> && npm init -y && npm install <pkg>@<ver> ws@8 --cache $B/npmcache/<dir> --foreground-scripts --no-audit --no-fund; node -e 'require(...)'; node --input-type=module -e 'import ...'` | 네이티브 빌드 없이 설치 성공, 로드 성공 | 모두 exit=0. node-datachannel 1735ms/4패키지/9.6MB, werift 1580ms/12패키지/25MB, @roamhq/wrtc 2227ms/5패키지/24MB(domexception deprecated 경고). 컴파일 없음. CJS 로드 3종 성공, ESM import 는 node-datachannel·werift 성공 | 통과 |
| PRE-RTC-03 | 2026-11-15 10:24:01 KST ~ 2026-11-15 10:24:36 KST | (a) 두 프로세스 연결, iceServers 없음 | `cd $B/common && node run.mjs pair <ndc\|ndc-poly\|werift\|wrtc> none` | DataChannel 열림과 양방향 hello·ack | 네 구성 모두 connected:true. 열림 시간 offer측/answer측: ndc 22/14ms, ndc-poly 22/14ms, werift 186/166ms, wrtc 11/9ms. host candidate 만 생성. 정상 종료 exit 0 | 통과 |
| PRE-RTC-04 | 2026-11-15 10:25:47 KST ~ 2026-11-15 10:26:13 KST | (a) 두 프로세스 연결, 구글 공용 STUN | `cd $B/common && node run.mjs pair <ndc\|ndc-poly\|werift\|wrtc> stun` | 연결 성립과 srflx candidate 수집 | 모두 connected:true. ndc 20/14ms(srflx@45ms), ndc-poly 20/13ms, werift 278/211ms(srflx 포함 SDP, setLocalDescription 54ms), wrtc 14/13ms(연결이 먼저 끝나 srflx 미표시; 단독 수집 시험에서는 46ms 에 srflx 확인). 선택된 쌍은 host<->host, relay 0개 | 통과 |
| PRE-RTC-05 | 2026-11-15 10:26:49 KST ~ 2026-11-15 10:28:20 KST | (b) 4피어 full mesh 와 offer 규칙 | `cd $B/common && node run.mjs mesh <ndc\|ndc-poly\|werift\|wrtc> none 4; node run.mjs mesh <ndc\|werift> stun 4` | 각 피어가 3개 채널을 열고 3명에게서 hello·ack 수신, offer 는 작은 ID 쪽만 | 6회 실행 모두 fullMesh:true, 오류 0건. offer 방향이 ID 순서와 일치(p1→p2,p3,p4; p2→p3,p4; p3→p4). 전원 exit 0 | 통과 |
| PRE-RTC-06 | 2026-11-15 10:28:20 KST ~ 2026-11-15 10:29:55 KST | (c) 상대 강제 종료·멈춤 감지 | `cd $B/common && node run.mjs kill <lib> SIGKILL 90000; node run.mjs kill <lib> SIGSTOP 90000` | 끊김 이벤트와 걸린 시간 관찰 | ndc: +26.97초 failed→closed, dc onClosed. ndc-poly: +26.97초 closed 만. werift: +26.87초 failed(dc close 없음). wrtc: +6.5초 disconnected, +16.6초 failed(dc close 없음). ws leave 는 SIGKILL 시 +4~13ms, SIGSTOP 시 없음 | 통과 |
| PRE-RTC-07 | 2026-11-15 10:30:15 KST ~ 2026-11-15 10:31:32 KST | (d) 연결 불가 시 상태 이벤트 | `cd $B/common && node run.mjs mute <lib> 75000; node run.mjs dropcand <lib> 75000; node run.mjs fakecand <lib> 75000` | 라이브러리가 제한 시간 안에 failed 를 내는지 | mute: 네 구성 모두 76초 동안 이벤트 없음. dropcand: ndc 39.5초 failed→closed, ndc-poly 39.5초 closed, werift·wrtc 없음. fakecand: ndc 39.5초 failed, ndc-poly 39.5초 closed, werift 없음, wrtc 15.4초 failed | 부분 검증 |
| PRE-RTC-08 | 2026-11-15 10:31:51 KST ~ 2026-11-15 10:36:31 KST | (f) 순서·신뢰성·최대 메시지 크기 | `cd $B/common && node run.mjs big <ndc\|ndc-poly\|werift\|wrtc>; node run.mjs big ndc 1048576` | 순서 보장, 기본 한도 확인 | 네 구성 모두 2000개 순서대로 수신. ndc: 262144 통과, 262145 는 'Message size exceeds limit' 예외. werift: 65536 통과, 65537 예외. wrtc: 262145 전송 뒤 채널 닫힘. ndc 에 maxMessageSize 1048576 지정 시 1MB 수신 | 통과 |
| PRE-RTC-09 | 2026-11-15 10:32:24 KST ~ 2026-11-15 10:32:33 KST | offer 충돌(glare)과 재입장 | `cd $B/common && node run.mjs glare <lib>; node run.mjs rejoin <lib>` | 규칙 없이는 실패, 규칙 있으면 재입장 성공 | glare: 네 구성 모두 채널 0개 열림(ndc 는 512ms 에 failed). rejoin: 네 구성 모두 양쪽 경우 성공, 157~340ms | 통과 |
| PRE-RTC-10 | 2026-11-15 10:32:49 KST ~ 2026-11-15 10:33:14 KST | (g) 종료 정리 | `cd $B/common && node run.mjs exit <lib> full\|nocleanup\|none` | 이벤트 루프가 끝나 프로세스가 스스로 종료 | full: 네 구성 모두 6~15ms 에 exit 0. nocleanup: ndc 네이티브·werift·wrtc 는 종료, ndc-poly 는 20초 뒤에도 미종료. none: 네 구성 모두 미종료 | 부분 검증 |
| PRE-RTC-11 | 2026-11-15 10:34:40 KST ~ 2026-11-15 10:35:55 KST | (e) relay candidate 생성 조건과 필터 | `cd $B/turn && TURN_PORT=34780 node server.cjs &; cd $B/common && node run.mjs relay <ndc\|werift> 34780 [NORELAY] [relay]` | TURN 설정 시에만 relay 생성, 필터로 전달 차단 | TURN 설정 시 ndc·werift 모두 relay/udp 1개 생성. NORELAY 필터로 양쪽 1건씩 차단, 선택 쌍 host<->host. ndc policy=relay 는 연결되고 선택 쌍 타입이 srflx<->prflx 로 보고됨. werift policy=relay 는 이 TURN 서버로 연결 안 됨 | 통과 |
| PRE-RTC-12 | 2026-11-15 10:36:20 KST ~ 2026-11-15 10:36:31 KST | 선택 의존성 제외 설치 | `cd $B/ndc-noopt && npm install node-datachannel@0.33.6 --omit=optional && node -e 'require("node-datachannel")'` | 프리빌트가 없으면 로드 실패 | 설치는 성공(2패키지), 로드 시 'Cannot load native addon for node-datachannel on darwin (arm64) ... avoid --no-optional / --omit=optional' 오류 | 통과 |
| PRE-RTC-13 | 2026-11-15 10:36:31 KST ~ 2026-11-15 10:36:43 KST | 라이브러리 간 상호 연결 | `cd $B/common && node run.mjs mixed x ndc werift; mixed x werift ndc; mixed x ndc wrtc; mixed x ndc-poly ndc` | 연결과 메시지 교환 | 4쌍 모두 connected:true. 열림 시간 ndc↔werift 165ms, werift(offer)↔ndc 1061ms, ndc↔wrtc 72ms, ndc-poly↔ndc 21ms | 통과 |
| PRE-RTC-14 | 2026-11-15 10:37:03 KST ~ 2026-11-15 10:37:14 KST | node-datachannel 연결·종료 반복 메모리 | `cd $B/ndc && node --expose-gc churn.cjs 300` | RSS 가 크게 늘지 않고 cleanup 후 종료 | RSS 23.2MB(50회) → 24.8MB(300회), 11.4초 소요, cleanup() 9ms, exit=0 | 통과 |
| PRE-RTC-15 | 2026-11-15 10:38:16 KST ~ 2026-11-15 10:38:36 KST | 추천 라이브러리 최소 예제 1차: mesh, 멈춘 피어 감지, 연결 시간 초과, 종료 | `cd $B/example && npm install; PORT=8799 node signal-server.mjs &; HEARTBEAT_MS=2000 DEAD_MS=6000 CONNECT_TIMEOUT_MS=5000 node peer.mjs alice\|carol\|bob ws://127.0.0.1:8799 &; kill -STOP <carol>; MUTE=1 로 응답 없는 피어 zed 입장; kill -TERM <alice> <bob>` | 3피어 mesh 와 메시지 교환, 멈춘 피어를 DEAD_MS 근처에 감지, 응답 없는 피어를 5000ms 에 실패 처리, exit 0 | 3피어 모두 서로의 chat 수신. carol SIGSTOP(01:38:20Z) 후 bob 5.4초·alice 7.2초에 'no traffic for 6000ms'. zed 는 5000ms 에 'direct connection not established'. alice·bob·signal exit=0 | 통과 |
| PRE-RTC-16 | 2026-11-15 10:38:50 KST ~ 2026-11-15 10:39:28 KST | 추천 라이브러리 최소 예제 2차: 원격 정상 종료와 라이브러리 수준 끊김 | `cd $B/example && PORT=8798 node signal-server.mjs &; DEAD_MS=120000 HEARTBEAT_MS=2000 node peer.mjs alice\|bob\|carol ws://127.0.0.1:8798 &; kill -TERM <carol>; kill -STOP <bob>; 33초 대기; kill -TERM <alice>` | 원격 종료 즉시 감지, 멈춘 피어는 라이브러리 이벤트로 감지, 콜백 안에서 close 해도 문제없이 exit 0 | carol 종료 3ms 뒤 alice·bob 이 'channel closed by remote'. bob SIGSTOP(01:38:54Z) 약 16초 뒤 alice 가 'connection closed'. carol·alice exit=0 | 통과 |
| PRE-RTC-17 | 2026-11-15 10:39:42 KST ~ 2026-11-15 10:40:13 KST | srflx 만으로 연결 (NAT hairpin) | `cd $B/common && ONLY_TYP=srflx node run.mjs pair ndc stun` | hairpin 이 되면 연결 | 6초 안에 연결되지 않음(connecting/checking 유지). 이 네트워크는 hairpin 미지원으로 보이며, STUN 경로 검증으로는 쓸 수 없었다 | 차단 |
| PRE-RTC-18 | 2026-11-15 10:40:20 KST ~ 2026-11-15 10:40:45 KST | TypeScript 타입 확인 | `cd $B/tscheck && npm install typescript@5 @types/node node-datachannel@0.33.6 werift@0.27.0 && node_modules/.bin/tsc -p . (ndc.ts, wer.ts 각각)` | ESM import 와 타입이 오류 없이 통과 | node-datachannel: 오류 없음. werift: multicast-dns 타입 누락 TS7016 1건, --skipLibCheck 로 통과 | 부분 검증 |

미확인으로 남은 것:
- Linux x64/arm64, Windows x64, macOS x64 에서의 실제 설치·실행. npm registry 메타데이터와 README 로만 확인했다.
- 서로 다른 PC·서로 다른 NAT 사이에서 STUN(srflx) 경로로 연결되는지. 한 PC 안에서만 측정했고, srflx 만 쓰는 시험은 hairpin 불가로 연결되지 않았다.
- PRD 완료 기준인 '서로 다른 PC 4대' 연결. 한 PC 의 4개 프로세스로만 확인했다.
- 대칭 NAT 등 실제 연결 불가 환경에서 failed 이벤트가 나오는 시간. 도달 불가 주소(192.0.2.1)로 바꿔 넣는 방식으로만 재현했다.
- STUN 서버가 차단되거나 DNS 조회가 실패하는 네트워크에서의 수집 지연과 연결 시간.
- node-datachannel 의 소실 감지 시간(26.97초)과 연결 실패 시간(39.5초)을 설정으로 줄일 수 있는지. RtcConfig 타입에 해당 항목이 없다는 것만 확인했다.
- 시그널링 필터만으로 relay 가 완전히 차단되는지. 로컬 relay 주소에서 직접 검사 패킷을 보내는 경우는 실험하지 않았다(추론).
- getSelectedCandidatePair() 가 실제 인터넷 TURN 서버에서도 relay 를 srflx 로 보고하는지. 로컬 node-turn(127.0.0.1) 한 가지 구성에서만 관찰했다.
- 바이너리 메시지(sendMessageBinary) 송수신과 bufferedAmount 기반 역압 동작.
- 장시간(수 시간) 연결 유지 시 안정성과 메모리. 연결·종료 300회 반복(11초)만 측정했다.
- node-datachannel 과 @roamhq/wrtc 의 Node 26 공식 지원 표기. 문서에는 없고 이 PC 에서 동작만 확인했다.
- @roamhq/wrtc 의 TypeScript 타입 품질과 종료 시 크래시 여부. 정상 종료 3가지 경우만 봤다.
- MPL-2.0 의 법적 해석. 의존성으로 쓰는 데 제약이 없다는 것은 가정이다.
- Windows 방화벽 등 OS 가 UDP 수신을 막거나 승인 창을 띄우는 경우의 동작.
- 네이티브 API 의 DataChannel 기본 ordered/reliable 값을 getter 로 직접 읽는 것. polyfill 속성값과 2000개 순서 수신으로 간접 확인했다.
- 예제 코드의 인증·방 구분·메시지 중복 제거. 예제에 포함하지 않았다.