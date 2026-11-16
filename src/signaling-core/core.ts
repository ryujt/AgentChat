// 시그널링 서버 규칙 (protocol.md 2.3). 저장과 전송은 포트로만 닿는다.
// 상태를 갖지 않는다. 공용 서버에서는 메시지마다 다른 실행이 이 코드를 돌리므로,
// 같은 연결의 호출이 동시에·역순으로 들어와도 맞게 동작해야 한다.

import { createHash } from 'node:crypto';
import type { ServerLogFields } from '../diagnostics/log-port.js';
import {
  LIMITS,
  encodeServerMessage,
  isSignalMessageTooLarge,
  parseClientMessage,
  refOf,
  signalCarriesRelay,
  utf8ByteLength,
} from '../protocol/index.js';
import type {
  ClientSignalMessage,
  JoinMessage,
  LeaveMessage,
  Member,
  PingMessage,
  ServerMessage,
  ServerSignalMessage,
  SignalErrorCode,
} from '../protocol/index.js';
import type { SignalingCore, SignalingCoreDeps } from './contract.js';
import type { ConnBinding, ConnId, PeerRecord, RoomKey } from './ports.js';

/** 조건부 쓰기에서 진 쪽이 3번 단계를 다시 평가하는 횟수. 넘으면 SERVER_ERROR 로 답하고 클라이언트가 다시 보낸다. */
const JOIN_WRITE_ATTEMPTS = 4;

/** 방 키의 길이(SHA-256 16진수 앞 32자리). 로그의 room_ref 는 같은 해시의 앞 12자리다. */
const ROOM_KEY_HEX_CHARS = 32;
const REF_HEX_CHARS = 12;

