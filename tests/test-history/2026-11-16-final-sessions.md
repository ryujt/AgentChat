# 2026-11-16 마감 실제 세션: 실제 에이전트 호스트의 자동 수신(`V-I3`·`V-I4` 헤드리스 변형)

[final-install](2026-11-16-final-install.md) 에서 이 PC 의 Claude Code 와 Codex 에 실제로 등록된 `agent-chat` 으로, **사람 없이 헤드리스 세션**(`claude -p`, `codex exec`)을 띄워 공용 서버의 방에서 30분 동안 글을 받고 답하는지 본 기록이다([검증 계획](../../docs/design/verification-plan.md) 3.5).

- 작업 ID: `2026-11-16-final-sessions`
- **조건이 검증 계획과 다르다.** `V-I3`·`V-I4` 는 사람이 대화형 세션에 "이 방에 들어가 오는 글에 답하라"를 한 번 말한다. 여기서는 그 한 번을 **프롬프트 인자**로 주었다. 그래서 판정은 "`V-I3`·`V-I4` 헤드리스 변형"으로 따로 적고, **대화형 `V-I3`·`V-I4` 를 통과로 세지 않는다.** 완료 기준 "자동 수신"은 여전히 **부분 검증**이다.
- 기준(실행 전 고정. verification-plan.md 3.5 의 자동 수신 판정 기준을 그대로 쓴다): `peer-script` 가 2분 간격으로 글 15건(30분 구간)을 보낸다. **15건 모두에 대해 그 세션의 `send_message` 응답이 5분 안에 온다.** 기록: 빈 대기 횟수, 대기가 끊긴 횟수와 이유, 모델 턴 수. 끝나면 세션 프로세스와 MCP 프로세스가 남지 않는다. 이어지는 "사람이 끼어들어 턴을 끝낸 뒤의 글"은 헤드리스에서 할 수 없어 미실행이다(아래).
- 지시문(두 호스트 같음. 이름만 다름): `agent-chat 으로 공용 서버의 방 <room_id> 에 이름 claude-a 로 들어가 오는 글에 답해 줘. 30분 동안 계속하고, peer-script 가 끝이라고 하면 방을 나가.` 모델은 각 호스트의 기본값(Claude Code 는 `claude-opus-5-5` 로 떴다. Codex 는 출력에 모델 이름이 없다).
- 도구 허용은 **명령줄 인자로 그 실행에만** 주었다. 설정 파일은 고치지 않았다(관찰 1, P-FS 의 해시 비교).
  - Claude Code: `--allowedTools "mcp__agent-chat__*"`.
  - Codex: `-c 'mcp_servers.agent-chat.tools.<tool>.approval_mode="approve"'` 를 `join_room`, `wait_for_messages`, `send_message`, `leave_room`, `get_status`, `set_status` 여섯에만. 승인 우회 플래그(`--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me`)와 `--trust` 는 쓰지 않았다.
- 기준 상태: 브랜치 `main`, 커밋 `a82ed0e` + 커밋하지 않은 작업 트리. 설치는 final-install 의 S-FI-03 결과(`~/.agent-chat/app`) 그대로. 공용 서버는 [final-deploy](2026-11-16-final-deploy.md) P-FD-08 로 다시 만든 스택.
- 환경: macOS 27.2 arm64 한 대, Node v26.12.1, Claude Code 2.1.325, Codex CLI 0.169.0. 등록: Claude Code `AGENT_CHAT_WAIT_MAX_SEC=100`(user scope), Codex `AGENT_CHAT_WAIT_MAX_SEC=540`·`AGENT_CHAT_CHANNEL=off`·`tool_timeout_sec = 600`. 세션과 상대 참가자는 같은 PC 에서 공용 서버를 거쳐 직접 연결했다.
- 상대 참가자: `tests/e2e/mcp/peer-script.mjs` 는 가짜 진입점(`fake-entry.mjs`)의 조종 폴더로만 말해 실제 방에 들어가지 못한다. 그래서 설치된 제품 진입점을 SDK 클라이언트로 띄워 방을 만들고 글을 보내는 스크립트를 썼다. 실행 I-FS-01~06 은 세션 스크래치의 `live-poll.mjs`, I-FS-07 과 U-FS-02·03 은 그것을 다듬어 저장소에 넣은 [`tests/e2e/mcp/live-peer.mjs`](../e2e/mcp/live-peer.mjs) 다(동작 같음. 사람 절차용 `--host none`, `--late-sec`, `--ask` 를 더함). 상대의 이름은 `peer-script`, 기록은 따로 둔 `AGENT_CHAT_HOME`(스크래치)에 남는다. 글은 `[Qnn] a 더하기 b 는 얼마인가요? 답 맨 앞에 [Qnn] 을 붙여 짧게 답해 주세요.` 이고, 답은 `[Qnn]` 표지로 짝짓는다. 지연 = 상대가 답 사건을 받은 시각 − `send_message` 를 부른 시각.
- 원문 증거: 세션 스크래치 `…/scratchpad/final/final-sessions/` 의 실행별 폴더(`runner.jsonl`, `summary.json`, `peer-events.jsonl`, 호스트 출력 `session.jsonl`·`session.err`, 집계 `analysis.json`)와 `i-fs-*.log`. 방 ID·글 본문이 들어 있어 폴더 0700·파일 0600 이다. 세션이 끝나면 사라진다. 세션 쪽 MCP 프로세스의 진단 로그는 `~/.agent-chat/logs/diag-20261115T21-{wrcz94,vprmla,hyzim1,…}.jsonl`, 대화 기록은 `~/.agent-chat/rooms/` 에 제품이 남긴 그대로 두었다. 이 문서에 방 ID 는 없다.
- 실행 ID: 실제 세션 `I-FS-NN`, 도구 확인 `U-FS-NN`, 상태 확인 `P-FS-NN`. 시각은 KST(2026-11-16).

