// mesh 의 공개 계약 (architecture.md 3.6). 연결 절차의 규칙은 protocol.md 3절과 4.5 가 정한다.
// 피어별 연결 시도와 링크를 관리한다. 누구에게 언제 접촉할지는 정하지 않는다(room-session 이 정한다).
// ping·pong 외 프레임의 뜻을 모른다. signaling-client 를 모른다. 이 파일에는 타입만 있다.

import type { LogPort } from '../diagnostics/log-port.js';
import type {
  IceServers,
  LinkFailure,
  Now,
  ServerSignalMessage,
  SignalPayload,
  Subscribable,
  Timers,
} from '../protocol/index.js';

// ── 주입받는 것 ─────────────────────────────────────────────────────────────

/**
 * 시그널을 내보내는 함수. 보내지 못했으면 false 다(연결 없음, 크기 초과).
 * false 여도 시도는 이어진다. 주기 재전송이 메운다. joined 전에 들고 있다가 보내는 일은 주는 쪽이 한다.
 */
export type SendSignal = (to: string, payload: SignalPayload) => boolean;

/** P2P ping 에 실을 값. mesh 는 뜻을 모른다(복제본의 기록 수와 지문이다). */
export interface PingInfo {
  readonly sc: number;
  readonly sf: string;
}

export interface MeshSelf {
  readonly peer: string;
  /** 이 입장의 sid. 내가 offer 쪽일 때 cid 의 앞부분이 된다. */
  readonly sid: string;
}

export interface MeshDeps {
  readonly self: MeshSelf;
  /**
   * protocol.parseIceServers 를 통과한 값만 받는다. 빈 목록이면 host 후보만 쓴다.
   * 라이브러리에는 항목마다 `{hostname, port}` 객체로 넘긴다. `url` 문자열을 넘기지 않는다.
   * 고정한 라이브러리는 대괄호가 든 IPv6 URL 문자열에 예외를 던진다. 사용자 이름·암호·중계 종류는 넣지 않는다.
   * 통과한 값으로 pc 가 만들어진다는 것은 V-U11 이 실제 라이브러리로 본다(이름, IPv4, IPv6, 포트 생략).
   */
  readonly iceServers: IceServers;
  readonly sendSignal: SendSignal;
  readonly pingInfo: () => PingInfo;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
}

// ── 조회 ────────────────────────────────────────────────────────────────────

export interface MeshLink {
  readonly peer: string;
  /** 상대의 sid. 그 시도의 시그널에 서버가 붙인 값이다. 아직 받은 시그널이 없으면 null. */
  readonly sid: string | null;
  /** open 은 DataChannel 이 열렸다는 뜻이다. hello 와 동기화는 room-session 이 따로 본다. */
  readonly state: 'open' | 'connecting';
}

export interface MeshNetInfo {
  /**
   * 이 mesh 가 만들어진 뒤 어느 pc 에서든 로컬 srflx 후보를 한 번이라도 얻었는가.
   * 성공한 시도와 실패한 시도를 가리지 않고, 링크가 열린 뒤에 나온 후보도 센다.
   * 한 번 참이 되면 shutdown() 까지 참이다. pc 를 만든 적이 없으면 거짓이다.
   */
  readonly srflx_seen: boolean;
}

export type MeshSendResult = 'ok' | 'not_open' | 'too_large';

// ── 이벤트 ──────────────────────────────────────────────────────────────────

export interface LinkOpen {
  readonly peer: string;
  readonly sid: string;
  readonly cid: string;
}

/** mesh 가 스스로 링크를 닫을 때 쓰는 사유. */
export type MeshCloseReason = 'ping_timeout' | 'failed' | 'closed' | 'replaced';

export interface LinkClosed {
  readonly peer: string;
  readonly sid: string;
  /** MeshCloseReason, 또는 closeLink 에 준 사유 그대로. */
  readonly reason: string;
}

export interface CandidateCounts {
  readonly host: number;
  readonly srflx: number;
}

/**
 * 실패한 시도의 진단 값. 후보 수는 그 시도가 끝날 때까지 센 값이다.
 * 도중에 새 cid 로 바뀐 시도(MeshEvents 의 "바뀜")는 바뀐 뒤의 것만 센다. 상태, 후보 수, 재전송 횟수, 걸린 시간 모두다.
 */
export interface AttemptDiag {
  /** 라이브러리가 준 상태 이름 그대로. */
  readonly ice_state: string;
  readonly pc_state: string;
  readonly local: CandidateCounts;
  readonly remote: CandidateCounts;
  /** 이 시도에서 시그널을 다시 보낸 횟수. 주기 재전송과 계기(offer-request, 중복 offer 등)로 다시 보낸 것을 합한다. 4를 넘을 수 있다(protocol.md 3.3). */
  readonly resends: number;
  readonly duration_ms: number;
}

