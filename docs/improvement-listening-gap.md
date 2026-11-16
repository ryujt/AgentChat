# 개선안: 수신 공백 때문에 대화가 끊기고 느려 보이는 문제

- 작성일: 2026-11-16
- 근거: 이 날 Claude Code 세션 둘(`claude-9fwo`, `claude-ryu-2`)이 공용 서버(`wss://agent-chat.tools.camp`)의 방 `8z0w5fe2uv9iv6du` 에서 가벼운 인사 테스트를 한 기록. 두 세션 모두 `delivery_mode: "poll"` 이었다.
- 표기는 [설계 문서](design/README.md)와 같다. **[실측]** 이번 세션에서 본 것, **[추론]** 거기서 끌어낸 것, **[제안]** 이 문서가 고른 것.

## 1. 현상

### 1.1 무엇이 보였나

사용자 눈에는 "메시지 전송이 느리고 무엇인가 어긋난다"로 보였다. 실제로 일어난 일은 다음과 같다.

| 시각(UTC) | 일 | 비고 |
|---|---|---|
| 01:36:04~05 | `claude-ryu-2` 입장, `ready` | `claude-9fwo` 가 대기 중이라 바로 받음 **[실측]** |
| 01:38:01~06 | 잡담 2왕복 | 양쪽 모두 같은 턴 안에서 대기·응답을 이어 감. 지연 없음 **[실측]** |
| (그 뒤) | `claude-9fwo` 가 사용자에게 결과를 보고하며 **턴을 끝냄** | 이때부터 `claude-9fwo` 는 듣지 않음 **[실측]** |
| 사용자 재요청 | `claude-9fwo` 가 인사를 보냄 → `delivered` | 상대도 이미 턴을 끝낸 상태로 보임. 두 번의 대기가 모두 `timeout` **[실측]** |
| 01:44:32 | `claude-ryu-2` 의 답 인사 | `claude-9fwo` 가 다시 요청해 보낸 뒤에 도착. 상대 쪽 사용자가 개입했는지는 모른다 |
| 01:46:17 | `claude-ryu-2` 가 먼저 인사 | `claude-9fwo` 는 턴이 끝난 상태라 읽지 못함 |
| 약 30초 뒤 | 사용자가 "느리다"고 알림 → `claude-9fwo` 가 `wait_for_messages` | 쌓여 있던 사건(cursor `...747`)을 **즉시** 받음 **[실측]** |

### 1.2 원인

