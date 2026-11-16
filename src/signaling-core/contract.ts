// signaling-core 의 공개 계약 (architecture.md 3.2). 규칙의 뜻은 protocol.md 2.3 이 정한다.
// 두 조립(signaling-selfhost, signaling-aws)이 이 타입으로 core 를 세운다. 이 파일에는 타입만 있다.

import type { ServerLogPort } from '../diagnostics/log-port.js';
import type { Now } from '../protocol/index.js';
import type { ConnId, ConnectionSink, RoomStore } from './ports.js';

export type {
  ConnBinding,
  ConnId,
  ConnectionSink,
  PeerClaimCondition,
  PeerDeleteCondition,
  PeerOwnerCondition,
  PeerRecord,
  PutPeerCondition,
  RateHit,
  RoomKey,
  RoomStore,
  TouchPeerCondition,
} from './ports.js';

export interface SignalingCoreDeps {
  readonly store: RoomStore;
  readonly sink: ConnectionSink;
  readonly now: Now;
  /**
   * 서버 로그다. 참가자 이름은 peer_ref, 방은 room_ref, 연결은 conn_ref 로만 남긴다.
   * 타입이 peer 를 받지 않는다. 조립은 보통의 로거를 그대로 넘기면 된다.
   */
  readonly log: ServerLogPort;
}

/**
 * 상태가 없다. 같은 연결의 호출이 동시에·역순으로 들어와도 된다.
 * 두 함수 모두 예상 가능한 실패로는 reject 하지 않는다. 응답은 sink.send 로 나간다.
 * 저장소·전송 오류는 SERVER_ERROR 응답과 로그로 바꾼다. 응답 전송 실패는 무시한다.
 * 보내는 글은 모두 protocol.encodeServerMessage 로 만든다. 그 함수가 BAD_MESSAGE 로 거절하면(규칙 코드의 결함)
 * 그 글을 보내지 않는다. 요청에 대한 응답이었으면 그 요청의 SERVER_ERROR 로 답하고, 전달하던 signal 이었으면
 * 보낸 쪽에 그 signal 의 SERVER_ERROR 로 답한다. 두 경우 모두 로그를 남긴다(수준 error).
 */
export interface SignalingCore {
  /**
   * 받은 텍스트 프레임 하나를 처리한다.
   * 와이어 계약상 바이너리 프레임은 연결을 1003 으로 닫는다(protocol.md 2.1). 자체 호스팅 조립은 넘기지 않고 닫으며,
   * 공용 서버는 API Gateway 가 닫는다. 조립이 그래도 넘기는 경우(본문 없는 이벤트 등)는 빈 문자열로 넘긴다.
   * JSON 이 아니므로 다른 잘못된 입력과 같이 속도 제한에 세고 BAD_MESSAGE 로 답한다.
   */
  onMessage(connId: ConnId, text: string): Promise<void>;

  /** 연결 종료 통지. 참가자 기록을 연결 ID 조건부로 지우고 연결 등록을 지운다. 여러 번 불려도 결과가 같다. */
  onDisconnect(connId: ConnId): Promise<void>;
}

/** `signaling-core/index.ts` 가 `createSignalingCore` 라는 이름으로 내보낸다. */
export type CreateSignalingCore = (deps: SignalingCoreDeps) => SignalingCore;

/** 계약 테스트가 시험마다 부른다. 빈 저장소, 또는 다른 시험과 키가 겹치지 않는 저장소를 돌려준다. */
export type RoomStoreFactory = () => RoomStore | Promise<RoomStore>;

export interface RoomStoreContractOptions {
  /** 묶음의 이름. 두 조립이 같은 묶음을 돌리므로 출력에서 가릴 수 있게 한다. */
  readonly name?: string;
  /**
   * 묶음이 만드는 모든 roomKey 와 connId 의 앞머리. 운영 테이블에 실행할 때 자기 항목만 찾아 지우는 데 쓴다.
   * 생략하면 묶음이 실행마다 무작위로 정한다.
   */
  readonly idPrefix?: string;
}

/**
 * RoomStore 계약 테스트 묶음(V-U7). 시험 전용 진입점 `signaling-core/testing.ts` 가
 * `defineRoomStoreContractTests` 라는 이름으로 내보낸다. 제품 코드는 그 파일을 import 하지 않는다.
 * node:test 의 describe/it 을 등록하고, 시험마다 자기가 만든 항목을 포트 연산으로 지운다.
 */
export type DefineRoomStoreContractTests = (makeStore: RoomStoreFactory, options?: RoomStoreContractOptions) => void;
