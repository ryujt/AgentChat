// P2P 세션 (protocol.md 4절, 5.4, 5.5. architecture.md 3.10).
// 링크마다 hello 검사, 스냅샷 교환(시작과 답하기), sync_end 의 경과 시간 전달, bye, 버전 불일치,
// 지문 비교와 재동기화, 진전 판정과 간격 조정, 중단을 병합했을 때의 즉시 교환을 맡는다.
// 병합과 경과 시간의 계산은 shared-state 가 한다. 여기서는 받은 값을 그대로 넘긴다.
// chat 과 ack 는 내용을 보지 않고 부르는 쪽에 넘긴다. 누구에게 접촉할지는 모른다.
// 관전자 링크(hello.observer: true)의 chat 과 변경은 받지 않는다. 스냅샷은 그 관전자가 쓴 기록만 빼고 받는다(protocol.md 4.6).

import type { LogPort } from '../diagnostics/log-port.js';
import type { Mesh } from '../mesh/contract.js';
import { LIMITS, encodeP2PFrame, packStateFrames, parseP2PFrame, utf8ByteLength } from '../protocol/index.js';
import type {
  ByeReason,
  ChatFrame,
  HelloFrame,
  Now,
  P2PFrame,
  StateFrame,
  StateRecord,
  SyncEndFrame,
  TimerHandle,
  Timers,
} from '../protocol/index.js';
import type { ApplyLocalResult, Replica, StateCommand } from '../shared-state/contract.js';
import type { AppInfo } from './contract.js';
import type { EventSink } from './events.js';

/** room-session 이 판정하는 session 단계의 실패 가운데 링크를 닫으며 정해지는 것. */
export type SessionFailureReason = 'hello_timeout' | 'hello_mismatch' | 'version';

/** 링크를 닫을 때 mesh 에 주는 사유. mesh 가 스스로 쓰는 네 값과 겹치지 않는다. */
export type SessionCloseReason =
  | 'bye_leave'
  | 'bye_shutdown'
  | 'bye_version'
  | 'bye_protocol_error'
  | 'version'
  | 'hello_mismatch'
  | 'hello_timeout'
  | 'protocol_error';

/** 스냅샷을 보낸 계기. 로그 state.resync 의 cause 다. */
type ExchangeCause = 'link_open' | 'ping_mismatch' | 'reply' | 'stop';

/** 링크에서 일어난 일을 입장·보정 쪽에 알린다. 링크를 닫는 경우에는 닫기 전에 부른다. */
export interface P2PHooks {
  /** 상대의 sync_end 를 처음 받았다. 그 링크는 동기화됐다. */
  synced(peer: string): void;
  /** 상대의 hello 를 받아들였다. observer 는 그 hello 의 관전자 표시다(필드가 없으면 null = 관전자를 모르는 구버전). */
  greeted(peer: string, sid: string, observer: boolean | null): void;
  failed(peer: string, reason: SessionFailureReason, theirVersion: number | null): void;
  bye(peer: string, sid: string, reason: Exclude<ByeReason, 'version'>): void;
  /** observer 가 참이면 관전자 링크에서 온 글이다(사람이 관전 콘솔에서 쓴 글). */
  chat(peer: string, frame: ChatFrame, observer: boolean): void;
  /** read 가 참이면 읽음 확인이다(ack{read: true}). */
  ack(peer: string, id: string, read: boolean): void;
}

export interface P2PSessionDeps {
  /** observer 는 내 hello 에 싣는 관전자 표시다(관전 모드면 참). */
  readonly self: { readonly peer: string; readonly sid: string; readonly observer: boolean };
  readonly app: AppInfo;
  readonly mesh: Pick<Mesh, 'send' | 'closeLink' | 'markAlive'>;
  readonly replica: Replica;
  readonly events: EventSink;
  readonly hooks: P2PHooks;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
}