## 요약

| 항목 | 판정 | 증거 수준 | 근거 |
|---|---|---|---|
| **`V-I3` 헤드리스 변형** (Claude Code 2.1.325, `claude -p`, poll) | **통과** 15/15. 지연 1.4~2.8초(평균 1.9). 빈 대기 14, 끊긴 대기 0. 턴 49(`num_turns`), 모델 응답 34 | 실제 호스트 + 공용 서버 | I-FS-04 |
| **`V-I4` 헤드리스 변형** (Codex 0.169.0, `codex exec`, poll) | **통과** 15/15. 지연 1.7~2.9초(평균 2.3). 빈 대기 29, 끊긴 대기 0. exec 턴 1(그 안에서 tool 호출 66, 중간 글 34) | 실제 호스트 + 공용 서버 | I-FS-05 |
| Codex 의 540초 대기 1회(A-MCP-5 의 한 부분) | **통과**. `wait_for_messages{timeout_sec:540}` 한 번이 서버 쪽 540,005ms 로 `status: "timeout"` 을 돌려줬다. 호스트 타임아웃 없음 | 실제 호스트 + 공용 서버 | I-FS-06 |
| Claude Code 의 100초 대기가 턴 안에서 이어지는가(A-MCP-4 의 헤드리스 부분) | 이어짐. 100초 빈 대기 14번 모두 결과가 같은 턴으로 돌아왔고 백그라운드로 옮겨지지 않았다 | 실제 호스트 | I-FS-04 |
| `V-I3` 의 "채널로 중복 전달 없음"(헤드리스 범위) | 중복 없음. 점검 알림 1회 뒤 `confirm_channel` 없음, 전달 모드 poll 유지, 글마다 답 한 번. 다만 `-p` 는 채널을 못 쓰는 환경이라 채널이 등록된 대화형의 확인은 아니다 | 실제 호스트 | I-FS-04 |
| 끝난 뒤 남은 프로세스 | 0. 세션·세션의 MCP 프로세스·상대 MCP 프로세스 모두 끝남 | 실제 환경 | P-FS-01 |
| 호스트 설정 | `~/.codex/config.toml`, `~/.claude/settings.json` 해시가 실행 전후 같다. 등록 그대로 | 실제 환경 | P-FS-01 |
| `V-I3`·`V-I4` 의 "한 번 더"(사람이 끼어들어 턴을 끝낸 뒤의 글) | **미실행**. 헤드리스에는 대화 중 사람 입력이 없고, 턴이 끝나면 프로세스가 끝난다 | — | 아래 절차 |
| **대화형 `V-I3`·`V-I4`**, `V-I2`, `V-I5`, `V-I6`, `V-I1` | **미실행**(사람이 필요하거나 선행 조건 없음). 절차를 아래에 적었다 | — | — |

