// room-session 의 공개 계약 (architecture.md 3.10). 방 참가 한 번의 조율자다.
// 입장 절차, mesh 보정, P2P 프레임 해석, 채팅 전송, 참가자 표시, 도메인 변화를 수신함 사건으로 바꾸기, 종료를 맡는다.
// 병합 규칙(shared-state), 연결 방법(mesh), 전달 경로(inbox)는 각 소유자에게 맡긴다.
// 이 파일에는 타입만 있다. 결과의 필드 이름은 tool 결과(mcp-interface.md)에 그대로 실리는 이름이다.

import type { LogPort } from '../diagnostics/log-port.js';
import type { Inbox } from '../inbox/contract.js';
import type { CreateMesh } from '../mesh/contract.js';
import type {
  ClaimOutcome,
  IceServers,
  LinkFailure,
  Now,
  PresenceStatus,
  RandomBytes,
  Result,
  SignalErrorCode,
  StopReason,
  Timers,
  VerificationResult,
} from '../protocol/index.js';
import type { OpenTranscript, ReportSummary, WriteReport } from '../records/contract.js';
import type {
  ClaimStatus,
  CreateReplica,
  PresenceBody,
  RuleErrorCode,
  StateCommand,
} from '../shared-state/contract.js';
import type {
  CreateSignalingClient,
  SignalingBlockReason,
  SignalingState,
} from '../signaling-client/contract.js';

// mcp-server 는 아래 모듈의 계약을 직접 가져다 쓰지 않는다. tool 결과에 필요한 타입은 여기서 다시 내보낸다.
export type { ClaimStatus, PresenceBody, RuleErrorCode } from '../shared-state/contract.js';
export type { ReportSummary } from '../records/contract.js';
export type { SignalingBlockReason, SignalingState } from '../signaling-client/contract.js';

// ── 주입받는 것 ─────────────────────────────────────────────────────────────

export interface IceServersSetting {
  /** AGENT_CHAT_ICE_SERVERS 원문. 없으면 null. 로그와 결과에 싣지 않는다. */
  readonly raw: string | null;
  /** protocol.parseIceServers 의 결과. 실패면 create·join 이 접속하지 않고 ICE_CONFIG_REJECTED 를 돌려준다. */
  readonly parsed: Result<IceServers, 'ICE_CONFIG_REJECTED'>;
}

/** 환경 변수에서 온 값 가운데 방 참가에 쓰는 것. 해석은 mcp-server 의 loadConfig 가 한다. */
export interface RoomSessionConfig {
  /**
   * AGENT_CHAT_SERVER 원문. 없으면 null(공용 서버). 검증하지 않은 값이다.
   * `server` 인자가 없을 때만 protocol.normalizeServerAddress 에 넘긴다. 잘못됐으면 INVALID_ARGUMENT 다.
   */
  readonly defaultServer: string | null;
  /** `name` 인자가 없을 때 쓰는 이름. 형식 검증을 통과한 값이다. */
  readonly name: string;
  /** presence.client 에 쓰는 값. */
  readonly client: string;
  readonly iceServers: IceServersSetting;
  /** AGENT_CHAT_HOME. 기록 파일의 뿌리다. 쓸 수 없는 경로면 기록 없이 동작한다. */
  readonly home: string;
}

/** hello.client 와 기록 파일 첫 줄에 쓰는 이 패키지의 이름과 버전. */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
}

export interface RoomSessionLimits {
  /** listening 변화로 presence 를 다시 쓰는 최소 간격. 그 사이의 변화는 마지막 값만 쓴다. */
  readonly PRESENCE_MIN_INTERVAL_MS: number;
  /** resend_of 가 찾는 보낸 메시지 버퍼의 크기. */
  readonly SENT_BUFFER_SIZE: number;
}

/** 제품 기본값(architecture.md 5절). `room-session/index.ts` 가 이 타입의 상수 `DEFAULT_ROOM_SESSION_LIMITS` 를 내보낸다. */
export interface DefaultRoomSessionLimits extends RoomSessionLimits {
  readonly PRESENCE_MIN_INTERVAL_MS: 5000;
  readonly SENT_BUFFER_SIZE: 200;
}

