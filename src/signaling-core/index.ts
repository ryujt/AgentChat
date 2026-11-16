// signaling-core 의 공개 진입점 (architecture.md 3.2).
// 두 조립(signaling-selfhost, signaling-aws)이 이 파일과 contract.ts, ports.ts 만 import 한다.
// 저장소 계약 테스트 묶음은 시험 전용 진입점 testing.ts 에 있다. 제품 코드는 그 파일을 import 하지 않는다.

import type { CreateSignalingCore } from './contract.js';
import { createSignalingCore as create } from './core.js';

export const createSignalingCore: CreateSignalingCore = create;

export type {
  ConnBinding,
  ConnId,
  ConnectionSink,
  CreateSignalingCore,
  PeerClaimCondition,
  PeerDeleteCondition,
  PeerOwnerCondition,
  PeerRecord,
  PutPeerCondition,
  RateHit,
  RoomKey,
  RoomStore,
  SignalingCore,
  SignalingCoreDeps,
  TouchPeerCondition,
} from './contract.js';