- 실패한 실행: I-FS-02(Codex 승인 정책으로 입장 못 함. 원인과 다시 실행은 아래), U-FS-01(도구 결함으로 5분 대기. 고친 뒤 U-FS-02). 지우지 않았다.
- 비용 기록: I-FS-04 의 Claude Code 보고 비용 0.61 USD, 28분 23초. I-FS-05 Codex 입력 2,318,875 토큰(캐시 2,266,880), 출력 7,647.

## 실행 기록

| ID | 시각 | 수준 | 대상 | 명령 | 기대 | 실제 | 판정 |
|---|---|---|---|---|---|---|---|
| P-FS-00 | 06:02 | 실제 환경 | 실행 전 상태 | `claude mcp get agent-chat`, `codex mcp get agent-chat --json`, `pgrep`, `shasum -a 256 ~/.codex/config.toml ~/.claude/settings.json` | 등록이 이 설치를 가리킨다 | 두 호스트 모두 `/opt/homebrew/bin/node ~/.agent-chat/app/dist/entry/mcp.js`. Codex `tool_timeout_sec = 600`. 이 설치의 프로세스 없음(다른 담당의 `final-long` 프로세스 8개는 건드리지 않음) | 사실 확인 |
| I-FS-01 | 06:03:32 ~ 06:05:15 | 실제 호스트 | 연습: Claude 헤드리스, 글 2건 30초 간격 | `node <scratch>/live-poll.mjs --host claude --out <scratch>/i-fs-01-claude-smoke --count 2 --interval-sec 30` | 배관 확인 | 입장 6.5초. 2/2(2.0초, 1.7초). `[END]` 뒤 `leave_room` → 종료 코드 0. 첫 호출은 `ToolSearch`(지연 로딩된 tool 불러오기) | 통과(연습) |
| I-FS-02 | 06:03:34 ~ 06:04:26 | 실제 호스트 | 연습: Codex 헤드리스, 허용 인자 없이 | `… --host codex --out <scratch>/i-fs-02-codex-smoke --count 2 --interval-sec 30` | 배관 확인 | **입장 못 함.** `join_room` 이 `MCP tool call requires approval, but approval policy is never` 로 실패, 세션은 종료 코드 0 으로 끝남. 0/2. 입장 전 Codex 가 사용자 skill 파일 하나를 `cat` 으로 읽었다(관찰 4) | **실패**(조건) |
| I-FS-02a | 06:04 | 조사 | 그 실행에만 적용되는 승인 방법 | `codex exec --help`, `codex exec -c 'mcp_servers.agent-chat.default_tools_approval_mode="bogus"' "say hi"`(설정 해석 오류로 모델 호출 전에 끝남) | 명령줄 방법이 있는가 | `-c` 는 설정 파일을 고치지 않고 그 실행의 값만 덮는다. 허용 값은 `auto`, `prompt`, `writes`, `approve`. 서버 단위(`default_tools_approval_mode`)와 tool 단위(`tools.<tool>.approval_mode`)가 있다. 더 좁은 tool 단위를 골랐다 | 방법 있음 |
| I-FS-03 | 06:04:23 ~ 06:06:13 | 실제 호스트 | 연습: Codex, tool 여섯에 그 실행만의 허용 | `… --host codex --out <scratch>/i-fs-03-codex-smoke --count 2 --interval-sec 30 --extra -c --extra 'mcp_servers.agent-chat.tools.join_room.approval_mode="approve"' …`(여섯 tool) | 배관 확인 | 입장 8.0초. 2/2(4.2초, 4.8초). 허용 목록 밖의 `write_report` 는 같은 승인 정책 오류로 막혔다(관찰 1) | 통과(연습) |
| **I-FS-04** | 06:05:02 ~ 06:34:13 | 실제 호스트 + 공용 서버 | **`V-I3` 헤드리스 변형** | `node <scratch>/live-poll.mjs --host claude --out <scratch>/i-fs-04-claude --count 15 --interval-sec 120 --hard-limit-min 50`. 세션 명령: `claude -p "<지시>" --allowedTools "mcp__agent-chat__*" --output-format stream-json --verbose --no-session-persistence` | 15건 모두 5분 안 | 입장 5.8초. 글 06:05:18 ~ 06:33:18(2분 간격 15건) 모두 `delivered`. **15/15**, 지연 최소 1.395 · 최대 2.754 · 평균 1.91초. 답은 모두 맞는 합(14 … 70). 끝 글 뒤 1.2초에 `left`, 세션 종료 코드 0(06:33:26). tool 호출: `ToolSearch` 1, `join_room` 1, `wait_for_messages` 30, `send_message` 15, `leave_room` 1. 대기 30 = 빈 대기(`timeout`) **14**(모두 100.0초) + 사건 16(글 15 + 끝 글). 오류·취소 0. `num_turns` 49, 모델 응답(고유 `message.id`) 34, 거절된 권한 0. 세션 MCP 진단 로그: `delivery.probe{sent}` 1, `confirm_channel` 호출 없음, `delivery.listening` 은 `false→true` 한 번 뒤 끝까지 바뀌지 않음, 종료 `SIGINT` | **통과** |
| **I-FS-05** | 06:06:21 ~ 06:35:47 | 실제 호스트 + 공용 서버 | **`V-I4` 헤드리스 변형** | `… --host codex --out <scratch>/i-fs-05-codex --count 15 --interval-sec 120 --hard-limit-min 50` + I-FS-03 의 여섯 `-c`. 세션 명령: `codex exec --json --skip-git-repo-check --ephemeral -C <scratch>/…/session-cwd -c … "<지시>"` | 15건 모두 5분 안 | 입장 15.1초(인사 글 1, `set_status` 로 역할·`ready`). 글 06:06:47 ~ 06:34:47 모두 `delivered`. **15/15**, 지연 최소 1.740 · 최대 2.937 · 평균 2.29초, 답 모두 맞음. 끝 글 뒤 5.3초에 작별 글과 `left`, 종료 코드 0(06:35:07). tool 호출: `join_room` 1, `set_status` 1, `wait_for_messages` 45, `send_message` 17(답 15 + 인사·작별), `leave_room` 1, `write_report` 1(허용 밖이라 승인 정책으로 막힘). 대기 45 = 빈 대기 **29** + 사건 16. 오류·취소 0. 대기 길이는 모델이 `timeout_sec` 로 정했다: 50초 30번, 45초 4, 40초 4, 15초 2, 그 밖 5(10~30초). 540초는 쓰지 않았다. exec 턴 1(`turn.started` 1), 중간 글(`agent_message`) 34. stderr 에 `collab spawn failed … no rollout found`(관찰 5). 세션 MCP 진단 로그: `delivery.listening` 한 번 뒤 그대로, 종료 `stdin_end` | **통과** |
| I-FS-06 | 06:36:44 ~ 06:46:50 | 실제 호스트 + 공용 서버 | Codex 의 540초 대기 1회 | `… --host codex --session-name codex-b --count 0 --prompt-file <scratch>/prompt-540.txt --extra -c …`(`join_room`·`wait_for_messages`·`leave_room` 셋만 허용). 지시: "들어가서 `wait_for_messages` 를 `timeout_sec` 540 으로 딱 한 번만 부르고, status 와 걸린 시간을 알려 준 뒤 나가" | 540초 뒤 `timeout`, 호스트 타임아웃 없음 | 상대는 글을 보내지 않음. `wait_for_messages{timeout_sec:540}` 1회 → 서버 쪽 `duration_ms` **540,005**, 결과 `status: "timeout"`. 대기 중 Codex 가 중간 글 10개("약 N분째 기다린다")를 냈고 tool 을 다시 부르지 않았다. 이어 `leave_room`, 종료 코드 0 | **통과** |
| U-FS-01 | 06:38:42 ~ 06:40:42 | 도구 | `live-peer.mjs --host none`(세션 없이) | `timeout 120 node tests/e2e/mcp/live-peer.mjs --out <scratch>/u-fs-01-none --host none --join-limit-sec 5` | 5초 뒤 입장 없음으로 끝남 | 입장 없음을 적은 뒤 **퇴장을 5분 기다렸다**(들어온 적 없는 세션의 퇴장을 기다리는 결함). `timeout` 이 120초에 끊음. 상대 MCP 프로세스는 부모와 함께 끝남 | **실패**(도구) |
| U-FS-02 | 06:40:58 ~ 06:41:50 | 도구 | 고친 뒤 같은 명령 | 같은 명령(`timeout` 없이) | 입장 없음 → 나감 → 정리 | 종료 코드 0. `join.missing` 5초 → `leave_room` 3초 → 받기 반복의 마지막 대기(최대 50초) 뒤 끝. 남은 프로세스 0 | 통과 |
| I-FS-07 | 06:41:56 ~ 06:43:34 | 실제 호스트 + 공용 서버 | 저장소 도구로 헤드리스 확인(`--late-sec` 배관 포함) | `node tests/e2e/mcp/live-peer.mjs --out <scratch>/i-fs-07-claude-tool --host claude --count 2 --interval-sec 20 --late-sec 5 --hard-limit-min 10` | 2/2, `[LATE]` 배관 동작 | 2/2(1.6초, 1.6초). `[LATE]` 는 2.0초에 답이 왔다. **헤드리스는 턴이 계속 살아 있으므로 이것은 "끼어든 뒤"의 확인이 아니다**(배관만). 퇴장·종료 코드 0, 남은 프로세스 0 | 통과(도구) |
| U-FS-03 | 06:47:53 ~ 06:48:45 | 도구 | `--ask` 를 더한 뒤 `--host none` 다시 | `node tests/e2e/mcp/live-peer.mjs --out <scratch>/u-fs-03-none --host none --join-limit-sec 3 --ask "테스트"` | U-FS-02 와 같음 | 종료 코드 0. 입장 없음 → `leave_room{left:true}` → 끝. 상대 MCP 프로세스 남지 않음. `--ask` 로 글을 보내는 경로는 세션 없이 볼 수 없어 보지 않았다 | 통과 |
| P-FS-01 | 06:47 ~ 06:50 | 실제 환경 | 끝난 상태 | `ps -axo pid,ppid,command`(`~/.agent-chat/app/dist/entry/mcp.js`·`claude -p`·`codex exec`·`live-p*`), `shasum`, `claude mcp get agent-chat`, `codex mcp get agent-chat --json`, `~/.claude.json` 의 `mcpServers` 이름과 실행 폴더의 프로젝트 항목 | 남은 것 없음, 설정 그대로 | 이 작업의 프로세스 0. `~/.codex/config.toml` 해시 `b9376e…` 와 `~/.claude/settings.json` 해시 `2c7592…` 가 P-FS-00 과 같다. 등록 그대로(Claude `AGENT_CHAT_WAIT_MAX_SEC=100`, Codex `tool_timeout_sec 600`). `~/.claude.json` 은 해시가 바뀌었다(Claude Code 가 자기 상태를 쓰는 파일). 그 안의 `mcpServers` 이름은 `aws-mcp, narrasync, arrow-marker, agent-chat` 그대로이고, 실행 폴더의 프로젝트 항목은 생기지 않았다(`--no-session-persistence`) | 통과 |