/**
 * room-session 이 inbox 에서 쓰는 부분. 나머지는 mcp-server 만 부른다.
 * 방을 나가는 모든 길(leave, create·join 의 실패와 취소)의 정리에서 discardAll() 을 부른다.
 * 수신함은 프로세스에 하나라, 비우지 않으면 이 방의 글과 테스트 요청이 다음 방의 사건으로 나간다.
 */
export type SessionInbox = Pick<Inbox, 'push' | 'discardAll' | 'mode' | 'listening' | 'on'>;

/**
 * 하위 모듈은 만드는 함수로 받는다. 입장할 때마다 새로 만든다(이름, sid, 서버 주소가 그때 정해진다).
 * room-session 은 하위 모듈의 구현을 import 하지 않는다. 시험은 여기에 가짜를 넣는다.
 */
export interface RoomSessionDeps {
  readonly config: RoomSessionConfig;
  readonly app: AppInfo;
  readonly limits: RoomSessionLimits;
  readonly inbox: SessionInbox;
  readonly createSignalingClient: CreateSignalingClient;
  readonly createMesh: CreateMesh;
  readonly createReplica: CreateReplica;
  readonly openTranscript: OpenTranscript;
  readonly writeReport: WriteReport;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
  /** 방 ID, sid, resume key 를 만들 때 쓴다. 생략하면 node:crypto. key 는 만들 때 한 번 정하고 저장하지 않는다. */
  readonly randomBytes?: RandomBytes;
}

// ── 입력 ────────────────────────────────────────────────────────────────────

export interface CreateRoomArgs {
  readonly server?: string;
  /** 생략하면 무작위 16자를 만든다. */
  readonly room_id?: string;
  readonly name?: string;
  /** 호스트의 취소. 취소되면 입장 실패와 같이 정리하고 CANCELLED 를 돌려준다. */
  readonly signal?: AbortSignal;
}

export interface JoinRoomArgs {
  readonly room_id: string;
  readonly server?: string;
  readonly name?: string;
  readonly signal?: AbortSignal;
}

/**
 * 관전 입장(protocol.md 4.6, architecture.md 3.10 의 관전 모드). join 과 같은 인자다.
 * 시그널링 join(mode=join) 으로 들어가 join 과 같은 입장 판정을 한다. 방을 만들지 않는다.
 */
export type ObserveRoomArgs = JoinRoomArgs;

export interface SendChatArgs {
  /** UTF-8 16384바이트 이하. resend_of 를 주면 무시하고 원문을 쓴다. */
  readonly text: string;
  /** 생략하면 방 전체. */
  readonly to?: readonly string[];
  /** 이전 message_id. 같은 ID 로 다시 보낸다. */
  readonly resend_of?: string;
}

/**
 * 공유 상태를 바꾸는 tool 호출. type 은 tool 이름과 같다(기록 파일 rule 줄의 tool 값이 된다).
 * 입력의 상한(글자 수, 개수, 범위)과 기본값은 부르는 쪽(mcp-server)이 건다.
 */
export type SessionCommand =
  /** 준 필드만 바꾼다. role 은 null 로 지운다. 자기 것만 바꾼다. */
  | {
      readonly type: 'set_status';
      readonly status?: Exclude<PresenceStatus, 'left'>;
      readonly role?: string | null;
      readonly tools?: readonly string[];
      readonly note?: string | null;
      /**
       * false 만 받는다. 에이전트가 지금부터 듣지 않는다고 알린다. 부르는 쪽(mcp-server)이 먼저 inbox.pauseListening() 을 부르고,
       * room-session 은 그때의 inbox.listening() 을 presence 에 바로 쓴다(유예를 기다리지 않는다). 다음 wait 이 풀어 준다.
       */
      readonly listening?: false;
    }
  /** reason 은 사용자가 말한 중단 사유 글이다. stop 기록의 detail 이 된다. */
  | { readonly type: 'stop_test'; readonly reason: string }
  | Extract<StateCommand, { type: 'start_test' | 'start_scenario' | 'record_claim' | 'record_verification' }>;

export type SessionCommandType = SessionCommand['type'];

// ── 결과: 참가자와 상태 ─────────────────────────────────────────────────────

/** open 은 동기화까지 끝난 링크다. connecting 은 시도 중이거나 동기화 전이다. */
export type LinkStatus = 'open' | 'connecting' | 'none';

