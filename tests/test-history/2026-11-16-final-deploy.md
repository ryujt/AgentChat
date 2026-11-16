# 2026-11-16 마감 재배포: 검토 반영분 배포(`V-P1` 재확인)와 재현성(`V-P6`)

독립 검토 1~3차에서 고친 서버 코드(SERVER-R1-01·03, SERVER-R2-01·02, SERVER-R3-01)를 공용 서버 스택 `agent-chat-signaling` 에 배포해 `V-P1` 을 다시 보고, 공용 서버 로그에서 검토 3차의 `conn.join{cause=claimed}` 경로를 확인한 뒤, `destroy.sh --yes` 로 스택을 지우고 `deploy.sh` 로 다시 만들어 `V-P1` 이 다시 통과하는지(`V-P6`, [검증 계획](../../docs/design/verification-plan.md) 3.3) 본 기록이다.

- 작업 ID: `2026-11-16-final-deploy`
- 기준(통과 기준, 실행 전 고정): `V-P1` — `deploy.sh` 종료 코드 0, `verify.mjs` 전 항목 통과(동시 입장의 정원·생성 판정, 여분 프레임 0건 포함), `npm run test:store -- --table … --region …` 통과·끝난 뒤 시험 항목 0건. `V-P6` — `destroy.sh` 뒤 `deploy.sh` 를 다시 실행해 `V-P1` 통과. 지시에 따른 덧붙임: 삭제 완료와 A 레코드 없음, 인증서·검증용 CNAME·호스팅 영역이 남는다. 끝나면 공용 서버가 떠 있다.
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e` + 커밋하지 않은 작업 트리(검토 3차 반영 뒤. `npm test` 1565, `npm run test:e2e` 13/13 이 그 상태의 마지막 결과). 이 작업에서 고친 저장소 파일은 이 기록 하나다. 다른 담당은 일하지 않았다.
- 환경: macOS 27.2 arm64 한 대, Node v26.12.1, AWS CLI 2.39.0. AWS 는 서울(`ap-northeast-2`), 기본 프로필(계정 `<ACCOUNT>` 의 **루트 자격 증명**. 이전 기록의 남은 것 그대로), 호스팅 영역 `<ZONE>`. 인증서 ARN 은 스크래치 파일에서 읽어 넘겼고 이 문서에 적지 않았다.
- 빌드: 공용 `dist` 를 `npm run build` 로 만들었다. 검증은 `AGENT_CHAT_DIST=<repo>/dist`. Lambda 번들은 `deploy.sh` 안의 `npm run build:lambda`. `npm ci` 는 하지 않았다(`--skip-install`).
- 참고한 이전 이력: `2026-11-15-w9-redeploy`(갱신 경로의 `V-P1`, 명령 모양), `2026-11-15-w2`(처음 배포 뒤 약 3분의 HTTP 400), `2026-11-16-review-r3`(남은 것 1: 배포 뒤 `test:store`·`verify.mjs`·`conn.join{cause=claimed}`), `2026-11-15-gate3`.
- 원문 증거: 명령 출력과 탐색 스크립트(`claimed-probe.mjs`, `claimed-logs.mjs`)는 세션 스크래치 `…/scratchpad/final/final-deploy/` 에 있다(방 ID·이름·key 가 든 파일은 권한 600). 세션이 끝나면 사라진다. 이 문서에 방 ID, 참가자 이름, key, sid, 계정 ID, 인증서 ARN, API ID 는 없다.
- 실행 ID: 대역 `U-FD-NN`, 실제 환경 `P-FD-NN`. 시각은 KST(2026-11-16).

## 요약

| 완료 기준 | 판정 | 증거 수준 | 근거 |
|---|---|---|---|
| 검토 반영분 배포: `deploy.sh` 종료 코드 0(갱신 경로) | **통과** | 실제 환경 | P-FD-01 |
| 같은 배포의 `verify.mjs` 전 항목(`--verify-full`: flood, 동시 항목 10회 포함) | **통과**. 1번 셋 3/3, 와이어 26/26, 정원 초과·이중 생성 0회, 여분 프레임 0, 닫히지 않은 연결 0 | 실제 환경 | P-FD-01 |
| 같은 배포의 `test:store`(남은 항목 0) | **통과**. 29/29(검토 3차의 `claimed` 시험 포함), 남은 항목 0, Scan 0 | 실제 환경 | P-FD-02 |
| **`V-P1` 재확인(검토 반영분)** | **통과** | 실제 환경 | 위 셋 |
| 공용 서버 로그의 `conn.join{cause=claimed}` 경로 | **통과(관찰한 범위)**. 같은 join 을 한 연결로 두 번 보낸 64회 중 17회에서 `cause=claimed` 가 나왔고 17줄 모두 `outcome=joined`. 64회 모두 첫 답이 `joined`, 오류 답 0, 뒤 `ping` 의 `pong` 목록이 맞다. 함수 로그의 warn·error 0 | 실제 환경 | P-FD-03, 04, 10 |
| `destroy.sh --yes`: 삭제 완료, A 레코드 없음 | **통과**. 종료 코드 0, 스택 `DELETE_COMPLETE`, 함수·테이블·도메인·API·로그 그룹·역할 없음 | 실제 환경 | P-FD-06, 07 |
| 남아야 할 것: 인증서, 검증용 CNAME, 호스팅 영역 | **통과**. 인증서 `ISSUED`(사용처 없음), CNAME 그대로, 영역 그대로 | 실제 환경 | P-FD-07 |
| 다시 만든 스택의 `deploy.sh` 종료 코드 0(처음 배포 경로) | **통과**. 핸드셰이크가 HTTP 400 이던 162.6초(17회 시도)를 `verify.mjs` 가 기다린 뒤 열림 | 실제 환경 | P-FD-08 |
| 다시 만든 스택의 `verify.mjs` 전 항목 | **통과**. 와이어 26/26, 정원 초과·이중 생성 0회, 여분 프레임 0, 닫히지 않은 연결 0 | 실제 환경 | P-FD-08 |
| 다시 만든 스택의 `test:store` | **통과**. 29/29, 남은 항목 0, Scan 0 | 실제 환경 | P-FD-09 |
| **`V-P6`** | **통과** | 실제 환경 | P-FD-06~09 |
| 공용 서버가 떠 있다 | 통과. 스택 `CREATE_COMPLETE`, 자원 16개(지우기 전과 같은 구성), 로그 보존 7일, 스로틀 25/100, 테이블 항목 0 | 실제 환경 | P-FD-11 |

- 실패·중단한 실행: 없음.
- 스택은 다시 만든 상태로 두었다(`CREATE_COMPLETE`). API ID 가 바뀌었다(사용자 지정 도메인 `wss://agent-chat.tools.camp` 는 같다).

