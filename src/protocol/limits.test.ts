import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DATA_CHANNEL_LABEL, LIMITS } from './limits.js';

describe('LIMITS: protocol.md 의 표와 같은 값', () => {
  const documented: Record<string, number> = {
    // 2.2
    SIGNAL_VERSION: 1,
    SDP_MAX_CHARS: 12000,
    CANDIDATE_MAX_CHARS: 1024,
    CANDIDATE_MID_MAX_CHARS: 16,
    CANDIDATE_LIST_MAX: 32,
    // 2.5
    SIGNAL_MAX_MESSAGE_BYTES: 16384,
    ROOM_MAX_PEERS: 8,
    RATE_MAX_MESSAGES: 300,
    RATE_WINDOW_MS: 60000,
    JOIN_MISS_MAX: 5,
    SIGNAL_PING_INTERVAL_MS: 30000,
    SIGNAL_PONG_TIMEOUT_MS: 10000,
    SIGNAL_PING_RETRY_MS: 5000,
    SIGNAL_PING_MISS_MAX: 3,
    PARTICIPANT_STALE_MS: 90000,
    SIGNAL_CONNECT_TIMEOUT_MS: 10000,
    SIGNAL_REQUEST_TIMEOUT_MS: 10000,
    RECONNECT_BACKOFF_BASE_MS: 1000,
    RECONNECT_BACKOFF_FACTOR: 2,
    RECONNECT_BACKOFF_MAX_MS: 30000,
    GATEWAY_JOIN_RETRY_MIN_MS: 1000,
    GATEWAY_JOIN_RETRY_MAX_MS: 2000,
    // 3
    PRE_JOIN_SIGNAL_HOLD_MAX: 64,
    UNREACHABLE_AFTER_FAILS: 2,
    RECONTACT_DELAY_MS: 1000,
    CANDIDATE_BATCH_MS: 100,
    CANDIDATE_QUEUE_MAX: 32,
    REPLACE_PROBE_MS: 2000,
    SIGNAL_RESEND_MS: 3000,
    SIGNAL_RESEND_MIN_GAP_MS: 1000,
    SIGNAL_RESEND_MAX: 4,
    PEER_CONNECT_TIMEOUT_MS: 15000,
    HELLO_TIMEOUT_MS: 5000,
    JOIN_MESH_TIMEOUT_MS: 20000,
    // 4
    P2P_VERSION: 1,
    P2P_MAX_FRAME_BYTES: 65536,
    CHAT_ACK_TIMEOUT_MS: 5000,
    CHAT_UNACKED_MAX: 50,
    CHAT_SEND_RATE_MAX: 60,
    CHAT_RECV_RATE_MAX: 120,
    CHAT_RATE_WINDOW_MS: 60000,
    SEEN_ID_CAPACITY: 4096,
    CHAT_MAX_TEXT_BYTES: 16384,
    STATE_FRAME_TARGET_BYTES: 49152,
    BAD_FRAME_MAX: 5,
    BAD_FRAME_WINDOW_MS: 60000,
    P2P_PING_INTERVAL_MS: 5000,
    P2P_DEAD_AFTER_MS: 15000,
    // 5
    STATE_TEXT_FIELD_MAX_BYTES: 4096,
    STATE_RECORD_MAX_BYTES: 32768,
    STATE_MAX_RECORDS: 2000,
    STATE_MAX_BYTES: 1048576,
    STATE_MERGE_MAX_RECORDS: 4096,
    STATE_DIVERGE_PINGS: 2,
    RESYNC_MIN_GAP_MS: 30000,
    RESYNC_MAX_GAP_MS: 300000,
    CLOCK_SKEW_WARN_MS: 60000,
  };

  for (const [name, value] of Object.entries(documented)) {
    it(`${name} = ${value}`, () => {
      assert.equal((LIMITS as unknown as Record<string, unknown>)[name], value);
    });
  }

  it('표에 없는 숫자 상수가 LIMITS 에 섞여 있지 않다', () => {
    const numeric = Object.entries(LIMITS)
      .filter(([, value]) => typeof value === 'number')
      .map(([name]) => name)
      .sort();
    assert.deepEqual(numeric, Object.keys(documented).sort());
  });

  it('서버 지원 버전 목록은 [1] 이고 클라이언트 버전을 포함한다', () => {
    assert.deepEqual([...LIMITS.SIGNAL_SUPPORTED_VERSIONS], [1]);
    assert.ok((LIMITS.SIGNAL_SUPPORTED_VERSIONS as readonly number[]).includes(LIMITS.SIGNAL_VERSION));
  });

  it('DataChannel 라벨은 agent-chat 이다', () => {
    assert.equal(DATA_CHANNEL_LABEL, 'agent-chat');
  });

  it('값을 바꿀 수 없다', () => {
    assert.ok(Object.isFrozen(LIMITS));
    assert.ok(Object.isFrozen(LIMITS.SIGNAL_SUPPORTED_VERSIONS));
    assert.throws(() => {
      (LIMITS as unknown as Record<string, number>)['ROOM_MAX_PEERS'] = 99;
    }, TypeError);
    assert.equal(LIMITS.ROOM_MAX_PEERS, 8);
  });
});

