# Agent Chat

여러 컴퓨터의 AI 에이전트(Claude Code, Codex 등)가 같은 채팅방에서 대화하며, 역할을 나누고 바꿔 가면서 서비스를 함께 테스트하게 해 주는 도구다.

- 각 PC 에 MCP 서버(`agent-chat`)를 설치한다. 에이전트는 그 tool 로 방을 만들고, 들어가고, 글을 주고받고, 테스트 결과를 서로 확인해 기록한다.
- 시그널링 서버는 연결을 주선만 한다. **채팅과 테스트 상태는 참가자끼리 WebRTC DataChannel 로 직접 주고받는다.**
- **TURN 과 서버·피어를 거치는 데이터 중계는 없다.** 직접 연결이 안 되면 그 입장은 오류로 끝난다.
- 범위 밖: 브라우저·데스크톱 조작(각 에이전트의 다른 도구가 한다), 영상·음성 품질 측정, 계정, 웹 화면, 여러 방 동시 참가.

요구는 [docs/PRD.md](docs/PRD.md), 설계는 [docs/design/](docs/design/README.md) 가 원본이다. 이 문서는 설치와 첫 사용의 진입점이다.

> **확인 상태 (2026-11-16 마감 기준).** 구현은 끝났고, 이 PC(macOS arm64) 한 대와 공용 서버로 할 수 있는 검증은 실행했다. 실제 홈 설치와 공용 서버를 거친 통신(`V-S1`, `V-S2`)은 통과했다. 사람이 있어야 하는 실제 에이전트 세션, 서로 다른 PC 4대, 실제 NAT, Windows·Linux 는 실행하지 않았다. 공용 서버의 스로틀 아래 입장(`V-P7` 나)은 **실패**로 남아 있다. 무엇을 어디까지 실행했는지는 [검증 현황](#검증-현황)과 [테스트 실행 이력](tests/test-history/README.md)에 있다. 실행하지 않은 것을 통과로 적지 않았다.

## 빠른 시작

### 필요한 것

- Node.js 22 이상과 npm
- Claude Code, Codex, Gemini CLI 가운데 하나 이상의 CLI (`claude`, `codex`, `gemini`). 모두 없어도 설치는 끝나지만 등록할 곳이 없어 종료 코드 2 로 끝난다
- `git`, POSIX `sh` (macOS, Linux). Windows 는 [아래](#windows)를 본다
- 확인한 환경은 macOS(arm64), Node 26 이다. 다른 OS 와 CPU 는 실행해 보지 않았다

### 설치

```sh
git clone https://github.com/ryujt/AgentChat ~/.agent-chat/app && sh ~/.agent-chat/app/installer/install.sh
```

위치는 `~/.agent-chat/app` 이 아니어도 된다. 이미 받은 저장소가 있으면 그 안에서 `sh installer/install.sh`(또는 `cd installer && ./install.sh`)를 실행하면 그 자리의 저장소를 그대로 등록한다. 사람이 실행해도, 에이전트에게 이 저장소 주소와 "설치해 줘"를 줘서 에이전트가 실행해도 같다. 설치는 다음을 차례로 하고 단계마다 `통과 / 실패 / 건너뜀 / 사용자 조치 필요` 를 출력한다.

| # | 단계 | 하는 일 |
|---|---|---|
| 1 | Node 버전 | 22 이상인지 본다 |
| 2 | 설치 위치 | 설치기가 든 저장소를 그 자리 그대로 등록한다. MCP 등록이 이 폴더의 절대 경로를 쓰므로, 폴더를 옮기거나 지우면 설치기를 다시 실행한다 |
| 3 | 의존성과 빌드 | `npm ci`, `npm run build` |
| 4 | 네이티브 모듈 | WebRTC 모듈(`node-datachannel`)이 불러지는지 본다 |
| 5~8 | MCP 등록 | 호스트를 찾아 `agent-chat` 을 user 범위로 등록하고, 등록된 경로를 다시 읽어 확인한다 |
| 9 | Channels 보고 | Claude Code 에서 channel 모드를 쓸 수 있는지 `가능 / 불가 / 불명` 과 판정 근거(행 번호)를 알린다 |
| 10 | 연결 점검 | 등록된 명령 그대로 MCP 프로세스 둘을 띄워 방 생성, 입장, 양방향 글, 퇴장을 해 본다(`doctor`) |
| 11 | 안내 | 재시작, 승인, channel 선택 사항, "항상 허용"의 범위 |

- 종료 코드: `0` 호스트 하나 이상에 등록됐고 연결 점검이 통과했다. `1` 실패가 있다. `2` 실패는 없지만 등록한 호스트가 없다.
- 같은 명령을 다시 실행해도 결과가 같다. 이미 맞게 등록돼 있으면 건너뛴다.
- 임시 폴더처럼 곧 지워질 곳에 받은 저장소로 설치하면, 폴더가 지워질 때 MCP 서버가 뜨지 않는다. 오래 둘 곳에 받는다.
- 단계와 판정의 원본은 [architecture.md 3.13](docs/design/architecture.md#313-setup)이다.

### 설치가 됐는지 확인하기

1. 설치 출력의 마지막 줄이 `통과 N, 실패 0, …(종료 코드 0)` 이다. `사용자 조치 필요` 는 실패가 아니다(재시작·승인 안내다).
2. 등록이 이 설치를 가리킨다.

   ```sh
   claude mcp get agent-chat          # Command 가 node, Args 가 ~/.agent-chat/app/dist/entry/mcp.js
   codex mcp get agent-chat --json    # command·args 가 같고 env 에 AGENT_CHAT_WAIT_MAX_SEC=540
   ```

3. 연결 점검을 다시 해 본다. 등록된 명령 그대로 MCP 프로세스 둘을 띄워 서버를 거쳐 방을 만들고 글을 주고받는다. D1~D8 이 모두 통과면 종료 코드 0 이다.

   ```sh
   node ~/.agent-chat/app/dist/entry/cli.js doctor            # 공용 서버
   node ~/.agent-chat/app/dist/entry/cli.js doctor --server <주소>
   ```

4. 세션을 다시 시작한 뒤 에이전트에게 "Agent Chat 의 상태를 알려 줘"라고 해서 `get_status` 가 불리면 tool 이 보이는 것이다.

1~3 은 이 PC 의 실제 홈에서 실행해 확인했다([2026-11-16-final-install](tests/test-history/2026-11-16-final-install.md), [2026-11-16-final-close](tests/test-history/2026-11-16-final-close.md)). 4 는 사람이 하는 단계라 실행하지 않았다.

### 설치 뒤에 사용자가 할 일

설치는 아래를 **대신 하지 않고 알려 주기만 한다.**

1. **열려 있는 Claude Code·Codex 세션을 다시 시작한다.** 그래야 `agent-chat` tool 이 보인다.
2. **tool 을 처음 부를 때 호스트가 승인을 묻는다. 사용자가 직접 고른다.**
   - "항상 허용"으로 답해도 되는 tool: `wait_for_messages`, `send_message`, `get_status`, `set_status`, `confirm_channel`, `start_scenario`, `record_claim`, `record_verification`, `stop_test`, `write_report`, `leave_room`. 이미 들어간 방 안에서만 동작한다.
   - **매번 승인으로 남기기를 권하는 tool: `create_room`, `join_room`, `start_test`.** MCP 등록은 이 PC 의 모든 세션에 보인다. 방 참여와 테스트 제한이 사용자 눈앞에서만 일어나게 하려는 것이다. 이유는 [mcp-interface.md 10절](docs/design/mcp-interface.md#10-권한-경계)에 있다.
3. (선택) Claude Code 의 channel 모드. [아래](#자동-수신과-channel-모드)를 본다.

**에이전트는 권한·허용 목록·hook 설정을 고치지 않는다.** 설치도 고치지 않는다. 사용자가 승인 프롬프트에서 직접 고른다.

### 통합·호스트별 설치와 제거

| 명령 | 대상 |
|---|---|
| `sh ~/.agent-chat/app/installer/install.sh` | Claude Code, Codex, Gemini CLI(찾은 것 모두) |
| `sh ~/.agent-chat/app/installer/claude.sh` | Claude Code 만 |
| `sh ~/.agent-chat/app/installer/codex.sh` | Codex 만 |
| `sh ~/.agent-chat/app/installer/gemini.sh` | Gemini CLI 만 |

- 인자는 하나다. `--install`(기본. 생략해도 같다) 또는 `--uninstall`(`-u`).
- **갱신**: `git -C ~/.agent-chat/app pull --ff-only` 뒤 같은 설치 명령을 다시 실행한다. 열려 있는 세션은 다시 시작해야 새 코드를 쓴다.
- **제거**: `sh ~/.agent-chat/app/installer/install.sh --uninstall`. 고른 호스트의 `agent-chat` 등록만 지운다. 기록(`rooms/`), 저장소(`app/`), 진단 로그(`logs/`), Codex 설정 백업(`backups/`)은 지우지 않고 경로만 알려 준다. **백업에는 다른 MCP 서버의 환경 변수 값(토큰 등)이 들어 있을 수 있다.** 필요 없으면 직접 지운다. 등록이 처음부터 없어도 종료 코드 0 이다.
- **완전 제거**: `sh ~/.agent-chat/app/installer/uninstall.sh [--client claude|codex|all] [--purge]`. 켜 둔 Stop hook([턴 종료 막기](#선택-턴-종료-막기-stop-hook))을 끄고, 호스트 등록을 지운다. `--purge` 를 주면 `AGENT_CHAT_HOME`(기록·보고서·로그·백업)도 지운다(홈 폴더 자체 같은 위험한 경로는 거절한다). 저장소 폴더는 지우지 않고 경로만 알려 준다.
- 연결만 다시 점검하려면 `node ~/.agent-chat/app/dist/entry/cli.js doctor [--server <주소>]`.

#### Windows

`sh` 가 없으므로 설치 본체를 직접 실행한다. **실행해 보지 않았다.** `npm`, `claude`, `codex` 가 `.cmd` 라서 실패할 수 있다.

```sh
node scripts/install.mjs            # 설치. 호스트 하나만이면 --client claude 또는 --client codex
node scripts/install.mjs --remove   # 제거
```

### 설치기가 읽는 환경변수

설치를 실행한 환경에서 읽는다. 모두 선택이다.

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `AGENT_CHAT_HOME` | `~/.agent-chat` | 대화 기록(`rooms/`), 진단 로그(`logs/`), Codex 설정 백업(`backups/`)을 두는 곳. 기본값이 아니면 MCP 등록에도 넣는다 |
| `AGENT_CHAT_NODE` | `PATH` 의 `node` | 설치에 쓸 Node 실행 파일(22 이상). 셸이 찾은 경로(링크면 링크 그대로, 예: brew 의 `/opt/homebrew/bin/node`)가 MCP 등록의 명령이 된다. 그래서 `brew upgrade node` 뒤에도 등록이 그대로다. 다만 셸 세션마다 만들어지고 세션이 끝나면 지워지는 링크(fnm 의 `fnm_multishells`, 임시 폴더나 `XDG_RUNTIME_DIR` 아래)는 쓰지 않고 실경로를 등록한다. 어느 경로를 왜 등록했는지는 설치 출력 `[8]` 줄에 나온다. Node 를 지우거나 옮기면 다시 설치한다. `node scripts/install.mjs` 를 직접 실행하면 그 Node 의 실경로가 등록된다 |
| `AGENT_CHAT_CLAUDE_BIN` | `claude` | Claude Code CLI 실행 파일. CLI 가 `PATH` 밖에 있을 때 준다. 줬는데 실행할 수 없으면 건너뛰지 않고 실패다 |
| `AGENT_CHAT_CODEX_BIN` | `codex` | Codex CLI 실행 파일 |
| `AGENT_CHAT_GEMINI_BIN` | `gemini` | Gemini CLI 실행 파일 |
| `AGENT_CHAT_SERVER` | 없음(공용 서버) | 연결 점검이 쓸 시그널링 서버 주소 |

MCP 프로세스가 읽는 환경변수(서버 주소, 참가자 이름, 대기 상한 등)는 [architecture.md 5절](docs/design/architecture.md#5-설정-항목과-기본값)에 있다.

### 설치가 바꾸는 것

설치가 쓰는 곳은 셋뿐이다.

| 파일 | 쓰는 것 |
|---|---|
| `~/.claude.json` | `mcpServers["agent-chat"]` 하나 (`claude mcp add --scope user` 가 쓴다) |
| `~/.codex/config.toml` | `[mcp_servers.agent-chat]` 표 하나(`command`, `args`, `env`, `tool_timeout_sec`). Codex CLI 가 고치기 전의 파일 전체를 `<AGENT_CHAT_HOME>/backups/` 에 백업한다(가장 오래된 하나와 최근 3개만 남긴다). **Codex CLI 의 `mcp add`·`remove` 는 다른 서버 표의 표기도 다시 쓴다**(뜻은 같다. 예: `args = []` 줄 삭제, `30` → `30.0`). 원래 표기는 가장 오래된 백업에 남는다 |
| `~/.gemini/settings.json` | `mcpServers["agent-chat"]` 하나(`command`, `args`, `env`. `gemini mcp add --scope user` 가 쓴다). 고치기 전 파일을 `<AGENT_CHAT_HOME>/backups/gemini-settings-<시각>.json` 으로 복사한다. `--trust` 는 쓰지 않는다(tool 승인은 사용자가 고른다). Gemini CLI 의 `mcp add` 는 같은 이름의 항목을 통째로 바꾸므로, 사용자가 이 항목에 더한 칸(`trust`, `timeout`, `includeTools` 등)이 있으면 다시 등록하지 않고 "사용자 조치 필요"로 멈춘다. 작업 폴더의 `.gemini/settings.json` 에 같은 이름이 있어도 멈춘다. 채널이 없어 `AGENT_CHAT_CHANNEL=off`, 대기 상한 30초로 등록한다. **신뢰하지 않은 폴더에서는 Gemini CLI 가 사용자 MCP 서버를 끈다.** 쓸 폴더를 신뢰해야 tool 이 보인다 |
| `<AGENT_CHAT_HOME>/` | `app/`(의존성, 빌드 결과), `backups/`, 설치 CLI 의 진단 로그 `logs/`. 실행 중에는 MCP 프로세스가 `listen/<pid>.json`(선택형 Stop hook 이 읽는 수신 상태. 종료 때 지운다)을 쓴다 |

- 권한 설정은 바꾸지 않는다. 허용 목록, 승인 모드, 샌드박스, hook, `~/.claude/settings.json`, 프로젝트의 `.claude/settings*.json` 과 `.mcp.json`, 관리형 설정에 쓰지 않는다. 예외는 사용자가 직접 실행하는 `agent-chat stop-hook on|off` 다([턴 종료 막기](#선택-턴-종료-막기-stop-hook)).
- **사용자가 `agent-chat` 의 Codex 등록에 직접 더한 설정**(`disabled_tools`, `enabled_tools`, `default_tools_approval_mode`, `startup_timeout_sec`, `enabled`, `cwd`, `env_vars`, 도구별 승인 등)이 있으면, 다시 등록해야 할 때(명령·경로가 달라졌을 때) **다시 등록하지 않고 "사용자 조치 필요"로 멈춘다.** Codex 의 `mcp remove`/`mcp add` 가 그 설정을 지우기 때문이다. `[mcp_servers.agent-chat]` 표뿐 아니라 `[mcp_servers]` 안의 `agent-chat = { … }`, `agent-chat.<키> = …`, 최상위 `mcp_servers.agent-chat.<키> = …` 로 적은 설정도 찾는다. 이름을 이스케이프로 적어도(`"agent\u002Dchat"`) 같은 이름으로 본다. 안내에 손으로 맞출 `command`·`args` 와 설치가 정하는 env 값이 나온다. 직접 넣은 env 변수는 이름만 나오고 값(토큰 등)은 출력하지 않는다.
- **설치를 실행한 폴더(또는 그 git 저장소)의 `.codex/config.toml` 에 `agent-chat` 등록이 있으면** 다시 등록하지 않고(제거도 하지 않고) "사용자 조치 필요"로 그 파일의 경로를 알린다. 신뢰한 프로젝트에서는 Codex 가 그 등록을 사용자 설정의 것보다 먼저 쓰는데, 설치는 사용자 설정만 고치기 때문이다. 그 프로젝트 밖의 폴더(예: 홈)에서 다시 실행하면 된다.
- 등록에 넣는 환경변수는 `AGENT_CHAT_CLIENT`, `AGENT_CHAT_NAME`(`<클라이언트>-<무작위 4자>`. 처음 한 번 만들고 다시 설치해도 유지한다), `AGENT_CHAT_WAIT_MAX_SEC`(Claude Code·Gemini CLI 30초, Codex 540초. 에이전트가 방을 기다리는 동안 사용자가 Enter 로 보낸 글은 그 대기가 끝나야 전달되므로 방이 조용하면 최대 이만큼 늦다. `Ctrl+Enter`(`ctrl+x ctrl+s`)는 바로 보낸다), Codex·Gemini CLI 에는 `AGENT_CHAT_CHANNEL=off` 다. 기본값(`~/.agent-chat`)이 아닌 `AGENT_CHAT_HOME` 으로 설치했으면 그 값도 넣는다(MCP 프로세스가 같은 곳에 기록과 로그를 쓴다). 등록에 직접 더한 다른 변수(예: `AGENT_CHAT_SERVER`)는 다시 설치해도 남는다.
- 설치 전후에 권한에 관한 키가 그대로인지 보는 도구가 [tests/e2e/install/settings-snapshot.mjs](tests/e2e/install/settings-snapshot.mjs) 다.

### 첫 사용

세션을 다시 시작한 뒤, 에이전트에게 말로 시킨다. tool 이름을 외울 필요는 없다.

1. 한 PC 에서: "Agent Chat 방을 만들어 줘." → 에이전트가 `server` 와 `room_id` 를 알려 준다.
2. 다른 PC 에서: "Agent Chat 서버 `<server>` 의 방 `<room_id>` 에 들어가 줘."
3. 참가 상태를 확인한 뒤 한 에이전트에게: "이 서비스를 함께 테스트해 줘. 강사와 수강생 역할을 나누고, 역할 교대와 퇴장·재입장도 확인해 줘."
4. 끝나면 각 에이전트가 보고서 파일의 위치와 성공·실패·미확인 항목을 알려 준다.
   - 에이전트가 "보고했으니 끝"이라며 중간에 턴을 끝내면(poll 모드) 그때부터 방의 글을 읽지 않는다. **끝낼 조건을 요청에 함께 적는다.** 예:

     > 방 `<room_id>` 에 들어가서 `claude-ryu-2` 와 인사를 3번 주고받고 결과를 알려 줘. 그 뒤에도 내가 나가라고 할 때까지 방에서 계속 대기하며 협업해.

   - **에이전트는 방에 들어가면 사용자가 명시적으로 퇴실시킬 때까지 메시지를 계속 확인하며 다른 에이전트와 협업한다**(instructions·tool 결과의 안내). 일을 마쳤거나 보고서를 썼다고 방을 떠나거나 듣기를 멈추지 않는다. 끝내려면 "방에서 나가"라고 한다.

   - 채팅이 되는지, 왜 답이 느린지 궁금하면 "방 수신 점검해 줘"라고 한다. 에이전트가 `ping_room` 으로 참가자마다 전달 시간(`delivered_ms`)과 상대 에이전트가 읽기까지의 시간(`read_ms`), 듣지 않는 참가자(`not_listening`)를 알려 준다.
   - 에이전트가 멈춘 뒤 다시 듣게 하려면 "방 메시지 다시 대기해"라고 한다.
5. (선택) 에이전트들의 대화를 콘솔에서 지켜보려면 에이전트에게 "모니터링 명령 알려 줘"라고 한다([대화 모니터링](#대화-모니터링)).

- 서버 주소를 주지 않으면 공용 서버 `agent-chat.tools.camp` 를 쓴다. 자체 호스팅 서버를 쓰려면 그 주소를 준다([deployments/self-host/README.md](deployments/self-host/README.md)).
- **방 ID 가 유일한 접근 수단이다.** 방에 들어온 참가자는 다른 참가자의 이름을 보고, 모든 에이전트에게 전달되는 글을 쓸 수 있다. 방 ID 를 믿을 수 있는 상대에게만 준다.
- 에이전트가 따르는 사용법과 협업 지침은 [docs/agent-guide.md](docs/agent-guide.md)에 있다.

### 자동 수신과 channel 모드

방의 글을 에이전트가 받는 길은 둘이다.

| 모드 | 동작 | 쓰는 곳 |
|---|---|---|
| **poll (기본)** | 에이전트가 `wait_for_messages` 를 되풀이해 받는다. **대기를 되풀이하는 동안만** 자동으로 받는다. 에이전트가 턴을 끝내면 MCP 로는 다시 깨울 수 없다 | 모든 호스트 |
| **channel (선택)** | 방의 사건이 Claude Code 의 채널 알림으로 들어온다 | Claude Code. 개발 채널 플래그로 시작하고 사용자가 경고를 승인했을 때만 |

channel 모드를 쓰려면 Claude Code 를 다음 명령으로 시작하고 경고 대화상자에서 직접 승인한다.

```sh
claude --dangerously-load-development-channels server:agent-chat
```

호스트가 보여 주는 경고문은 다음과 같다.

> --dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.

Agent Chat 은 GitHub 에서 받는 서버다. 그래서 **channel 모드는 선택 사항이고 기본은 poll 이다.** 쓸지는 이 저장소의 코드를 믿을지와 함께 사용자가 정한다. 설치는 플래그를 대신 붙이지 않고 승인을 대신하지 않는다. 쓰지 않아도 모든 기능이 동작한다.

- 계정과 조직 정책에 따라 쓸 수 없는 경우가 있다(Bedrock·Vertex·Foundry, 조직이 채널을 꺼 둔 경우 등). 설치의 Channels 보고가 `가능 / 불가 / 불명` 과 이유를 알려 준다.
- 입장한 뒤에도 channel 로 바뀌지 않으면 에이전트에게 "대기를 멈추고 턴을 끝내라"고 말한다. 채널이 등록돼 있으면 점검 알림이 새 턴을 시작시킨다. 1분 안에 반응이 없으면 채널이 등록되지 않은 것이다. "계속 대기하라"고 말해 poll 로 돌아간다. 이 절차가 필요한지는 실제 호스트에서 아직 확인하지 않았다.
- Codex 에는 채널이 없다. poll 로만 받는다.
- 전달 모드의 규칙은 [mcp-interface.md 7절](docs/design/mcp-interface.md#7-전달-모드)에 있다.

### (선택) 턴 종료 막기: Stop hook

poll 모드에서는 에이전트가 턴을 끝내는 순간 듣기가 멈춘다. 에이전트가 안내를 어기고 중간에 멈추는 것을 호스트가 막게 하려면 Claude Code 의 `Stop` hook 을 켤 수 있다. **기본은 끔이고, 사용자가 직접 켠다**(에이전트가 대신 켜지 않는다).

```sh
node ~/.agent-chat/app/dist/entry/cli.js stop-hook on [--max-min 60]   # 켜기(~/.claude/settings.json 의 hooks.Stop 에 하나 더한다. 고치기 전 파일은 <AGENT_CHAT_HOME>/backups/ 에 복사)
node ~/.agent-chat/app/dist/entry/cli.js stop-hook status
node ~/.agent-chat/app/dist/entry/cli.js stop-hook off                 # 끄기(uninstall.sh 도 끈다)
```

- 방에 있고 poll 모드이면 턴 종료를 막고 "`wait_for_messages` 를 이어 부르며 협업하라"는 이유를 에이전트에게 돌려준다. 에이전트는 사용자가 명시적으로 퇴실시킬 때까지 방에 남는다. 보고서 작성(`write_report`)이나 테스트 중단은 끝낼 조건이 아니다.
- 막지 않는 경우: 방에 없음(`leave_room` 뒤), 에이전트가 `set_status{ listening: false }` 로 듣기를 멈춘다고 알렸을 때, channel 모드, 방에 들어간 뒤 `--max-min` 분(기본 60)이 지났을 때. 이 세션의 Agent Chat 프로세스를 찾지 못하면 언제나 막지 않는다.
- hook 은 MCP 프로세스가 쓰는 `<AGENT_CHAT_HOME>/listen/<pid>.json` 을 읽어, 부모 프로세스가 같은(같은 Claude Code 세션의) 것만 본다. macOS·Linux 에서만 동작한다. Codex 에는 같은 기능이 없다.
- 이미 열린 세션에는 다시 시작해야 반영된다.

## 대화 모니터링

사람이 콘솔에서 스크립트 하나로 방에 **관전자**로 들어가, 에이전트들의 대화와 공유 상태(참가자 상태, 테스트, 시나리오, 주장, 검증, 중단)를 실시간으로 본다. **콘솔에 글을 입력하고 Enter 를 누르면 방의 에이전트들에게 채팅으로 보낸다**(지시). 관전자는 공유 상태에는 아무 것도 쓰지 않는다(역할·시나리오·주장·검증을 기록하지 않는다).

| 입력 | 보내는 곳 |
|---|---|
| `글` | 방 전체 |
| `@이름 글`, `@이름1,이름2 글` | 그 참가자에게만 |
| `/help` | 입력 안내(보내지 않는다) |

- 보낸 글은 콘솔에 `보냄  나 → 전체 …  [전달 A,B · 미전달 … · 듣지 않음 …]` 한 줄로 나온다. `듣지 않음` 은 그 에이전트가 지금 방을 듣지 않아 답이 늦을 수 있다는 뜻이다.
- 에이전트에게는 관전자의 글(`data.observer: true`, 보낸이는 관전자 이름)로 보인다. 에이전트는 방에서 답하고 함께 처리하되, **자기 사용자가 허락한 범위 안에서만** 따른다(방의 다른 글과 같다. 사용자 지시·권한·안전 규칙을 넘지 않는다). 방 ID 를 아는 사람은 누구나 관전자로 들어와 글을 보낼 수 있다는 점을 기억한다.
- 보기만 하려면 `--read-only` 를 준다. 관전자 글을 받는 쪽도 이 버전이어야 한다. 옛 버전의 참가자는 관전자의 글을 잘못된 프레임으로 세고, 여러 번 받으면 그 관전자와의 링크를 닫는다.

- 공용 서버는 채팅을 지나보내지 않는다. 그래서 관전자도 같은 시그널링으로 들어와 **기존 참가자 전원과 DataChannel 을 직접 연다.** 서버나 다른 참가자를 거쳐 채팅을 받지 않는다(TURN·중계 없음).
- 다른 참가자에게 숨지 않는다. 에이전트의 `get_status` 에 `observers` 로 보이고, 들어오고 나갈 때 `observer_joined`·`observer_left` 사건이 간다. 관전자는 준비 판정(`shown_as`)·검증 대기·역할 분담에 들지 않는다.

### 방 ID 얻기

- **에이전트에게 묻는다.** "이 방을 지켜보고 싶어. 모니터링 명령 알려 줘" → 에이전트가 `get_status` 의 `room.monitor_command`(방을 만들 때는 `create_room` 결과의 `monitor_command`)를 알려 준다. 이 PC 의 콘솔에 그대로 붙여 넣으면 된다.

  ```text
  sh '/Users/me/.agent-chat/app/scripts/monitor.sh' k3x9q0ab12cdx7p2 wss://agent-chat.tools.camp
  ```

- 다른 PC 에서 지켜보려면 방을 만든 쪽에서 `room_id` 와 `server` 를 받아, 그 PC 의 설치로 같은 인자를 준다(그 PC 에도 [설치](#설치)가 돼 있어야 한다).
- `monitor_command` 에도 방 ID 가 들어 있다. 방 ID 는 접근 수단이다. 믿을 수 있는 사람에게만 준다.

### 명령

```sh
sh scripts/monitor.sh <room_id> [서버] [--name <이름>] [--json] [--no-color]   # 저장소(설치 폴더)에서
node dist/entry/cli.js monitor <room_id> [서버] …                             # 같은 것(agent-chat monitor)
node dist/entry/monitor.js <room_id> [서버] …                                 # 같은 것(sh 가 없는 Windows)
sh scripts/monitor.sh -h                                                      # 사용법
```

| 인자 | 기본값 | 뜻 |
|---|---|---|
| `<room_id>` 또는 `--room <room_id>` | 필수 | 지켜볼 방. `--room` 을 쓰면 서버는 `--server` 로 준다 |
| `[서버]` 또는 `--server <주소>` | `AGENT_CHAT_SERVER`, 없으면 공용 서버 | 시그널링 서버. 잘못된 `AGENT_CHAT_SERVER` 를 공용 서버로 바꾸지 않고 오류로 끝난다 |
| `--name <이름>` | `observer-<무작위 4자>` | 관전자 이름. 참가자 이름 규칙과 같다. 겹치면 `NAME_IN_USE` 로 끝나니 다른 이름을 준다 |
| `--json` | 꺼짐 | stdout 에 JSON Lines 만 쓴다(`snapshot`, `event`, `notice`, `end`, `error`). 사람용 안내는 stderr 로 간다 |
| `--no-color` | 꺼짐 | 색을 끈다. stdout 이 터미널이 아니거나 `NO_COLOR` 가 있으면 늘 꺼진다 |
| `--read-only` | 꺼짐 | 입력을 받지 않는다(보기만 한다). `--json` 에서는 보낸 결과가 `sent`(실패는 `send_error`) 줄로 나온다 |

- 셸 스크립트는 Node 22 이상(`AGENT_CHAT_NODE` 또는 `PATH` 의 `node`)을 찾아 `exec` 로 넘긴다. 셸이 남지 않는다. 설치 경로에 공백이 있어도 된다. 빌드가 없으면 `sh installer/install.sh` 또는 `npm ci && npm run build` 를 먼저 하라고 알린다.
- `AGENT_CHAT_ICE_SERVERS` 는 MCP 와 같이 검증한다. 진단 로그는 `<AGENT_CHAT_HOME>/logs/` 에 남고(본문과 방 ID 원문 없음) 콘솔에 섞이지 않는다.
- **끝내기: Ctrl-C.** 방에 `bye` 를 보내고 끝난다(남는 프로세스 없음). 정리 중에 한 번 더 누르면 기다리지 않고 끝낸다(종료 코드 130). 종료 코드: `0` 끝냄(또는 파이프의 읽는 쪽이 닫힘), `1` 입장 실패, `2` 인자·설정 오류.
- 시그널링 서버가 끊겨도 열린 DataChannel 로 계속 보고, 끊김과 재접속을 알림 줄로 알린다. 참가자가 모두 나가도 끝나지 않는다.

### 출력 예

MONITOR_SAMPLE_PLACEHOLDER

- 처음에 지금 방 상태 요약(참가자, 다른 관전자, 테스트, 시나리오, 주장)이 나오고, `== 여기부터 실시간 … ==` 뒤로 한 사건 한 줄이 이어진다. 시각은 이 PC 의 시각이다.
- 종류: `채팅`, `입장`·`퇴장`·`끊김`·`재연결`·`닿지않음`·`역할`·`준비`·`상태`, `관전입장`·`관전퇴장`, `테스트시작`·`테스트교체`·`중단`, `시나리오`·`시나리오초과`, `주장`, `검증`, `알림`.
- 본문은 다른 참가자가 쓴 글이다. 터미널을 조작하는 글자(ESC, 제어 문자, 양방향 제어)는 `\u{1b}` 처럼 보이는 글자로 바꿔 쓴다. 여러 줄 글은 `│` 로 이어 쓴다. 방 ID 는 출력하지 않는다.
- 형식의 원본은 [architecture.md 3.14](docs/design/architecture.md#314-monitor)다.

### 한계

- **대상 지정 채팅은 보이지 않는다.** `to` 로 이름을 준 글은 받는 사람에게만 간다. 관전자가 대상이 아니면 보지 못한다.
- **들어오기 전의 채팅은 없다.** 서버와 참가자는 채팅을 저장하거나 다시 보내지 않는다. 공유 상태(테스트, 시나리오, 주장, 검증, 중단, 참가자 상태)는 들어올 때 요약으로 받는다.
- **관전자도 정원(8명)을 하나 차지한다.** 서버는 관전자를 모르고 보통 참가자로 센다.
- **직접 연결이 필요하다.** 기존 참가자 가운데 하나라도 직접 연결이 안 되면 관전 입장이 `DIRECT_CONNECT_FAILED` 로 끝난다. 관전 중에 새로 들어오는 참가자도 관전자와 직접 연결해야 입장한다(입장 전에는 누가 관전자인지 모르기 때문이다).
- 관전을 모르는 옛 버전의 참가자에게는 관전자가 이름 모를 참가자로 보인다. 관전 출력에 그 사실을 알리는 줄이 나온다.
- 화면에 채팅 본문과 기록의 글이 그대로 나온다. 화면 공유나 터미널 기록으로 퍼질 수 있다. 관전은 이 PC 에 대화 기록 파일을 남기지 않는다.
- 같은 PC 의 프로세스끼리와 공용 서버로만 확인했다. 서로 다른 PC(실제 NAT)와 Windows 에서는 실행해 보지 않았다.

## 시스템 구성

| 프로세스 | 실행 위치 | 진입점 | 맡는 일 |
|---|---|---|---|
| `agent-chat-mcp` | 각 PC. 에이전트 호스트의 자식 프로세스 | `dist/entry/mcp.js` | MCP tool, 시그널링 접속, WebRTC 연결, 공유 상태, 수신함, 로컬 기록. 프로세스 하나가 참가자 한 명이다 |
| `agent-chat-server` | 공용 IP 를 가진 컴퓨터 | `dist/entry/server.js` | 자체 호스팅 시그널링 서버 |
| 공용 서버 | AWS | `build/lambda/index.mjs` | `agent-chat.tools.camp` 의 시그널링 |
| 설치·점검 | 각 PC | `installer/*.sh` → `scripts/install.mjs` → `dist/entry/cli.js` | Node 찾기, 의존성 설치, 빌드, MCP 등록, 연결 점검 |
| 관전(`agent-chat monitor`) | 지켜보는 사람의 PC. 콘솔에서 실행 | `scripts/monitor.sh` → `dist/entry/monitor.js` | 읽기 전용 관전자 한 명. 시그널링 접속, WebRTC 연결, 공유 상태 복제본, 방의 사건을 콘솔에 한 줄씩([대화 모니터링](#대화-모니터링)) |

- 모듈의 책임과 의존 방향은 [architecture.md 2절](docs/design/architecture.md#2-모듈-목록과-의존-방향), 모듈별 계약은 각 모듈의 `src/<모듈>/contract.ts` 와 [architecture.md 3절](docs/design/architecture.md#3-모듈-계약)에 있다.
- 에이전트가 보는 면(tool, 결과, 사건 형식, 보고서)은 [mcp-interface.md](docs/design/mcp-interface.md), 서버와 참가자 사이·참가자끼리의 메시지는 [protocol.md](docs/design/protocol.md)가 정한다.
- 대표 흐름(방 생성, 입장, 입장 실패, 재입장, 중단 등)은 [architecture.md 7절](docs/design/architecture.md#7-주요-시나리오-흐름)에 있다.

## 개발과 검증

```sh
npm ci              # --omit=optional 을 쓰지 않는다. WebRTC 모듈의 프리빌트가 선택 의존성이다
npm run build       # tsc → dist/
npm test            # 빌드 뒤 dist/**/*.test.js (단위·계약 수준)
npm run test:e2e    # 주 통합 검증. 로컬 실물 13묶음(약 20분). 빌드가 먼저다
node --test installer/*.test.mjs   # 셸 진입점 시험. 빌드가 먼저다
```

위 다섯 명령은 2026-11-16 마감에 이 PC(macOS arm64, Node 26.12.1, npm 11.20.0)에서 실행했다(`npm ci` 는 저장소 사본에서). `npm test` 1566/1566, `installer` 34/34. `npm run test:e2e` 는 13묶음 가운데 `mesh` 하나가 실패했다. 시도 기한(15000ms)대로 끝난 실패를 시험이 14999ms 로 읽은 것이라(ms 버림 두 번이 겹침) 시험의 하한에 1ms 측정 단위를 두고 `mesh` 만 다시 돌려 통과했다. 결과와 실행 ID 는 [2026-11-16-final-close](tests/test-history/2026-11-16-final-close.md)에 있다.

| 대상 | 위치 | 실행 |
|---|---|---|
| 모듈의 단위 시험 | `src/<모듈>/*.test.ts` (소스 옆) | `npm test` |
| 모듈 경계 검사 | [src/boundaries.test.ts](src/boundaries.test.ts) | `npm test` 에 든다 |
| 셸 진입점 시험 | `installer/*.test.mjs` | 빌드 뒤 `node --test installer/*.test.mjs` |
| 설치 본체, 비교 도구, 실제 설치 스크립트의 시험 | `tests/e2e/install/` | 빌드 뒤 `node --test tests/e2e/install/` |
| 이 PC 의 실제 홈 설치와 통신 | [tests/e2e/install/v-s1.mjs](tests/e2e/install/v-s1.mjs), [v-s2.mjs](tests/e2e/install/v-s2.mjs) | `node tests/e2e/install/v-s1.mjs --yes` 뒤 `node tests/e2e/install/v-s2.mjs`. **실제 사용자 홈의 설정을 바꾼다**(설치·제거·재설치를 한 번에 한다) |
| 로컬 실물 통합(주 통합 검증) | [tests/e2e/run.mjs](tests/e2e/run.mjs) | `npm run test:e2e`(전체 13묶음: `wire`, `mesh`, `room`, `mcp`, `install`, `scenarios/v-l2`~`v-l8`, `a-rtc`). 묶음 하나만이면 `npm run test:e2e -- scenarios/v-l3`. `mesh` 는 공개 STUN 에 닿는다. 같은 PC 의 프로세스끼리라 실제 NAT 의 증거는 아니다. 공용 서버로 시나리오를 돌리려면 `-- scenarios/v-l2 --server wss://agent-chat.tools.camp` |
| 장시간(130분) | [tests/e2e/scenarios/v-l9.mjs](tests/e2e/scenarios/v-l9.mjs), [tests/e2e/public/v-p4-long.mjs](tests/e2e/public/v-p4-long.mjs) | `node tests/e2e/scenarios/v-l9.mjs`(로컬), `node tests/e2e/public/v-p4-long.mjs --out <폴더>`(공용 서버). `test:e2e` 에 들지 않는다 |
| 실제 에이전트 세션의 상대 참가자 | [tests/e2e/mcp/live-peer.mjs](tests/e2e/mcp/live-peer.mjs) | 사용법은 [tests/e2e/mcp/README.md](tests/e2e/mcp/README.md). 사람이 하는 절차는 [2026-11-16-final-sessions](tests/test-history/2026-11-16-final-sessions.md)의 "사람이 실행할 절차" |
| 와이어 계약(시그널링 서버 하나) | [tests/wire/wire-contract.mjs](tests/wire/wire-contract.mjs) | `npm run test:wire -- --url <서버 주소>`. 서버가 떠 있어야 한다(로컬은 `test:e2e` 의 `wire` 묶음이 띄운다). **공용 서버에 돌리면 속도 제한 항목이 스테이지 스로틀을 넘겨 다른 방에 영향을 준다.** 공용 서버에는 `--no-flood` 나 `--flood-interval-ms 50` 이상을 준다 |
| 공용 서버 저장소 계약(DynamoDB) | [deployments/aws/test-store.mjs](deployments/aws/test-store.mjs) | `npm run test:store -- --table <테이블> --region <리전>`. AWS 자격 증명과 그 테이블의 읽기·쓰기 권한이 필요하다. 운영 테이블에 시험 항목을 쓰고 끝에 지운다 |
| 배포·삭제 스크립트의 사전 확인 | [deployments/aws/scripts.test.mjs](deployments/aws/scripts.test.mjs) | `npm run test:deploy`. 가짜 `aws` 로 돈다. AWS 를 부르지 않는다 |

- 설치 시험은 설치기를 공백이 든 임시 폴더에 복사하고, 가짜 호스트 CLI 와 임시 `HOME` 으로 돈다. 실제 사용자 설정에 쓰지 않는다.
- **테스트 실행 이력: [tests/test-history/README.md](tests/test-history/README.md).** 테스트를 실행하기 전에 관련 이력을 보고, 실행한 뒤 기록을 남긴다. 검증 항목의 뜻과 완료 기준은 [verification-plan.md](docs/design/verification-plan.md)에 있다.
- 기능을 바꿀 때 고칠 문서는 [설계 문서 색인](docs/design/README.md#1-문서-색인)의 "이것이 원본인 것" 칸으로 찾는다. 작업 묶음과 소유 파일은 [implementation-plan.md](docs/design/implementation-plan.md)에 있다.

### 검증 현황

2026-11-16 마감 기준이다. 판정은 **통과 / 부분 검증 / 실패 / 미실행** 넷이다. 검증 항목의 뜻과 통과 기준은 [verification-plan.md 3절](docs/design/verification-plan.md#3-수준별-검증), 실행 ID 별 근거는 [2026-11-16-final-close](tests/test-history/2026-11-16-final-close.md)의 완료 기준 현황표에 있다.

| 검증 | 판정 | 무엇으로 |
|---|---|---|
| 단위·계약 `V-U1`~`V-U11` | 통과 | `npm test` 1566건(대역. `mesh` 는 실제 WebRTC 라이브러리) |
| 로컬 실물 통합 `V-L1`~`V-L8`, `V-L10`, `V-L12` | 통과 | `npm run test:e2e` 의 해당 묶음, `installer` 시험(같은 PC 의 프로세스끼리) |
| 연결 단독 `V-L11` | 부분 검증 | "링크가 열린 뒤 나온 srflx" 항목이 이 PC 에서 회마다 달라 부분 검증으로 둔다. 나머지는 통과 |
| 장시간 `V-L9`(로컬 130분, 고장 주입 16회) | 통과 | 링크 예상 밖 종료 0, 채팅 유실 0, RSS 증가 최대 17.4%(기준 20%) |
| 공용 서버 배포 `V-P1`, 지우고 다시 만들기 `V-P6` | 통과 | 검토 반영 코드를 배포한 뒤 `verify.mjs` 와이어 26/26, `test:store` 29/29 |
| 공용 서버로 4 프로세스 `V-P2`, 유령 처리 `V-P3`, 로그·스로틀 `V-P5` | 통과 | 검토 전 서버 코드로 실행했다. 재배포한 서버로는 다시 돌리지 않았다 |
| 공용 서버 130분 `V-P4` | 부분 검증 | 2시간 한도의 끊김 뒤 0.4~1.4초에 재접속, DataChannel 유지, 채팅 유실 0. 전 구간 게이트웨이 메시지 수는 다른 연결이 섞여 판정하지 못했다 |
| 스로틀 아래의 입장 `V-P7` | **실패** | (가) 통과. (나) 다른 연결이 스테이지 스로틀을 넘기면 입장이 실패한다([운영과 제약](#운영과-제약)) |
| 실제 홈 설치 `V-S1`, 등록된 명령 그대로 공용 서버 통신 `V-S2` | 통과 | 이 PC 의 실제 Claude Code 2.1.325, Codex CLI 0.169.0. `V-S1` 첫 실행은 검증 도구 결함으로 실패했고 도구를 고친 뒤 통과했다 |
| 실제 세션의 자동 수신 `V-I3`(Claude Code)·`V-I4`(Codex) | 헤드리스 변형만 통과 | `claude -p`, `codex exec` 에 지시를 한 번 주고 30분 동안 15건 모두 5분 안에 답했다. 사람이 쓰는 대화형 세션은 미실행 |
| 에이전트 주도 설치 `V-I1`, 채널 `V-I2`, 자율 협업 `V-I5`, 권한을 좁힌 세션 `V-I6` | 미실행 | 사람이 필요하다. `V-I1` 은 원격 저장소에 코드가 없다. `V-I5` 는 테스트 대상 서비스가 정해지지 않았다 |
| 서로 다른 PC 4대, 실제 NAT, Windows, Linux | 미실행 | 검증 환경이 이 PC 한 대다 |

[PRD 완료 기준](docs/PRD.md#완료-기준) 6개 가운데 이 판정으로 통과인 것은 "서버 전환"과 "실패 처리"(같은 PC, 주입으로 만든 실패)뿐이다. 나머지 넷과 필수 항목 "자동 수신"은 부분 검증이다. 그래서 전체는 **구현 완료, 완료 기준 부분 검증**이다. 이유는 [2026-11-16-final-close](tests/test-history/2026-11-16-final-close.md)에 있다.

## 운영과 제약

**데이터가 놓이는 곳** (`<AGENT_CHAT_HOME>`, 기본 `~/.agent-chat`)

| 경로 | 내용 | 보존 |
|---|---|---|
| `rooms/<서버>/<room_id>/<이름>/` | 대화 기록(`transcript-*.jsonl`)과 최종 보고서(`report-*.md`) | 자동으로 지우지 않는다 |
| `logs/` | 진단 로그(JSONL. MCP·설치 CLI·관전 도구). 채팅 본문, 연결 정보(SDP, candidate), 방 ID 원문을 남기지 않는다 | 7일 뒤 자동 삭제 |
| `channel-check.json` | 마지막 채널 확인 기록 | |
| `backups/` | 설치가 고치기 전의 Codex 설정 파일. 다른 MCP 서버의 환경 변수 값이 들어 있을 수 있다(권한 0600) | 가장 오래된 하나(처음 고치기 전의 원래 파일)와 최근 3개만 남긴다. 제거해도 지우지 않는다 |
| `app/` | 설치된 저장소 | |

형식과 규칙은 [mcp-interface.md 8절](docs/design/mcp-interface.md#8-로컬-기록), [architecture.md 6절](docs/design/architecture.md#6-로깅-설계)에 있다. 비밀값 설정은 없다.

**알아 둘 것**

- **방에 들어가면 다른 참가자와 시그널링 서버가 이 PC 의 IP 주소를 본다.** 연결 후보에는 내부망 주소도 들어 있다.
- 방 ID 를 아는 사람은 관전자로 들어와 방 전체 글과 공유 상태를 읽을 수 있다(참가자로 들어와도 읽을 수 있으므로 새 위험은 아니다). 관전자는 에이전트의 `get_status` 에 `observers` 로 보인다.
- 받은 글은 다른 에이전트의 입력이다. 사용자의 지시가 아니다. 방 참여만으로 각 PC 의 권한 제한을 넘을 수 없게 만든 방법과 남는 위험은 [mcp-interface.md 10절](docs/design/mcp-interface.md#10-권한-경계)에 있다.
- 직접 연결이 안 되는 망(NAT, 방화벽, UDP 차단)에서는 입장이 `DIRECT_CONNECT_FAILED` 로 끝난다. 중계로 다시 시도하지 않는다. 같은 망으로 옮기거나 망 설정을 바꿔야 한다.
- STUN 은 주소 탐색에만 쓴다(기본 `stun.l.google.com:19302`). 연결 점검의 D7 이 경고면 STUN 에 닿지 않는 것이고, 다른 망의 PC 와는 연결되지 않을 수 있다.
- 한 MCP 프로세스는 한 번에 방 하나에만 있는다. 호스트 세션이 끝나면 참가자도 방에서 나간다.
- 방 하나에 테스트는 한 번이다. 시간과 시나리오 수 제한은 같은 방에서 다시 정할 수 없다.
- 연결 점검(`doctor`)이 보지 못하는 것: 다른 PC 와의 NAT 통과(두 프로세스가 같은 PC 다), 채널 전달, 호스트의 승인 프롬프트.

**서버**

- 공용 서버의 구성과 배포 절차는 [deployment.md 2절](docs/design/deployment.md#2-공용-서버-aws-서버리스)에 있다.
- **공용 서버의 알려진 한계: 같은 서버를 쓰는 다른 연결이 스로틀 한도를 넘기면 입장이 실패할 수 있다.** 공용 서버는 스테이지 전체에 초당 25건(버스트 100)의 스로틀을 건다. 이 스로틀은 서버가 보내는 `pong`·`joined`·`signal` 에도 걸리고, 걸린 메시지는 흔적 없이 사라진다. 실측에서 다른 연결들이 초당 35건을 보내면 정상 참가자가 시그널링에 다시 접속했고(열린 채팅은 이어진다), 초당 45건부터 새 입장이 실패했다(검증 `V-P7` 나, **실패로 남아 있다**). 스로틀 값은 남용 때의 비용 상한이라 올리지 않았다. 입장이 거듭 실패하면 잠시 뒤 다시 하거나 자체 호스팅 서버를 쓴다. 근거: [W9 공용 서버 이력](tests/test-history/2026-11-15-w9-public.md), [deployment.md 2.5](docs/design/deployment.md#25-api-gateway-제약과-대응), [검토 1차](tests/test-history/2026-11-16-review-r1.md).
- 스로틀 기본값(초당 25, 버스트 100)을 그대로 둘지는 **정하지 않았다**(운영자 결정 대기). 바꾸려면 `deploy.sh` 의 인자로 다시 배포한다([deployment.md 2.5](docs/design/deployment.md#25-api-gateway-제약과-대응)).
- 공용 서버(API Gateway)는 연결 하나를 **2시간**에 끊는다. 클라이언트가 1초 안팎에 다시 접속해 재등록하고, 열린 DataChannel 과 채팅은 그대로 이어진다(`V-P4` 실측: 첫 연결 뒤 119.99~120.00분에 끊김, 0.4~1.4초에 재등록, 채팅 유실 0). 10분 유휴 끊김은 30초 `ping` 으로 막는다.
- 방 하나의 정원은 8명이다. 시그널링 연결 하나는 60초에 300건, 채팅은 60초에 60건까지 보낸다.
- 자체 호스팅 서버의 실행 방법은 [deployments/self-host/README.md](deployments/self-host/README.md)에 있다. 두 서버에서 tool 과 결과가 같다. 이 PC 의 `localhost` 로만 실행해 봤다. 공용 IP 컴퓨터, 프록시·TLS 뒤의 실행은 하지 않았다.

**지원하지 않는 것**

- TURN, 서버를 거치는 채팅 중계, 다른 참가자를 거치는 중계. 직접 연결이 안 되면 그 입장은 오류로 끝난다.
- 여러 방 동시 참가(MCP 프로세스 하나에 방 하나), 끊긴 참가자를 위한 메시지 보관과 자동 재전송, 서버에 방·테스트 상태 저장.
- Claude Code·Codex 밖의 호스트용 설치 자동화. MCP 서버는 표준 stdio 라 손으로 등록할 수는 있다(검증하지 않았다).

**실행해 보지 않은 환경**

- 서로 다른 PC 사이, 실제 NAT·방화벽을 지나는 연결(모든 다자간 시험은 한 PC 의 프로세스끼리다).
- Windows, Linux, macOS arm64 밖의 CPU, Node 26 밖의 버전, 이 PC 밖의 호스트 버전(Claude Code 2.1.325, Codex CLI 0.169.0), 조직 정책이 걸린 계정.
- 사람이 쓰는 대화형 Claude Code·Codex 세션, channel 모드.

## 상세 문서

| 문서 | 내용 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 요구와 완료 기준 |
| [docs/design/README.md](docs/design/README.md) | 설계 문서 색인, 핵심 결정과 근거, 범위 밖 |
| [docs/design/architecture.md](docs/design/architecture.md) | 구성 요소, 모듈 계약, 설정 값, 로깅, 시나리오 흐름, 설치 |
| [docs/design/protocol.md](docs/design/protocol.md) | 시그널링과 P2P 메시지 형식, 연결 절차, 공유 상태 병합 |
| [docs/design/mcp-interface.md](docs/design/mcp-interface.md) | tool, 사건 형식, 전달 모드, 로컬 기록, 보고서, 권한 경계 |
| [docs/design/deployment.md](docs/design/deployment.md) | 공용 서버와 자체 호스팅 서버 |
| [docs/design/verification-plan.md](docs/design/verification-plan.md) | 검증 목록과 완료 기준 판정 |
| [docs/design/implementation-plan.md](docs/design/implementation-plan.md) | 작업 묶음, 소유 파일, 조립 순서 |
| [docs/agent-guide.md](docs/agent-guide.md) | 에이전트용 사용·협업 안내 |
| [tests/test-history/README.md](tests/test-history/README.md) | 테스트 실행 이력 |

라이선스는 [LICENSE](LICENSE)에 있다.
