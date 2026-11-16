// protocol 모듈의 공개 진입점. 다른 모듈은 이 파일만 import 한다.
// 네트워크·파일·시계에 닿지 않는다. 계약의 설명은 docs/design/protocol.md 에 있다.

export { err, ok } from './result.js';
export type { Err, Ok, Result } from './result.js';

export { utf8ByteLength } from './util.js';

export type { Now, RandomUnit, Subscribable, TimerHandle, Timers, Unsubscribe } from './runtime-ports.js';

export { DATA_CHANNEL_LABEL, LIMITS } from './limits.js';
export type { Limits } from './limits.js';

export {
  CID_PATTERN,
  CID_SEQ_MAX,
  ENTRY_ID_PATTERN,
  ENTRY_SEQ_MAX,
  PEER_NAME_PATTERN,
  REQUEST_ID_PATTERN,
  RESERVED_PEER_NAMES,
  RESUME_KEY_BYTES,
  RESUME_KEY_PATTERN,
  ROOM_ID_GENERATED_LENGTH,
  ROOM_ID_PATTERN,
  SID_LENGTH,
  SID_PATTERN,
  checkPeerName,
  cidSchema,
  comparePeerNames,
  entryIdSchema,
  isCid,
  isEntryId,
  isOfferSide,
  isPeerName,
  isRequestId,
  isReservedPeerName,
  isResumeKey,
  isRoomId,
  isSid,
  makeCid,
  makeEntryId,
  newResumeKey,
  newRoomId,
  newSid,
  parseCid,
  parseEntryId,
  peerNameSchema,
  randomLowerAlnum,
  refOf,
  requestIdSchema,
  resumeKeySchema,
  roomIdSchema,
  sidSchema,
} from './identifiers.js';
export type { CidParts, EntryIdParts, RandomBytes } from './identifiers.js';

export {
  CLIENT_ACTIONS,
  JOIN_MODES,
  SERVER_MESSAGE_TYPES,
  SIGNAL_ERRORS,
  SIGNAL_ERROR_CODES,
  SIGNAL_KINDS,
  clientSignalMessageSchema,
  encodeClientMessage,
  encodeServerMessage,
  errorMessageSchema,
  isSignalErrorCode,
  isSignalMessageTooLarge,
  joinMessageSchema,
  joinedMessageSchema,
  leaveMessageSchema,
  memberSchema,
  parseClientMessage,
  parseServerMessage,
  pingMessageSchema,
  pongMessageSchema,
  serverSignalMessageSchema,
  signalCarriesRelay,
  signalPayloadSchema,
} from './signaling-wire.js';
export type {
  CandidateData,
  CandidateItem,
  ClientAction,
  ClientMessage,
  ClientMessageErrorCode,
  ClientSignalMessage,
  ErrorMessage,
  JoinMessage,
  JoinMode,
  JoinedMessage,
  LeaveMessage,
  Member,
  ParseClientMessageResult,
  ParseServerMessageResult,
  PingMessage,
  PongMessage,
  SdpData,
  ServerFrameErrorCode,
  ServerMessage,
  ServerMessageType,
  ServerSignalMessage,
  SignalErrorCode,
  SignalKind,
  SignalPayload,
} from './signaling-wire.js';

export {
  BYE_REASONS,
  P2P_FRAME_TYPES,
  ackFrameSchema,
  byeFrameSchema,
  chatFrameSchema,
  encodeP2PFrame,
  helloFrameSchema,
  packStateFrames,
  parseP2PFrame,
  pingFrameSchema,
  pongFrameSchema,
  syncEndFrameSchema,
} from './p2p-wire.js';
export type {
  AckFrame,
  ByeFrame,
  ByeReason,
  ChatFrame,
  HelloFrame,
  P2PFrame,
  P2PFrameErrorCode,
  P2PFrameType,
  ParseP2PFrameResult,
  PingFrame,
  PongFrame,
  StateFrame,
  SyncEndFrame,
} from './p2p-wire.js';

export {
  APPEND_RECORD_KINDS,
  CLAIM_OUTCOMES,
  KEY_RECORD_KINDS,
  PRESENCE_KEY_PREFIX,
  PRESENCE_STATUSES,
  RECORD_KINDS,
  STATE_CLOCK_MAX,
  STATE_FINGERPRINT_PATTERN,
  STOP_REASONS,
  TEST_KEY,
  VERIFICATION_RESULTS,
  canonicalBytes,
  canonicalJson,
  claimRecordSchema,
  compareCanonical,
  isAppendRecord,
  isKeyRecord,
  parseStateRecord,
  presenceKey,
  presenceRecordSchema,
  recordByteSize,
  recordIdentity,
  scenarioRecordSchema,
  stateFingerprint,
  stateFingerprintSchema,
  stateRecordSchema,
  stopRecordSchema,
  testRecordSchema,
  verificationRecordSchema,
} from './state-records.js';
export type {
  AppendRecord,
  ClaimOutcome,
  ClaimRecord,
  KeyRecord,
  PresenceRecord,
  PresenceStatus,
  RecordKind,
  ScenarioRecord,
  StateRecord,
  StateRecordErrorCode,
  StopReason,
  StopRecord,
  TestRecord,
  VerificationRecord,
  VerificationResult,
} from './state-records.js';

export { LINK_FAILURE_REASONS, LINK_FAILURE_STAGES, isLinkFailure } from './link-failure.js';
export type { LinkFailure, LinkFailureReason, LinkFailureStage } from './link-failure.js';

export { DEFAULT_SERVER_URL, SELF_HOST_DEFAULT_PORT, normalizeServerAddress } from './server-address.js';
export type { ServerAddress } from './server-address.js';

export {
  DEFAULT_ICE_SERVERS,
  ICE_SERVERS_NONE,
  STUN_DEFAULT_PORT,
  isRelayCandidate,
  parseIceServers,
} from './ice-config.js';
export type { IceServer, IceServers } from './ice-config.js';

export {
  CHANNEL_CHECK_FILE_NAME,
  CHANNEL_CHECK_VERSION,
  channelCheckSchema,
  parseChannelCheck,
  serializeChannelCheck,
} from './local-files.js';
export type { ChannelCheck } from './local-files.js';
