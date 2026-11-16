// 채팅 전달 (protocol.md 4.3, 4.4. mcp-interface.md 3.6).
// chat 프레임 만들기, 크기·속도 검사, 수신자별 ack 대기, 본 id 집합, 보낸 버퍼, resend_of, 미확인 상한을 맡는다.
// 프레임을 보내는 함수 하나만 받는다. 다른 부분(수신함, 기록, 시그널링)을 부르지 않는다.
// 글은 작성자가 수신자에게 직접 보낸다. 받은 글을 다른 참가자에게 넘기는 길은 여기에 없다.

import { LIMITS, encodeP2PFrame, makeEntryId, utf8ByteLength } from '../protocol/index.js';
import type { ChatFrame, Now, TimerHandle, Timers } from '../protocol/index.js';
import type { ChatSent, SendChatArgs, SessionResult } from './contract.js';

/** 열린 링크로 텍스트 프레임 하나를 보낸다. mesh.send 와 같은 결과다. */
export type SendFrame = (peer: string, text: string) => 'ok' | 'not_open' | 'too_large';

export interface ChatTargets {
  /** 지금 글을 보낼 수 있는(동기화까지 끝난) 링크의 피어. */
  readonly open: readonly string[];
  /** 방에 있지만 나와 링크가 없는 참가자. 방 전체 글의 결과에 not_connected 로 싣는다. */
  readonly absent: readonly string[];
  /** `to` 에 쓸 수 있는 이름(자신을 뺀 참가자 전부). */
  readonly known: readonly string[];
}

export interface ChatDeliveryDeps {
  /** 이 입장의 sid. 메시지 ID(`<sid>-<순번>`)의 앞부분이 된다. */
  readonly sid: string;
  readonly sendFrame: SendFrame;
  readonly now: Now;
  readonly timers: Timers;
  /** resend_of 가 찾는 보낸 메시지 버퍼의 크기. */
  readonly sentBufferSize: number;
}

/** 실제로 보낸 글. 기록 파일의 chat_out 줄에 쓴다. resend_of 면 원문이다. */
export interface SentChat {
  readonly to: readonly string[] | null;
  readonly text: string;
  /** 프레임을 보낸 수신자 수. */
  readonly targets: number;
  readonly bytes: number;
}

export interface ChatSendOutcome {
  readonly result: SessionResult<ChatSent>;
  /** 거절했으면 null. */
  readonly sent: SentChat | null;
}

export type IncomingChat =
  /** 처음 본 글. to 는 수신함 사건의 to 값이다. */
  | { readonly kind: 'new'; readonly to: 'room' | 'you' }
  /** 이미 본 id. 수신함에 넣지 않고 ack 만 다시 보낸다. */
  | { readonly kind: 'duplicate' }
  /** 한 피어에게서 창 안에 CHAT_RECV_RATE_MAX 를 넘었다. 버리고 잘못된 프레임으로 센다. */
  | { readonly kind: 'rate_exceeded' }
  /** 대상 지정 글인데 내가 대상이 아니다. 버리고 잘못된 프레임으로 센다. */
  | { readonly kind: 'misaddressed' };

export interface ChatDelivery {
  /** 수신자에게 직접 보내고 수신자별 ack 를 기다린다. reject 하지 않는다. */
  send(args: SendChatArgs, targets: ChatTargets): Promise<ChatSendOutcome>;
  /** 받은 ack 하나. 기한 뒤에 온 것도 받아 미확인 집계와 보낸 버퍼를 고친다. */
  ack(peer: string, id: string): void;
  /** 받은 chat 하나를 가른다. 수신함과 기록에 넣는 일은 부르는 쪽이 한다. */
  accept(peer: string, frame: ChatFrame, self: string): IncomingChat;
  /** 그 피어의 링크가 닫혔다. 기다리던 ack 는 결과 불명(ack_timeout)으로 끝낸다. */
  peerClosed(peer: string): void;
  /** 진행 중인 전송을 CANCELLED 로 끝낸다. 이후의 send 도 CANCELLED 다. */
  close(): void;
}

type Undelivered = ChatSent['undelivered'][number];

interface SentEntry {
  readonly id: string;
  readonly to: readonly string[] | null;
  readonly text: string;
  readonly frame: string;
  readonly bytes: number;
  /** 아직 전달을 확인하지 못한 수신자. resend_of 의 대상이다. */
  readonly pending: Set<string>;
}

interface Operation {
  readonly entry: SentEntry;
  /** 이번 호출에서 시도한 수신자. 결과의 순서다. */
  readonly recipients: readonly string[];
  readonly waiting: Set<string>;
  readonly delivered: Set<string>;
  readonly failed: Map<string, Undelivered['reason']>;
  readonly sent: SentChat;
  timer: TimerHandle | null;
  resolve: (outcome: ChatSendOutcome) => void;
}

