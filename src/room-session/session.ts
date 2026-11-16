// 프로세스에 하나인 세션 (architecture.md 3.10). 한 번에 방 하나에만 있는다.
// 여기서는 "방에 있는가"와 인자 검증만 본다. 방 안의 일은 입장마다 새로 만드는 room 이 한다.
// observe 는 관전 모드로 들어간다(protocol.md 4.6). 입장 절차는 join 과 같고 쓰는 일만 하지 않는다.
// 만들 때는 아무 데도 접속하지 않는다.

import { checkPeerName, isRoomId, newResumeKey, newRoomId, newSid, normalizeServerAddress } from '../protocol/index.js';
import type {
  CommandOutputs,
  CreateRoomArgs,
  CreateRoomSession,
  DefaultRoomSessionLimits,
  JoinRoomArgs,
  ObserveRoomArgs,
  RoomEntered,
  RoomObserved,
  RoomSession,
  SessionCommand,
  SessionFailure,
  SessionResult,
} from './contract.js';
import { createRoom } from './room.js';
import type { Room } from './room.js';

/** 제품 기본값(architecture.md 5절). */
export const DEFAULT_ROOM_SESSION_LIMITS: DefaultRoomSessionLimits = Object.freeze({
  PRESENCE_MIN_INTERVAL_MS: 5000,
  SENT_BUFFER_SIZE: 200,
});

const NOT_IN_ROOM: SessionFailure = { ok: false, code: 'NOT_IN_ROOM', detail: 'not in a room' };
const ALREADY_IN_ROOM: SessionFailure = { ok: false, code: 'ALREADY_IN_ROOM', detail: 'already in a room or joining one' };
const CANCELLED: SessionFailure = { ok: false, code: 'CANCELLED', detail: 'the call was cancelled or the process is shutting down' };