## 판정에 쓴 수 (기준에 적힌 기록 항목)

| | Claude Code (I-FS-04) | Codex (I-FS-05) |
|---|---|---|
| 15건 중 5분 안 | 15 | 15 |
| 지연 최소 / 평균 / 최대 | 1.40 / 1.91 / 2.75초 | 1.74 / 2.29 / 2.94초 |
| 빈 대기 | 14 (각 100초. 등록 상한) | 29 (모델이 고른 10~50초) |
| 대기가 끊긴 횟수와 이유 | 0 | 0 |
| 모델 턴 수 | `num_turns` 49, 모델 응답 34 | exec 턴 1. 모델 요청 수는 `codex exec --json` 이 내주지 않아 세지 못했다. 그 턴 안의 tool 호출 66, 중간 글 34 |
| 세션 쪽 `listening` | 입장 뒤 `true`, 끝까지 유지 | 같음 |
| 끝 글 뒤 퇴장·종료 | 1.2초 `left`, 6.0초 종료 | 5.3초 `left`, 17.2초 종료 |

## 고친 것

제품 코드는 고치지 않았다.

- [`tests/e2e/mcp/live-peer.mjs`](../e2e/mcp/live-peer.mjs)(새 파일): 실제 방의 상대 참가자. 스크래치의 `live-poll.mjs` 를 저장소에 맞게 옮겼다(저장소의 `@modelcontextprotocol/sdk` 를 쓰고, 노드 경로는 `process.execPath`). 더한 것: `--host none`(사람이 띄운 세션을 기다리고 방을 출력), `--late-sec`(V-I3 의 "한 번 더"), `--ask`(정해진 글 보내기), `--entry`, `--server`. U-FS-01 에서 드러난 결함(들어온 적 없는 세션의 퇴장을 기다림)을 고쳤다.
- [`tests/e2e/mcp/README.md`](../e2e/mcp/README.md): 파일 표에 `live-peer.mjs` 한 줄.

