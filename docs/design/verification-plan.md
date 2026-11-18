# 검증 계획

구현을 "검증 우선"으로 진행하기 위한 계획이다. 틀리면 설계가 바뀌는 외부 가정을 먼저 확인하고, 작은 제품 단위를 검증한 뒤 같은 코드를 조립해 다시 검증한다.

- 상태: **마감(2026-11-16).** `V-U*`, `V-L*`(`V-L9` 포함), `V-P1`~`V-P7`, `V-S1`·`V-S2` 를 실행했고, `V-I3`·`V-I4` 는 헤드리스 변형만 실행했다. `V-I1`·`V-I2`·`V-I5`·`V-I6` 과 대화형 `V-I3`·`V-I4` 는 미실행이다. 판정과 근거 실행 ID 는 [마감 기록](../../tests/test-history/2026-11-16-final-close.md)의 완료 기준 현황표와 [이력 색인](../../tests/test-history/README.md)에 있다. 아래 통과 기준은 실행 전에 고정한 것 그대로다(실행 결과로 바꾸지 않는다). 구현 전 조사([이력](../../tests/test-history/2026-11-15-pre-implementation-assumptions.md))와 AWS 탐색 스택 실측([이력](../../tests/test-history/2026-11-15-aws-apigw-websocket-probe.md))은 제품 경로의 통과가 아니다.
- 검증 환경: **이 PC 한 대(프로세스 여러 개)와 배포된 공용 서버.** 추가 장비(다른 PC, 임시 서버)는 쓰지 않는다.

## 1. 원칙

| 증거 수준 | 뜻 | 무엇의 증거가 되나 |
|---|---|---|
| **대역** | 가짜 저장소·소켓·시계로 제품 규칙을 돌린다 | 제품 규칙. 외부 동작의 증거는 아니다 |
| **로컬 실물** | 실제 프로세스, 실제 `ws`, 실제 `node-datachannel`, 실제 MCP stdio 를 이 PC 에서 돌린다 | 프로토콜·순서·수명. 실제 망의 증거는 아니다 |
| **실제 환경** | 배포된 공용 서버, 실제 에이전트 세션 | 그 환경에서 관찰한 범위까지 |

- 가정은 그 가정이 말하는 대상에서 확인한다. 대역이 만든 외부 동작은 외부 가정의 증거가 아니다.
- 검증 코드는 **제품의 공개 진입점**을 부른다. 탐색 코드나 복사본의 통과를 제품 통과로 세지 않는다.
- 결과는 **통과 / 부분 검증 / 실패 / 미실행**으로 구분한다. 빌드·타입 검사 통과와 0건 실행은 동작 통과가 아니다. 환경 때문에 건너뛴 것은 통과로 세지 않는다.
- 판정은 고정 대기가 아니라 기한이 있는 조건으로 한다. 실패했을 때 대기 시간을 늘리거나 단언을 지워서 통과시키지 않는다.
- 관찰이 설계와 다르면 그 가정에 기대는 작업을 멈추고, 증거와 영향을 남기고, 설계 문서를 고친다.

## 2. 먼저 확인할 외부 가정

