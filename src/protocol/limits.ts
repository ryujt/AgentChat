// 와이어에 드러나는 상한과 기한. 값과 근거의 원본은 docs/design/protocol.md 이고,
// 구현 뒤에는 이 파일이 원본이다. 서버 둘과 클라이언트가 같은 값을 써야 해서 한 곳에 둔다.
// 주석의 절 번호는 protocol.md 의 절이다.

export const LIMITS = Object.freeze({
  // ── 2.2 시그널링 버전과 필드 ──────────────────────────────────────────────
  /** 클라이언트가 join.v 에 싣는 버전. */
  SIGNAL_VERSION: 1,
  /** 서버가 받는 버전 목록. UNSUPPORTED_VERSION 의 supported 로 돌려준다. */
  SIGNAL_SUPPORTED_VERSIONS: Object.freeze([1] as const),
  /** offer·answer 의 data.sdp 최대 글자 수. */
  SDP_MAX_CHARS: 12000,
  /** candidate 문자열 최대 글자 수. */
  CANDIDATE_MAX_CHARS: 1024,
  /** candidate 의 mid 최대 글자 수. */
  CANDIDATE_MID_MAX_CHARS: 16,
  /** candidate 메시지 하나에 묶는 후보 수(1~32). */
  CANDIDATE_LIST_MAX: 32,

  // ── 2.5 시그널링 상한과 기한 ──────────────────────────────────────────────
  SIGNAL_MAX_MESSAGE_BYTES: 16384,
  ROOM_MAX_PEERS: 8,
  /** 연결별 고정 창의 속도 제한. */
  RATE_MAX_MESSAGES: 300,
  RATE_WINDOW_MS: 60_000,
  /** 한 연결의 연속 ROOM_NOT_FOUND 횟수. 닿으면 RATE_LIMITED 뒤 닫는다. */
  JOIN_MISS_MAX: 5,
  SIGNAL_PING_INTERVAL_MS: 30_000,
  SIGNAL_PONG_TIMEOUT_MS: 10_000,
  SIGNAL_PING_RETRY_MS: 5_000,
  SIGNAL_PING_MISS_MAX: 3,
  PARTICIPANT_STALE_MS: 90_000,
  SIGNAL_CONNECT_TIMEOUT_MS: 10_000,
  SIGNAL_REQUEST_TIMEOUT_MS: 10_000,
  /** 재접속 대기: 1초부터 2배, 상한 30초, 전 구간 무작위(full jitter). */
  RECONNECT_BACKOFF_BASE_MS: 1_000,
  RECONNECT_BACKOFF_FACTOR: 2,
  RECONNECT_BACKOFF_MAX_MS: 30_000,
  /** 2.4 게이트웨이 프레임을 받았을 때 같은 join 을 다시 보내기까지의 무작위 대기 구간. */
  GATEWAY_JOIN_RETRY_MIN_MS: 1_000,
  GATEWAY_JOIN_RETRY_MAX_MS: 2_000,

  // ── 3. WebRTC 연결 절차 ───────────────────────────────────────────────────
  /** 3.1 joined 전에 받은 offer 로 생긴 answer·후보를 들고 있는 최대 건수. */
  PRE_JOIN_SIGNAL_HOLD_MAX: 64,
  /** 3.1 같은 피어와의 시도가 이만큼 연속 실패하면 "닿지 않음"으로 표시한다. */
  UNREACHABLE_AFTER_FAILS: 2,
  /** 3.1 링크가 닫히거나 시도가 실패한 직후 한 번 다시 접촉하기까지의 대기. */
  RECONTACT_DELAY_MS: 1_000,
  /** 3.2 로컬 후보를 모아 한 메시지로 보내는 시간. */
  CANDIDATE_BATCH_MS: 100,
  /** 3.2 시도 큐와 대기 큐 각각의 최대 건수. */
  CANDIDATE_QUEUE_MAX: 32,
  /** 3.2 교체 확인: 이 시간 안에 pong 이 오면 기존 링크를 지킨다. */
  REPLACE_PROBE_MS: 2_000,
  /** 3.3 시도가 열리기 전까지 시그널을 다시 보내는 주기. */
  SIGNAL_RESEND_MS: 3_000,
  /** 3.3 즉시 재전송(게이트웨이 프레임, SERVER_ERROR)의 최소 간격. */
  SIGNAL_RESEND_MIN_GAP_MS: 1_000,
  /** 3.3 주기 재전송은 한 시도에 최대 4회다(15초 / 3초). 총 기한을 늘리지 않는다. */
  SIGNAL_RESEND_MAX: 4,
  /** 3.3 시도 시작 → DataChannel open. */
  PEER_CONNECT_TIMEOUT_MS: 15_000,
  /** 3.3 open → 상대 hello. */
  HELLO_TIMEOUT_MS: 5_000,
  /** 3.3 joined 수신 → 모든 필수 링크 동기화 완료. */
  JOIN_MESH_TIMEOUT_MS: 20_000,

  // ── 4. P2P DataChannel ────────────────────────────────────────────────────
  /** 4.1 봉투의 v. 다르면 bye{version} 뒤 링크를 닫는다. */
  P2P_VERSION: 1,
  /** 4.1 직렬화한 프레임 하나의 최대 바이트. */
  P2P_MAX_FRAME_BYTES: 65536,
  /** 4.3 수신자별 ack 대기. 넘으면 결과 불명(ack_timeout)이다. */
  CHAT_ACK_TIMEOUT_MS: 5_000,
  /** 4.3 한 피어에 대해 확인받지 못한 chat 이 이 수를 넘으면 새 전송은 not_connected 다. */
  CHAT_UNACKED_MAX: 50,
  /** 4.3 보내는 쪽: 창 안에 이 건수까지만 보낸다. */
  CHAT_SEND_RATE_MAX: 60,
  /** 4.3 받는 쪽: 한 피어에게서 창 안에 이 건수를 넘으면 버리고 잘못된 프레임으로 센다. */
  CHAT_RECV_RATE_MAX: 120,
  CHAT_RATE_WINDOW_MS: 60_000,
  /** 4.4 기억하는 최근 chat.id 수. */
  SEEN_ID_CAPACITY: 4096,
  /** 4.4 chat.text 의 UTF-8 최대 바이트. */
  CHAT_MAX_TEXT_BYTES: 16384,
  /** 4.4 state 프레임 하나에 기록을 담는 목표 크기. */
  STATE_FRAME_TARGET_BYTES: 49152,
  /** 4.4 잘못된 프레임이 창 안에 이 건수를 넘으면 bye{protocol_error} 뒤 닫는다. */
  BAD_FRAME_MAX: 5,
  BAD_FRAME_WINDOW_MS: 60_000,
  /** 4.5 링크 생존 확인 주기. ICE 만으로는 상대 소실을 아는 데 약 27초가 걸린다. */
  P2P_PING_INTERVAL_MS: 5_000,
  /** 4.5 마지막 생존 증거 이후 이 시간이 지나면 링크를 죽은 것으로 본다. */
  P2P_DEAD_AFTER_MS: 15_000,

  // ── 5. 공유 상태 ──────────────────────────────────────────────────────────
  /** 5.1 기록 body 의 글자 필드 하나의 UTF-8 최대 바이트. */
  STATE_TEXT_FIELD_MAX_BYTES: 4096,
  /** 5.1 기록 하나를 정규 직렬화한 최대 바이트. */
  STATE_RECORD_MAX_BYTES: 32768,
  /** 5.1 로컬 쓰기에만 거는 복제본 기록 수 상한. presence·test·stop 은 뺀다. */
  STATE_MAX_RECORDS: 2000,
  /** 5.1 로컬 쓰기에만 거는 복제본 전체 크기 상한(기록별 직렬화 크기의 합). */
  STATE_MAX_BYTES: 1_048_576,
  /** 5.1 병합으로 복제본이 이 수를 넘게 되면 프로토콜 위반으로 본다. */
  STATE_MERGE_MAX_RECORDS: 4096,
  /** 5.4 재동기화를 시작하려면 ping 의 지문이 이만큼 연속 달라야 한다. */
  STATE_DIVERGE_PINGS: 2,
  /** 5.4 재동기화 간격의 기본값. 스냅샷 답을 기다리는 시간이기도 하다. */
  RESYNC_MIN_GAP_MS: 30_000,
  /** 5.4 진전이 없을 때 2배씩 늘리는 간격의 상한. */
  RESYNC_MAX_GAP_MS: 300_000,
  /** 5.6 hello.wall 로 본 시계 차이가 이 값을 넘으면 경고한다. 판정에는 쓰지 않는다. */
  CLOCK_SKEW_WARN_MS: 60_000,
} as const);

export type Limits = typeof LIMITS;

/** 3.4 DataChannel 라벨. 쌍마다 채널은 이것 하나다. */
export const DATA_CHANNEL_LABEL = 'agent-chat';