/** 응답의 message 칸. 받은 값의 원문을 싣지 않는다. */
const ERROR_TEXT: Readonly<Record<SignalErrorCode, string>> = Object.freeze({
  BAD_MESSAGE: 'message is not valid',
  MESSAGE_TOO_LARGE: `message exceeds ${LIMITS.SIGNAL_MAX_MESSAGE_BYTES} bytes`,
  UNSUPPORTED_VERSION: 'protocol version is not supported',
  NOT_JOINED: 'connection is not joined',
  ROOM_NOT_FOUND: 'room has no participants',
  ROOM_EXISTS: 'room already has participants',
  ROOM_FULL: `room is full (${LIMITS.ROOM_MAX_PEERS})`,
  NAME_IN_USE: 'name is in use by another live connection',
  PEER_NOT_FOUND: 'peer is not in the room',
  RELAY_NOT_ALLOWED: 'relay candidates are not forwarded',
  RATE_LIMITED: 'too many messages or failed joins',
  REPLACED: 'a newer connection took over this registration',
  SERVER_ERROR: 'internal server error',
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 저장소 키. 방 ID 는 유일한 접근 수단이라 저장소와 로그에 원문을 넘기지 않는다. */
export function roomKeyOf(roomId: string): RoomKey {
  return sha256Hex(roomId).slice(0, ROOM_KEY_HEX_CHARS);
}

/** resume key 는 해시로만 견준다. */
export function keyHashOf(resumeKey: string): string {
  return sha256Hex(resumeKey);
}

type ErrorExtra = { readonly retry_after_ms?: number; readonly supported?: readonly number[] };

/** throttled: 앞단 스로틀이 그 글을 버렸다. 오류 응답을 또 보내지 않는다(요구량을 늘리지 않는다). 클라이언트 재전송이 메운다. */
type SendOutcome = 'ok' | 'gone' | 'throttled' | 'failed' | 'invalid';

export function createSignalingCore(deps: SignalingCoreDeps): SignalingCore {
  const { store, sink, now, log } = deps;

  const isStale = (record: PeerRecord, at: number): boolean => at - record.lastSeenAt > LIMITS.PARTICIPANT_STALE_MS;

  const refs = (connId: ConnId, roomKey?: RoomKey, peer?: string): ServerLogFields => ({
    conn_ref: refOf(connId),
    ...(roomKey === undefined ? {} : { room_ref: roomKey.slice(0, REF_HEX_CHARS) }),
    ...(peer === undefined ? {} : { peer_ref: refOf(peer) }),
  });

  /** 글 하나를 내보낸다. 던지지 않는다. invalid 는 규칙 코드가 스키마에 맞지 않는 글을 만든 경우다(결함). */
  async function sendTo(connId: ConnId, message: ServerMessage): Promise<SendOutcome> {
    const encoded = encodeServerMessage(message);
    if (!encoded.ok) {
      log.event('error', 'signaling-core', 'send.invalid', { ...refs(connId), kind: message.type, error_code: encoded.code });
      return 'invalid';
    }
    try {
      return await sink.send(connId, encoded.value);
    } catch {
      log.event('warn', 'signaling-core', 'send.failed', { ...refs(connId), kind: message.type, error_code: 'SERVER_ERROR' });
      return 'failed';
    }
  }

  /** 요청을 보낸 연결에 오류로 답한다. 응답 전송 실패는 무시한다(상대가 이미 없다). */
  async function fail(connId: ConnId, code: SignalErrorCode, re: string | undefined, extra: ErrorExtra = {}): Promise<void> {
    await sendTo(connId, {
      type: 'error',
      code,
      message: ERROR_TEXT[code],
      ...(re === undefined ? {} : { re }),
      ...(extra.retry_after_ms === undefined ? {} : { retry_after_ms: extra.retry_after_ms }),
      ...(extra.supported === undefined ? {} : { supported: [...extra.supported] }),
    });
  }

  /** 요청의 성공 응답. 스키마에 걸리면 그 요청의 SERVER_ERROR 로 바꾼다. */
  async function reply(connId: ConnId, message: ServerMessage, re: string): Promise<SendOutcome> {
    const outcome = await sendTo(connId, message);
    if (outcome === 'invalid') await fail(connId, 'SERVER_ERROR', re);
    return outcome;
  }

  async function closeQuietly(connId: ConnId): Promise<void> {
    try {
      await sink.close(connId);
    } catch {
      // 닫기는 최선이다. 못 닫아도 기록은 연결 ID 조건으로 지켜진다.
    }
  }

  /** 방의 살아 있는 참가자 가운데 자신을 뺀 목록. 오래된 기록은 읽을 때 걸러낸다. */
  async function liveOthers(roomKey: RoomKey, self: string): Promise<Member[]> {
    const records = await store.listPeers(roomKey);
    const at = now();
    return records
      .filter((record) => record.peer !== self && !isStale(record, at))
      .map((record) => ({ peer: record.peer, sid: record.sid }))
      .sort((a, b) => (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0));
  }

  async function sendJoined(connId: ConnId, re: string, members: Member[]): Promise<SendOutcome> {
    return reply(
      connId,
      {
        type: 'joined',
        re,
        members,
        max_peers: LIMITS.ROOM_MAX_PEERS,
        ping_interval_ms: LIMITS.SIGNAL_PING_INTERVAL_MS,
        stale_after_ms: LIMITS.PARTICIPANT_STALE_MS,
      },
      re,
    );
  }

  /**
   * 판정을 통과한(그 판을 차지한) join 의 마무리: 연결을 등록하고 joined 로 답한다.
   * cause=claimed 는 앞선 처리가 차지만 하고 등록·응답 전에 실패한 것을 이 처리가 마친 경우다(검토 3차 SERVER-R3-01).
   */
  async function bindAndReply(
    connId: ConnId,
    message: JoinMessage,
    roomKey: RoomKey,
    members: Member[],
    base: ServerLogFields,
    more: ServerLogFields,
  ): Promise<void> {
    await store.bind(connId, { roomKey, peer: message.peer, sid: message.sid });
    const sent = await sendJoined(connId, message.id, members);
    if (sent === 'gone') {
      // 연결이 이미 없다(공용 서버의 410). 종료 통지가 이 처리의 등록보다 먼저 끝났으면 아무도 이 등록과 기록을 지우지 않는다.
      // 방금 만든 것을 지운다. 기록은 연결 ID 조건이라 그 사이 다른 연결로 인계된 새 기록은 지우지 못한다(검토 2차 SERVER-R2-02).
      await store.unbind(connId);
      const removed = await store.deletePeer(roomKey, message.peer, { connId });
      log.event('info', 'signaling-core', 'conn.join', {
        ...base,
        sid: message.sid,
        outcome: 'gone',
        reason: removed ? 'released' : 'record_changed',
        ...more,
        members: members.length,
      });
      return;
    }
    log.event('info', 'signaling-core', 'conn.join', {
      ...base,
      sid: message.sid,
      outcome: sent === 'invalid' ? 'failed' : 'joined',
      ...(sent === 'invalid' ? { error_code: 'SERVER_ERROR' } : {}),
      // 등록은 마쳤지만 joined 가 스로틀로 버려졌다. 클라이언트가 같은 join 을 다시 보내면 등록된 연결로 joined 를 다시 받는다.
      ...(sent === 'throttled' ? { reason: 'throttled' } : {}),
      ...more,
      members: members.length,
    });
  }

  async function handleJoin(connId: ConnId, message: JoinMessage, binding: ConnBinding | null): Promise<void> {
    const roomKey = roomKeyOf(message.room);
    const base: ServerLogFields = { ...refs(connId, roomKey, message.peer), mode: message.mode, seq: message.seq };
    const rejected = (code: SignalErrorCode, more: ServerLogFields = {}): void => {
      log.event('info', 'signaling-core', 'conn.join', { ...base, outcome: 'rejected', error_code: code, ...more });
    };

    if (binding !== null) {
      if (binding.roomKey !== roomKey || binding.peer !== message.peer) {
        rejected('BAD_MESSAGE');
        await fail(connId, 'BAD_MESSAGE', message.id);
        return;
      }
      // 응답이 사라져 다시 보낸 join 이다. 판정을 다시 하면 그 사이 들어온 참가자 때문에 만든 쪽이 ROOM_EXISTS 를 받는다.
      const members = await liveOthers(roomKey, message.peer);
      await sendJoined(connId, message.id, members);
      log.event('info', 'signaling-core', 'conn.join', { ...base, outcome: 'resent', members: members.length });
      return;
    }

    const keyHash = keyHashOf(message.key);
    let takeover = false;
    let settled = false;
    /**
     * 판정에 쓴 기록의 lastSeenAt. 기록의 판(版)을 가리킨다. 같은 연결의 같은 join 이 두 실행에서 겹치면 둘이 같은 기록으로 판정한다.
     * 실패한 쪽은 이 판일 때만 지우고, 통과한 쪽은 이 판일 때만 차지한다(검토 1차 SERVER-R1-01).
     */
    let version = 0;

    for (let attempt = 0; attempt < JOIN_WRITE_ATTEMPTS && !settled; attempt += 1) {
      const existing = await store.getPeer(roomKey, message.peer);
      const at = now();
      const record: PeerRecord = {
        roomKey,
        peer: message.peer,
        connId,
        sid: message.sid,
        keyHash,
        seq: message.seq,
        lastSeenAt: at,
      };

      if (existing === null) {
        if (await store.putPeer(record, { absent: true })) {
          settled = true;
          version = record.lastSeenAt;
        }
        continue;
      }

      // 덮어쓰기는 "방금 읽은 연결 ID 와 seq 그대로"일 때만 된다. 지면 이 단계를 다시 평가한다.
      const unchanged = { connId: existing.connId, seq: existing.seq };

      if (isStale(existing, at)) {
        if (await store.putPeer(record, unchanged)) {
          settled = true;
          version = record.lastSeenAt;
        }
        continue;
      }

      if (existing.keyHash === keyHash) {
        if (existing.connId === connId && existing.seq === message.seq) {
          if (existing.claimed === true) {
            // 같은 join 의 앞선 처리가 이 판으로 판정을 통과해 차지했지만 등록(bind)·응답 전에 실패했다(저장소의 일시 실패, 함수 기한).
            // 또는 다른 실행이 지금 등록하는 중이다. 판정은 이미 끝났다. 다시 판정하면 그 사이의 방 변화 때문에 만든 쪽이 ROOM_EXISTS 를,
            // 들어온 쪽이 ROOM_NOT_FOUND 를 받는다(등록된 연결의 재전송과 같은 이유). 등록하고 joined 로 답한다(검토 3차 SERVER-R3-01).
            // 두 실행이 함께 답하면 joined 가 둘 가고, 클라이언트는 두 번째를 버린다.
            const members = await liveOthers(roomKey, message.peer);
            await bindAndReply(connId, message, roomKey, members, base, { cause: 'claimed' });
            return;
          }
          // 앞선 처리가 판정 전에 끊겼거나, 같은 join 을 다른 실행이 함께 처리하는 중이다. 기록은 그대로 두고 판정으로 간다.
          settled = true;
          version = existing.lastSeenAt;
          continue;
        }
        if (message.seq > existing.seq) {
          if (await store.putPeer(record, unchanged)) {
            takeover = true;
            settled = true;
            version = record.lastSeenAt;
            if (existing.connId !== connId) {
              await fail(existing.connId, 'REPLACED', undefined);
              await closeQuietly(existing.connId);
            }
          }
          continue;
        }
        // 늦게 처리된 옛 연결의 join 이다. 순번이 같은 다른 연결도 어느 쪽이 나중인지 가릴 수 없어 인계하지 않는다.
        rejected('REPLACED', { seq_stale: true });
        await fail(connId, 'REPLACED', message.id);
        await closeQuietly(connId);
        return;
      }

      // 같은 이름을 다른 프로세스가 쓴다. 그 연결이 실제로 닫혔을 때만 자리를 넘긴다.
      if (await sink.isOpen(existing.connId)) {
        rejected('NAME_IN_USE');
        await fail(connId, 'NAME_IN_USE', message.id);
        return;
      }
      if (await store.putPeer(record, unchanged)) {
        settled = true;
        version = record.lastSeenAt;
      }
    }

    if (!settled) {
      log.event('error', 'signaling-core', 'conn.join', { ...base, outcome: 'failed', error_code: 'SERVER_ERROR', attempt: JOIN_WRITE_ATTEMPTS });
      await fail(connId, 'SERVER_ERROR', message.id);
      return;
    }

    // 쓰고 나서 읽고 판정한다. 순위가 아니라 자기가 읽은 목록의 수로 본다.
    const members = await liveOthers(roomKey, message.peer);
    let failure: SignalErrorCode | null = null;
    if (message.mode === 'create' && members.length > 0) failure = 'ROOM_EXISTS';
    else if (message.mode === 'join' && members.length === 0) failure = 'ROOM_NOT_FOUND';
    else if (members.length + 1 > LIMITS.ROOM_MAX_PEERS) failure = 'ROOM_FULL';

    if (failure !== null) {
      // 판정에 쓴 판 그대로이고 아무도 차지하지 않았을 때만 지운다. 이번 처리가 쓴 판이든, "모두 같다"로 앞선 처리가 남긴 판이든 같다
      // (앞선 처리가 쓰고 등록 전에 끊긴 기록을 남기면 실패를 받은 연결이 정원에 세어진다).
      // 같은 join 을 함께 처리한 다른 실행이 이 판으로 통과해 차지했으면 지우지 못한다.
      const removed = await store.deletePeer(roomKey, message.peer, { connId, writtenAt: version });
      if (!removed) {
        // 지우지 못했는데 기록이 아직 이 연결의 이 join 이면, 같은 join 의 다른 처리가 그 판을 차지했다(또는 다시 썼다).
        // 여기서 실패 코드를 보내면 같은 요청에 joined 와 반대인 답이 함께 가고, 먼저 닿은 쪽을 클라이언트가 따른다(검토 2차 SERVER-R2-01).
        const current = await store.getPeer(roomKey, message.peer);
        if (current !== null && current.connId === connId && current.seq === message.seq) {
          if (current.claimed === true) {
            // 차지한 처리가 판정을 통과했다. 그 처리가 등록·응답 전에 실패했을 수 있으니 이 처리도 등록하고 joined 로 답한다.
            // "차지한 처리가 joined 를 보낸다"고 기대하고 조용히 끝내면, 그 처리가 실패한 경우 이 요청에는 끝내 답이 없다(검토 3차 SERVER-R3-01).
            // 이 처리가 읽은 목록(판정 실패의 근거)이 지금 방의 참가자다.
            await bindAndReply(connId, message, roomKey, members, base, { cause: 'claimed', takeover });
            return;
          }
          // 같은 join 의 다른 처리가 새 판을 썼고 아직 판정하지 않았다. 답은 그 처리가 한다.
          log.event('info', 'signaling-core', 'conn.join', { ...base, outcome: 'superseded', error_code: failure, takeover, members: members.length });
          return;
        }
      }
      if (failure === 'ROOM_NOT_FOUND') {
        const misses = await store.bumpJoinMiss(connId);
        if (misses >= LIMITS.JOIN_MISS_MAX) {
          rejected('RATE_LIMITED', { takeover, members: members.length });
          log.event('warn', 'signaling-core', 'rate.limited', { ...refs(connId, roomKey, message.peer), reason: 'join_miss', error_code: 'RATE_LIMITED' });
          await fail(connId, 'RATE_LIMITED', message.id, { retry_after_ms: LIMITS.RATE_WINDOW_MS });
          await closeQuietly(connId);
          return;
        }
      }
      rejected(failure, { takeover, members: members.length });
      await fail(connId, failure, message.id);
      return;
    }

    // 판정에 쓴 기록(그 판)이 그대로인지 확인하며 차지한다. 같은 join 을 함께 처리한 다른 실행이 판정에 실패해 그 기록을 지웠으면
    // 여기서 실패한다. 지운 사이에 다른 입장자가 이 기록을 보지 못하고 통과했을 수 있어 joined 를 보내지 않는다.
    // 거꾸로 차지한 뒤에는 그 실행의 삭제(판 조건)가 실패한다. 같은 판을 판정해 통과한 다른 실행도 차지에 성공한다.
    // 클라이언트는 SERVER_ERROR 를 받으면 같은 join 을 같은 연결에 다시 보낸다.
    const claimed = await store.claimPeer(roomKey, message.peer, { connId, writtenAt: version });
    if (!claimed) {
      log.event('warn', 'signaling-core', 'conn.join', { ...base, outcome: 'failed', error_code: 'SERVER_ERROR', reason: 'record_changed', takeover });
      await fail(connId, 'SERVER_ERROR', message.id);
      return;
    }
    // 차지한 뒤 등록이나 응답 전에 이 처리가 실패하면(저장소 오류는 onMessage 가 SERVER_ERROR 로 답한다) 클라이언트가 같은 join 을 다시 보낸다.
    // 그 재전송은 차지된 판을 보고 다시 판정하지 않고 등록을 마친다(위 "모두 같다", 검토 3차 SERVER-R3-01).
    await bindAndReply(connId, message, roomKey, members, base, { takeover });
  }

  async function handleSignal(connId: ConnId, message: ClientSignalMessage, binding: ConnBinding | null, bytes: number): Promise<void> {
    const cid = message.kind === 'offer-request' ? undefined : message.cid;
    const base: ServerLogFields = {
      ...refs(connId, binding?.roomKey, binding?.peer),
      kind: message.kind,
      bytes,
      ...(cid === undefined ? {} : { cid }),
    };
    const rejected = async (code: SignalErrorCode): Promise<void> => {
      log.event(code === 'SERVER_ERROR' ? 'error' : 'info', 'signaling-core', 'relay', { ...base, outcome: 'rejected', error_code: code });
      await fail(connId, code, message.id);
    };

    if (binding === null) return rejected('NOT_JOINED');
    if (message.to === binding.peer) return rejected('BAD_MESSAGE');
    // 서버는 SDP 를 해석하지 않는다. relay 후보 표시가 든 것만 전달하지 않는다.
    if (signalCarriesRelay(message)) return rejected('RELAY_NOT_ALLOWED');

    const target = await store.getPeer(binding.roomKey, message.to);
    if (target === null || isStale(target, now())) return rejected('PEER_NOT_FOUND');

    // from 과 sid 는 보낸 연결의 등록에서 붙인다. 보낸 쪽의 참가자 기록은 읽지 않는다.
    const { action: _action, id: _id, to: _to, ...payload } = message;
    const forward = { type: 'signal', from: binding.peer, sid: binding.sid, ...payload } as ServerSignalMessage;
    const outcome = await sendTo(target.connId, forward);

    if (outcome === 'gone') {
      await store.deletePeer(binding.roomKey, message.to, { connId: target.connId });
      return rejected('PEER_NOT_FOUND');
    }
    if (outcome === 'throttled') {
      // 스로틀 중이다. SERVER_ERROR 를 보내면 그 응답도 스로틀 토큰을 쓴다. 보낸 쪽은 시도 안에서 같은 signal 을 다시 보낸다.
      log.event('warn', 'signaling-core', 'relay', { ...base, outcome: 'throttled' });
      return;
    }
    if (outcome !== 'ok') return rejected('SERVER_ERROR');
    log.event('info', 'signaling-core', 'relay', { ...base, outcome: 'ok' });
  }

  async function handlePing(connId: ConnId, message: PingMessage, binding: ConnBinding | null): Promise<void> {
    if (binding === null) {
      await fail(connId, 'NOT_JOINED', message.id);
      return;
    }
    // 조건이 맞지 않으면 다른 연결에 인계됐거나, 기록이 지워졌거나, 이미 오래된 것이다.
    // 오래된 기록은 되살리지 않는다. 목록에서 빠져 있던 동안 다른 참가자가 자리를 채웠을 수 있다.
    const at = now();
    const touched = await store.touchPeer(binding.roomKey, binding.peer, { connId, seenSince: at - LIMITS.PARTICIPANT_STALE_MS }, at);
    if (!touched) {
      await fail(connId, 'NOT_JOINED', message.id);
      return;
    }
    const members = await liveOthers(binding.roomKey, binding.peer);
    await reply(connId, { type: 'pong', re: message.id, members }, message.id);
  }

  /** leave 와 종료 통지가 함께 쓴다. 삭제가 연결 ID 조건부라 늦게 온 옛 연결의 통지가 새 기록을 지우지 못한다. */
  async function release(connId: ConnId, reason: 'leave' | 'disconnect'): Promise<void> {
    const binding = await store.unbind(connId);
    if (binding === null) {
      log.event('info', 'signaling-core', 'conn.closed', { ...refs(connId), reason, outcome: 'unbound' });
      return;
    }
    const removed = await store.deletePeer(binding.roomKey, binding.peer, { connId });
    log.event('info', 'signaling-core', 'conn.closed', {
      ...refs(connId, binding.roomKey, binding.peer),
      reason,
      outcome: removed ? 'removed' : 'kept',
    });
  }

  async function handleLeave(connId: ConnId, _message: LeaveMessage): Promise<void> {
    await release(connId, 'leave');
  }

  /** 요청의 id 를 읽을 수 있으면 돌려준다. 오류 응답의 re 에 쓴다. */
  function requestIdOf(text: string): string | undefined {
    const parsed = parseClientMessage(text);
    return parsed.ok ? parsed.value.id : parsed.re;
  }

  async function onMessage(connId: ConnId, text: string): Promise<void> {
    let re: string | undefined;
    let parsedOnce = false;
    try {
      // 1. 상한을 넘으면 JSON 을 파싱하지 않는다. 크기는 건수를 세기 전에 본다.
      const tooLarge = isSignalMessageTooLarge(text);
      parsedOnce = tooLarge;

      // 2. 연결별 속도 제한. 건수 올리기와 등록 읽기를 한 번에 한다.
      // 상한을 넘는 글도 센다. 세지 않으면 한 연결이 큰 글만 보내 한도 없이 서버와 스로틀을 붙잡을 수 있다.
      const at = now();
      const hit = await store.hitRate(connId, at);
      if (hit.count > LIMITS.RATE_MAX_MESSAGES) {
        log.event('warn', 'signaling-core', 'rate.limited', {
          ...refs(connId, hit.binding?.roomKey, hit.binding?.peer),
          reason: 'rate',
          error_code: 'RATE_LIMITED',
        });
        await fail(connId, 'RATE_LIMITED', undefined, { retry_after_ms: LIMITS.RATE_WINDOW_MS - (at % LIMITS.RATE_WINDOW_MS) });
        await closeQuietly(connId);
        return;
      }
      if (tooLarge) {
        log.event('info', 'signaling-core', 'conn.rejected', { ...refs(connId), error_code: 'MESSAGE_TOO_LARGE', bytes: utf8ByteLength(text) });
        await fail(connId, 'MESSAGE_TOO_LARGE', undefined);
        return;
      }

      // 3. JSON 과 스키마.
      const parsed = parseClientMessage(text);
      parsedOnce = true;
      if (!parsed.ok) {
        re = parsed.re;
        log.event('info', 'signaling-core', 'conn.rejected', { ...refs(connId), error_code: parsed.code, bytes: utf8ByteLength(text) });
        await fail(connId, parsed.code, parsed.re, parsed.code === 'UNSUPPORTED_VERSION' ? { supported: LIMITS.SIGNAL_SUPPORTED_VERSIONS } : {});
        return;
      }

      const message = parsed.value;
      re = message.id;
      switch (message.action) {
        case 'join':
          await handleJoin(connId, message, hit.binding);
          return;
        case 'signal':
          await handleSignal(connId, message, hit.binding, utf8ByteLength(text));
          return;
        case 'ping':
          await handlePing(connId, message, hit.binding);
          return;
        case 'leave':
          await handleLeave(connId, message);
          return;
      }
    } catch (error) {
      // 저장소·전송의 실패다. 그 요청의 SERVER_ERROR 로 바꾼다. 재시도는 클라이언트가 한다.
      if (!parsedOnce) re = requestIdOf(text);
      log.event('error', 'signaling-core', 'message.failed', { ...refs(connId), error_code: 'SERVER_ERROR', reason: errorName(error) });
      await fail(connId, 'SERVER_ERROR', re);
    }
  }

  async function onDisconnect(connId: ConnId): Promise<void> {
    try {
      await release(connId, 'disconnect');
    } catch (error) {
      log.event('error', 'signaling-core', 'disconnect.failed', { ...refs(connId), error_code: 'SERVER_ERROR', reason: errorName(error) });
    }
  }

  return { onMessage, onDisconnect };
}

/** 오류는 이름만 남긴다. message 에는 저장소가 돌려준 값이 섞일 수 있다. */
function errorName(error: unknown): string {
  return error instanceof Error && typeof error.name === 'string' && error.name !== '' ? error.name : 'Error';
}
