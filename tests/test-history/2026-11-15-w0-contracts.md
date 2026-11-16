# 2026-11-15 W0 전반부: 패키지 설정과 protocol 모듈

작업 묶음 W0([구현 계획](../../docs/design/implementation-plan.md#3-작업-묶음)) 가운데 패키지 설정, `src/protocol/**`, `src/diagnostics/log-port.ts`, `tests/support/proc.mjs` 를 만들고 검증한 기록이다. `contract.ts` 들, `src/signaling-core/ports.ts`, `src/boundaries.test.ts`(`V-U8`)는 이 기록의 범위가 아니다(다음 담당).

- 작업 ID: `2026-11-15-w0-contracts`
- 대상: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `src/protocol/**`(구현 11개, 테스트 10개), `src/diagnostics/log-port.ts`, `tests/support/proc.mjs`
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e`. 미커밋 변경은 `docs/`, `tests/test-history/`(이전 기록)와 위 대상 파일이다. 실행 중 다른 묶음의 파일은 작업 트리에 없었다.
- 환경: macOS 27.2.1 arm64 한 대, Node v26.12.1, npm 11.20.0. 설치된 버전은 아래 "설치된 의존성" 표.
- 검증 수준: 대역(`V-U1`). 네트워크, 실제 서버, 실제 호스트를 쓰지 않았다. `tests/support/proc.mjs` 확인만 실제 프로세스를 띄웠다(로컬 실물).
- 참고한 이전 이력:
  - `2026-11-15-pre-implementation-assumptions`: PRE-MCP-02(SDK 1.32.2 + zod 4.6.7 조합), PRE-RTC-12(`--omit=optional` 이면 네이티브 로드 실패), PRE-RTC-18(node-datachannel 타입 검사), PRE-RTC-11(relay 후보 필터), PRE-CH-10(SDK 1.32.2 고정 이유). 반영: 같은 버전을 고정했고, 설치에 `--omit=optional` 을 쓰지 않았고, 설치 뒤 네이티브 로드를 확인했다(W0-04, W0-16).
  - `2026-11-15-aws-apigw-websocket-probe`: PRE-AWS-02(Lambda 런타임 내장 SDK 3.1105.0). 반영: 개발 의존성의 AWS SDK 를 같은 3.1105.0 으로 고정했다.
  - `2026-11-15-design-review`: 문서 검토 기록이라 실행 조건에는 쓰지 않았다. 미실측으로 남은 규칙 가운데 이번에 스키마 수준으로 본 것은 `sync_end` 의 `test_id`·`test_elapsed_ms` 짝과 후보 묶음의 형식이다. 동작(재전송, 대기 큐, 경과 시간 계산)은 이 기록의 범위가 아니다.
- 원문 증거: 명령 출력과 탐색 스크립트는 세션 임시 폴더(아래 `<scratch>` = 세션 임시 폴더의 `w0/`)에 있었고 보존 대상이 아니다. 재현에 필요한 명령·조건·판정은 이 문서에 적었다.
- 실행 ID: 지시에 따라 `W0-NN` 을 썼다. 수준은 표의 "수준" 칸에 적었다([검증 계획 7절](../../docs/design/verification-plan.md#7-테스트-실행-이력-운영)의 접두어 `U-`·`L-` 에 해당).

## 요약

| 항목 | 결과 | 근거 실행 |
|---|---|---|
| 설계가 고정한 의존성 버전이 레지스트리에 있다 | 통과. 넷 다 있다 | W0-01 |
| `npm install` 이 경고 없이 끝난다 | 처음에는 실패(peer 충돌 경고). `overrides` 한 줄로 해소. npm 11 이 esbuild 의 설치 스크립트를 실행하지 않았다는 알림은 남는다(동작에는 영향 없음) | W0-03, W0-04 |
| `npm install` → `npm run build` → `npm test` 가 통과한다 | 통과. 테스트 266건, 실패 0건 | W0-15, W0-21 |
| 잠금 파일만으로 깨끗이 설치해도 같은 결과다 | 통과 | W0-16 |
| `V-U1`: protocol 의 스키마 통과·거절 표본, 주소 정규화 표의 모든 행과 오류 입력, ICE 검증, relay 후보 판별 | 통과. 첫 실행의 실패 1건은 테스트의 기대값 칸에 임시 값이 있던 것 | W0-06 ~ W0-08, W0-15 |
| 테스트가 규칙 위반을 실제로 잡는다 | 표본 변이 24건 가운데 23건을 잡았다. 남은 1건은 도달하지 않는 줄의 변이(동작이 같다) | W0-10, W0-11 |
| 묶음별 빌드 폴더(`--outDir .work/<묶음>/dist`)와 `AGENT_CHAT_DIST` 가 동작한다. 다른 묶음의 타입 오류가 있어도 산출물이 나온다 | 통과(저장소 사본에서) | W0-17 |
| protocol 이 Lambda 번들 방식(esbuild)으로 묶인다 | 통과. 781.3kb, 외부 import 는 `node:crypto` 뿐 | W0-09 |
| `tests/support/proc.mjs`: 띄우기, 종료 대기, 남은 프로세스 확인 | 통과(15단계). 도중의 실패 2건은 확인 스크립트 쪽 문제였다 | W0-12, W0-13, W0-19, W0-20 |
| `LogPort` 와 protocol 타입이 의도대로 좁혀지고 거절한다 | 통과(컴파일 확인) | W0-18 |

## 설치된 의존성

| 패키지 | 버전 | 정한 근거 |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 | 설계 고정값 |
| `zod` | 4.6.7 | 설계 고정값 |
| `ws` | 8.23.0 | 설계 고정값 |
| `node-datachannel` | 0.33.6 | 설계 고정값 |
| `typescript` | 7.0.2 | 설계에 버전 없음. 레지스트리 최신. MCP SDK 타입 검사를 이 버전으로 한 적이 있다(조사). 이번에 전 라이브러리 import 를 컴파일했다(W0-02) |
| `@types/node` | 22.20.5 | 설계에 버전 없음. 패키지 하한(Node 22)에 맞춘 22 계열 최신. 22 에 없는 API 를 쓰면 컴파일에서 걸린다 |
| `@types/ws` | 8.18.2 | 설계에 버전 없음. 레지스트리 최신 |
| `esbuild` | 0.28.2 | 설계에 버전 없음. 레지스트리 최신 |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-apigatewaymanagementapi` | 3.1105.0 | 설계에 버전 없음. Lambda 런타임 내장 SDK 의 실측 버전(PRE-AWS-02)과 같게 했다. 레지스트리 최신은 3.1169.0 |
| (`overrides`) `@aws-sdk/util-dynamodb` | 3.996.7 | `lib-dynamodb` 3.1105.0 이 끌어오는 최신 util(3.996.9)이 client `^3.1111.0` 을 요구해 충돌한다. 3.996.7 은 `^3.1088.0` 을 요구한다(W0-03) |

## 실행 기록

시각은 KST 다. "경"은 파일 수정 시각에서 옮긴 것이다(실행 때 시각을 찍지 않았다).

| 실행 ID | 시각 | 수준 | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|---|
| W0-01 | 14:05 경 | 조회 | 설계가 적은 버전이 레지스트리에 있는가. 버전이 없는 개발 의존성의 최신 | `npm view <패키지>@<버전> version` (SDK 1.32.2, zod 4.6.7, ws 8.23.0, node-datachannel 0.33.6), `npm view <패키지> version` (개발 의존성 7개), `npm view @aws-sdk/…@3.1105.0 version` | 넷 다 있다 | 넷 다 있다. 최신: typescript 7.0.2, @types/node 26.6.6, @types/ws 8.18.2, esbuild 0.28.2, @aws-sdk 셋 3.1169.0. 3.1105.0 도 셋 다 있다 | 통과 |
| W0-02 | 14:07:41 ~ 14:16:34 | 탐색 | 후보 조합의 설치와 타입 검사. `<scratch>/probe7` | `npm install` → 모든 외부 라이브러리를 import 하는 파일과 일부러 틀린 파일을 두고 `npx tsc -p tsconfig.json` (strict, NodeNext, `skipLibCheck: false`) → `npx tsc -p tsconfig.json --outDir .work/x/dist` | 설치와 컴파일이 된다. 타입 오류가 있어도 산출물이 나온다. `outDir` 를 바꿀 수 있다 | 설치 138 패키지, 취약점 0. `skipLibCheck: false` 에서 MCP SDK 의 `shared/transport.d.ts` 가 DOM 타입 `HeadersInit` 를 찾지 못해 TS2304 1건. 틀린 파일의 TS2322 1건. tsc exit 2 였고 산출물은 두 폴더 모두에 나왔다. `skipLibCheck: true` 로 바꾸고 틀린 파일을 지우니 exit 0. npm 이 "esbuild 의 postinstall 을 실행하지 않았다(allowScripts)"고 알렸다. 그래도 `npx esbuild --version` 은 0.28.2 를 냈다 | 통과(관찰 2건) |
| W0-03 | 14:18 경 | 대역 | 저장소의 첫 `npm install` (@aws-sdk 3.1105.0, `overrides` 없음) | `npm install`, `npm ls --all` | 경고 없이 설치 | `npm warn ERESOLVE overriding peer dependency`. `npm ls --all` 에 `@aws-sdk/client-dynamodb@3.1105.0 … invalid: "^3.1111.0" from …/util-dynamodb` | 실패 → `overrides` 추가 |
| W0-04 | 14:19 경 | 대역 | `overrides` 추가 뒤 재설치 | `rm -rf node_modules package-lock.json && npm install`, `npm ls --all`, `rm -rf node_modules && npm ci`, `npx esbuild --version`, `npx tsc --version`, node-datachannel 로 `PeerConnection` 을 만들고 `cleanup()`, `ws` import | ERESOLVE 경고 0, invalid 0, 도구와 네이티브 모듈이 뜬다 | 138 패키지, 취약점 0. ERESOLVE 경고 없음, invalid 없음, util-dynamodb 3.996.7 `overridden`. esbuild 설치 스크립트 알림은 남는다. esbuild 0.28.2, tsc 7.0.2, node-datachannel 과 ws 로드 됨 | 통과 |
| W0-05 | 14:25:16 ~ 14:25:37 | 대역 | protocol 소스의 첫 컴파일과 손으로 고른 표본 | `npx tsc -p tsconfig.json --outDir <scratch>/dist-try`, `node <scratch>/try1.mjs` (주소 30개, ICE 19개, relay 6개, 스키마 표본) | exit 0. 표본이 문서의 규칙대로 나온다 | tsc exit 0. 표본은 문서대로였다. 하나를 고쳤다: `exa%6dple.com` 이 `wss://example.com` 으로 풀렸다. 보이는 이름과 접속하는 이름이 달라지므로 호스트의 `%` 를 거절하게 했다 | 통과(1건 수정) |
| W0-06 | 14:34 경 | 대역 | protocol 단위 테스트 첫 실행 | `npx tsc -p tsconfig.json --outDir .work/w0/dist && node --test --enable-source-maps ".work/w0/dist/**/*.test.js"` | 실패 0 | tests 262, pass 261, fail 1. 실패한 것은 "지문 값이 고정돼 있다". 기대값 칸에 임시 값을 넣어 둔 채 돌렸다. 실제 값은 `8bf49d06f0a5` | 실패 → 기대값을 `shasum -a 256` 으로 따로 계산해 넣음(같은 값) |
| W0-07 | 14:35 경 | 대역 | W0-06 재실행 | 같은 명령 | 실패 0 | tests 262, pass 262, fail 0 | 통과 |
| W0-08 | 14:35:40 경 | 대역 | 실패 분류표(`link-failure.ts`)와 그 테스트를 더한 뒤 | 같은 명령 | 실패 0 | tests 266, suites 39, pass 266, fail 0 | 통과 |
| W0-09 | 14:35:43 | 대역 | protocol 이 Lambda 번들 방식으로 묶이는가 | `npx esbuild src/protocol/index.ts --bundle --platform=node --format=esm --target=node22 '--external:@aws-sdk/*' --outfile=<scratch>/bundle/protocol.mjs`, 묶은 파일을 import 해 `parseClientMessage`, `LIMITS`, `stateFingerprint` 호출 | 번들이 만들어지고 혼자 돈다 | 781.3kb. 외부 import 는 `node:crypto` 뿐. `node-datachannel`, `ws`, MCP SDK 는 0건. 호출 결과 정상 | 통과 |
| W0-10 | 14:36 ~ 14:37 | 대역 | 변이 점검. 컴파일된 protocol 의 임시 사본을 한 곳씩 바꾸고 테스트를 돌린다 | `node <scratch>/mutate.mjs <.work/w0/dist> <scratch 사본> <node_modules>` (23건: 예약 이름 제거, 방 ID 길이, offer 판정, relay 판별을 고정 문자열로, TURN 검사, `none`, `sync_end` 짝 검사, P2P 버전 판정, 프레임·시그널·기록 크기 경계, 버전 협상, 게이트웨이 프레임 판별, 오류 표, presence 키 검사, 키 정렬, 지문 구분자, IP 기본 포트, 쿼리 거절, 끝의 `/`, 정원 값, `fallback_at`) | 23건 모두 실패 1건 이상 | 22건을 잡았다. 1건이 살아남았다: "다른 스킴 검사에서 `turns` 를 빼기". 그 앞의 TURN 검사가 먼저 걸러 그 줄에 닿지 않는다. 동작이 바뀌지 않는 변이다 | 부분 → W0-11 |
| W0-11 | 14:37 경 | 대역 | W0-10 보충. `turns:` 가 실제로 허용되게 두 줄을 함께 바꾼 변이 | 사본을 고친 뒤 `node --test "<scratch 사본>/**/*.test.js"` | 실패 1건 이상 | pass 264, fail 2 ("turn: 과 turns: 는 거절한다", "섞인 목록은 전체를 거절한다") | 통과 |
| W0-12 | 14:39:09 ~ 14:39:13 | 로컬 실물 | `tests/support/proc.mjs` 자체 확인 1차. 15단계: dist 뿌리와 `AGENT_CHAT_DIST`, 띄우기·출력 대기·종료 코드·환경 변수, `run()`, `stop()` 의 두 경우, 기한 초과, 손자 프로세스가 남은 경우, 실행할 수 없는 명령, `trackPid()`, 부모가 그냥 끝난 경우, 부모가 SIGTERM 을 받은 경우, `dispose()` | `node <scratch>/proc-check/check.mjs <repo>` | 15/15 | 14/15. 실패: 06 "기한 안에 안 끝나면 SIGKILL 하고 forced=true". 시험용 자식 스크립트가 준비 문구를 SIGTERM 처리기보다 **먼저** 출력했다. 문구를 본 부모의 신호가 처리기보다 먼저 닿아 자식이 기본 동작으로 죽었다. `proc.mjs` 의 결함이 아니다 | 실패 → 자식 스크립트의 순서를 고침. `proc.mjs` 머리말에 같은 주의를 적음 |
| W0-13 | 14:39:32 ~ 14:39:47, 14:40:24 경 | 로컬 실물 | W0-12 재실행 | 같은 명령 4회, 머리말을 고친 뒤 1회 | 15/15 | 5회 모두 15/15. 끝난 뒤 `pgrep` 으로 본 남은 시험 프로세스 0 | 통과 |
| W0-14 | 14:40:39 ~ 14:40:40 | 대역 | 완료 기준 명령 | `rm -rf .work dist`, `npm install`, `npm run build` (출력을 `tail` 로 넘김) | 종료 코드 0 | 출력은 정상이었다. zsh 에서 `PIPESTATUS` 가 비어 종료 코드를 남기지 못했다 | 무효(기록 불가) → W0-15 |
| W0-15 | 14:40:49 ~ 14:40:50 | 대역 | 완료 기준 명령. 종료 코드를 직접 기록 | `npm install` → `npm run build` → `npm test` | 셋 다 exit 0. 테스트 실패 0 | `npm install` exit 0 (139 패키지 감사, 취약점 0). `npm run build` exit 0 (오류 출력 없음). `npm test` exit 0: tests 266, suites 39, pass 266, fail 0, cancelled 0, skipped 0, todo 0 | 통과 |
| W0-16 | 14:41:02 ~ 14:41:06 | 대역 | 잠금 파일로 깨끗이 설치 | `rm -rf node_modules dist && npm ci` → node-datachannel import 와 `cleanup()` → `npm test` | exit 0, 로드 성공, 실패 0 | `npm ci` exit 0 (138 패키지). 로드 됨. `npm test` exit 0: 266/266 | 통과 |
| W0-17 | 14:41:16 | 대역 | 묶음별 빌드. 다른 묶음의 작성 중 파일에 타입 오류가 있을 때. 저장소의 `src`·`tsconfig.json`·`package.json` 사본(`<scratch>/outdir-check`)에 타입 오류 2건짜리 파일을 더했다 | `npx tsc -p tsconfig.json --outDir .work/w0/dist` → `node --test ".work/w0/dist/**/*.test.js"` → `AGENT_CHAT_DIST=<그 폴더>` 로 `proc.mjs` 의 `distUrl('protocol/index.js')` 를 import | tsc 는 오류를 보고하되 산출물을 낸다. 기본 `dist` 는 만들지 않는다. 테스트가 통과한다 | tsc exit 2 (TS2322, TS7006). `.work/w0/dist/{diagnostics,other-bundle,protocol}` 이 생겼고 `dist` 는 없다. 266/266. `distRoot()` 가 그 폴더를 가리켰고 import 됐다 | 통과 |
| W0-18 | 14:42 경 | 대역 | 타입 계약의 컴파일 확인. `<scratch>/outdir-check` 사본 | `@ts-expect-error` 9곳(허용 목록에 없는 로그 필드 3, 객체 값, 오류 객체 값, 모르는 수준, 모르는 모듈, 단계와 사유의 짝 불일치, `LIMITS` 에 대입)과, 메시지·프레임·기록의 구별 합집합을 좁히는 `switch` 4개를 담은 파일 → `npx tsc -p tsconfig.json --noEmit` | exit 0 (표시한 곳이 모두 실제 오류이고 나머지는 통과) | exit 0 | 통과 |
| W0-19 | 14:42:54 ~ 14:43:30 경 | 대역 + 로컬 실물 | 마지막 확인 | `npm run build` → `npm test`. 이어서 `proc.mjs` 자체 확인 9회 | exit 0, 266/266. 15/15 | 빌드 exit 0, 테스트 exit 0 (266/266). 자체 확인은 9회 모두 14/15. 실패: 02 "AGENT_CHAT_DIST 로 바꾼다". 확인 스크립트가 `<repo>/.work/w0/dist` 를 import 하는데 그 폴더를 W0-14 에서 지웠다. 결정적 실패이고 `proc.mjs` 의 결함이 아니다 | 빌드·테스트 통과. 자체 확인 실패 → W0-20 |
| W0-20 | 14:43:49 ~ 14:44:08 | 로컬 실물 | W0-19 의 자체 확인 재실행. 02 단계가 저장소 `dist` 의 임시 사본을 가리키게 고쳤다 | `node <scratch>/proc-check/check.mjs <repo>` 5회 | 15/15 | 5회 모두 15/15. `pgrep` 남은 프로세스 0. 저장소에 `.work` 없음 | 통과 |
| W0-21 | 14:45:00 ~ 14:45:01 | 대역 | 주석 한 줄을 고친 뒤의 완료 기준 명령(같은 명령의 재실행) | `npm install` → `npm run build` → `npm test` | 셋 다 exit 0. 실패 0 | 셋 다 exit 0. tests 266, suites 39, pass 266, fail 0, cancelled 0, skipped 0, todo 0 | 통과 |

## `V-U1` 이 본 것 (테스트 파일별)

| 파일 | 건수 | 본 것 |
|---|---|---|
| `limits.test.ts` | 70 | [protocol.md](../../docs/design/protocol.md) 의 값 57개를 하나씩. 표에 없는 숫자가 섞이지 않았는지. 문서가 값 사이에 둔 관계(시그널링 끊김 인지 70초 < 오래됨 90초, 주기 재전송 4회, 접속·등록·mesh 합 40초, 닿지 않음 31초, 재동기화 간격 30→300초 등) |
| `identifiers.test.ts` | 29 | 방 ID, 이름, sid, key, cid, 메시지·기록 ID, 요청 id 의 경계. 예약 이름 8개의 대소문자 변형. 이름 비교와 offer 쪽 판정. 생성 함수(주입한 바이트로 고정, 치우침 없는 추출, 고르게 나오는지). 참조 값(SHA-256 앞 12자리) |
| `signaling-wire.test.ts` | 46 | `join` 세 모드, 접속 순번, 예약 이름, `v` 협상. `signal` 의 kind 별 `cid`·`data`, sdp 12000자, 후보 묶음 1~32건과 1024자·16자. 16384바이트 경계와 UTF-8 기준. 서버 메시지 넷, 오류 코드 13개와 닫힘·치명 표시, 게이트웨이 프레임·빈 프레임·모르는 type. relay 가 든 signal 판별 |
| `p2p-wire.test.ts` | 33 | 여덟 타입의 통과 표본. `sync_end` 에 `test_id` 와 `test_elapsed_ms` 가운데 하나만 있으면 거절. 버전 불일치와 모르는 타입의 구분. chat 16384바이트, 프레임 65536바이트 경계(글은 상한 안인데 직렬화하면 넘는 경우 포함). state 의 기록별 검증. 49152바이트 목표로 나눠 담기 |
| `state-records.test.ts` | 28 | 기록 여섯 종류의 통과·거절 표본. presence 키와 작성자의 일치. 글자 필드 4096바이트, 기록 32768바이트 경계. 정규 직렬화(키 정렬, UTF-8 바이트 비교, 어느 순서로 견줘도 같은 쪽). 지문(정의대로의 값, 고정값, 순서 무관, 식별자만 반영) |
| `server-address.test.ts` | 21 | [6절 표](../../docs/design/protocol.md#6-서버-주소-정규화)의 여섯 행, 공통 규칙(소문자, IPv6 대괄호, 기본 포트, 끝의 `/`, 경로 유지), 오류 입력(쿼리, 조각, 사용자 정보, 다른 스킴, 빈 호스트, 잘못된 포트·호스트) |
| `ice-config.test.ts` | 17 | 기본값, `none`, `stun:`·`stuns:`. `turn:`·`turns:` 거절, 섞인 목록 전체 거절, 그 밖의 스킴. 거절 사유에 원문이 없는지. relay 후보 판별(공백 여러 칸과 탭 포함) |
| `local-files.test.ts` | 13 | 확인 기록 파일: 설계 문서의 예시, 빠진 필드, 다른 버전, 시각 형식, 쓰고 다시 읽기 |
| `link-failure.test.ts` | 4 | [3.3 의 실패 분류](../../docs/design/protocol.md#33-재전송-기한-실패): 단계 셋과 사유 아홉 |
| `index.test.ts` | 5 | [architecture.md 3.1](../../docs/design/architecture.md#31-protocol) 의 공개 진입점이 있는지. 결과 모양. 해석 함수 10개가 나쁜 입력 17개에 예외를 던지지 않는지 |

건수는 `node --test` 가 센 수(266)와 맞춘 것이다. `limits.test.ts` 는 값마다 테스트를 하나씩 만든다.

## 미실행 항목

| 항목 | 사유 |
|---|---|
| Node 22, Node 24 에서의 빌드와 테스트 | 이 PC 에는 Node v26.12.1 뿐이다. `@types/node` 를 22 계열로 고정해 22 에 없는 API 는 컴파일에서 걸리게만 했다 |
| macOS arm64 밖의 OS | 환경 없음 |
| `npm run build:lambda`, `npm run test:e2e`, `npm run test:wire`, `npm run test:store` | 대상 파일이 아직 없다(W1, W2, W9 의 것). 이름과 명령만 정했다. 번들 방식 자체는 W0-09 로 봤다 |
| `V-U8` (`src/boundaries.test.ts`), 각 모듈의 `contract.ts`, `src/signaling-core/ports.ts` | 다음 담당의 범위 |
| `tests/support/proc.mjs` 의 Windows 동작 | 환경 없음. Windows 에서는 프로세스 그룹을 쓰지 않아 손자 프로세스를 잡지 못한다 |
| protocol 스키마를 실제 서버·클라이언트 경로에서 쓰는 검증 | 이후 묶음(`V-U2`, `V-L1` 등) |
| 변이 점검의 전수 실행 | 표본 24건만 했다 |

## 다음 실행에서 확인할 것

- 다른 묶음이 protocol 을 쓰다가 찾는 계약의 빈틈. 고칠 때는 [구현 계획 6절](../../docs/design/implementation-plan.md#6-공통-규칙)의 절차를 따른다.
- AWS SDK 버전을 올릴 때는 `overrides` 의 `@aws-sdk/util-dynamodb` 를 함께 지우거나 맞춘다. 그대로 두면 다시 peer 충돌이 난다.
- esbuild 의 설치 스크립트가 실행되지 않은 상태에서 `npm run build:lambda` 가 되는지(W2). W0-09 에서는 같은 옵션으로 protocol 만 묶었다.
- 설계 문서가 정하지 않아 코드에서 정한 것(지문의 구분자와 16진수 표기, `test_id` 의 형식, 기록 body 의 null 허용 필드, 서버 → 클라이언트 프레임의 크기 상한 없음)을 문서에 반영할지. 내용은 이번 작업의 완료 보고에 있다.
- 준비 문구를 신호 처리기보다 먼저 출력하는 프로세스는 `waitForOutput` 직후의 `stop()` 에서 기본 동작으로 죽는다(W0-12). 서버와 MCP 진입점을 만들 때 순서를 지킨다.

---

# W0 후반부: 모듈 공개 계약과 `V-U8`

위 기록(W0-01 ~ W0-21)에 이어 적는다. 위 기록은 고치지 않았다. 범위는 `src/signaling-core/ports.ts`, 여덟 모듈의 `contract.ts`, `src/boundaries.test.ts`(`V-U8`), 그리고 protocol 에 더한 `runtime-ports.ts` 다.

- 대상 파일
  - 새로: `src/signaling-core/ports.ts`, `src/signaling-core/contract.ts`, `src/signaling-client/contract.ts`, `src/mesh/contract.ts`, `src/shared-state/contract.ts`, `src/inbox/contract.ts`, `src/records/contract.ts`, `src/room-session/contract.ts`, `src/mcp-server/contract.ts`, `src/boundaries.test.ts`
  - 새로(protocol): `src/protocol/runtime-ports.ts`, `src/protocol/runtime-ports.test.ts`
  - 고침: `src/protocol/index.ts` (타입 여섯 개를 다시 내보내는 한 줄)
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e`. 미커밋 변경은 위 기록의 대상과 이 대상이다. 실행 중 다른 묶음의 파일은 작업 트리에 없었다.
- 환경: 위와 같다(macOS arm64 한 대, Node v26.12.1, TypeScript 7.0.2).
- 검증 수준: 대역(`V-U1` 추가분, `V-U8`). 네트워크와 실제 프로세스를 쓰지 않았다.
- 참고한 이전 실행
  - W0-14(zsh 에서 파이프 뒤 종료 코드를 남기지 못함): 종료 코드를 파이프 없이 남겼다. 한 번 같은 실수를 했고 무효로 적었다(W0-26).
  - W0-17(묶음별 빌드 폴더): 경계 검사가 `dist/` 와 `.work/<묶음>/dist/` 어디서 돌아도 저장소 뿌리를 찾게 했다(W0-29 에서 사본의 `.work/dist` 로 확인).
  - W0-10, W0-11(변이 점검): 같은 방법으로 경계 검사기를 점검했다(W0-30 ~ W0-32).
- 원문 증거: 명령 출력, 가짜 구현 사본, 변이 스크립트는 세션 임시 폴더(`<scratch>/w0b/`, `<scratch>/logs/w0b-*.log`)에 있고 보존 대상이 아니다. 저장소에는 탐색용 파일을 두지 않았다.

## 요약

| 항목 | 결과 | 근거 실행 |
|---|---|---|
| `npm run build`, `npm test` 가 통과한다 | 통과. 테스트 332건, 실패 0건 | W0-34 |
| `V-U8`: 실제 소스에 경계 위반이 없다 | 통과. 소스 35개, import 131개를 읽었다 | W0-25, W0-34 |
| `V-U8` 검사가 위반을 실제로 잡는다 | 통과. 자체 시험의 가짜 위반 43건(규칙 14가지)을 모두 잡는다. 저장소 사본에 넣은 위반 파일 5개에서 16건을 잡았고, 지우니 통과했다 | W0-27, W0-34 |
| 검사기의 규칙을 하나씩 끈 변이를 자체 시험이 잡는다 | 27건 가운데 26건. 남은 1건은 시험의 단언 자체를 약하게 바꾼 것이라 대상이 아니다. 같은 뜻의 제품 쪽 변이 3건은 모두 잡았다 | W0-30 ~ W0-32 |
| 계약만 보고 쓴 가짜 구현과 조립이 컴파일된다 | 통과. 9개 모듈의 가짜 `index.ts`, 시험용 진입점, MCP 조립 파일. 그 트리에서 경계 위반 0건 | W0-26, W0-29 |
| 형제 모듈이 따로 적은 타입이 어긋나면 컴파일이 실패한다 | 통과. 일부러 어긋나게 한 8건 가운데 5건 실패. 3건은 참조로 이어진 타입이라 함께 바뀐다(의도대로) | W0-33 |
| 계약 파일에 실행 코드가 없다 | 통과. 11개 파일의 산출물이 `export {};` 뿐이다 | W0-35 |
| node:test 가짜 타이머의 동작 | 관찰. 한 번에 움직인 구간 안에서 다시 건 타이머는 구간의 끝 시각 기준으로 걸린다. 시험은 가장 짧은 주기 이하의 걸음으로 시간을 움직여야 한다 | W0-22, W0-23 |

## 실행 기록

시각은 KST 다. "경"은 앞뒤 실행의 시각에서 어림한 것이다.

| 실행 ID | 시각 | 수준 | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|---|
| W0-22 | 15:17:42 | 대역 | 계약과 경계 검사의 첫 빌드와 실행 | `npm run build` → `node --test --enable-source-maps dist/boundaries.test.js dist/protocol/runtime-ports.test.js` | 빌드 exit 0, 실패 0 | 빌드 exit 0. tests 61, pass 60, fail 1. 실패: "주기 작업은 울릴 때마다 다시 걸어 만든다". 100ms 마다 다시 거는 타이머를 `mock.timers.tick(250)` 한 번으로 움직였더니 2회가 아니라 1회 울렸다 | 실패 → W0-23 |
| W0-23 | 15:18 경 | 탐색 | node:test 가짜 타이머가 구간 안에서 다시 건 타이머를 다루는 방식 | `node <scratch>/w0b/mock-timers-probe.mjs` (100ms 마다 다시 거는 타이머, `Date` 도 가짜) | — | `tick(250)` 한 번: 1회 울리고 그때 `Date.now()` 는 250. `tick(250)` 두 번: 250, 500. `tick(100)` 다섯 번과 `tick(50)` 열 번: 100, 200, 300, 400, 500. `tick(1000)` 한 번: 1회(1000). `setInterval` 은 `tick(250)` 에 2회 울리지만 둘 다 250 을 본다 | 관찰. 계약의 약속이 아니라 시험의 기대가 틀렸다. 시험을 50ms 걸음으로 고치고 `Timers` 주석에 적었다 |
| W0-24 | 15:18:45 | 대역 | W0-22 재실행 | 같은 명령 | 실패 0 | 빌드 exit 0. tests 61, pass 61, fail 0 | 통과 |
| W0-25 | 15:19 경 | 대역 | 경계 검사의 소스 읽기(주석·문자열·정규식 가리기, import 찾기)를 실제 소스에 대조 | `node <scratch>/w0b/scan-sanity.mjs <repo>` (파일마다: 줄 머리의 `import/export … from '…'` 를 단순 정규식으로 센 것과 비교, 길이와 줄 수 보존, 읽기 실패 0, 주석과 문자열을 지운 본문에 한글이 남지 않음) | 어긋남 0 | files 35, imports 131, mismatches 0 | 통과 |
| W0-26 | 15:20 ~ 15:22 경 | 대역 | 계약만 보고 가짜 구현을 쓸 수 있고 조립이 맞물리는가. 저장소 `src` 사본(`<scratch>/w0b/wiring`)에 `signaling-client`, `mesh`, `shared-state`, `inbox`, `records`, `room-session`, `mcp-server`, `signaling-core`, `signaling-selfhost`, `diagnostics` 의 가짜 `index.ts`, `signaling-core/testing.ts`, `entry/mcp.ts` 를 더했다 | `npx tsc -p tsconfig.json --outDir .work/dist`. 이어서 조립 파일의 `createMesh` 자리에 `createReplica` 를 넣고 `npx tsc --noEmit` | exit 0. 틀린 조립은 실패 | 첫 실행은 출력을 `head` 로 넘겨 종료 코드를 남기지 못했다(무효). 다시 실행: exit 0, 산출물 생성. 틀린 조립: exit 1, TS2322 | 통과(무효 1회) |
| W0-27 | 15:22 경 | 대역 | 실제 소스를 읽는 경로가 위반 파일을 잡는가. 같은 사본을 `AGENT_CHAT_REPO_ROOT` 로 가리켰다 | `AGENT_CHAT_REPO_ROOT=<scratch>/w0b/wiring node --test --enable-source-maps dist/boundaries.test.js` 를 세 번: ① 가짜 구현만 ② 위반 파일 5개 추가(내부 파일과 구현 import, 위 모듈 타입 import, 환경 변수, 전역 시계와 타이머, `child_process`, 형제 타입 import, 다른 모듈의 `ws`, TURN 주소와 중계 옵션, permission 문자열, 시그널 전송 함수, 모르는 모듈 폴더) ③ 지운 뒤 | ① 통과 ② 실패 ③ 통과 | ① exit 0, 56/56 ② exit 1, fail 1, 위반 16건을 파일과 줄 번호로 출력(규칙 10가지) ③ exit 0, 56/56 | 통과 |
| W0-28 | 15:23:40 ~ 15:23:41 | 대역 | 완료 기준 명령 | `npm run build` → `npm test` | 둘 다 exit 0 | 둘 다 exit 0. tests 328, suites 45, pass 328, fail 0 | 통과 |
| W0-29 | 15:25:03 ~ 15:25:04 | 대역 | 실행 파일 머리줄 처리, 조립 파일의 환경 변수 규칙, 저장소 계약 테스트의 인자를 고친 뒤 | `npm run build` → `npm test`. 사본도 최신 계약으로 맞춰 `npx tsc -p tsconfig.json --outDir .work/dist` → `node --test ".work/dist/**/*.test.js"` | 모두 exit 0 | 저장소: 둘 다 exit 0, 331/331. 사본: tsc exit 0, 테스트 exit 0, 332/332(가짜 구현이 든 트리에서 경계 위반 0건, 가짜 저장소로 계약 테스트 진입점 1건) | 통과 |
| W0-30 | 15:26 경 | 대역 | 경계 검사기의 변이 점검 1차. `dist` 사본의 `boundaries.test.js` 를 한 곳씩 바꿨다(24건: 주입받는 모듈의 구현 허용, 형제·위 방향 허용, `child_process`, 환경 변수, 시계, permission, TURN 주소·설정 이름, 중계 경로 이름, 외부 SDK, 시험 전용 파일, src 밖, 동적 import, 시그널 전송 함수, 채팅 부분, 계약 파일, 모르는 폴더, 읽기 실패, 주석 지우기, I/O 없는 모듈 등) | `node <scratch>/w0b/mutate-boundaries.mjs <사본> <repo>` | 24건 모두 실패 1건 이상 | 22건을 잡았다. 남은 2건: "목록 밖 패키지 허용"은 바로 뒤 분기가 같은 규칙으로 잡아 동작이 같았다. "2026-07-28 검사"는 단언의 문자열만 바꾼 것이라 설치된 SDK 로는 가릴 수 없었다 | 부분 → W0-31 |
| W0-31 | 15:27 경 | 대역 | W0-30 보충. revision 판정을 함수로 빼고 그 함수의 시험을 더했다. 변이 27건(위 2건을 고쳐 다시, 의존성 버전 고정 포함) | 같은 명령 | 모두 실패 | 26건을 잡았다. 남은 1건은 "signal kind 목록 단언을 약하게"로, 시험의 단언 자체를 바꾼 것이다(제품 변이가 아니다) | 통과(1건은 대상 아님) → W0-32 |
| W0-32 | 15:27 경 | 대역 | 와이어 스키마에 채팅 길을 내는 제품 변이 3건(signal 의 kind 에 `chat`, 서버 action 에 `chat`, `offer-request` 의 data 가 아무 필드나 통과) | `node <scratch>/w0b/mutate-wire.mjs <사본> <repo>` | 3건 모두 실패 | 3건 모두 잡았다 | 통과 |
| W0-33 | 15:27 경 | 대역 | 계약을 일부러 어긋나게 바꾼 사본 8건의 컴파일(`<scratch>/w0b/typeneg`) | 건마다 `npx tsc -p tsconfig.json --noEmit` | 형제 모듈이 따로 적은 타입이 어긋나면 실패 | 5건 실패(TS2344. `boundaries.test.ts` 의 맞물림 확인에서): mesh 의 전송 함수 인자, signaling-client 의 relay-error 필드, records 의 분류 값, inbox 에서 room-session 이 쓰는 함수, mesh 의 진단 칸 이름. 3건 통과: shared-state 의 규칙 오류 코드 추가, 명령 필드 이름 변경, room-session 설정 칸 추가. 이 셋은 위 모듈이 타입을 참조로 가져다 써서 함께 바뀐다 | 통과 |
| W0-34 | 15:27:49 ~ 15:27:50 | 대역 | 완료 기준 명령. `dist` 를 지우고 실행 | `rm -rf dist` → `npm run build` → `npm test` | 둘 다 exit 0. 실패 0 | `npm run build` exit 0(오류 출력 없음). `npm test` exit 0: tests 332, suites 45, pass 332, fail 0, cancelled 0, skipped 0, todo 0 | 통과 |
| W0-35 | 15:28 경 | 대역 | 계약 파일의 산출물과 protocol 번들 | 계약 파일 11개(`*/contract.js`, `signaling-core/ports.js`, `protocol/runtime-ports.js`, `diagnostics/log-port.js`)의 내용 확인. `npx esbuild src/protocol/index.ts --bundle --platform=node --format=esm --target=node22 '--external:@aws-sdk/*' --outfile=<scratch>/…` | 실행 코드 없음. 번들 됨 | 11개 모두 `export {};` 뿐. esbuild exit 0, 781.4kb(W0-09 는 781.3kb) | 통과 |

## `V-U8` 이 보는 것

검사는 `src/boundaries.test.ts` 하나다. 소스를 디스크에서 읽어 넘기는 부분과, 소스 묶음(경로 → 내용)을 받아 위반 목록을 돌려주는 부분으로 나뉜다. 자체 시험은 뒤쪽에 가짜 소스 묶음을 넣는다.

| 규칙 | 보는 것 | [`V-U8` 정의](../../docs/design/verification-plan.md#31-대역-단위계약)의 항목 |
|---|---|---|
| `import-internal` | 다른 모듈의 공개 파일(`index.ts`, `contract.ts`, signaling-core 의 `ports.ts`, diagnostics 의 `log-port.ts`)이 아닌 파일을 import. protocol 은 `index.ts` 뿐. room-session 과 mcp-server 의 제품 코드는 주입받는 모듈의 `contract.ts` 만 | 모듈 밖에서 내부 파일 import 없음 |
| `import-direction` | 의존 표에 없는 모듈을 import(타입 포함). 형제끼리, 아래에서 위로, mcp-server 에서 shared-state 로, Lambda 조립에서 클라이언트 모듈로 | 형제 모듈의 타입 import 없음. 아래 모듈이 위 모듈을 import 하지 않음 |
| `import-testing` | 제품 코드가 `testing.ts` 나 `*.test.ts` 를 import | (architecture.md 2절) |
| `import-outside` | `src` 밖이나 절대 경로를 import | `src` 가 `tests/support` 를 import 하지 않음 |
| `import-dynamic` | 문자열이 아닌 동적 import | (검사를 비켜 가는 길을 막는다) |
| `external-package` | 외부 SDK 를 정해진 모듈 밖에서 import. 의존성 목록 밖의 패키지 | (architecture.md 2절. 구현 계획 1절 6번) |
| `builtin` | 설치 CLI 밖의 `child_process`(와 `worker_threads`, `cluster`). I/O 없는 모듈(protocol, shared-state, signaling-core)의 `node:crypto` 밖 내장 모듈. 제품 코드의 `node:test` | 실행 모듈에 `child_process` 없음 |
| `env` | mcp-server, setup, signaling-aws 밖에서 `process.env`. MCP 조립 파일은 통째로 넘기는 것만, 서버 조립 파일은 없음 | 환경 변수를 읽는 곳은 `mcp-server` 뿐 |
| `clock` | 시각과 타이머를 주입받는 아홉 모듈의 `Date.now`, 인자 없는 `new Date()`, 전역 타이머, `node:timers` | (구현 계획 1절 7번) |
| `relay` | 문자열 안의 `turn:`·`turns:`. TURN 서버·자격 증명·중계 종류·ICE 전송 정책의 이름. TURN·중계 환경 변수. 클라이언트 쪽의 중계 경로 이름 | (구현 계획 6절 "하지 않는 것") |
| `permission` | permission relay capability 문자열 | permission capability 문자열 없음 |
| `signal-chat` | signaling-client, mesh, room-session 밖의 시그널 전송 함수. room-session 의 채팅 부분(파일 이름에 chat)에서의 시그널 전송 함수와 signaling-client import | `signal` 로 채팅을 보내는 호출 경로 없음 |
| `contract-types-only` | `contract.ts`, `ports.ts`, `log-port.ts` 의 실행 코드 | (구현 계획 W0) |
| `layout` | 모르는 모듈 폴더, `src` 바로 아래의 제품 코드, 정해지지 않은 조립 파일 | (새 폴더가 규칙 없이 들어오지 않게) |
| `scan` | 소스를 끝까지 읽지 못함(닫히지 않은 문자열·주석·템플릿) | (검사 결과를 믿을 수 없는 경우를 실패로 만든다) |

그 밖에 같은 파일이 보는 것:

- 설치된 MCP SDK 가 1.32.2 이고 지원 목록에 `2026-07-28` 이 없다(`V-U8` 의 "SDK 지원 목록에 `2026-07-28` 없음"). 지금 지원 목록은 `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` 이다.
- `package.json` 의 의존성이 설계의 네 개 그대로이고 버전이 고정돼 있다. 개발 의존성이 목록 안이다.
- 와이어 스키마: 서버가 받는 action 이 넷, `signal` 의 kind 가 넷이다. 다른 action·kind 는 `BAD_MESSAGE` 다. `signal` 에 얹은 다른 필드는 해석 결과에 남지 않는다.
- 계약끼리의 맞물림(컴파일로만 확인. 실행되는 시험이 아니다): room-session 과 조립이 잇는 자리 24곳.

건수: `boundaries.test.ts` 61건(실제 소스 3, 의존성과 SDK 3, 와이어 스키마 3, 소스 읽기 5, 검사기 자체 시험 47 = 가짜 위반 43 + 위반이 없어야 하는 묶음과 줄 번호 4), `runtime-ports.test.ts` 5건. 위 기록의 266건과 합쳐 332건이다.

## 미실행 항목

| 항목 | 사유 |
|---|---|
| 실제 구현에 대한 `V-U8` | 구현이 아직 없다. 지금 읽는 것은 protocol, 계약 파일, 이 검사 자신이다. 가짜 구현이 든 사본으로만 봤다(W0-27, W0-29) |
| Node 22, Node 24 에서의 실행. 특히 가짜 타이머의 동작(W0-23) | 이 PC 에는 Node v26.12.1 뿐이다 |
| macOS arm64 밖의 OS | 환경 없음 |
| 계약의 동작 검증(각 모듈의 `V-U*`) | 이 기록의 범위가 아니다. 계약은 타입뿐이다 |
| 경계 검사기 변이의 전수 실행 | 표본 30건(검사기 27, 와이어 3)만 했다 |

## 다음 실행에서 확인할 것

- 구현이 들어온 뒤 `V-U8` 이 잘못 잡는 곳(정상 코드를 위반으로 세는 경우)이 있는지. 소스 읽기는 문법 전체를 해석하지 않는다. 읽지 못하면 `scan` 으로 실패하므로 조용히 지나가지는 않는다.
- 주기 타이머가 있는 모듈의 시험이 시간을 한 번에 크게 움직이고 있지 않은지(W0-23). `V-U9` 의 8번·11번처럼 60분을 돌리는 시험에서 특히 본다.
- 계약 변경 요청이 오면 [구현 계획 6절](../../docs/design/implementation-plan.md#6-공통-규칙)의 절차대로 고치고, 이 파일에 새 실행으로 적는다.
- 설계 문서가 정하지 않아 계약에서 정한 것(완료 보고의 "설계와 다른 관찰")을 문서에 반영할지.

---

# W0 검토 지적 반영 (1차)

위 기록(W0-01 ~ W0-35)에 이어 적는다. 위 기록은 고치지 않았다. 독립 검토 1차의 지적 13건(protocol 구현 5건, 계약과 설계의 대조 8건)을 판단해 반영하고 다시 검증한 기록이다. 위 기록과 다른 곳은 이 절이 최신이다(예: `stuns:` 는 이제 거절한다. `V-U8` 의 규칙이 늘었다. 테스트는 421건이다).

- 대상 파일
  - 고침: `src/protocol/ice-config.ts`, `p2p-wire.ts`, `signaling-wire.ts`, `state-records.ts`, `server-address.ts`(주석), `util.ts`, `index.ts`, 그 테스트 6개(`ice-config`, `p2p-wire`, `signaling-wire`, `state-records`, `server-address`, `runtime-ports`). `src/mesh/contract.ts`, `src/inbox/contract.ts`, `src/mcp-server/contract.ts`, `src/signaling-core/contract.ts`, `src/signaling-core/ports.ts`, `src/diagnostics/log-port.ts`, `src/boundaries.test.ts`
  - 새로: `src/protocol/testing.ts`(시험 전용), `src/diagnostics/contract.ts`
  - 설계 문서: `docs/design/protocol.md`(2.2, 2.3, 4.4, 6절, 7절), `architecture.md`(2절, 3.1~3.4, 3.6, 3.8, 3.10~3.13, 5절, 6.2, 6.3, S13), `mcp-interface.md`(2절 오류 표, 3.7, 7.1, 10절), `deployment.md`(2.4), `verification-plan.md`(3.1 의 `V-U1`·`V-U4`·`V-U6`·`V-U8`·`V-U10`·`V-U11`, `V-L10`), `implementation-plan.md`(1절 7번, W0 파일 목록, W7 행, 묶음별 메모, 6절 1번)
  - `package.json`, `tsconfig.json`, `tests/support/proc.mjs` 는 바꾸지 않았다. 의존성은 그대로다.
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e`. 미커밋 변경은 위 기록의 대상과 이 대상이다. 다른 묶음의 파일은 작업 트리에 없었다.
- 환경: 위와 같다(macOS arm64 한 대, Node v26.12.1, TypeScript 7.0.2, node-datachannel 0.33.6).
- 검증 수준: 대역이 기본이다. W0-36, W0-44, W0-45 는 실제 라이브러리를 쓴 로컬 실물이고, W0-45 는 공개 STUN 서버에 닿았다.
- 참고한 이전 실행
  - W0-14, W0-26(파이프 뒤 종료 코드를 남기지 못함): 종료 코드는 출력을 파일로 보내고 따로 남겼다.
  - W0-10, W0-30 ~ W0-32(변이 점검): 같은 방법으로 새 규칙과 수정한 곳을 점검했다(W0-48).
  - W0-26, W0-29(가짜 구현 사본): 같은 사본을 새 계약으로 다시 컴파일했다(W0-50).
  - W0-18, W0-33(타입 계약의 컴파일 확인): 새 타입에 같은 방법을 썼다(W0-47).
  - PRE-RTC-11(relay 후보는 TURN URL 을 줬을 때만): `{hostname, port}` 객체에 중계 종류를 넣지 않는 것으로 반영했다.
- 원문 증거: 명령 출력과 탐색 스크립트는 세션 임시 폴더(`<scratch>/r1/`)에 있고 보존 대상이 아니다. 검토자의 반례 스크립트는 `<scratch>/review-protocol-impl/`, `<scratch>/review-contracts-vs-design/` 에 있었다. 저장소에는 탐색용 파일을 두지 않았다.

## 요약

| 항목 | 결과 | 근거 실행 |
|---|---|---|
| `npm run build`, `npm test` 가 통과한다 | 통과. 테스트 421건, 실패 0건 | W0-51 |
| 필수 지적 2건(`stuns:` 와 IPv6 ICE 설정이 고정 라이브러리에서 예외) | 재현한 뒤 반영. 통과한 값 11종으로 pc 가 만들어지고, `stuns:` 는 `ICE_CONFIG_REJECTED` 다 | W0-36, W0-44 |
| 객체 형태로 넘긴 STUN 설정이 실제로 쓰인다 | 통과. URL 형태와 같이 srflx 후보 1개. `none` 은 0개 | W0-45 |
| 권장 지적 11건 | 11건 모두 수용. 그중 1건(대괄호 없는 IPv6 서버 주소)은 동작을 두고 설계 문구와 테스트를 맞췄다 | 지적 원장 |
| 검토자의 반례가 더는 재현되지 않는다 | 통과. 경계 검사 반례 26건 가운데 잡는 것이 1건 → 20건. 남은 6건은 이번 지적에 없던 것이다 | W0-42, W0-46 |
| 새 규칙과 수정이 테스트로 지켜진다 | 변이 63건 가운데 63건을 잡았다 | W0-48 |
| 새 계약이 틀린 사용을 컴파일에서 거절한다 | 통과. 13곳 | W0-47 |
| 계약만 보고 쓴 가짜 구현이 새 계약과 새 규칙 아래에서 컴파일되고 경계 검사를 통과한다 | 통과(고친 뒤). 처음에는 계약 변경 2곳과 새 규칙 4건에 걸렸다 | W0-50 |

## 실행 기록

시각은 KST 다. 로그 파일의 수정 시각에서 옮겼다.

| 실행 ID | 시각 | 수준 | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|---|
| W0-36 | 15:55:58 | 로컬 실물 | 지적 PROTOCOL-IMPL-R1-01, CONTRACTS-VS-DESIGN-R1-01 의 재현. 고치기 전 `parseIceServers` 가 통과시킨 값을 node-datachannel 0.33.6 의 `PeerConnection` 에 넣는다 | `npm run build` → `node <scratch>/review-protocol-impl/probe-ndc2.mjs`, `node <scratch>/review-contracts-vs-design/ndc-stuns.mjs` | 지적대로 재현된다 | 빌드 exit 0. URL 문자열로 넣으면 `stuns:stun.example.com:5349` → `Unknown ICE server protocol: stuns`, `stun:[2001:db8::1]:3478` → `Invalid ICE server port in URL: db8::1]:3478`, `stun:[::1]` → `Invalid ICE server port in URL: :1]`. `stun:<이름 또는 IPv4>[:포트]` 는 만들어진다. `{hostname, port}` 객체로 넣으면 IPv6(대괄호 유무 모두)와 `stuns` 에서 온 값이 모두 만들어진다. 객체 형태에는 TLS 를 고르는 칸이 없다 | 재현됨 |
| W0-37 | 16:06:04 ~ 16:06:05 | 대역 | 수정 뒤 첫 빌드와 경계 검사 | `npm run build` → `node --test --enable-source-maps dist/boundaries.test.js` | 빌드 exit 0, 실패 0 | 빌드 exit 0. tests 123, pass 26, fail 97. 원인 둘. ① 자체 시험의 "규칙을 지킨 묶음"에 타입 멤버 `setTimeout(f, ms): unknown` 을 적었는데 전역 타이머 규칙이 그것을 호출로 읽었다. 그 한 줄이 모든 "잡는다" 사례에 `clock` 위반으로 섞였다(96건). ② 배포 템플릿 표본의 `TurnServerUrl` 을 TURN 이름 규칙이 잡지 못했다. 규칙 끝에 단어 경계가 있어 이어 쓴 이름을 놓쳤다(1건) | 실패 → ① 표본을 속성 형태(`setTimeout: (f, ms) => unknown`)로 고침. 메서드 모양의 타입 멤버를 잡는 것은 검사기의 한계로 남긴다("남은 위험"). ② 규칙에서 끝의 경계를 뺌 |
| W0-38 | 16:06:27 | 대역 | W0-37 재실행 | 같은 명령 | 실패 0 | 빌드 exit 0. tests 123, pass 123, fail 0 | 통과 |
| W0-39 | 16:06:35 | 대역 | 전체 테스트 | `npm test` | exit 0 | exit 1. tests 421, pass 420, fail 1. 실패: "어긴 구현마다 걸리는 확인이 정해져 있다". "나중에 붙인 리스너부터 부르는 구현"이 해지 확인에도 걸리는데(순서가 뒤집혀 기대 순서와 어긋난다) 기대값에 그 확인을 적지 않았다. 적합성 시험이 아니라 자체 확인의 기대값이 틀렸다 | 실패 → 기대값에 해지 확인을 더함 |
| W0-40 | 16:06:52 | 대역 | W0-39 재실행 | `npm test` | exit 0, 실패 0 | exit 0. tests 421, suites 52, pass 421, fail 0 | 통과 |
| W0-41 | 16:10:23 ~ 16:10:25 | 대역 | 설계 문서를 고친 뒤(소스의 주석 한 줄 포함) | `npm run build` → `npm test` | 둘 다 exit 0 | 둘 다 exit 0. tests 421, pass 421, fail 0 | 통과 |
| W0-42 | 16:06 경 처음, 16:14:41 ~ 16:14:42 다시(결과 같음) | 대역 | 검토자의 경계 검사 반례 묶음을 고친 검사기에 다시 넣음. `<scratch>/r1/gaps.mjs`(반례 25건과 대조 1건), `legit.mjs`(설계대로 쓴 정상 코드 12건) | `node gaps.mjs`, `node legit.mjs`, `node legit2.mjs`(L1 의 파일 이름만 `signal-gate.ts` 로 바꾼 것) | 지적한 반례를 잡는다. 정상 코드는 통과한다 | 반례: 잡음 20(G1a~G1d, G2a, G2b, G3, G4a~G4e, G5, G6, G8, G9, G14, G15, G16, 대조 C1). 고치기 전에는 대조 1건만 잡았다. 놓침 6: G7a·G7b(MCP SDK 의 서버 쪽·클라이언트 쪽 구분), G10(setup 이 설정 파일을 고침), G11(개발 채널 플래그), G12(ICE 객체의 사용자 이름·암호), G13(이름에 표시가 없는 채팅 다시 보내기). 이 6건은 이번 지적 목록에 없다. 정상 코드: 통과 9, 걸림 3. L1 은 새 규칙 때문에 걸린다(시그널 전송 함수를 `join.ts` 에 뒀다). 같은 코드를 `signal-gate.ts` 에 두면 통과한다. L4(거절 문구에 `turn:` 을 적음)와 L11(mesh 시험이 signaling-client 실물을 import)은 고치기 전과 같다 | 통과(남은 것은 "남은 위험") |
| W0-43 | 16:10 경 | 대역 | 검토자의 protocol 반례 재실행 | `node <scratch>/review-protocol-impl/probe6.mjs`, `probe3.mjs`, `probe1.mjs`, `node <scratch>/r1/after-probes.mjs <repo>` | 반례가 재현되지 않는다 | `P2P_FRAME_TYPES.push('x')` 는 TypeError. 그 뒤 `parseP2PFrame('{"v":1,"t":"x"}')` 는 `UNKNOWN_TYPE`. `SIGNAL_ERRORS.REPLACED.fatal = true` 는 TypeError 이고 값은 false. 공개 이름 목록 16개와 `SIGNAL_ERRORS` 의 안쪽이 모두 얼어 있다. `encodeP2PFrame`(글 20000바이트) → `BAD_FRAME` `text: text exceeds 16384 bytes`. `encodeClientMessage`(빈 id, 방 `X`, 이름 `all` 등) → `BAD_MESSAGE`. 대괄호 없는 IPv6 서버 주소 4종(`::1`, `2001:db8::1`, `ws://2001:db8::1`, `::1:8787`)은 `INVALID_ARGUMENT`(대괄호 표기 안내), `[::1]` 과 `[2001:db8::1]:9000` 은 통과. `protocol/index.js` 에 `defineSubscribableContractTests` 가 없다 | 통과 |
| W0-44 | 16:10 경 | 로컬 실물 | 고친 `parseIceServers` 가 통과시킨 값으로 pc 가 만들어지는가. 입력 14종(생략, `none`, 이름+포트, 이름, IPv4±포트, IPv6±포트, `[::1]`, 끝에 점이 붙은 이름, 세 개짜리 목록, `stuns:` 둘, `turn:`) | `node <scratch>/r1/ndc-after.mjs <repo>` (`{hostname, port}` 객체로 `new PeerConnection`) | 통과한 값은 모두 만들어진다. 예외 0 | pc_ok 11, rejected 3(`stuns:` 둘과 `turn:`. 모두 `ICE_CONFIG_REJECTED`), threw 0 | 통과 |
| W0-45 | 16:10:37 | 로컬 실물(공개 STUN 에 닿음) | 객체 형태로 넘긴 STUN 설정이 실제로 쓰이는가. 기본값(`stun.l.google.com:19302`)으로 pc 를 만들고 DataChannel 을 하나 만들어 4초 동안 로컬 후보를 센다 | `node <scratch>/r1/ndc-srflx.mjs <repo>` (URL 형태, 객체 형태, 빈 목록) | 객체 형태에서도 srflx 후보가 나온다 | URL 형태: host 1, srflx 1, relay 0. 객체 형태: host 1, srflx 1, relay 0. 빈 목록: host 1, srflx 0 | 통과(이 PC, 이 망에서 1회) |
| W0-46 | 16:13:14 | 대역 | protocol 번들과 계약 파일의 산출물 | `npx esbuild src/protocol/index.ts --bundle --platform=node --format=esm --target=node22 '--external:@aws-sdk/*' --outfile=<scratch>/r1/bundle/protocol.mjs`, 번들을 import 해 `parseIceServers`·`encodeP2PFrame` 호출, 계약 파일 12개의 내용 확인 | 번들에 시험 코드가 없다. 계약 파일에 실행 코드가 없다 | esbuild exit 0, 783.4kb(W0-35 는 781.4kb). 외부 import 는 `node:crypto` 뿐. `node:test`, `node:assert`, `defineSubscribableContractTests` 0건. 호출 결과 정상. 계약 파일 12개(`*/contract.js` 9개, `signaling-core/ports.js`, `protocol/runtime-ports.js`, `diagnostics/log-port.js`)는 주석과 `export {};` 뿐 | 통과 |
| W0-47 | 16:11:31 | 대역 | 새 계약이 틀린 사용을 거절하는가. 저장소 `src` 사본(`<scratch>/r1/typeneg`)에 `@ts-expect-error` 13곳과 맞는 사용을 담은 파일을 더했다 | `npx tsc -p tsconfig.json --noEmit` | exit 0(표시한 곳이 모두 실제 오류이고 나머지는 통과) | exit 0. 거절: 서버 로그에 `peer` 넘기기(객체 리터럴, 변수), `noteToolCall('이름')`, `noteToolCall({cursor})`, `IceServer.host`, `IceServer.scheme`, `sid` 없는 `bind`, encode 오류 코드를 하나로 좁히기 2곳, 시계 없는 `createFileLogger`, 모르는 로그 수준, `P2P_FRAME_TYPES.push`, `SIGNAL_ERRORS.REPLACED.fatal` 대입. 통과: `peer_ref` 넘기기, 보통의 로거를 서버 포트에 넘기기, `{hostname, port}` 를 라이브러리 타입에 넘기기 | 통과 |
| W0-48 | 16:12:34 ~ 16:12:58 | 대역 | 변이 점검. `dist` 사본(`<scratch>/r1/mut`)의 한 곳씩 바꾸고 테스트를 돌린다. 63건: 경계 검사기의 새 규칙 43건(네트워크 내장 모듈과 허용 모듈, fs, console·stdout, `child_process` 파일 제한과 시험 요구, 환경 변수, 시계 규칙의 모듈 넷과 패턴 여섯, 전역 객체, 최상위 `let`·`var`, 전역 `fetch`·`EventSource`·`WebSocket`, `getBuiltinModule`, 권한 실행 옵션, 시그널 전송 파일 제한, protocol 시험 진입점, diagnostics 계약, `src` 밖 설정 넷, 이어 쓴 TURN 이름), protocol 15건(`stuns:` 허용 둘, hostname 의 대괄호, 기본 포트, 중복 판정, encode 의 스키마 확인 넷, 스키마 표 확인, 얼림 다섯), 적합성 시험 5건 | `node <scratch>/r1/mutate-r1.mjs <사본> <repo>` | 모두 실패 1건 이상 | 63건 모두 잡았다. 못 찾은 변이 0. 원본 재실행 exit 0, 421/421 | 통과 |
| W0-49 | 16:13 경 | 대역(정적) | 설계 문서의 링크 | `python3 <scratch>/linkcheck.py docs/design` | 깨진 링크 0 | 검사한 링크 283, 깨진 링크 0 | 통과 |
| W0-50 | 16:13:38 ~ 16:14:06 | 대역 | 계약만 보고 쓴 가짜 구현 사본(W0-26 의 것)에 저장소의 현재 파일을 덮어쓰고 다시 컴파일 | `npx tsc -p tsconfig.json --outDir .work/dist` → `node --test ".work/dist/**/*.test.js"` | 계약 변경이 컴파일에서 드러난다. 고치면 통과한다 | 1차: tsc exit 2. `noteToolCall(name)`(TS2345), `sid` 없는 `bind`(TS2741). 가짜 구현 2곳을 고쳐 tsc exit 0. 2차: 경계 검사 fail 1, 위반 4건. `room-session/index.ts` 의 `sendSignal` 3곳(새 규칙 `signal-chat`), `signaling-selfhost/index.ts` 의 `Date.now`(새 규칙 `clock`). 시그널 관문을 `room-session/signal-gate.ts` 로 옮기고 자체 호스팅 가짜가 `now` 를 받게 고쳤다. 3차: tsc exit 0, tests 422, pass 422, fail 0 | 통과(가짜 구현을 새 규칙에 맞춘 뒤) |
| W0-51 | 16:14:50 ~ 16:14:51 | 대역 | 완료 기준 명령. `dist` 를 지우고 실행 | `rm -rf dist` → `npm run build` → `npm test` | 둘 다 exit 0. 실패 0 | `npm run build` exit 0(오류 출력 없음). `npm test` exit 0: tests 421, suites 52, pass 421, fail 0, cancelled 0, skipped 0, todo 0. 저장소에 `.work` 없음 | 통과 |

## 지적 원장

"재검증"의 실행 ID 는 위 표의 것이다. 처리의 "수용"은 지적한 사실을 받아들여 코드·계약·문서 가운데 하나 이상을 고쳤다는 뜻이다.

| ID | 위치 | 반례 | 영향 | 필수/권장 | 처리 | 재검증 |
|---|---|---|---|---|---|---|
| PROTOCOL-IMPL-R1-01 | `src/protocol/ice-config.ts` 의 `IceServer.url`, `ice-config.test.ts`, `src/mesh/contract.ts`, protocol.md 7절 | `parseIceServers` 가 통과시킨 `stuns:…` 와 `stun:[IPv6]…` 를 URL 문자열로 넣으면 고정 라이브러리가 예외를 던진다 | mesh 가 `url` 을 그대로 넘기면 create·join 의 `ICE_CONFIG_REJECTED` 가 아니라 pc 생성 때 분류되지 않은 예외가 난다 | 필수 | **수용.** ① `stuns:` 는 `parseIceServers` 가 `ICE_CONFIG_REJECTED` 로 거절한다(사유 문구에 "이 빌드의 라이브러리가 지원하지 않는다"). ② `IceServer` 를 `{url, hostname, port}` 로 바꿨다. `hostname` 은 대괄호 없는 호스트, `port` 는 생략 시 3478. 옛 `host`·`scheme` 칸은 없앴다. ③ mesh 계약에 "`{hostname, port}` 객체로 넘긴다. `url` 문자열을 넘기지 않는다"를 적었다. ④ `V-U11` 에 "통과한 대표 값으로 pc 가 만들어진다"를 더했다. protocol.md 7절, mcp-interface.md 오류 표, architecture.md 3.1·3.6 을 함께 고쳤다 | W0-36(재현), W0-44, W0-45, W0-47, W0-48 |
| PROTOCOL-IMPL-R1-02 | `src/protocol/server-address.ts`, `server-address.test.ts`, protocol.md 6절 | `normalizeServerAddress('::1')` 이 오류다. 설계의 "IPv6 는 대괄호로 감싼다"를 "감싸 준다"로 읽으면 `ws://[::1]:8787` 이어야 한다 | 설계 문구를 구현이 좁게 해석했고 이력에 적히지 않았다 | 권장 | **수용(해석을 문서로 확정).** 동작은 그대로 둔다. `::1:8787`, `2001:db8::1:9000` 은 그대로도 올바른 IPv6 주소라 끝의 숫자가 포트인지 가를 수 없다. 추측해서 다른 주소에 접속하지 않는 쪽이 보수적이다. protocol.md 6절에 "IPv6 는 입력에서도 대괄호로 적는다. 대괄호 없으면 오류"를 적고, 테스트에 모호한 두 예를 더했다 | W0-43, W0-51 |
| PROTOCOL-IMPL-R1-03 | `src/protocol/runtime-ports.test.ts` | 제품 코드 import 가 타입뿐이라 5건이 제품이 어떻게 바뀌어도 통과한다 | `Subscribable` 의 약속이 검증된 것처럼 건수에 잡힌다 | 권장 | **수용.** ① 건수를 따로 센다(아래 "건수"). ② 시험 전용 진입점 `src/protocol/testing.ts` 에 `Subscribable` 적합성 시험(확인 4가지)을 두고, 세 모듈의 시험이 자기 구현에 돌리게 했다(`V-U4`, `V-U10`, `V-U11` 에 적음). ③ `runtime-ports.test.ts` 는 그 적합성 시험이 약속을 어긴 구현 8종을 잡는지를 본다. `Math.random` 을 검사하던 1건은 없앴다 | W0-40, W0-48 |
| PROTOCOL-IMPL-R1-04 | `encodeP2PFrame`, `encodeClientMessage`, protocol.md 4.4 | 글 20000바이트의 chat 을 `encodeP2PFrame` 이 통과시키고 받는 쪽은 `BAD_FRAME` 으로 버린다. 형식이 틀린 `join` 도 `encodeClientMessage` 를 통과한다 | 호출자가 글 크기 검사를 빠뜨리면 받는 쪽이 잘못된 프레임으로 세고 링크를 닫을 수 있다 | 권장 | **수용.** 두 함수가 받는 쪽과 같은 스키마로 먼저 검증한다. 오류 코드는 `encodeP2PFrame` 이 `FRAME_TOO_LARGE` \| `BAD_FRAME`, `encodeClientMessage` 가 `MESSAGE_TOO_LARGE` \| `BAD_MESSAGE` 다. state 프레임은 기록 하나만 틀려도 거절한다. 모르는 필드는 싣지 않는다. protocol.md 4.4 에 적었다 | W0-43, W0-47, W0-48 |
| PROTOCOL-IMPL-R1-05 | `p2p-wire.ts`, `signaling-wire.ts` 의 공개 상수 | `P2P_FRAME_TYPES.push('x')` 가 되고 그 뒤 `parseP2PFrame` 이 TypeError 를 던진다. `SIGNAL_ERRORS.REPLACED.fatal = true` 가 들어간다 | "예외를 던지지 않는다"와 "전역 가변 상태 금지"가 깨질 수 있다 | 권장 | **수용.** 공개 이름 목록 13개와 `SIGNAL_ERRORS` 의 안쪽을 얼렸다(`deepFreeze`). `parseP2PFrame` 과 `encodeP2PFrame` 은 이름 목록이 아니라 스키마 표(`Object.hasOwn`)로 가른다 | W0-43, W0-47, W0-48 |
| CONTRACTS-VS-DESIGN-R1-01 | `MeshDeps.iceServers`, `CreateMeshResult`, `IceServer`, protocol.md 7절 | PROTOCOL-IMPL-R1-01 과 같다. 더해서: 객체 형태에는 TLS 칸이 없어 `stuns` 가 평문 STUN 으로 바뀐다 | 계약으로는 `stuns` 를 설계대로 만들 수 없고, 실패를 알릴 길도 없다 | 필수 | **수용.** PROTOCOL-IMPL-R1-01 과 같은 수정이다(지적의 1번과 2번 안). `stuns` 를 남기지 않으므로 `CreateMeshResult` 에 코드를 더하지 않았다 | W0-36, W0-44, W0-45, W0-47 |
| CONTRACTS-VS-DESIGN-R1-02 | `Inbox.noteToolCall`, `Inbox.wait`, mcp-interface.md 7.1 | 수신 불명 상태에서 `cursor` 없는 `wait_for_messages` 가 poll 로 돌아가지 않고 `channel_mode` 를 받는다 | 대기만 되풀이하는 에이전트가 사건을 받지 못한다 | 권장 | **수용.** `noteToolCall({name, cursor?})` 로 바꿨다. 수신 불명에서 돌아가지 않는 호출은 `wait_for_messages{cursor}` 하나다. `cursor` 없는 대기와 `confirm_channel` 도 돌아가는 호출이다. 돌아갈 때 새 토큰을 만들고 앞 토큰은 버린다(그 호출의 confirm 은 `INVALID_ARGUMENT`). mcp-interface.md 3.7·7.1, architecture.md 3.8·3.11, `V-U4` 를 함께 고쳤다 | W0-47, W0-50, W0-51 |
| CONTRACTS-VS-DESIGN-R1-03 | `ConnBinding`, deployment.md 2.4, protocol.md 2.2 | 서버가 붙이는 `sid` 가 `hitRate` 의 결과에 없어 signal 마다 보낸 쪽 기록을 한 번 더 읽어야 한다 | 가장 잦은 메시지에 강한 일관성 읽기가 하나 늘고, 보낸 쪽 기록이 없을 때의 답이 정해져 있지 않다 | 권장 | **수용.** `ConnBinding` 에 `sid` 를 더했다. 보낸 쪽 기록은 읽지 않는다. protocol.md 2.2·2.3, deployment.md 2.4(연결 항목의 `sid?`, 동작별 연산), architecture.md 3.2 를 고쳤다 | W0-47, W0-50 |
| CONTRACTS-VS-DESIGN-R1-04 | `log-port.ts`, `McpConfig.logLevel`, architecture.md 3.12·6.3·S13 | 로거 생성 함수와 flush·close 의 타입이 어디에도 없다. `logLevel` 을 받을 자리가 없다 | 로거를 만드는 네 묶음이 서명을 추측해야 한다 | 권장 | **수용.** `src/diagnostics/contract.ts` 를 새로 두었다. `CreateFileLogger({dir, service, level, now, timers})`, `CreateStdoutLogger({service, level, now})`, 돌려주는 값 `LogPort & {proc, close(budgetMs)}`. 조립 성격의 모듈만 이 파일을 import 한다(경계 검사). architecture.md 3.12·5절·6.3·S13, 구현 계획(W0 목록, W7)을 고쳤다 | W0-47, W0-48, W0-51 |
| CONTRACTS-VS-DESIGN-R1-05 | `SignalingCoreDeps.log`, `log-port.ts` | 서버 규칙 코드가 `{peer: 이름}` 을 넘겨도 컴파일, 경계 검사, 출력 필터가 모두 통과한다 | 이름 원문이 서버 로그에 남는다 | 권장 | **수용(두 안 모두).** 타입: `ServerLogPort` 와 `ServerLogFields`(`peer?: never`)를 두고 `SignalingCoreDeps.log` 에 썼다. 보통의 로거를 그대로 넘길 수 있다. 출력: "`svc` 가 `server`·`lambda` 면 `peer` 를 버린다"를 architecture.md 3.12·6.2 와 `V-U6` 에 더했다(구현은 W7) | W0-47 |
| CONTRACTS-VS-DESIGN-R1-06 | `boundaries.test.ts` 의 시계·환경 변수 규칙, architecture.md 2절, 구현 계획 1절 7번 | 최상위 `let`, mcp-server 의 `process.env`, diagnostics·signaling-selfhost 의 `Date.now`·`setInterval`, `AbortSignal.timeout`, `process.hrtime`, `const {now} = Date` 를 놓친다 | 원칙 7번("모든 모듈")과 검사 범위가 다르다. 전역 가변 상태 검사가 없다 | 권장 | **수용.** ① 환경 변수: mcp-server 를 허용 목록에서 뺐다. `?.` 로 읽는 것도 잡는다. ② 전역 상태: 최상위 `let`·`var` 와 `globalThis`·`global.` 을 잡는다(`global-state`). ③ 시계: 조립 파일(`entry`)만 빼고 **모든** 모듈에 건다. diagnostics, setup, signaling-selfhost, signaling-aws 가 새로 든다. 패턴에 `AbortSignal.timeout`, `process.hrtime`·`uptime`, `performance`, `Date` 를 다른 이름으로 받기, `new` 없는 `Date()` 를 더했다. architecture.md 2절·3.3·3.4·3.12·3.13 과 구현 계획 1절 7번에 적었다 | W0-42, W0-48, W0-50 |
| CONTRACTS-VS-DESIGN-R1-07 | `boundaries.test.ts` 의 외부 패키지·내장 모듈 규칙, architecture.md 2절·3.9·3.11 | 전역 `WebSocket`·`fetch`, `node:net`·`dgram`·`https`, `console.log`, `process.stdout.write`, room-session 의 `node:fs` 를 놓친다 | 서버 중계 금지를 받치는 정적 검사에 구멍이 있다. stdout 한 줄이 stdio 프로토콜을 깬다 | 권장 | **수용.** 규칙 `network`(네트워크 내장 모듈은 signaling-selfhost·signaling-client 만. 전역 `WebSocket`·`fetch`·`EventSource` 는 전부 금지. `process.getBuiltinModule` 금지), `stdout`(`console` 과 stdout 직접 쓰기는 diagnostics·setup·`entry/cli`·`entry/server` 만), `builtin` 의 fs(records·diagnostics·mcp-server·setup·signaling-selfhost·entry 만)를 더했다. 지적의 허용 목록보다 좁힌 곳이 하나 있다: setup 에는 네트워크 내장 모듈을 주지 않았다(3.13 이 "연결 점검은 등록된 MCP 프로세스를 거친다"고 적는다) | W0-42, W0-48 |
| CONTRACTS-VS-DESIGN-R1-08 | `boundaries.test.ts` 의 `signal-chat`, `child_process` 예외, 읽는 범위. mcp-interface.md 10절 | (가) `chat` 이 아닌 이름의 room-session 파일이 시그널에 글을 싣는다. (나) setup 이 호스트를 `--dangerously-skip-permissions` 로 띄운다. (다) `deployments/` 등의 TURN 설정을 보지 않는다 | 파일 이름을 달리 지으면 검사가 걸리지 않는다. 금지 범위가 검사 범위보다 넓다 | 권장 | **수용.** (가) room-session 에서 `sendSignal` 이라는 이름은 `signal-gate.ts` 한 파일만 쓴다. (나) `child_process` 는 `setup/host-cli.ts` 한 파일만 쓰고, 그 파일에 `host-cli.test.ts` 가 없으면 실패한다. `entry/cli` 의 예외를 없앴다. 권한을 넓히는 실행 옵션 문자열 8종을 금지했다. 하위 명령 목록은 설계(3.13, 10절, `V-L10` 다)에 적었고 그 단위 시험은 W8 이 쓴다. (다) `deployments/`, `scripts/`, `installer/` 의 글 파일에 TURN 이름과 주소 규칙을 돌린다(안내 문서와 시험 파일 제외) | W0-42, W0-48, W0-50 |

## `V-U8` 에 더한 규칙

위 "`V-U8` 이 보는 것" 표에 더해 읽는다. 바뀐 규칙은 "바뀜"으로 적었다.

| 규칙 | 보는 것 |
|---|---|
| `network` (새로) | signaling-selfhost·signaling-client 밖의 `net`, `dgram`, `http`, `https`, `http2`, `tls`. 모든 모듈의 전역 `fetch(`, `EventSource`. `ws` 를 import 하지 않은 파일의 `WebSocket` |
| `stdout` (새로) | diagnostics·setup·`entry/cli`·`entry/server` 밖의 `console.`, `process.stdout.write`·`end`·`cork`, `node:console` |
| `global-state` (새로) | 모듈 최상위의 `let`·`var`(조립 파일 포함). `globalThis`, `global.` |
| `builtin` (바뀜) | `child_process` 는 `setup/host-cli.ts` 만(설치 CLI 조립 파일의 예외를 없앴다). fs 는 정해진 여섯 모듈만. `process.getBuiltinModule` |
| `env` (바뀜) | mcp-server 도 `process.env` 를 읽지 않는다. `process?.env`, `process.env?.X` 도 잡는다 |
| `clock` (바뀜) | 조립 파일을 뺀 모든 모듈. `AbortSignal.timeout`, `process.hrtime`·`uptime`, `performance.now`·`timeOrigin`, `Date`·`performance` 를 다른 이름으로 받기, `new` 없는 `Date()` |
| `permission` (바뀜) | 권한을 넓히는 실행 옵션 문자열(`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--permission-mode`, `bypassPermissions`, `--allowedTools`, `--full-auto`, `--yolo`, `--ask-for-approval`) |
| `signal-chat` (바뀜) | room-session 에서는 `signal-gate.ts` 밖의 `sendSignal`·`SendSignal`(문자열로 꺼내는 것 포함) |
| `relay` (바뀜) | 이어 쓴 TURN 이름(`TurnServerUrl`). `deployments/`·`scripts/`·`installer/` 의 글 파일(스크립트는 주석을 지우고 문자열 안의 주소만, 그 밖은 있는 그대로) |
| `layout` (바뀜) | `setup/host-cli.ts` 가 있는데 `setup/host-cli.test.ts` 가 없음 |
| `import-internal` (바뀜) | 시험 파일은 `protocol/testing.ts` 를 쓸 수 있다. `diagnostics/contract.ts` 는 조립 성격의 모듈만 |

계약끼리의 맞물림(컴파일)에 더한 것 9곳: ICE 서버 값 → 라이브러리의 객체 형태, 연결 등록의 `sid` → 서버 `signal` 의 `sid`, `wait_for_messages` 의 `cursor` → `noteToolCall`, 로거 → 로그 포트 셋, 서버 로그 필드가 `peer` 를 받지 않음(과 `peer_ref` 는 받음), `logLevel` → 로거 생성 옵션.

## 건수

`node --test` 가 센 수는 421 이다(W0-51). 파일별: `boundaries.test.ts` 123, `limits` 70, `signaling-wire` 51, `p2p-wire` 40, `identifiers` 29, `state-records` 29, `server-address` 21, `ice-config` 20, `runtime-ports` 16, `local-files` 13, `index` 5, `link-failure` 4.

이 가운데 **제품 코드의 동작을 보지 않는 것**을 따로 센다(지적 PROTOCOL-IMPL-R1-03).

| 구분 | 건수 | 내용 |
|---|---|---|
| 시험 도구의 동작 확인 | 2 | `runtime-ports.test.ts` 의 가짜 타이머 2건. 제품이 바뀌어도 통과한다 |
| 적합성 시험의 자체 확인 | 14 | `runtime-ports.test.ts` 의 나머지. `protocol/testing.ts`(시험 전용)가 지키는 구현을 통과시키고 어긴 구현 8종을 잡는지 본다. 제품 구현은 보지 않는다 |
| 경계 검사기의 자체 시험 | 113 | `boundaries.test.ts` 가운데 가짜 소스로 검사기를 시험하는 것(소스 읽기 5, 가짜 위반과 그 주변 97, `src` 밖 설정 11) |
| 제품 코드와 실제 소스를 보는 것 | 292 | protocol 의 구현 테스트 282(나머지 10개 파일), `boundaries.test.ts` 의 실제 소스 4·의존성과 SDK 3·와이어 스키마 3 |

`Subscribable` 의 약속(순서, 동기 호출, 예외 격리, 해지)을 **실제 구현**으로 본 테스트는 아직 0건이다. 구현이 없다. signaling-client, mesh, inbox 가 `defineSubscribableContractTests` 를 자기 구현에 돌릴 때 처음 생긴다.

## 미실행 항목

| 항목 | 사유 |
|---|---|
| `stuns:` 를 실제 STUN-over-TLS 서버에 붙이는 시험 | 하지 않는다. 고정 라이브러리가 URL 을 받지 않아(W0-36) 거절하기로 했다 |
| IPv6 STUN 서버로 실제 후보를 얻는 시험 | 환경 없음. pc 가 만들어지는 것까지만 봤다(W0-44) |
| 객체 형태 STUN 의 srflx 확인을 다른 망·다른 PC 에서 | 이 PC 에서 1회만(W0-45) |
| `src` 밖 폴더(`deployments/`, `scripts/`, `installer/`)의 실제 파일에 대한 TURN 검사 | 그 폴더가 아직 없다. 가짜 파일 묶음으로만 봤다 |
| 실제 구현에 대한 새 `V-U8` 규칙 | 구현이 없다. 가짜 구현 사본으로만 봤다(W0-50) |
| `diagnostics` 가 서버 로그에서 `peer` 를 버리는지(`V-U6`), `inbox` 의 수신 불명 처리(`V-U4`), `setup/host-cli.test.ts` | 계약과 설계에만 적었다. 구현은 W7, W5, W8 |
| Node 22, Node 24, macOS arm64 밖의 OS | 환경 없음(위 기록과 같다) |
| 변이 점검의 전수 실행 | 표본 63건만 했다 |

## 다음 실행에서 확인할 것

- 구현이 들어온 뒤 새 규칙이 정상 코드를 잘못 잡는 곳. 알려진 것: 타입이나 객체에 메서드 모양으로 적은 `setTimeout(…)` 을 전역 타이머 호출로 읽는다(W0-37). 속성 모양(`setTimeout: (…) => …`)으로 적으면 걸리지 않는다. `fetch(` 라는 이름의 자기 메서드 정의도 같다.
- W3 의 `V-U11`: 통과한 ICE 값으로 pc 가 만들어지는지를 mesh 의 실제 코드 경로로 다시 본다(W0-44 는 탐색 스크립트였다).
- W6 이 시그널 전송을 `signal-gate.ts` 한 파일에 두고도 입장 절차를 자연스럽게 쓸 수 있는지. 어렵다면 계약 변경 절차로 알린다.
- W1·W2 가 `signaling-selfhost`, `signaling-aws` 에서 시계를 주입받는 것이 실제 소켓 시험(`V-L1`)과 맞물리는지.
- 검토자의 반례 가운데 이번 지적에 없어 그대로 남은 6건(W0-42 의 G7a, G7b, G10, G11, G12, G13)을 규칙으로 만들지.
- `tests/test-history/README.md` 색인에 이 파일의 줄이 없다. 색인 소유 묶음(W9)이 더한다.

---

# W0 검토 지적 반영 (2차)

위 기록(W0-01 ~ W0-51)에 이어 적는다. 위 기록은 고치지 않았다. 독립 검토 2차의 지적 8건(protocol 구현 4건, 계약과 설계의 대조 4건. 모두 권장)을 판단해 반영하고 다시 검증한 기록이다. 위 기록과 다른 곳은 이 절이 최신이다(예: `encodeServerMessage` 와 `packStateFrames` 의 반환 타입, `Inbox.discardAll`, `Mesh.expireAttempt`, `V-U8` 의 규칙. 테스트는 471건이다).

- 대상 파일
  - 고침: `src/protocol/p2p-wire.ts`, `signaling-wire.ts`, `state-records.ts`, `index.ts`, 그 테스트 4개(`p2p-wire`, `signaling-wire`, `state-records`, `index`). `src/mesh/contract.ts`, `src/inbox/contract.ts`, `src/room-session/contract.ts`, `src/shared-state/contract.ts`, `src/signaling-core/contract.ts`, `src/boundaries.test.ts`
  - 설계 문서: `docs/design/protocol.md`(2.3, 3.2, 3.3, 4.4, 5.2), `architecture.md`(2절, 3.1, 3.2, 3.6, 3.7, 3.8, 3.10, 3.13, 6.1, S3), `mcp-interface.md`(3.3, 7.1, 10절), `verification-plan.md`(3.1 의 `V-U1`·`V-U3`·`V-U4`·`V-U8`·`V-U9`·`V-U11`), `implementation-plan.md`(묶음별 메모 W1·W2, W3, W4, W5, W6, W8)
  - `package.json`, `tsconfig.json`, `src/signaling-core/ports.ts`, `src/diagnostics/log-port.ts`, `tests/support/proc.mjs` 는 바꾸지 않았다. 의존성은 그대로다.
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e`. 미커밋 변경은 위 기록의 대상과 이 대상이다. 다른 묶음의 파일은 작업 트리에 없었다.
- 환경: 위와 같다(macOS arm64 한 대, Node v26.12.1, TypeScript 7.0.2).
- 검증 수준: 모두 대역이다. 네트워크와 실제 라이브러리의 연결은 쓰지 않았다.
- 참고한 이전 실행
  - W0-14, W0-26(파이프 뒤 종료 코드를 남기지 못함): 출력을 파일로 보내고 종료 코드를 따로 남겼다.
  - W0-48(변이 점검): 같은 방법으로 새 규칙과 수정을 점검했다(W0-60, W0-61). 그 실행의 `dist` 사본(`<scratch>/r1/mut`)을 "고치기 전 검사기"로 써서 반례를 재현했다(W0-54).
  - W0-50(가짜 구현 사본): 같은 사본에 새 계약을 덮어써 다시 컴파일했다(W0-62).
  - W0-47(타입 계약의 컴파일 확인): 새 타입에 같은 방법을 썼다(W0-63).
  - W0-42(검토자의 경계 검사 반례와 정상 코드 표본): 같은 표본을 다시 넣었다(W0-65). 그때 남긴 6건 가운데 G7a·G7b 가 이번 지적에 들어왔다.
- 원문 증거: 명령 출력과 탐색 스크립트는 세션 임시 폴더(`<scratch>/r2/`)에 있고 보존 대상이 아니다. 검토자의 반례 스크립트는 `<scratch>/review-protocol-impl/`(t3, t6, t8), `<scratch>/review-contracts-vs-design/`(exp1, exp2, exp3)에 있었다. 저장소에는 탐색용 파일을 두지 않았다.

## 요약

| 항목 | 결과 | 근거 실행 |
|---|---|---|
| `npm run build`, `npm test` 가 통과한다 | 통과. 테스트 471건, 실패 0건 | W0-66 |
| 지적 8건(모두 권장) | 8건 모두 수용. 그중 3건은 설계에 없던 경우를 정한 것이다(아래 "설계와 다른 관찰") | 지적 원장 |
| 검토자의 반례가 더는 재현되지 않는다 | 통과. protocol 3건은 거절로 바뀌었고, 경계 검사 반례 가운데 지적에 든 11건을 모두 잡는다 | W0-53, W0-54, W0-59 |
| `lc` 가 `2^53 − 1` 인 기록은 지금도 받는다 | 의도한 동작이다. 스키마의 끝을 상수와 시험으로 고정했고, 그 뒤의 쓰기를 거절하는 규칙을 계약과 설계에 적었다. 거절 자체의 구현과 시험은 W4 | W0-59 |
| 새 규칙과 수정이 테스트로 지켜진다 | 변이 52건 가운데 51건을 잡았다. 남은 1건은 다른 규칙이 같은 것을 잡아 동작이 같다 | W0-60, W0-61 |
| 새 계약이 틀린 사용을 컴파일에서 거절한다 | 통과. 12곳 | W0-63 |
| 계약 변경이 가짜 구현의 컴파일에서 드러나고, 고치면 새 규칙 아래에서 통과한다 | 통과. 네 곳(오류 7건)이 드러났다 | W0-62 |
| 새 규칙이 설계대로 쓴 정상 코드를 더 막지 않는다 | 통과. 1차의 정상 코드 표본 결과가 그대로다 | W0-65 |

## 실행 기록

시각은 KST 다. 로그 파일의 수정 시각과 실행 때 찍은 시각에서 옮겼다.

| 실행 ID | 시각 | 수준 | 대상·시나리오 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|---|
| W0-52 | 16:41:07 ~ 16:41:08 | 대역 | 고치기 전의 기준 상태 | `npm run build` → `npm test` | 둘 다 exit 0, 421건 | 둘 다 exit 0. tests 421, suites 52, pass 421, fail 0 | 통과 |
| W0-53 | 16:41 경 | 대역 | protocol 지적 3건의 재현(고치기 전) | `node <scratch>/review-protocol-impl/t3.mjs`, `t6.mjs`, `t8.mjs` | 지적대로 재현된다 | `packStateFrames`: 글자 필드 5000바이트 기록 → ok, 받는 쪽 `invalidRecords` 1. 49354바이트 기록 → ok(프레임 49398바이트). 같은 기록의 `encodeP2PFrame` → `BAD_FRAME records.0: record is 49354 bytes`. 모르는 필드가 실린다. `encodeServerMessage` → 다시 해석하면 `BAD_MESSAGE` 3건(`code: invalid_value; message: invalid_type`, `data.list: too_small`, `re: invalid_format`), 모르는 필드 `secret` 이 실린다. `lc = 2^53 − 1` 을 받고, 본 값 + 1 은 `BAD_RECORD lc: too_big` | 재현됨 |
| W0-54 | 17:03 경 (고친 뒤에 실행. 대상은 W0-48 이 남긴 고치기 전 `dist` 사본) | 대역 | 경계 검사 지적 2건의 재현(고치기 전 검사기) | `AGENT_CHAT_REPO_ROOT=<repo> node <scratch>/review-contracts-vs-design/exp1.mjs <scratch>/r1/mut`, `exp2.mjs`, `exp3.mjs` | 지적한 표본이 "(위반 없음)"이다 | exp1 의 1·2·3(`node:module`), 5(polyfill), 9(SDK HTTP 전송), 15(`setup/doctor.ts` 의 클라이언트 stdio), exp2 의 A(mcp-server 의 클라이언트 stdio), B(`node:process`), C(`inspector`·`vm`), exp3 의 X1(설치 진입점의 권한 옵션) 모두 "(위반 없음)". exp1 의 4 는 셋째 줄(`new Date()`)만 잡고 `+new Date`, `(new Date)` 는 놓쳤다. exp1 은 16번에서 exit 1 이었다(사본에 `docs/` 가 없어 파일 읽기 실패. 1~15번은 출력됐다) | 재현됨 |
| W0-55 | 16:49:33 | 대역 | protocol 수정 뒤 첫 빌드와 실행 | `npm run build` → `node --test --enable-source-maps "dist/protocol/*.test.js"` | 빌드 exit 0, 실패 0 | 빌드 exit 0. tests 314, pass 313, fail 1. 실패: "lc 와 wall 은 안전 정수까지다". 사유 문구가 `lc: too_big` 이 아니라 `lc: too_big; lc: too_big` 이었다. 상한을 `.max(STATE_CLOCK_MAX)` 로 한 번 더 걸었는데, zod 의 `int()` 가 이미 같은 끝(안전 정수)을 걸고 있어 같은 사유가 두 번 나왔다 | 실패 → `.max` 를 빼고, "끝이 `STATE_CLOCK_MAX` 와 같다"를 주석과 시험으로 고정 |
| W0-56 | 16:49:49 | 대역 | W0-55 재실행 | 같은 명령 | 실패 0 | 빌드 exit 0. tests 314, pass 314, fail 0 | 통과 |
| W0-57 | 16:54:38 | 대역 | 경계 검사기에 규칙을 더한 뒤 | `npm run build` → `node --test --enable-source-maps dist/boundaries.test.js` | 빌드 exit 0, 실패 0 | 빌드 exit 0. tests 155, pass 155, fail 0 | 통과 |
| W0-58 | 16:58:04 ~ 16:58:06 | 대역 | 계약, 설계 문서, 계약 맞물림 확인을 고친 뒤 | `npm run build` → `npm test` | 둘 다 exit 0 | 둘 다 exit 0. tests 469, suites 54, pass 469, fail 0 | 통과 |
| W0-59 | 16:58:32 | 대역 | 2차 반례를 고친 빌드에 다시 넣음 | `node <scratch>/r2/after-probes.mjs <repo>`(t3·t6·t8 의 반례를 새 서명으로 옮긴 것), `node <scratch>/review-contracts-vs-design/exp1.mjs <repo>`, `exp2.mjs`, `exp3.mjs`, 그리고 `dist/protocol` 사본의 `index.js` 에서 `encodeClientMessage`·`encodeP2PFrame` 을 뺀 뒤 `node --test <사본>/protocol/index.test.js` | 반례가 재현되지 않는다 | `packStateFrames`: 5000바이트 글자 필드 → `BAD_FRAME records.0: body.observed: text field exceeds 4096 bytes`. 큰 기록 → `BAD_FRAME records.0: record is 49353 bytes; the limit is 32768`(`encodeP2PFrame` 과 같은 결과). 모르는 필드는 실리지 않는다. `encodeServerMessage`: 세 표본 모두 `BAD_MESSAGE`, `secret` 은 빠진다. `STATE_CLOCK_MAX` = 9007199254740991, 그 값은 받고 1 큰 값은 `BAD_RECORD lc: too_big`. 경계 검사: W0-54 에서 "(위반 없음)"이던 표본을 모두 잡는다(`builtin` 5, `external-package` 4, `permission` 1). exp1 의 4 는 세 줄 모두 `clock`. 함께 잡힌 것: exp1 의 7(`node:dns`), 13(`node:process` 이름공간), exp2 의 D(`perf_hooks`). 지나간 것: exp1 의 6(다른 이름으로 받은 stdout), 8, 10, 12, 20, exp2 의 F(다른 이름으로 받은 전역 타이머), S, exp3 의 X3. 이번 지적에 없는 것들이다. `index.js` 변이: tests 6, pass 5, fail 1("설계가 적은 진입점이 모두 있다") | 통과 |
| W0-60 | 16:59:40 ~ 16:59:58 | 대역 | 변이 점검 1차. `dist` 사본(`<scratch>/r2/mutdir`)의 한 곳씩 바꾸고 테스트를 돌린다. 52건: 내장 모듈 허용 목록 9, SDK 하위 경로와 MCP 프로세스 파일 11, polyfill 2, `new Date` 3, `src` 밖의 권한 옵션 6, `packStateFrames` 6, `encodeServerMessage` 6, `lc` 상한 2, 공개 진입점 7 | `node <scratch>/r2/mutate-r2.mjs <사본> <repo>` | 모두 실패 1건 이상 | 48건을 잡았다. 남은 4건: "vm 허용", "inspector 허용"(자체 시험의 표본 하나가 두 모듈을 함께 import 해서, 하나를 허용해도 다른 하나가 걸렸다), "repl 허용"(같은 이유. `worker_threads` 와 묶여 있었다), "mcp-server 에 클라이언트 stdio 허용"(경로를 허용해도 "그 전송은 `setup/mcp-process.ts` 만"이 같은 import 를 잡는다. 동작이 같다) | 부분 → 표본을 모듈 하나씩으로 나눔 |
| W0-61 | 17:00:15 ~ 17:00:33 | 대역 | W0-60 재실행(표본을 나누고 조립 파일의 목록 밖 내장 모듈 사례를 더한 뒤) | `npm run build` → 같은 명령 | 동작이 같은 1건을 빼고 모두 실패 | 빌드 exit 0. 51건을 잡았다. 남은 1건은 "mcp-server 에 클라이언트 stdio 허용"(동작이 같다). 못 찾은 변이 0. 원본 재실행 exit 0, 471/471 | 통과(1건은 대상 아님) |
| W0-62 | 17:00 ~ 17:01:33 | 대역 | 계약만 보고 쓴 가짜 구현 사본(W0-50 의 것을 `<scratch>/r2/wiring` 으로 복사)에 저장소의 현재 `src` 를 덮어쓰고 다시 컴파일 | `npx tsc -p tsconfig.json --outDir .work/dist` → `node --test ".work/dist/**/*.test.js"`. 이어서 가짜 서버 규칙이 `encodeServerMessage` 의 결과를 문자열로 쓰게 바꾸고 `npx tsc --noEmit` | 계약 변경이 컴파일에서 드러난다. 고치면 통과한다. 틀린 사용은 실패한다 | 1차: tsc exit 2. 네 곳, 오류 7건. `inbox/index.ts` 에 `discardAll` 없음(TS2322), `mesh/index.ts` 에 `expireAttempt` 없음(TS2741), `room-session/index.ts` 의 `leave` 결과에 `undelivered_events` 없음(TS2322), `signaling-core/index.ts` 가 `encodeServerMessage` 의 결과를 문자열로 넘김(TS2345 4건). 가짜 구현을 고쳤다(서버 규칙은 실패를 `SERVER_ERROR` 로 바꾸는 전송 함수 하나로, 방 조율은 퇴장과 입장 실패에서 `discardAll`, 입장 기한에 `expireAttempt`). 2차: tsc exit 2, TS1005 5건. 고치는 스크립트가 `joined` 줄을 잘못 바꿨다(사본을 고치던 쪽의 실수). 그 줄을 고친 3차: tsc exit 0, tests 472, pass 472, fail 0(가짜 구현이 든 트리에서 경계 위반 0건). 틀린 사용: tsc exit 1, TS2345(`Err<"BAD_MESSAGE">` 는 `string` 이 아니다) | 통과(가짜 구현을 새 계약에 맞춘 뒤) |
| W0-63 | 17:01:57 | 대역 | 새 계약이 틀린 사용을 거절하는가. 저장소 `src` 사본(`<scratch>/r2/typeneg`)에 `@ts-expect-error` 12곳과 맞는 사용을 담은 파일을 더했다 | `npx tsc -p tsconfig.json --noEmit` | exit 0(표시한 곳이 모두 실제 오류이고 나머지는 통과) | exit 0. 거절: `encodeServerMessage` 의 결과를 `string` 에 대입, 그 오류 코드를 `MESSAGE_TOO_LARGE` 로 좁히기, `packStateFrames` 의 오류 코드를 `FRAME_TOO_LARGE` 로 좁히기, `undelivered_events` 없는 `RoomLeft`, 그 값이 문자열인 `RoomLeft`, `discardAll` 없는 수신함을 `SessionInbox` 에 대입, `SessionInbox` 로 `wait` 부르기, `expireAttempt` 없는 mesh, 인자 없는 `expireAttempt()`, 사유 `relay_not_allowed`, 사유 `replaced`, `handleRelayError` 에 `ROOM_FULL`. 통과: 결과를 `ok` 로 가른 뒤 쓰기, `discardAll()` 의 값을 `undelivered_events` 에 넣기, `RoomLeft` 를 `leave_room` 결과에 넣기, `ice`/`failed` 로 끝낸 시도 | 통과 |
| W0-64 | 17:02 경 | 대역 | protocol 번들과 계약 파일의 산출물 | `npx esbuild src/protocol/index.ts --bundle --platform=node --format=esm --target=node22 '--external:@aws-sdk/*' --outfile=<scratch>/r2/bundle/protocol.mjs`, 번들을 import 해 `encodeServerMessage`·`packStateFrames`·`STATE_CLOCK_MAX` 사용, 계약 파일 12개의 내용 확인 | 번들이 혼자 돈다. 계약 파일에 실행 코드가 없다 | esbuild exit 0, 783.9kb(W0-46 은 783.4kb). 외부 import 는 `node:crypto` 뿐. `node:test`, `node:assert`, `defineSubscribableContractTests` 0건. 호출 결과 정상. 계약 파일 12개는 `export {};` 뿐 | 통과 |
| W0-65 | 17:02 경 | 대역 | 1차의 표본을 고친 검사기에 다시 넣음(W0-42 와 같은 스크립트) | `node <scratch>/r1/legit.mjs`, `legit2.mjs`, `gaps.mjs` | 정상 코드의 결과가 1차와 같다. 반례는 더 잡는다 | 정상 코드: `legit` 통과 9, 걸림 3. `legit2` 통과 10, 걸림 2(L4, L11). 걸린 것과 사유가 W0-42 와 같다. 새 규칙(내장 모듈 허용 목록, SDK 하위 경로)에 걸린 정상 코드는 없다. 반례: 잡음 22(W0-42 는 20. G7a, G7b 가 더해졌다), 놓침 4(G10, G11, G12, G13) | 통과 |
| W0-66 | 17:02:47 ~ 17:02:48 | 대역 | 완료 기준 명령. `dist` 를 지우고 실행 | `rm -rf dist` → `npm run build` → `npm test` | 둘 다 exit 0. 실패 0 | `npm run build` exit 0(오류 출력 없음). `npm test` exit 0: tests 471, suites 54, pass 471, fail 0, cancelled 0, skipped 0, todo 0. 저장소에 `.work` 없음 | 통과 |
| W0-67 | 16:57 경, 17:02 경 (결과 같음) | 대역(정적) | 설계 문서의 링크 | `python3 <scratch>/linkcheck.py docs/design` | 깨진 링크 0 | 검사한 링크 311(W0-49 는 283), 깨진 링크 0 | 통과 |

## 지적 원장

"재검증"의 실행 ID 는 위 표의 것이다. 처리의 "수용"은 지적한 사실을 받아들여 코드·계약·문서 가운데 하나 이상을 고쳤다는 뜻이다.

| ID | 위치 | 반례 | 영향 | 필수/권장 | 처리 | 재검증 |
|---|---|---|---|---|---|---|
| PROTOCOL-IMPL-R2-01 | `src/protocol/p2p-wire.ts` 의 `packStateFrames`, architecture.md 3.1, protocol.md 4.4 | 글자 필드 5000바이트 기록과 49354바이트 기록으로 프레임이 만들어진다. 받는 쪽은 그 기록을 버린다. 모르는 필드가 실린다. 유일한 오류 갈래 `FRAME_TOO_LARGE` 는 유효한 기록으로 닿을 수 없고 시험도 없다 | 스냅샷과 변경의 주 경로에 "받는 쪽이 거절할 것을 만들지 않는다"가 걸려 있지 않다. 보낸 쪽만 성공으로 알고 지문이 계속 어긋난다 | 권장 | **수용(첫째 안).** 기록마다 `parseStateRecord` 로 먼저 본다. 하나라도 걸리면 프레임을 하나도 만들지 않고 `BAD_FRAME`(`records.<순번>: …`)이다. 통과한 값을 싣는다(모르는 필드는 빠진다). 닿을 수 없던 `FRAME_TOO_LARGE` 갈래는 없앴다. 반환 타입은 `Result<string[], 'BAD_FRAME'>` 다. 통과한 기록이 한 프레임에 든다는 것은 상한의 관계(`limits.test.ts`)와 상한에 맞춘 기록의 시험이 지킨다. architecture.md 3.1 의 불변조건을 네 함수 이름으로 적고 "예외는 없다"를 더했다. protocol.md 4.4 에 문장을 더했다. shared-state 계약에 "`applyLocal` 의 기록과 `snapshot()` 은 이 함수를 통과하는 값"을 적었다 | W0-53(재현), W0-59, W0-60, W0-63 |
| PROTOCOL-IMPL-R2-02 | `src/protocol/signaling-wire.ts` 의 `encodeServerMessage`, architecture.md 3.1·3.2, protocol.md 2.3 | 표에 없는 오류 코드, 빈 후보 묶음, 형식이 틀린 `re` 가 그대로 직렬화되고 `parseServerMessage` 가 `BAD_MESSAGE` 로 버린다. 모르는 필드가 실린다 | 불변조건을 `encode…` 전체로 적었는데 이것만 검증하지 않는다. 서버 규칙 코드에 결함이 있으면 클라이언트가 버릴 `joined`·`error` 가 나가고 클라이언트는 요청 기한까지 기다린다. 나중에 맞추면 호출부가 함께 바뀐다 | 권장 | **수용(첫째 안. W1 시작 전).** type 별 스키마로 먼저 보고 `Result<string, 'BAD_MESSAGE'>` 를 돌려준다. 모르는 필드는 버린다. 해석과 직렬화가 같은 판정 함수를 쓴다. 크기 상한은 걸지 않는다(서버 → 클라이언트 방향에는 상한이 없다). signaling-core 계약과 architecture.md 3.2, protocol.md 2.3 에 "실패는 그 요청의 `SERVER_ERROR` 와 로그로 바꾼다"를 적었다. 설계의 문장(모든 보내는 함수가 먼저 검증한다)을 좁히지 않고 코드를 문장에 맞췄다 | W0-53(재현), W0-59, W0-60, W0-62, W0-63 |
| PROTOCOL-IMPL-R2-03 | `src/protocol/state-records.ts` 의 `clockSchema`, protocol.md 5.2 | `lc = 2^53 − 1` 인 기록을 받는다. 그것을 본 뒤에 쓴 기록(본 값 + 1)은 같은 스키마가 거절한다. 상한을 풀어도 `2^53` 에서는 더하기 1 이 값을 바꾸지 못한다 | 그런 기록이 한 번 들어오면 그 방에서는 누구도 `presence`·`stop`·`claim` 을 쓸 수 없다. 설계에 `lc` 의 상한과 넘칠 때의 동작이 없어 W4 가 각자 정하게 된다. 정상 시계로는 닿지 않는다(결함이나 위조) | 권장 | **수용(보수적 해석을 계약과 설계에 확정. 받는 동작은 그대로).** ① 스키마의 끝을 상수 `STATE_CLOCK_MAX`(`2^53 − 1`)로 내보내고 시험으로 고정했다. ② shared-state 계약(`CommandErrorCode`)과 protocol.md 5.2 에 "본 값 + 1 이 끝을 넘으면 그 쓰기를 `INVALID_ARGUMENT` 로 거절한다. 값을 접거나 낮춰 쓰지 않는다. 그 방에서는 그 뒤로 기록을 쓸 수 없다"를 적었다. 새 오류 코드는 만들지 않았다("만든 기록이 와이어 스키마를 어긴 경우"라는 기존 정의에 든다). ③ `V-U3` 에 사례를 더했다. 스키마의 상한을 낮추는 것으로는 풀리지 않는다는 지적을 받아들여 상한은 그대로 뒀다. **"설계와 다른 관찰"에 올린다** | W0-53(재현), W0-59, W0-60. 거절 동작은 W4 의 `V-U3` |
| PROTOCOL-IMPL-R2-04 | `src/protocol/index.test.ts`, architecture.md 3.1 | `index.js` 에서 `encodeClientMessage`·`encodeP2PFrame` 을 지워도 421건이 모두 통과한다 | 다른 모듈은 `index.ts` 만 import 한다. "모두 있다"는 시험이 늘어난 진입점을 지키지 않는다 | 권장 | **수용.** 설계가 적은 진입점 목록에 두 함수를 더했다. 다른 모듈이 쓰는 함수 26개(`encodeServerMessage`, `packStateFrames`, `parseStateRecord`, `signalCarriesRelay`, `stateFingerprint` 등)와 `STATE_CLOCK_MAX` 를 보는 시험을 따로 더했다 | W0-59, W0-60 |
| CONTRACTS-VS-DESIGN-R2-01 | `src/mesh/contract.ts` 의 `AttemptFailure`·`MeshEvents`·`handleRelayError`, protocol.md 3.2·3.3 | (가) `RELAY_NOT_ALLOWED` 로 끝낸 시도의 사유가 다섯 짝 어디에도 없다. (나) 새 `cid` 의 `offer` 가 진행 중인 시도를 바꿀 때 `attempt-failed` 를 내는지 계약에 없다. 바뀐 시도가 입장 기한까지 끝나지 않으면 그 피어의 단계를 알 길이 없다 | W3 와 W6 가 다르게 정할 수 있다. (가)는 어느 짝을 골라도 입장 결과나 안내가 틀릴 수 있다 | 권장 | **수용.** (나) "바뀜은 시도의 끝이 아니다. 이벤트를 내지 않고 기한을 바뀐 때부터 새로 잰다"를 mesh 계약, protocol.md 3.2, architecture.md 3.6 에 적었다(지적의 1번 안). 그러면 바뀐 시도가 입장 기한(20초)을 넘겨 이어질 수 있으므로, 지적이 영향으로 든 빈 곳을 메우려고 `Mesh.expireAttempt(peer)` 를 더했다. room-session 이 입장 기한에 아직 시도 중인 필수 피어에 부르고, mesh 는 기한이 찼을 때와 같은 분류로 `attempt-failed` 를 한 번 낸다. "남은 기한을 이어받는다"로 정하는 안은 버렸다(늦게 다시 시작한 상대와의 시도가 열리기 직전에 끝나는 일이 되풀이될 수 있다). (가) 사유를 더하지 않고 `ice`/`failed` 로 끝낸다. `peer_gone` 이 아니므로 필수 목록에서 빼지 않고 연속 실패로 센다. 원인은 로그 `link.attempt_end` 의 `error_code` 로 남긴다(지적의 2번 안). 옛 `cid` 의 오류는 버린다는 것도 `handleRelayError` 에 적었다. `V-U11`, `V-U9` 에 사례를 더했다. **"설계와 다른 관찰"에 올린다** | W0-62, W0-63. 동작은 W3 의 `V-U11`, W6 의 `V-U9` |
| CONTRACTS-VS-DESIGN-R2-02 | `src/inbox/contract.ts`, `src/room-session/contract.ts` 의 `SessionInbox`·`RoomLeft`, mcp-interface.md 3.3·7.1, architecture.md 3.8·3.10·S3 | 방 R1 의 `chat` 과 테스트 요청이 수신함에 남은 채 `leave_room` → 다른 방 R2 에 들어가면 첫 `wait_for_messages` 가 R1 의 사건을 준다. 사건에 방 표시가 없고 비우는 함수가 없다. 입장 실패에서도 같다 | 앞 방의 글과 테스트 요청이 새 방의 사건으로 전달된다. 어느 쪽으로 정하든 inbox 계약이 바뀐다 | 권장 | **수용(보수적인 쪽).** `Inbox.discardAll(): number` 를 더했다. 대기열(내준 것과 내주지 않은 것 모두)을 비우고 내주지 않은 수를 돌려준다. 넘침과 구분한다(`inbox_dropped` 사건과 누락 누계에 넣지 않는다). 순번은 이어 간다. channel 모드의 "확인 안 된" 사건과 `pushed_since_last_call` 집계도 없어진다. 모드와 점검 토큰은 그대로다. `SessionInbox` 에 넣었고, room-session 이 퇴장과 입장 실패·취소의 정리에서 부른다. `leave` 결과에 `undelivered_events` 를 더했다(`leave_room` 결과에 그대로 나간다). 입장 실패의 수는 inbox 가 로그 `inbox.discarded`(`unseen`)로 남긴다. architecture.md 3.8·3.10·6.1·S3, mcp-interface.md 3.3·7.1, `V-U4`, `V-U9` 에 적었다. **"설계와 다른 관찰"에 올린다**(tool 결과에 필드가 하나 늘었다) | W0-62, W0-63. 동작은 W5 의 `V-U4`, W6 의 `V-U9` |
| CONTRACTS-VS-DESIGN-R2-03 | `src/boundaries.test.ts` 의 외부 패키지·내장 모듈 규칙, architecture.md 2절·3.6·3.11·3.13, mcp-interface.md 10절 | `node:module` 의 `createRequire` 로 `node:net`·`child_process`·`ws` 를 부른다. mcp-server 가 SDK 의 클라이언트 stdio 전송과 HTTP 전송을 쓴다. `setup/doctor.ts` 가 클라이언트 stdio 로 호스트를 띄운다. `node:process` 를 다른 이름으로 받아 env·stdout·시계를 쓴다. `inspector`·`vm`. `node-datachannel/polyfill` | 설계가 금지로 적었고 import 로 정확히 가릴 수 있는데 지나간다. `V-U8` 통과가 틀린 보증이 된다 | 권장 | **수용.** ① 내장 모듈을 금지 목록에서 **허용 목록**으로 바꿨다(지적의 "또는" 안). 제품 코드는 `assert`, `buffer`, `crypto`, `events`, `os`, `path`, `stream`, `string_decoder`, `url`, `util` 과 모듈을 정해 둔 `fs`·네트워크 여섯·`child_process`·`console`·`timers` 만 쓴다. `module` 과 `process` 는 조립 파일에서도 막았다(지적은 `entry` 밖만 들었다. 조립 파일에서 `createRequire` 로 `child_process` 를 부르면 같은 우회이고, `process` 를 다른 이름으로 받으면 조립 파일의 환경 변수 규칙을 비켜 간다). ② MCP SDK 하위 경로: mcp-server 는 `server`, `server/index.js`, `server/mcp.js`, `server/stdio.js`, `server/completable.js`, `types.js`, `shared/*`. setup 은 `client`, `client/index.js`, `client/stdio.js`, `types.js`, `shared/*`. `client/stdio.js` 는 `setup/mcp-process.ts` 한 파일만 쓰고 그 파일에 시험이 없으면 실패한다. 시험 파일은 이 표를 따르지 않는다. ③ `node-datachannel` 은 이름 그대로만(시험 파일 포함). architecture.md 2절·3.13, mcp-interface.md 10절, `V-U8` 정의, 구현 계획(W3, W5, W8)에 적었다 | W0-54(재현), W0-57, W0-59, W0-61, W0-65 |
| CONTRACTS-VS-DESIGN-R2-04 | `src/boundaries.test.ts` 의 `analyzeExtra`·시계 규칙, mcp-interface.md 10절, architecture.md 3.13 | (가) `installer/claude.sh` 의 `--dangerously-skip-permissions`, `scripts/install.mjs` 의 `--dangerously-bypass-approvals-and-sandbox` 가 "(위반 없음)"이다. (나) `+new Date`, `(new Date).getTime()` 을 놓친다 | (가) 호스트를 가장 쉽게 띄울 수 있는 설치 진입점이 권한 옵션 검사 밖이다. (나) 가짜 시계 시험에서 조용히 어긋난다 | 권장 | **수용.** (가) `analyzeExtra` 가 권한을 넓히는 실행 옵션과 permission capability 문자열도 찾는다(스크립트는 주석을 지운 뒤, 셸과 그 밖의 글 파일은 있는 그대로). 규칙 이름은 `permission` 이다. (나) `new Date` 규칙을 "뒤에 `(` 와 인자가 오지 않는 `new Date`"로 넓혔다. architecture.md 2절·3.13, mcp-interface.md 10절, `V-U8` 정의에 적었다 | W0-54(재현), W0-57, W0-59, W0-61 |

## 설계와 다른 관찰

설계에 없던 경우를 정했거나 설계 문서의 뜻을 넓힌 곳이다. 모두 해당 절에 적어 두었다. 총괄이 다르게 정하면 계약과 문서를 함께 되돌린다.

| 위치 | 내용 | 택한 해석 |
|---|---|---|
| protocol.md 5.2, `shared-state/contract.ts` 의 `CommandErrorCode` | `lc` 의 상한과, 본 값 + 1 이 상한을 넘을 때의 동작이 설계에 없었다 | 상한은 안전 정수의 끝(`2^53 − 1`)이다. 넘으면 그 쓰기를 `INVALID_ARGUMENT` 로 거절한다. 값을 접거나 낮추지 않는다. 그 방에서는 그 뒤로 누구도 기록을 쓸 수 없다(중단 요청 포함). 위조는 범위 밖이라는 설계의 전제를 따랐다. 에이전트에게는 `INVALID_ARGUMENT` 로 보이는데, 인자가 틀린 것이 아니라 방이 망가진 것이다. 전용 오류 코드를 둘지는 정하지 않았다 |
| protocol.md 3.2("진행 중인 시도가 바뀌는 경우")·3.3, `mesh/contract.ts`, architecture.md 3.6·3.10 | `offer` ④가 진행 중인 시도의 pc 를 닫을 때 그 시도가 끝난 것인지가 설계에 없었다. "시도 하나는 둘 중 하나로 끝난다"와 "하나라도 실패하면 입장 전체 실패"를 글자대로 읽으면, 상대가 다시 시작하기만 해도 입장이 실패한다 | 시도의 끝이 아니다. 이벤트를 내지 않고 기한을 바뀐 때부터 새로 잰다. 대신 **mesh 의 공개 진입점이 하나 늘었다**(`expireAttempt`). 입장 기한에 아직 시도 중인 필수 피어의 단계와 사유를 얻는 길이다. 바뀌지 않은 시도는 15초 안에 끝나므로 이 호출에 닿지 않는다. 피어 하나와의 시도가 처음 시작한 때부터 15초를 넘길 수 있어, protocol.md 3.1 의 "약 31초 안에 닿지 않음을 알린다"는 상대가 그 사이에 다시 시작한 경우에는 성립하지 않는다 |
| protocol.md 3.2·3.3, `mesh/contract.ts` 의 `handleRelayError` | `RELAY_NOT_ALLOWED` 로 끝낸 시도의 단계와 사유가 실패 분류표에 없었다 | 표를 바꾸지 않고 `ice`/`failed` 를 쓴다. 입장 중이면 `DIRECT_CONNECT_FAILED` 의 `ice` 안내("NAT·방화벽")가 나간다. 실제 원인(결함이나 설정 위반)과 다른 안내다. 원인은 로그의 `error_code` 에만 남는다. relay 후보는 설정과 mesh 의 필터가 막으므로 결함이 있을 때만 닿는다 |
| mcp-interface.md 3.3·7.1, architecture.md 3.8·3.10·S3, `inbox/contract.ts`, `room-session/contract.ts` | 방을 나갈 때 수신함을 어떻게 하는지가 설계에 없었다 | 비운다. **inbox 의 공개 진입점이 하나 늘었고**(`discardAll`), **`leave_room` 결과에 필드가 하나 늘었다**(`undelivered_events`). 입장 도중 받아 `ack` 한 `chat` 도 입장이 실패하면 수신함에서 없어진다(보낸 쪽에는 `delivered` 로 보였다. `ack` 의 뜻은 "수신함에 넣었다"까지라 글자로는 어긋나지 않는다). 본문은 기록 파일에 남는다 |
| architecture.md 2절·3.13, `src/boundaries.test.ts` | 설계는 SDK 를 "서버 쪽"·"클라이언트 쪽"으로만 나눴고, 내장 모듈은 금지할 것만 적었다. `doctor` 가 MCP 프로세스를 띄우는 파일의 이름이 없었다 | SDK 하위 경로와 내장 모듈을 허용 목록으로 적었다. 프로세스를 띄우는 SDK 전송을 쓰는 파일을 `src/setup/mcp-process.ts` 로 정하고 옆에 시험을 요구했다(W8 의 파일 이름을 하나 정한 것이다). 허용 목록에 `readline`, `tty`, `zlib`, `perf_hooks` 는 없다. 필요해지면 계약 변경 절차로 더한다 |
| architecture.md 3.1, `src/protocol/p2p-wire.ts` | `packStateFrames` 의 오류 코드가 `FRAME_TOO_LARGE` 에서 `BAD_FRAME` 으로 바뀌었다 | 유효한 기록으로는 닿을 수 없던 갈래를 없앴다. 스냅샷에 걸리는 기록이 하나라도 있으면 그 링크로는 스냅샷이 하나도 나가지 않는다(일부만 보내지 않는다). 복제본에는 검증을 통과한 기록만 들어가므로 결함이 있을 때만 닿는다 |

## `V-U8` 에 더한 규칙

위 두 표("`V-U8` 이 보는 것", "`V-U8` 에 더한 규칙")에 더해 읽는다.

| 규칙 | 보는 것 |
|---|---|
| `builtin` (바뀜) | 내장 모듈을 허용 목록으로 가린다. `node:module`, `node:process` 는 조립 파일에서도 쓰지 않는다. 목록 밖(`vm`, `inspector`, `repl`, `wasi`, `dns`, `perf_hooks`, `readline` 등)은 어디서도 쓰지 않는다 |
| `external-package` (바뀜) | MCP SDK 의 하위 경로(제품 코드만). mcp-server 는 서버 쪽과 stdio 전송, setup 은 클라이언트 쪽과 stdio 전송. `client/stdio.js` 는 `setup/mcp-process.ts` 만. `node-datachannel` 의 하위 경로(시험 파일 포함) |
| `layout` (바뀜) | `setup/mcp-process.ts` 가 있는데 `setup/mcp-process.test.ts` 가 없음 |
| `clock` (바뀜) | 괄호 없는 `new Date`(`+new Date`, `(new Date)`), 빈 괄호 사이에 공백을 둔 것 |
| `permission` (바뀜) | `deployments/`·`scripts/`·`installer/` 의 글 파일에서도 권한을 넓히는 실행 옵션과 permission capability 문자열을 찾는다 |

계약끼리의 맞물림(컴파일)에 더한 것 5곳: 수신함을 비운 수 → `leave` 결과, `leave` 결과 → `leave_room` 결과, 실패한 시도의 피어 이름 → `expireAttempt`, 복제본이 만든 기록 → `packStateFrames`, 스냅샷 → `packStateFrames`.

## 건수

`node --test` 가 센 수는 471 이다(W0-66). 파일별: `boundaries.test.ts` 157, `limits` 70, `signaling-wire` 58, `p2p-wire` 47, `state-records` 30, `identifiers` 29, `server-address` 21, `ice-config` 20, `runtime-ports` 16, `local-files` 13, `index` 6, `link-failure` 4.

| 구분 | 건수 | 내용 |
|---|---|---|
| 시험 도구의 동작 확인 | 2 | 위와 같다 |
| 적합성 시험의 자체 확인 | 14 | 위와 같다 |
| 경계 검사기의 자체 시험 | 147 | 1차의 113 에 34 를 더했다(가짜 위반 24, 그 주변 2, `src` 밖 설정 8) |
| 제품 코드와 실제 소스를 보는 것 | 308 | protocol 의 구현 테스트 298(1차의 282 에 16: `signaling-wire` 7, `p2p-wire` 7, `state-records` 1, `index` 1), `boundaries.test.ts` 의 실제 소스 4·의존성과 SDK 3·와이어 스키마 3 |

## 미실행 항목

| 항목 | 사유 |
|---|---|
| `lc` 가 끝에 닿았을 때 `applyLocal` 이 거절하는지(`V-U3`) | 구현이 없다. 계약과 설계에만 적었다. W4 |
| 진행 중인 시도가 바뀔 때의 mesh 동작, `expireAttempt`, `RELAY_NOT_ALLOWED` 처리(`V-U11`) | 구현이 없다. W3. 실제 라이브러리에서 진행 중인 pc 를 닫고 새 pc 로 받는 것이 안전한지도 보지 않았다(열린 링크의 교체는 A-RTC-3 으로 이미 가정에 있다) |
| `discardAll` 의 동작(`V-U4`), 퇴장 뒤 다른 방에서 앞 방의 사건이 나오지 않는지(`V-U9`, `V-L7`) | 구현이 없다. W5, W6. 가짜 구현으로 컴파일만 봤다(W0-62) |
| signaling-core 가 `encodeServerMessage` 의 실패를 `SERVER_ERROR` 로 바꾸는지(`V-U2`) | 구현이 없다. W1 |
| `src` 밖 폴더의 실제 파일에 대한 권한 옵션 검사, 실제 `setup/mcp-process.ts` | 그 파일들이 아직 없다. 가짜 파일 묶음으로만 봤다 |
| Node 22, Node 24, macOS arm64 밖의 OS | 환경 없음(위 기록과 같다) |
| 변이 점검의 전수 실행 | 표본 52건만 했다 |

## 다음 실행에서 확인할 것

- 내장 모듈 허용 목록이 실제 구현을 막는 곳. 목록 밖 모듈이 꼭 필요한 묶음은 계약 변경 절차로 알린다(예상되는 것: 설치 CLI 의 `readline`).
- W8 이 `setup/mcp-process.ts` 한 파일로 `doctor` 의 프로세스 띄우기를 자연스럽게 쓸 수 있는지. 그 시험이 "등록에서 읽은 명령·인자·환경만 넘긴다"를 실제로 고정하는지(검사기는 파일이 있는지만 본다).
- W3 의 `V-U11` 에서, 바뀐 시도의 기한을 새로 재는 규칙이 같은 상대의 되풀이된 새 `offer` 로 시도를 끝없이 늘리는 경우가 실제로 생기는지. 생기면 상한을 두는 것을 다시 정한다.
- `lc` 가 끝에 닿은 방을 에이전트가 알아볼 수 있는지. 지금은 `INVALID_ARGUMENT` 와 로그뿐이다.
- 검토자의 반례 가운데 이번에도 지적에 없어 그대로 남은 것: 다른 이름으로 받은 stdout(`const out = process.stdout`), 다른 이름으로 받은 전역 타이머(`const later = setTimeout`), 문자열을 이어 붙여 꺼낸 `sendSignal`, 최상위 `const` 의 가변 컨테이너, ICE 객체의 사용자 이름·암호, `signal-gate.ts` 안에서 SDP 자리에 글을 싣는 것, setup 이 권한 설정 파일을 직접 고치는 것(W0-59 의 "지나간 것", W0-65 의 G10~G13).
- 1차부터 그대로인 것: 설계대로 ICE 거절 문구에 `turn:` 을 적으면 `relay` 규칙에 걸린다(W0-42 의 L4, W0-59 의 exp1 18번). W5 가 오류 문구를 쓸 때 부딪힌다.
- `tests/test-history/README.md` 색인에 이 파일의 줄이 없다. 색인 소유 묶음(W9)이 더한다.
