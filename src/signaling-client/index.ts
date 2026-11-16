// signaling-client 의 공개 진입점. 다른 모듈은 이 파일과 contract.ts 만 import 한다.

import type { CreateSignalingClient } from './contract.js';
import { createSignalingClient as create } from './client.js';

export const createSignalingClient: CreateSignalingClient = create;

export type {
  CreateSignalingClient,
  MembersUpdate,
  OpenSignalingSocket,
  RelayError,
  SignalingBlockReason,
  SignalingClient,
  SignalingClientDeps,
  SignalingClientEvents,
  SignalingJoinFailure,
  SignalingJoinRequest,
  SignalingJoined,
  SignalingSocket,
  SignalingSocketHandlers,
  SignalingState,
  SignalingStateChange,
} from './contract.js';
