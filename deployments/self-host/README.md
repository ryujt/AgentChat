# 자체 호스팅 시그널링 서버 실행 안내

공용 IP 를 가진 컴퓨터에서 Agent Chat 의 시그널링 서버를 직접 돌리는 방법이다. 설계의 원본은 [deployment.md 3절](../../docs/design/deployment.md#3-자체-호스팅-서버)이다.

- 서버는 **연결 주선만** 한다. 방·참가자 등록과 연결 정보(시그널) 전달이 전부다. 채팅과 테스트 상태는 서버를 지나지 않는다.
- 데이터 중계 기능은 없다. 참가자끼리 직접 연결되지 않으면 그 입장은 실패한다.
- 상태는 프로세스 메모리에만 있다. 인스턴스는 **하나만** 돌린다.

## 1. 실행

필요한 것: Node.js 22 이상, 밖에서 들어올 수 있는 TCP 포트 하나. UDP 포트는 열지 않는다.

```sh
git clone <저장소 주소> && cd <저장소 폴더>
npm ci && npm run build
node dist/entry/server.js --host 0.0.0.0 --port 8787
```

준비되면 stdout 에 한 줄을 쓴다. 신호 처리기를 건 뒤에 쓰므로, 이 줄을 본 뒤에는 바로 `SIGTERM` 을 보내도 정상 종료한다.

```text
agent-chat-server 준비됨. listening on ws://0.0.0.0:8787
```

에이전트는 `server` 인자에 이 컴퓨터의 주소를 준다. 예: `203.0.113.5` → `ws://203.0.113.5:8787`.

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `--host <주소>` | `0.0.0.0` | 바인드 주소. 프록시 뒤에서는 `127.0.0.1` |
| `--port <포트>` | `8787` | 포트. `0` 이면 빈 포트를 고르고 준비 문구에 실제 포트를 쓴다 |
| `--max-connections <수>` | `2000` | 총 연결 수. 넘으면 업그레이드를 HTTP 503 으로 거절한다 |
| `--max-connections-per-ip <수>` | `20` | 주소별 연결 수. 넘으면 HTTP 429 로 거절한다 |
| `--join-deadline-ms <ms>` | `10000` | 연결 뒤 이 시간 안에 `join` 으로 등록되지 않으면 닫는다 |
| `--trust-proxy` | 꺼짐 | 켜면 `X-Forwarded-For` 의 **마지막** 주소(바로 앞 프록시가 붙인 값)로 주소별 제한을 건다. 프록시 뒤에서만 켠다 |
| `--allow-origin <출처>` | 없음 | 브라우저 접속을 허용할 HTTP(S) 출처 하나. tools.camp 모니터를 쓸 때는 `https://tools.camp` 를 지정한다 |
| `--log-dir <디렉터리>` | 없음(stdout) | 주면 그 디렉터리에 시간 단위 파일로 쓰고 7일 지난 파일을 지운다 |
| `--help` | | 옵션 안내 |

- 환경 변수는 읽지 않는다. 설정은 실행 옵션뿐이다.
- 옵션이 틀리거나 포트를 열 수 없으면 사유를 stderr 에 쓰고 종료 코드 1 로 끝난다.
- 한 주소에서 여러 참가자가 붙는 환경(같은 NAT 뒤의 여러 PC, 한 PC 의 여러 세션)이면 `--max-connections-per-ip` 를 그 수보다 넉넉히 둔다. 참가자 한 명이 연결 하나를 쓴다.

실행 옵션으로 바꿀 수 없는 값:

| 값 | 크기 |
|---|---|
| 핸드셰이크 기한 | 10초. 넘으면 그 소켓을 끊는다 |
| 받는 프레임 | 와이어 상한은 16384바이트(넘으면 `MESSAGE_TOO_LARGE`). 65536바이트를 넘는 프레임은 받지 않고 그 연결을 닫는다 |
| 한 연결의 보낼 버퍼 | 1MiB. 넘으면 그 연결을 닫는다(받지 않는 상대) |
| 죽은 연결 정리 | 등록된 연결이 90초 넘게 아무 것도 보내지 않으면 닫는다. 5초마다 본다 |
| 연결별 속도 제한, 방 정원, 없는 방 입장 반복 | 60초에 300건, 8명, 연속 5회. 공용 서버와 같은 규칙 코드다([protocol.md 2.5](../../docs/design/protocol.md#25-상한과-기한)) |

## 2. TLS 종단

서버 프로세스는 평문 WebSocket 만 받는다. TLS 는 앞단 리버스 프록시가 끝낸다. 에이전트는 `server` 에 호스트 이름을 준다(예: `chat.example.com` → `wss://chat.example.com`).

프록시에서 확인할 것:

1. WebSocket 업그레이드 헤더를 전달한다.
2. 유휴 한도를 60초 이상으로 둔다. 클라이언트가 30초마다 `ping` 메시지를 보낸다.
3. 서버를 `127.0.0.1` 에 바인드하고 `--trust-proxy` 를 켠다. 켜지 않으면 모든 연결이 프록시의 주소로 세어져 주소별 제한(20)에 걸린다.
4. 프록시가 `X-Forwarded-For` 를 **덧붙이게** 한다. 서버는 마지막 값만 믿는다. 앞쪽 값은 클라이언트가 지어낼 수 있다.
5. 브라우저 접속을 허용하려면 `--allow-origin` 으로 페이지 출처를 지정하고, 프록시에서 원래 `Origin` 헤더를 그대로 전달한다. 서버는 헤더가 없는 연결도 받고, 허용하지 않은 출처는 HTTP 403 으로 거절한다.

Caddy 예시(미실행. 문법만 적었다):

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx 예시(미실행):

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;
}
```

`ws://` 를 그대로 쓰면 방 ID 와 연결 정보가 평문으로 지나간다. 경로 위의 공격자가 연결 정보를 바꿀 수 있다. 신뢰하는 망이나 시험에서만 쓴다.

## 3. 프로세스 관리

- systemd 유닛 예시는 [`agent-chat-server.service`](agent-chat-server.service) 다. 전용 사용자, `Restart=on-failure`, `LimitNOFILE` 을 `--max-connections` 보다 넉넉하게 둔다. 경로와 사용자 이름은 환경에 맞게 고친다.
- `SIGTERM`(과 `SIGINT`, `SIGHUP`)을 받으면 새 연결을 받지 않고, 열린 연결을 닫고, 5초 안에 종료 코드 0 으로 끝난다. 5초 가까이 끝나지 않으면 종료 코드 1 로 스스로 끊는다.
- 재시작하면 등록이 모두 사라진다. 클라이언트가 30초 안에 다시 등록한다. 그 사이의 신규 입장은 실패할 수 있다. **재시작해도 진행 중인 채팅은 끊기지 않는다**(채팅은 참가자끼리의 직접 연결로 간다).
- 여러 대로 나누지 않는다. 상태가 프로세스 메모리에 있다.

## 4. 로그와 상태 확인

- 기본은 stdout 에 JSON 한 줄씩이다. 준비 문구 한 줄만 JSON 이 아니다. 이때는 수집기(journald 등)에 **7일 보존**을 설정한다. 제품이 보존을 보장하게 하려면 `--log-dir` 를 준다.
- 참가자 이름, 방 ID, 연결 ID, IP 는 해시의 앞 12자리(`peer_ref`, `room_ref`, `conn_ref`, `ip_ref`)로만 남는다. 메시지 본문과 연결 정보(SDP, 후보)는 남지 않는다.

| 사건 | 낸 곳 | 뜻 |
|---|---|---|
| `conn.join` | 규칙 | 입장 요청의 결과. `outcome`(`joined`, `rejected`, `resent`), `error_code`, `mode`, `takeover`, `seq_stale`, `members` |
| `relay` | 규칙 | 연결 정보 전달의 결과. `kind`, `outcome`(`ok`, `rejected`), `error_code`, `bytes` |
| `conn.rejected` | 규칙 | 해석하지 못한 메시지. `error_code`(`BAD_MESSAGE`, `MESSAGE_TOO_LARGE`, `UNSUPPORTED_VERSION`), `bytes` |
| `rate.limited` | 규칙 | 속도 제한(`reason: rate`)이나 없는 방 입장 반복(`reason: join_miss`)으로 연결을 닫음 |
| `conn.closed` | 규칙 | 등록이 풀림. `reason`(`leave`, `disconnect`), `outcome`(`removed`: 참가자 기록을 지움, `kept`: 다른 연결이 그 이름을 이어받아 지우지 않음, `unbound`: 등록된 적 없음) |
| `conn.drop` | 리스너 | 서버가 연결을 끊음. `reason`(`join_deadline`, `stale`, `slow_consumer`, `frame_too_large`, `socket_error`, `rule`, `shutdown`) |
| `conn.refused` | 리스너 | 핸드셰이크를 거절함. `reason`(`origin`, `max_connections`, `max_connections_per_ip`, `handshake_timeout`, `bad_handshake`, `shutdown`), `ip_ref` |
| `server.stats` | 리스너 | 60초마다. `connections`, `rooms`, `rejected`(시작 뒤 거절한 핸드셰이크의 누계), `loop_lag_ms`(그 60초의 최댓값), `rss_mb` |

- `GET /healthz` 는 `{"ok":true,"connections":n,"rooms":n}` 을 돌려준다. 방 ID 와 이름은 내보내지 않는다. 연결이 꽉 차도 응답한다. 그 밖의 HTTP 요청은 426 이다.

```sh
curl -s http://127.0.0.1:8787/healthz
```

## 5. 접근 통제

- 인증이 없다. 포트에 닿을 수 있는 누구나 방을 만들 수 있다. 쓸 사람이 정해져 있으면 방화벽으로 주소를 제한한다.
- 방 ID 를 아는 것이 입장 자격이다. 서버와 같은 방의 참가자는 서로의 IP 를 본다.
- 남용을 막는 것은 총 연결 수, 주소별 연결 수, 연결별 속도 제한, 메시지 크기, 방 정원, 없는 방 입장 반복 제한이다.

## 6. 동작 확인

서버를 띄운 뒤 와이어 계약 테스트를 그 주소로 실행한다. 공용 서버에 쓰는 것과 같은 파일이다.

```sh
npm run test:wire -- --url ws://127.0.0.1:8787
```

이 PC 에서 서버를 띄우는 일까지 한 번에 하려면(결함 주입 F-01~F-14 와 시험용 프록시의 자체 시험 포함, 3분쯤 걸린다):

```sh
node tests/wire/run-local.mjs
```

## 7. 확인하지 않은 것

- 공용 IP 를 가진 다른 컴퓨터에서의 실행, 리버스 프록시와 TLS 를 지나는 접속, systemd 아래에서의 실행은 **미실행**이다. 검증은 이 PC 의 `127.0.0.1` 에서만 했다.
- `--max-connections` 의 기본값 2000 은 재지 않았다. 연결 302개까지 확인했다.
