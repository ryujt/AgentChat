// signaling-core 가 조립에게 요구하는 두 포트의 타입 (architecture.md 3.2, protocol.md 2.3, deployment.md 2.4).
// 구현은 조립이 갖는다: 자체 호스팅은 메모리 Map 과 ws 소켓, 공용은 DynamoDB 와 연결 관리 API.
// 규칙은 core 에만 있다. 포트 구현에는 판정을 넣지 않는다. 이 파일에는 타입만 있다.

/** 조립이 정한 연결 식별자. 프로세스(또는 게이트웨이) 수명 동안 재사용되지 않는다. */
export type ConnId = string;

/**
 * 방을 가리키는 저장소 키. 방 ID 의 SHA-256 16진수 앞 32자리이고 core 가 만든다.
 * 방 ID 는 유일한 접근 수단이라 저장소는 원문을 받지 않는다. 로그의 room_ref 는 같은 해시의 앞 12자리다.
 */
export type RoomKey = string;

/** 참가자 기록. (roomKey, peer) 에 하나이고 연결 하나만 가리킨다. */
export interface PeerRecord {
  readonly roomKey: RoomKey;
  readonly peer: string;
  readonly connId: ConnId;
  readonly sid: string;
  /** resume key 의 SHA-256 16진수. key 원문은 저장하지 않는다. */
  readonly keyHash: string;
  /** 이 기록을 쓴 join 의 접속 순번. */
  readonly seq: number;
  /** 마지막 join·ping 시각(epoch ms). 오래됨 판정은 core 가 읽을 때 한다. */
  readonly lastSeenAt: number;
  /**
   * 읽기(getPeer, listPeers)만 싣는다. 이 판을 판정한 join 처리가 판정을 통과해 차지(claimPeer)했다. 차지되지 않았으면 키가 없다.
   * putPeer 는 이 값을 쓰지 않는다(새 판은 차지되지 않은 판이다). 등록(bind) 전에 실패한 join 의 재전송이 다시 판정받지 않고
   * 등록을 마치는 데 쓴다(검토 3차 SERVER-R3-01, protocol.md 2.3 의 6번).
   */
  readonly claimed?: true;
}

/** 연결이 등록된 자리. */
export interface ConnBinding {
  readonly roomKey: RoomKey;
  readonly peer: string;
  /**
   * 등록할 때의 join.sid. 이 연결이 보낸 signal 에 서버가 붙이는 sid 다.
   * 보낸 쪽의 참가자 기록을 signal 마다 다시 읽지 않으려고 등록에 함께 둔다.
   */
  readonly sid: string;
}

/** hitRate 의 결과. */
export interface RateHit {
  /** 이번 호출을 포함해 `now` 가 속한 고정 창(RATE_WINDOW_MS) 안에서 센 건수. */
  readonly count: number;
  /** 이 연결의 등록. 없으면 null. */
  readonly binding: ConnBinding | null;
}

/**
 * putPeer 의 조건.
 * - `{absent: true}`: (roomKey, peer) 기록이 없을 때만 쓴다.
 * - `{connId, seq}`: 저장된 기록의 연결 ID 와 접속 순번이 방금 읽은 값 그대로일 때만 덮어쓴다.
 */
export type PutPeerCondition =
  | { readonly absent: true }
  | { readonly absent?: false; readonly connId: ConnId; readonly seq: number };

/** 저장된 기록의 연결 ID 가 같을 때만 한다. */
export interface PeerOwnerCondition {
  readonly connId: ConnId;
}

/**
 * deletePeer 의 조건. 저장된 기록의 연결 ID 가 같을 때만 한다.
 * `writtenAt` 을 주면 더해서, 저장된 lastSeenAt 이 그 값(그 처리가 쓴 그대로)이고 아무 처리도 그 기록을 차지(claimPeer)하지 않았을 때만 한다.
 * join 이 사후 판정에 실패해 자기가 쓴 기록을 지울 때 쓴다(검토 1차 SERVER-R1-01).
 */
export interface PeerDeleteCondition extends PeerOwnerCondition {
  readonly writtenAt?: number;
}

/** claimPeer 의 조건. 연결 ID 가 같고 저장된 lastSeenAt 이 `writtenAt` 일 때(판정에 쓴 그 판일 때)만 한다. */
export interface PeerClaimCondition extends PeerOwnerCondition {
  readonly writtenAt: number;
}

/**
 * touchPeer 의 조건. 연결 ID 가 같고, 저장된 lastSeenAt 이 `seenSince` 이상일 때만 한다.
 * core 는 `now - PARTICIPANT_STALE_MS` 를 준다. 이미 오래된 기록은 ping 으로 되살리지 않는다.
 * 오래된 기록은 목록에서 빠져 있었으므로, 그 사이 다른 참가자가 그 자리를 채웠을 수 있다.
 * 되살리면 정원을 넘는다. 그 연결은 NOT_JOINED 를 받고 다시 등록하며, 그때 정원을 다시 판정받는다.
 */