export interface LinkView {
  readonly peer: string;
  readonly sid: string;
  readonly openedAt: number;
  readonly helloReceived: boolean;
  readonly synced: boolean;
  /** 스냅샷을 주고받아도 맞춰지지 않는 차이가 있다(진전 없음). */
  readonly diverged: boolean;
  /** hello.wall 로 본 시계 차이가 CLOCK_SKEW_WARN_MS 를 넘는다. */
  readonly clockSkew: boolean;
  /** 상대 hello 의 관전자 표시. hello 전이거나 필드가 없으면(구버전) null. */
  readonly observer: boolean | null;
}

export interface LocalWrite {
  readonly result: ApplyLocalResult;
  /** 만든 기록을 변경으로 보낸 링크의 피어. */
  readonly sentTo: readonly string[];
}

export interface P2PSession {
  linkOpened(link: { readonly peer: string; readonly sid: string; readonly cid: string }): void;
  /** 닫힌 링크의 마지막 상태. 모르는 링크면 null. */
  linkClosed(peer: string): LinkView | null;
  frame(peer: string, text: string): void;
  /** 상대의 ping 에 실린 기록 수와 지문. */
  ping(peer: string, sc: number, sf: string): void;
  /** 복제본에 로컬 명령을 넣고, 만든 기록을 열린 링크 전부에 변경으로 보낸다. */
  applyLocal(command: StateCommand): LocalWrite;
  /** read 가 참이면 읽음 확인(ack{read: true})을 보낸다. */
  ack(peer: string, id: string, read?: boolean): void;
  /** 채팅 쪽이 버린 프레임을 잘못된 프레임으로 센다. */
  countBadFrame(peer: string, code: string): void;
  byeAll(reason: 'leave' | 'shutdown'): void;
  link(peer: string): LinkView | null;
  links(): readonly LinkView[];
  /** 타이머를 지우고 링크 상태를 버린다. */
  close(): void;
}

interface LinkState {
  readonly peer: string;
  readonly sid: string;
  readonly openedAt: number;
  helloReceived: boolean;
  synced: boolean;
  helloTimer: TimerHandle | null;
  /** 내가 시작한 교환의 답(상대의 sync_end)을 기다리는 중인가. RESYNC_MIN_GAP_MS 가 지나면 끝난 것으로 본다. */
  waiting: boolean;
  waitStartedAt: number;
  /** 기다리기 시작한 뒤로 다른 곳(로컬 쓰기, 다른 링크의 병합)에서 기록이 들어왔는가. */
  foreignSinceWait: boolean;
  /** 연속으로 지문이 다른 ping 수. */
  mismatches: number;
  /** 이 링크에서 마지막으로 스냅샷을 보낸 때(시작이든 답이든). */
  lastSnapshotAt: number;
  gapMs: number;
  diverged: boolean;
  clockSkew: boolean;
  observer: boolean | null;
  badFrames: number[];
}

function viewOf(link: LinkState): LinkView {
  return {
    peer: link.peer,
    sid: link.sid,
    openedAt: link.openedAt,
    helloReceived: link.helloReceived,
    synced: link.synced,
    diverged: link.diverged,
    clockSkew: link.clockSkew,
    observer: link.observer,
  };
}