## 실행 기록

| ID | 시각 | 수준 | 대상 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|---|
| P-FD-00 | 05:30 | 실제 환경 | 실행 전 상태(읽기만) | `sts get-caller-identity`, `cloudformation describe-stacks`·`list-stack-resources`, `lambda get-function-configuration`, `route53 list-resource-record-sets`, `acm describe-certificate` | — | 자격 증명은 계정 루트. 스택 `UPDATE_COMPLETE`(마지막 갱신 2026-11-15 20:28 KST), 자원 16개, 함수 코드는 W9 재배포 때의 묶음(검토 전 코드). `agent-chat` 이름 레코드는 A 와 검증용 CNAME 둘. 인증서 `ISSUED`, 만료 2027-06-01 | 사실 확인 |
| U-FD-01 | 05:30:36 ~ 31:02 | 대역 | 빌드와 서버 단위 시험 | `npm run build`, `node --test --enable-source-maps "dist/signaling-aws/**/*.test.js" "dist/signaling-core/**/*.test.js"`, `npm run test:deploy` | 오류 0, 전부 통과 | 빌드 종료 코드 0. 단위 76/76. 배포 스크립트 시험 10/10 | 통과 |
| P-FD-01 | 05:31:17 ~ 32:26 | 실제 환경 | **검토 반영분 배포(갱신 경로)와 `verify.mjs` 전 항목** | `AGENT_CHAT_DIST=<repo>/dist sh deployments/aws/deploy.sh --region ap-northeast-2 --domain agent-chat.tools.camp --certificate-arn "$(cat <scratch>/acm-arn.txt)" --hosted-zone-id <ZONE> --skip-install --verify-full` | 종료 코드 0, 검증 전 항목 통과 | **종료 코드 0**(1분 9초). 사전 점검 통과(이 제품의 스택: 태그·설명·출력, `UPDATE_COMPLETE` → 갱신, 이 스택의 A 레코드, CloudWatch 역할 있음). 번들 799.7kB, 묶음 134,207바이트. 템플릿은 바뀐 것이 없어 `No changes to deploy`. 함수 코드 올림과 해시 일치. verify 1번: 도메인 조회 243ms(1회), TLS(TLSv1.3, CN·SAN 이 도메인, 발급자 Amazon, 만료 2027-06-01), 핸드셰이크(첫 시도, `NOT_JOINED` 1186ms). 와이어 **26/26**. 측정값: `connect_ms` 62, `join_ms` 309, `ping_ms` 197, 강제 종료 뒤 `PEER_NOT_FOUND` 152ms, 동시 입장 통과 0 인 회차 8/10(2 이상 0회), 동시 생성 성공 0 인 회차 6/10(2 이상 0회), 같은 이름 10개 동시 → 등록 1, 처리 299건 뒤 `RATE_LIMITED`(보낸 301), Origin 403, 여분 프레임 모두 0, 연결 147, 닫히지 않은 연결 0. `검증 통과`, `배포 완료` | **통과** |
| P-FD-02 | 05:32:34 ~ 32:51 | 실제 환경 | **`test:store`**(운영 테이블) | `AGENT_CHAT_DIST=<repo>/dist npm run test:store -- --table agent-chat-signaling-table --region ap-northeast-2` | 전부 통과, 남은 항목 0 | **29/29**(16.9초). 실행 ID `df40b65ac058`. W9 재배포 때 26 에서 늘었다. 검토 3차의 "읽기는 차지 표시(`claimed: true`)를 싣는다…" 와 바뀐 기대값 2건 포함. 쓴 항목 62, 건드린 키 156. 정리 전 남은 항목 0, 정리 후 0, Scan 0 | **통과** |
| P-FD-03 | 05:33:28 ~ 35:24 | 실제 환경 | **`conn.join{cause=claimed}` 경로 탐색.** 한 연결이 같은 join(같은 `id`·`sid`·`key`·`seq`)을 간격 d(0, 5, 10, 20, 30, 45, 60, 90ms)로 두 번 보낸다. 모드 `create`(빈 방)와 `join`(만든 쪽이 있는 방). 3회 × 8간격 × 2모드 = 48회. 답을 모은 뒤 `ping` 으로 등록과 목록을 본다. 와이어 메시지만 보낸다(`tests/wire/wire-client.mjs`). 제품 코드는 그대로 | `AGENT_CHAT_DIST=<repo>/dist node <scratch>/claimed-probe.mjs <repo> wss://agent-chat.tools.camp <scratch>/p03-claimed.json 3` | 같은 요청에 모순된 답(오류와 `joined`)이 없다. 등록된다 | 48/48 첫 답 `joined`, 48/48 `joined` 두 번(클라이언트는 기다리는 `re` 의 첫 것만 받는다), 오류 답 0, `ping` 48/48 `pong`, 목록 크기 48/48 맞음(`create` 0, `join` 1), 여분 프레임 0 | 통과(탐색) |
| P-FD-04 | 05:35:3x | 실제 환경 | P-FD-03 의 함수 로그 | `node <scratch>/claimed-logs.mjs <scratch>/p03-claimed.json <scratch>`(`aws logs filter-log-events` 쪽 넘김 전부) | `cause=claimed` 줄이 나오고 모두 `outcome=joined`. warn·error 0 | 함수 로그 1416줄 = 플랫폼 1152 + 앱 JSON 264, 해석 안 되는 줄 0, 수준 info 264(warn·error 0). 탐색의 `conn.join` 96줄(48회 × 2). 회당 두 줄의 꼴: `joined + joined/claimed` **14회**, `joined + joined` 21회, `joined + resent` 13회. `cause=claimed` 14줄 모두 `outcome=joined`. 간격별: `claimed` 는 5~60ms 와 `create` 0ms 에서, 90ms 는 6/6 `resent`, 10ms 는 6/6 `joined + joined` | **통과**(관찰 1) |
| P-FD-05 | 05:35:4x | 실제 환경 | 탐색 뒤 테이블 | `dynamodb scan --consistent-read --select COUNT`, `pgrep` | 0, 남은 프로세스 0 | 0, 0 | 통과 |
| P-FD-06 | 05:36:00 ~ 37:05 | 실제 환경 | **`V-P6`: `destroy.sh --yes`** | `sh deployments/aws/destroy.sh --region ap-northeast-2 --yes` | 종료 코드 0, 스택 없음, A 레코드 없음 | **종료 코드 0**(1분 5초). 대상 출력(도메인, 지워지는 것, 남는 것) → 삭제 요청 → `확인: 스택 agent-chat-signaling 없음`, `확인: agent-chat.tools.camp 의 A 레코드 없음`, `삭제 완료`. 지우기 전 자원 목록(16개)은 스크래치에 받아 둠 | **통과** |
| P-FD-07 | 05:37:1x | 실제 환경 | 삭제 상태 독립 확인(스크립트 밖) | `cloudformation describe-stacks`·`list-stacks --stack-status-filter DELETE_COMPLETE`, `route53 list-resource-record-sets`·`get-hosted-zone`, `acm describe-certificate`, `dynamodb describe-table`, `lambda get-function`, `apigatewayv2 get-domain-name`·`get-apis`, `logs describe-log-groups`, `iam get-role`(지우기 전 목록의 역할 이름) | 스택 소유 자원 모두 없음. 인증서·CNAME·영역은 남음 | 스택 `does not exist`, 삭제 목록에 `DELETE_COMPLETE`. 테이블·함수 `ResourceNotFoundException`, 도메인 `NotFoundException`, 이름에 `agent-chat` 이 든 API 0, `/agent-chat/` 로그 그룹 0, 역할 `NoSuchEntity`. `agent-chat` 이름 레코드는 검증용 CNAME 하나. 영역 그대로(레코드 23). 인증서 `ISSUED`, `InUseBy` 빈 목록 | **통과** |
| P-FD-08 | 05:37:33 ~ 42:30 | 실제 환경 | **`V-P6`: 다시 만들기(처음 배포 경로)와 `verify.mjs` 전 항목** | `AGENT_CHAT_DIST=<repo>/dist sh deployments/aws/deploy.sh --region ap-northeast-2 --domain agent-chat.tools.camp --certificate-arn "$(cat <scratch>/acm-arn.txt)" --hosted-zone-id <ZONE> --skip-install` | 종료 코드 0, 검증 전 항목 통과(처음 배포는 늘 전체) | **종료 코드 0**(4분 57초). 사전 점검: 스택 없음(새로 만든다), `DNS 레코드: … 아직 없다`. 스택 `REVIEW_IN_PROGRESS` 05:37:39 → `CustomDomain` 05:37:52 → `DnsRecord` 05:38:25 → `DomainMapping` 05:38:42 → 스택 `CREATE_COMPLETE` 05:38:43. 같은 묶음 134,207바이트, 함수 코드 올림과 해시 일치(묶음 해시는 P-FD-01 과 다르다. 관찰 3). verify 1번: 도메인 조회 153ms(1회), TLS 통과, 핸드셰이크는 **HTTP 400 으로 17회 시도, 162.6초 기다린 뒤 열림**(`NOT_JOINED` 1495ms). 와이어 **26/26**. 측정값: `connect_ms` 122, `join_ms` 309, `ping_ms` 79, 강제 종료 뒤 `PEER_NOT_FOUND` 69ms, 동시 입장 통과 0 인 회차 5/10(2 이상 0회), 동시 생성 성공 0 인 회차 5/10(2 이상 0회), 같은 이름 → 등록 1, 처리 299건 뒤 `RATE_LIMITED`(보낸 300), Origin 403, 여분 프레임 모두 0, 연결 147, 닫히지 않은 연결 0 | **통과** |
| P-FD-09 | 05:42:40 ~ 42:58 | 실제 환경 | **`V-P6`: 새 테이블의 `test:store`** | `AGENT_CHAT_DIST=<repo>/dist npm run test:store -- --table agent-chat-signaling-table --region ap-northeast-2` | 전부 통과, 남은 항목 0 | **29/29**(17.6초). 실행 ID `b88ce40b4dbb`. 남은 항목 정리 전 0·후 0, Scan 0 | **통과** |
| P-FD-10 | 05:43:04 ~ 43:43 (로그 05:43:5x) | 실제 환경 | 다시 만든 스택에서 `cause=claimed` 경로 재확인(1회 × 8간격 × 2모드 = 16회)과 함수 로그 | `… claimed-probe.mjs … p08-claimed.json 1`, `node <scratch>/claimed-logs.mjs <scratch>/p08-claimed.json <scratch>` | P-FD-03·04 와 같음 | 16/16 첫 답 `joined`, 오류 답 0, `pong` 16/16·목록 맞음, 여분 프레임 0. 함수 로그 464줄(앱 87, 해석 안 되는 줄 0, info 87). 탐색 `conn.join` 32줄. `joined + joined/claimed` 3회, `joined + joined` 8회, `joined + resent` 5회. `claimed` 3줄 모두 `outcome=joined`, 필드에 `takeover` 없음(관찰 1) | 통과 |
| P-FD-11 | 05:44 | 실제 환경 | 끝난 뒤 상태 | `cloudformation describe-stacks`·`list-stack-resources`·`describe-stack-events`, `route53 list-resource-record-sets`, `lambda get-function-configuration`, `logs describe-log-groups`, `apigatewayv2 get-stage`, `dynamodb describe-time-to-live`·`scan`, `pgrep`, `git status --short` | 서버가 떠 있다. 지우기 전과 같은 구성 | 스택 `CREATE_COMPLETE`, 태그 `project=agent-chat`, 자원 16개 모두 `CREATE_COMPLETE`, 논리 ID·형식이 지우기 전 목록과 같다(`diff` 0). `agent-chat` 이름 레코드는 이 스택의 A 와 검증용 CNAME 둘. 함수 `nodejs24.x`·arm64·256MB·10초, Active·Successful, 코드 해시가 P-FD-08 에 올린 묶음과 같음. 로그 그룹 둘 다 보존 7일. 스테이지 스로틀 25/100, 접근 로그 형식이 템플릿과 같음. TTL `ENABLED`(`ttl`). 테이블 항목 0. 남은 로컬 프로세스 0. 작업 트리는 이 기록 외에 바뀐 추적 파일 없음(`build/`·`dist/` 는 무시 대상) | 통과 |

