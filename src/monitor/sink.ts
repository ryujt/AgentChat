// 관전 출력 싱크 (architecture.md 3.14). room-session 의 수신함 자리에 들어가 받은 사건을 바로 stdout 에 쓴다.
// 요약을 다 쓰기 전에 받은 사건(입장 중의 채팅, system)은 들고 있다가 start() 에서 순서대로 쓴다.
// 사건을 저장하거나 다시 보내지 않는다. 출력은 사람에게 보여 주는 것이라 본문이 나온다(진단 로그가 아니다).

import type { DeliveryMode, InboxEvent, InboxEvents } from '../inbox/contract.js';
import type { Unsubscribe } from '../protocol/index.js';
import type { RoomObserved } from '../room-session/contract.js';
import type { MonitorBook, MonitorSink, MonitorSinkDeps } from './contract.js';
import { formatEvent, jsonLine } from './format.js';

/** start() 전에 들고 있는 사건의 최대 건수. 넘치면 버리고 버린 수를 한 줄로 알린다. */
export const MONITOR_HOLD_MAX = 1000;

/** JSON Lines 의 event 줄. 수신함 사건에 type 을 더한 것이다(cursor 는 없다). */
export function eventLine(event: InboxEvent): string {
  return jsonLine({ type: 'event', ...event });
}

export function createMonitorSink(deps: MonitorSinkDeps): MonitorSink {
  const scenarioIndex = new Map<string, number>();
  const claimAuthor = new Map<string, string>();
  const held: InboxEvent[] = [];
  let started = false;
  let closed = false;
  let written = 0;
  let dropped = 0;

  const seed = (observed: RoomObserved): void => {
    for (const scenario of observed.scenarios) scenarioIndex.set(scenario.scenario_id, scenario.index);
    for (const claim of observed.claims) claimAuthor.set(claim.claim_id, claim.by);
  };

  const refreshIfUnknown = (known: boolean): void => {
    if (known || deps.refresh === undefined) return;
    const observed = deps.refresh();
    if (observed !== null) seed(observed);
  };

  const book: MonitorBook = {
    scenarioIndex: (id) => scenarioIndex.get(id) ?? null,
    claimAuthor: (id) => claimAuthor.get(id) ?? null,
  };

  /** 출력하기 전에 표를 맞춘다. 시나리오 사건에는 순번이 없어 복제본의 요약에서 찾는다. */
  const learn = (event: InboxEvent): void => {
    switch (event.kind) {
      case 'scenario':
        refreshIfUnknown(scenarioIndex.has(event.data.scenario_id));
        return;
      case 'claim':
        claimAuthor.set(event.data.claim_id, event.data.by);
        refreshIfUnknown(scenarioIndex.has(event.data.scenario_id));
        return;
      case 'verification':
        refreshIfUnknown(claimAuthor.has(event.data.claim_id));
        return;
      default:
        return;
    }
  };

  const emit = (event: InboxEvent): void => {
    if (closed) return;
    written += 1;
    if (deps.json) {
      deps.write(eventLine(event));
      return;
    }
    learn(event);
    deps.write(formatEvent(event, deps.style, book));
  };

  return {
    push(event) {
      if (closed) return;
      if (started) {
        emit(event);
        return;
      }
      if (held.length >= MONITOR_HOLD_MAX) {
        dropped += 1;
        return;
      }
      held.push(event);
    },
    discardAll() {
      // 입장이 실패하거나 취소됐다. 들고 있던 사건은 버린다(쓰지 않은 수를 돌려준다).
      const unseen = held.length;
      held.length = 0;
      return unseen;
    },
    mode: (): DeliveryMode => 'poll',
    // 관전 모드의 room-session 은 수신 상태를 쓰지 않는다. 에이전트가 없으니 "수신 중"이 아니다.
    listening: () => false,
    on<E extends keyof InboxEvents>(_event: E, _listener: InboxEvents[E]): Unsubscribe {
      return () => undefined;
    },

    seed,
    start() {
      if (started || closed) return;
      started = true;
      for (const event of held.splice(0)) emit(event);
      if (dropped > 0) {
        // 버린 것이 있다. 수신함의 누락 알림과 같은 모양으로 한 줄 쓴다.
        emit({
          kind: 'system',
          change: null,
          id: null,
          from: 'system',
          to: 'you',
          ts: new Date(deps.now()).toISOString(),
          text: `${dropped} events were dropped before the summary was written.`,
          data: { code: 'inbox_dropped', count: dropped },
        });
      }
    },
    close() {
      closed = true;
      held.length = 0;
    },
    written: () => written,
    dropped: () => dropped,
  };
}
