# 2026-11-16 마감 실제 설치: 이 PC 의 실제 홈에 설치(`V-S1`)와 공용 서버를 거친 통신(`V-S2`)

사용자 지시("직접 설치하고 통신까지 모두 테스트 해줘")에 따라 이 PC 의 **실제 홈**에 Agent Chat 을 설치하고, 설치가 넣은 등록 그대로 공용 서버(`wss://agent-chat.tools.camp`, [final-deploy](2026-11-16-final-deploy.md) 에서 다시 만든 스택)를 거쳐 통신한 기록이다([검증 계획](../../docs/design/verification-plan.md) 3.4).

- 작업 ID: `2026-11-16-final-install`
- 기준(통과 기준, 실행 전 고정. verification-plan.md 3.4):
  - `V-S1`: 작업 트리를 `~/.agent-chat/app` 에 복사(`.git`, `node_modules`, `dist`, `build`, `.work` 제외)하고 `tests/e2e/install/v-s1.mjs --yes` 한 번으로 사본 → `sh installer/install.sh` → 사본 → 비교. 종료 코드 0. `claude mcp get agent-chat`·`codex mcp get agent-chat` 의 명령 경로가 이 설치. [권한 관련 키의 고정 목록](../../docs/design/architecture.md#313-setup)이 전후에 뜻이 같다(바이트 비교 안 함). Channels 보고에 판정표 행 번호. 다시 실행해도 같은 결과. `--uninstall` 뒤 등록 없음·목록이 설치 전과 뜻이 같음. 다시 설치해 등록된 채로 끝낸다.
  - `V-S2`: 등록된 명령·환경 그대로 MCP 프로세스 2개를 SDK stdio 클라이언트로 띄워(`server` 생략 = 공용 서버) `create_room` → `join_room` → 양방향 `send_message` `delivered` → `wait_for_messages` 수신 → `get_status` 상대가 `not_ready`/`ready` → `leave_room`, 남은 프로세스 0. `agent-chat doctor` 종료 코드 0.
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e` + 커밋하지 않은 작업 트리(검토 3차 반영 뒤). 공용 서버는 final-deploy 의 P-FD-08 로 다시 만든 스택.
- 환경: macOS 27.2 arm64 한 대, Node v26.12.1(`PATH` 의 `/opt/homebrew/bin/node` → `/opt/homebrew/Cellar/node/26.12.1_1/bin/node`), npm 11.20.0, Claude Code 2.1.325, Codex CLI 0.169.0. 이 Claude Code 세션이 떠 있는 상태에서 실행했다.
- 바꾼 사용자 설정: 승인 범위 셋뿐이다. `~/.agent-chat/`(새로 생김), `~/.claude.json` 의 `mcpServers["agent-chat"]`, `~/.codex/config.toml` 의 `[mcp_servers.agent-chat]`(다만 Codex CLI 자신이 같은 파일의 다른 서버 표 **표기**를 바꿔 썼다. 관찰 1). 권한·hook·허용 목록과 다른 MCP 등록은 고치지 않았다.
- 원문 증거: 명령 출력은 세션 스크래치 `…/scratchpad/final/final-install/` 에 있다(`s1-run1.log`, `s1-run2.log`, `s1-run2-pre-uninstall.log`, `s2-run1.log`, `u-*.log`). 실행 전 `~/.codex/config.toml` 사본(`backup/codex-config.toml`, 권한 600)을 남겼다(관찰 1 의 원래 표기가 남은 유일한 사본). 세션이 끝나면 사라진다. 이 문서에 다른 MCP 서버의 환경 변수 값은 없다. 홈 경로는 `~` 로 적었다.
- 실행 ID: 대역 `U-FI-NN`, 실제 설치 `S-FI-NN`. 시각은 KST(2026-11-16).

## 요약

| 완료 기준 | 판정 | 증거 수준 | 근거 |
|---|---|---|---|
| `V-S1` 1차(고치기 전) | **실패** 6/11. S1-03·06·08·10(Codex 설정의 다른 서버 표 키 5개가 "다르다"), S1-05(다시 실행 뒤 Codex 등록 조회 결과가 "다르다") | 실제 설치 | S-FI-01 |
| 1차 실패의 원인 | 설치·제품 결함이 아니라 **검증 도구(`settings-snapshot.mjs`, `v-s1.mjs`)의 결함**. Codex 0.169.0 이 (가) 다른 서버 표의 표기를 바꿔 쓰고 (나) `mcp get --json` 의 env 키 순서를 부를 때마다 바꾼다. Codex 가 읽는 값은 전후가 같았다 | 실제 설치 + 대역 재현 | S-FI-01a, U-FI-01 |
| 고친 뒤 단위·설치 시험 | 통과. `npm test` 1565/1565, `installer` 34/34, `test:e2e install` 96/96 | 대역 | U-FI-02 |
| 고친 비교 도구로 1차의 실제 전후 파일 비교 | 같다(11개 대상) | 실제 파일 | U-FI-03 |
| **`V-S1`**(작업 트리 다시 복사, 처음부터) | **통과** 11/11 | 실제 설치 | S-FI-02, S-FI-03 |
| **`V-S2`**(공용 서버) | **통과** 9/9. `doctor` 종료 코드 0, 남은 프로세스 0 | 실제 설치 + 공용 서버 | S-FI-04 |
| 끝난 상태 | 등록된 채. Claude Code·Codex 모두 이 설치를 가리킨다. 다른 MCP 등록 그대로 | 실제 설치 | S-FI-05 |

- 실패한 실행: S-FI-01(지우지 않고 아래에 남긴다). 중단한 실행: 없음.

## 실행 기록

| ID | 시각 | 수준 | 대상 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|---|
| S-FI-00 | 05:44 ~ 05:46 | 실제 설치 | 실행 전 상태(읽기만) | `ls -la ~/.agent-chat`, `claude mcp get agent-chat`, `codex mcp get agent-chat --json`, `~/.claude.json` 의 `mcpServers` 키 이름, `~/.codex/config.toml` 의 표 머리줄, 작업 폴더의 `.claude`·`.codex`·`.mcp.json` | — | `~/.agent-chat` **없음**(덮어쓸 것 없음. `rooms/`·`logs/` 도 없었다). `agent-chat` 등록은 두 호스트 모두 없음(종료 코드 1). Claude Code 의 다른 user 등록: `aws-mcp`, `narrasync`, `arrow-marker`. Codex 설정의 다른 서버 표: `node_repl`, `narrasync`, `arrow-marker`, `rea`(그 밖에 `list` 에 플러그인의 `codex_app`, `cua_repl`). Codex 설정에 `agent-chat` 글자 0. 작업 폴더에 `.claude/`, `.codex/`, `.mcp.json` 없음. `~/.claude/settings.json` 있음, `settings.local.json` 없음. 되돌릴 때를 위해 두 설정 파일 사본을 스크래치에 600 으로 떴다(`~/.claude.json` 사본은 끝난 뒤 지웠다) | 사실 확인 |
| S-FI-01 | 05:47:01 ~ 05:47:42 | 실제 설치 | **`V-S1` 1차** | `node tests/e2e/install/v-s1.mjs --yes` (작업 폴더 = 저장소 뿌리) | 11/11 통과 | 종료 코드 1, **6/11**. 설치 네 번은 모두 종료 코드 0(1회 `통과 16, 건너뜀 0, 사용자 조치 필요 3`, 2회 `통과 13, 건너뜀 2`(이미 등록됨), 제거 `통과 4`, 4회 `통과 16`). S1-01·02(둘)·04·07·09 통과. **S1-03·06·08·10 실패**: `~/.codex/config.toml: [mcp_servers.node_repl] args, … startup_timeout_sec, [mcp_servers.rea] args, … startup_timeout_sec, … tool_timeout_sec`. **S1-05 실패**: 종료 코드 0 인데 "등록이 같다"가 거짓 | **실패** |
| S-FI-01a | 05:48 ~ 05:50 | 실제 설치(조회) + 임시 `CODEX_HOME` | 실패 원인 확인 | (가) 사본과 현재 파일의 해당 키 비교. (나) 실행 전 사본과 현재 파일을 각각 임시 `CODEX_HOME`(600, 확인 뒤 지움)에 두고 `codex mcp get <이름> --json` 으로 `node_repl`·`rea`·`narrasync`·`arrow-marker` 를 읽어 비교. (다) `claude mcp get`·`codex mcp get --json` 을 두 번씩 받아 `diff` | — | (가) Codex 의 `mcp add`/`remove` 가 파일을 다시 쓰며 다른 서버 표를 바꿨다: `node_repl` 의 `args = []` 줄 삭제, `startup_timeout_sec = 120` → `120.0`, `rea` 의 `args = [ "…", "mcp" ]` → `["…", "mcp"]`, `30` → `30.0`, `450` → `450.0`. env 하위 표와 다른 표는 그대로. (나) **Codex 가 읽은 값은 네 서버 모두 전후가 같다**(enabled, command, args, env 키, env_vars, cwd, enabled_tools, disabled_tools, startup·tool 시간). (다) Claude 출력은 같고, **Codex `get --json` 은 env 키 순서가 두 번 부를 때 달랐다**(값은 같음). 판단: 기준 "뜻이 같다"는 지켜졌고, 검증 도구가 값 원문(S1-03 등)과 JSON 글자 순서(S1-05)로 견준 것이 결함 | 원인 확인 |
| U-FI-01 | 05:51 ~ 05:53 | 대역 | **고치기 전 재현** | 시험을 먼저 더한 뒤 `node --test tests/e2e/install/settings-snapshot.test.mjs tests/e2e/install/verify-scripts.test.mjs`, 이어서 `--test-name-pattern="Codex 0.169.0"` 로 v-s1 대역만 | 새 시험이 실패한다 | 72 중 69 통과, **3 실패**(뜻 비교 2건, v-s1 대역 1건). 가짜 Codex 에 env 순서를 정해진 순열로 바꾸는 동작을 넣은 두 번째 실행에서 v-s1 대역이 **6/11, 실패 S1-03·05·06·08·10** — 실제 홈 S-FI-01 과 같은 실패 집합 | 재현됨 |
| U-FI-02 | 05:53 ~ 05:56 | 대역 | 고친 뒤 시험 | `node --test tests/e2e/install/settings-snapshot.test.mjs`(고친 직후), `npm test`, `node --test installer/`, `node tests/e2e/run.mjs install` | 전부 통과 | 스냅숏 66/66. `npm test` **1565/1565**(빌드 포함, 제품 코드 무변경). `installer` **34/34**. `test:e2e install` **96/96**(76.2초, 새 v-s1 대역은 11/11) | **통과** |
| U-FI-03 | 05:56 | 실제 파일(임시 홈) | 고친 비교 도구로 1차의 실제 전후 비교 | 실행 전 사본(`~/.claude.json`, `~/.codex/config.toml`)과 S-FI-01 뒤의 실제 파일을 임시 홈 둘(600)에 두고 `takeSnapshot`(실제 `codex`, `CODEX_HOME` 지정) → `compareSnapshots`. 끝나고 임시 홈 지움 | 같다 | `{"same":true,"compared":11,"differences":[]}` | 통과 |
| S-FI-02 | 05:57:02 | 실제 설치 | 처음부터 하려고 1차가 남긴 등록 제거 | `sh ~/.agent-chat/app/installer/install.sh --uninstall`, 이어서 `claude mcp get agent-chat`, `codex mcp get agent-chat --json` | 종료 코드 0, 등록 없음 | 종료 코드 0(`통과 4`), 두 `get` 모두 종료 코드 1(없음). `rooms/`·`app/`·`logs/`·`backups/` 는 남기고 경로만 알림 | 통과(준비) |
| S-FI-03 | 05:57:0x ~ 05:57:48 | 실제 설치 | **`V-S1` 2차(고친 작업 트리를 다시 복사, 처음부터)** | `node tests/e2e/install/v-s1.mjs --yes` (복사 표시 파일이 있어 `--replace-app` 불필요) | 11/11 통과 | 종료 코드 0, **11/11**. 1회: 6·7단계 `새로 등록`, Codex 백업 뜸, `tool_timeout_sec = 600` 넣음, 8단계 명령 `/opt/homebrew/bin/node`(셸이 찾은 링크 그대로), 9단계 **Claude Code `불명 — 판정표 9행`**, Codex `불가`, 10단계 D1~D8 통과(D4 `wss://agent-chat.tools.camp`), `통과 16, 실패 0, 건너뜀 0, 사용자 조치 필요 3, 경고 0 (종료 코드 0)`. S1-02 두 호스트 모두 `~/.agent-chat/app/dist/entry/mcp.js`. S1-03 같음. 2회: 6·7단계 `건너뜀 — 이미 등록됨`, `통과 13, 건너뜀 2`, S1-05·06 통과. 제거: `통과 4`, S1-07·08 통과. 4회: `통과 16`, S1-09·10 통과 | **통과** |
| S-FI-04 | 05:58:03 ~ 05:58:12 | 실제 설치 + 공용 서버 | **`V-S2`** | `node tests/e2e/install/v-s2.mjs` (인자 없음 = 공용 서버), 앞뒤로 `pgrep -fl 'agent-chat/app/dist/entry'` | 9/9 통과, 남은 프로세스 0 | 종료 코드 0, **9/9**. A 는 Claude Code 등록, B 는 Codex 등록으로 띄움. `create_room` 서버 `wss://agent-chat.tools.camp`, `join_room` 성공, A→B·B→A 모두 `delivered` 이고 `wait_for_messages` 로 받음, 양쪽 `get_status` 의 상대 `not_ready`, `leave_room` 뒤 닫기 14ms·남은 프로세스 0. `doctor`(설치된 `~/.agent-chat/app/dist/entry/cli.js`) D1~D8 통과, 종료 코드 0. `pgrep` 앞 0·뒤 0 | **통과** |
| S-FI-05 | 05:58 ~ 05:59 | 실제 설치 | 끝난 상태 | `claude mcp get agent-chat`, `codex mcp get agent-chat --json`, `codex mcp list --json`(이름만), `~/.claude.json` `mcpServers` 키, Codex 설정의 `agent-chat` 표, `ls -la ~/.agent-chat …`, `pgrep` | 등록된 채, 다른 등록 그대로 | Claude Code: user scope, `Command: /opt/homebrew/bin/node`, `Args: ~/.agent-chat/app/dist/entry/mcp.js`, env `AGENT_CHAT_CLIENT=claude-code`, `AGENT_CHAT_NAME=claude-<4자>`, `AGENT_CHAT_WAIT_MAX_SEC=100`. Codex: 같은 명령·인자, env `AGENT_CHAT_CHANNEL=off`, `AGENT_CHAT_CLIENT=codex`, `AGENT_CHAT_NAME=codex-<4자>`, `AGENT_CHAT_WAIT_MAX_SEC=540`, `tool_timeout_sec = 600`, 표 키는 `command`·`args`·`env`·`tool_timeout_sec` 뿐. `~/.claude.json` `mcpServers`: `aws-mcp`, `narrasync`, `arrow-marker`, `agent-chat`. Codex 서버: `agent-chat`, `arrow-marker`, `codex_app`, `cua_repl`, `narrasync`, `node_repl`, `rea`. `~/.agent-chat/`: `app/`(755, `.v-s1-copy` 표시 파일), `backups/`·`logs/`·`rooms/`(700, 파일 600). 남은 MCP 프로세스 0 | 통과 |

## 고친 것

검증 도구와 그 시험만 고쳤다. 설치기(`installer/*.sh`, `scripts/install.mjs`)와 `src/setup` 등 제품 코드는 고치지 않았다(결함이 거기 있지 않았다).

1. `tests/e2e/install/settings-snapshot.mjs` — Codex 설정 값을 **원문이 아니라 뜻으로** 견준다(`tomlValueMeaning`). 문자열(따옴표 종류·이스케이프를 푼 내용), 수(정수·소수는 값이 같으면 같다. 밑줄·진법·지수), 불리언, 날짜·시각, 배열, 인라인 표. 종류가 다르면 다르다(`30` 과 `"30"`). 읽지 못한 값은 원문으로 견준다. 다른 서버 표(`[mcp_servers.<agent-chat 아닌 이름>]`) 바로 아래의 **빈 `args` 만** 없는 키와 같게 본다(Codex 기본값이 빈 목록이고 Codex 가 이 줄을 지운다). `enabled_tools = []` 같은 다른 빈 목록은 "아무 것도 허용하지 않음"일 수 있어 그대로 견준다.
2. `tests/e2e/install/v-s1.mjs` — S1-05 의 Codex 등록 비교를 키를 정렬한 JSON 으로 한다(`canonicalJson`).
3. `tests/e2e/install/fake-host-cli.mjs` — `FAKE_CODEX_LIKE_0169=<상태 파일>` 을 주면 실제 Codex 0.169.0 의 두 동작을 흉내 낸다: env 키 순서를 부를 때마다 다음 순열로, `mcp add`·`remove` 때 다른 서버 표의 `args = []` 삭제·정수 시간 → 소수·배열 공백 정리.
4. 시험: `settings-snapshot.test.mjs` 에 "뜻으로 견준다" 묶음 10건(같다 2, 다르다 8)과 `tomlValueMeaning` 직접 시험 1건을 더했다. 기존 "값의 따옴표 종류가 바뀜 → 다르다" 시험은 "리터럴 문자열의 내용이 바뀜 → 다르다"로 바꿨다(같은 내용의 따옴표 바꿈은 이제 "같다" 쪽 시험에 있다). `verify-scripts.test.mjs` 에 "실제 Codex 0.169.0 처럼 … 바꿔 써도 통과한다" 1건.
5. `docs/design/architecture.md` 3.13 "줄 단위 읽기" — 위 규칙과 근거(이 기록)로 고쳤다. 전에는 "값의 따옴표 종류가 바뀌면 다르다. 비교 대상 값이 짧은 문자열과 불리언이다"를 **[가정]** 으로 뒀는데 이번 실측으로 틀렸다. 통과 기준("설치 전후에 뜻이 같다", 바이트 비교 안 함)은 바꾸지 않았다.

## 설치 결과로 사용자가 할 일 (설치기 출력 그대로, S-FI-03 의 1회. 홈 경로만 `~`)

```text
[11] 안내: 사용자 조치 필요 — 열려 있는 Claude Code 세션을 다시 시작한다. 그래야 agent-chat tool 이 보이고 새 코드를 쓴다.
[11] 안내: 사용자 조치 필요 — 열려 있는 Codex 세션을 다시 시작한다. 그래야 agent-chat tool 이 보이고 새 코드를 쓴다.
[11] 안내: 사용자 조치 필요 — tool 을 처음 부를 때 호스트가 승인을 묻는다. 사용자가 직접 고른다. 설치와 에이전트는 권한·허용 목록·hook 설정을 고치지 않는다.
  "항상 허용"을 골라도 되는 tool: wait_for_messages, send_message, get_status, set_status, confirm_channel, start_scenario, record_claim, record_verification, stop_test, write_report, leave_room (이미 들어간 방 안에서만 동작한다).
  매번 승인으로 남기기를 권하는 tool: create_room, join_room, start_test. MCP 등록은 이 PC 의 모든 세션에 보인다. 방 참여와 테스트 제한이 사용자 눈앞에서만 일어나게 한다.
  방에 들어가면 다른 참가자와 시그널링 서버가 이 PC 의 IP 주소를 본다. 연결 후보에는 내부망 주소도 들어 있다.
  channel 모드는 선택 사항이다(Claude Code). 기본은 poll 이고, 쓰지 않아도 모든 기능이 동작한다.
  쓰려면 claude --dangerously-load-development-channels server:agent-chat 로 시작하고 경고 대화상자에서 직접 승인한다. 호스트가 보여 주는 경고문은 다음과 같다.
    "--dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet."
  Agent Chat 은 GitHub 에서 받는 서버다. 쓸지는 저장소 코드를 믿을지와 함께 사용자가 정한다. 설치는 플래그를 대신 붙이지 않고 승인을 대신하지 않는다.
  입장한 뒤에도 channel 로 바뀌지 않으면 에이전트에게 "대기를 멈추고 턴을 끝내라"고 말한다. 채널이 등록돼 있으면 점검 알림이 새 턴을 시작시킨다. 1분 안에 반응이 없으면 채널이 등록되지 않은 것이다. "계속 대기하라"고 말해 poll 로 돌아간다.
  Codex 에는 채널이 없다. 에이전트가 wait_for_messages 를 되풀이하는 동안만 자동으로 받는다.
  갱신: git -C "~/.agent-chat/app" pull --ff-only 뒤 sh "~/.agent-chat/app/installer/install.sh" 를 다시 실행한다.
  제거: sh "~/.agent-chat/app/installer/install.sh" --uninstall
```

Channels 보고(같은 실행의 9단계): `[9] Channels (Claude Code): 불명 — 판정표 9행. 서버 관리형 정책, 계정 종류, 기능 공개 여부는 로컬에서 알 수 없다. 쓰려면 개발 채널 플래그(claude --dangerously-load-development-channels server:agent-chat)로 시작해 경고를 읽고 직접 승인한다. 입장 뒤 점검이 통하면 다음 설치 점검부터 '가능'으로 나온다. 그 전까지는 poll 로 동작한다.` / `[9] Channels (Codex): 불가 — 채널이 없다. poll 로 받는다.` S-FI-01 의 1회와 안내 글이 같다(`diff` 0).

## 설계와 다른 관찰

1. **Codex CLI 의 `mcp add`·`remove` 는 다른 서버 표의 표기를 바꿔 쓴다**(S-FI-01a). 뜻(Codex 가 읽는 값)은 같지만 사용자 파일의 표기는 영구히 바뀐다(`args = []` 삭제, 정수 → 소수, 배열 공백). 설치기는 Codex 가 파일을 고치기 전에 백업을 뜨지만 **설치가 만든 백업은 최근 3개만 남긴다**. 이번 작업에서 설치가 Codex 등록을 네 번 넣으며 백업을 넷 떠(제거는 백업을 뜨지 않는다), 원래 표기가 든 첫 백업(`codex-config-…T204707Z.toml`)은 이미 지워졌다. 남은 3개는 모두 바뀐 뒤의 표기다. 원래 표기는 세션 스크래치의 `backup/codex-config.toml` 에만 있다. 설치·제거가 사용자 파일을 직접 고쳐 쓰지 않고 Codex CLI 를 쓰는 것은 설계가 고른 길이라 고치지 않았다.
2. **Codex 0.169.0 의 `mcp get --json` 은 env 키 순서가 부를 때마다 다르다.** 설치기의 등록 비교(6·7단계 "이미 등록됨")는 영향을 받지 않았다(2회에서 `건너뜀`). 검증 스크립트만 영향을 받았다.
3. 설치마다 stderr 에 `npm warn install-scripts 1 package has install scripts not yet covered by allowScripts: esbuild@0.28.2 (postinstall: node install.js)` 가 나온다(npm 11.20.0). 설치 결과는 통과였다. `esbuild` 는 Lambda 번들(`build:lambda`)에만 쓰고 설치의 빌드(`tsc`)에는 쓰지 않는다. 이 경고로 postinstall 이 건너뛰어졌는지는 확인하지 않았다.
4. 제거 뒤 다시 설치하면 `AGENT_CHAT_NAME` 의 무작위 4자가 새로 정해진다(1차 끝 `claude-mcgj`·`codex-htm0` → 2차 끝 다른 값). 설계("처음 설치할 때 한 번 만들고, 다시 설치하면 기존 등록의 값을 유지")대로다. 제거 없이 다시 설치한 2회에서는 유지됐다(S1-05).
5. `V-S2` 의 두 프로세스는 같은 PC 다. 상대가 `not_ready` 로 보인 것은 두 프로세스 모두 `set_status` 를 부르지 않았기 때문으로 기대와 맞다.

## 미실행과 이유

- `git clone` 으로 받는 길과 `git pull` 갱신: `V-S1` 의 범위 밖(작업 트리 복사). `V-I1` 에서 본다. 원격 저장소에 코드가 아직 없다.
- Codex 설정의 원래 표기로 되돌리기: 승인 범위(`[mcp_servers.agent-chat]`) 밖의 표를 고치는 일이라 하지 않았다. 원래 표기를 되살리려면 사용자가 스크래치 사본을 보고 정한다.
- 실제 호스트 세션(Claude Code·Codex 를 다시 시작해 tool 을 부르기, channel 모드): `V-I*` 범위. 사람의 승인이 필요하다.
- 전체 `npm run test:e2e`: 검증 도구만 고쳐 `install` 묶음만 다시 돌렸다(96/96). 제품 코드는 바꾸지 않았고 `npm test` 1565/1565 는 다시 돌렸다.
- 다른 OS, Windows 의 `node scripts/install.mjs` 직접 실행: 미실행(이전과 같음).

## 다음에 확인할 것

- 설치가 Codex 설정을 고치기 전 **원래** 파일을 백업 회전(최근 3개)으로 잃지 않게 할지(예: 처음 백업은 지우지 않기) — 설계 결정이 필요하다.
- `V-I1`(README 만 보고 에이전트가 설치)과 `V-I2`~`V-I4`(실제 세션의 channel·poll 수신).
