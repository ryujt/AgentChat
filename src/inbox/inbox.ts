// 수신함 구현 (architecture.md 3.8, mcp-interface.md 7절).
// 사건을 넣은 순서대로 보관하고, 한 번에 한 경로(poll 또는 channel)로만 내준다.
// 상태는 모두 createInbox 안에 있다. 시각과 타이머는 주입받는다.

import { randomLowerAlnum } from '../protocol/index.js';
import type { Unsubscribe } from '../protocol/index.js';
import type {
  ChannelItem,
  ChannelSender,
  ConfirmResult,
  CreateInbox,
  DefaultInboxLimits,
  DeliveredEvent,
  DeliveryMode,
  Inbox,
  InboxEvent,
  InboxEvents,
  InboxNotice,
  InboxStats,
  SystemEvent,
  ToolCallInfo,
  WaitOptions,
  WaitResult,
} from './contract.js';

export const DEFAULT_INBOX_LIMITS: DefaultInboxLimits = Object.freeze({
  INBOX_MAX_EVENTS: 1000,
  WAIT_MAX_EVENTS: 20,
  WAIT_MAX_RESULT_BYTES: 24000,
  LISTEN_GRACE_MS: 120000,
  CHANNEL_SEEN_GRACE_MS: 120000,
});

const PROBE_TOKEN_LENGTH = 16;
const CURSOR_PATTERN = /^[0-9]{1,15}$/;
const WAIT_TOOL = 'wait_for_messages';

interface Entry {
  readonly seq: number;
  /** cursor 를 붙인 사건. 다시 줄 때도 같은 객체를 쓴다. */
  readonly delivered: DeliveredEvent;
  /** delivered 를 JSON 으로 적은 UTF-8 길이. */
  readonly bytes: number;
  /** 어느 경로로든(wait·confirm 의 결과, 채널) 한 번이라도 내줬는가. */
  handed: boolean;
  /** 채널로 보냈거나 channel 모드에서 다시 준 시각. 확인을 기다리는 기한의 기준이다. */
  pushedAt: number | null;
  /** 누락 알림 사건이면 그것이 대신하는 사건 수. 보통 사건은 0. */
  readonly dropCount: number;
}

interface Waiter {
  readonly from: number;
  readonly resolve: (result: WaitResult) => void;
  timer: { readonly handle: unknown } | null;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
}

interface Batch {
  readonly entries: readonly Entry[];
  readonly events: readonly DeliveredEvent[];
  readonly bytes: number;
  /** 마지막으로 담은 사건의 순번. 담은 것이 없으면 from 그대로다. */
  readonly last: number;
  readonly more: boolean;
}

type ListenerRecord<E extends keyof InboxEvents> = { readonly fn: InboxEvents[E] };

/** cursorBase 의 상한. 이 값에 사건 수를 더해도 cursor 가 15자리(CURSOR_PATTERN, tool 입력 형식) 안에 든다. */
const CURSOR_BASE_MAX = 1e14;

function parseCursor(cursor: string | undefined): number | null {
  if (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor)) return null;
  return Number.parseInt(cursor, 10);
}

function cursorBaseOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > CURSOR_BASE_MAX) return 0;
  return Math.floor(value);
}

