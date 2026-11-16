// 에이전트에게 보이는 글: 오류 코드별 안내, 입장 실패의 단계별 안내, 결과의 hint (mcp-interface.md 2~3절).
// 여러 회사의 에이전트가 읽으므로 영어로 쓴다. 다른 참가자가 쓴 글을 이 문장들에 이어 붙이지 않는다.

import type { SignalErrorCode } from '../protocol/index.js';
import type { FailedPeer, SignalingBlockReason, SignalingState } from '../room-session/contract.js';
import type { DirectConnectHints, ToolErrorMessages } from './contract.js';

export const TOOL_ERROR_MESSAGES: ToolErrorMessages = Object.freeze({
  INVALID_ARGUMENT: 'An argument is malformed or out of range.',
  NOT_IN_ROOM: 'You are not in a room. Call create_room or join_room first.',
  ALREADY_IN_ROOM: 'You are already in a room or entering one. Call leave_room first if you want to switch rooms.',
  ICE_CONFIG_REJECTED:
    'The ICE server setting (AGENT_CHAT_ICE_SERVERS) has an entry that is not a plain STUN server. Agent Chat connects peers directly and does not accept TURN or any other relaying server, so it did not connect. Ask your user to fix the setting.',
  NATIVE_LOAD_FAILED: 'The WebRTC native module could not be loaded. Agent Chat has to be installed again.',
  SERVER_UNREACHABLE: 'The signaling server did not answer in time. Check the server address and the network, then try again.',
  SIGNALING_ERROR: 'The signaling server rejected the request. See details.server_code.',
  DIRECT_CONNECT_FAILED:
    'Could not open a direct connection to every participant already in the room. You are not in the room. See details.peers and details.hint.',
  PEER_VERSION_MISMATCH:
    'A participant in the room runs a different Agent Chat version. You are not in the room. Update Agent Chat on both PCs to the same version.',
  CHAT_RATE_LIMITED: 'Too many messages (at most 60 per 60 seconds). Nothing was sent. Wait details.retry_after_ms and send again.',
  RECORD_FAILED: 'The report file could not be written. Check that the Agent Chat home directory is writable.',
  CANCELLED: 'The call was cancelled, or the Agent Chat process is shutting down.',
  TEST_ALREADY_ACTIVE: 'A test is already running in this room. A room has one test and its limits cannot be changed.',
  TEST_ENDED:
    'The test in this room has already ended. A room has one test and it cannot be restarted here. Tell your user; a new test needs a new room.',
  NO_ACTIVE_TEST: 'There is no test in this room yet.',
  TEST_STOPPED: 'The test was stopped. No new scenario can start. Finish recording what you already did, then call write_report.',
  TIME_LIMIT_REACHED: 'The time limit of the test was reached and the test is now stopped. No new scenario can start.',
  SCENARIO_LIMIT_REACHED:
    'The scenario limit of the test was reached. No new scenario can start. Claims and verifications for existing scenarios still work.',
  UNKNOWN_SCENARIO: 'No such scenario in the current test. Use a scenario_id returned by start_scenario, seen in a scenario event, or listed in test.scenarios.items of get_status.',
  SCENARIO_OVER_LIMIT: 'That scenario is over the scenario limit of the test and cannot take claims.',
  UNKNOWN_CLAIM: 'No such claim in the current test. Use a claim_id returned by record_claim, seen in a claim event, or listed in claims.waiting_for_you of get_status.',
  SELF_VERIFY_FORBIDDEN:
    'You cannot verify your own claim. This covers every name this process has used in this room. Another participant has to verify it.',
  STATE_FULL: 'The shared state of this room is full. stop_test and set_status still work.',
  INTERNAL_ERROR: 'Agent Chat hit an unexpected internal error. This is a defect in Agent Chat, not in your call.',
});

const NAME_IN_USE_HINT =
  'That name is already used by a live session in this room. Call again with a different `name` argument. Waiting does not help while the other session is alive.';

/** SIGNALING_ERROR 의 server_code 마다 덧붙이는 안내. 없는 코드는 기본 문구만 쓴다. */
const SIGNALING_CODE_MESSAGES: { readonly [C in SignalErrorCode]?: string } = Object.freeze({
  ROOM_NOT_FOUND: 'No such room on this server, or everyone has left it. Check both `server` and `room_id`.',
  ROOM_EXISTS: 'A room with that room_id already has participants. Omit room_id to get a new random one, or use join_room.',
  ROOM_FULL: 'The room is full.',
  NAME_IN_USE: NAME_IN_USE_HINT,
  UNSUPPORTED_VERSION: 'The signaling server does not support the version of this Agent Chat. Update Agent Chat.',
  RATE_LIMITED: 'The signaling server is rate limiting this connection. Wait details.retry_after_ms before trying again.',
  SERVER_ERROR: 'The signaling server failed internally. Try again.',
});