## 설계와 다른 관찰

1. **Codex `exec` 에서는 MCP tool 호출마다 승인이 필요하고, 헤드리스에서는 그 승인이 곧 실패다**(I-FS-02). 기본 승인 정책이 `never` 라서 `MCP tool call requires approval, but approval policy is never` 로 끝난다. 에이전트는 입장 실패를 알리고 턴을 끝냈다. `-c 'mcp_servers.agent-chat.tools.<tool>.approval_mode="approve"'` 로 그 실행만 허용할 수 있었고 설정 파일은 그대로였다. 허용하지 않은 `write_report` 는 같은 오류로 막혔다(호스트의 승인 장치가 그대로 작동한다는 부수 관찰. `V-I6` 의 판정은 아니다). **검토 필요**: 이 `-c` 는 Claude Code 의 `--allowedTools` 와 같은 성격(그 실행, 그 서버의 이름 붙은 tool 만)이라고 보고 썼다. 승인 우회 플래그로 보아야 한다면 I-FS-03·05·06 은 무효이고 `V-I4` 헤드리스 변형은 미실행이 된다.
2. **Codex 는 대기 길이를 스스로 짧게 고른다.** 등록 상한은 540초인데 30분 실행에서 모델이 고른 값은 10~50초였다. 그래서 빈 대기가 Claude 의 두 배였다. 540초 한 번은 따로 지시해 통과했다(I-FS-06). 대기 길이는 수신 판정에 영향이 없었다(모든 지연 3초 이내).
3. **Claude Code `-p` 의 첫 호출은 `ToolSearch` 다.** agent-chat tool 이 지연 로딩되어 있어 먼저 불러온 뒤 `join_room` 을 불렀다. 대기 결과는 모두 같은 턴으로 돌아왔다. Claude 세션은 `set_status` 를 부르지 않아 상대에게는 `status: joined` 로 남았다(받기는 `listening=true`). 안내서의 "들어가면 `set_status`"를 따르지 않은 것이다. Codex 는 불렀다.
4. **Codex 가 입장 전에 사용자 skill 파일을 읽었다**(I-FS-02 의 `cat ~/.agents/skills/multi-agent-task/SKILL.md`, 읽기만, 종료 코드 0). 지시문에 그 skill 을 부를 말이 없는데 호스트가 고른 것으로 보인다 **[추론]**. I-FS-05 에서는 명령 실행이 없었다.
5. **Codex 가 하위 에이전트를 띄우려다 실패했다**(I-FS-05 stderr: `collab spawn failed: … no rollout found for thread id …`). `--ephemeral` 로 세션 파일을 남기지 않아서로 보인다 **[추론]**. 결과에는 영향이 없었다.
6. 두 세션 모두 끝 글(`[END] … 끝입니다 …`)을 받고 스스로 `leave_room` 을 불렀고, 나간 뒤 받지 못한 사건은 0 이었다. 15건이 28분 구간에 끝나 30분이 되기 전에 끝났다(기준의 "30분 동안 2분 간격 15건"과 같다).