export function createP2PSession(deps: P2PSessionDeps): P2PSession {
  const { mesh, replica, events, hooks, log } = deps;
  const links = new Map<string, LinkState>();
  /** 시계 차이 사건은 참가자마다 한 번만 낸다. 링크가 다시 열려도 되풀이하지 않는다. */
  const skewNotified = new Set<string>();

  const sendFrame = (peer: string, frame: P2PFrame): boolean => {
    const text = encodeP2PFrame(frame);
    if (!text.ok) {
      // 받는 쪽이 거절할 프레임이다. 보내지 않는다. 이 모듈의 결함이다.
      log.event('error', 'room-session', 'p2p.encode_failed', { peer, kind: frame.t, error_code: text.code });
      return false;
    }
    return mesh.send(peer, text.value) === 'ok';
  };

  const isWaiting = (link: LinkState, now: number): boolean =>
    link.waiting && now - link.waitStartedAt < LIMITS.RESYNC_MIN_GAP_MS;

  const close = (link: LinkState, reason: SessionCloseReason): void => {
    if (link.helloTimer !== null) deps.timers.clearTimeout(link.helloTimer);
    link.helloTimer = null;
    mesh.closeLink(link.peer, reason);
  };

  /** 가진 모든 기록을 보내고 sync_end 로 끝낸다. 답이면 그 스냅샷의 지문을 싣는다. */
  const sendSnapshot = (link: LinkState, cause: ExchangeCause): void => {
    const now = deps.now();
    link.lastSnapshotAt = now;
    const records = replica.snapshot();
    const frames = packStateFrames(records, { snap: true });
    if (!frames.ok) {
      // 복제본에 받는 쪽이 버릴 기록이 있다. 일부만 보내면 지문이 계속 어긋난다. 보내지 않고 남긴다.
      log.event('error', 'room-session', 'state.resync', { peer: link.peer, cause, outcome: 'failed', error_code: frames.code });
      return;
    }
    let bytes = 0;
    for (const text of frames.value) {
      if (mesh.send(link.peer, text) !== 'ok') return;
      bytes += utf8ByteLength(text);
    }
    const end: SyncEndFrame = { v: LIMITS.P2P_VERSION, t: 'sync_end', count: records.length };
    // 경과 시간은 shared-state 가 잰 값을 보내는 순간 그대로 싣는다. 여기서 더하거나 견주지 않는다.
    const elapsed = replica.testElapsed(now);
    const test = elapsed === null ? null : replica.view(now).test;
    if (elapsed !== null && test !== null) {
      end.test_id = test.test_id;
      end.test_elapsed_ms = Math.max(0, Math.trunc(elapsed));
    }
    if (cause === 'reply') end.sf = replica.fingerprint();
    sendFrame(link.peer, end);
    log.event('info', 'room-session', 'state.resync', {
      peer: link.peer,
      cause,
      gap_ms: link.gapMs,
      records: records.length,
      bytes,
    });
  };

  /** 교환을 시작한다. 이미 기다리는 중이면 다시 보내기만 하고 기다림을 새로 시작하지 않는다. */
  const startExchange = (link: LinkState, cause: Exclude<ExchangeCause, 'reply'>): void => {
    const now = deps.now();
    const alreadyWaiting = isWaiting(link, now);
    sendSnapshot(link, cause);
    if (!links.has(link.peer) || alreadyWaiting) return;
    link.waiting = true;
    link.waitStartedAt = now;
    link.foreignSinceWait = false;
  };

  const countBad = (link: LinkState, code: string): void => {
    const now = deps.now();
    link.badFrames = link.badFrames.filter((at) => now - at < LIMITS.BAD_FRAME_WINDOW_MS);
    link.badFrames.push(now);
    log.event('debug', 'room-session', 'p2p.bad_frame', { peer: link.peer, error_code: code });
    if (link.badFrames.length <= LIMITS.BAD_FRAME_MAX) return;
    log.event('warn', 'room-session', 'p2p.protocol_error', { peer: link.peer, error_code: code });
    sendFrame(link.peer, { v: LIMITS.P2P_VERSION, t: 'bye', reason: 'protocol_error' });
    close(link, 'protocol_error');
  };

  const onHello = (link: LinkState, frame: HelloFrame): void => {
    if (link.helloReceived) return;
    // 발신자는 링크로 정한다. 본문의 이름과 sid 는 그 시도의 시그널에 서버가 붙인 값과 대조만 한다.
    if (frame.peer !== link.peer || frame.sid !== link.sid) {
      sendFrame(link.peer, { v: LIMITS.P2P_VERSION, t: 'bye', reason: 'protocol_error' });
      hooks.failed(link.peer, 'hello_mismatch', null);
      close(link, 'hello_mismatch');
      return;
    }
    link.helloReceived = true;
    if (link.helloTimer !== null) deps.timers.clearTimeout(link.helloTimer);
    link.helloTimer = null;
    if (Math.abs(frame.wall - deps.now()) > LIMITS.CLOCK_SKEW_WARN_MS) {
      link.clockSkew = true;
      if (!skewNotified.has(link.peer)) {
        skewNotified.add(link.peer);
        events.system('clock_skew', `The clock of ${link.peer} differs from yours by more than 60 seconds. Displayed times of records may be off.`, {
          peer: link.peer,
        });
      }
    }
    link.observer = frame.observer ?? null;
    hooks.greeted(link.peer, link.sid, link.observer);
  };

  const onState = (link: LinkState, frame: StateFrame, invalidRecords: number): void => {
    const now = deps.now();
    mesh.markAlive(link.peer);
    const snapshot = frame.snap === true;
    let records = frame.records;
    let skipped = 0;
    if (link.observer === true) {
      // 관전자는 공유 상태에 기록을 쓰지 않는다. 변경은 통째로 버리고, 스냅샷에서는 그 관전자가 쓴 기록만 뺀다.
      if (!snapshot) {
        countBad(link, 'observer_write');
        return;
      }
      records = frame.records.filter((record) => record.author !== link.peer);
      skipped = frame.records.length - records.length;
    }
    const merged = replica.mergeRemote(records, { from: link.peer, snapshot }, now);
    log.event('info', 'room-session', 'state.merge', {
      peer: link.peer,
      applied: merged.applied.length,
      ignored: merged.ignored + invalidRecords + skipped,
      anomalies: merged.anomalies,
      snapshot,
    });
    if (merged.overflow) {
      // 규칙을 따르는 참가자끼리는 닿지 않는 수다. 프로토콜 위반으로 보고 그 링크를 닫는다.
      sendFrame(link.peer, { v: LIMITS.P2P_VERSION, t: 'bye', reason: 'protocol_error' });
      close(link, 'protocol_error');
      return;
    }
    if (merged.applied.length > 0) {
      // 같은 링크에서 온 기록은 상대의 답 스냅샷에도 들어 있다. 다른 링크에게만 "다른 곳에서 들어온 기록"이다.
      for (const other of links.values()) {
        if (other !== link && isWaiting(other, now)) other.foreignSinceWait = true;
      }
      events.stateRecorded(merged.applied, 'remote', link.peer);
    }
    events.stateChanged(merged.changes, 'remote');
    if (merged.changes.some((change) => change.type === 'test_stopped')) {
      // 중단은 간격을 기다리지 않는다. 받은 링크를 뺀 열린 모든 링크에서 바로 교환을 시작한다.
      for (const other of [...links.values()]) {
        if (other !== link && links.get(other.peer) === other) startExchange(other, 'stop');
      }
    }
  };

  const onSyncEnd = (link: LinkState, frame: SyncEndFrame): void => {
    const now = deps.now();
    mesh.markAlive(link.peer);
    if (frame.test_id !== undefined && frame.test_elapsed_ms !== undefined) {
      // 첫 동기화, 재동기화, 시작, 답을 가리지 않고 매번 그대로 넘긴다. 견주는 일은 shared-state 만 한다.
      if (replica.adoptElapsed(frame.test_id, frame.test_elapsed_ms, now)) events.elapsedAdopted();
    }
    const wasWaiting = isWaiting(link, now);
    if (frame.sf !== undefined) {
      // 답이다. 답에는 어느 경우에도 답하지 않는다. 진전 판정은 이 한 순간에만 한다.
      link.waiting = false;
      let outcome: 'same' | 'no_progress' | 'undecided';
      if (replica.fingerprint() === frame.sf) {
        outcome = 'same';
        link.gapMs = LIMITS.RESYNC_MIN_GAP_MS;
        link.diverged = false;
      } else if (wasWaiting && !link.foreignSinceWait) {
        outcome = 'no_progress';
        link.gapMs = Math.min(link.gapMs * 2, LIMITS.RESYNC_MAX_GAP_MS);
        log.event('warn', 'room-session', 'state.diverged', { peer: link.peer, outcome, gap_ms: link.gapMs });
        if (!link.diverged) {
          link.diverged = true;
          events.system(
            'state_diverged',
            `Shared state with ${link.peer} still differs after exchanging snapshots. Records that can be received keep arriving.`,
            { peer: link.peer },
          );
        }
      } else {
        outcome = 'undecided';
      }
      if (outcome !== 'no_progress') {
        log.event('debug', 'room-session', 'state.resync', { peer: link.peer, outcome, gap_ms: link.gapMs });
      }
    } else if (wasWaiting) {
      // 양쪽이 동시에 시작한 교환이다. 답하지 않고 판정하지 않는다.
      link.waiting = false;
    } else {
      sendSnapshot(link, 'reply');
    }
    if (links.get(link.peer) === link && !link.synced) {
      link.synced = true;
      hooks.synced(link.peer);
    }
  };

  const onBye = (link: LinkState, reason: ByeReason): void => {
    if (reason === 'version') {
      hooks.failed(link.peer, 'version', null);
      close(link, 'bye_version');
      return;
    }
    hooks.bye(link.peer, link.sid, reason);
    close(link, `bye_${reason}`);
  };

  const broadcast = (records: readonly StateRecord[]): string[] => {
    const frames = packStateFrames(records, { snap: false });
    if (!frames.ok) {
      // 받는 쪽이 버릴 기록이다. 보내지 않는다. shared-state 가 만든 기록이 스키마를 어긴 결함이다.
      log.event('error', 'room-session', 'state.send_failed', { error_code: frames.code, records: records.length });
      return [];
    }
    const sent: string[] = [];
    for (const link of [...links.values()]) {
      if (frames.value.every((text) => mesh.send(link.peer, text) === 'ok')) sent.push(link.peer);
    }
    return sent;
  };

  return {
    linkOpened(opened) {
      const now = deps.now();
      const link: LinkState = {
        peer: opened.peer,
        sid: opened.sid,
        openedAt: now,
        helloReceived: false,
        synced: false,
        helloTimer: null,
        waiting: false,
        waitStartedAt: now,
        foreignSinceWait: false,
        mismatches: 0,
        lastSnapshotAt: now,
        gapMs: LIMITS.RESYNC_MIN_GAP_MS,
        diverged: false,
        clockSkew: false,
        observer: null,
        badFrames: [],
      };
      links.set(link.peer, link);
      sendFrame(link.peer, {
        v: LIMITS.P2P_VERSION,
        t: 'hello',
        peer: deps.self.peer,
        sid: deps.self.sid,
        wall: Math.max(0, Math.trunc(now)),
        client: { name: deps.app.name, version: deps.app.version },
        // 새 구현은 늘 싣는다. 없으면 상대는 관전자를 모르는 구버전으로 본다(protocol.md 4.6).
        observer: deps.self.observer,
      });
      // 받은 프레임을 처리하기 전에 보낸다. 그래서 첫 동기화는 양쪽이 동시에 시작한 교환이 된다.
      startExchange(link, 'link_open');
      if (links.get(link.peer) !== link) return;
      link.helloTimer = deps.timers.setTimeout(() => {
        link.helloTimer = null;
        if (links.get(link.peer) !== link || link.helloReceived) return;
        hooks.failed(link.peer, 'hello_timeout', null);
        close(link, 'hello_timeout');
      }, LIMITS.HELLO_TIMEOUT_MS);
    },

    linkClosed(peer) {
      const link = links.get(peer);
      if (link === undefined) return null;
      if (link.helloTimer !== null) deps.timers.clearTimeout(link.helloTimer);
      link.helloTimer = null;
      links.delete(peer);
      return viewOf(link);
    },

    frame(peer, text) {
      const link = links.get(peer);
      if (link === undefined) return;
      // 자기 이름으로 온 프레임은 처리하지 않는다. 되돌아오는 경로는 없지만 이름이 같은 발신자를 믿지 않는다.
      if (peer === deps.self.peer) return;
      const parsed = parseP2PFrame(text);
      if (!parsed.ok) {
        if (parsed.code !== 'VERSION_MISMATCH') {
          countBad(link, parsed.code);
          return;
        }
        // bye 는 내 버전으로 보낸다. 상대는 그것을 버전 불일치로 읽는다.
        sendFrame(peer, { v: LIMITS.P2P_VERSION, t: 'bye', reason: 'version' });
        hooks.failed(peer, 'version', parsed.theirVersion ?? null);
        close(link, 'version');
        return;
      }
      const frame = parsed.value;
      switch (frame.t) {
        case 'bye':
          onBye(link, frame.reason);
          return;
        case 'hello':
          onHello(link, frame);
          return;
        case 'ping':
        case 'pong':
          // 생존 확인은 mesh 가 한다. 여기까지 온 것은 버린다.
          return;
        default:
          break;
      }
      if (!link.helloReceived) {
        // 신원을 확인하기 전의 프레임은 받지 않는다. 채널이 순서를 지키므로 정상 상대에게서는 오지 않는다.
        countBad(link, 'BEFORE_HELLO');
        return;
      }
      switch (frame.t) {
        case 'state':
          onState(link, frame, parsed.invalidRecords);
          return;
        case 'sync_end':
          onSyncEnd(link, frame);
          return;
        case 'chat':
          // 관전자도 사람이 콘솔에서 쓴 글(지시)을 보낼 수 있다(2026-11-16). 받는 쪽이 관전자의 글로 표시한다.
          hooks.chat(peer, frame, link.observer === true);
          return;
        case 'ack':
          hooks.ack(peer, frame.id, frame.read === true);
          return;
      }
    },

    ping(peer, sc, sf) {
      const link = links.get(peer);
      if (link === undefined) return;
      const now = deps.now();
      if (sc === replica.snapshot().length && sf === replica.fingerprint()) {
        // 한 번이라도 같으면 간격을 기본값으로 되돌리고 경고를 거둔다.
        link.mismatches = 0;
        link.gapMs = LIMITS.RESYNC_MIN_GAP_MS;
        link.diverged = false;
        return;
      }
      link.mismatches += 1;
      // 가는 중인 변경 때문에 잠깐 다른 것을 거른다.
      if (link.mismatches < LIMITS.STATE_DIVERGE_PINGS) return;
      // 간격은 내가 이 링크에서 마지막으로 스냅샷을 보낸 때부터 잰다. 재동기화는 멈추지 않고 간격만 바뀐다.
      if (now - link.lastSnapshotAt < link.gapMs) return;
      startExchange(link, 'ping_mismatch');
    },

    applyLocal(command) {
      const now = deps.now();
      const result = replica.applyLocal(command, now);
      if (!result.ok) return { result, sentTo: [] };
      let sentTo: string[] = [];
      if (result.records.length > 0) {
        for (const link of links.values()) {
          if (isWaiting(link, now)) link.foreignSinceWait = true;
        }
        events.stateRecorded(result.records, 'local', null);
        // 보낸 뒤에 변화를 알린다. 기한이 이미 찬 테스트면 그 알림 안에서 stop 이 이어서 나간다.
        sentTo = broadcast(result.records);
      }
      events.stateChanged(result.changes, 'local');
      return { result, sentTo };
    },

    ack(peer, id, read = false) {
      if (links.has(peer)) sendFrame(peer, read ? { v: LIMITS.P2P_VERSION, t: 'ack', id, read: true } : { v: LIMITS.P2P_VERSION, t: 'ack', id });
    },

    countBadFrame(peer, code) {
      const link = links.get(peer);
      if (link !== undefined) countBad(link, code);
    },

    byeAll(reason) {
      for (const link of [...links.values()]) sendFrame(link.peer, { v: LIMITS.P2P_VERSION, t: 'bye', reason });
    },

    link(peer) {
      const link = links.get(peer);
      return link === undefined ? null : viewOf(link);
    },
    links: () => [...links.values()].map(viewOf),

    close() {
      for (const link of links.values()) {
        if (link.helloTimer !== null) deps.timers.clearTimeout(link.helloTimer);
        link.helloTimer = null;
      }
      links.clear();
    },
  };
}