- AWS 변경은 스택 `agent-chat-signaling` 의 함수 코드 갱신(P-FD-01), 그 스택과 소유 자원의 삭제(P-FD-06)와 다시 만들기(P-FD-08), 그 테이블의 시험 항목(모두 지움)뿐이다. 다른 스택, 인증서, 검증용 CNAME, 호스팅 영역의 다른 레코드, S3, IAM 사용자, EC2 는 건드리지 않았다. 스택이 소유한 함수 역할은 스택과 함께 지워지고 다시 만들어졌다. 계정의 API Gateway CloudWatch 역할은 읽기만 했다.
- 로컬 포트는 쓰지 않았다(공용 서버에만 붙음).

## 설계와 다른 관찰

1. **공용 서버에서 본 `cause=claimed` 는 "다른 실행이 지금 등록하는 중" 쪽이다.** 같은 join 의 두 번째 처리가 앞선 처리의 차지 뒤·등록 전 기록을 읽은 경우로, `core.ts` 의 "모두 같다" 분기다(P-FD-10 의 3줄에 `takeover` 필드가 없다. P-FD-04 의 14줄은 이 필드를 따로 보지 않았다. 판정 실패 뒤 다시 읽은 기록이 차지돼 있는 두 번째 분기는 `takeover` 를 싣는다). 두 처리 모두 `joined` 를 보내 클라이언트는 같은 `re` 의 `joined` 를 둘 받았고, 첫 것만 받는 제품 클라이언트 규칙([review-r3](2026-11-16-review-r3.md) SERVER-R3-01)에 맞다. 검토 3차가 고친 본래 경우(앞선 처리가 차지한 뒤 `bind`·응답 전에 **실패**)와 판정 실패 뒤의 두 번째 분기는 실제 서버에서 일으키지 않았다. 저장소 실패를 일으키려면 결함 주입이 필요하고, 제품 코드에 시험용 분기를 두지 않으므로 대역·메모리 저장소 시험(review-r3 U-R3-01, L-R3-02)이 근거로 남는다. DynamoDB 쪽의 `claimed` 읽기는 `test:store` 의 새 시험이 실제 테이블에서 통과했다(P-FD-02, 09).
2. **동시 입장·생성의 "모두 거절"**: 갱신 배포에서 입장 8/10, 생성 6/10, 다시 만든 스택에서 5/10, 5/10(W9 재배포 6/10, 3/10). 정원 초과와 이중 생성은 이번에도 0회다. 기준(통과 1 이하)은 지켰고, "모두 거절" 빈도는 기준 밖의 기록 값이다.
3. **같은 소스로 만든 묶음의 해시가 배포마다 다르다.** P-FD-01 과 P-FD-08 의 묶음은 크기(134,207바이트)가 같고 해시가 다르다. `deploy.sh` 가 번들을 다시 만들 때 zip 안의 파일 시각이 바뀌기 때문으로 보인다 **[추론. 묶음 내용은 비교하지 않았다]**. `deploy.sh` 는 올린 해시와 로컬 묶음 해시가 같은지만 보므로 판정에는 영향이 없다.
4. **처음 배포 뒤의 HTTP 400 구간**: 스택 완료(05:38:43)부터 핸드셰이크가 열리기까지 약 2분 40초. `verify.mjs` 가 기다려 넘겼다(알려진 동작, A-AWS-8).
5. P-FD-04 의 원문 함수 로그 파일(`claimed-fn-raw.json`)은 P-FD-10 이 같은 이름으로 덮어써 P-FD-10 의 원문만 남았다. P-FD-04 의 집계(`p04-claimed-logs.json`)는 남아 있다.

