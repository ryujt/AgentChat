// mesh 의 공개 진입점. 다른 모듈은 이 파일과 contract.ts 만 import 한다.

import type { CreateMesh } from './contract.js';
import { createMeshWith } from './mesh.js';
import { loadNative } from './native.js';

/** 네이티브 모듈은 이 함수가 불릴 때 처음 불러온다. 불러오지 못하면 NATIVE_LOAD_FAILED 로 돌려준다. */
export const createMesh: CreateMesh = (deps) => createMeshWith(deps, loadNative);

export type {
  AttemptDiag,
  AttemptFailed,
  AttemptFailure,
  CandidateCounts,
  CreateMesh,
  CreateMeshResult,
  LinkClosed,
  LinkOpen,
  Mesh,
  MeshCloseReason,
  MeshDeps,
  MeshEvents,
  MeshLink,
  MeshNetInfo,
  MeshSelf,
  MeshSendResult,
  PeerFrame,
  PeerPing,
  PingInfo,
  SendSignal,
} from './contract.js';