/** 표시용 판정. mcp-interface.md 3.4 의 표를 위에서부터 처음 맞는 행으로 정한다. */
export type ShownAs = 'ready' | 'working' | 'not_ready' | 'unreachable' | 'left' | 'connecting' | 'disconnected';

/** presence 를 아직 못 받은 참가자는 client, tools, role, status, listening 이 null 이다. */
export interface ParticipantView {
  readonly name: string;
  readonly client: string | null;
  readonly tools: readonly string[] | null;
  readonly role: string | null;
  readonly status: PresenceStatus | null;
  readonly link: LinkStatus;
  readonly listening: boolean | null;
  readonly shown_as: ShownAs;
}

export interface TestStatus {
  readonly test_id: string;
  readonly request: string;
  /** 테스트를 시작한 참가자. */
  readonly by: string;
  /** started_wall 의 UTC ISO 8601. 표시용이다. */
  readonly started: string;
  readonly max_duration_min: number;
  /** 이 프로세스가 잰 경과 시간으로 계산한 남은 시간. 분으로 올림한다. 0 이면 기한이 지났다. */
  readonly remaining_min: number;
  readonly stopped: {
    readonly reason: StopReason;
    readonly by: string;
    /** 중단 기록의 벽시계(UTC ISO 8601). 표시용이다. */
    readonly at: string;
    readonly detail: string;
  } | null;
  readonly scenarios: {
    readonly used: number;
    readonly max: number;
    /**
     * 한도 안의 유효 시나리오 가운데 최근 SCENARIO_ITEMS_MAX 개(views.ts). 순번 순이다.
     * 재입장한 행동자가 주장을 붙일 scenario_id 를, 재입장한 검증자가 자기가 맡은 시나리오를 안다(검토 3차 PRODUCT-R3-01).
     */
    readonly items: readonly ScenarioItem[];
    /** 싣지 못한 앞쪽 유효 시나리오의 수. */
    readonly items_omitted: number;
  };
}

/** 시나리오 한 줄. 계획(plan)은 크기 때문에 싣지 않는다(scenario 사건에 있다). actor·verifier 는 합의를 적은 칸이고 강제하지 않는다. */
export interface ScenarioItem {
  readonly scenario_id: string;
  readonly index: number;
  readonly title: string;
  readonly by: string;
  readonly actor: string | null;
  readonly verifier: string | null;
}

/**
 * 나를 기다리는 주장(검토 3차 PRODUCT-R3-01). 검증자가 tool 결과만으로 무엇을 확인할지 알게 내용을 싣는다.
 * 글자 필드(action, expected, observed, steps)의 합은 결과 하나에 WAITING_TEXT_BUDGET_BYTES(views.ts)까지다. 넘는 뒤쪽 주장은
 * 글자 필드가 null 이고 text_omitted 가 참이다. 첫 주장은 늘 싣는다. 앞의 주장을 검증하면 다음 get_status 에 실린다.
 */
export interface WaitingClaim {
  readonly claim_id: string;
  readonly scenario_id: string;
  readonly by: string;
  readonly outcome: ClaimOutcome;
  readonly action: string | null;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly steps: string | null;
  readonly text_omitted: boolean;
}

export interface ClaimCounts {
  /** 중단 뒤 기록이 아닌 주장을 상태별로 센다. */
  readonly confirmed: number;
  readonly refuted: number;
  readonly unverified: number;
  /** 중단 뒤 기록. */
  readonly late: number;
  /** 내가 검증할 수 있는 미확인 주장(이 프로세스가 이 방에서 쓴 이름이 작성자도 검증자도 아닌 것). 주장 순서(lc, author, rid)다. */
  readonly waiting_for_you: readonly WaitingClaim[];
}

export type SessionWarning =
  /**
   * 직접 연결을 열지 못한 참가자(`shown_as` 가 unreachable 인 참가자). 내 글이 가지 않는다.
   * 처음 연결하는 중인 참가자(connecting)와 끊긴 참가자(disconnected)는 싣지 않는다. 입장 때마다 잠깐 뜨는 경고가 되기 때문이다.
   */
  | { readonly code: 'unreachable'; readonly peer: string }
  /** 같은 이름의 다른 세션이 서버에 등록됐다. */
  | { readonly code: 'name_conflict' }
  | {
      readonly code: 'signaling';
      readonly state: Exclude<SignalingState, 'connected'>;
      readonly reason: SignalingBlockReason | null;
    }
  /** 스냅샷을 주고받아도 맞춰지지 않는 복제본 차이. */
  | { readonly code: 'state_diverged'; readonly peer: string }
  /** 시계 차이 60초 초과. */
  | { readonly code: 'clock_skew'; readonly peer: string }
  | { readonly code: 'record_failed' };

