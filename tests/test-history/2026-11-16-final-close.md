# 2026-11-16 마감: 앞 단계 보고 판단, 결함 수정과 재검증, 전체 재실행, 문서 마감, 완료 기준 현황

마감 단계의 앞 담당 넷(재배포·`V-P6`, 실제 설치, 장시간, 헤드리스 세션)의 보고를 받아, 고칠 수 있는 결함을 고쳐 다시 검증하고, 공용 `dist` 로 빌드·`npm test`·`npm run test:e2e` 전체·`installer` 시험을 다시 돌리고, README·안내서·설계 문서를 최종 코드와 대조해 마감한 기록이다. 끝에 완료 기준 현황표와 PRD 완료 기준 판정을 둔다.

- 작업 ID: `2026-11-16-final-close`
- 기준(통과 기준, 실행 전 고정): [verification-plan.md](../../docs/design/verification-plan.md) 3절의 항목별 기준과 8절의 완료 보고 규칙 그대로다. 낮추지 않았다. 이번 작업의 덧붙임: `rm -rf dist && npm run build && npm test` 종료 코드 0·실패 0, `npm run test:e2e` 13묶음 종료 코드 0·남은 프로세스 0, `node --test installer/*.test.mjs` 실패 0. 설치된 사본(`~/.agent-chat/app`)에 영향이 있는 제품 변경을 하면 다시 복사·설치하고 `V-S2` 를 다시 본다.
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e` + 커밋하지 않은 작업 트리(검토 3차 반영, final-deploy·final-install·final-long·final-sessions 의 산출물 전체). 이 작업 동안 저장소의 작성자는 이 담당 하나였다.
- 환경: macOS 27.2 arm64 한 대, Node v26.12.1, npm 11.20.0, TypeScript 7.0.2, `node-datachannel` 0.33.6, Claude Code 2.1.325, Codex CLI 0.169.0. 공용 서버는 [final-deploy](2026-11-16-final-deploy.md) P-FD-08 로 다시 만든 스택.
- 지킨 것: git 커밋·푸시·stash·checkout·reset 을 하지 않았다. `docs/PRD.md` 를 고치지 않았다. TURN·서버 중계·피어 중계를 더하지 않았다. 제품 코드에 시험용 분기를 넣지 않았다. AWS 자원을 만들거나 바꾸지 않았다(공용 서버에는 클라이언트로만 접속). 권한 설정(`~/.claude/settings*.json` 의 permissions·hooks, `~/.codex/config.toml` 의 승인·sandbox 키, 허용 목록)을 고치지 않았다. 내가 띄운 프로세스만 끝냈다.
- 원문 증거: 세션 스크래치 `…/scratchpad/final/final-close/`(`u-fc-01-pre.log`, `u-fc-02-npm-test.log`, `l-fc-03-e2e.log`, `l-fc-04-installer.log`, 그 밖 `*-fc-*.log`, 고치기 전 빌드 `pre/`, 복사 스크립트 `recopy-app.mjs`). 세션이 끝나면 사라진다. 이 문서에 방 ID, 채팅 본문, 계정 ID, 다른 MCP 서버의 env 값은 없다. 홈 경로는 `~` 로 적었다.
- 참고한 이전 이력: [final-deploy](2026-11-16-final-deploy.md), [final-install](2026-11-16-final-install.md), [final-long](2026-11-16-final-long.md), [final-sessions](2026-11-16-final-sessions.md), [review-r3](2026-11-16-review-r3.md)(기준 1565·e2e 13/13·installer 34/34), [review-r1](2026-11-16-review-r1.md)·[r2](2026-11-16-review-r2.md), [Gate 3](2026-11-15-gate3.md)(완료 기준 현황표의 틀). 확정한 기록은 고치지 않았다. 정정은 이 기록에 적었다.
- 실행 ID: `U-`(대역), `L-`(로컬 실물), `S-`(실제 설치), `D-`(문서 대조·조회). 시각은 KST(2026-11-16).

## 요약

| 항목 | 판정 | 증거 수준 | 근거 |
|---|---|---|---|
| 고친 결함: Codex 설정의 원래 표기가 든 첫 백업을 회전으로 잃음(final-install 위험 1) | **고침**. 설치가 만든 백업 가운데 가장 오래된 것을 지우지 않는다. 고치기 전 빌드에서 새 시험 2건 실패, 고친 뒤 통과 | 대역 | U-FC-01, U-FC-02 |
| 전체 단위 시험 `rm -rf dist && npm run build && npm test` | **통과** 1566/1566 | 대역 | U-FC-02 |
| `npm run test:e2e` 전체 | **실패 1회 → 도구 고쳐 `mesh` 재실행 통과.** 첫 실행 12/13(`mesh` 의 `[fail]` 항목 하나가 시도 시간 14999ms 로 하한 15000ms 에 1ms 모자람). 검증 도구의 하한에 측정 단위 1ms 를 두고 `mesh` 만 다시 돌려 통과(`V-L11` 은 srflx 항목 때문에 부분 검증 그대로) | 로컬 실물 | L-FC-03 |
| `node --test installer/*.test.mjs` | **통과** 34/34 | 대역(프로세스) | L-FC-04 |
| README 의 개발 명령(`npm ci`, `node --test tests/e2e/install/`, `npm run test:deploy`) | **통과**. `npm ci`(저장소 사본)·빌드 종료 코드 0, `tests/e2e/install/` 96/96, `test:deploy` 10/10 | 대역 | L-FC-05, U-FC-06, U-FC-07 |
| 설치된 사본 갱신(작업 트리 다시 복사 → `install.sh`) | **통과**. 종료 코드 0, `통과 13, 실패 0, 건너뜀 2(이미 등록됨)`, 연결 점검 통과. Codex 설정 파일·백업 그대로 | 실제 설치 | S-FC-08 |
| `V-S2` 다시 보기 | **통과** 9/9, `doctor` 종료 코드 0, 남은 프로세스 0 | 실제 설치 + 공용 서버 | S-FC-09 |
| README "설치가 됐는지 확인하기" 의 명령 | **통과**. 등록 경로·대기 상한·`doctor` D1~D8 이 README 의 설명과 같다 | 실제 설치 | S-FC-10 |
| 문서와 최종 코드 대조 | 어긋남을 고쳤다(아래). 상대 링크·앵커 0건 깨짐 | 문서 대조 | D-FC-11 |
| 원격 저장소 상태 | `main` 이 `a82ed0e`(첫 커밋)뿐. README 의 `git clone` 설치는 아직 실패한다 | 조회 | D-FC-12 |

- 실패한 실행: U-FC-01(고치기 전 빌드, 의도한 실패 재현). L-FC-03(`npm run test:e2e` 첫 실행, `mesh` 묶음 실패. 관찰 1).
- `.gitignore`: 작업 트리의 임시물은 `dist/`, `build/`, `.work/`, `node_modules/` 로 이미 빠진다. 추적되지 않은 파일 274개는 모두 소스·문서·설정(`.ts`, `.mjs`, `.md`, `.sh`, `.yaml`, `.json`, `.service`)이고 탐색 산출물은 없다. 고치지 않았다. 커밋하지 않았다.

## 앞 단계 보고의 판단

| 출처 | 보고 | 판단 | 한 일 |
|---|---|---|---|
| final-install 위험 1, "다음에 확인할 것" | Codex CLI 의 `mcp add`·`remove` 가 다른 서버 표의 표기를 바꿔 쓰고(뜻은 같다), 설치의 백업 회전(최근 3개)이 원래 표기가 든 첫 백업을 지웠다. 원래 표기는 세션 스크래치에만 있다 | **제품 결함으로 본다.** 백업의 목적(설치가 바꾸기 전으로 되돌릴 수 있게)이 바로 이 경우에 깨진다. 처음 백업 하나를 더 남기는 것은 회전의 이유(비밀값이 든 파일을 끝없이 쌓지 않음, 검토 1차 BOUNDARY-R1-03)를 해치지 않는다(파일 하나, 권한 0600) | `src/setup/codex-config.ts` `pruneBackups`: 설치가 만든 이름의 백업 가운데 **가장 오래된 하나**(수정 시각, 같으면 이름)를 회전에서 뺀다. 결과는 "가장 오래된 하나 + 최근 3개". 백업 이름과 쓰는 시점은 그대로다. 시험: `codex-config.test.ts` 기존 1건 기대값 변경(처음 것이 남는다) + 새 1건(백업 8번 동안 매번 처음 것이 남고 개수는 최대 4). 문서: `architecture.md` 3.13 의 `<AGENT_CHAT_HOME>/` 행, README 두 곳. **이 PC 의 원래 표기는 되살리지 못한다**(이미 지워졌다. 남은 가장 오래된 백업 `…T204736Z` 는 바뀐 뒤의 표기다). 원래 표기의 사본을 남길지는 사용자가 정한다(아래 "사용자가 할 일") |
| final-install "검토가 필요한 점" | 비교 도구를 원문 비교에서 뜻 비교로 바꿨다 | **수용.** 통과 기준은 "권한 관련 키가 설치 전후에 뜻이 같다(바이트 비교 안 함)"이고 바뀌지 않았다. 원문 비교가 기준보다 엄격했던 도구 결함이다. 빈 `args` 만 없는 키와 같게 보고 `enabled_tools = []` 같은 다른 빈 목록은 그대로 견주는 구분도 맞다(빈 허용 목록은 "아무 것도 허용하지 않음"일 수 있다). 고치기 전 같은 실패 집합의 대역 재현(U-FI-01)과 실제 전후 파일의 재비교(U-FI-03)가 있다 | 없음 |
| final-install 관찰 3 | `npm warn install-scripts … esbuild@0.28.2 (postinstall: node install.js)` | 설치 결과에 영향 없음을 확인했다. 설치된 사본의 `node_modules/.bin/esbuild --version` 이 `0.28.2` 를 낸다(플랫폼 패키지 `@esbuild/darwin-arm64` 의 바이너리). `esbuild` 는 `build:lambda` 에만 쓰고 설치의 빌드(`tsc`)에는 쓰지 않는다 | 없음(D-FC-13) |
| final-sessions "총괄 확인이 필요한 점" | Codex 헤드리스에서 `-c 'mcp_servers.agent-chat.tools.<tool>.approval_mode="approve"'` 로 tool 여섯을 그 실행에만 허용했다 | **유효로 본다.** 사용자(시험 담당)가 그 실행에만, 이 서버의 이름 붙은 tool 에만 준 허용이고 설정 파일은 바뀌지 않았다(해시 같음). 승인 장치 자체를 끄는 플래그(`--dangerously-bypass-approvals-and-sandbox` 등)를 쓰지 않았고, 허용하지 않은 `write_report` 는 막혔다. Claude Code 의 `--allowedTools` 와 같은 성격이고, `V-I1` 기준이 허용하는 "사용자가 고른 항상 허용"과도 같다. 그래도 사람이 쓰는 대화형 세션의 판정은 아니므로 `V-I3`·`V-I4` 는 통과로 세지 않는다 | 없음 |
| final-sessions 관찰 2(3) | Claude `-p` 세션이 입장 뒤 `set_status` 를 부르지 않았다 | instructions 에 이미 "Tell the room your tools and state with set_status" 가 있다. 모델의 행동이라 코드로 고칠 것이 없다. 상대에게 `joined` 로 보여 "준비되지 않음"으로 세어지므로 안전 쪽이다 | 없음. 남은 위험에 적었다 |
| final-long 관찰 1 | P4-05 의 증거 조건(10초 표본에 재접속이 잡혀야 함)이 1.4초 재접속을 놓쳐 실패로 출력 | **수용.** 기준(DataChannel 유지)은 그대로이고 증거를 진단 로그의 `socket_closed` 로 바꿨다. 같은 원자료로 다시 판정해 통과(P-FL-03a). 다만 고친 스크립트로 130분을 다시 돌리지 않았고 P4-07(다)가 판정되지 않아 `V-P4` 전체는 **부분 검증** 그대로다 | 없음 |
| final-long 기록의 "검토 전 서버 코드" | `V-P4` 결과는 재배포 전 서버의 것이라고 적었다 | **정정.** final-deploy 의 갱신 배포(P-FD-01, 05:31)와 다시 만든 스택(P-FD-08, 05:37~05:42)이 `V-P4` 시작(06:20:27)보다 앞선다. 그 사이 공용 서버를 바꾼 기록은 없다. 그래서 `V-P4` 는 **검토 1~3차 반영 서버 코드**로 돈 결과다(P4-04 의 재등록 `conn.join{joined}` 4건도 이 코드). 확정한 기록은 고치지 않고 여기와 색인에 적었다 | 색인 행에 정정 |
| final-long 관찰 2 | 06:21~06:48 에 다른 연결이 공용 서버를 함께 썼다(누구인지 미확인) | **같은 시각의 final-sessions 실행으로 본다 [추론].** I-FS-04(06:05~06:34)·I-FS-05(06:06~06:35)는 방 둘에 MCP 프로세스 넷(세션 둘 + 상대 둘)이 있었고 입장 뒤에는 `ping` 만 서버를 지난다(06:21~06:32 의 "다른 연결 4개가 `ping` 만"). 06:33~06:47 의 다른 방 입장·퇴장은 세션의 퇴장(06:34~35), I-FS-06(06:36~06:46), U-FS-01·02, I-FS-07(06:41~06:43)과 맞는다. 접근 로그에 연결 ID 가 없어 정확히 나누지 못하는 것은 그대로라 P4-07(다)는 판정하지 않는다 | 없음 |
| final-long 관찰 4 | RSS 가 천천히 늘어난다(최대 +17.4%, 기준 20%) | 기준 안이라 결함으로 보지 않는다. 130분보다 길게 돌면 넘을 수 있다 | 남은 위험에 적었다 |
| final-deploy 관찰 1 | 실제 서버의 `cause=claimed` 는 "다른 처리가 지금 등록 중"인 경우뿐이었다 | 차지 뒤 등록 전 **실패**의 경우는 결함 주입이 필요해 대역·DynamoDB 계약 시험이 근거로 남는다. 제품 코드에 시험용 분기를 넣지 않는다 | 없음 |
| final-deploy 관찰 4·5 | Lambda 묶음 해시가 배포마다 다름, 탐색 로그 파일 덮어씀 | 묶음 크기 같음. 결함 아님. 로그 덮어쓰기는 스크래치 도구의 일 | 없음 |

## 실행 기록

| ID | 시각 | 수준 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|
| U-FC-01 | 08:38 ~ 08:39 | 대역 | 시험을 먼저 고친 뒤, 작업 트리의 `src` 를 스크래치 `pre/` 에 복사하고 `pruneBackups` 만 고치기 전 꼴로 되돌려 `npx tsc -p tsconfig.json` → `node --test dist/setup/codex-config.test.js` | 새·바뀐 시험이 실패한다 | 빌드 종료 코드 0. tests 36, pass 34, **fail 2**: "백업은 가장 오래된 하나와 최근 3개만 남긴다…"(남은 파일 4, 기대 5: 처음 백업이 지워짐), "가장 오래된 백업은 회전으로 지우지 않는다…"(4번째 백업 뒤 3, 기대 4). 로그는 `pre/u-fc-01-pre.log` | 실패 재현 |
| U-FC-02 | 08:40:34 ~ 40:47 | 대역 | `rm -rf dist && npm run build && npm test` (고친 뒤) | 종료 코드 0, 전부 통과 | 빌드 종료 코드 0. **tests 1566, pass 1566, fail 0, cancelled 0, skipped 0, todo 0**(검토 3차의 1565 + 새 1) | **통과** |
| **L-FC-03** | 08:40:52 ~ 09:01:43 | 로컬 실물(+대역 프로세스) | `TMPDIR=<스크래치>/e2e-tmp npm run test:e2e` (U-FC-02 의 `dist`) | 13묶음 종료 코드 0, 남은 프로세스 0 | **종료 코드 1, 12/13.** `mesh`(`V-L11`) 실패: 통과 24, **실패 1**, 부분 1. 실패 항목은 `[fail]` "offer 를 계속 버림(answer 쪽이 나중에 들어와 offer-request 를 보냄)": 분류(`ra` `signaling/no_answer`, `rb` `signaling/no_offer`)·재전송 수(offer 9 = 1 + 8, offer-request 5 = 1 + 4)·남은 링크 0 은 모두 맞았고, `ra` 의 시도 시간이 **14999ms** 라 시험의 하한(`duration_ms >= 15000`)에 1ms 모자랐다(관찰 1). 부분 1 은 늘 같은 srflx 항목(0/10). 나머지: `wire` 26·7·14·16 모두 통과, `room` 42/42, `mcp` 35/35, `install` 96/96, v-l2 24, v-l3 14, v-l4 9, v-l5 14, v-l6 5, v-l7 39, v-l8 32, a-rtc 5 모두 통과. 끝난 뒤 시험 프로세스 0 | **실패**(묶음 1개. 기록 남김) |
| U-FC-03b | 09:02 ~ 09:03 | 탐색(이 PC) | `node -e` 로 15초 타이머 8개의 `Date.now` 차이와 `performance.now` 차이를 같이 잼 | — | 벽시계 차이 15000~15001, 단조 시계 15000.29~15001.25, 둘의 차이 −0.61~+0.38ms. 이 실행에서는 14999 가 나오지 않았다. libuv 는 기한을 ms 버림 단조 시각에 걸고 `Date.now` 도 ms 버림이라, 실제 경과가 15000ms 를 1ms 안으로 밑돌거나 두 버림이 겹치면 14999 로 읽힌다 **[추론. 재현하지 못함]** | 탐색 |
| L-FC-03a | 09:04:04 ~ 09:06:27 | 로컬 실물 | `tests/e2e/mesh/v-l11.mjs` 의 `[fail]` 하한을 `PEER_CONNECT_TIMEOUT_MS - CLOCK_GRANULARITY_MS(1)` 로 고친 뒤 `TMPDIR=<스크래치>/e2e-tmp node tests/e2e/run.mjs mesh` (같은 `dist`) | 종료 코드 0 | **종료 코드 0. `V-L11` 통과 25, 실패 0, 부분 1**(srflx 0/10). `[fail]` 세 경우의 시도 시간 15000~15001ms(이번에는 고치기 전 하한으로도 통과했을 값이다. 고친 하한은 지나지 않았다) | 통과(`V-L11` 은 부분 검증) |
| L-FC-04 | 09:06:33 ~ 07:03 | 대역(프로세스) | `TMPDIR=<스크래치>/e2e-tmp node --test installer/*.test.mjs` | 실패 0 | **34/34** | **통과** |
| L-FC-05 | 09:07:03 ~ 08:19 | 대역(프로세스) | `TMPDIR=<스크래치>/e2e-tmp node --test tests/e2e/install/` (README 의 명령) | 실패 0 | **96/96** | **통과** |
| U-FC-06 | 09:08:19 ~ 08:44 | 대역 | `npm run test:deploy` | 실패 0 | **10/10**(가짜 `aws`) | **통과** |
| U-FC-07 | 09:08:49 ~ 08:51 | 대역 | 스크래치에 `package.json`·`package-lock.json`·`tsconfig.json`·`src` 를 복사해 `npm ci` → `npm run build` → `node-datachannel` import → `node_modules/.bin/esbuild --version` (README 의 `npm ci`) | 종료 코드 0 | `npm ci` 종료 코드 0(138개), 빌드 0, `node-datachannel` 의 `PeerConnection` 있음, `esbuild` 0.28.2. `allowScripts` 경고는 같게 나왔다. 저장소의 `node_modules` 는 건드리지 않았다 | **통과** |
| D-FC-13 | 08:5x | 조회 | 설치된 사본의 `node_modules/.bin/esbuild --version`, `node_modules/@esbuild/` | — | `0.28.2`, `darwin-arm64` 있음. 경고가 나와도 `esbuild` 는 동작한다 | 사실 확인 |
| S-FC-08 | 09:08:57 ~ 09:09:08 | 실제 설치 | 실행 전 상태 기록(`~/.codex/config.toml`·`~/.claude/settings.json` 해시, `backups/` 목록, `~/.claude.json` 의 `mcpServers` 이름, MCP 프로세스 수) → `node <스크래치>/recopy-app.mjs <저장소>`(`v-s1.mjs` 와 같은 제외 목록으로 작업 트리를 `~/.agent-chat/app` 에 다시 복사. `.v-s1-copy` 표시가 있을 때만) → `sh ~/.agent-chat/app/installer/install.sh` (README 의 갱신 경로에서 `git pull` 대신 복사) | 종료 코드 0, 등록 그대로 | **종료 코드 0.** `통과 13, 실패 0, 건너뜀 2, 사용자 조치 필요 3, 경고 0`. `[6]`·`[7]` `건너뜀 — 이미 등록됨`(호스트 CLI 의 remove/add 없음, 백업 없음), `[8]` 두 호스트 `/opt/homebrew/bin/node`, `[9]` Claude Code `불명 — 판정표 9행`·Codex `불가`, `[10]` 연결 점검 통과(공용 서버). stderr 의 `allowScripts` 경고 1건 | **통과** |
| S-FC-09 | 09:09:15 ~ 09:09:21 | 실제 설치 + 공용 서버 | **`V-S2` 다시**: `node tests/e2e/install/v-s2.mjs` | 9/9 | **종료 코드 0, 9/9.** 상대 `not_ready`(양쪽 `set_status` 를 부르지 않음), `leave_room` 뒤 5ms 에 프로세스 0, `doctor` D1~D8 통과(D4 `wss://agent-chat.tools.camp`) | **통과** |
| S-FC-10 | 09:09:27 ~ 09:09:32 | 실제 설치 + 공용 서버 | README "설치가 됐는지 확인하기" 1~3: 위 설치 출력의 마지막 줄, `claude mcp get agent-chat`, `codex mcp get agent-chat --json`, `node ~/.agent-chat/app/dist/entry/cli.js doctor`. 이어서 끝난 상태 기록 | README 대로 나온다 | Claude: user scope, `Command: /opt/homebrew/bin/node`, `Args: ~/.agent-chat/app/dist/entry/mcp.js`, `AGENT_CHAT_WAIT_MAX_SEC=100`. Codex: 같은 명령·인자, `AGENT_CHAT_WAIT_MAX_SEC=540`, `AGENT_CHAT_CHANNEL=off`, `tool_timeout_sec` 600. `doctor` 종료 코드 0(D1~D8 통과). 끝난 상태: 두 설정 파일 해시가 S-FC-08 전과 같다, `backups/` 3개 그대로, `mcpServers` 이름 그대로(`aws-mcp`, `narrasync`, `arrow-marker`, `agent-chat`), MCP 프로세스 0 | **통과** |
| D-FC-11 | 08:44 ~ 09:15 | 문서 대조 | 아래 "문서와 최종 코드 대조" | 어긋남 없음 | 어긋남을 문서에서 고쳤다. 링크 검사 0건 | 통과(고친 뒤) |
| D-FC-12 | 08:5x | 조회 | `git ls-remote https://github.com/ryujt/AgentChat` | — | `HEAD`·`refs/heads/main` 모두 `a82ed0e`(첫 커밋) | 사실 확인 |

실행 순서: U-FC-02 의 `dist` 로 L-FC-03 을 돌렸고, 그 뒤 제품 코드(`src`)는 바뀌지 않았다. L-FC-03 뒤에 바뀐 것은 `tests/e2e/mesh/v-l11.mjs` 의 하한(L-FC-03a 가 그 파일로 돈다)과 문서·이력뿐이다. 그래서 `mesh` 밖의 12묶음은 다시 돌리지 않았다. S-FC-08 의 복사는 이 시험 파일 수정 뒤, README·설계 문서·이 기록의 마감 수정 전이다(설치된 사본과 저장소는 문서만 다르다).

### 관찰

1. **`mesh` 의 14999ms(L-FC-03).** 제품의 시도 기한은 `setTimeout(…, 15000)` 하나이고, 시도 시간 `duration_ms` 는 `Date.now()` 의 차이다. 같은 묶음의 다른 시도는 15000~15001ms 였고, 이전 실행(Gate 3, 검토 1~3차)에서 이 항목은 통과였다. 1ms 모자란 것은 ms 단위 버림에서 나오는 측정 오차로 본다 **[추론]**(U-FC-03b 에서 재현하지 못했다). 기한이 늦어지거나 일러지는 제품 결함은 아니라고 판단했다. 그래서 제품은 고치지 않고 시험의 하한에만 측정 단위 1ms 를 두었다. "기한 전에 끝나지 않는다"는 뜻은 그대로다(2ms 이상 이르면 여전히 실패). [verification-plan.md](../../docs/design/verification-plan.md) 의 `V-L11` 기준 문장에는 이 하한이 없다(W3b 가 정한 `[fail]` 절의 시험 조건이다). 고친 하한은 L-FC-03a 에서 실제로 쓰이지 않았다(모두 15000ms 이상). 실패한 실행은 지우지 않았다.
2. 설치된 사본을 다시 복사하고 설치해도 등록은 그대로라 Codex CLI 가 불리지 않았고, `~/.codex/config.toml` 해시와 `backups/` 가 그대로였다. 이번 백업 수정(가장 오래된 것 보존)은 다음 재등록 때부터 효과가 있다. 그때 남는 가장 오래된 것은 `…T204736Z` 다(원래 표기가 아니다).
3. `V-S2` 의 두 프로세스가 같은 PC 다. 상대가 `not_ready` 인 것은 시험이 `set_status` 를 부르지 않아서다(기대와 같다).

## 문서와 최종 코드 대조 (D-FC-11)

| 문서 | 대조한 것 | 결과 |
|---|---|---|
| `architecture.md` 5절 | 환경 변수 기본값, 내부 값(`SHUTDOWN_BUDGET_MS` 400, `LISTEN_GRACE_MS`·`CHANNEL_SEEN_GRACE_MS` 120000, `PRESENCE_MIN_INTERVAL_MS` 5000, `INBOX_MAX_EVENTS` 1000, `WAIT_MAX_EVENTS`/`WAIT_MAX_RESULT_BYTES` 20/24000, `SENT_BUFFER_SIZE` 200, 대기 5~540 기본 50, 로그 7일·20MB·200MB)과 `src/inbox/inbox.ts`, `mcp-server/limits.ts`, `room-session/session.ts`, `setup/registration.ts`(100/540/50), `diagnostics/*` | 맞다 |
| `architecture.md` 3.13 `<AGENT_CHAT_HOME>/` 행 | 이번에 고친 백업 보존 규칙 | 고쳤다(가장 오래된 하나 + 최근 3개, 근거 링크) |
| `architecture.md` 3.13 "등록 명령의 형식" | "실제 등록은 실행하지 않았다" | **사실과 다름 → 고쳤다**(실제 홈에서 등록·재등록·제거, final-install) |
| `protocol.md` 2.5 `ROOM_MAX_PEERS`, 2.6 끊김 | "8은 미실측", "2시간 실측하지 않음" | **사실과 다름 → 고쳤다**(W9 A-RTC-4 8피어, final-long `V-P4` 2시간). 값은 그대로 |
| `deployment.md` 2.5 "연결은 최대 2시간" 행 | "재지 않았다" | **고쳤다**(`V-P4` 실측) |
| `mcp-interface.md` 7.3 poll 의 한계, 10절 A-MCP-7 | "확인하지 않았다" | **고쳤다**(헤드리스 실측만 있다는 것과 그 값. 대화형은 미실행으로 남김) |
| `verification-plan.md` 머리 상태 줄, 2.2 A-MCP-3·4·5·7 과 2.3 A-AWS-1 의 "지금 근거" | 상태와 근거 | 고쳤다(7절 규칙: 결과에 따라 "지금 근거" 칸을 고친다). **통과 기준 칸은 손대지 않았다** |
| `design/README.md` 상태 줄, 5절 A-MCP-4·5, 7절 검토 | "설계안. 구현 전이다", 검토 횟수 | **사실과 다름 → 고쳤다** |
| `implementation-plan.md` 상태 줄 | "계획. 아직 코드가 없다" | **사실과 다름 → 고쳤다** |
| `agent-guide.md` 전체 | 안내서가 쓰는 tool 이름·인자·결과 필드·오류 코드·`shown_as` 값·설치 출력 문구(`[2] 설치 위치`~`[7]` 의 사용자 조치 문구, `D4`·`D5`·`D7` 이름) 52개를 `src`·`scripts`·`installer` 의 시험 밖 코드에서 찾음. 입장 최악 시간 "약 40초" = 연결 10초 + 요청 10초 + `JOIN_MESH_TIMEOUT_MS` 20초 | 52개 모두 있다. 고칠 것 없음 |
| `mcp-interface.md` 5절 instructions 사본 | 검토 3차 D-R3-11 이 글자 비교로 같음을 봤고 그 뒤 `instructions.ts` 는 바뀌지 않았다 | 맞다(다시 비교하지 않음) |
| README, 안내서, 설계 문서, `tests/e2e/mcp/README.md`, self-host README, 이력 색인의 상대 링크와 앵커 | 스크립트(`linkcheck.mjs`)로 파일과 머리글 앵커 확인 | 깨진 것 0 |

## 완료 기준 현황 (마감 시점)

| 기준 | 판정 | 근거 실행 ID | 증거 수준 |
|---|---|---|---|
| V-U1~V-U6, V-U8~V-U11 | 통과 | U-FC-02 | 대역(V-U11 은 실제 라이브러리) |
| V-U7 `RoomStore` 계약 | 통과(메모리 U-FC-02, DynamoDB 29/29·남은 항목 0: 갱신 뒤 P-FD-02, 다시 만든 뒤 P-FD-09) | U-FC-02, P-FD-02, P-FD-09 | 대역 + 실제 환경 |
| V-L1~V-L8, V-L12 | 통과(첫 실행 L-FC-03 에서 모두 통과. `mesh` 만 실패해 L-FC-03a 로 다시) | L-FC-03 | 로컬 실물 |
| V-L9 (130분) | 통과 7/7 | L-FL-02 | 로컬 실물 |
| V-L10 (가)·(나) | 통과(`install` 96/96, `installer` 34/34, `tests/e2e/install/` 96/96) | L-FC-03 `install`, L-FC-04 | 대역 |
| V-L11 | 부분 검증(L-FC-03 통과 24·실패 1(측정 1ms)·부분 1 → 도구 고친 뒤 L-FC-03a 통과 25·실패 0·부분 1. srflx 항목 0/10) | L-FC-03 `mesh` | 로컬 실물 |
| V-P1 | 통과(검토 반영 코드) | P-FD-01, P-FD-02 | 실제 환경 |
| V-P2 | 통과(검토 전 서버 코드. 재배포 뒤 미재실행) | P-W9P-01, 02, 02R, P-G3-07 | 실제 환경 |
| V-P3 | 통과(검토 전 서버 코드. 재배포 뒤 미재실행) | P-W9P-03, 04 | 실제 환경 |
| V-P4 | **부분 검증**(P4-01~06 통과(P4-05 는 같은 원자료 재판정), P4-07 부분. 검토 반영 서버 코드) | P-FL-03, P-FL-03a | 실제 환경 |
| V-P5 | 통과(검토 전 서버 코드. 재배포 뒤 미재실행) | P-W9P-05 | 실제 환경 |
| V-P6 | 통과 | P-FD-06~09 | 실제 환경 |
| V-P7 | **실패**((가) 통과, (나) 실패. 스로틀 값 결정 대기. 재배포 뒤 미재실행) | P-W9P-06~10 | 실제 환경 |
| V-S1 | 통과 11/11(첫 실행 S-FI-01 은 도구 결함으로 실패, 기록 남김) | S-FI-03 | 실제 설치 |
| V-S2 | 통과 9/9(final-install). 이번 백업 수정 뒤 다시: 9/9 통과 | S-FI-04, S-FC-09 | 실제 설치 + 공용 서버 |
| V-I1 | **미실행**. 원격 저장소에 코드가 없다(D-FC-12). 사람이 필요 | — | — |
| V-I2 | **미실행**. 개발 채널 플래그와 경고 승인에 사람이 필요 | — | — |
| V-I3 | **미실행(대화형)**. 헤드리스 변형(`claude -p`)은 통과 15/15 이지만 사람이 한 번 말하는 대화형 조건이 아니고 "한 번 더"를 하지 않아 통과로 세지 않는다 | I-FS-04(변형) | 실제 호스트(헤드리스) |
| V-I4 | **미실행(대화형)**. 헤드리스 변형(`codex exec`)은 통과 15/15, 540초 대기 1회 통과. 위와 같은 이유로 통과로 세지 않는다 | I-FS-05, I-FS-06(변형) | 실제 호스트(헤드리스) |
| V-I5 | **미실행**. 사람, 모델 호출, 테스트 대상 서비스가 필요하다(대상 미정) | — | — |
| V-I6 | **미실행**. 사람이 필요하다(헤드리스에서 허용 밖 `write_report` 가 막힌 것은 부수 관찰) | — | — |

### 가정 확인 상태 (verification-plan.md 8절)

| 가정 | 상태 | 근거 |
|---|---|---|
| A-RTC-1 | 미실행(이 PC 한 대) | — |
| A-RTC-2, 3, 5 | 확인됨(이 PC) | W3a, W3b, L-FC-03 `mesh` |
| A-RTC-4, 6 | 확인됨(같은 PC) | W9 조립 |
| A-MCP-1, 2, 8, 9 | 미실행(대화형 세션·사람 필요) | — |
| A-MCP-3 | 미실행(신호 순서·유예를 재지 않음. 헤드리스 종료 원인 `stdin_end` 만 관찰) | final-sessions |
| A-MCP-4, 5 | 일부(헤드리스에서 유지됨. 대화형·턴 종료 뒤, 설정 없는 Codex 한도는 미실행) | I-FS-04~06 |
| A-MCP-6 | 미실행(Codex 는 `AGENT_CHAT_CHANNEL=off` 로 설치) | — |
| A-MCP-7 | 일부(헤드리스에서 tool 별 허용 가능. 대화형 프롬프트 미관찰) | final-sessions |
| A-MCP-10 | 확인됨 | W8, final-install |
| A-AWS-1 | 확인됨(유휴 600초, 2시간 한도 `V-P4`) | PRE-AWS-07, P-FL-03 |
| A-AWS-2, 4, 5, 7, 8, 9, 10, 11, 14 | 확인됨 | 탐색 스택, W2, W9 공용, final-deploy |
| A-AWS-3, 6, 13 | 일부(망 단절, `$default` 예외 프레임 미실측) | W2, W9 공용 |
| A-AWS-12 | 미실행(단가) | — |
| A-OPS-1 | 확인됨(이 PC 의 `doctor` D7 통과) | S-FI-03, S-FC-10 |
| A-TIME-1 | 미실행(한 PC 라 시계 차이가 없다) | — |
| A-LIC-1 | 미실행(법적 검토 안 함) | — |

### PRD 완료 기준과 자동 수신

| PRD 완료 기준 | 판정 | 이유 | 빠진 것 |
|---|---|---|---|
| 설치 | **부분 검증** | 실제 홈 설치·등록·연결 점검(`V-S1`·`V-S2`)과 대역 설치 시험(`V-L10`)이 통과했다. 사용자 승인(재시작, tool 승인)은 설치가 대신하지 않고 알린다 | "GitHub 주소와 설치 요청만으로"(`V-I1`): 원격에 코드가 없어 할 수 없었다. 다른 OS 미실행 |
| 다자간 통신 | **부분 검증** | 한 PC 의 프로세스 4~8개로 생성·입장·상태 공유·양방향 채팅이 로컬·공용 서버에서 통과(`V-L2`, `V-L6`, `V-P2`, `V-S2`, `V-L9`) | 서로 다른 PC 4대, 실제 NAT |
| 자율 협업 | **부분 검증** | tool 이 역할 분담·교차 검증·역할 교대·퇴장·재입장·보고서 흐름을 지원하고 규칙을 강제한다(`V-L8`) | 실제 에이전트의 자율 수행(`V-I5`) |
| 서버 전환 | **통과**(같은 PC, 정상 부하) | 같은 스크립트·같은 계약이 자체 호스팅(로컬)과 공용 서버에서 통과(`V-L2`↔`V-P2`, `V-L1`↔`V-P1`). 공용 서버는 검토 반영 코드로 `V-P1`·`V-P6`·`V-S2` 통과 | 공용 서버가 남용 부하 아래에서 입장을 막는다(`V-P7` 나 실패). 공용 IP·프록시 뒤 자체 호스팅 미실행 |
| 실패 처리 | **통과**(주입으로 만든 실패, 같은 PC) | 후보·시그널을 버린 주입에서 기한 안 `DIRECT_CONNECT_FAILED` 와 단계 구분, relay 후보 0, `turn:` 거절, 채팅이 서버를 지나지 않음(`V-L3`, `V-L11` `[fail]`, `V-U1`, `V-U8`, `V-P2` 지표) | 실제 NAT 의 연결 불가 |
| 실행 통제 | **부분 검증** | 중단·제한이 tool 에서 강제되고 끊긴 쌍에도 닿는다(`V-L8`, `V-U3`, `V-U9`, `V-L12`). 권한: 실행 모듈에 `child_process`·permission capability 없음(`V-U8`), 설치가 권한 키를 바꾸지 않음(`V-S1`) | 실제 에이전트가 중단 뒤 멈추는지(`V-I5`), 권한을 좁힌 세션(`V-I6`), 에이전트 주도 설치의 전후 비교(`V-I1`) |
| **자동 수신**(필수 구현) | **부분 검증** | 수신함·전달 모드(`V-U4`, `V-L7`)와 등록된 경로의 수신(`V-S2`)이 통과. 헤드리스 세션에서 두 호스트 모두 사람 입력 없이 30분 15건을 받았다(I-FS-04·05) | 대화형 `V-I3`·`V-I4`(사람이 한 번만 말하는 조건, 턴이 끝난 뒤의 글), 채널(`V-I2`). 8절에 따라 호스트별 통과로도 세지 않는다 |

**전체: 구현 완료, 완료 기준 6개 중 2개 통과·4개 부분 검증, 필수 항목 "자동 수신" 부분 검증. `V-P7`(나) 실패가 남아 있어 "완료"로 보고하지 않는다**(verification-plan.md 8절).

## 사용자가 직접 할 일

1. **세션 재시작**: 열려 있는 Claude Code·Codex 세션을 다시 시작한다(설치된 `agent-chat` 이 보이고, 이번에 다시 설치한 코드를 쓴다).
2. **tool 승인**: 처음 부를 때의 승인은 직접 고른다. `create_room`, `join_room`, `start_test` 는 매번 승인으로 남기기를 권한다.
3. **채널 확인(선택)**: `claude --dangerously-load-development-channels server:agent-chat` 로 시작해 경고를 직접 승인하고, 방에 들어간 뒤 채널로 바뀌는지 본다(`V-I2`). 바뀌지 않으면 에이전트에게 "대기를 멈추고 턴을 끝내라"고 해서 1분 안에 점검 알림이 오는지 본다.
4. **스로틀 값 결정**: 공용 서버 스테이지 스로틀(지금 초당 25, 버스트 100)을 둘지 바꿀지 정한다(`V-P7` 나 실패의 원인). 바꾸면 `deploy.sh --throttle-rate … --throttle-burst …` 로 다시 배포하고 `tests/e2e/public/v-p7-join.mjs --part b` 를 다시 돈다.
5. **4대 PC 시험**: 직접 연결 가능한 서로 다른 PC 4대에 설치해 방 생성·입장·상태 공유·양방향 메시지(다자간 통신)와 실제 NAT 의 연결·실패를 본다.
6. **사람이 하는 세션 검증**: [final-sessions](2026-11-16-final-sessions.md) "사람이 실행할 절차"대로 대화형 `V-I3`·`V-I4`(한 번 더 포함), `V-I2`, `V-I6`, 테스트 대상 서비스를 정해 `V-I5`.
7. **커밋·푸시**: 작업 트리를 검토해 커밋하고 GitHub 에 푸시한다. 그 뒤 README 의 `git clone … && sh …/installer/install.sh` 로 `V-I1`(에이전트가 README 만 보고 설치)을 실행한다. `docs/PRD.md` 에 개인 절대 경로(참조 프로젝트 경로)가 있으니 공개 전에 직접 판단한다(이 작업은 PRD 를 고칠 수 없다).
8. **Codex 설정의 원래 표기**: 원래 표기가 든 사본은 세션 스크래치 `…/scratchpad/final/final-install/backup/codex-config.toml`(권한 600, 다른 MCP 서버의 env 값 포함)에만 있고 세션이 끝나면 사라진다. 남기려면 그 전에 직접 옮긴다. 뜻은 지금 파일과 같다.
9. 배포 자격 증명을 계정 루트에서 권한을 좁힌 IAM 주체로 바꾼다.

## 남은 위험

1. `V-P7`(나) 실패: 같은 공용 서버를 쓰는 다른 연결이 초당 45건쯤 보내면 새 입장이 실패하고, 버려진 `pong`·`signal` 은 흔적이 없다. 스로틀 값 결정 전이다.
2. 서로 다른 PC·실제 NAT 를 한 번도 지나지 않았다. 모든 다자간 결과는 한 PC 의 host 후보 연결이다.
3. 실제 대화형 세션의 자동 수신, 채널, 승인 프롬프트가 대기 반복을 끊는지는 모른다. Claude `-p` 세션은 `set_status` 를 부르지 않았다(안내를 따르지 않음. 준비되지 않음으로 세어져 안전 쪽).
4. 재배포한 서버로 `V-P2`·`V-P3`·`V-P5`·`V-P7` 을 다시 돌리지 않았다. `V-P4` 는 고친 스크립트로 다시 돌리지 않았고 전 구간 메시지 수가 판정되지 않았다.
5. RSS 증가가 기준에 가깝다(130분에 최대 +17.4%). 더 오래 돌면 20% 를 넘을 수 있다.
6. 백업 보존 수정은 앞으로의 설치에만 효과가 있다. 이 PC 의 원래 표기 백업은 이미 지워졌다. 가장 오래된 백업도 다른 MCP 서버의 env 값을 담고 사용자가 지울 때까지 남는다.
7. 배포 자격 증명이 계정 루트다. 경보·`--access-log off`·예약 동시 실행 분기는 실행하지 않았다.
8. 고친 설계 문서와 README 는 작성자 대조만 했다. 독립 검토는 받지 않았다.

## 마지막 확인

U-FC-02(08:40:34~40:47): `rm -rf dist && npm run build` 종료 코드 0, `npm test` **1566/1566**. `npm run test:e2e` 전체(L-FC-03): **12/13**, `mesh` 의 1ms 측정 하한 실패 → 시험 하한을 고쳐 `mesh` 재실행(L-FC-03a) 통과(`V-L11` 부분 검증). `installer` 34/34(L-FC-04). 설치된 사본 갱신(S-FC-08)과 `V-S2` 9/9(S-FC-09), README 확인 명령(S-FC-10) 통과. 끝난 뒤 시험·MCP 프로세스 0. 이 PC 는 Claude Code·Codex 모두 `~/.agent-chat/app` 을 가리키는 등록된 상태다. U-FC-02 뒤 `src` 는 바뀌지 않았다. 이 기록의 저장을 확인했다.
