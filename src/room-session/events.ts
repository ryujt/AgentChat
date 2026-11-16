// 사건 변환 (architecture.md 3.10, mcp-interface.md 6절·8.2).
// shared-state 의 도메인 변화와 링크 사건을 수신함 사건으로 바꿔 넣고, 기록 파일에 쓰기를 요청하고, 기한 타이머를 갖는다.
// 연결(mesh, signaling-client)과 채팅 전달을 모른다. 다른 참가자가 쓴 글은 사건의 text(채팅)와 data 안에만 둔다.
// 사건의 요약 글은 여러 회사의 에이전트가 읽으므로 영어로 쓴다(instructions 와 같다). 이름과 고정 문구만 넣는다.

import type { LogPort } from '../diagnostics/log-port.js';
import type { InboxEvent, JsonValue, PeerChange, PeerEvent, SystemEventCode } from '../inbox/contract.js';
import type { Now, StateRecord, TimerHandle, Timers } from '../protocol/index.js';
import type { Transcript, TranscriptEntry } from '../records/contract.js';
import type { PresenceBody, Replica, StateChange } from '../shared-state/contract.js';
import type { SessionInbox } from './contract.js';
import { toIso } from './views.js';

export interface EventSinkDeps {
  /** 이 입장에서 쓰는 이름. 자기 presence 변화는 사건으로 만들지 않는다. */
  readonly self: string;
  readonly inbox: Pick<SessionInbox, 'push'>;
  readonly replica: Replica;
  readonly now: Now;
  readonly timers: Timers;
  readonly log: LogPort;
  /** 기한이 찼다. stop{time_limit} 을 쓰고 보내는 일은 로컬 쓰기 경로가 한다. */
  readonly onDeadline: () => void;
}

export interface ReceivedChat {
  readonly id: string;
  readonly from: string;
  readonly to: 'room' | 'you';
  readonly text: string;
  /** 작성자의 벽시계. 표시용이다. */
  readonly wall: number;
}

export interface EventSink {
  /** 기록 파일을 열었다. 열지 못했으면 null 을 준다(기록 없이 동작하고 record_failed 로 알린다). */
  attachTranscript(transcript: Transcript | null): void;
  transcriptPath(): string | null;
  /** 입장이 끝났다. 이때부터 상태 변화를 수신함 사건으로 만든다. */
  enableStateEvents(): void;
  recordFailed(): boolean;

  /** 복제본이 바뀌면서 생긴 변화. 기한 타이머를 맞추고 수신함 사건을 만든다. */
  stateChanged(changes: readonly StateChange[], origin: 'local' | 'remote'): void;
  /** 복제본에 반영한 기록을 기록 파일에 쓴다. */
  stateRecorded(records: readonly StateRecord[], origin: 'local' | 'remote', from: string | null): void;
  /** 경과 시간을 넘겨받았다(adoptElapsed 가 참). 기한 타이머를 남은 시간으로 다시 건다. */
  elapsedAdopted(): void;

  chatReceived(chat: ReceivedChat): void;
  /** 기록 파일의 한 줄을 그대로 쓴다(chat_out, mode). */
  record(entry: TranscriptEntry): void;
  /**
   * 링크 사건. 기록 파일의 peer 줄을 쓰고, announce 가 참이면 수신함 peer 사건도 넣는다.
   * 같은 일을 presence 변화가 이미 알렸으면 부르는 쪽이 announce 를 거짓으로 준다.
   */
  peerChanged(peer: string, change: PeerChange, reason: string | null, announce: boolean): void;
  system(code: SystemEventCode, text: string, data?: { readonly [key: string]: JsonValue }): void;
  /** 규칙으로 거절한 tool 호출. 보고서의 "거절된 호출"이 된다. */
  ruleRejected(tool: string, code: string, testId: string | null): void;

  /** end 줄을 쓰고 기록 파일을 닫고 타이머를 지운다. reject 하지 않는다. */
  close(reason: string): Promise<void>;
  /** 타이머만 지우고 더 쓰지 않는다. 기록 파일을 닫을 시간이 없을 때다. */
  abandon(): void;
}