export function signalingErrorMessage(code: SignalErrorCode): string {
  const extra = SIGNALING_CODE_MESSAGES[code];
  return extra === undefined ? TOOL_ERROR_MESSAGES.SIGNALING_ERROR : `${TOOL_ERROR_MESSAGES.SIGNALING_ERROR} ${extra}`;
}

export const DIRECT_CONNECT_HINTS: DirectConnectHints = Object.freeze({
  signaling:
    'The other participant did not answer the connection request. This does not mean there is no direct path: its process may be stuck or may have already left. Try again in 90 seconds.',
  ice: 'These two PCs cannot reach each other directly (NAT, firewall or blocked UDP). Agent Chat does not use any relaying server. Move to the same network or change the network settings.',
  session: 'The connection opened but the other participant did not finish the handshake in time. It may be busy or the link may be slow. Try again.',
});

/** ice 단계가 하나라도 있으면 그 안내를 쓴다. 직접 연결이 안 된다고 볼 수 있는 유일한 단계다. */
export function directConnectHint(peers: readonly Pick<FailedPeer, 'stage'>[]): string {
  if (peers.some((peer) => peer.stage === 'ice')) return DIRECT_CONNECT_HINTS.ice;
  if (peers.some((peer) => peer.stage === 'signaling')) return DIRECT_CONNECT_HINTS.signaling;
  return DIRECT_CONNECT_HINTS.session;
}

/** notice.signaling 에 붙이는 복구 방법. 채팅은 계속 된다. */
export function signalingNoticeHint(
  state: Exclude<SignalingState, 'connected'>,
  reason: SignalingBlockReason | undefined,
): string {
  if (state === 'detached') {
    return 'Reconnecting to the signaling server has stopped. Chat with connected participants still works, but nobody new can join through you. To recover: leave_room, update Agent Chat, then join again.';
  }
  switch (reason) {
    case 'NAME_IN_USE':
      return 'Another session is using your name on the signaling server, so re-registering is blocked. Chat still works. It retries by itself; if it does not clear, leave_room and join again with a different name.';
    case 'ROOM_FULL':
      return 'The room is full on the signaling server, so re-registering is blocked. Chat still works. It retries by itself.';
    case 'UNSUPPORTED_VERSION':
      return 'The signaling server no longer supports this Agent Chat version. Chat still works for now. To recover: leave_room, update Agent Chat, then join again.';
    default:
      return 'The link to the signaling server is down and is being re-established. Chat with connected participants still works.';
  }
}

export interface EnterHintInput {
  /** 채널 capability 를 선언했는가. */
  readonly channelDeclared: boolean;
  readonly deliveryMode: 'poll' | 'channel';
  /** create_room 에서 에이전트가 room_id 를 직접 정했는가. */
  readonly customRoomId: boolean;
  readonly created: boolean;
}

/** create_room·join_room 결과의 hint. 두 수신 경로를 안내한다(mcp-interface.md 7.1). */
export function enterHint(input: EnterHintInput): string {
  const parts: string[] = [];
  if (input.created) {
    parts.push('Give the other agents both `server` and `room_id`; they need both to join.');
    if (input.customRoomId) {
      parts.push(
        'You chose the room_id yourself. It is the only thing protecting this room and a chosen id can be guessed; omit room_id next time to get a random one.',
      );
    }
  }
  if (input.deliveryMode === 'channel') {
    parts.push(
      'Receiving: delivery_mode is channel. Room events arrive as channel blocks. After handling them, call wait_for_messages once with the cursor of the last block you saw.',
    );
  } else if (input.channelDeclared) {
    parts.push(
      'Receiving: call wait_for_messages now and keep calling it with next_cursor. If a channel block with kind="probe" appears instead, call confirm_channel with its token; from then on events arrive as channel blocks.',
    );
  } else {
    parts.push('Receiving: call wait_for_messages now and keep calling it with next_cursor.');
  }
  return parts.join(' ');
}

export const WAIT_HINTS = Object.freeze({
  timeout: 'No events yet. This is normal: call wait_for_messages again with next_cursor.',
  channel_mode:
    'Channel mode: do not wait here. Room events arrive as channel blocks. After handling them, call wait_for_messages once with the cursor of the last block you saw.',
  more: 'More events are waiting. Call wait_for_messages again right away with next_cursor.',
});

export const CONFIRM_REJECTED_MESSAGE =
  'Unknown channel check token. The delivery mode did not change. Use the token from the most recent channel block with kind="probe".';