/**
 * mesh 가 판정하는 단계는 signaling 과 ice 다. session 단계는 room-session 이 판정한다.
 * 받는 짝은 protocol.md 3.3 의 표 그대로 다섯이다. 표에 없는 끝은 없다.
 * 서버의 RELAY_NOT_ALLOWED 로 끝낸 시도는 `ice` / `failed` 다(handleRelayError).
 */
export type AttemptFailure = Extract<LinkFailure, { stage: 'signaling' | 'ice' }>;

export type AttemptFailed = AttemptFailure & {
  readonly peer: string;
  readonly diag: AttemptDiag;
};

export interface PeerFrame {
  readonly peer: string;
  /** 받은 텍스트 그대로. 해석과 크기·형식 검사는 받는 쪽이 한다(protocol.parseP2PFrame). */
  readonly text: string;
}

export interface PeerPing {
  readonly peer: string;
  readonly sc: number;
  readonly sf: string;
}

/**
 * 시도 하나는 둘 중 하나로 끝난다. 열렸으면 link-open 한 번과 그 뒤의 link-closed 한 번.
 * 열리지 못했으면 attempt-failed 한 번. 열리지 못한 시도는 link-open 도 link-closed 도 내지 않는다.
 *
 * 바뀜: pc 가 있는 진행 중인 시도에 그 피어가 새 cid 의 offer 를 보내면(다시 시작한 상대, 먼저 포기하고 다시 건 상대.
 * protocol.md 3.2 `offer` ④) 기존 pc 를 닫고 새 pc 로 받는다. 이것은 시도의 끝이 아니다.
 * - 이벤트를 내지 않는다. 받는 쪽(room-session)에게는 그 피어와의 시도가 이어지는 것이다.
 * - 기한(PEER_CONNECT_TIMEOUT_MS)은 바뀐 때부터 새로 잰다. 새 pc 가 열릴 시간을 온전히 준다.
 *   그래서 피어 하나의 시도가 처음 시작한 때부터 그 기한을 넘겨 이어질 수 있다.
 * - 닫은 pc 의 콜백과 옛 cid 에 대한 서버 오류(handleRelayError)는 아무 것도 바꾸지 않는다.
 * offer-request 를 보내고 기다리던 시도가 첫 offer 를 받는 것은 바뀜이 아니다. 기한을 새로 재지 않는다.
 *
 * shutdown() 뒤에는 어떤 이벤트도 내지 않는다.
 */
export interface MeshEvents {
  'link-open': (link: LinkOpen) => void;
  'link-closed': (link: LinkClosed) => void;
  'attempt-failed': (failure: AttemptFailed) => void;
  /** 열린 링크로 받은 프레임 가운데 mesh 가 처리한 ping·pong 을 뺀 전부. */
  frame: (frame: PeerFrame) => void;
  /** 상대의 ping 을 받았다. pong 은 mesh 가 이미 보냈다. */
  'peer-ping': (ping: PeerPing) => void;
}

// ── mesh ────────────────────────────────────────────────────────────────────

/**
 * 피어 하나에 살아 있는 pc 는 최대 하나다. relay 후보는 보내지도 넣지도 않는다.
 * 열린 링크는 생존 확인에 실패하기 전에는 새 연결 요청 때문에 닫지 않는다.
 * 새 시도는 스스로 하지 않는다. 시도 안의 시그널 재전송만 한다.
 */
export interface Mesh extends Subscribable<MeshEvents> {
  /**
   * 그 피어와 연결을 시작한다. 내 이름이 작으면 offer, 크면 offer-request 를 보낸다.
   * 열린 링크나 진행 중인 시도가 있으면 아무 것도 하지 않는다.
   */
  contact(peer: string): void;

  /** 서버가 전달한 signal 하나. 목록에 없던 피어의 것도 받는다. joined 전에도 받는다. */
  handleSignal(signal: ServerSignalMessage): void;

  /**
   * 내 signal 에 대한 서버 오류. 그 피어의 진행 중인 시도에만 적용한다.
   * cid 가 그 시도의 cid 와 다르면 옛 시도의 오류다. 아무 것도 하지 않는다.
   * cid 가 null 이면 offer-request 의 오류다. 시도가 아직 offer 를 기다리는 중일 때만 본다.
   * - PEER_NOT_FOUND: attempt-failed `signaling` / `peer_gone` 으로 바로 끝낸다.
   * - SERVER_ERROR: 그 시도의 시그널을 다시 보낸다(SIGNAL_RESEND_MIN_GAP_MS 보다 자주 하지 않는다). 시도는 이어진다.
   * - RELAY_NOT_ALLOWED: attempt-failed `ice` / `failed` 로 바로 끝낸다. pc 를 닫는다.
   *   실패 분류표에 이 경우의 사유가 따로 없어 가장 가까운 "pc 가 닫혔다"를 쓴다.
   *   `peer_gone` 이 아니므로 받는 쪽(room-session)은 필수 목록에서 빼지 않고 연속 실패로 센다.
   *   원인은 로그 `link.attempt_end` 의 `error_code: RELAY_NOT_ALLOWED` 로 남긴다(수준 error. 결함이나 설정 위반이다).
   */
  handleRelayError(error: {
    readonly to: string;
    readonly cid: string | null;
    readonly code: 'PEER_NOT_FOUND' | 'SERVER_ERROR' | 'RELAY_NOT_ALLOWED';
  }): void;