/**
 * 관전자 한 명(protocol.md 4.6). 이 세션에서 hello.observer: true 를 받은 이름 가운데, 지금 링크가 있거나 서버 목록에 있는 것.
 * bye{leave|shutdown} 로 닫히면 빠진다. 같은 이름이 hello.observer: false 로 다시 들어오면 참가자로 옮긴다.
 */
export interface ObserverView {
  readonly name: string;
  /** ParticipantView.link 와 같은 뜻. */
  readonly link: LinkStatus;
  /** 그 관전자(그 sid)의 hello 를 처음 받은 때(UTC ISO 8601). */
  readonly since: string;
}

/** get_status 의 결과에서 delivery_mode 와 mcp-server 가 더하는 경고(수신함 누락, 무시한 설정)를 뺀 것. */
export interface SessionStatus {
  readonly room: {
    readonly room_id: string;
    /** 정규화한 서버 키. */
    readonly server: string;
    readonly name: string;
    readonly signaling: SignalingState;
    readonly net: {
      /** ICE 설정에 STUN 서버가 하나라도 있는가. */
      readonly stun: boolean;
      /** mesh.netInfo() 의 값 그대로. */
      readonly srflx_seen: boolean;
    };
  };
  /**
   * 자신을 뺀다. presence 가 있는 이름, 링크가 있거나 시도 중인 피어, 서버가 가장 최근에 준 목록의 합집합이다.
   * 알려진 관전자는 뺀다(observers 에 싣는다).
   */
  readonly participants: readonly ParticipantView[];
  /** 읽기 전용으로 지켜보는 관전자. 준비 판정·waiting_for_you·도달 범위·unreachable 경고에 들지 않는다. */
  readonly observers: readonly ObserverView[];
  readonly test: TestStatus | null;
  readonly claims: ClaimCounts;
  readonly warnings: readonly SessionWarning[];
}

/** 모든 tool 결과의 notice 에 붙이는 조각. 수신함을 보지 않는 에이전트도 놓치지 않게 한다. */
export interface SessionNotice {
  readonly test_stopped?: { readonly reason: StopReason; readonly by: string };
  readonly signaling?: {
    readonly state: Exclude<SignalingState, 'connected'>;
    readonly reason?: SignalingBlockReason;
  };
  /** 직접 연결을 열지 못한 참가자의 이름(`shown_as` 가 unreachable). SessionWarning 의 unreachable 과 같은 범위다. */
  readonly unreachable?: readonly string[];
  readonly record_failed?: true;
}

// ── 결과: 동작별 ────────────────────────────────────────────────────────────

export interface RoomEntered {
  readonly room_id: string;
  /** 정규화한 서버 키. 다른 에이전트에게 room_id 와 같이 전해야 한다. */
  readonly server: string;
  readonly name: string;
  /**
   * join 은 SessionStatus.participants 와 같다(자신을 뺀다).
   * create 는 자신 한 명을 싣는다(mcp-interface.md 3.1). 자기 행은 link 가 none 이고,
   * shown_as 는 자기 status 로만 정한다(ready → ready, working → working, 그 밖 → not_ready).
   */
  readonly participants: readonly ParticipantView[];
  /** 입장한 때 이미 방을 지켜보던 관전자(hello.observer: true 를 받은 피어). create 는 빈 목록이다. */
  readonly observers: readonly ObserverView[];
  /** 현재 테스트. 재입장자는 여기서 목표와 남은 제한을 받는다. create 는 null. */
  readonly test: TestStatus | null;
  /**
   * 입장하며 쓴 자기 presence(검토 1차 PRODUCT-R1-01). 재입장이면(스냅샷에 자기 옛 presence 가 있었으면) 옛 역할과 도구를 이어받는다.
   * 상태는 늘 joined 이고 메모는 비운다. 에이전트는 이것으로 자기가 맡았던 역할을 알고, 준비되면 set_status 로 알린다.
   */
  readonly you: SelfEntered;
}