export interface TouchPeerCondition extends PeerOwnerCondition {
  readonly seenSince: number;
}

/**
 * 참가자 기록과 연결 등록의 저장소.
 * - 모든 읽기는 강한 일관성이다. 쓰기 뒤의 읽기는 그 쓰기를 본다.
 * - 조건부 연산은 원자적이다. 조건이 맞지 않으면 아무 것도 바꾸지 않고 false 를 돌려준다(오류가 아니다).
 * - 저장소 자체의 실패(망, 권한 등)만 reject 한다. core 가 SERVER_ERROR 로 바꾼다.
 * - 타이머로 기록을 지우지 않는다. 오래된 기록도 그대로 돌려준다.
 */
export interface RoomStore {
  /**
   * 이 연결의 메시지 한 건을 센다. 건수 올리기와 등록 읽기를 한 번에 한다.
   * 연결 항목이 없으면 만든다.
   */
  hitRate(connId: ConnId, now: number): Promise<RateHit>;

  /** 연결을 (roomKey, peer, sid) 로 등록한다. 이미 있던 등록을 덮어쓰고, 연속 입장 실패 횟수를 0 으로 돌린다. */
  bind(connId: ConnId, binding: ConnBinding): Promise<void>;

  /** 연결 항목(등록, 건수, 실패 횟수)을 지우고 지우기 전의 등록을 돌려준다. 없었으면 null. 여러 번 불러도 된다. */
  unbind(connId: ConnId): Promise<ConnBinding | null>;

  /** 그 기록. 차지된 판이면 `claimed: true` 를 싣는다. */
  getPeer(roomKey: RoomKey, peer: string): Promise<PeerRecord | null>;

  /** 조건이 맞으면 기록 전체를 쓰고 true. record 의 claimed 는 무시한다. 쓴 판은 차지되지 않은 판이다. */
  putPeer(record: PeerRecord, condition: PutPeerCondition): Promise<boolean>;

  /** 방의 모든 참가자 기록. 오래된 것을 거르지 않는다. 순서는 정해져 있지 않다. 차지 표시는 getPeer 와 같다. */
  listPeers(roomKey: RoomKey): Promise<readonly PeerRecord[]>;

  /** 조건이 맞으면 lastSeenAt 을 now 로 바꾸고 true. 기록이 없거나 이미 오래됐으면 false. */
  touchPeer(roomKey: RoomKey, peer: string, condition: TouchPeerCondition, now: number): Promise<boolean>;

  /**
   * 조건이 맞으면 그 기록을 "차지됨"으로 표시하고 true. 이미 표시돼 있어도 조건이 맞으면 true 다(같은 판을 판정한 다른 처리).
   * 기록이 없거나 다른 판이면(지워졌거나 다시 쓰였으면) false. putPeer 로 다시 쓰거나 지우면 표시는 없어진다. touchPeer 는 표시를 그대로 둔다.
   * lastSeenAt 은 바꾸지 않는다.
   * join 이 사후 판정을 통과한 뒤 등록하기 전에 부른다. 표시된 기록은 deletePeer 의 writtenAt 조건으로 지워지지 않는다(protocol.md 2.3 의 6번).
   */
  claimPeer(roomKey: RoomKey, peer: string, condition: PeerClaimCondition): Promise<boolean>;

  /** 조건이 맞으면 기록을 지우고 true. 기록이 없어도 false. */
  deletePeer(roomKey: RoomKey, peer: string, condition: PeerDeleteCondition): Promise<boolean>;

  /** 이 연결의 연속 ROOM_NOT_FOUND 횟수를 원자적으로 1 올리고 올린 뒤의 값을 돌려준다. */
  bumpJoinMiss(connId: ConnId): Promise<number>;
}

/**
 * 연결로 내보내는 길.
 * 그 연결이 없다는 것과 스로틀에 걸렸다는 것은 결과로 알린다. 그 밖의 전송 실패만 reject 한다.
 */
export interface ConnectionSink {
  /**
   * 텍스트 프레임 하나를 보낸다. 연결이 이미 없으면 'gone'.
   * 'throttled' 는 앞단(공용 서버의 스테이지 스로틀)이 이 전송을 거절해 그 글이 버려졌다는 뜻이다. 연결은 그대로다.
   * core 는 이때 오류 응답을 또 보내지 않는다. 스로틀 중에 요구량을 늘리지 않으려는 것이다(검토 1차 SERVER-R1-03).
   * 자체 호스팅 조립은 이 값을 돌려주지 않는다.
   */
  send(connId: ConnId, text: string): Promise<'ok' | 'gone' | 'throttled'>;

  /** 그 연결이 지금 열려 있는가. 이름 충돌 판정(key 가 다른 join)에 쓴다. */
  isOpen(connId: ConnId): Promise<boolean>;

  /** 연결을 닫는다. 이미 없으면 아무 일이 없다. 종료 코드에는 의미를 두지 않는다. */
  close(connId: ConnId): Promise<void>;
}