export const createRoomSession: CreateRoomSession = (deps) => {
  // resume key 는 프로세스가 뜰 때 한 번 정한다. 파일에 저장하지 않는다.
  const key = newResumeKey(deps.randomBytes);
  // 접속 순번은 key 와 수명이 같다. 방을 나갔다 다시 들어가도 이어 센다(protocol.md 2.2).
  let joinSeq = 0;
  const nextSeq = (): number => {
    joinSeq += 1;
    return joinSeq;
  };
  /** entering 과 leaving 동안에도 방을 차지하고 있다. 그동안의 create·join 은 ALREADY_IN_ROOM 이다. */
  let phase: 'idle' | 'entering' | 'in' | 'leaving' = 'idle';
  let room: Room | null = null;
  let stopping: Promise<void> | null = null;
  /** 이 프로세스가 방마다 쓴 이름. 나갔다가 다른 이름으로 들어와 자기 주장을 검증하는 것을 막는다. */
  const namesByRoom = new Map<string, Set<string>>();

  const invalid = (detail: string): SessionFailure => ({ ok: false, code: 'INVALID_ARGUMENT', detail });

  const enter = async (
    mode: 'create' | 'join' | 'observe',
    args: CreateRoomArgs | JoinRoomArgs | ObserveRoomArgs,
  ): Promise<SessionResult<{ readonly room: Room; readonly entered: { readonly ok: true } & RoomEntered }>> => {
    if (stopping !== null) return CANCELLED;
    if (phase !== 'idle') return ALREADY_IN_ROOM;
    if (args.signal?.aborted === true) return CANCELLED;

    // ICE 설정이 틀리면 접속하지 않는다. 기본값으로 바꿔 쓰지 않는다.
    const ice = deps.config.iceServers.parsed;
    if (!ice.ok) return { ok: false, code: 'ICE_CONFIG_REJECTED', detail: ice.detail };
    // server 인자가 없을 때만 환경 변수의 값을 본다. 잘못된 값을 공용 서버로 바꿔 접속하지 않는다.
    const server = normalizeServerAddress(args.server ?? deps.config.defaultServer);
    if (!server.ok) {
      if (args.server !== undefined) return invalid(server.detail);
      // 에이전트는 server 인자를 주지 않았다. 원인이 설정이라는 것과 할 일을 알린다(mcp-interface.md 2절, 검토 1차 PRODUCT-R1-04).
      return invalid(
        `the server argument was not given, and the AGENT_CHAT_SERVER setting is not a valid server address (${server.detail}). ` +
          'Ask your user to fix the AGENT_CHAT_SERVER setting, or pass the server argument the user gave you.',
      );
    }
    const name = checkPeerName(args.name ?? deps.config.name);
    if (!name.ok) return invalid(name.detail);
    const roomId = args.room_id ?? (mode === 'create' ? newRoomId(deps.randomBytes) : undefined);
    if (!isRoomId(roomId)) return invalid('room_id must be 8-32 characters of lowercase letters and digits');

    phase = 'entering';
    // 관전자는 주장을 쓰거나 검증하지 않는다. 이 방에서 쓴 이름 목록에 넣지 않는다.
    let names: Set<string>;
    if (mode === 'observe') {
      names = new Set([name.value]);
    } else {
      const roomKey = `${server.value.serverKey}\n${roomId}`;
      names = namesByRoom.get(roomKey) ?? new Set<string>();
      names.add(name.value);
      namesByRoom.set(roomKey, names);
    }

    const entered = createRoom(deps, {
      mode: mode === 'observe' ? 'join' : mode,
      role: mode === 'observe' ? 'observer' : 'participant',
      roomId,
      name: name.value,
      sid: newSid(deps.randomBytes),
      key,
      nextSeq,
      server: server.value,
      iceServers: ice.value,
      selfNames: names,
      signal: args.signal,
    });
    room = entered;
    const result = await entered.enter();
    if (result.ok && stopping === null) {
      phase = 'in';
      return { ok: true, room: entered, entered: result };
    }
    if (room === entered) room = null;
    phase = 'idle';
    // 종료가 시작됐으면 진행 중이던 호출은 CANCELLED 다. 방의 정리는 종료 절차가 한다.
    return result.ok ? CANCELLED : result;
  };

  const enterAs = async (mode: 'create' | 'join', args: CreateRoomArgs | JoinRoomArgs): Promise<SessionResult<RoomEntered>> => {
    const result = await enter(mode, args);
    return result.ok ? result.entered : result;
  };

  const inRoom = (): Room | null => (phase === 'in' ? room : null);

  const session: RoomSession = {
    create: (args) => enterAs('create', args),
    join: (args) => enterAs('join', args),

    async observe(args) {
      const result = await enter('observe', args);
      if (!result.ok) return result;
      const observed: RoomObserved = result.room.observed();
      return { ok: true, ...observed };
    },

    observed() {
      if (stopping !== null) return CANCELLED;
      const current = inRoom();
      if (current === null) return NOT_IN_ROOM;
      return { ok: true, ...current.observed() };
    },

    async leave() {
      if (stopping !== null) return CANCELLED;
      const current = inRoom();
      if (current === null) return NOT_IN_ROOM;
      phase = 'leaving';
      try {
        const left = await current.leave();
        return stopping !== null ? CANCELLED : { ok: true, ...left };
      } finally {
        if (room === current) room = null;
        phase = 'idle';
      }
    },

    async sendChat(args) {
      if (stopping !== null) return CANCELLED;
      const current = inRoom();
      if (current === null) return NOT_IN_ROOM;
      const result = await current.sendChat(args);
      return stopping !== null ? CANCELLED : result;
    },

    async ping(args) {
      if (stopping !== null) return CANCELLED;
      const current = inRoom();
      if (current === null) return NOT_IN_ROOM;
      const result = await current.ping(args);
      return stopping !== null ? CANCELLED : result;
    },

    async command<C extends SessionCommand>(command: C): Promise<SessionResult<CommandOutputs[C['type']]>> {
      if (stopping !== null) return CANCELLED;
      const current = inRoom();
      if (current === null) return NOT_IN_ROOM;
      return current.command(command) as SessionResult<CommandOutputs[C['type']]>;
    },

    status() {
      if (stopping !== null) return CANCELLED;
      const current = inRoom();
      if (current === null) return NOT_IN_ROOM;
      return { ok: true, ...current.status() };
    },

    async writeReport() {
      if (stopping !== null) return CANCELLED;
      const current = inRoom();
      if (current === null) return NOT_IN_ROOM;
      const result = await current.writeReport();
      return stopping !== null ? CANCELLED : result;
    },

    notice() {
      const current = stopping === null ? inRoom() : null;
      if (current === null) return null;
      try {
        return current.notice();
      } catch {
        deps.log.event('error', 'room-session', 'notice.failed', {});
        return null;
      }
    },

    shutdown(budgetMs) {
      if (stopping !== null) return stopping;
      const current = room;
      stopping = (async (): Promise<void> => {
        if (current === null) return;
        try {
          await current.shutdown(budgetMs);
        } catch {
          // 종료는 reject 하지 않는다. 남은 정리는 프로세스 종료에 맡긴다.
        }
      })();
      return stopping;
    },
  };
  return session;
};