export interface SelfEntered {
  readonly role: string | null;
  readonly tools: readonly string[];
  readonly status: PresenceStatus;
  readonly note: string | null;
  /** 스냅샷에 이 이름의 옛 presence 가 있었다(같은 이름으로 다시 들어왔다). */
  readonly rejoined: boolean;
}

export interface RoomLeft {
  readonly left: true;
  /** 기록 파일을 열지 못했으면 null. */
  readonly transcript_path: string | null;
  /**
   * 나갈 때 수신함에 남아 있던, 에이전트에게 한 번도 전달하지 않은 사건의 수(inbox.discardAll() 의 값).
   * 그 사건은 버린다. 다음 방에서 나오지 않는다. 글과 상태 기록은 기록 파일에 있다.
   */
  readonly undelivered_events: number;
}

export interface ChatSent {
  readonly message_id: string;
  /** 상대 프로세스가 받아 기록하고 수신함에 넣었다고 확인한 참가자. */
  readonly delivered: readonly string[];
  /** ack_timeout 은 결과 불명이다. 실패 확정이 아니다. */
  readonly undelivered: readonly { readonly name: string; readonly reason: 'not_connected' | 'ack_timeout' }[];
  /**
   * 수신자 가운데 지금 에이전트가 듣고 있지 않은 참가자(presence.listening 이 거짓)와 그렇게 된 시각(UTC ISO 8601).
   * delivered 여도 그 에이전트는 아직 읽지 않는다. 한 명도 없으면 싣지 않는다.
   */
  readonly not_listening?: readonly NotListening[];
}

export interface NotListening {
  readonly name: string;
  /** presence.listening 이 거짓이 된 때(그 참가자가 presence 를 쓴 벽시계). 입장 때 이미 그랬으면 근삿값이다. */
  readonly since: string;
}

/**
 * 점검 결과 한 명(ping_room). 시간은 점검 글을 보낸 때부터 잰 이 PC 의 ms 다.
 * - read: 그 에이전트가 점검 글을 꺼내 갔다(read_ms).
 * - not_listening: 전달은 됐지만 그 에이전트가 듣고 있지 않다(presence.listening 이 거짓). 기한 안에 읽지 않았다.
 * - not_read: 전달은 됐고 듣는 중으로 보이지만 기한 안에 읽지 않았다(다른 일을 하는 중이거나 구버전이다).
 * - no_ack: 보냈지만 받았다는 확인이 오지 않았다(결과 불명).
 * - not_connected: 나와 링크가 없어 보내지 못했다.
 */
export interface PingPeer {
  readonly name: string;
  readonly outcome: 'read' | 'not_listening' | 'not_read' | 'no_ack' | 'not_connected';
  readonly delivered_ms: number | null;
  readonly read_ms: number | null;
  /** 그 참가자의 presence.listening. presence 를 못 받았으면 null. */
  readonly listening: boolean | null;
}

export interface PingSent {
  readonly message_id: string;
  readonly participants: readonly PingPeer[];
  /** outcome 이 not_listening 인 참가자. */
  readonly not_listening: readonly NotListening[];
}

export interface PingArgs {
  /** 듣는 중인 참가자의 읽음 확인을 기다리는 최대 시간. */
  readonly timeoutMs: number;
}

/** 관전 요약의 시나리오 한 줄. 한도 초과를 포함해 전부 싣는다. 값은 shared-state 의 view 를 이름만 바꿔 옮긴다. */
export interface ObservedScenario {
  readonly scenario_id: string;
  readonly index: number;
  readonly title: string;
  readonly by: string;
  readonly plan: string | null;
  readonly actor: string | null;
  readonly verifier: string | null;
  readonly over_limit: boolean;
  /** 작성자의 벽시계(UTC ISO 8601). 표시용이다. */
  readonly wall: string;
}

export interface ObservedVerification {
  readonly by: string;
  readonly result: VerificationResult;
  readonly evidence: string;
  /** 판정에 넣는가. 주장 작성자가 쓴 검증은 거짓이다. */
  readonly counted: boolean;
  readonly wall: string;
}

/** 관전 요약의 주장 한 줄. 전부 싣는다. */
export interface ObservedClaim {
  readonly claim_id: string;
  readonly scenario_id: string;
  readonly by: string;
  readonly outcome: ClaimOutcome;
  readonly action: string;
  readonly expected: string | null;
  readonly observed: string;
  readonly steps: string;
  readonly status: ClaimStatus;
  /** 중단 뒤 기록. */
  readonly late: boolean;
  readonly wall: string;
  readonly verifications: readonly ObservedVerification[];
}