export const createInbox: CreateInbox = (deps) => {
  const { limits, now, timers, log } = deps;
  // 누락 알림 하나와 새 사건 하나는 항상 들어갈 수 있어야 한다.
  const maxEvents = Math.max(2, Math.floor(limits.INBOX_MAX_EVENTS));
  const maxBatchEvents = Math.max(1, Math.floor(limits.WAIT_MAX_EVENTS));

  const queue: Entry[] = [];
  // 순번은 cursorBase 다음부터 센다. 앞 프로세스의 cursor(더 작다)를 넘기면 resolveFrom 의 min 규칙으로 새 사건을 처음부터 준다.
  const base = cursorBaseOf(deps.cursorBase);
  let nextSeq = base + 1;
  /** 마지막으로 내준 곳. poll 에서는 wait·confirm 결과로, channel 에서는 채널로 보낸 곳이다. */
  let deliveredUpTo = base;
  /** channel 모드에서 에이전트가 봤다고 확인한 곳. */
  let confirmedUpTo = base;
  let mode: DeliveryMode = 'poll';
  let token: string | null = null;
  let probePending = false;
  let sender: ChannelSender | null = null;
  let sending = false;
  let waiter: Waiter | null = null;
  let lastWaitEndedAt: number | null = null;
  let listeningNow = false;
  let graceTimer: { readonly handle: unknown } | null = null;
  let dropped = 0;
  /** 마지막 tool 호출 뒤 채널로 보낸 사건 수와, 그 사건들 바로 앞의 순번. */
  let pushedCount = 0;
  let pushedAfter = 0;
  let closed = false;

  const listeners: { [E in keyof InboxEvents]: ListenerRecord<E>[] } = {
    'listening-changed': [],
    'mode-changed': [],
  };

  // ── 이벤트 ────────────────────────────────────────────────────────────────

  function on<E extends keyof InboxEvents>(event: E, listener: InboxEvents[E]): Unsubscribe {
    const record: ListenerRecord<E> = { fn: listener };
    const list = listeners[event] as ListenerRecord<E>[];
    list.push(record);
    return () => {
      const index = list.indexOf(record);
      if (index >= 0) list.splice(index, 1);
    };
  }

  function emit<E extends keyof InboxEvents>(event: E, payload: Parameters<InboxEvents[E]>[0]): void {
    if (closed) return;
    for (const record of [...listeners[event]] as ListenerRecord<E>[]) {
      try {
        (record.fn as (value: Parameters<InboxEvents[E]>[0]) => void)(payload);
      } catch {
        // 리스너의 예외가 다른 리스너와 수신함의 상태를 깨지 않게 한다. 오류 글은 남기지 않는다.
        log.event('warn', 'inbox', 'inbox.listener_error', { kind: event });
      }
    }
  }

  // ── 대기열 ────────────────────────────────────────────────────────────────

  /** 순번이 seq 보다 큰 첫 항목의 자리. 대기열은 순번 순이다. */
  function firstIndexAfter(seq: number): number {
    let low = 0;
    let high = queue.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((queue[mid] as Entry).seq <= seq) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** from 뒤의 사건을 상한까지 담는다. upTo 를 주면 그 순번까지만 본다. */
  function collect(from: number, upTo = Number.POSITIVE_INFINITY): Batch {
    const entries: Entry[] = [];
    const events: DeliveredEvent[] = [];
    let bytes = 0;
    let last = from;
    let index = firstIndexAfter(from);
    while (index < queue.length) {
      const entry = queue[index] as Entry;
      if (entry.seq > upTo) break;
      if (events.length >= maxBatchEvents) break;
      // 사건 하나가 바이트 상한보다 크면 그것 하나만 준다.
      if (events.length > 0 && bytes + entry.bytes > limits.WAIT_MAX_RESULT_BYTES) break;
      entries.push(entry);
      events.push(entry.delivered);
      bytes += entry.bytes;
      last = entry.seq;
      index += 1;
    }
    const next = queue[index];
    return { entries, events, bytes, last, more: next !== undefined && next.seq <= upTo };
  }

  function chatIds(batch: Batch): string[] {
    const ids: string[] = [];
    for (const event of batch.events) if (event.kind === 'chat' && event.id !== null) ids.push(event.id);
    return ids;
  }

  function markDelivered(batch: Batch, via: 'poll' | 'confirm' | 'recheck'): void {
    for (const entry of batch.entries) entry.handed = true;
    if (batch.last > deliveredUpTo) deliveredUpTo = batch.last;
    log.event('info', 'inbox', 'inbox.delivered', {
      via,
      delivered: batch.events.length,
      bytes: batch.bytes,
      more: batch.more,
      msg_id: chatIds(batch),
    });
  }

  function isoNow(): string {
    const at = now();
    return Number.isFinite(at) ? new Date(at).toISOString() : new Date(0).toISOString();
  }

  function makeEntry(seq: number, event: InboxEvent, dropCount: number): Entry {
    const delivered = { cursor: String(seq), ...event } as DeliveredEvent;
    const bytes = Buffer.byteLength(JSON.stringify(delivered), 'utf8');
    return { seq, delivered, bytes, handed: false, pushedAt: null, dropCount };
  }

  function makeDropMarker(seq: number, count: number): Entry {
    const event: SystemEvent = {
      kind: 'system',
      change: null,
      id: null,
      from: 'system',
      to: 'you',
      ts: isoNow(),
      text: `${count} event(s) were dropped here because the inbox was full. Their content is in the local transcript file.`,
      data: { code: 'inbox_dropped', count },
    };
    return makeEntry(seq, event, count);
  }

  /** 새 사건 하나가 들어갈 자리를 만든다. 확인된 것부터 버리고, 확인 못 한 것을 버려야 하면 누락 알림을 남긴다. */
  function makeRoom(): void {
    if (queue.length < maxEvents) return;
    // channel 모드에서 채널로만 보낸 사건은 전달의 증거가 없다. 확인된 곳까지만 조용히 버린다.
    const safeUpTo = mode === 'channel' ? confirmedUpTo : deliveredUpTo;
    while (queue.length >= maxEvents && (queue[0] as Entry).seq <= safeUpTo) queue.shift();
    if (queue.length < maxEvents) return;

    let count = 0;
    let real = 0;
    let lastVictim: Entry | null = null;
    let oldestPushedAt: number | null = null;
    while (queue.length > maxEvents - 2) {
      const victim = queue.shift() as Entry;
      if (victim.dropCount > 0) {
        count += victim.dropCount;
      } else {
        count += 1;
        real += 1;
      }
      if (oldestPushedAt === null && victim.pushedAt !== null) oldestPushedAt = victim.pushedAt;
      lastVictim = victim;
    }
    if (lastVictim === null) return;
    dropped += real;
    const marker = makeDropMarker(lastVictim.seq, count);
    if (mode === 'channel' && lastVictim.handed) {
      // 이미 채널로 보낸 구간이다. 알림은 채널로 보내지 않고, 다시 줄 때(확인 호출, poll 복귀) 맨 앞에 나오게 둔다.
      marker.handed = true;
      marker.pushedAt = oldestPushedAt;
    }
    queue.unshift(marker);
    log.event('warn', 'inbox', 'inbox.dropped', { unseen: real });
  }

  // ── listening ─────────────────────────────────────────────────────────────

  /** channel 모드에서 채널로 보냈지만 확인되지 않은 가장 오래된 사건의 시각. */
  function oldestUnconfirmedAt(): number | null {
    const entry = queue[firstIndexAfter(confirmedUpTo)];
    if (entry === undefined || entry.seq > deliveredUpTo) return null;
    return entry.pushedAt;
  }

  /** listening 이 거짓으로 바뀔 시각. 그럴 일이 없으면 null. */
  function listeningDeadline(): number | null {
    if (mode === 'poll') {
      if (waiter !== null || lastWaitEndedAt === null) return null;
      return lastWaitEndedAt + limits.LISTEN_GRACE_MS;
    }
    const at = oldestUnconfirmedAt();
    return at === null ? null : at + limits.CHANNEL_SEEN_GRACE_MS;
  }

  function computeListening(): boolean {
    if (mode === 'poll') {
      if (waiter !== null) return true;
      return lastWaitEndedAt !== null && now() - lastWaitEndedAt < limits.LISTEN_GRACE_MS;
    }
    const at = oldestUnconfirmedAt();
    return at === null || now() - at < limits.CHANNEL_SEEN_GRACE_MS;
  }

  function clearGrace(): void {
    if (graceTimer === null) return;
    timers.clearTimeout(graceTimer.handle);
    graceTimer = null;
  }

  /** listening 을 다시 계산해 바뀌었으면 알리고, 다음에 바뀔 때에 맞춰 타이머를 건다. 상태를 다 바꾼 뒤 마지막에 부른다. */
  function refresh(): void {
    if (closed) return;
    clearGrace();
    const value = computeListening();
    const deadline = value ? listeningDeadline() : null;
    if (deadline !== null) {
      const timer = { handle: timers.setTimeout(() => onGrace(timer), Math.max(0, deadline - now())) };
      graceTimer = timer;
    }
    if (value === listeningNow) return;
    const previous = listeningNow;
    listeningNow = value;
    log.event('info', 'inbox', 'delivery.listening', { from: previous, to: value, cause: mode });
    emit('listening-changed', value);
  }

  function onGrace(timer: { readonly handle: unknown }): void {
    if (graceTimer !== timer) return;
    graceTimer = null;
    refresh();
  }

  // ── wait ──────────────────────────────────────────────────────────────────

  function emptyResult(status: WaitResult['status'], cursor: number): WaitResult {
    return { status, events: [], next_cursor: String(cursor), more: false };
  }

  function eventsResult(batch: Batch): WaitResult {
    return { status: 'events', events: batch.events, next_cursor: String(batch.last), more: batch.more };
  }

  /** 걸려 있는 wait 을 끝낸다. 타이머와 취소 리스너를 뗀다. listening 은 부르는 쪽이 다시 계산한다. */
  function settleWaiter(result: (from: number) => WaitResult): void {
    const current = waiter;
    if (current === null) return;
    waiter = null;
    if (current.timer !== null) timers.clearTimeout(current.timer.handle);
    if (current.signal !== undefined && current.onAbort !== null) {
      current.signal.removeEventListener('abort', current.onAbort);
    }
    lastWaitEndedAt = now();
    current.resolve(result(current.from));
  }

  function resolveFrom(cursor: string | undefined): number {
    const parsed = parseCursor(cursor);
    // 아직 준 적 없는 곳을 가리키면 마지막으로 준 곳으로 본다.
    return parsed === null ? deliveredUpTo : Math.min(parsed, deliveredUpTo);
  }

  function waitInChannelMode(options: WaitOptions): WaitResult {
    const parsed = parseCursor(options.cursor);
    if (parsed === null) return emptyResult('channel_mode', confirmedUpTo);
    // cursor 까지 봤다는 확인이다. 채널로 보낸 곳을 넘어서 확인할 수는 없다.
    const seen = Math.min(parsed, deliveredUpTo);
    if (seen > confirmedUpTo) confirmedUpTo = seen;
    const batch = collect(seen, deliveredUpTo);
    if (batch.events.length === 0) return emptyResult('channel_mode', seen);
    const at = now();
    // 결과로 다시 준 것은 그때부터 확인을 기다린다.
    for (const entry of batch.entries) entry.pushedAt = at;
    markDelivered(batch, 'recheck');
    return eventsResult(batch);
  }

  function startWait(options: WaitOptions): Promise<WaitResult> {
    if (closed || options.signal?.aborted === true) {
      return Promise.resolve(emptyResult('cancelled', mode === 'channel' ? confirmedUpTo : deliveredUpTo));
    }
    // 동시에 걸린 wait 은 하나다. 먼저 온 쪽을 빈 결과로 끝낸다.
    settleWaiter((from) => emptyResult('timeout', from));

    if (mode === 'channel') {
      const result = waitInChannelMode(options);
      lastWaitEndedAt = now();
      refresh();
      return Promise.resolve(result);
    }

    const from = resolveFrom(options.cursor);
    const batch = collect(from);
    if (batch.events.length > 0) {
      markDelivered(batch, 'poll');
      lastWaitEndedAt = now();
      refresh();
      return Promise.resolve(eventsResult(batch));
    }
    if (!(options.timeoutMs > 0)) {
      lastWaitEndedAt = now();
      refresh();
      return Promise.resolve(emptyResult('timeout', from));
    }

    return new Promise<WaitResult>((resolve) => {
      const entry: Waiter = { from, resolve, timer: null, signal: options.signal, onAbort: null };
      entry.timer = {
        handle: timers.setTimeout(() => {
          if (waiter !== entry) return;
          settleWaiter((cursor) => emptyResult('timeout', cursor));
          refresh();
        }, options.timeoutMs),
      };
      if (options.signal !== undefined) {
        entry.onAbort = () => {
          if (waiter !== entry) return;
          // 취소된 요청에는 응답이 가지 않는다. 커서를 옮기지 않는다.
          settleWaiter((cursor) => emptyResult('cancelled', cursor));
          refresh();
        };
        options.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      waiter = entry;
      refresh();
    });
  }

  function wait(options: WaitOptions): Promise<WaitResult> {
    try {
      return startWait(options);
    } catch {
      log.event('error', 'inbox', 'inbox.error', { kind: 'wait' });
      return Promise.resolve(emptyResult('cancelled', deliveredUpTo));
    }
  }

  // ── 채널 ──────────────────────────────────────────────────────────────────

  function nextChannelItem(): ChannelItem | null {
    if (mode === 'poll') {
      // 확인 전에 채널로 가는 것은 점검 알림뿐이다.
      if (!probePending || token === null) return null;
      probePending = false;
      log.event('info', 'inbox', 'delivery.probe', { outcome: 'sent' });
      return { type: 'probe', token };
    }
    probePending = false;
    const entry = queue[firstIndexAfter(deliveredUpTo)];
    if (entry === undefined) return null;
    if (pushedCount === 0) pushedAfter = deliveredUpTo;
    pushedCount += 1;
    entry.handed = true;
    entry.pushedAt = now();
    deliveredUpTo = entry.seq;
    log.event('info', 'inbox', 'inbox.delivered', {
      via: 'channel',
      delivered: 1,
      bytes: entry.bytes,
      kind: entry.delivered.kind,
      msg_id: entry.delivered.kind === 'chat' ? entry.delivered.id : null,
    });
    return { type: 'event', event: entry.delivered };
  }

  /** 채널로 보낼 것을 하나씩 넘긴다. 앞의 것이 끝난 뒤에 다음 것을 넘긴다. */
  function pump(): void {
    if (closed || sending || sender === null) return;
    const item = nextChannelItem();
    if (item === null) return;
    sending = true;
    let sent: Promise<void>;
    try {
      sent = Promise.resolve(sender(item));
    } catch {
      sent = Promise.reject(new Error('channel send failed'));
    }
    sent
      .catch(() => {
        // 호스트는 받았다고 알려 주지 않는다. 실패해도 멈추지 않고, 확인 절차가 유실을 메운다.
        log.event('warn', 'inbox', 'delivery.channel_send', { outcome: 'failed', kind: item.type });
      })
      .then(() => {
        sending = false;
        pump();
        refresh();
      });
  }

  function startProbe(): void {
    if (closed || sender === null || mode === 'channel') return;
    if (token === null) token = randomLowerAlnum(PROBE_TOKEN_LENGTH, deps.randomBytes);
    probePending = true;
    pump();
  }

  function setChannelSender(next: ChannelSender | null): void {
    if (closed) return;
    sender = next;
    if (next === null) return;
    pump();
    refresh();
  }

  function confirm(candidate: string): ConfirmResult {
    if (closed || token === null || typeof candidate !== 'string' || candidate !== token) {
      log.event('info', 'inbox', 'delivery.probe', { outcome: 'rejected' });
      return { ok: false, code: 'INVALID_ARGUMENT' };
    }
    if (mode === 'channel') {
      // 같은 점검 알림을 두 번 본 에이전트의 두 번째 확인이다. 바꿀 것이 없다.
      return { ok: true, events: [], next_cursor: String(confirmedUpTo) };
    }
    mode = 'channel';
    probePending = false;
    // 밀린 사건은 이 결과로만 나간다. 결과로 준 것은 확인된 것으로 친다.
    const batch = collect(deliveredUpTo);
    if (batch.events.length > 0) markDelivered(batch, 'confirm');
    confirmedUpTo = deliveredUpTo;
    const nextCursor = String(deliveredUpTo);
    pushedCount = 0;
    settleWaiter((from) => emptyResult('channel_mode', from));
    log.event('info', 'inbox', 'delivery.probe', { outcome: 'confirmed' });
    log.event('info', 'inbox', 'delivery.mode', { from: 'poll', to: 'channel', cause: 'confirmed' });
    emit('mode-changed', { from: 'poll', to: 'channel', cause: 'confirmed' });
    // 상한을 넘은 나머지와 이후 사건은 채널로 간다.
    pump();
    refresh();
    return { ok: true, events: batch.events, next_cursor: nextCursor };
  }

  function countUnconfirmed(): number {
    if (mode !== 'channel') return 0;
    return firstIndexAfter(deliveredUpTo) - firstIndexAfter(confirmedUpTo);
  }

  /** 확인이 끊긴 channel 모드에서 poll 로 되돌아간다. 확인 안 된 사건부터 다시 준다. */
  function revertToPoll(): InboxNotice {
    const after = confirmedUpTo;
    const unseen = countUnconfirmed();
    mode = 'poll';
    deliveredUpTo = confirmedUpTo;
    pushedCount = 0;
    // 앞 토큰은 버린다. 채널이 실제로 통하면 새 점검 알림이 도착한다.
    token = randomLowerAlnum(PROBE_TOKEN_LENGTH, deps.randomBytes);
    probePending = true;
    log.event('info', 'inbox', 'delivery.mode', { from: 'channel', to: 'poll', cause: 'channel_unconfirmed', unseen });
    emit('mode-changed', { from: 'channel', to: 'poll', cause: 'channel_unconfirmed' });
    pump();
    refresh();
    return { delivery: { mode: 'poll', reason: 'channel_unconfirmed', after_cursor: String(after) } };
  }

  function noteToolCall(call: ToolCallInfo): InboxNotice {
    if (closed || mode !== 'channel') return {};
    const isWait = call.name === WAIT_TOOL;
    const confirms = isWait && parseCursor(call.cursor) !== null;
    // 수신 불명에서 되돌아가지 않는 호출은 "여기까지 봤다"는 확인 하나뿐이다.
    if (!confirms && !computeListening()) return revertToPoll();
    const notice: InboxNotice =
      !confirms && pushedCount > 0
        ? { pushed_since_last_call: { count: pushedCount, after_cursor: String(pushedAfter) } }
        : {};
    pushedCount = 0;
    return notice;
  }

  // ── 넣기와 비우기 ─────────────────────────────────────────────────────────

  function push(event: InboxEvent): void {
    if (closed) return;
    try {
      const entry = makeEntry(nextSeq, event, 0);
      nextSeq += 1;
      makeRoom();
      queue.push(entry);
      if (mode === 'poll') {
        const current = waiter;
        if (current !== null) {
          const batch = collect(current.from);
          if (batch.events.length > 0) {
            markDelivered(batch, 'poll');
            settleWaiter(() => eventsResult(batch));
          }
        }
      } else {
        pump();
      }
      refresh();
    } catch {
      // push 는 던지지 않는다. JSON 으로 적을 수 없는 사건은 버린다.
      log.event('error', 'inbox', 'inbox.error', { kind: 'push' });
    }
  }

  function discardAll(): number {
    if (closed) return 0;
    let unseen = 0;
    for (const entry of queue) if (!entry.handed) unseen += 1;
    const total = queue.length;
    queue.length = 0;
    // 순번은 이어 간다. 확인 안 된 사건과 집계도 함께 없어진다.
    deliveredUpTo = nextSeq - 1;
    confirmedUpTo = deliveredUpTo;
    pushedCount = 0;
    if (total > 0) log.event('info', 'inbox', 'inbox.discarded', { unseen });
    refresh();
    return unseen;
  }

  function stats(): InboxStats {
    let undelivered = 0;
    for (const entry of queue) if (!entry.handed) undelivered += 1;
    return { queued: queue.length, undelivered, dropped, unconfirmed: countUnconfirmed() };
  }

  function close(): void {
    if (closed) return;
    clearGrace();
    settleWaiter((from) => emptyResult('cancelled', from));
    closed = true;
    sender = null;
  }

  return {
    on,
    push,
    discardAll,
    wait,
    startProbe,
    confirm,
    setChannelSender,
    noteToolCall,
    mode: () => mode,
    listening: () => !closed && computeListening(),
    stats,
    close,
  } satisfies Inbox;
};