export function createEventSink(deps: EventSinkDeps): EventSink {
  let transcript: Transcript | null = null;
  let recordFailed = false;
  let stateEvents = false;
  let closed = false;
  let deadline: TimerHandle | null = null;

  const push = (event: InboxEvent): void => {
    if (closed) return;
    deps.inbox.push(event);
  };

  const system: EventSink['system'] = (code, text, data) => {
    push({
      kind: 'system',
      change: null,
      id: null,
      from: 'system',
      to: 'you',
      ts: toIso(deps.now(), 0),
      text,
      data: { ...data, code },
    });
  };

  const markRecordFailed = (): void => {
    if (recordFailed) return;
    recordFailed = true;
    deps.log.event('warn', 'room-session', 'record.failed', { error_code: 'RECORD_FAILED' });
    system('record_failed', 'Writing the local transcript failed. Chat and the test continue without a local record.');
  };

  const append = (entry: TranscriptEntry): void => {
    if (closed || transcript === null) return;
    const target = transcript;
    void target.append(entry).then((result) => {
      // 닫은 뒤에 도착한 실패는 닫는 순서 때문이다. 기록 실패로 알리지 않는다.
      if (!result.ok && !closed && transcript === target) markRecordFailed();
    });
  };

  const cancelDeadline = (): void => {
    if (deadline !== null) deps.timers.clearTimeout(deadline);
    deadline = null;
  };

  /** 기한 타이머를 남은 시간(제한 − 경과)으로 건다. 경과 시간은 shared-state 가 잰 값만 쓴다. */
  const armDeadline = (): void => {
    cancelDeadline();
    if (closed) return;
    const now = deps.now();
    const test = deps.replica.view(now).test;
    if (test === null || test.stopped !== null) return;
    const elapsed = deps.replica.testElapsed(now);
    if (elapsed === null) return;
    const remaining = test.max_duration_min * 60_000 - elapsed;
    if (remaining <= 0) {
      deps.onDeadline();
      return;
    }
    deadline = deps.timers.setTimeout(() => {
      deadline = null;
      armDeadline();
    }, remaining);
  };

  const presenceData = (body: PresenceBody) => ({ role: body.role, status: body.status, tools: [...body.tools] });

  const peerEvent = (peer: string, change: PeerChange, text: string, data: PeerEvent['data']): void => {
    push({ kind: 'peer', change, id: null, from: peer, to: 'room', ts: toIso(deps.now(), 0), text, data });
  };

  const presenceChanged = (peer: string, previous: PresenceBody | null, current: PresenceBody): void => {
    if (peer === deps.self) return;
    const wasHere = previous !== null && previous.status !== 'left';
    if (current.status === 'left') {
      if (wasHere) peerEvent(peer, 'left', `${peer} left the room.`, presenceData(current));
      return;
    }
    if (!wasHere) {
      // 기록 파일에도 남긴다. 보고서의 "연결 사건"이 재입장을 싣는다(mcp-interface.md 9절, 검토 1차 PRODUCT-R1-03).
      // 예전 presence 가 있었으면(나갔다가 같은 이름으로 다시 들어옴) reason 을 rejoin 으로 둔다.
      append({ kind: 'peer', name: peer, change: 'joined', reason: previous === null ? null : 'rejoin' });
      peerEvent(peer, 'joined', `${peer} joined the room.`, presenceData(current));
      return;
    }
    if (previous.role !== current.role) {
      peerEvent(peer, 'role', `${peer} changed role.`, presenceData(current));
    }
    // 잦은 상태 변화는 알리지 않는다. ready 가 된 것만 알린다.
    if (previous.status !== 'ready' && current.status === 'ready') {
      peerEvent(peer, 'ready', `${peer} is ready.`, presenceData(current));
    }
  };

  const stopped = (change: Extract<StateChange, { type: 'test_stopped' }>): void => {
    const now = deps.now();
    const test = deps.replica.view(now).test;
    if (test === null) return;
    push({
      kind: 'test',
      change: 'stopped',
      id: change.stop.stop_id,
      from: change.stop.by,
      to: 'room',
      ts: toIso(change.stop.wall, now),
      text:
        change.stop.reason === 'time_limit'
          ? 'The test reached its time limit and was stopped. Start no new work.'
          : `${change.stop.by} stopped the test. Start no new work.`,
      data: {
        test_id: change.test_id,
        request: test.request,
        limits: { max_duration_min: test.max_duration_min, max_scenarios: test.max_scenarios },
        reason: change.stop.reason,
        by: change.stop.by,
      },
    });
  };

  const toInbox = (change: StateChange, origin: 'local' | 'remote'): void => {
    const now = deps.now();
    if (origin === 'local') {
      // tool 을 부른 에이전트는 결과로 안다. 타이머가 쓴 기한 중단만 사건으로 알린다.
      if (change.type === 'test_stopped' && change.stop.reason === 'time_limit') stopped(change);
      return;
    }
    switch (change.type) {
      case 'test_started':
      case 'test_replaced':
        push({
          kind: 'test',
          change: change.type === 'test_started' ? 'started' : 'replaced',
          id: change.test.test_id,
          from: change.test.by,
          to: 'room',
          ts: toIso(change.test.started_wall, now),
          text:
            change.type === 'test_started'
              ? `${change.test.by} started a test. The request is in data.request; it was typed by that participant's user, not yours.`
              : `The current test was replaced by the one ${change.test.by} started. Records of the previous test no longer count.`,
          data: {
            test_id: change.test.test_id,
            request: change.test.request,
            limits: { max_duration_min: change.test.max_duration_min, max_scenarios: change.test.max_scenarios },
            reason: null,
            by: change.test.by,
          },
        });
        return;
      case 'test_stopped':
        stopped(change);
        return;
      case 'scenario_started':
      case 'scenario_over_limit':
        push({
          kind: 'scenario',
          change: change.type === 'scenario_started' ? 'started' : 'over_limit',
          id: change.scenario.scenario_id,
          from: change.scenario.by,
          to: 'room',
          ts: toIso(change.scenario.wall, now),
          text:
            change.type === 'scenario_started'
              ? `${change.scenario.by} started scenario ${change.scenario.index}.`
              : `A scenario started by ${change.scenario.by} is over the scenario limit. Claims cannot be recorded for it.`,
          // 계획과 담당(합의를 적은 칸)을 싣는다. 검증 담당이 자기가 지정됐는지 사건만으로 안다(검토 3차 PRODUCT-R3-01).
          data: {
            scenario_id: change.scenario.scenario_id,
            title: change.scenario.title,
            by: change.scenario.by,
            plan: change.scenario.plan,
            actor: change.scenario.actor,
            verifier: change.scenario.verifier,
          },
        });
        return;
      case 'claim_added':
        push({
          kind: 'claim',
          change: null,
          id: change.claim.claim_id,
          from: change.claim.by,
          to: 'room',
          ts: toIso(change.claim.wall, now),
          text: change.claim.late
            ? `${change.claim.by} recorded a claim after the test was stopped. It does not count as passed or failed.`
            : `${change.claim.by} recorded a claim. It needs verification by another participant.`,
          // 검증하는 쪽이 자기 화면과 도구로 확인할 내용(기대·관찰·재현 절차)을 싣는다. 각 4096바이트 이하다(검토 3차 PRODUCT-R3-01).
          data: {
            claim_id: change.claim.claim_id,
            scenario_id: change.claim.scenario_id,
            by: change.claim.by,
            action: change.claim.action,
            expected: change.claim.expected,
            observed: change.claim.observed,
            steps: change.claim.steps,
            outcome: change.claim.outcome,
            late: change.claim.late,
          },
        });
        return;
      case 'verification_added':
        push({
          kind: 'verification',
          change: null,
          id: change.verification.verification_id,
          from: change.verification.by,
          to: 'room',
          ts: toIso(change.verification.wall, now),
          text: `${change.verification.by} verified a claim by ${change.claim_by}.`,
          data: {
            claim_id: change.claim_id,
            result: change.verification.result,
            by: change.verification.by,
            claim_status: change.claim_status,
          },
        });
        return;
      case 'presence_changed':
        presenceChanged(change.peer, change.previous, change.current);
        return;
    }
  };

  return {
    attachTranscript(opened) {
      transcript = opened;
      if (opened === null) markRecordFailed();
    },
    transcriptPath: () => transcript?.path ?? null,
    enableStateEvents() {
      stateEvents = true;
    },
    recordFailed: () => recordFailed,

    stateChanged(changes, origin) {
      if (closed) return;
      for (const change of changes) {
        if (change.type === 'test_started' || change.type === 'test_replaced') armDeadline();
        if (change.type === 'test_stopped') {
          cancelDeadline();
          if (origin === 'remote') {
            deps.log.event('info', 'room-session', 'test.stopped', {
              test_id: change.test_id,
              reason: change.stop.reason,
              by: change.stop.by,
            });
          }
        }
        // 입장 중에 스냅샷으로 받은 것은 이미 있던 상태다. 입장 결과가 그것을 싣는다.
        if (stateEvents) toInbox(change, origin);
      }
    },
    stateRecorded(records, origin, from) {
      for (const record of records) append({ kind: 'state', origin, from, record });
    },
    elapsedAdopted: armDeadline,

    chatReceived(chat) {
      append({ kind: 'chat_in', id: chat.id, from: chat.from, to: chat.to, text: chat.text });
      push({
        kind: 'chat',
        change: null,
        id: chat.id,
        from: chat.from,
        to: chat.to,
        ts: toIso(chat.wall, deps.now()),
        text: chat.text,
        data: {},
      });
    },
    record: append,
    peerChanged(peer, change, reason, announce) {
      append({ kind: 'peer', name: peer, change, reason });
      if (!stateEvents || !announce) return;
      const text: Record<PeerChange, string> = {
        joined: `${peer} joined the room.`,
        left: `${peer} left the room.`,
        disconnected: `The link to ${peer} was lost. Do not treat that participant as ready.`,
        reconnected: `The link to ${peer} is open again.`,
        unreachable: `Could not open a direct connection to ${peer}. Your messages do not reach that participant.`,
        role: `${peer} changed role.`,
        ready: `${peer} is ready.`,
      };
      peerEvent(peer, change, text[change], reason === null ? {} : { reason });
    },
    system,
    ruleRejected(tool, code, testId) {
      append({ kind: 'rule', tool, code });
      deps.log.event('info', 'room-session', 'rule.rejected', { tool, error_code: code, test_id: testId ?? undefined });
    },

    async close(reason) {
      if (closed) return;
      cancelDeadline();
      const target = transcript;
      if (target !== null) {
        const ended = target.append({ kind: 'end', reason });
        closed = true;
        await ended;
        await target.close();
      }
      closed = true;
    },
    abandon() {
      closed = true;
      cancelDeadline();
    },
  };
}