/**
 * 관전 요약(observe 의 결과, observed()). 지금 복제본과 링크로 만든다.
 * **room_id 는 싣지 않는다.** 출력 쪽(콘솔)이 방 ID(접근 수단)를 실수로 찍지 못하게 타입에서 뺀다.
 */
export interface RoomObserved {
  /** 정규화한 서버 키. */
  readonly server: string;
  /** 이 세션의 이름. */
  readonly name: string;
  readonly signaling: SignalingState;
  /** 자신과 알려진 관전자를 뺀 참가자. SessionStatus.participants 와 같은 규칙이다. */
  readonly participants: readonly ParticipantView[];
  /** 자신을 뺀 관전자. */
  readonly observers: readonly ObserverView[];
  /** 관전자를 모르는 구버전 참가자(그 링크의 hello 에 observer 가 없었다). 그쪽에는 관전 사실이 표시되지 않는다. */
  readonly unaware: readonly string[];
  readonly test: TestStatus | null;
  readonly scenarios: readonly ObservedScenario[];
  readonly claims: readonly ObservedClaim[];
}

export interface ReportWritten {
  readonly path: string;
  readonly summary: ReportSummary;
}

/** 기록을 보낸 열린 링크의 참가자와, 방에 있지만 나와 링크가 없는 참가자. */
export interface Reach {
  readonly sent_to: readonly string[];
  readonly not_connected: readonly string[];
}

/** command 의 type 마다 돌려주는 성공 결과. */
export interface CommandOutputs {
  set_status: { readonly presence: PresenceBody };
  start_test: Reach & {
    readonly test_id: string;
    readonly limits: { readonly max_duration_min: number; readonly max_scenarios: number };
  };
  /**
   * 이미 중단됐어도 성공이다. 그때는 새 기록을 쓰지 않으므로 보낸 것이 없다.
   * sent_to 에는 지금 동기화까지 끝난 링크의 참가자를 싣는다(스냅샷 교환으로 중단 기록을 이미 갖고 있다).
   * 비워 두면 에이전트가 "아무에게도 닿지 않았다"고 잘못 알리게 된다.
   */
  stop_test: Reach & { readonly stopped: true; readonly test_id: string };
  /** remaining 은 더 시작할 수 있는 시나리오 수다. */
  start_scenario: { readonly scenario_id: string; readonly index: number; readonly remaining: number };
  /** late 가 참이면 중단 뒤 기록이다. */
  record_claim: { readonly claim_id: string; readonly status: 'unverified'; readonly late: boolean };
  record_verification: { readonly verification_id: string; readonly claim_status: ClaimStatus };
}

// ── 결과 코드 ───────────────────────────────────────────────────────────────

/**
 * 방 동작의 결과 코드. mcp-server 가 같은 이름의 tool 오류로 옮긴다.
 *
 * | 코드 | 나오는 곳 | 뜻 |
 * |---|---|---|
 * | INVALID_ARGUMENT | create, join, observe, sendChat, command | 서버 주소, 이름, 예약 이름, 방 ID, 크기, 모르는 수신자, 버퍼에 없는 resend_of, 기록 크기 |
 * | NOT_IN_ROOM | leave, sendChat, command, status, observed, writeReport | 방에 없다(입장 중에도 이것이다). 관전 중의 command·writeReport·ping 도 이것이다 |
 * | ALREADY_IN_ROOM | create, join, observe | 방에 있거나 입장 중이다 |
 * | ICE_CONFIG_REJECTED | create, join, observe | ICE 설정 위반. 접속하지 않았다 |
 * | NATIVE_LOAD_FAILED | create, join, observe | mesh 를 만들지 못했다 |
 * | SERVER_UNREACHABLE | create, join, observe | 기한 안에 시그널링 서버에 접속·등록하지 못했다 |
 * | SIGNALING_ERROR | create, join, observe | 서버가 거절했다. 필수 피어가 모두 빠진 join 도 이것이다(server_code ROOM_NOT_FOUND) |
 * | DIRECT_CONNECT_FAILED | join, observe | 기존 참가자 전원과 연결·동기화하지 못했다. 방에서 나간 상태다 |
 * | PEER_VERSION_MISMATCH | join, observe | 기존 참가자와 P2P 버전이 다르다. 방에서 나간 상태다. 실패한 피어가 모두 버전 불일치일 때만 이 코드다. 다른 실패가 섞이면 DIRECT_CONNECT_FAILED 이고 그 피어는 peers 에 `session` / `version` 으로 실린다(theirs 는 싣지 않는다) |
 * | CHAT_RATE_LIMITED | sendChat | 60초에 60건 초과. 아무에게도 보내지 않았다 |
 * | RECORD_FAILED | writeReport | 보고서 파일을 쓰지 못했다 |
 * | CANCELLED | create, join, observe, 종료 중의 모든 호출 | 호출이 취소됐거나 shutdown 이 시작됐다 |
 * | RuleErrorCode | command, writeReport(NO_ACTIVE_TEST) | shared-state 의 규칙 거절. 기록 파일에 rule 줄을 남긴다 |
 *
 * 입장이 실패로 끝나면 열린 링크와 서버 등록이 남지 않는다. 입장 도중 수신함에 넣은 사건도 남지 않는다
 * (discardAll. 버린 수는 inbox 가 로그에 남긴다).
 */