function fail(code: 'INVALID_ARGUMENT' | 'CANCELLED', detail: string): ChatSendOutcome {
  return { result: { ok: false, code, detail }, sent: null };
}

/** 창 밖으로 나간 시각을 앞에서부터 지운다. */
function prune(times: number[], now: number, windowMs: number): void {
  let drop = 0;
  while (drop < times.length && now - (times[drop] as number) >= windowMs) drop += 1;
  if (drop > 0) times.splice(0, drop);
}

export function createChatDelivery(deps: ChatDeliveryDeps): ChatDelivery {
  let closed = false;
  let seq = 1;
  /** 최근에 보낸 글. 넣은 순서가 오래된 순서다. */
  const sentBuffer = new Map<string, SentEntry>();
  const sendTimes: number[] = [];
  const operations = new Set<Operation>();
  /** 피어별로 ack 를 아직 못 받은 메시지 ID. 기한이 지난 것도 남는다(느린 피어 보호). */
  const unacked = new Map<string, Set<string>>();
  /** 최근에 본 chat.id. 넣은 순서가 오래된 순서다. */
  const seen = new Set<string>();
  const received = new Map<string, number[]>();

  const unackedOf = (peer: string): Set<string> => {
    let ids = unacked.get(peer);
    if (ids === undefined) {
      ids = new Set();
      unacked.set(peer, ids);
    }
    return ids;
  };

  const finish = (operation: Operation): void => {
    if (!operations.delete(operation)) return;
    if (operation.timer !== null) deps.timers.clearTimeout(operation.timer);
    operation.timer = null;
    for (const peer of operation.waiting) operation.failed.set(peer, 'ack_timeout');
    operation.waiting.clear();
    for (const peer of operation.delivered) operation.entry.pending.delete(peer);
    const delivered = operation.recipients.filter((peer) => operation.delivered.has(peer));
    const undelivered: Undelivered[] = [];
    for (const peer of operation.recipients) {
      const reason = operation.failed.get(peer);
      if (reason !== undefined && !operation.delivered.has(peer)) undelivered.push({ name: peer, reason });
    }
    operation.resolve({
      result: { ok: true, message_id: operation.entry.id, delivered, undelivered },
      sent: operation.sent,
    });
  };

  const remember = (entry: SentEntry): void => {
    sentBuffer.delete(entry.id);
    sentBuffer.set(entry.id, entry);
    while (sentBuffer.size > Math.max(1, deps.sentBufferSize)) {
      const oldest = sentBuffer.keys().next();
      if (oldest.done === true) break;
      sentBuffer.delete(oldest.value);
    }
  };

  /** 인자를 검증해 보낼 글과 이번에 시도할 수신자를 정한다. 아무 것도 보내지 않는다. */
  const prepare = (
    args: SendChatArgs,
    targets: ChatTargets,
    now: number,
  ): { entry: SentEntry; recipients: string[]; fresh: boolean } | ChatSendOutcome => {
    if (args.resend_of !== undefined) {
      const entry = sentBuffer.get(args.resend_of);
      if (entry === undefined) return fail('INVALID_ARGUMENT', 'resend_of is not in the sent buffer');
      // 대상은 처음에 전달되지 않은 참가자다. 그 가운데 지금 연결된 참가자에게만 프레임이 간다.
      return { entry, recipients: [...entry.pending], fresh: false };
    }

    const textBytes = utf8ByteLength(args.text);
    if (textBytes > LIMITS.CHAT_MAX_TEXT_BYTES) {
      return fail('INVALID_ARGUMENT', `text is ${textBytes} bytes; the limit is ${LIMITS.CHAT_MAX_TEXT_BYTES}`);
    }
    let to: string[] | null = null;
    if (args.to !== undefined) {
      to = [...new Set(args.to)];
      if (to.length === 0) return fail('INVALID_ARGUMENT', 'to must name at least one participant');
      const known = new Set(targets.known);
      if (to.some((name) => !known.has(name))) return fail('INVALID_ARGUMENT', 'to names an unknown participant');
    }
    const id = makeEntryId(deps.sid, seq);
    if (!id.ok) return fail('INVALID_ARGUMENT', 'message id space is exhausted');
    // 글자 수와 따로, 직렬화한 프레임의 크기도 보내기 전에 본다. 받는 쪽이 거절할 프레임을 만들지 않는다.
    const frame = encodeP2PFrame({ v: LIMITS.P2P_VERSION, t: 'chat', id: id.value, to, text: args.text, wall: now });
    if (!frame.ok) return fail('INVALID_ARGUMENT', frame.detail);
    const recipients = to ?? [...targets.open, ...targets.absent.filter((name) => !targets.open.includes(name))];
    const entry: SentEntry = {
      id: id.value,
      to,
      text: args.text,
      frame: frame.value,
      bytes: utf8ByteLength(frame.value),
      pending: new Set(recipients),
    };
    return { entry, recipients, fresh: true };
  };

  return {
    send(args, targets) {
      if (closed) return Promise.resolve(fail('CANCELLED', 'the session is shutting down'));
      const now = deps.now();
      const prepared = prepare(args, targets, now);
      if ('result' in prepared) return Promise.resolve(prepared);

      prune(sendTimes, now, LIMITS.CHAT_RATE_WINDOW_MS);
      if (sendTimes.length >= LIMITS.CHAT_SEND_RATE_MAX) {
        const retryAfter = Math.max(1, (sendTimes[0] as number) + LIMITS.CHAT_RATE_WINDOW_MS - now);
        return Promise.resolve({
          result: {
            ok: false,
            code: 'CHAT_RATE_LIMITED',
            details: { retry_after_ms: retryAfter },
            detail: `more than ${LIMITS.CHAT_SEND_RATE_MAX} messages in ${LIMITS.CHAT_RATE_WINDOW_MS} ms`,
          },
          sent: null,
        });
      }
      sendTimes.push(now);
      const { entry, recipients } = prepared;
      if (prepared.fresh) {
        seq += 1;
        remember(entry);
      }

      const open = new Set(targets.open);
      const waiting = new Set<string>();
      const failed = new Map<string, Undelivered['reason']>();
      for (const peer of recipients) {
        const pendingAcks = unackedOf(peer);
        // 느린 피어 보호: 확인받지 못한 글이 상한을 넘으면 그 피어로는 새로 보내지 않는다.
        if (!open.has(peer) || pendingAcks.size > LIMITS.CHAT_UNACKED_MAX) {
          failed.set(peer, 'not_connected');
        } else if (deps.sendFrame(peer, entry.frame) !== 'ok') {
          failed.set(peer, 'not_connected');
        } else {
          pendingAcks.add(entry.id);
          waiting.add(peer);
        }
      }

      return new Promise<ChatSendOutcome>((resolve) => {
        const operation: Operation = {
          entry,
          recipients,
          waiting,
          delivered: new Set(),
          failed,
          sent: { to: entry.to, text: entry.text, targets: waiting.size, bytes: entry.bytes },
          timer: null,
          resolve,
        };
        operations.add(operation);
        if (waiting.size === 0) {
          finish(operation);
          return;
        }
        operation.timer = deps.timers.setTimeout(() => {
          operation.timer = null;
          finish(operation);
        }, LIMITS.CHAT_ACK_TIMEOUT_MS);
      });
    },

    ack(peer, id) {
      unacked.get(peer)?.delete(id);
      let matched = false;
      for (const operation of [...operations]) {
        if (operation.entry.id !== id || !operation.waiting.delete(peer)) continue;
        matched = true;
        operation.delivered.add(peer);
        if (operation.waiting.size === 0) finish(operation);
      }
      // 기한 뒤에 온 ack: 호출은 이미 ack_timeout 으로 끝났다. 다음 resend_of 의 대상에서만 뺀다.
      if (!matched) sentBuffer.get(id)?.pending.delete(peer);
    },

    accept(peer, frame, self) {
      const now = deps.now();
      let times = received.get(peer);
      if (times === undefined) {
        times = [];
        received.set(peer, times);
      }
      prune(times, now, LIMITS.CHAT_RATE_WINDOW_MS);
      if (times.length >= LIMITS.CHAT_RECV_RATE_MAX) return { kind: 'rate_exceeded' };
      times.push(now);

      if (frame.to !== null && !frame.to.includes(self)) return { kind: 'misaddressed' };
      if (seen.has(frame.id)) return { kind: 'duplicate' };
      seen.add(frame.id);
      while (seen.size > LIMITS.SEEN_ID_CAPACITY) {
        const oldest = seen.values().next();
        if (oldest.done === true) break;
        seen.delete(oldest.value);
      }
      return { kind: 'new', to: frame.to === null ? 'room' : 'you' };
    },

    peerClosed(peer) {
      unacked.delete(peer);
      for (const operation of [...operations]) {
        if (!operation.waiting.delete(peer)) continue;
        // 상대가 받았는지 알 수 없다. 실패 확정이 아니라 결과 불명이다.
        operation.failed.set(peer, 'ack_timeout');
        if (operation.waiting.size === 0) finish(operation);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      for (const operation of [...operations]) {
        operations.delete(operation);
        if (operation.timer !== null) deps.timers.clearTimeout(operation.timer);
        operation.timer = null;
        operation.resolve(fail('CANCELLED', 'the session is shutting down'));
      }
    },
  };
}