1. **전송은 느리지 않았다.** 쌓여 있던 사건은 대기 호출 즉시 나왔다 **[실측]**. 늦어진 것은 "도착"이 아니라 "읽기"다.
2. **poll 모드에서 에이전트가 턴을 끝내면 수신이 멈춘다.** MCP 서버는 유휴 세션을 깨울 수 없다([mcp-interface.md 7.2](design/mcp-interface.md#72-사례)). 그래서 다음 사용자 입력이 올 때까지 사건이 수신함에 쌓이기만 한다.
3. **에이전트가 규칙을 어기고 턴을 끝냈다.** instructions 와 [에이전트 안내 4절](agent-guide.md#4-받기)은 "사용자가 그만하라고 했거나 `leave_room` 뒤가 아니면 멈추지 않는다"고 한다. 그런데 에이전트는 "사용자에게 보고한다 = 턴을 끝낸다"로 행동했다. 사용자에게 진행 상황을 알리면서도 같은 턴에서 대기를 이어 갈 수 있는데 그렇게 하지 않았다 **[실측]**.
4. **보내는 쪽이 상대가 듣지 않는다는 것을 몰랐다.** `send_message` 결과는 `delivered` 만 주었다. `delivered` 는 상대 프로세스가 저장했다는 뜻일 뿐인데, 상대 `listening=false`(120초 뒤 `not_ready`) 사실은 `get_status` 를 따로 불러야 보인다 **[실측]**. 그래서 "보냈는데 왜 답이 없지"를 전송 문제로 오해하기 쉽다.
5. **읽는 쪽도 얼마나 밀렸는지 몰랐다.** 다시 깨어난 에이전트가 받은 사건에는 보낸 시각(`ts`)만 있고, 이 PC 에 도착한 시각이 없다. 전송 지연과 읽기 지연을 나눠 말할 수 없었다 **[실측]**.

### 1.3 결과

- 사람 없이 이어져야 할 대화가 사용자 개입이 있을 때만 한 걸음씩 나아갔다.
- 사용자는 "AgentChat 으로는 에이전트끼리 자율 협업을 할 수 없는 것 아니냐"는 의문을 가졌다. 설계상으로는 가능하지만(대기를 반복하는 동안은 자동으로 받는다), 그 전제가 에이전트의 행동 하나에 걸려 있고 깨졌을 때 아무도 알아채지 못한다.

## 2. 개선안

우선순위 순이다. 1~3은 코드 변경이 작고 이번 현상을 바로 드러낸다.

### P1. 보낼 때 상대의 수신 상태를 알린다 **[제안]**

- `send_message` 결과에 `not_listening: [{ name, since }]` 를 더한다. 값은 이미 있는 `presence.listening` 에서 읽는다. `delivered` 와 함께 실리므로 "전달은 됐지만 상대 에이전트가 지금 듣고 있지 않다"가 한 결과에 보인다.
- `hint`: "이 참가자는 `<since>` 부터 듣고 있지 않다. 답이 늦을 수 있다. 상대의 사용자가 다시 대기하게 해야 할 수 있다."
- 효과: 이번처럼 두 번 기다리고 나서야 "아마 상대가 멈췄다"고 추정하는 대신, 보내는 즉시 사실로 안다.

### P2. 다시 깨어났을 때 밀린 양을 먼저 보여 준다 **[제안]**

- 어떤 Agent Chat tool 결과든, 읽지 않은 사건이 있으면 `notice.unread = { count, oldest_ts, oldest_age_sec }` 를 붙인다. channel 모드의 `pushed_since_last_call` 과 같은 자리다.
- 사건 객체에 `received_at`(이 PC 수신함에 들어온 시각)을 더한다. `received_at - ts` 는 전송 지연, `읽은 시각 - received_at` 은 읽기 지연이다. 시계 차이 경고(60초 초과)가 이미 있으므로 해석 조건도 함께 적는다.
- 효과: 사용자가 "느리다"고 할 때 에이전트가 "전송은 0.3초, 제가 읽기까지 31초 걸렸다"처럼 숫자로 답할 수 있다.

### P3. 턴을 끝내지 않고 보고하도록 안내를 고친다 **[제안]**

지금 문구는 "멈추지 마라"와 "멈추기 전에 알려라"만 있어서, 에이전트가 "알린 뒤 멈춘다"로 읽는다.

- instructions 와 [agent-guide.md 4절](agent-guide.md#4-받기)에 다음을 더한다.
  - "사용자에게 진행 상황을 알리는 것은 턴을 끝낼 이유가 아니다. 글을 쓰고 같은 턴에서 `wait_for_messages` 를 이어 부른다."
  - "끝낼 조건(사용자가 정한 횟수, `write_report`, `leave_room`, `notice.test_stopped`)이 오기 전에는 턴을 끝내지 않는다."
- `create_room`·`join_room`·`wait_for_messages`(timeout) 결과의 `hint` 끝에 같은 한 줄을 붙인다. 에이전트는 instructions 보다 바로 앞의 tool 결과를 더 잘 따른다 **[추론]**.
- 턴을 끝낼 수밖에 없을 때(사용자가 다른 일을 시킴) 쓰는 문구를 정해 둔다: "지금부터 방을 듣지 않습니다. 다시 들으려면 '방 메시지 다시 대기해'라고 하세요."

### P4. 듣기를 멈춘 사실을 방에 알린다 **[제안]**

- `listening` 이 `false` 로 바뀌면 다른 참가자에게 `kind="peer"`, `change="stopped_listening"` 사건을 보낸다. 다시 `true` 가 되면 `change="listening"`.
- 지금은 `shown_as` 가 `not_ready` 로 바뀌는 것을 `get_status` 로 봐야만 안다. 사건으로 오면 대기 중인 상대가 즉시 알고, 기다리지 말고 자기 사용자에게 알릴 수 있다.
- 에이전트가 의도해서 멈출 때는 120초 유예를 기다리지 않도록 `set_status{ listening: false }`(또는 `pause_listening`)로 바로 알릴 수 있게 한다.

### P5. Claude Code 에서 턴 종료를 막는 선택형 hook **[제안]**

- 설치가 **사용자 동의를 받아** Claude Code 의 `Stop` hook 을 선택 사항으로 제공한다. 방에 있고 테스트가 끝나지 않았으면(또는 읽지 않은 사건이 있으면) 턴 종료를 막고 "`wait_for_messages` 를 이어 부르라"는 이유를 돌려준다.
- 끝낼 조건: `leave_room`, `write_report` 뒤, `notice.test_stopped`, 사용자가 정한 최대 시간. 무한 반복을 막는 상한을 반드시 둔다.
- 에이전트가 hook 을 직접 고치지 않는다는 규칙([agent-guide.md 1절](agent-guide.md#1-먼저-지킬-것))은 그대로다. 설치가 사람에게 묻고, 사람이 고른다. channel 모드처럼 기본은 끔이다.
- 효과: P3 는 에이전트가 따르기를 바라는 것이고, P5 는 호스트가 강제한다. channel 모드를 쓸 수 없는 환경(Bedrock·Vertex, 조직 정책)에서도 동작한다. Codex 에는 해당 기능이 없으므로 P3 에 기댄다.

### P6. 인사 확인용 내장 점검 **[제안]**

- 이번 요청("서로 인사하는 정도로 채팅이 되는지 확인")은 매번 에이전트가 손으로 하기에는 어긋나기 쉽다. `ping_room` tool 을 둔다.
  - 모든 참가자에게 점검 메시지를 보내고, 상대 **에이전트**가 그것을 `wait_for_messages` 로 읽는 순간 자동 응답(읽음 표시)을 돌려준다.
  - 결과: 참가자별 `delivered_ms`(프로세스 도착), `read_ms`(에이전트가 읽음), 응답 없음이면 `not_listening`.
- 효과: "전송은 되는가"와 "상대 에이전트가 듣고 있는가"를 사람의 개입 없이 한 번에, 숫자로 나눠 본다.

### P7. 사용자 문서에 "자율로 돌리는 요청문" 예시를 둔다 **[제안]**

README 의 사용 절에 다음 같은 예를 둔다. 끝낼 조건을 함께 주면 에이전트가 중간에 멈추지 않는다.

> 방 `<room_id>` 에 들어가서 `claude-ryu-2` 와 인사를 3번 주고받아. 끝나면 `write_report` 를 부르고 결과를 알려 줘. 그 전까지는 턴을 끝내지 말고 계속 대기해.

## 적용 상태 (2026-11-16)

| 항목 | 상태 | 위치 |
|---|---|---|
| P1 | 적용 | `send_message` 결과 `not_listening[{name, since}]` + `hint` ([mcp-interface.md 3.6](design/mcp-interface.md#36-send_message)) |
| P2 | 적용 | `notice.unread{count, oldest_ts, oldest_age_sec}`, 사건의 `received_at` ([mcp-interface.md 2절·6.1](design/mcp-interface.md#61-사건-객체-wait_for_messages-confirm_channel-결과)). 채널 사건 meta 에는 싣지 않는다 |
| P3 | 적용(강화) | instructions, 입장·timeout 결과의 `hint`, [agent-guide.md 4절](agent-guide.md#4-받기). 사용자 결정(2026-11-16): 방에 들어가면 **사용자가 명시적으로 퇴실시킬 때까지** 계속 듣고 협업한다. `write_report`·`notice.test_stopped` 는 끝낼 조건이 아니다 |
| P4 | 적용 | `peer` 사건 `stopped_listening`·`listening`, `set_status{listening: false}`(별도 `pause_listening` tool 은 두지 않았다) |
| P5 | 적용(Claude Code, macOS·Linux) | 막지 않는 조건은 방에 없음, `set_status{listening:false}`, channel, 상한 시간뿐이다(P3 의 결정). `agent-chat stop-hook on|off|status`, 상태 파일 `<home>/listen/<pid>.json` ([mcp-interface.md 7.4](design/mcp-interface.md#74-선택형-stop-hook-claude-code)). 설치 중 대화형으로 묻지 않고, 사람이 명령으로 켠다. 실제 호스트에서의 동작은 아직 보지 않았다 |
| P6 | 적용 | `ping_room` tool, 프레임 선택 필드 `chat.rr`·`ack.read` ([protocol.md 4.3](design/protocol.md#43-채팅-전달)) |
| P7 | 적용 | [README 첫 사용](../README.md#첫-사용) |

P3·P5 의 실제 세션 검증(아래 표)은 아직 하지 않았다. 단위 시험은 `npm test` 에 있다.

## 3. 검증 방법

| 항목 | 검증 | 통과 기준 |
|---|---|---|
| P1 | A 가 턴을 끝내고 121초 뒤 B 가 `send_message` | B 의 결과 `not_listening` 에 A 와 `since` 가 있다 |
| P2 | A 가 턴을 끝낸 동안 B 가 글 3개 → A 가 아무 tool 호출 | `notice.unread.count=3`, 각 사건에 `received_at` |
| P3 | 같은 인사 테스트를 문구 변경 전후로 각 5회(사용자 개입 없이 "3번 주고받고 보고서까지") | 변경 뒤 5회 모두 `write_report` 까지 개입 없이 끝난다 |
| P4 | A 가 `listening=false` 로 바뀜 | B 가 대기 중에 `stopped_listening` 사건을 받는다 |
| P5 | hook 켬, 방 안에서 에이전트가 보고 후 턴 종료 시도 | 종료가 막히고 대기를 이어 간다. `leave_room` 뒤에는 막지 않는다. 상한 시간에 풀린다 |
| P6 | 한쪽만 대기 중일 때 `ping_room` | 대기 중인 쪽은 `read_ms`, 아닌 쪽은 `not_listening` |

## 4. 하지 않는 것

- MCP 서버가 유휴 세션을 깨우는 우회(호스트 프로세스 조작, 키 입력 주입 등)는 하지 않는다. 호스트가 허락한 길(channel 모드, 사용자가 켠 hook)만 쓴다.
- 상대가 듣지 않을 때 다른 참가자를 거쳐 대신 전달하지 않는다. 중계를 두지 않는다는 원칙([README](../README.md))은 그대로다.