export type SessionErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_IN_ROOM'
  | 'ALREADY_IN_ROOM'
  | 'ICE_CONFIG_REJECTED'
  | 'NATIVE_LOAD_FAILED'
  | 'SERVER_UNREACHABLE'
  | 'SIGNALING_ERROR'
  | 'DIRECT_CONNECT_FAILED'
  | 'PEER_VERSION_MISMATCH'
  | 'CHAT_RATE_LIMITED'
  | 'RECORD_FAILED'
  | 'CANCELLED'
  | RuleErrorCode;

export interface SignalingErrorDetails {
  readonly server_code: SignalErrorCode;
  readonly retry_after_ms?: number;
}

/**
 * 실패한 피어 하나. signaling·ice 단계의 진단 값은 mesh 의 attempt-failed 에서 온다. session 단계는 null 이다.
 * 필수 목록에서 빼는 것은 `signaling` / `peer_gone` 과 상대의 bye{leave|shutdown} 뿐이다.
 * 그 밖의 attempt-failed 는 모두 실패로 싣고 연속 실패로 센다(RELAY_NOT_ALLOWED 로 끝난 `ice` / `failed` 포함).
 * 입장 기한(JOIN_MESH_TIMEOUT_MS)에 아직 시도 중인 필수 피어는 mesh.expireAttempt 로 끝내 그 attempt-failed 를 싣는다.
 */
export type FailedPeer = LinkFailure & {
  readonly name: string;
  readonly ice_state: string | null;
  readonly candidates: {
    readonly local: { readonly host: number; readonly srflx: number };
    readonly remote: { readonly host: number; readonly srflx: number };
  } | null;
  readonly resends: number | null;
};

export interface DirectConnectFailedDetails {
  /** JOIN_MESH_TIMEOUT_MS. */
  readonly timeout_ms: number;
  /** 실패한 피어 전부. 서로 다른 단계에서 실패했으면 모두 싣는다. 단계별 안내는 mcp-server 가 붙인다. */
  readonly peers: readonly FailedPeer[];
}

export interface PeerVersionMismatchDetails {
  /** theirs 는 상대 프레임의 v. bye{version} 만 받았으면 null. */
  readonly peers: readonly { readonly name: string; readonly theirs: number | null }[];
  readonly mine: number;
}

type DetailedErrorCode = 'SIGNALING_ERROR' | 'DIRECT_CONNECT_FAILED' | 'PEER_VERSION_MISMATCH' | 'CHAT_RATE_LIMITED';

/** 실패 결과. detail 은 원인을 짧게 적은 글이다. 다른 참가자가 쓴 글을 싣지 않는다. */
export type SessionFailure =
  | { readonly ok: false; readonly code: 'SIGNALING_ERROR'; readonly details: SignalingErrorDetails; readonly detail?: string }
  | {
      readonly ok: false;
      readonly code: 'DIRECT_CONNECT_FAILED';
      readonly details: DirectConnectFailedDetails;
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly code: 'PEER_VERSION_MISMATCH';
      readonly details: PeerVersionMismatchDetails;
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly code: 'CHAT_RATE_LIMITED';
      readonly details: { readonly retry_after_ms: number };
      readonly detail?: string;
    }
  | { readonly ok: false; readonly code: Exclude<SessionErrorCode, DetailedErrorCode>; readonly detail?: string };