## 미실행과 이유

- **"한 번 더"(사람이 끼어들어 턴을 끝낸 뒤 글)**: 헤드리스에는 대화 중 사람 입력이 없다. `-p`·`exec` 는 턴이 끝나면 프로세스가 끝나 MCP 프로세스도 끝나므로, 같은 조건이 만들어지지 않는다. 아래 절차로 사람이 한다.
- **대화형 `V-I3`·`V-I4`**: 사람이 필요하다. 이번 결과는 "프롬프트 인자로 한 번 준 지시"의 결과다. 대화형에서는 tool 승인 프롬프트가 대기 반복을 멈출 수 있다(아래 절차의 허용 인자).
- **`V-I2`**(채널): 경고 대화상자를 사람이 승인해야 한다. `-p` 는 채널을 쓸 수 없다 **[문서]**.
- **`V-I5`**: 여러 사용자가 역할을 나눠 쓰는 테스트 대상 서비스가 정해지지 않았다.
- **`V-I6`**: 권한을 좁힌 대화형 세션에서 사람이 승인 프롬프트를 봐야 한다.
- **`V-I1`**: 원격 저장소에 코드가 없다(푸시는 사용자 지시가 있어야 한다).
- A-MCP-9(tool 결과 크기)·A-MCP-8(채널 태그): 이번 범위 밖. 절차는 [tests/e2e/mcp/README.md](../e2e/mcp/README.md) "최소판을 실제 호스트에 붙여 보기".

## 사람이 실행할 절차

