// signaling-client 의 공개 계약 (architecture.md 3.5). 와이어와 재접속 규칙은 protocol.md 2.4~2.7 이 정한다.
// WebRTC 와 방의 의미는 모른다. 이 파일에는 타입만 있다.

import type { LogPort } from '../diagnostics/log-port.js';
import type {
  JoinMode,
  Member,
  Now,
  RandomUnit,
  ServerSignalMessage,
  SignalErrorCode,
  SignalPayload,
  Subscribable,
  Timers,
} from '../protocol/index.js';

// ── 주입받는 것 ─────────────────────────────────────────────────────────────

/** 소켓이 클라이언트에게 알리는 일. 버린 소켓의 늦은 호출은 클라이언트가 세대 번호로 무시한다. */
export interface SignalingSocketHandlers {
  onOpen(): void;
  /** 받은 텍스트 프레임 하나. */
  onText(text: string): void;
  /** 닫혔다. 한 소켓에 한 번만 부른다. 접속에 실패한 경우에도 부른다. */
  onClose(): void;
}

export interface SignalingSocket {
  /** 열려 있지 않으면 보내지 않고 false. 던지지 않는다. */
  send(text: string): boolean;
  /** 여러 번 불러도 된다. 닫히면 onClose 가 온다. */
  close(): void;
}

/**
 * 서버로 가는 소켓을 연다. 생략하면 모듈이 `ws` 로 연다(서브프로토콜과 압축 없음, Origin 헤더 없음).
 * 시험은 가짜 소켓을 넣는다(V-U10). 받는 프레임의 크기 상한은 소켓 구현이 건다.
 */
export type OpenSignalingSocket = (url: string, handlers: SignalingSocketHandlers) => SignalingSocket;

export interface SignalingClientDeps {
  /** protocol.normalizeServerAddress 를 통과한 접속 URL. 방 ID·이름·key 를 싣지 않는다. */
  readonly url: string;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
  /** 재접속 대기와 join 다시 보내기의 무작위 값. 생략하면 Math.random. */
  readonly random?: RandomUnit;
  readonly openSocket?: OpenSignalingSocket;
  /**
   * 다음 접속 순번(join.seq)을 돌려준다. 새 소켓에서 join 을 보낼 때마다 한 번 부른다.
   * 접속 순번은 **프로세스**가 새 연결에서 join 을 보낼 때마다 커지는 값이다(protocol.md 2.2).
   * 클라이언트는 입장마다 새로 만들지만 resume key 는 프로세스에 하나라, 같은 key 를 이어 쓰는 쪽(room-session)이
   * 프로세스 수명 동안 커지기만 하는 값을 넘긴다. 클라이언트마다 1부터 세면, 같은 방에 다시 들어갈 때
   * 서버에 옛 기록(같은 key, 더 큰 seq)이 남아 있으면 그 join 이 REPLACED 로 거절된다.
   * 생략하면 이 클라이언트 안에서 1부터 센다(key 를 한 번만 쓰는 시험과 도구용).
   */
  readonly nextSeq?: () => number;
}

// ── join ────────────────────────────────────────────────────────────────────

/** v, id, seq 는 클라이언트가 붙인다. 재접속의 mode=resume 도 클라이언트가 스스로 보낸다. */
export interface SignalingJoinRequest {
  readonly room: string;
  readonly peer: string;
  readonly sid: string;
  readonly key: string;
  readonly mode: Exclude<JoinMode, 'resume'>;
}

export interface SignalingJoined {
  /** 자신을 뺀 참가자 목록. */
  readonly members: readonly Member[];
  /** 이 목록을 요청한(join 을 보낸) 시각. */
  readonly requestedAt: number;
}

/**
 * join() 이 reject 하는 값.
 * - 서버 오류 코드: 서버가 거절했다. SERVER_ERROR 는 요청 기한까지 다시 보낸 뒤에도 그 답뿐이었을 때의 결과다.
 * - SERVER_UNREACHABLE: 접속 기한 안에 소켓이 열리지 않았거나, 요청 기한 안에 답이 없었거나, 답 전에 끊겼다.
 *   게이트웨이 프레임만 받다 요청 기한이 찬 것도 이것이다. 그 프레임에는 코드가 없어 "답이 없었다"와 같다.
 * - 첫 join 을 기다리는 중의 REPLACED 는 그 코드로 reject 한다(서버 오류 코드의 하나다). 재접속하지 않는다.
 * - CLOSED: 기다리는 중에 leave() 나 close() 가 불렸다.
 */