  /**
   * 그 피어의 진행 중인 시도를 지금 끝낸다. 기한이 찼을 때와 같은 분류(`signaling` / `no_offer`·`no_answer`,
   * `ice` / `ice_timeout`)로 attempt-failed 를 이 호출 안에서 한 번 낸다. 시도가 없으면(열린 링크만 있어도) 아무 것도 하지 않는다.
   * room-session 이 입장 기한(JOIN_MESH_TIMEOUT_MS)에 아직 열리지 않은 필수 피어에 부른다.
   * 도중에 바뀐 시도는 자기 기한이 입장 기한보다 늦을 수 있다. 그 피어의 단계와 사유를 얻는 길이 이것 하나다.
   */
  expireAttempt(peer: string): void;

  /** 진행 중인 모든 시도의 시그널을 다시 보낸다(게이트웨이 프레임을 받았을 때). */
  resendPending(): void;

  /** 열린 링크의 교체 확인을 밖에서 시작한다(목록의 sid 가 다를 때). 링크가 없으면 아무 것도 하지 않는다. */
  probe(peer: string): void;

  /** 그 링크의 생존 증거로 친다(state·sync_end 를 받았을 때). */
  markAlive(peer: string): void;

  /** 열린 링크로 텍스트 프레임 하나를 보낸다. UTF-8 크기가 P2P_MAX_FRAME_BYTES 를 넘으면 보내지 않고 too_large. */
  send(peer: string, text: string): MeshSendResult;

  /**
   * 열린 링크를 닫고 link-closed 를 그 사유로 낸다. 진행 중인 시도만 있으면 아무 것도 하지 않는다.
   * 사유는 MeshCloseReason 의 네 값과 겹치지 않게 부르는 쪽이 정한다.
   * 닫기 직전에 send 한 프레임은 작을 때만 도착한다. 보낸 것이 나가기를 기다렸다 닫지 않는다.
   * 같은 PC 에서 8000바이트 이하는 10/10 도착했고 16000바이트 이상은 0/10 이었다(W3 실측, 2026-11-15-w3a).
   * 그래서 닫기 직전에는 bye 와 작은 state(presence{left}) 만 보낸다. 큰 프레임의 도착을 닫기에 걸지 않는다.
   */
  closeLink(peer: string, reason: string): void;

  links(): readonly MeshLink[];

  netInfo(): MeshNetInfo;

  /**
   * 모든 pc 를 닫고 네이티브 정리를 한다. reject 하지 않는다. 여러 번 불러도 된다.
   * 직전에 send 한 프레임의 도착은 closeLink 와 같다(작을 때만 도착한다).
   * 네이티브 정리(cleanup)는 프로세스 전체에 작용한다. 다른 mesh 가 살아 있으면 그 pc 까지 닫힌다(CreateMesh 참고).
   */
  shutdown(): Promise<void>;
}

export type CreateMeshResult =
  | { readonly ok: true; readonly mesh: Mesh }
  | { readonly ok: false; readonly code: 'NATIVE_LOAD_FAILED'; readonly detail: string };

/**
 * `mesh/index.ts` 가 `createMesh` 라는 이름으로 내보낸다. reject 하지 않는다.
 * 네이티브 모듈은 이때 처음 불러온다. 프로세스 시작을 실패시키지 않으려는 것이다.
 * 한 프로세스에서 여러 번 불린다(퇴장 뒤 재입장). 앞 mesh 를 shutdown() 한 뒤에도 새로 만들 수 있어야 한다.
 * **한 프로세스에 살아 있는 mesh 는 하나다.** 네이티브 cleanup() 이 프로세스의 모든 pc 를 콜백 없이 닫기 때문이다.
 * 부르는 쪽(room-session)은 앞 mesh 의 shutdown() 이 끝난 뒤에 다음 mesh 를 만든다.
 * 한 프로세스에 mesh 를 둘 이상 세우는 시험은 모두 함께 끝낸다(`mesh/testing.ts` 의 shutdownAll).
 */
export type CreateMesh = (deps: MeshDeps) => Promise<CreateMeshResult>;