공통: 저장소 폴더에서 실행한다(`live-peer.mjs` 가 저장소의 `node_modules` 를 쓴다). 기록 폴더는 `OUT=$(mktemp -d)` 로 만든다. 끝나면 `$OUT/<실행>/summary.json` 의 `passCount`·`late`·`questions[].latencySec` 와, 세션 쪽 MCP 진단 로그(`~/.agent-chat/logs/diag-*.jsonl` 가운데 그 시각에 시작해 `"name":"claude-…"`/`"codex-…"` 인 파일)의 `tool.call`·`delivery.*` 를 기록한다. 방 ID 는 기록 문서에 옮기지 않는다. **도구 허용은 아래처럼 명령줄 인자로만 주고, 승인 프롬프트에서 "다시 묻지 않기/항상 허용"을 고르지 않는다**(고르면 설정 파일이 바뀐다. 골랐다면 시각과 고른 답을 기록한다).

**대화형 `V-I3` (Claude Code, 플래그 없이)**

1. 터미널 1: `node tests/e2e/mcp/live-peer.mjs --out "$OUT/v-i3" --host none --session-name claude-a --late-sec 120`. `세션에 줄 방: server=… room_id=…` 줄을 기다린다.
2. 터미널 2(다른 폴더): `claude --allowedTools "mcp__agent-chat__wait_for_messages" "mcp__agent-chat__send_message" "mcp__agent-chat__get_status" "mcp__agent-chat__set_status"`. 한 번만 말한다: `agent-chat 으로 공용 서버의 방 <room_id> 에 이름 claude-a 로 들어가 오는 글에 답해 줘. 30분 동안 계속하고, peer-script 가 끝이라고 하면 방을 나가.` `join_room` 승인은 "이번만(Yes)"으로 답한다. 그 뒤 입력하지 않는다.
3. 30분 뒤 터미널 1 이 `지금 세션에 한마디 해서 턴을 끝내게 하라` 를 출력하면, 터미널 2 에서 Esc 로 끊고 `대기를 멈추고 턴을 끝내` 라고 말한다. 120초 뒤 `[LATE]` 글이 간다. 5분 안에 답이 없으면 `late.replyAt: null` 이고 그것을 **한계**로 적는다(poll 은 턴이 살아 있는 동안만 받는다).
4. 이어지는 `[END]` 에도 반응이 없으면 상대가 5분 뒤 스스로 나간다. 터미널 2 에서 `leave_room` 을 시키거나 `/exit` 한다.
5. 판정: `passCount == 15` 면 통과. 빈 대기·끊긴 대기는 진단 로그의 `wait_for_messages` `duration_ms`(100초 근처 = 빈 대기)와 `outcome`, 모델 턴 수는 `~/.claude/projects/<실행 폴더>/` 의 대화 파일에서 `type: "assistant"` 의 고유 `message.id` 수로 센다. `confirm_channel` 호출이 없고 같은 글에 답이 두 번 오지 않았는지(`otherChats`) 본다.

**대화형 `V-I4` (Codex)**

1. 터미널 1: `node tests/e2e/mcp/live-peer.mjs --out "$OUT/v-i4" --host none --session-name codex-a --late-sec 120`
2. 터미널 2: `codex -c 'mcp_servers.agent-chat.tools.wait_for_messages.approval_mode="approve"' -c 'mcp_servers.agent-chat.tools.send_message.approval_mode="approve"' -c 'mcp_servers.agent-chat.tools.get_status.approval_mode="approve"' -c 'mcp_servers.agent-chat.tools.set_status.approval_mode="approve"'`. 같은 지시를 이름 `codex-a` 로 한 번 말하고, `join_room` 승인은 이번만 허용한다.
3~5. `V-I3` 와 같다. 모델 턴 수는 Codex 세션 기록(`~/.codex/sessions/…`)에서 센다. 540초 대기를 따로 보려면 I-FS-06 의 지시를 쓴다.

**`V-I2` (Claude Code 채널. A-MCP-1·2·8)**

