// mesh 보정 (protocol.md 3.1, 4.5. architecture.md 3.10 의 "입장·보정").
// 서버가 준 목록으로 누구에게 접촉할지 고르고, 연속 실패를 세고, 목록의 sid 불일치를 교체 확인에 넘긴다.
// 연결 방법은 mesh 가 정한다. 여기서는 contact 와 probe 를 부를 뿐이다. 시그널 전송 함수를 다루지 않는다.

import type { AttemptFailed, Mesh } from '../mesh/contract.js';
import { LIMITS } from '../protocol/index.js';
import type { Member, Now, TimerHandle, Timers } from '../protocol/index.js';
import type { PeerFacts } from './views.js';

export interface MeshKeeperDeps {
  readonly self: string;
  readonly mesh: Pick<Mesh, 'contact' | 'probe' | 'links'>;
  /** 그 피어의 지금 링크가 열린 때. 링크가 없으면 null. */
  readonly linkOpenedAt: (peer: string) => number | null;
  readonly now: Now;
  readonly timers: Timers;
}

export interface MeshKeeper {
  /** 서버가 가장 최근에 준 목록과 그것을 요청한 시각. */
  setMembers(members: readonly Member[], requestedAt: number): void;
  /** 가장 최근 목록의 이름(자신 제외). */
  members(): readonly string[];
  /** 목록에 있고, 열린 링크가 없고, 진행 중인 시도가 없는 피어에게 접촉한다. sid 가 다른 열린 링크는 교체 확인에 넘긴다. */
  reconcile(): void;
  /** 접촉을 멈춘다. 입장이 실패로 정해진 뒤다. */
  pause(): void;

  linkOpened(peer: string): void;
  /** 그 링크가 동기화됐다. 끊겼다가 다시 붙은 것이면 reconnected 가 참이다. */
  linkSynced(peer: string): { readonly reconnected: boolean };
  /** 닫힌 사유에 따라 다시 접촉할 때를 정한다. quickRetry 가 거짓이면 다음 목록 갱신 때 한다. */
  linkClosed(peer: string, wasSynced: boolean, quickRetry: boolean): void;
  /** 그 피어가 bye{leave|shutdown} 을 보냈다. 그 sid 와는 다시 시도하지 않는다. */
  peerLeft(peer: string, sid: string): void;
  /** P2P 버전이 달랐다. 그 sid 와는 다시 시도하지 않는다. 처음 알았으면 참을 돌려준다. */
  versionMismatch(peer: string, sid: string): boolean;
  /**
   * 실패한 시도를 센다. peer_gone 은 세지 않는다(상대가 떠난 것이다).
   * 연속 UNREACHABLE_AFTER_FAILS 회에 닿은 순간 한 번, 알릴 사유를 돌려준다.
   */
  attemptFailed(failure: AttemptFailed): { readonly unreachable: 'no_response' | 'no_route' | null };

  /** 참가자 표시에 쓰는 연결 쪽 사실. attempting 은 그 피어와 링크나 진행 중인 시도가 지금 있는가다. */
  facts(peer: string, attempting: boolean): Omit<PeerFacts, 'link'>;
  /** 타이머를 지운다. */
  stop(): void;
}

interface PeerState {
  failStreak: number;
  unreachableNotified: boolean;
  /** P2P 버전이 달랐던 상대의 sid. */
  versionSid: string | null;
  /** bye{leave|shutdown} 을 보낸 상대의 sid. */
  goneSid: string | null;
  /** 마지막 링크가 bye{leave|shutdown} 으로 닫혔고 그 뒤 새 시도가 없다. */
  leftByBye: boolean;
  everLinked: boolean;
  /** 동기화된 링크가 bye 없이 닫혔다. 다시 동기화되면 "다시 연결됨"이다. */
  lost: boolean;
  retry: TimerHandle | null;
}