export interface SignalingJoinFailure {
  readonly code: SignalErrorCode | 'SERVER_UNREACHABLE' | 'CLOSED';
  readonly retryAfterMs?: number;
  /** UNSUPPORTED_VERSION 일 때 서버의 지원 목록. */
  readonly supported?: readonly number[];
}

// ── 이벤트 ──────────────────────────────────────────────────────────────────

/** 서버가 준 참가자 목록. 재접속 뒤의 joined 와 모든 pong 에서 낸다. 첫 join 의 목록은 join() 의 결과로만 준다. */
export interface MembersUpdate {
  readonly members: readonly Member[];
  /** 이 목록을 요청한 시각. 그보다 먼저 열린 링크의 sid 불일치만 교체 확인 대상이다. */
  readonly requestedAt: number;
  readonly source: 'joined' | 'pong';
}

/** 내가 보낸 signal 을 서버가 전달하지 못했다. */
export interface RelayError {
  readonly to: string;
  /** offer-request 는 cid 가 없다. */
  readonly cid: string | null;
  readonly code: 'PEER_NOT_FOUND' | 'SERVER_ERROR' | 'RELAY_NOT_ALLOWED';
}

/**
 * - connected: 이 소켓으로 등록돼 있다.
 * - reconnecting: 끊겼고 다시 붙는 중이다. 열린 DataChannel 과는 무관하다.
 * - detached: 재접속을 멈췄다. UNSUPPORTED_VERSION 뿐이다.
 */
export type SignalingState = 'connected' | 'reconnecting' | 'detached';

/** 재접속이 서버 거절로 막힌 이유. ROOM_FULL·NAME_IN_USE 는 상한 간격으로 계속 시도한다. */
export type SignalingBlockReason = 'ROOM_FULL' | 'NAME_IN_USE' | 'UNSUPPORTED_VERSION';

export interface SignalingStateChange {
  readonly state: SignalingState;
  /** 막힌 이유가 없으면 null. connected 면 항상 null 이다. */
  readonly reason: SignalingBlockReason | null;
}

export interface SignalingClientEvents {
  /** 소켓이 열린 순간부터 낸다. join 의 결과를 기다리지 않는다. */
  signal: (signal: ServerSignalMessage) => void;
  members: (update: MembersUpdate) => void;
  'relay-error': (error: RelayError) => void;
  /** type 없는 프레임을 받았다는 사실만 알린다. 본문은 넘기지 않는다. */
  'gateway-frame': () => void;
  /** state 나 reason 이 바뀔 때마다 한 번. join() 이 성공하면 connected 를 낸다. */
  state: (change: SignalingStateChange) => void;
}

// ── 클라이언트 ──────────────────────────────────────────────────────────────

/**
 * 입장 한 번에 클라이언트 하나를 쓴다. leave() 나 close() 뒤에는 다시 쓰지 않는다.
 * 재접속 루프는 이 안에 하나뿐이다. 재시도는 이 모듈만 한다.
 */
export interface SignalingClient extends Subscribable<SignalingClientEvents> {
  /**
   * 접속해 등록한다. 한 번만 부른다. joined 로 resolve 하거나 SignalingJoinFailure 로 reject 한다.
   * 실패하면 소켓을 닫고 재접속하지 않는다. 성공한 뒤의 끊김은 스스로 다시 붙는다.
   */
  join(request: SignalingJoinRequest): Promise<SignalingJoined>;

  /**
   * 같은 방의 `to` 에게 연결 정보를 보낸다. 큐에 쌓지 않는다.
   * 지금 소켓으로 등록돼 있지 않거나(joined 전, 재접속 중) 크기 상한을 넘으면 보내지 않고 false.
   */
  sendSignal(to: string, payload: SignalPayload): boolean;

  /** leave 를 보내고(연결이 있으면) 소켓과 타이머를 정리한다. reject 하지 않는다. */
  leave(): Promise<void>;

  /** 타이머와 소켓을 모두 정리한다. 보내지 못한 것은 버린다. 여러 번 불러도 된다. 이후 이벤트를 내지 않는다. */
  close(): void;
}

/**
 * `signaling-client/index.ts` 가 `createSignalingClient` 라는 이름으로 내보낸다.
 * 만들기만 하고 접속하지 않는다. 접속은 join() 이 한다.
 */
export type CreateSignalingClient = (deps: SignalingClientDeps) => SignalingClient;