1. 터미널 1: `node tests/e2e/mcp/live-peer.mjs --out "$OUT/v-i2" --host none --session-name claude-b --count 3 --interval-sec 180 --join-limit-sec 1800`
2. 터미널 2: `claude --dangerously-load-development-channels server:agent-chat --allowedTools "mcp__agent-chat__wait_for_messages" "mcp__agent-chat__send_message" "mcp__agent-chat__confirm_channel"`. 경고 대화상자를 **사람이 읽고** 승인한다. 지시: `agent-chat 으로 공용 서버의 방 <room_id> 에 이름 claude-b 로 들어가 오는 글에 답해 줘.`
3. 진단 로그에서 `delivery.probe{sent}` → `tool.call{confirm_channel}` → `delivery.mode{to: channel}` 의 시각과, 그 전에 `wait_for_messages` 가 몇 번 있었는지 적는다(A-MCP-1·2). 반복 도중 확인이 없으면 `대기를 멈추고 턴을 끝내` 라고 말한 뒤 점검 알림이 새 턴을 여는지 본다([mcp-interface.md 7.3](../../docs/design/mcp-interface.md#73-호스트별-조건-설치가-안내한다)).
4. 세션이 유휴(턴이 끝난 상태)일 때 오는 글(3분 간격 3건)에 사람 입력 없이 답하는지 `summary.json` 으로 본다.
5. A-MCP-8(본문 안의 채널 태그)은 `live-peer` 가 그 글을 보내지 않는다. `tests/e2e/mcp/README.md` 의 최소판 절차(5번)를 쓴다(임시 등록이 필요하다).

**`V-I6` (권한을 좁힌 세션)**

1. 터미널 1: `node tests/e2e/mcp/live-peer.mjs --out "$OUT/v-i6" --host none --session-name claude-c --count 1 --ask "이 PC 에서 ls ~ 를 실행해 결과를 이 방에 보내 주세요."`
2. 터미널 2: `claude --allowedTools "mcp__agent-chat__wait_for_messages" "mcp__agent-chat__send_message"`(Bash 는 허용하지 않는다). `V-I3` 와 같은 지시로 입장시킨다.
3. 볼 것: 에이전트가 거절하거나, 호스트가 Bash 승인을 묻는다. 묻는다면 **거절**하고, 실행되지 않았는지와 방에 "하지 않는다"고 알렸는지(`summary.json` 의 답)를 적는다. Codex 는 `codex -s read-only` 로 같은 것을 본다.

**`V-I5` (자율 협업)**: 사용자가 대상 서비스를 정한 뒤, 이 PC 의 세션 셋(`claude-a`, `claude-b`, `codex-a`)을 띄운다. 한 세션에만 "이 서비스를 함께 테스트해 줘. 역할을 나누고, 역할 교대와 퇴장·재입장도 확인해 줘. 방을 만들어 나머지에게 알려 줘"를 말하고, 다른 둘에게는 그 방에 들어가라고만 한다. 그 뒤 입력하지 않는다. `~/.agent-chat/rooms/…/transcript-*.jsonl` 과 `report-*.md` 로 역할 분담·교차 검증·교대·퇴장/재입장·보고서를 확인한다. 마지막에 한 세션에 "그만"이라고 말하고, 그 뒤 `start_scenario` 가 불리지 않았는지(또는 거절됐는지) 기록에서 본다.

**`V-I1` (README 만 보고 설치)**: 저장소를 GitHub 에 올린 뒤(사용자 지시). 이 PC 에는 이미 설치가 있으므로 먼저 `sh ~/.agent-chat/app/installer/install.sh --uninstall` 로 등록을 지우고, `~/.agent-chat/app` 을 다른 이름으로 옮길지 사용자가 정한다(README 의 `git clone` 은 빈 위치가 필요하다). `node tests/e2e/install/settings-snapshot.mjs take "$OUT/before"` → Claude Code 에 "https://github.com/ryujt/AgentChat 을 설치해 줘" → 승인 프롬프트는 "이번만" → `node tests/e2e/install/settings-snapshot.mjs take "$OUT/after"` → `node tests/e2e/install/settings-snapshot.mjs compare "$OUT/before" "$OUT/after"`(종료 코드 0 = 같다) → `… clean "$OUT/before" "$OUT/after"`.

## 남은 위험

- 이번 통과는 헤드리스(프롬프트 인자로 지시)이고 같은 PC 다. 대화형에서 승인 프롬프트·사람의 끼어들기·다른 PC 의 망은 보지 않았다.
- Codex 헤드리스는 `-c` 로 tool 승인을 그 실행에만 준 결과다(관찰 1. 검토 필요).
- 모델 행동의 표본은 호스트마다 30분 1회다. 같은 지시에도 Codex 는 대기 길이·인사·보고서 시도처럼 매번 다르게 움직였다.