export function createMeshKeeper(deps: MeshKeeperDeps): MeshKeeper {
  const { mesh } = deps;
  let listed = new Map<string, string>();
  let requestedAt = 0;
  let paused = false;
  const peers = new Map<string, PeerState>();

  const stateOf = (peer: string): PeerState => {
    let state = peers.get(peer);
    if (state === undefined) {
      state = {
        failStreak: 0,
        unreachableNotified: false,
        versionSid: null,
        goneSid: null,
        leftByBye: false,
        everLinked: false,
        lost: false,
        retry: null,
      };
      peers.set(peer, state);
    }
    return state;
  };

  const cancelRetry = (state: PeerState): void => {
    if (state.retry !== null) deps.timers.clearTimeout(state.retry);
    state.retry = null;
  };

  /** 목록에 있는 그 피어에게 접촉한다. 그 sid 와 다시 시도하지 않기로 한 경우는 건너뛴다. */
  const contact = (peer: string, sid: string, linked: ReadonlyMap<string, { sid: string | null; state: string }>): void => {
    if (peer === deps.self) return;
    const state = stateOf(peer);
    if (state.versionSid === sid || state.goneSid === sid) return;
    const link = linked.get(peer);
    if (link !== undefined) {
      if (link.state !== 'open' || link.sid === sid) return;
      // 목록의 sid 가 다르다. 그 목록을 요청하기 전에 열린 링크만 상대가 다시 시작했을 수 있다.
      // 바로 닫지 않고 교체 확인에 넘긴다. 확인에 실패했을 때만 mesh 가 닫는다.
      const openedAt = deps.linkOpenedAt(peer);
      if (openedAt !== null && openedAt < requestedAt) mesh.probe(peer);
      return;
    }
    state.leftByBye = false;
    mesh.contact(peer);
  };

  const linkedNow = (): Map<string, { sid: string | null; state: string }> =>
    new Map(mesh.links().map((link) => [link.peer, { sid: link.sid, state: link.state }]));

  /** 링크가 닫히거나 시도가 실패한 직후 한 번 다시 접촉한다. 그 뒤로는 목록 갱신(pong) 주기다. */
  const retrySoon = (peer: string): void => {
    const state = stateOf(peer);
    cancelRetry(state);
    if (paused) return;
    state.retry = deps.timers.setTimeout(() => {
      state.retry = null;
      if (paused) return;
      const sid = listed.get(peer);
      if (sid !== undefined) contact(peer, sid, linkedNow());
    }, LIMITS.RECONTACT_DELAY_MS);
  };

  return {
    setMembers(members, at) {
      listed = new Map(members.filter((member) => member.peer !== deps.self).map((member) => [member.peer, member.sid]));
      requestedAt = at;
    },
    members: () => [...listed.keys()],
    reconcile() {
      if (paused) return;
      const linked = linkedNow();
      for (const [peer, sid] of listed) contact(peer, sid, linked);
    },
    pause() {
      paused = true;
      for (const state of peers.values()) cancelRetry(state);
    },

    linkOpened(peer) {
      const state = stateOf(peer);
      cancelRetry(state);
      state.failStreak = 0;
      state.unreachableNotified = false;
      state.leftByBye = false;
    },
    linkSynced(peer) {
      const state = stateOf(peer);
      const reconnected = state.lost;
      state.lost = false;
      state.everLinked = true;
      return { reconnected };
    },
    linkClosed(peer, wasSynced, quickRetry) {
      const state = stateOf(peer);
      if (wasSynced && !state.leftByBye) state.lost = true;
      if (quickRetry) retrySoon(peer);
    },
    peerLeft(peer, sid) {
      const state = stateOf(peer);
      state.goneSid = sid;
      state.leftByBye = true;
      state.lost = false;
      cancelRetry(state);
    },
    versionMismatch(peer, sid) {
      const state = stateOf(peer);
      const first = state.versionSid !== sid;
      state.versionSid = sid;
      cancelRetry(state);
      return first;
    },
    attemptFailed(failure) {
      const state = stateOf(failure.peer);
      // 실패했다는 것은 그 사이 새 시도가 있었다는 뜻이다.
      state.leftByBye = false;
      if (failure.stage === 'signaling' && failure.reason === 'peer_gone') {
        // 서버에 그 피어가 없다. 다음 목록을 받을 때까지 대상에서 뺀다.
        listed.delete(failure.peer);
        cancelRetry(state);
        return { unreachable: null };
      }
      state.failStreak += 1;
      // 첫 실패 뒤에만 바로 다시 한다. 그 뒤의 재시도는 목록 갱신 주기를 따른다.
      if (state.failStreak === 1) retrySoon(failure.peer);
      if (state.failStreak < LIMITS.UNREACHABLE_AFTER_FAILS || state.unreachableNotified) return { unreachable: null };
      state.unreachableNotified = true;
      return { unreachable: failure.stage === 'signaling' ? 'no_response' : 'no_route' };
    },

    facts(peer, attempting) {
      const state = peers.get(peer);
      const sid = listed.get(peer);
      return {
        inServerList: sid !== undefined,
        failedRepeatedly: (state?.failStreak ?? 0) >= LIMITS.UNREACHABLE_AFTER_FAILS,
        // 상대가 새 sid 로 다시 들어오면 다시 시도한다. 그때는 버전이 다르다고 보지 않는다.
        versionMismatch: state !== undefined && state.versionSid !== null && state.versionSid === sid,
        leftByBye: state !== undefined && state.leftByBye && !attempting,
        everLinked: state?.everLinked ?? false,
      };
    },
    stop() {
      for (const state of peers.values()) cancelRetry(state);
    },
  };
}