describe('LIMITS: 문서가 값 사이에 둔 관계', () => {
  it('죽은 시그널링 연결을 아는 데 최대 70초이고 오래됨 기준 90초보다 짧다', () => {
    const worst =
      LIMITS.SIGNAL_PING_INTERVAL_MS +
      LIMITS.SIGNAL_PING_MISS_MAX * LIMITS.SIGNAL_PONG_TIMEOUT_MS +
      (LIMITS.SIGNAL_PING_MISS_MAX - 1) * LIMITS.SIGNAL_PING_RETRY_MS;
    assert.equal(worst, 70000);
    assert.ok(worst < LIMITS.PARTICIPANT_STALE_MS);
  });

  it('주기 재전송은 연결 기한 안에 4회다', () => {
    const before = Math.ceil(LIMITS.PEER_CONNECT_TIMEOUT_MS / LIMITS.SIGNAL_RESEND_MS) - 1;
    assert.equal(before, LIMITS.SIGNAL_RESEND_MAX);
  });

  it('접속·등록·mesh 기한을 합쳐 40초로, 가장 짧은 tool 호출 한도 60초 안이다', () => {
    const total =
      LIMITS.SIGNAL_CONNECT_TIMEOUT_MS + LIMITS.SIGNAL_REQUEST_TIMEOUT_MS + LIMITS.JOIN_MESH_TIMEOUT_MS;
    assert.equal(total, 40000);
    assert.ok(total < 60000);
    assert.equal(LIMITS.JOIN_MESH_TIMEOUT_MS, LIMITS.PEER_CONNECT_TIMEOUT_MS + 5000);
  });

  it('닿지 않음은 첫 실패 뒤 1초 만의 재시도를 포함해 약 31초 안에 알린다', () => {
    const notice =
      LIMITS.UNREACHABLE_AFTER_FAILS * LIMITS.PEER_CONNECT_TIMEOUT_MS +
      (LIMITS.UNREACHABLE_AFTER_FAILS - 1) * LIMITS.RECONTACT_DELAY_MS;
    assert.equal(notice, 31000);
  });

  it('시그널 메시지 상한은 공용 서버 한도 131072 의 1/8, ping 주기는 유휴 한도 600초의 1/20 이다', () => {
    assert.equal(LIMITS.SIGNAL_MAX_MESSAGE_BYTES * 8, 131072);
    assert.equal(LIMITS.SIGNAL_PING_INTERVAL_MS * 20, 600000);
  });

  it('기록 하나는 state 프레임 목표 크기에, 목표 크기는 프레임 상한에 든다', () => {
    assert.ok(LIMITS.STATE_RECORD_MAX_BYTES < LIMITS.STATE_FRAME_TARGET_BYTES);
    assert.ok(LIMITS.STATE_FRAME_TARGET_BYTES < LIMITS.P2P_MAX_FRAME_BYTES);
  });

  it('받는 쪽 채팅 한도는 보내는 쪽 한도보다 커서 규칙을 지키는 발신자는 닿지 않는다', () => {
    assert.ok(LIMITS.CHAT_RECV_RATE_MAX > LIMITS.CHAT_SEND_RATE_MAX);
  });

  it('재동기화 간격은 30초에서 2배씩 늘어 300초에서 멈춘다', () => {
    const gaps: number[] = [LIMITS.RESYNC_MIN_GAP_MS];
    for (let i = 0; i < 5; i += 1) {
      gaps.push(Math.min((gaps.at(-1) ?? 0) * 2, LIMITS.RESYNC_MAX_GAP_MS));
    }
    assert.deepEqual(gaps, [30000, 60000, 120000, 240000, 300000, 300000]);
  });

  it('병합 보호 상한은 로컬 쓰기 상한보다 크다', () => {
    assert.ok(LIMITS.STATE_MERGE_MAX_RECORDS > LIMITS.STATE_MAX_RECORDS + LIMITS.ROOM_MAX_PEERS);
  });
});