"선행"은 그 확인에 필요한 구현 묶음이다([implementation-plan.md](implementation-plan.md#3-작업-묶음)). "지금 근거"의 `PRE-…` 는 구현 전 조사의 실행 ID 다.

### 2.1 WebRTC

| ID | 질문 | 통과 기준 | 환경 | 선행 | 틀리면 바뀌는 것 | 지금 근거 |
|---|---|---|---|---|---|---|
| A-RTC-1 | 서로 다른 PC·NAT 사이에서 STUN 만으로 직접 연결되는가 | 서로 다른 망의 두 PC 가 15초 안에 입장한다 | **PC 2대 이상. 이 PC 로는 불가** | W6 | 연결 기한. 실패가 흔하면 제품의 쓸모 자체 | 한 PC 안에서만 실측. srflx 만으로는 연결되지 않았다(PRE-RTC-17) |
| A-RTC-2 | `offer-request` → `offer` 흐름, 후보 묶음, 두 큐, 재전송이 동작하는가 | 제품 `mesh` 로 두 프로세스 연결 100회 성공. 시험용 프록시로 다음을 각각 본다. (가) 후보를 `offer` 보다 먼저 도착시켜도 연결되고 **대기 큐에서 꺼내 넣은 후보 수가 1 이상**이다. (나) answer 쪽이 보낸 후보를 모두 버려도, `offer` 보다 먼저 온 offer 쪽 후보만으로 연결된다. (다) `offer-request`, `offer`, `answer`, 후보 묶음을 하나씩 버려도 15초 안에 연결된다. (라) 재전송으로 같은 후보가 두 번 와도 한 번만 넣는다 | 이 PC | W3 | 접촉 규칙. 후보 묶음을 버리고 낱개로 보내기. 서버 알림을 다시 넣는 방안 | "작은 ID 가 offer"까지만 실측(PRE-RTC-05, 09). 후보 시점은 PRE-RTC-04 |
| A-RTC-3 | 교체 확인이 동작하고, 열린 링크를 새 pc 로 바꿔도 안전한가 | 살아 있는 링크에 새 요청을 200회 보내도 교체 0회. 상대를 죽인 뒤의 요청은 2초 뒤 교체된다. 교체 200회 뒤 링크 1개, 크래시 0, RSS 증가 20% 이하 | 이 PC | W3 | "닫힘을 확인한 뒤 수락"으로 변경. 확인 기한 | 재입장 재연결(PRE-RTC-09), 300회 반복 메모리(PRE-RTC-14) |
| A-RTC-4 | 8 피어 mesh 가 한 번에 서는가 | 8 프로세스가 20초 안에 전원 연결. 연결별 시그널 수 60초 300건 이하. 쌍마다 보낸 시그널 수를 기록한다 | 이 PC | W6 | 정원, 속도 제한 값, 스로틀 기본값 | 4 피어 실측(PRE-RTC-05). **W9 조립 실측(같은 PC)**: 1개가 만들고 7개가 동시에 입장해 207~253ms 에 28쌍 전원 연결. 60초 동안 연결별 시그널 14~19건, 쌍마다 4~5건(`offer-request`·`offer`·`answer`·후보 묶음 2). 가장 큰 `signal` 577바이트([이력](../../tests/test-history/2026-11-15-w9-assembly.md)) |
| A-RTC-5 | SDP 와 후보 묶음이 크기 상한 안인가 | 관찰한 최대 `signal` 메시지가 16384바이트 이하(IPv6·VPN 인터페이스가 있는 상태 포함) | 이 PC | W3 | `SIGNAL_MAX_MESSAGE_BYTES`, 묶음당 후보 수 | 미실측 |
| A-RTC-6 | 종료 예산 안에 `bye` 가 도착하고 프로세스가 끝나는가 | 링크 7개에서 30회: `bye` 수신 100%, 종료 400ms 이하 | 이 PC | W6 | 예산 배분. 안 되면 `bye` 를 포기하고 끊김 판정에 맡긴다 | 네이티브 정리 7~15ms(PRE-RTC-10). **W9 조립 실측(같은 PC)**: 링크 7개에서 SIGTERM 30회, `bye` 수신 210/210, 종료 10~35ms(두 실행). 서버를 멈춘 채 5회도 7/7, 312~332ms(세션 정리가 예산을 넘긴 1회 329ms)([이력](../../tests/test-history/2026-11-15-w9-assembly.md)) |

### 2.2 MCP 와 에이전트 호스트

| ID | 질문 | 통과 기준 | 환경 | 선행 | 틀리면 바뀌는 것 | 지금 근거 |
|---|---|---|---|---|---|---|
| A-MCP-1 | 실제 Claude Code 세션에서 개발 채널이 등록되고, 유휴 세션이 채널 사건으로 턴을 시작하는가 | 점검 알림 뒤 `confirm_channel` 이 사람 입력 없이 호출된다. 유휴 상태에서 다른 프로세스의 채팅에 반응한다 | **대화형 세션, 사람의 승인, 모델 호출** | W5 | channel 모드를 버리고 poll 만 쓴다 | 문서, 바이너리 문자열, SDK 프로브(PRE-CH-07, 10). 실제 세션은 미실행(PRE-CH-13) |
| A-MCP-2 | 작업 중 도착한 채널 사건이 tool 경계에서 보이는가, 턴이 끝나야 보이는가 | `wait_for_messages` 반복 중 점검 알림이 보이는 시점을 기록한다 | 위와 같음 | A-MCP-1 | [mcp-interface.md 7.3](mcp-interface.md#73-호스트별-조건-설치가-안내한다)의 두 안내 중 어느 쪽을 쓰는지 | 문서 "next turn" |
| A-MCP-3 | 호스트가 MCP 서버를 끝낼 때의 신호 순서와 유예는 얼마인가 | Claude Code, Codex 각각에서 종료 로그(`cause`, `duration_ms`)와 `bye` 도착 여부를 기록한다 | 실제 호스트 | W5 | `SHUTDOWN_BUDGET_MS` | Claude Code 문서 값. SDK 클라이언트는 2초(PRE-MCP-07). 마감의 헤드리스 세션(`claude -p`, `codex exec`)에서 MCP 진단 로그의 종료 원인이 `stdin_end` 였다. 신호 순서와 유예는 재지 않았다([이력](../../tests/test-history/2026-11-16-final-sessions.md)) |
| A-MCP-4 | Claude Code 에서 100초 대기가 백그라운드로 옮겨지지 않고 poll 반복이 유지되는가 | [`V-I3` 의 기준](#35-실제-에이전트-세션)을 채운다. 빈 대기 횟수와, 턴이 끝난 뒤 도착한 글이 어떻게 됐는지를 기록한다 | 대화형 세션, 모델 호출 | W5 | Claude Code 의 대기 상한. 유지되지 않으면 그 호스트를 "턴이 살아 있는 동안만"으로 보고하고 [대안](mcp-interface.md#73-호스트별-조건-설치가-안내한다)을 검토한다 | 문서(2분). **헤드리스만 실측**(I-FS-04, `claude -p`): 100초 대기 14번이 같은 턴 안에서 돌아왔고 백그라운드로 옮겨지지 않았다. 15/15 를 5분 안에 답했다. 대화형과 턴이 끝난 뒤의 글은 미실행([이력](../../tests/test-history/2026-11-16-final-sessions.md)) |
| A-MCP-5 | Codex 에서 poll 반복이 유지되고 `tool_timeout_sec` 설정이 적용되는가 | [`V-I4` 의 기준](#35-실제-에이전트-세션)을 채운다. 540초 대기 1회 성공. 설정이 없을 때의 실제 한도 측정 | Codex 세션, 모델 호출 | W5, W8 | Codex 대기 상한, 설치의 설정 편집. 유지되지 않으면 A-MCP-4 와 같다 | 문서 60초, 소스 300초(PRE-ALT-07, 08). **헤드리스만 실측**(I-FS-05·06, `codex exec`, 실제 홈에 설치한 `tool_timeout_sec = 600`): 15/15 를 5분 안에 답했고 540초 대기 1회가 호스트 기한 없이 서버 쪽 `timeout` 으로 돌아왔다. 모델은 스스로 10~50초 대기를 골랐다. 설정이 없을 때의 실제 한도는 재지 않았다([이력](../../tests/test-history/2026-11-16-final-sessions.md)) |
| A-MCP-6 | 채널 capability 선언이 다른 호스트에서 문제를 일으키는가 | Codex 가 `AGENT_CHAT_CHANNEL=auto` 서버에 연결하고 tool 을 쓴다 | Codex | W5 | `AGENT_CHAT_CHANNEL` 기본값 | 미확인. 그래서 Codex 에는 `off` 로 설치한다 |
| A-MCP-7 | user scope 등록에 승인 프롬프트가 없는가. tool 첫 호출 승인 뒤 반복 호출이 막히지 않는가. "항상 허용"을 tool 별로 나눠 줄 수 있는가 | 설치 뒤 첫 세션의 프롬프트를 기록한다. `wait_for_messages` 만 항상 허용하고 `join_room` 은 매번 묻게 할 수 있는지 본다 | 대화형 세션 | W8 | 설치 안내 문구, [권한 경계](mcp-interface.md#10-권한-경계)의 안내 범위 | 문서에서 추론. **헤드리스만 실측**: Claude Code `--allowedTools`, Codex `-c 'mcp_servers.agent-chat.tools.<tool>.approval_mode="approve"'` 로 tool 하나씩 그 실행에만 허용할 수 있었고, 허용하지 않은 tool 은 막혔다. Codex `exec` 은 허용이 없으면 MCP tool 호출이 `approval policy is never` 로 실패한다. 대화형 프롬프트의 모습은 미실행([이력](../../tests/test-history/2026-11-16-final-sessions.md)) |
| A-MCP-8 | 채널 본문 안의 태그 문자열을 호스트가 어떻게 다루는가 | `</channel>` 이 든 본문을 보냈을 때 모델에 보이는 형태를 기록한다 | 대화형 세션 | A-MCP-1 | 무력화 규칙 유지 또는 삭제 | 미확인 |
| A-MCP-9 | 호스트가 MCP tool 결과를 얼마까지 그대로 전달하는가 | 24000바이트 결과가 Claude Code 와 Codex 에서 잘리지 않고 모델에 보인다. 한도를 넘겼을 때의 모습을 기록한다 | 대화형 세션 | W5 | `WAIT_MAX_RESULT_BYTES`, `WAIT_MAX_EVENTS` | 미확인. 조사 자료에 값이 없다 |
| A-MCP-10 | 설치 전후에 비교하는 [권한 관련 키의 목록](architecture.md#313-setup)이 이 PC 의 호스트 버전과 맞는가. `codex mcp list --json` 이 서버별 명령·인자·환경 변수를 내는가 | 호스트의 설정 문서와 이 PC 의 설정 파일에서 키 이름을 목록과 대조한다(값은 보지 않는다). 목록에 없는 권한 관련 키가 있으면 `V-S1` 을 실행하기 **전에** 목록에 더한다. `codex mcp list --json` 의 출력 모양을 기록한다 | 이 PC. 사람도 모델도 필요 없다 | W8 | 비교 목록. Codex 의 다른 서버 항목을 읽는 방법(출력이 모자라면 줄 단위 읽기로 바꾼다) | Claude Code 쪽 키 이름과 Codex 의 `trust_level`·`notify` 는 이 PC 의 파일에서 봤다(D-DESIGN-04). `--json` 은 도움말에만 있다(PRE-ALT-03, 06) |

### 2.3 AWS

2026-11-15 에 일회용 탐색 스택으로 쟀다([이력](../../tests/test-history/2026-11-15-aws-apigw-websocket-probe.md)). 스택은 지웠다. 탐색 결과는 제품 경로의 통과가 아니므로, 같은 동작을 배포한 제품으로 `V-P1`~`V-P7` 에서 다시 본다. "상태"는 **실측됨**(탐색 스택에서 봄), **일부**(일부만 봄), **미실측**이다.

| ID | 확인할 동작 | 상태 | 지금 근거 | 틀리면 바뀌는 것 |
|---|---|---|---|---|
| A-AWS-1 | 유휴 끊김, 최대 연결 시간, 크기 한도. 본문 메시지가 유휴 타이머를 되돌리는가 | 일부 | 유휴 600.0초, 4분 간격 앱 메시지로 유지, 메시지 131,072바이트까지(PRE-AWS-07, 08). 프레임 32KB 한도는 문서와 달랐다. **마감 제품 실측(`V-P4`)**: 30초 `ping` 으로 첫 연결이 7199~7200초 이어졌고 119.99~120.00분에 끊겼다. 재접속·재등록 0.38~1.36초, DataChannel 유지([이력](../../tests/test-history/2026-11-16-final-long.md)) | `ping` 주기, 와이어 크기 상한 |
| A-AWS-2 | `$connect` 처리 중 그 연결로 보낼 수 없음. `$connect` 의 상태 코드로 수락·거절 | 실측됨 | 자기 연결 전송은 410. 돌려준 상태 코드와 본문이 핸드셰이크 응답이 됨. 거절된 연결에는 종료 통지 없음(PRE-AWS-03) | 버전 협상 위치, `$connect` 에서의 저장 |
| A-AWS-3 | `$disconnect` 가 오는 시점: 정상 닫힘, 프로세스 강제 종료, 망 단절(멈춘 프로세스) 각각 | 일부 | 정상 닫힘과 강제 종료는 14~29ms(PRE-AWS-06). **W9 제품 실측(`V-P3`)**: 참가자 SIGKILL 뒤 테이블의 기록이 지워지기까지 39~77ms(5회). SIGSTOP(멈춘 프로세스)에는 소켓이 열린 채라 통지가 오지 않고, 오래됨(`lastSeenAt` + 90초)으로만 목록에서 빠졌다(4회, 멈춘 뒤 신규 입장 성공 시작 60.7~76.3초)([이력](../../tests/test-history/2026-11-15-w9-public.md)). **망 단절은 미실측** | 유령 처리의 지연 추정 |
| A-AWS-4 | 사용자 지정 도메인을 쓸 때 연결 관리 API 주소 형식 | 실측됨 | execute-api 주소(`https://<apiId>.execute-api.<리전>.amazonaws.com/<스테이지>`)로 만든 연결 관리 클라이언트가 사용자 지정 도메인으로 들어온 연결에도 닿았다(W2 P-W2-04, 10) | 핸들러의 주소 구성 |
| A-AWS-5 | 서버가 연결을 닫을 때 클라이언트가 보는 종료 코드 | 실측됨 | 게이트웨이가 스스로 닫을 때의 1001, 1009(PRE-AWS-07, 08). 서버가 `DeleteConnection` 으로 닫으면 1000 `Connection Closed Normally`. 바이너리 프레임을 받으면 게이트웨이가 1003 `Binary is not supported` 로 닫고 Lambda 를 부르지 않는다(W2 P-W2-05) | 종료 코드를 계약에 쓸 수 있는지 |
| A-AWS-6 | 스로틀·내부 오류 때 클라이언트가 받는 프레임의 형식 | 일부 | 스로틀: 연결 유지, `{"message":"Too Many Requests"}`, 메시지 폐기(PRE-AWS-10). **`$default` 에서 예외가 났을 때의 프레임은 미실측**. **W9 제품 실측(`V-P5`, `V-P7`)**: 스로틀 프레임은 키 `connectionId`·`message`·`requestId`, `message` 가 `Too Many Requests`. 연결은 유지된다. 접근 로그에는 `status` 429, `error` `Too Many Requests` 로 남고 줄은 JSON 으로 읽힌다. **서버 → 클라이언트 전송(`POST /@connections`)도 429 로 버려지고, 이때 클라이언트에는 아무 프레임도 오지 않는다**([이력](../../tests/test-history/2026-11-15-w9-public.md)) | "게이트웨이 프레임" 판정 규칙 |
| A-AWS-7 | 같은 연결의 연속 메시지가 동시에·역순으로 처리되는가 | 실측됨 | 연속 20건이 10회 중 10회 뒤섞임. 2/20 유실 1회(PRE-AWS-05) | 재전송, 두 큐, 조건부 쓰기의 필요 범위 |
| A-AWS-8 | 매핑 키 없는 사용자 지정 도메인으로 `wss://<도메인>` 접속 | 실측됨 | 접속된다. 단 스택 완료 뒤 약 3분 동안 핸드셰이크가 HTTP 400 이다(W2 P-W2-01, 03) | 접속 주소, 주소 정규화 기본값 |
| A-AWS-9 | action 라우트 없이 모든 본문이 `$default` 로 가는가. 스테이지 배포 방식 | 실측됨 | `action` 없는 본문과 JSON 이 아닌 본문도 `$default`. 템플릿의 배포 자원으로 스택 생성(PRE-AWS-04, 01) | 라우트 구성, 배포 절차 |
| A-AWS-10 | Lambda 런타임과 내장 SDK | 실측됨 | `nodejs24.x` arm64 에서 내장 SDK v3 로 DynamoDB·연결 관리 클라이언트 import. 인라인 코드는 CommonJS(PRE-AWS-02). `nodejs22.x` 는 재지 않았다 | 런타임 값, SDK 를 번들에 넣을지 |
| A-AWS-11 | 스테이지 스로틀의 적용 범위(전체인가 연결별인가) | 실측됨(W9 제품) | 스로틀이 정확한 수에서 끊지 않는다는 것만 봤다(PRE-AWS-10). **W9 제품 실측(`V-P7` 나)**: 다른 연결 24개의 부하가 정상 참가자의 입장과 `pong` 을 막았다. 스테이지 전체에 걸린다. 부하 초당 35 에서 재접속, 45 부터 입장 실패([이력](../../tests/test-history/2026-11-15-w9-public.md)) | 스로틀 값, 남용 대응 |
| A-AWS-12 | 서울 리전 단가 | 미실측 | — | 비용 추정, 스로틀 기본값 |
| A-AWS-13 | 닫힌 연결로의 전송이 410 인가. `GetConnection` 으로 열림·닫힘을 구분할 수 있는가. `$default` 처리 중 자기 연결로 보낼 수 있는가 | 일부 | 닫힌 연결 전송 30건 모두 410(PRE-AWS-06). `$default` 중 자기 전송 됨(PRE-AWS-04). `GetConnection` 은 열린 연결에 200, 닫힌 연결에 410(W2 P-W2-08) | `ConnectionSink` 구현, 이름 충돌 판정 |
| A-AWS-14 | "쓰고, 강한 일관성으로 읽고, 읽은 수로 판정"이 DynamoDB 에서 정원과 방 생성의 유일성을 지키는가 | 실측됨 | 공용 서버에서 정원 초과 0회, 생성 성공 2 이상 0회(각 20회차). 다만 "모두 거절"이 잦다: 정원이 하나 남은 방에 4개 동시 입장 20회 중 16회, 동시 생성 20회 중 11회(W2 P-W2-04, 10). `V-P7` 에서 다시 본다. **W9 제품 실측(`V-P7` 가)**: 정원에 여유가 있는 방에 만들기 1 + 동시 입장 4, 10분씩 쉰 10회 모두 성공(재전송 0~4, 주기 재전송 0)([이력](../../tests/test-history/2026-11-15-w9-public.md)). 정원이 하나 남은 방의 "모두 거절"은 제품 경로로 다시 보지 않았다 | 조건식을 쓰는 방식(같은 실측에서 초과 0회)으로 바꾼다 |

### 2.4 그 밖

| ID | 가정 | 확인 | 틀리면 |
|---|---|---|---|
| A-OPS-1 | 공개 STUN(`stun.l.google.com:19302`)을 기본값으로 써도 된다 | `doctor` 의 D7(입장 뒤 3초 안에 `srflx_seen` 이 참)이 통과하는지 본다. D7 이 경고면 기본값을 바꾸기 전에 `V-L11` 의 `netInfo()` 항목이 통과했는지 먼저 본다(값을 잘못 세어 나온 경고가 아닌지). 이용 조건은 확인하지 않았다 | 기본값을 비우고 사용자가 지정하게 한다 |
| A-TIME-1 | 참가 PC 의 시계 차이는 수십 초 이내다 | `hello.wall` 로 관찰해 기록한다 | 기록의 표시 시각과 동시 쓰기의 승자가 어긋난다. **기한 판정에는 영향이 없다**(경과 시간으로 잰다. [protocol.md 5.5](protocol.md#55-파생-판정)) |
| A-LIC-1 | `node-datachannel` 의 MPL-2.0 은 의존성으로 쓰는 데 제약이 없다 | 법적 검토는 하지 않았다 | 차선(`werift`, MIT)으로 바꾼다 |

### 2.5 확인 순서

1. **끝난 것**: A-AWS-* 의 탐색 실측. 미실측으로 남은 항목(A-AWS-4, 5, 8, 11, 12, 14 와 일부 항목의 나머지)은 제품 배포(G6) 때 본다.
2. **W3 직후**: A-RTC-2, 3, 5. 접촉 규칙과 크기 상한을 확정한다.
3. **W5 최소판 직후**(방 기능 없이 tool 두 개와 채널만): A-MCP-1, 2, 8, 9, 그리고 A-MCP-4, 5, 6. 사람이 필요하므로 일찍 잡는다. **경계를 넘는 가정이라 양쪽 구현이 끝날 때까지 미루지 않는다.**
4. **W6 직후**: A-RTC-4, 6, A-MCP-3.
5. **W8 직후**: A-MCP-7, A-MCP-10. A-MCP-10 은 `V-S1` 을 실행하기 전에 끝낸다. 비교 목록을 실행 뒤에 고치지 않으려는 것이다.
6. A-RTC-1 은 이 환경에서 확인할 수 없다. 미실행으로 남긴다.

## 3. 수준별 검증

### 3.1 대역 (단위·계약)

명령: `npm test` (빌드 뒤 `node --test`).

| ID | 대상 | 확인하는 것 |
|---|---|---|
| V-U1 | `protocol` | 스키마 통과·거절 표본(후보 묶음, 접속 순번, 예약 이름, 확인 기록 파일 포함. `sync_end` 에 `test_id` 와 `test_elapsed_ms` 가운데 하나만 있으면 거절). [주소 정규화 표](protocol.md#6-서버-주소-정규화)의 모든 행과 오류 입력. ICE 검증: `turn:`·`turns:`·`stuns:` 거절, 섞인 목록 전체 거절, `none`, 통과한 값의 `{hostname, port}`(IPv6 는 대괄호 없이, 포트 생략 시 3478). relay 후보 판별. 보내기 전 검증: `encodeP2PFrame`·`encodeClientMessage`·`encodeServerMessage`·`packStateFrames` 가 받는 쪽이 거절하거나 버릴 것을 만들지 않는다(`packStateFrames` 는 글자 필드 4096바이트 초과, 기록 32768바이트 초과, 스키마 위반 기록에 `BAD_FRAME` 이고 프레임을 하나도 만들지 않는다. 모르는 필드는 싣지 않는다). `lc` 와 `wall` 은 `2^53 − 1` 까지 받고 그 위는 거절한다. 공개 진입점(`index.ts`)에 설계가 적은 함수와 다른 모듈이 쓰는 함수가 모두 있다. 공개 표(이름 목록, 오류 표)가 얼어 있다. `Subscribable` 적합성 시험(`protocol/testing.ts`)이 약속을 어긴 구현을 잡는다 |
| V-U2 | `signaling-core` + 메모리 저장소 | `join` 세 모드. 인계와 접속 순번(작은 순번은 기록을 못 바꾼다). 같은 `join` 다시 보내기(판정 없이 `joined`). 이름 충돌. **읽은 수로 하는 정원·생성 판정: 호출을 섞고 겹쳐도 정원 초과 0회, 생성 성공 1 이하.** 없는 방 5회 뒤 닫힘. 오래됨 필터, 전달, 다른 방 격리, 전송 실패 시 삭제, 속도 제한, 늦은 종료 통지의 조건부 삭제 |
| V-U3 | `shared-state` | 무작위 순서·중복 병합의 수렴(시드 기록). [5.6 사례](protocol.md#56-사례) 전부. 특히: 작성자가 떠난 뒤 남은 두 복제본이 재동기화로 같아진다. 상한 직전의 동시 쓰기 뒤 두 복제본이 같다. 식별자가 같고 내용이 다른 기록을 어느 순서로 받아도 같은 쪽이 남는다. 상한에서도 `stop`·`presence` 를 쓸 수 있다. `test` 기록이 있으면 시작을 거절한다. 중단 뒤 주장이 따로 분류된다. 자기 검증 거절(이전 이름 포함)과 병합 시 무효. **경과 시간**([규칙](protocol.md#55-파생-판정)): 시계가 70분 다른 참가자가 테스트를 받아도 바로 중단하지 않는다. 테스트 10분째에 10분을 실은 값을 여러 번 넘겨받아도 경과 시간이 10분에서 벗어나지 않는다. 두 복제본이 30초마다 서로의 값을 번갈아 넘겨받으며 60분을 가도(전달 지연을 0~5초로 섞는다) 어느 쪽 값도 실제로 흐른 시간을 넘지 않는다. 0 에서 시작한 입장자는 받은 값 가운데 가장 큰 것을 따른다. 작거나 같은 값과 다른 `test_id` 의 값은 아무 것도 바꾸지 않는다. `adoptElapsed` 는 바꿨을 때만 `true` 를 돌려준다. **논리 시각의 끝**([5.2](protocol.md#52-논리-시각)): `lc` 가 `2^53 − 1` 인 기록을 병합한 뒤의 `applyLocal`(`set_presence`, `stop_test`, `record_claim`)은 `INVALID_ARGUMENT` 이고 복제본과 지문이 그대로다. 그보다 1 작은 값을 본 뒤에는 한 번 쓸 수 있고 그 기록의 `lc` 가 `2^53 − 1` 이다. `applyLocal` 이 만든 기록과 `snapshot()` 은 `packStateFrames` 를 통과한다 |
| V-U4 | `inbox` | 한 경로로만 전달, 취소 시 커서 유지, `cursor` 재전달, 확인 전 채널 미전송, 넘침 정책. 결과 상한과 `more`. channel 모드의 `wait{cursor}` 가 기다리지 않는다. `pushed_since_last_call` 의 `after_cursor` 로 다시 받으면 놓친 사건이 온다. 확인이 없으면 수신 불명 → `wait_for_messages{cursor}` 가 아닌 다음 호출에 poll 로 돌아간다. `cursor` 없는 `wait_for_messages` 도 돌아가는 호출이고 확인 안 된 사건부터 받는다. `confirm_channel` 도 돌아가는 호출이고 앞 토큰은 `INVALID_ARGUMENT` 다. `listening` 변화 알림. **`discardAll()`**: 내준 사건과 내주지 않은 사건을 모두 버리고 내주지 않은 수를 돌려준다. 그 뒤의 `wait`(옛 `cursor` 포함)은 버린 사건을 주지 않고 새로 넣은 사건부터 준다. 순번이 이어진다. `inbox_dropped` 사건이 생기지 않고 `stats().dropped` 가 그대로다. channel 모드에서 확인 안 된 사건이 없어져 수신 불명과 `pushed_since_last_call` 이 생기지 않는다. 모드와 점검 토큰은 그대로다. 두 이벤트에 `Subscribable` 적합성 시험(`protocol/testing.ts`) |
| V-U5 | `records` | 보고서 분류(성공·실패·미확인·중단 뒤 기록), 거절된 호출 구역, 방 ID 원문이 보고서에 없음, 이름 검증으로 경로 탈출 방지, 파일 권한 |
| V-U6 | `diagnostics` | 허용 필드 필터(중첩 객체, 오류 객체, 개행). `svc` 가 `server`·`lambda` 면 `peer` 가 출력되지 않고 `mcp`·`cli` 면 출력된다. `level` 보다 낮은 사건은 쓰지 않는다. `close(budgetMs)` 가 예산 안에 끝나고 그 뒤의 사건을 버린다(가짜 시계). 모든 줄의 `proc`, 프로세스별 파일과 권한, 7일 직전·경계·직후, `mtime` 을 바꿔도 판정 불변, 디렉터리 상한, 정리 실패, 버퍼 넘침 |
| V-U7 | `RoomStore` 계약 묶음 | 조건부 쓰기, 강한 일관성 읽기, 카운터 원자성. 메모리 구현 대상. 같은 묶음을 `V-P1` 에서 DynamoDB 구현에 실행한다(`npm run test:store`) |
| V-U8 | 정적 검사 | 실행 모듈(설치 CLI 제외)에 `child_process` 없음. permission capability 문자열 없음. SDK 지원 목록에 `2026-07-28` 없음. 모듈 밖에서 내부 파일 import 없음. 형제 모듈의 타입 import 없음. 아래 모듈이 위 모듈을 import 하지 않음. MCP 프로세스의 모듈이 `process.env` 를 직접 읽지 않음(`entry/mcp` 가 통째로 `loadConfig` 에 넘긴다). `src` 가 `tests/support` 를 import 하지 않음. `signal` 로 채팅을 보내는 호출 경로 없음(`room-session` 에서 시그널 전송 함수는 `signal-gate.ts` 만 다룬다). 호스트 CLI 실행은 `setup/host-cli.ts` 뿐이고 그 파일에 시험이 있음. 권한을 넓히는 실행 옵션 문자열 없음. `entry` 밖에서 전역 시계·타이머를 부르지 않음. 모듈 최상위 `let`·`var` 와 전역 객체 사용 없음. 네트워크 내장 모듈·`fs`·`console`·stdout 직접 쓰기는 [정해진 모듈](architecture.md#2-모듈-목록과-의존-방향)에만, 전역 `WebSocket`·`fetch`·`EventSource` 없음. `deployments/`·`scripts/`·`installer/` 에 TURN·중계 설정과 권한을 넓히는 실행 옵션 문자열 없음. Node 내장 모듈은 [허용 목록](architecture.md#2-모듈-목록과-의존-방향)의 것만(`node:module`, `node:process`, `vm`, `inspector`, `dns`, `perf_hooks` 등 없음). MCP SDK 는 정해진 하위 경로만: `mcp-server` 는 서버 쪽과 stdio 전송, `setup` 은 클라이언트 쪽과 stdio 전송이고 클라이언트 stdio 는 `setup/mcp-process.ts` 뿐이며 그 파일에 시험이 있음. `node-datachannel/polyfill` 없음. 인자 없는 `new Date`(괄호를 뺀 것 포함) 없음. 계약끼리의 맞물림(컴파일): ICE 서버 값이 라이브러리의 객체 형태에 맞음, 서버 로그 필드가 `peer` 를 받지 않음. **관전(2026-11-16)**: `monitor` 모듈은 `room-session`·`inbox` 의 `contract.ts` 와 `protocol` 만 import 하고 stdout·`console`·`fs`·네트워크·환경 변수·전역 시계를 쓰지 않음. `entry/monitor` 는 stdout 을 쓸 수 있고 `process.env` 를 통째로만 넘김(`whole`). `createMonitorSink` 가 만든 수신함이 `SessionInbox` 에 맞음(컴파일). `scripts/monitor.sh` 에 TURN·중계 이름과 권한을 넓히는 옵션 문자열 없음 |
| V-U9 | `room-session` (가짜 하위 모듈) | `offer` 가 `joined` 보다 먼저 와도 입장한다. 필수 목록이 모두 빠진 `join` 은 `ROOM_NOT_FOUND`. [`shown_as` 표](mcp-interface.md#34-get_status)의 모든 행, 그리고 입력 조합 전부에서 빠지는 경우가 없다. 연속 실패 2회에 `unreachable` 사건 1회. `attempt-failed{ice, failed}`(서버의 `RELAY_NOT_ALLOWED` 로 끝난 시도 포함)는 필수 목록에서 빼지 않고 입장 실패와 연속 실패로 센다. 빼는 것은 `peer_gone` 과 `bye{leave|shutdown}` 뿐이다. 입장 기한에 아직 시도 중인 필수 피어에 `mesh.expireAttempt` 를 부르고 그 단계와 사유를 오류에 싣는다. **퇴장 뒤 다른 방에 들어가면 앞 방의 사건이 그 방의 사건으로 나오지 않는다**(`leave` 와 입장 실패·취소의 정리에서 `inbox.discardAll()` 을 부른다. `leave` 결과의 `undelivered_events` 가 그 수다). 채팅 전달(크기, 속도, `ack`, `resend_of`). `stop_test` 결과의 `sent_to`·`not_connected`. `presence` 재기록 간격. `get_status.room.net` 이 `netInfo()` 의 값을 싣는다. **스냅샷 교환과 재동기화, 경과 시간과 기한**(가짜 시계. 아래 기준) |
| V-U10 | `signaling-client` (가짜 소켓) | `joined` 전에도 `signal` 이벤트가 나온다. `ping` 3회 놓침에 재접속, 1~2회에는 재접속하지 않는다. 게이트웨이 프레임의 상태별 처리. `join` 다시 보내기. 재접속 중 `ROOM_FULL`·`NAME_IN_USE` 에 멈추지 않는다. 지금 쓰는 소켓의 `REPLACED` 는 재접속. 접속 순번이 커진다. 이벤트에 `Subscribable` 적합성 시험(`protocol/testing.ts`) |
| V-U11 | `mesh` (실제 라이브러리, 한 프로세스의 두 인스턴스) | 후보 처리의 세 갈래, 재전송 표, 교체 확인, "시도 하나는 열림·닫힘 한 쌍 또는 실패 하나로 끝난다", relay 후보 필터. **진행 중인 시도가 새 `cid` 의 `offer` 로 바뀌어도**(다른 `sid`, 같은 `sid` 의 더 큰 순번) `attempt-failed` 가 나오지 않고, 기한이 바뀐 때부터 새로 재지며, 새 pc 로 열리면 `link-open` 이 한 번 나온다. `handleRelayError`: `RELAY_NOT_ALLOWED` 는 `attempt-failed{ice, failed}` 한 번, `PEER_NOT_FOUND` 는 `{signaling, peer_gone}` 한 번, 옛 `cid` 의 오류는 아무 것도 바꾸지 않는다. `expireAttempt` 는 진행 중인 시도를 상태에 맞는 분류(`no_offer`, `no_answer`, `ice_timeout`)로 한 번 끝내고, 시도가 없으면 아무 것도 하지 않는다. `netInfo().srflx_seen` 은 pc 를 만들기 전과 STUN 없는 구성에서 거짓이다. **`parseIceServers` 를 통과한 대표 값(호스트 이름, IPv4, IPv6, 포트 생략, 여러 개)으로 pc 가 예외 없이 만들어진다**(`{hostname, port}` 객체로 넘긴다). 이벤트에 `Subscribable` 적합성 시험(`protocol/testing.ts`). **실제 라이브러리를 쓰므로 증거 수준은 로컬 실물이다** |
| V-U12 | `monitor`, 그리고 관전자 처리(`room-session` 가짜 하위 모듈, `protocol`) | **`protocol`**: `hello` 에 `observer` 가 없어도, `true`·`false` 여도 받는다. 불리언이 아니면 `BAD_FRAME`. `encodeP2PFrame` 이 `observer` 를 싣는다. **`room-session`**(가짜 하위 모듈. 아래 "V-U12 의 관전자 처리 기준"). **`monitor`**: `parseMonitorArgs` 의 표(위치 인자와 `--room`/`--server` 의 같음과 충돌, 서버 생략 → `AGENT_CHAT_SERVER` → 공용 서버, 잘못된 `AGENT_CHAT_SERVER` 는 공용 서버로 바꾸지 않고 오류, `turn:` 이 든 `AGENT_CHAT_ICE_SERVERS` 는 오류, 예약 이름·형식 위반 이름, 모르는 옵션, `--help`, 색: TTY·`--json`·`--no-color`·`NO_COLOR` 의 조합 전부). `toTerminalText`: ESC·C0·DEL·C1·양방향 제어·U+2028/2029 가 하나도 그대로 나가지 않고 보이는 글자로 바뀐다. 줄바꿈은 들여 이어 쓴다. 한글·이모지는 그대로다. `formatEvent`·`formatSnapshot`: 사건 종류·`change` 의 모든 값에 한 줄이 나오고(빠지는 값이 없다), 색을 끈 출력에 ESC 바이트가 0개다. JSON 줄은 `JSON.parse` 로 되읽어 원래 사건과 같다. 요약과 출력 어디에도 방 ID 가 없다(시험이 넣은 방 ID 문자열 0건). `createMonitorSink`: `start()` 전 사건은 들고 있다가 요약 뒤 순서대로 쓴다. 1000건을 넘으면 버린 수를 한 줄로 알린다. `runMonitor`(가짜 세션, 가짜 시계): 세션에서 부르는 것은 `observe`, `observed`, `shutdown` 뿐이다(`sendChat`·`command`·`writeReport`·`create`·`join` 호출 0회). 입장 실패 코드마다 종료 코드 1 과 안내, 인자 오류 2, `stop` 뒤 0, 두 번째 `stop` 은 130. `stop` 은 `shutdown` 에 1500ms 예산을 준다. 시그널링 상태가 바뀌면 알림 한 줄. 진단 로그(가짜 로그 포트)에 사건 본문과 방 ID 가 없다 |

**V-U9 의 스냅샷 교환, 재동기화, 경과 시간 기준 (실행 전에 고정)**. 규칙은 [protocol.md 5.4](protocol.md#54-동기화-절차)와 [5.5](protocol.md#55-파생-판정)의 경과 시간이다. 가짜 시계와 가짜 `mesh`·`shared-state` 로 본다. 8번과 11번은 아래와 같이 다르다.

- **8번과 11번만 `shared-state` 를 실물로 둔다.** 경과 시간은 `shared-state` 가 계산한다. 가짜로는 값이 불어나는지 볼 수 없다. `shared-state` 는 시각을 인자로 받는 동기 함수뿐이라 가짜 시계로 돌릴 수 있다.
- 8번과 11번의 구성: `room-session` 둘(A, C)을 가짜 `mesh` 로 마주 잇는다. C 가 60분 제한의 테스트를 시작한다. 끊긴 쪽(B)의 기록은 C 에 변경으로 넣는다. 경과 시간은 시험이 `room-session` 에 넘긴 `shared-state` 의 `testElapsed` 로 읽는다. "실제로 흐른 시간"은 테스트를 시작한 뒤 가짜 시계가 간 시간이다.

| # | 상황 | 기대 |
|---|---|---|
| 1 | 상대의 `ping` 지문이 2회 연속 다르다 | 교환을 시작한다. 1회만 다르면 시작하지 않는다 |
| 2 | 상대가 시작한 교환을 받는다 | 병합한 뒤 `sf` 를 실어 한 번 답한다. 답(`sf` 있음)을 받으면 답하지 않는다 |
| 3 | 양쪽이 동시에 시작한다 | 스냅샷이 양쪽에서 한 번씩만 간다 |
| 4 | 교환 뒤 30초 안에 또 다르다 | 시작하지 않는다. 30초가 지난 뒤의 첫 `ping` 에 시작한다 |
| 5 | 답을 병합한 뒤 지문이 `sf` 와 다르고, 기다리는 동안 다른 곳에서 들어온 기록이 없다 | 진전 없음. 간격이 30 → 60 → 120 → 240 → 300초로 는다. **300초에서도 교환은 계속된다.** `state_diverged` 는 링크마다 한 번 |
| 6 | 5번과 같지만 기다리는 동안 로컬 쓰기나 다른 링크의 병합이 있었다 | 판정하지 않는다. 간격 그대로, 경고 없음 |
| 7 | 간격이 늘어난 뒤 `ping` 의 지문이 같아진다 | 간격이 30초로 돌아오고 경고가 걷힌다 |
| 8 | **끊긴 쌍의 한쪽이 5초마다 기록을 쓰는 상태를 3분 돌린다**(교환이 끝날 때마다 5초 안에 새 기록이 온다) | 교환이 3분 내내 이어진다. 교환 사이가 30초에서 35초다(간격 30초 + 다음 `ping` 까지 최대 5초). 간격이 늘지 않는다. `state_diverged` 0건. **끝났을 때 A 와 C 의 경과 시간이 실제로 흐른 3분과 1초 안에서 맞는다** |
| 9 | `stop` 을 병합으로 처음 받는다. 세 경우: 직전 교환 직후, 간격이 300초로 늘어난 링크, 답을 기다리는 중인 링크 | 받은 링크를 뺀 열린 모든 링크에 즉시 스냅샷을 보낸다. 받은 것이 상대가 시작한 스냅샷이면 그 링크에는 답으로 보낸다 |
| 10 | 이미 중단된 뒤 다른 `stop` 기록을 받는다. 로컬에서 `stop` 을 쓴다 | 9번을 하지 않는다. 로컬 `stop` 은 변경으로 열린 링크 전부에 간다 |
| 11 | **경과 시간과 기한.** 60분 제한의 테스트를 60분이 지날 때까지 돌린다. (가) 10분째에 A–C 링크를 닫았다 다시 연다. 양쪽 `sync_end` 가 10분을 싣는다. (나) 그 뒤 8번의 상태(30~35초마다 교환)를 유지한다. (다) 50분째에 A 가 나가고, 빈 복제본을 가진 새 `room-session` 이 같은 이름으로 들어온다 | (가) 다시 연 뒤 A 와 C 의 경과 시간이 10분에서 1초 넘게 벗어나지 않는다. (나) A 와 C 의 경과 시간이 실제로 흐른 시간을 넘는 때가 없다. (다) 들어온 직후 경과 시간이 50분과 1초 안에서 맞고, 기한 타이머가 남은 10분으로 걸린다. 전체: `stop{time_limit}` 이 60분 전에는 쓰이지 않고, 60분에서 5초 안에 쓰인다 |

**V-U12 의 관전자 처리 기준 (실행 전에 고정)**. 규칙은 [protocol.md 4.6](protocol.md#46-관전자)과 [architecture.md 3.10 의 관전 모드](architecture.md#310-room-session)다. 가짜 시계와 가짜 `mesh`·`signaling-client` 로 본다. "참가자 쪽"은 참가자 모드의 `room-session`, "관전 쪽"은 `observe` 로 들어간 `room-session` 이다.

| # | 상황 | 기대 |
|---|---|---|
| 1 | 관전 쪽이 들어간다(필수 피어 둘) | 시그널링 `join` 의 `mode` 가 `join` 이다. 보낸 `hello` 에 `observer: true`. 둘과 동기화되면 `RoomObserved` 를 돌려주고, 그 안에 방 ID 가 없다. 입장 뒤 관전 쪽이 보낸 프레임에 `chat` 과 변경 `state` 가 0건이다(스냅샷·`sync_end`·`ack`·`ping`·`pong`·`bye` 만) |
| 2 | 관전 쪽에 60분 제한 테스트가 있는 스냅샷을 주고 가짜 시계를 61분 보낸다 | `stop{time_limit}` 을 쓰지 않는다(보낸 변경 0건). `presence` 를 쓰지 않는다. 기록 파일을 열지 않는다(`openTranscript` 호출 0회) |
| 3 | 관전 쪽의 `sendChat`, `command`(종류마다), `writeReport` | 모두 `NOT_IN_ROOM`. 보낸 프레임 0건 |
| 4 | 관전 쪽이 방 전체 `chat` 과 자기를 지정한 `chat` 을 받는다 | 둘 다 `ack` 하고 사건(`to: room`, `to: you`)을 넣는다. 남을 지정한 `chat`(잘못 온 것)은 기존 규칙대로 버린다 |
| 5 | 관전 쪽이 받은 `presence` 변경으로 상대의 `status` 가 joined → working → ready 로 바뀐다 | `peer` / `status` 사건이 두 번, `ready` 사건이 한 번 나온다. 참가자 쪽은 같은 입력에 `ready` 한 번뿐이다 |
| 6 | `hello` 에 `observer` 가 없는 상대(구버전) | 관전 쪽: `system` / `observer_unaware` 가 그 상대마다 한 번, `RoomObserved.unaware` 에 그 이름. 참가자 쪽: 그 상대를 보통 참가자로 다룬다 |
| 7 | 참가자 쪽이 관전자(`hello.observer: true`)와 링크를 연다 | 동기화되면 `peer` / `observer_joined` 한 번. `status().participants` 에 없고 `status().observers` 에 `{name, link: open, since}`. 다른 참가자의 `shown_as`·`claims.waiting_for_you`·`warnings` 가 관전자가 없을 때와 같다(같은 입력의 두 결과를 비교한다) |
| 8 | 참가자 쪽이 관전자 링크에서 `chat` 을 받는다 | `data.observer: true` 인 `chat` 사건 1건, `ack` 1건, 기록 파일 `chat_in` 1건, 잘못된 프레임 0건(2026-11-16 변경: 관전 콘솔에서 지시를 보낸다) |
| 9 | 참가자 쪽이 관전자 링크에서 변경 `state`(아무 기록)를 받는다 | 복제본과 지문이 그대로다. 잘못된 프레임 1건(`observer_write`) |
| 10 | 참가자 쪽이 관전자 링크에서 스냅샷을 받는다. 남이 쓴 기록 둘과 `author` 가 그 관전자인 기록 하나 | 남의 기록 둘만 병합한다. `state.merge` 의 `ignored` 가 1 이상 |
| 11 | 참가자 쪽이 방 전체 글을 보낸다(참가자 둘, 관전자 하나가 동기화됨) | 관전자에게도 `chat` 이 간다. 결과 `delivered` 에 관전자 이름이 있다. `to: [관전자]` 도 받는다(`INVALID_ARGUMENT` 가 아니다) |
| 12 | 참가자 쪽의 `start_test`·`stop_test` | `sent_to`·`not_connected` 에 관전자 이름이 없다 |
| 13 | 관전자 링크가 `bye{shutdown}` 으로 닫힌다. 다른 관전자 링크는 `ping_timeout` 으로 닫힌다 | 각각 `observer_left` 한 번(`data.reason` 은 닫힌 사유). `disconnected`·`left` 사건 0건. 앞쪽은 `observers` 에서 빠진다 |
| 14 | 같은 이름이 `hello.observer: false` 로 다시 들어온다 | `observers` 에서 빠지고 `participants` 에 나온다 |

### 3.2 로컬 실물

명령: `npm run test:e2e` (프로세스를 띄우는 스크립트. 포트를 쓰는 시나리오는 순차 실행). 각 스크립트는 끝날 때 **자기가 띄운 프로세스가 남지 않았는지** 확인한다.

**결함을 만드는 수단.** 시그널의 유실, 순서 뒤바뀜, 지연은 **시험용 시그널링 프록시**(`tests/support/signal-proxy.mjs`)로 만든다. 프록시는 클라이언트와 자체 호스팅 서버 사이에 서서 지정한 쌍·종류·순번의 메시지를 버리거나 늦춘다. 제품 코드에 시험용 분기를 넣지 않는다. 같은 PC 에서는 한쪽 후보만 버리면 상대의 검사 패킷으로 주소를 알게 되어 연결된다. 그래서 "직접 연결 불가"는 **양방향 후보를 모두** 버려서 만든다. 부분 mesh 는 한 참가자의 시그널링을 끊은 사이 다른 참가자를 입장시킨 뒤, 그 둘 사이의 시그널을 계속 버려서 만든다.

| ID | 구성 | 확인하는 것 | 시나리오 |
|---|---|---|---|
| V-L1 | 자체 호스팅 서버 + 와이어 계약만 아는 클라이언트(`tests/wire/wire-contract.mjs`) | 와이어 계약 전체([deployment.md 2.11](deployment.md#211-배포-후-검증-verifymjs)의 표)와 6절의 결함 주입 | — |
| V-L2 | 서버 + MCP 프로세스 2개, 4개 | 생성, 입장, 상태 공유, 방 전체·대상 지정 채팅, `ack`, 자기 메시지 미수신. 채팅을 보낸 구간에서 서버의 `relay` 사건 수가 늘지 않는다 | S1, S2, S4 |
| V-L3 | 위 + 프록시 | 한 쌍의 후보를 양방향으로 버리면 입장이 **20초 안에** `DIRECT_CONNECT_FAILED`(단계 `ice`)로 끝난다. 한 참가자를 SIGSTOP 하거나 그 쌍의 `offer` 를 계속 버리면 단계가 `signaling` 이다. 끝난 뒤 서버 등록과 링크가 없다. relay 후보가 0개다. `turn:` 설정이면 접속 전에 `ICE_CONFIG_REJECTED` 이고 프로세스는 떠 있다 | S3 |
| V-L4 | 4개 중 하나를 SIGKILL, SIGSTOP | 나머지가 15초 안에 `disconnected` 로 표시한다. 나머지끼리의 채팅이 유지된다. 같은 이름으로 다시 들어온 프로세스가 목표와 역할 현황을 받는다. **그 뒤 새로 입장한 참가자가 죽은 참가자를 `disconnected` 로 본다.** 한 쌍만 끊긴 상태에서 한쪽이 기록을 쓰고 떠난 뒤, 남은 둘의 지문이 45초 안에 같아진다(규칙의 최댓값 35초 + 여유 10초) | S5, S7 |
| V-L5 | 서버 재시작, 서버 쪽에서 소켓 끊기 | DataChannel 이 유지된다. 끊긴 동안 채팅이 전달된다. 재등록 뒤 신규 입장이 된다. 끊긴 사이 입장한 참가자와 mesh 가 메워진다. 끊긴 사이 다른 프로세스가 같은 이름을 차지해도 원래 참가자의 링크가 닫히지 않고, 차지한 쪽이 나가면 재등록된다 | S6 |
| V-L6 | 프로세스 6개를 동시에 입장 | 전원이 서로 연결된다. 쌍마다 링크가 하나다. 정원에서 하나 모자란 방에 3개가 동시에 들어오면 **정원을 넘지 않는다**(통과 1 이하) | S8 |
| V-L7 | MCP SDK 클라이언트로 stdio 연결. **가**: 가짜 세션(`mcp-server` + `inbox`). **나**: 조립한 실제 프로세스 | capability 와 instructions. 확인 전 채널로 채팅이 나가지 않음. 점검 → `confirm_channel` → 채널 전달. 확인 호출이 없으면 poll 로 돌아옴. `wait_for_messages` 취소 뒤 사건이 유실되지 않음. 결과 상한. 잘못된 환경 변수로도 프로세스가 뜨고 `notice.config` 가 온다. 종료 400ms 이하. 부모 SIGKILL 뒤 고아 프로세스 없음 | S4, S9, S13 |
| V-L8 | MCP 프로세스 4개를 스크립트가 tool 로 조종 | 테스트 시작 → 시나리오 → 주장 → 타인 검증 → 역할 교대 → 퇴장·재입장 → 중단 → 보고서. 거절 사례: 자기 검증, 중단 뒤 시나리오 시작, 시간 제한, 시나리오 수 제한, 동시 한도 초과, **기한이나 중단 뒤의 `start_test`**. **중단 뒤에 옛 시나리오로 쓴 주장이 성공으로 세지 않는다.** **한 쌍이 끊긴 상태에서의 중단**(아래 기준) | S10~S12 |
| V-L9 | 4개, 130분 | 장시간. 아래 기준 | — |
| V-L10 | (가) 설치 본체 `scripts/install.mjs` 를 임시 홈 디렉터리에서, 호스트 CLI 를 가짜로 바꿔(`AGENT_CHAT_CLAUDE_BIN`, `AGENT_CHAT_CODEX_BIN`) 실행. 명령 `npm run test:e2e -- install`. (나) 셸 진입점 시험: 설치기를 공백이 든 임시 폴더에 복사하고, 가짜 호스트 CLI 와 임시 `HOME` 으로 `installer/install.sh`, `claude.sh`, `codex.sh` 를 실행. 명령 `node --test installer/*.test.mjs` | (가) 단계 순서, 등록 명령의 인자, 단계별 결과와 종료 코드(0·1·2), 다시 실행했을 때의 결과, [Channels 판정표](architecture.md#313-setup)의 모든 행. **설치가 쓰는 곳이 셋뿐이다**: 임시 홈의 설정 파일이 `agent-chat` 등록 항목을 빼면 바이트까지 같다(호스트가 돌지 않는 홈이라 전체를 비교할 수 있다). **비교 도구의 자체 시험**: 목록 밖의 키만 바뀐 사본은 같다고 하고, [목록](architecture.md#313-setup)의 키가 하나 바뀐 사본은 파일마다 다르다고 한다. 결과에 값이 출력되지 않는다. (나) 세 스크립트가 각각 `--client all`·`claude`·`codex` 의 등록을 만든다(`claude.sh` 는 Codex 를, `codex.sh` 는 Claude Code 를 등록하지 않는다). 인자 없음과 `--install` 의 결과가 같다. 다시 실행해도 등록이 같다. `--uninstall` 과 `-u` 뒤에 고른 호스트의 등록이 없고, 다시 제거해도 종료 코드 0 이다. 틀린 인자와 둘 이상의 인자는 사용법과 종료 코드 1 이다. Node 가 없거나(`AGENT_CHAT_NODE` 가 없는 파일) 22 미만이면(가짜 `node`) 안내와 종료 코드 1 이고 임시 홈이 그대로다. `install.mjs` 의 종료 코드 0·1·2 가 셸에서 그대로 나온다. 실제 홈의 설정 파일에 쓰지 않는다. (다) `src/setup/host-cli.test.ts`(단위. `npm test`): 호스트 CLI 로 실행하는 하위 명령이 `--version`, `mcp get`·`add`·`remove`·`list`, `auth status` 뿐이고, 그 밖의 인자 묶음은 실행 전에 거절된다. **호스트 CLI 가 가짜이므로 (가)와 (나) 모두 대역 수준이다** | S15 |
| V-L11 | 연결 단독: 두 프로세스(`signaling-client` + `mesh`) + 프록시 | A-RTC-2, A-RTC-3 의 통과 기준. 로그의 `queued_applied`, `resends` 가 주입과 맞는다. **`netInfo()`**: 기본 STUN 을 준 구성으로 10회 연결한다. 매회 `link-open` 뒤 3초 안에 `srflx_seen` 이 참이 된다. `link-open` 보다 늦게 srflx 후보가 나온 회가 1회 이상이다(링크가 열린 뒤의 후보를 세는 길을 실제로 지났다는 증거. 0회면 이 항목은 부분 검증). 공개 STUN 에 닿지 않으면 이 항목은 미실행으로 적는다 | S9, S15 |
| V-L12 | 방 조율 하네스: MCP 없이 실제 하위 모듈로 `room-session` 을 세운다 | 입장과 동기화. 프록시로 `joined` 를 늦춰 `offer` 가 먼저 오게 해도 입장한다. 부분 mesh 에서 공유 상태가 맞춰지고 채팅은 가지 않는다. **부분 mesh 에서 끊긴 쌍의 한쪽이 5초마다 기록을 쓰는 상태를 3분 유지한다. 그동안 경과 시간이 불어나지 않는다**(아래 기준) | S2, S6, S11, S12 |
| V-L13 | 자체 호스팅 서버 + 조립한 MCP 프로세스 4개(스크립트가 tool 로 조종. `V-L8` 의 하네스) + 관전 프로세스(`node dist/entry/monitor.js --json` 과 `sh scripts/monitor.sh`). 명령 `npm run test:e2e -- v-l13` | 관전자가 4명 방에 들어가 방 전체 채팅·상태·중단을 보고, 대상 지정 채팅은 보지 못한다. 에이전트 쪽 `get_status` 에 관전자로 보이고 준비 판정에 영향이 없다. 관전자가 아무 것도 쓰지 않는다. 시그널링이 끊겨도 계속 본다. Ctrl-C 뒤 남은 프로세스 0(아래 기준) | S16 |

**부분 mesh 의 재동기화와 중단 기준 (`V-L8`, `V-L12`. 실행 전에 고정)**. 구성: A–B 링크가 없고 둘 다 C 와 이어져 있다. 부분 mesh 는 위 프록시로 만든다.

| 검증 | 절차 | 통과 조건 |
|---|---|---|
| `V-L12` | 부분 mesh 가 된 뒤 B 가 60분 제한의 테스트와 시나리오를 시작한다. 하네스가 테스트를 시작한 시각을 적는다. B 가 5초마다 기록을 쓴다(주장, `set_status` 를 섞는다). 3분 유지한다. 하네스가 A 와 C 의 경과 시간을 읽는다. 이어서 B 가 `stop` 을 쓴다 | **읽은 A 와 C 의 경과 시간이, 적어 둔 시각부터 실제로 흐른 시간보다 1초 넘게 크지 않고 5초 넘게 작지 않다.** B 가 쓴 주장이 **하나도 빠짐없이** 각각 45초 안에 A 의 복제본에 들어온다(35초 + 여유 10초). `presence` 는 키 기록이라 마지막 값이 45초 안에 들어오면 된다. 3분 동안 A–C 링크의 `state.resync` 가 4회 이상이다. `state_diverged` 사건과 경고가 0건이다. `stop` 이 **5초 안에** A 의 복제본에 들어온다. A 쪽 로그에 `state.resync{cause: stop}` 으로 시작된 교환의 병합이 있다 |
| `V-L8` | B 가 5초마다 시나리오·주장을 쓰는 상태를 60초 유지한 뒤 B 가 `stop_test` 를 부른다 | 결과의 `not_connected` 에 A 가 실린다. **5초 안에** 전원의 `get_status.test.stopped` 가 채워진다. 그 뒤 전원의 `start_scenario` 가 `TEST_STOPPED` 로 거절된다. A 의 `get_status` 경고에 복제본 차이가 없다 |

- 5초의 근거: 규칙에서 나오는 시간은 링크 하나를 더 건너는 시간이다. 같은 PC 에서는 수십 ms 로 본다. 5초는 지문 비교로 맞춰지는 시간(10~35초)보다 분명히 짧다. 5초를 넘기면 중단의 즉시 교환이 동작하지 않은 것이다. 이 값은 같은 PC 의 기준이다. 실제 망의 시간으로 보고하지 않는다.
- 경과 시간을 읽는 방법: 하네스가 `room-session` 에 넘긴 `shared-state` 의 `testElapsed` 를 부른다. A 는 B 와 링크가 없으므로 테스트를 C 의 스냅샷으로 처음 받고, 같은 교환의 `sync_end` 로 경과 시간을 따라간다.
- 1초와 5초의 근거: 규칙대로면 받은 값은 건너오는 시간만큼만 뒤진다. 같은 PC 에서는 수십 ms 로 본다. 3분 동안 A–C 교환이 4회 이상 있고 교환 사이는 30초 이상이다. 받은 값을 기준 시각은 둔 채 한 번이라도 다시 받아들이면 실제보다 약 30초 이상 커진다 **[추론]**. 1초 넘게 크면 그 결함으로 본다. 같은 PC 의 기준이다. 실제 망의 오차로 보고하지 않는다.
- 주입이 실제로 일어났다는 증거(A–B 링크가 시험 내내 없었다는 양쪽 `get_status`)가 없으면 통과가 아니다.
- "`state.resync{cause: stop}` 으로 시작된 교환의 병합"을 읽는 법: 와이어에는 교환의 계기가 실리지 않아 A 는 계기를 모른다. 그래서 **C 의 로그에 `state.resync{cause: stop, peer: A}` 가 있고, 그 뒤 A 의 로그에 C 의 스냅샷을 병합한 `state.merge` 가 있는 것**으로 본다. `state.resync` 의 횟수는 `cause` 가 있는 줄만 센다(판정 때의 debug 줄은 `outcome` 만 있다).

**V-L9 장시간 판정 기준 (실행 전에 고정)**: 워밍업 5분. 60초마다 표본. 부하는 참가자마다 10초에 채팅 1건, 10분마다 한 참가자의 퇴장·재입장, 30분마다 서버 쪽 소켓 끊기. 통과 조건: 예상 밖 링크 종료 0건, 보낸 채팅 = 받은 채팅(끊긴 구간은 `undelivered` 로 보고된 것 제외), 프로세스별 RSS 가 워밍업 직후 대비 20% 넘게 늘지 않음, 주입 뒤 60초 안에 mesh 회복, 끝났을 때 모든 참가자의 상태 지문이 같음. 주입이 실제로 일어났다는 로그가 없으면 통과가 아니다. 130분보다 짧게 돌린 실행은 장시간 검증으로 보고하지 않는다.

**V-L13 관전 판정 기준 (실행 전에 고정)**. 구성: 자체 호스팅 서버 하나(`ws://127.0.0.1:<포트>`), MCP 프로세스 A, B, C, D(`AGENT_CHAT_HOME` 은 실행마다 새 임시 폴더). 관전 프로세스 O 는 `--name` 에 실행마다 다른 이름(`obs` + 무작위 6자)을 준다. 시험은 O 의 stdout(JSON Lines)과 stderr 를 모두 모은다. 글마다 실행마다 다른 표지 문자열을 넣는다(`M1`…: `v13-<무작위 8자>-<번호>`). 실제 홈의 설정을 쓰지 않는다.

| # | 절차 | 통과 조건 |
|---|---|---|
| 1 | A 가 `create_room`, B·C·D 가 `join_room`. 넷이 `set_status{status: ready, role}` 을 하고 `wait_for_messages` 를 돌려 `listening` 이 참이 되게 한다. 넷의 `get_status` 를 적어 둔다(전) | 넷 모두 서로를 `shown_as: ready` 로 본다 |
| 2 | O 를 `--json` 으로 띄운다(`--room`, `--server` 를 준다) | **25초 안에**(입장 기한 20초 + 5초) 첫 stdout 줄이 `type: snapshot` 이다. `participants` 의 이름이 정확히 {A, B, C, D} 이고 각 `shown_as` 가 `ready` 다. `observers` 가 비었다. 줄 어디에도 방 ID 가 없다 |
| 3 | O 가 들어온 뒤 5초 안에 넷의 `wait_for_messages` 와 `get_status` 를 본다(후) | 넷 모두 `peer` / `observer_joined`(`from` = O) 사건을 정확히 한 번 받았다. 넷의 `get_status.observers` 에 O 가 `link: open` 으로 있고 `participants` 에 O 가 없다. **전과 후의 `participants`(이름, `role`, `status`, `shown_as`)와 `claims.waiting_for_you` 와 `warnings` 가 같다** |
| 4 | A 가 `start_test`, B 가 `start_scenario`, C 가 `record_claim`, D 가 `record_verification(confirmed)`, B 가 `set_status{status: working}` | O 의 stdout 에 각각 `test`/`started`, `scenario`/`started`, `claim`, `verification`(`data.claim_status: confirmed`), `peer`/`status`(B, `working`) 사건이 **각 5초 안에** 한 줄씩 나온다 |
| 5 | A 가 방 전체로 `M1`(두 줄짜리), D 가 방 전체로 `M2` 를 보낸다. B 가 `to: [C]` 로 `M3`, C 가 `to: [A, D]` 로 `M4` 를 보낸다 | O 의 stdout 에 `M1`·`M2` 가 `kind: chat`, `to: room`, 맞는 `from` 으로 **각 정확히 한 번**, 5초 안에 나온다. A·D 의 결과 `delivered` 에 O 가 있다. **`M3`·`M4` 는 O 의 stdout·stderr 어디에도 0번** 나온다(시험 끝까지 센다). C 와 A·D 는 각각 `M3`·`M4` 를 받았다(주입이 실제로 있었다는 증거) |
| 6 | 자체 호스팅 서버를 멈춘다. 2초 뒤 A 가 방 전체로 `M5` 를 보낸다. 10초 뒤 서버를 다시 띄운다 | 서버가 멈춘 동안 O 의 stdout 에 `M5` 가 5초 안에 한 번 나온다. O 의 프로세스가 살아 있다. 서버가 돌아온 뒤 60초 안에 O 가 재등록한다(O 의 진단 로그 `signal.state` 가 `connected`) |
| 7 | C 가 `stop_test` 를 부른다 | O 의 stdout 에 `test`/`stopped`(`data.by` = C, `data.detail` = 준 사유) 가 **5초 안에** 나온다. C 의 결과 `sent_to`·`not_connected` 에 O 가 없다 |
| 8 | **읽기 전용 확인.** 넷의 기록 파일(`<AGENT_CHAT_HOME>/rooms/…/transcript-*.jsonl`)을 읽는다 | `state` 줄 가운데 `record.author` 가 O 인 것이 0건. `chat_in` 줄 가운데 `from` 이 O 인 것이 0건(O 는 입력이 없는 stdin 으로 띄운다). 넷의 진단 로그에 `p2p.bad_frame{error_code: observer_chat \| observer_write}` 가 0건(O 가 아예 보내지 않았다). 넷의 상태 지문이 서로 같다 |
| 9 | O 에 SIGINT 를 보낸다 | **3초 안에** O 가 끝나고 종료 코드 0. stdout 마지막 줄이 `{"type":"end","reason":"interrupted"}` 다. 넷 모두 5초 안에 `observer_left`(`data.reason` 은 `bye_shutdown`)를 받고 `get_status.observers` 가 비었다. **남은 프로세스 0**: O 의 pid 가 없고, `ps -A -o pid=,command=` 에서 O 의 이름을 담은 줄이 0개다. 넷의 `participants` 와 `shown_as` 가 1번과 같다 |
| 10 | 2~9 와 같은 방에 O2 를 **사람용 출력**(`--json` 없음, stdout 은 파이프라 TTY 가 아님)으로 `sh scripts/monitor.sh <room_id> <서버> --name <이름>` 으로 띄운다. A 가 방 전체로 `M6`(본문에 ESC 바이트로 시작하는 색 바꾸기 순서 `\x1b[31m`, 양방향 제어 U+202E, 줄바꿈을 넣는다)를 보낸 뒤 O2 에 SIGINT | O2 의 stdout 에 `M6` 의 표지가 한 번 나온다. **stdout 전체에 ESC 바이트(0x1b)와 U+202E 가 0개**다(색도 꺼져 있다). 방 ID 가 0번 나온다. SIGINT 뒤 3초 안에 종료 코드 0. `sh` 와 `node` 프로세스가 모두 남지 않는다(`exec` 확인) |
| 11 | 아무도 없는 방 ID 로 O3 를 띄운다. 정원이 찬 방(MCP 프로세스 8개)에 O4 를 띄운다 | O3: 10초 안에 종료 코드 1, `type: error`, `details.server_code: ROOM_NOT_FOUND`. O4: 종료 코드 1, `ROOM_FULL`. 둘 다 남은 프로세스 0, 서버에 O3·O4 의 등록이 남지 않는다 |
| 12 | **로그 규칙.** O·O2 의 진단 로그 파일(`<AGENT_CHAT_HOME>/logs/diag-*.jsonl`, `svc: monitor`)과 stderr 를 읽는다 | 표지 문자열(`M1`~`M6`) 0건, 방 ID 원문 0건. stderr 에 JSON 로그 줄이 0건(`stderrCopy: false`) |

- 시간 기준(5초, 25초, 3초)은 같은 PC 의 기준이다. 실제 망의 시간으로 보고하지 않는다.
- 주입이 실제로 일어났다는 증거가 없으면 통과가 아니다: 5번의 `M3`·`M4` 수신, 6번의 서버 중단(서버 프로세스가 없었던 구간의 시각), 9번의 SIGINT 전송 시각.
- 대상 지정 채팅이 보이지 않는 것은 **한계를 확인하는 항목**이다. 보이면 실패다(관전자에게 채팅이 다른 경로로 간 것이다).
- 구현 때 더한 확인(2026-11-16): (9-2) 관전 프로세스의 stdout 읽는 쪽을 닫고 글을 보내면 `bye{shutdown}` 을 보내고 종료 코드 0 이다(EPIPE 뒤의 쓰기 오류를 두 번째 신호로 읽어 130 으로 끝나지 않는다). (10) 셸 진입점은 공백과 작은따옴표가 든 폴더에 복사해 실행한다(`dist`·`node_modules` 는 링크). 같은 복사본으로 `-h` 는 0, Node 없음·22 미만(가짜 `node`)·빌드 없음은 안내와 종료 코드 2 이고 출력에 방 ID 가 없다. (11) 찬 방은 서버를 다시 띄운 뒤라 8명 모두의 재등록을 기다린 뒤 띄운다.

### 3.3 실제 환경 (공용 서버)

전제: [deployment.md 2.10](deployment.md#210-배포-갱신-삭제-절차)로 배포가 끝났다.

| ID | 확인하는 것 | 통과 기준 |
|---|---|---|
| V-P1 | 배포와 와이어 계약 | `deploy.sh` 종료 코드 0. `verify.mjs` 전 항목 통과(동시 입장의 정원·생성 판정, 여분 프레임 0건 포함). `npm run test:store -- --table … --region …` 통과, 끝난 뒤 시험 항목 0건 |
| V-P2 | 제품 코드로 4 프로세스 mesh | `V-L2` 와 **같은 스크립트**를 서버 인자 없이 실행해 통과. **채팅이 서버를 지나지 않음을 서버에서 본다**: 채팅 0건 구간과 200건 구간의 API Gateway 메시지 수와 Lambda 호출 수를 CloudWatch 지표로 비교한다. 차이가 `ping` 주기의 흔들림(±5건) 안이다 |
| V-P3 | 유령 처리 | 참가자 SIGKILL 뒤 서버 기록이 지워지기까지의 시간, SIGSTOP(멈춘 참가자) 뒤 신규 입장이 가능해지기까지의 시간을 기록한다. 후자가 90초 + 연결 기한 이내. 그동안의 입장 실패가 단계 `signaling` 으로 보고된다 |
| V-P4 | 유휴와 2시간 한도 | 130분 실행. `ping` 으로 10분을 넘겨 유지된다. 2시간 근처의 끊김 뒤 재접속·재등록한다. **그동안 DataChannel 이 유지되고 채팅 유실이 0건**이다. 전 구간의 게이트웨이 메시지 수가 `ping` 과 시그널의 예상치 안이다 |
| V-P5 | 로그와 스로틀 | 함수 로그와 접근 로그에서 시험 중 보낸 표지 문자열(채팅 본문, 방 ID, 참가자 이름, SDP 조각)이 0건. 로그 그룹 보존이 7일. 스로틀을 넘겼을 때 클라이언트가 받은 것을 기록 |
| V-P6 | 재현 가능성 | `destroy.sh` 뒤 `deploy.sh` 를 다시 실행해 `V-P1` 통과 |
| V-P7 | 유실과 스로틀 아래의 입장 | (가) 함수가 식은 상태에서 4개가 동시에 입장한다. 10회 모두 성공. 재전송 횟수와 걸린 시간을 기록한다. (나) 다른 연결로 스로틀을 넘긴 상태에서 입장한다. 성공하거나, 실패하면 단계가 `signaling` 이다. 그동안 재접속 횟수가 늘지 않는다. 결과로 스로틀 기본값을 다시 정한다 |
| V-P8 | 공용 서버를 거친 관전 | 명령 `node tests/e2e/public/v-p8-monitor.mjs`. 서버 인자 없이(공용 서버) MCP 프로세스 2개가 방을 만들고 들어간다. 관전 프로세스를 `--server` 없이 `--json` 으로 띄운다. 이어서 사람용 출력도 본다(`sh scripts/monitor.sh <room_id>`. 사용자 요청이 사람용과 `--json` 둘 다다). **통과**: 25초 안에 `snapshot` 줄(참가자 2명). 두 MCP 의 `get_status.observers` 에 관전자가 있다. 방 전체 글 2건이 각 10초 안에 관전 출력에 한 번씩, 대상 지정 글 1건은 0번. 사람용 출력에 요약, 실시간 머리줄, 채팅 한 줄(여러 줄은 `│` 로 잇는다)이 나오고 방 ID 가 없다. SIGINT 뒤 3초 안에 종료 코드 0(둘 다), 두 MCP 가 `observer_left` 를 받는다, 남은 프로세스 0. 끝나고 두 MCP 도 `leave_room`. **짧은 실제 확인이다**: 전체 2분 이내, 글 4건, 관전 입장 2회(`--json` 1, 사람용 1). 같은 PC 라 NAT 통과는 확인되지 않는다 |

같은 PC 의 프로세스끼리이므로 연결은 host 후보로 선다. **공용 서버를 거친 시그널링**은 확인되지만 **NAT 통과**는 확인되지 않는다.

### 3.4 실제 설치 (모델 호출 없음)

사람의 승인도 모델 호출도 필요 없다. 그래서 **반드시 실행한다.** 사용자가 범위에 넣은 "이 PC 에 실제로 설치해 공용 서버를 거친 통신까지 테스트"가 이 두 항목이다. 이력의 실행 ID 접두어는 `S-` 다.

| ID | 구성 | 통과 기준 |
|---|---|---|
| V-S1 | 이 PC 의 **실제 홈**에서 한다. 작업 트리를 `<AGENT_CHAT_HOME>/app` 에 복사하고(아래), 스크립트 하나가 설정 사본 뜨기 → `sh installer/install.sh` → 사본 뜨기 → 비교를 이어서 한다 | 종료 코드 0. `claude mcp get agent-chat` 과 `codex mcp get agent-chat` 의 명령 경로가 이 설치다. [권한 관련 키의 고정 목록](architecture.md#313-setup)이 설치 전후에 뜻이 같다. 목록 밖의 키는 비교하지 않는다. Channels 보고에 판정표의 행 번호가 함께 나온다. 다시 실행해도 결과가 같다. `sh installer/install.sh --uninstall` 뒤 등록이 없고 같은 목록이 설치 전과 뜻이 같다(확인 뒤 다시 설치한다). 바이트 비교는 하지 않는다 |
| V-S2 | `V-S1` 이 `installer/install.sh` 로 넣은 **등록의 명령과 환경 그대로** MCP 프로세스 2개를 SDK stdio 클라이언트로 띄운다. 이름만 `name` 인자로 다르게 주고 `server` 는 생략한다(공용 서버) | `create_room` → `join_room` → 양방향 `send_message` 가 `delivered` → 양쪽 `wait_for_messages` 로 수신 → `get_status` 의 상대가 `not_ready` 또는 `ready` → `leave_room`. 프로세스가 남지 않는다. `agent-chat doctor` 도 종료 코드 0 이다 |

- 선행: W8, 공용 서버 배포(G6), A-MCP-10. 저장소가 GitHub 에 올라가 있지 않아도 되고 커밋도 필요 없다.
- **저장소를 두는 방법.** 커밋하지 않은 작업 트리를 `<AGENT_CHAT_HOME>/app` 에 복사한다. `.git`, `node_modules`, `dist`, `build` 는 뺀다. 구현이 끝난 시점의 코드는 커밋돼 있지 않을 수 있고, 커밋은 사용자 지시가 있어야 하기 때문이다. `install.mjs` 는 git 저장소인지 보지 않는다([architecture.md 3.13](architecture.md#313-setup)). **`git clone` 으로 받는 길과 `git pull` 갱신은 이 검증에서 미실행이다.** 그것은 `V-I1` 에서 저장소가 올라가 있을 때 본다.
- **전후 비교.** 이 PC 에는 Claude Code 세션이 떠 있다. 검증을 실행하는 쪽이 그 세션이다. 호스트가 설정 파일을 계속 고쳐 쓰므로 파일 전체를 비교하지 않는다. 목록, 읽는 방법, 사람이 "항상 허용"을 골랐을 때의 처리는 [architecture.md 3.13](architecture.md#313-setup)이 정한다. 스크립트를 실행하라는 승인 프롬프트는 사본을 뜨기 전에 나온다.
- **진입점.** 실제 설치와 제거는 사용자가 쓰는 길 그대로 `installer/install.sh` 로 한다. `install.mjs` 를 직접 부르지 않는다. 호스트별 스크립트(`claude.sh`, `codex.sh`)와 틀린 인자, Node 가 없는 경우는 `V-L10`(나)가 본다. Windows 의 `node scripts/install.mjs` 직접 실행은 **미실행**이다.
- 한계: 두 프로세스가 같은 PC 다. 호스트(Claude Code, Codex) 자체가 서버를 띄우는 것은 [3.5](#35-실제-에이전트-세션)에서 본다. 목록 밖의 키를 설치가 건드리지 않는다는 것은 이 검증이 아니라 `V-L10` 이 본다.

### 3.5 실제 에이전트 세션

모델 호출 비용이 들고 사람이 있어야 한다. 실행하지 못한 항목은 미실행으로 적고, 그 항목에 기대는 완료 기준을 통과로 세지 않는다([8절](#8-완료-보고)).

공통 조건: 서버는 공용 서버(인자 생략). 세션마다 `name` 을 다르게 준다(`claude-a`, `claude-b`, `codex-a`). 같은 PC 의 세션은 설치가 넣은 기본 이름이 같기 때문이다. 상대 참가자는 스크립트가 조종하는 MCP 프로세스(`peer-script`)다.

| ID | 구성 | 확인하는 것 |
|---|---|---|
| V-I1 | 이 PC 의 Claude Code 에 저장소 주소와 설치 요청을 준다 | 에이전트가 저장소 README 의 첫 명령(`git clone` 뒤 `sh …/installer/install.sh`)으로 설치한다. 다른 길(`install.mjs` 직접 실행, 등록 명령을 손으로 실행)로 했으면 그 사실을 실행 기록에 적는다. 사용자 승인을 뺀 설치·등록·점검이 끝난다. Channels 보고가 나온다. **`V-S1` 과 같은 목록의 전후 비교**: 사본은 사람이 요청을 주기 직전과 에이전트가 끝낸 직후에 스크립트로 뜬다. 승인 프롬프트에는 "이번만 허용"으로 답한다. "항상 허용"을 골랐으면 프롬프트마다 시각·요청 내용·고른 답을 실행 기록에 적는다. 달라진 항목은 그 기록과 하나씩 대응해야 한다. 대응하지 않는 변화가 하나라도 있으면 실패다(설치나 에이전트가 권한·허용 목록·hook 설정을 고친 것으로 본다). **선행**: 저장소가 GitHub 에 올라가 있다(푸시는 사용자 지시가 있어야 한다). 안 되면 로컬 경로를 주고 "부분 검증: GitHub 에서 받기 미확인"으로 적는다 |
| V-I2 | Claude Code 를 개발 채널 플래그로 시작(사람이 경고 승인) | 입장 → 점검 → `confirm_channel` → 유휴 상태에서 `peer-script` 의 글에 반응. A-MCP-1, 2, 8 을 여기서 확인한다 |
| V-I3 | Claude Code 를 플래그 없이 시작 | **자동 수신 판정(poll).** 아래 기준. 채널로 중복 전달이 없다. A-MCP-4, 9 |
| V-I4 | Codex | **자동 수신 판정(poll).** 아래 기준. A-MCP-5, 6, 9 |
| V-I5 | 이 PC 의 세션 여러 개, 테스트 요청 한 번 | 역할 분담, 교차 검증, 역할 교대, 퇴장·재입장, 보고서가 사람의 추가 지시 없이 이루어진다. 중단을 말한 뒤 새 시나리오가 시작되지 않는다 |
| V-I6 | 권한을 좁힌 세션 | 방 메시지로 금지된 행동을 요청했을 때 호스트의 승인 요구나 거부가 그대로 작동한다 |

**자동 수신 판정 기준 (`V-I3`, `V-I4`. 실행 전에 고정)**: 사람은 처음에 "이 방에 들어가 오는 글에 답하라"를 한 번 말하고 그 뒤 입력하지 않는다. `peer-script` 가 30분 동안 2분 간격으로 글 15건을 보낸다. 통과 조건: 15건 모두에 대해 그 세션의 `send_message` 응답이 5분 안에 온다. 기록할 것: 빈 대기 횟수, 대기가 끊긴 횟수와 이유, 모델 턴 수. 이어서 한 번 더 본다. 사람이 한마디 끼어들어 턴을 끝낸 뒤 `peer-script` 가 글을 보낸다. 처리되지 않으면 그것을 **한계**로 기록한다(poll 은 턴이 살아 있는 동안만 받는다).

`V-I5` 에는 **여러 사용자가 역할을 나눠 쓸 수 있는 테스트 대상 서비스**가 필요하다. 이 저장소는 그런 서비스를 포함하지 않는다. 대상은 사용자가 정한다. 정해지지 않으면 `V-I5` 는 미실행으로 남긴다.

## 4. PRD 완료 기준별 판정

| 완료 기준 | 판정에 쓰는 검증 | 이 환경에서 낼 수 있는 결과 |
|---|---|---|
| **설치** | `V-S1`, `V-S2` (실제 설치와 통신. 반드시 실행), `V-I1` (에이전트가 주도하는 설치), `V-L10` (보조) | `V-S1`·`V-S2` 는 통과 가능. PRD 문장("GitHub 주소와 설치 요청만으로")의 통과는 `V-I1` 이 있어야 한다. `V-I1` 이 미실행이면 **부분 검증**. 이 PC(macOS)와 이 PC 의 호스트 버전에 한한다 |
| **자동 수신** (PRD 필수 구현 항목) | `V-U4`, `V-L7` (수신함과 전달 모드), `V-S2` (등록된 경로의 수신), `V-I3`·`V-I4` (실제 호스트의 poll), `V-I2` (채널) | `V-U4`·`V-L7`·`V-S2` 는 tool 이 사건을 빠짐없이 내준다는 것까지 보인다. **에이전트가 사람 입력 없이 계속 받는다는 것은 `V-I3`·`V-I4` 로만 보인다.** 둘이 미실행이면 **부분 검증**이다. 호스트별로 따로 적는다 |
| **다자간 통신** (서로 다른 PC 4대) | `V-L2`, `V-P2`, `V-L6`, `V-S2` | **부분 검증**. 한 PC 의 프로세스 4개로 생성·입장·상태 공유·양방향 채팅을 확인한다. "서로 다른 PC 4대"는 **미실행**으로 남긴다 |
| **자율 협업** | `V-L8` (tool 수준), `V-I5` (실제 에이전트) | `V-L8` 은 tool 이 흐름을 지원하고 규칙을 강제함을 보인다. 자율성은 `V-I5` 로만 보인다. `V-I5` 가 미실행이면 **부분 검증** |
| **서버 전환** | `V-L2` 와 `V-P2` (같은 스크립트, 서버 인자만 다름), `V-L1` 과 `V-P1` (같은 계약 테스트) | 통과 가능 |
| **실패 처리** | `V-L3`, `V-L11`, `V-U1`, `V-U8` | 통과 가능. 단 "직접 연결 불가"는 후보를 버리는 주입으로 만든 것이다. 실제 NAT 에서의 실패는 미실행. 채팅이 서버를 지나지 않는다는 것은 `V-P2`·`V-P4` 의 메시지 수로 본다 |
| **실행 통제: 중단과 제한** | `V-L8`, `V-U3` (tool 수준), `V-U9`, `V-L12` (끊긴 쌍에게도 중단이 닿는가. 테스트 도중의 재동기화로 시간 제한이 일찍 걸리지 않는가), `V-I5` (실제 에이전트가 멈추는가) | tool 이 거절한다는 것은 통과 가능. 끊긴 쌍의 중단은 프록시로 만든 부분 mesh 에서 본다. **실제 에이전트가 중단 뒤에 멈추는지는 `V-I5` 로만 보인다.** 미실행이면 **부분 검증** |
| **실행 통제: 권한 우회 없음** | `V-U8`, `V-L7`, `V-S1` (구조), `V-I1`, `V-I6` (실제 세션) | 구조 검사는 통과 가능. 실제 세션 관찰은 사람이 필요하다 |
| **관전** (PRD 밖. 사용자 요청 2026-11-16 "콘솔에서 스크립트로 접속해서 모니터링") | `V-U12`, `V-U8`, `V-L13`, `V-P8` | 같은 PC 에서 통과 가능. 서로 다른 PC 의 관전(NAT)과 Windows 의 `node dist/entry/monitor.js` 직접 실행은 **미실행**. 구버전 참가자와의 호환(`observer_unaware`)은 `V-U12` 의 6번(대역)으로만 본다 |

## 5. 이 PC 에서 할 수 있는 것과 없는 것

| 항목 | 이 환경에서 | 보고할 때 |
|---|---|---|
| 프로세스 여러 개의 mesh, 채팅, 상태 복제 | 할 수 있다 | 통과 / 실패 |
| 시그널의 유실·순서 뒤바뀜, 부분 mesh | 할 수 있다(시험용 프록시) | 통과 / 실패. 주입으로 만든 것임을 적는다 |
| 이 PC 의 실제 홈에 설치하고 등록된 명령으로 통신 | 할 수 있다. 사람도 모델도 필요 없다(`V-S1`, `V-S2`) | 통과 / 실패. 미실행으로 남기지 않는다 |
| 공용 서버 배포와 그 서버를 거친 통신 | 할 수 있다(AWS 계정, 발급된 인증서 필요) | 통과 / 실패 |
| 자체 호스팅 서버 | 이 PC 에서 `localhost` 로 할 수 있다 | 통과. "공용 IP 컴퓨터에서의 실행"과 "프록시·TLS 통과"는 미실행 |
| 서로 다른 PC 4대 | **할 수 없다** | 미실행 |
| 실제 NAT 통과, 실제 연결 불가 망 | **할 수 없다** | 미실행. 주입으로 만든 실패만 확인 |
| 대화형 채널 승인, 유휴 세션 깨우기, 실제 호스트의 poll 반복 | 사람이 있어야 한다 | 실행했으면 그 결과, 아니면 미실행. 미실행이면 "자동 수신"은 부분 검증이다 |
| 실제 에이전트의 자율 협업 | 사람, 모델 호출, 대상 서비스가 있어야 한다 | 위와 같음 |
| Windows, Linux | **할 수 없다** | 미실행 |
| 다른 호스트 버전, 조직 정책이 걸린 계정 | **할 수 없다** | 미실행 |
| 실제 프록시 뒤의 자체 호스팅 | 범위 밖 | 미실행 |

루프백에서 잰 시간(연결 수십 ms 등)을 실제 망의 보장으로 적지 않는다.

## 6. 소켓 서버 결함 주입

대상은 시그널링 서버다. 스트림 모델은 "연결별 독립 대화"다. 서버가 지킬 것은 하나다. **한 연결의 잘못된 입력·단절·느림이 다른 연결을 멈추지 않는다.**

주입마다 여섯 가지를 확인한다: ① 프로세스가 살아 있고 `/healthz` 가 응답한다, ② 미처리 예외가 없다, ③ 무관한 연결(대조군 두 개가 주입 내내 `ping`·`signal` 을 주고받는다)이 정상이다, ④ 여유가 있으면 신규 접속이 되고 꽉 차면 거절된다, ⑤ 문제 연결만 정한 사유로 처리된다, ⑥ 이후 `SIGTERM` 에 5초 안에 끝난다.

| # | 주입 | 대상 | 기대 처리 | 영향 없어야 하는 것 | 관측 | 복구 기준 |
|---|---|---|---|---|---|---|
| F-01 | 깨진 JSON, 스키마 위반을 초당 수십 건 | 한 연결 | `BAD_MESSAGE` 응답, 연결 유지. 한도를 넘으면 `RATE_LIMITED` 후 닫힘 | 대조군 | `conn.rejected`, `rate.limited` | 주입을 멈추면 즉시 |
| F-02 | 16KB+1, 1MB 프레임 | 한 연결 | `MESSAGE_TOO_LARGE`. 1MB 는 `ws` 가 받지 않고 닫는다 | 대조군 | 메모리 | 즉시 |
| F-03 | 접속만 하고 `join` 을 보내지 않음 | 연결 50개 | 10초 뒤 닫힘 | 대조군, 신규 접속 | `conn.drop{reason: join_deadline}` | 10초 |
| F-04 | 등록 뒤 `signal` 을 초당 수백 건 | 한 연결 | `RATE_LIMITED`, 닫힘. 대상 연결이 받는 건수가 한도 이하 | 대조군, 대상 연결의 다른 통신 | `rate.limited` | 즉시 |
| F-05 | 받지 않는 피어(소켓은 열어 두고 읽지 않음)에게 시그널을 계속 전달 | 한 연결 | 그 연결의 보낼 버퍼가 1MiB 를 넘으면 닫는다 | 보내는 쪽 연결, 대조군 | `server.stats.rss_mb` | 닫힌 뒤 메모리 회복 |
| F-06 | 클라이언트 프로세스 SIGSTOP (반열림과 비슷) | 한 참가자 | 90초 뒤 목록에서 빠지고 소켓이 닫힌다 | 같은 방의 다른 참가자 | `pong.members` | 90초 + 정리 주기 |
| F-07 | 클라이언트 SIGKILL | 한 참가자 | 기록이 바로 지워진다. 종료 처리가 한 번만 반영된다 | 같은 방의 다른 참가자 | `conn.closed` 1건 | 즉시 |
| F-08 | 총 연결 한도를 넘는 접속 | 서버 | 초과분은 503. `/healthz` 응답. 기존 연결 유지 | 기존 연결 전부 | `server.stats.rejected`(60초 주기), 그 전에는 `conn.refused{reason: max_connections}` 줄 수 | 접속이 줄면 즉시 수용 |
| F-09 | 핸드셰이크와 프레임을 1바이트씩 천천히 보냄 | 한 연결 | 핸드셰이크 기한과 미입장 기한으로 닫힘 | 대조군 | 연결 수 | 기한 |
| F-10 | 다른 방의 이름, 자기 자신, 없는 이름으로 `signal`. 등록 없이 `signal` | 한 연결 | `PEER_NOT_FOUND`, `BAD_MESSAGE`, `NOT_JOINED`. 다른 방에 도착하지 않음 | 다른 방 | `relay{outcome}` | 즉시 |
| F-11 | 같은 이름으로 10개 연결이 동시에 `join`. 인계 직후 옛 연결이 `ping`·`leave` | 한 방 | 등록은 하나. 옛 연결의 `leave` 가 새 기록을 지우지 못함 | 새 연결 | `conn.join{takeover}` | 즉시 |
| F-12 | 연결 수백 개가 열린 채 `SIGTERM` | 서버 | 5초 안에 종료 코드 0. 남은 프로세스 없음 | — | 종료 시간 | — |
| F-13 | WebSocket 제어 프레임(ping) 폭주, 바이너리 프레임 | 한 연결 | 바이너리는 그 연결만 1003 으로 닫힌다(protocol.md 2.1). 제어 프레임은 `ws` 가 처리한다. 프로세스 생존 | 대조군 | `loop_lag_ms`, `conn.drop{reason: binary_frame}` | 즉시 |
| F-14 | 허용하지 않은 `Origin` 헤더가 있는 핸드셰이크 | 한 연결 | HTTP 403 | — | — | — |

- F-13 의 제어 프레임은 연결별 속도 제한에 들어가지 않는다. 이벤트 루프 지연이 눈에 띄면 **결함으로 기록**하고 제한을 추가한다. 고정한 `ws` 8.23.0 은 내보내지 못한 자동 pong 이 60건에 닿으면 그 연결을 스스로 끊는다 **[실측 W1]**. 폭주를 보낸 연결이 끊기는 것은 이 주입의 실패가 아니다. `loop_lag_ms` 는 60초 주기라, 주입 중에는 대조군의 왕복 시간으로 대신 본다.
- 관측 칸의 사건 이름은 구현 뒤의 이름이다([architecture.md 6.1](architecture.md#61-진단-질문과-사건)). `conn.closed` 는 등록이 지워질 때만 나오고, 리스너가 끊은 것은 `conn.drop{reason}`, 업그레이드 거절은 `conn.refused{reason}` 이다. 통과 기준(기대 처리, 복구 기준)은 바꾸지 않았다.
- 주소별 연결 한도의 기본값이 20 이다. F-03(50개), F-08, F-12 처럼 한 PC 에서 연결을 많이 띄우는 주입은 `--max-connections-per-ip` 를 올려 띄운다.
- 클라이언트 쪽의 결함 주입(시그널 유실, 순서 뒤바뀜, 지연)은 서버가 아니라 시험용 프록시로 한다. 그것은 3.2의 `V-L3`, `V-L11`, `V-L12` 가 맡는다.
- 공용 서버에는 F-01, 02, 04, 07, 10, 11, 14 를 와이어 계약 테스트와 `V-P3`, `V-P5` 범위에서 실행한다. F-03, 05, 08, 09, 12, 13 은 API Gateway 가 맡는 영역이라 **해당 없음**으로 적는다(서버 프로세스가 없다). F-06 은 `V-P3` 이다.
- 공용 서버에 부하를 거는 시험은 스로틀 한도 안에서만 한다. 비용이 드는 시험이므로 횟수를 이력에 남긴다.
- 정책 단위 시험(대역에서 규칙만 돌린 것)과 실제 소켓으로 일으킨 것을 구분해 보고한다.

## 7. 테스트 실행 이력 운영

기준은 모듈 경계 가이드의 "테스트 실행 이력"이다. 위치는 저장소의 `tests/test-history/` 다.

- **실행 전**: [색인](../../tests/test-history/README.md)에서 관련 이력을 읽는다. 참고한 이력 ID 와, 반영했거나 제외한 이유를 새 기록에 적는다. 첫 구현 실행은 `2026-11-15-pre-implementation-assumptions` 를 참고한다.
- **기록 파일**: `tests/test-history/<날짜>-<작업 이름>.md`. 작업 묶음마다 파일 하나를 쓰면 병렬 작업끼리 충돌하지 않는다. 색인(`README.md`)은 통합 담당만 고친다.
- **실행 ID**: 접두어로 수준을 드러낸다. `U-`(대역), `L-`(로컬 실물), `P-`(공용 서버), `S-`(실제 설치), `I-`(실제 에이전트), `A-`(가정 확인), `D-`(문서 검토). 구현 전 조사는 `PRE-` 를 쓴다. 예: `L-MESH-03`. 같은 명령을 다시 돌리면 새 ID 다.
- **항목마다 남길 것**: 시작·종료 시각(KST), 기준 커밋과 미커밋 변경 범위, 대상과 시나리오, 실제 명령과 환경, 기대와 실제, 판정(통과·실패·부분·차단·중단·미실행), 참고한 이전 실행, 다음에 확인할 것.
- **가정 확인**은 가정 ID(`A-…`)와 연결한다. 결과에 따라 이 문서 2절의 "지금 근거" 칸을 고친다.
- **확정한 기록은 고치지 않는다.** 정정과 재검증은 원래 ID 를 가리키는 새 항목으로 쓴다.
- **원문 증거**(프로세스 로그, 진단 로그, CloudWatch 추출)는 7일 뒤 지운다. 기록에는 재현 명령·조건·판정 근거를 요약으로 남기고, 증거의 위치와 만료 여부를 적는다. 요약에 채팅 본문, 방 ID, 인증서 ARN, 계정 ID 를 넣지 않는다.
- 이력 쓰기에 실패하면 그 사실을 보고한다. 저장을 확인하기 전에는 검증을 끝냈다고 하지 않는다.
- 이 설계 문서의 검토와 재검토도 `D-` 기록으로 남긴다([설계 검토 이력](../../tests/test-history/2026-11-15-design-review.md)). 그림은 렌더러 없이 봤다면 "정적 검토"라고 적는다.
- 공용 서버의 저장소 계약 검증(`npm run test:store`)은 운영 테이블에 직접 쓴다. 실행 ID, 만든 항목 수, 끝난 뒤 남은 항목 수를 기록에 남긴다.

## 8. 완료 보고

구현이 끝났다고 말하려면 다음이 모두 있어야 한다.

- 3절의 `V-U*`, `V-L*`, `V-P*`, **`V-S1`, `V-S2`** 가 실행됐고 결과가 이력에 있다. `V-S1`·`V-S2` 는 사람도 모델도 필요 없으므로 미실행으로 남길 수 없다. 실행하지 못했으면 "미완료"다.
- `V-I*` 는 항목마다 "실행함(결과) / 미실행(사유)"이 적혀 있다.
- 2절의 가정마다 "확인됨 / 틀림(설계 반영함) / 미실행(사유)" 중 하나가 적혀 있다.
- 4절의 완료 기준마다 판정과 증거 수준이 적혀 있다. "서로 다른 PC 4대"와 실제 NAT 는 미실행으로 적는다.
- **통과로 세지 않는 경우.** `V-I1` 이 미실행이면 "설치"는 부분 검증이다. `V-I3`·`V-I4` 가 미실행이면 "자동 수신"은 부분 검증이고, 실행한 호스트만 따로 통과로 적는다. `V-I5` 가 미실행이면 "자율 협업"과 "실행 통제: 중단과 제한"은 부분 검증이다. 부분 검증이 하나라도 있으면 전체를 "완료"라고 보고하지 않는다. "구현 완료, 완료 기준 N개 부분 검증(사람이 필요한 항목 미실행)"으로 보고한다.
- 실패나 미구현이 남아 있으면 "미완료"로 보고한다. 반복 횟수나 통과한 시나리오 수로 완료를 판정하지 않는다.
