// 진단 로그 포트의 타입 (architecture.md 3.12, 6절).
// 모든 모듈이 이 타입만 주입받아 사건을 남긴다. 구현(파일·stdout 로거)은 diagnostics 가 갖는다.
// 로거를 만드는 함수의 타입은 조립만 쓰므로 contract.ts 에 따로 둔다.
// 이 파일에는 타입만 둔다. 실행 코드를 넣지 않는다.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 줄마다 붙는 svc 값. 로거를 만들 때 정한다. 호출 지점은 넘기지 않는다. */
export type LogService = 'mcp' | 'server' | 'lambda' | 'cli';

/** 줄마다 붙는 mod 값. 사건을 낸 모듈의 폴더 이름이다. */
export type LogModule =
  | 'protocol'
  | 'diagnostics'
  | 'signaling-core'
  | 'signaling-selfhost'
  | 'signaling-aws'
  | 'signaling-client'
  | 'mesh'
  | 'shared-state'
  | 'inbox'
  | 'records'
  | 'room-session'
  | 'mcp-server'
  | 'setup'
  | 'entry';

/**
 * 호출 지점이 넘길 수 있는 필드 이름. architecture.md 6.1 의 "허용 필드"와 "연결 ID" 칸, 6.2 의 공통 필드다.
 * 출력기의 허용 목록은 이 이름을 모두 포함해야 한다.
 *
 * 여기에 없는 것은 남기지 않는다: 채팅 본문, 상태 기록의 글자 필드, SDP, candidate, key,
 * 방 ID 원문, IP 주소 원문, 환경 변수 값, 게이트웨이 프레임 본문.
 * ts, level, svc, proc, mod, event 는 로거가 붙인다.
 *
 * 로거만 붙이는 필드가 둘 더 있다. 호출 지점은 넘길 수 없다(이 타입에 없고, 넘겨도 출력기가 버린다).
 * - dropped: 버퍼 넘침, 시간 파일 상한, 덧붙이기 실패로 버린 줄 수. 다음에 받아들인 줄에 붙는다.
 * - failed: 보존 정리에서 지우지 못한 파일 수. `log.cleanup` 줄(mod: diagnostics, level: warn, outcome: error)에만 붙는다.
 */
export type LogFieldName =
  // 공통 (해당할 때만). 타임아웃은 outcome: "unknown" 이다. 실패 확정이 아니다.
  | 'outcome'
  | 'error_code'
  | 'duration_ms'
  | 'attempt'
  // 연결 ID. 방 ID·연결 ID·IP 는 원문 대신 SHA-256 앞 12자리(protocol 의 refOf)로 남긴다.
  | 'room_ref'
  | 'conn_ref'
  | 'ip_ref'
  | 'sid'
  | 'cid'
  | 'msg_id'
  | 'test_id'
  // 참가자 이름. MCP 의 로컬 로그에는 peer 로 그대로, 서버 로그에는 peer_ref 로만 남긴다.
  | 'peer'
  | 'peer_ref'
  // 입장과 연결 시도
  | 'stage'
  | 'reason'
  | 'pc_state'
  | 'ice_state'
  | 'cand_local_host'
  | 'cand_local_srflx'
  | 'cand_remote_host'
  | 'cand_remote_srflx'
  // 시그널 유실과 순서
  | 'kind'
  | 'cause'
  | 'resends'
  | 'queued_applied'
  | 'dup_ignored'
  | 'frame_len'
  // 시그널링 연결 상태
  | 'state'
  | 'backoff_ms'
  | 'misses'
  | 'seq'
  // 링크 종료와 교체 확인
  | 'last_alive_age_ms'
  | 'open_ms'
  // 메시지 전달
  | 'targets'
  | 'delivered'
  | 'undelivered'
  | 'bytes'
  | 'dup'
  | 'via'
  | 'more'
  // 전달 모드
  | 'from'
  | 'to'
  | 'unseen'
  // 중단과 제한
  | 'tool'
  | 'by'
  | 'sent_to'
  | 'not_connected'
  // 공유 상태
  | 'applied'
  | 'ignored'
  | 'anomalies'
  | 'snapshot'
  | 'gap_ms'
  | 'records'
  // 종료
  | 'forced'
  | 'links'
  // 설정
  | 'name'
  // 서버의 거절과 종료
  | 'mode'
  | 'takeover'
  | 'seq_stale'
  | 'members'
  // 서버 자원
  | 'connections'
  | 'rooms'
  | 'rejected'
  | 'loop_lag_ms'
  | 'rss_mb'
  // 설치
  | 'step'
  | 'host';

type LogScalar = string | number | boolean | null;

/** 값은 짧은 식별자, 수, 참·거짓, 또는 그것의 목록이다. 객체와 오류 객체는 넘기지 않는다. */
export type LogFieldValue = LogScalar | readonly LogScalar[] | undefined;

export type LogFields = { readonly [K in LogFieldName]?: LogFieldValue };

/**
 * 서버 로그(svc 가 server·lambda)에 넘길 수 있는 필드. 참가자 이름 원문(peer)이 없다.
 * 서버 로그는 운영자가 보는 자료이고 이름은 사용자가 정하는 값이라 peer_ref 로만 남긴다(architecture.md 6.2).
 */
export type ServerLogFields = Omit<LogFields, 'peer'> & { readonly peer?: never };

export interface LogPort {
  /**
   * 진단 사건 하나를 남긴다. 던지지 않고, 기다리게 하지 않는다. 로그 실패가 호출자를 멈추면 안 된다.
   * @param event 사건 이름. 예: `join.end`, `link.attempt_end`, `signal.resend`.
   */
  event(level: LogLevel, module: LogModule, event: string, fields?: LogFields): void;
}

/**
 * 서버 쪽 모듈(signaling-core 와 두 조립)이 주입받는 로그 포트. LogPort 와 같되 peer 를 받지 않는다.
 * 조립은 보통의 로거(LogPort)를 그대로 넘긴다. 출력기도 svc 가 server·lambda 면 peer 를 버린다.
 */
export interface ServerLogPort {
  event(level: LogLevel, module: LogModule, event: string, fields?: ServerLogFields): void;
}