export type SessionResult<T> = ({ readonly ok: true } & T) | SessionFailure;

// ── 세션 ────────────────────────────────────────────────────────────────────

/**
 * 프로세스에 하나다. 한 번에 방 하나에만 있는다. 어떤 함수도 예상 가능한 실패로 reject 하거나 던지지 않는다.
 * 방에 있지 않으면 create·join 외에는 NOT_IN_ROOM 이다.
 */
export interface RoomSession {
  /** 방을 만든다. 성공하면 방에 있는 상태다. */
  create(args: CreateRoomArgs): Promise<SessionResult<RoomEntered>>;

  /**
   * 방에 들어가 기존 참가자 전원과 연결·동기화한다. 최악의 경우 약 40초 걸린다.
   * 하나라도 실패하면 방에서 나가고 실패를 돌려준다. 부분 입장 상태는 없다.
   */
  join(args: JoinRoomArgs): Promise<SessionResult<RoomEntered>>;

  /** presence{left} 와 bye{leave} 를 보내고 서버 등록을 지우고 기록 파일을 닫고 수신함을 비운다. */
  leave(): Promise<SessionResult<RoomLeft>>;

  /** 수신자에게 직접 보내고 수신자별 ack 를 기다려(5초) 결과를 돌려준다. */
  sendChat(args: SendChatArgs): Promise<SessionResult<ChatSent>>;

  /**
   * 점검(ping_room). 자신과 관전자를 뺀 참가자 전원에게 읽음 확인을 요청한 고정 글을 보낸다. ack 를 기다린 뒤,
   * 듣는 중인 수신자의 읽음 확인을 timeoutMs 까지 기다린다. 보내기는 sendChat 과 같은 규칙(속도 상한, 기록 파일)을 따른다.
   */
  ping(args: PingArgs): Promise<SessionResult<PingSent>>;

  /**
   * 관전자로 방에 들어간다(protocol.md 4.6). 입장 판정과 결과 코드는 join 과 같다. 새 결과 코드는 없다.
   * 관전 중에는 공유 상태에 기록을 쓰지 않고 기록 파일을 열지 않는다. 채팅은 보낼 수 있다(sendChat. 사람이 관전 콘솔에서
   * 에이전트들에게 지시한다. 받는 쪽 사건의 data.observer 가 참이다). command·writeReport·ping 은 NOT_IN_ROOM(detail `observing read-only`)이다.
   */
  observe(args: ObserveRoomArgs): Promise<SessionResult<RoomObserved>>;

  /** 방에 있으면(관전이든 참가든) 지금 복제본과 링크로 만든 요약. 없으면 NOT_IN_ROOM. */
  observed(): SessionResult<RoomObserved>;

  /** 공유 상태를 바꾸고 열린 링크 전부에 변경으로 보낸다. */
  command<C extends SessionCommand>(command: C): Promise<SessionResult<CommandOutputs[C['type']]>>;

  status(): SessionResult<SessionStatus>;

  /** 로컬 복제본으로 보고서 파일을 만든다. 방에 올리지 않는다. 테스트 기록이 없으면 NO_ACTIVE_TEST. */
  writeReport(): Promise<SessionResult<ReportWritten>>;

  /** 방에 있으면 지금 붙일 notice 조각, 없으면 null. mcp-server 가 모든 tool 결과에 쓴다. 던지지 않는다. */
  notice(): SessionNotice | null;

  /**
   * 프로세스 종료용. 예산 안에 presence{left}·bye{shutdown} 전송 → 서버 leave → 링크 정리(mesh.shutdown) → 기록 파일 닫기를 하고,
   * 예산을 넘기면 남은 단계를 건너뛴다. reject 하지 않는다. 진행 중이던 호출과 이후의 호출은 CANCELLED 다.
   */
  shutdown(budgetMs: number): Promise<void>;
}

/** `room-session/index.ts` 가 `createRoomSession` 이라는 이름으로 내보낸다. 만들 때는 아무 데도 접속하지 않는다. */
export type CreateRoomSession = (deps: RoomSessionDeps) => RoomSession;