## 미실행과 이유

- `npm ci` 경로: 지시대로 하지 않았다(`--skip-install`).
- 전체 `npm test`·`npm run test:e2e`: 이번 작업은 코드를 바꾸지 않아 다시 돌리지 않았다(검토 3차 상태의 1565, 13/13). 서버 단위 시험과 배포 스크립트 시험만 돌렸다(U-FD-01).
- `cause=claimed` 의 실패 뒤 경로와 판정 실패 뒤 두 번째 분기: 관찰 1.
- 경보(`--alarm-topic-arn`), `--access-log off`, `--reserved-concurrency` 분기: 실행하지 않았다(이전과 같음).
- `V-P2`~`V-P5`, `V-P7` 의 새 서버 재실행: 이번 범위 밖. `V-P7`(나)는 실패 그대로다.
- 최소 권한 배포자로의 전환: 이번에도 루트 자격 증명으로 배포했다. IAM 사용자를 만들거나 바꾸는 일은 범위 밖이다.

## 다음에 확인할 것

- 새 서버(검토 반영분)에서 `V-P2`·`V-P3`·`V-P5`·`V-P7` 과 `V-S2` 등 공용 서버를 쓰는 항목.
- 배포 자격 증명을 최소 권한 사용자로 바꾼 뒤의 재배포.
