// 시험용 가짜 세션. room-session 의 계약(src/room-session/contract.ts)에 맞춘 대역이다. 제품 코드가 아니다.
// 방 기능이 없다: 시그널링에 접속하지 않고 WebRTC 를 열지 않는다. 입장은 그 자리에서 성공하고,
// "다른 참가자의 글"은 시험이 넣어 준다(inject). 규칙 판정은 흉내만 낸다. 제품 규칙의 증거가 아니다.
//
// 쓰는 곳: fake-entry.mjs (V-L7(가), 실제 호스트에 붙여 보는 최소판).

import { distUrl } from '../../support/proc.mjs';

const protocol = await import(distUrl('protocol/index.js'));

export const FAKE_PEER = 'peer-script';

function failure(code, detail) {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

/**
 * @param {object} deps
 * @param {{push(event: object): void, discardAll(): number, listening(): boolean}} deps.inbox
 * @param {object} deps.config  loadConfig 의 config.session
 * @param {() => number} deps.now
 * @param {{setTimeout: Function, clearTimeout: Function}} deps.timers
 * @param {{event: Function}} deps.log
 * @param {object} [deps.options]
 * @param {number} [deps.options.shutdownDelayMs] shutdown 이 걸리는 시간.
 * @param {boolean} [deps.options.shutdownHang] 참이면 shutdown 이 끝나지 않는다(예산 초과를 만든다).
 * @param {number} [deps.options.echoDelayMs] 0 이상이면 send_message 마다 그 시간 뒤에 가짜 참가자가 답한다.
 * @param {(entry: object) => void} [deps.options.onSent] 에이전트가 보낸 글을 받는다(시험의 관찰용).
 */
export function createFakeSession(deps) {
  const { inbox, config, now, timers, log } = deps;
  const options = deps.options ?? {};
  let room = null;
  let shuttingDown = false;
  let sid = protocol.newSid();
  let entrySeq = 0;
  const pendingTimers = new Set();

  const iso = () => new Date(now()).toISOString();
  const nextId = () => {
    entrySeq += 1;
    const made = protocol.makeEntryId(sid, entrySeq);
    return made.ok ? made.value : `${sid}-${entrySeq}`;
  };

  function selfView() {
    const presence = room.presence;
    const status = presence.status;
    return {
      name: room.name,
      client: presence.client,
      tools: presence.tools,
      role: presence.role,
      status,
      link: 'none',
      listening: inbox.listening(),
      shown_as: status === 'ready' ? 'ready' : status === 'working' ? 'working' : 'not_ready',
    };
  }

  function peerView() {
    return { name: FAKE_PEER, client: 'script', tools: [], role: null, status: 'ready', link: 'open', listening: true, shown_as: 'ready' };
  }

  function testStatus() {
    const test = room?.test;
    if (!test) return null;
    const elapsedMin = (now() - test.startedAt) / 60000;
    return {
      test_id: test.test_id,
      request: test.request,
      by: test.by,
      started: new Date(test.startedAt).toISOString(),
      max_duration_min: test.max_duration_min,
      remaining_min: Math.max(0, Math.ceil(test.max_duration_min - elapsedMin)),
      stopped: test.stopped,
      // 계약의 모양을 따른다(검토 3차 PRODUCT-R3-01: 유효 시나리오 목록). 이 가짜는 제목과 담당을 기억하지 않는다.
      scenarios: {
        used: test.scenarios.length,
        max: test.max_scenarios,
        items: test.scenarios.map((scenarioId, index) => ({ scenario_id: scenarioId, index: index + 1, title: '', by: room.name, actor: null, verifier: null })),
        items_omitted: 0,
      },
    };
  }

  function enter(args, joined) {
    if (shuttingDown) return failure('CANCELLED');
    if (room !== null) return failure('ALREADY_IN_ROOM');
    // 계약: ICE 설정이 거절됐으면 접속하지 않고 ICE_CONFIG_REJECTED 를 돌려준다.
    if (!config.iceServers.parsed.ok) return failure('ICE_CONFIG_REJECTED', config.iceServers.parsed.detail);
    const address = protocol.normalizeServerAddress(args.server ?? config.defaultServer);
    if (!address.ok) return failure('INVALID_ARGUMENT', address.detail);
    const name = protocol.checkPeerName(args.name ?? config.name);
    if (!name.ok) return failure('INVALID_ARGUMENT', name.detail);
    const roomId = args.room_id ?? protocol.newRoomId();
    if (!protocol.isRoomId(roomId)) return failure('INVALID_ARGUMENT', 'room_id must be 8-32 lowercase letters and digits');
    // 가짜 참가자와 같은 이름이면 서버가 거절한 것처럼 돌려준다.
    if (name.value === FAKE_PEER) return { ok: false, code: 'SIGNALING_ERROR', details: { server_code: 'NAME_IN_USE' } };

    sid = protocol.newSid();
    entrySeq = 0;
    room = {
      room_id: roomId,
      server: address.value.serverKey,
      name: name.value,
      joined,
      presence: { client: config.client, tools: [], role: null, status: 'joined', listening: false, note: null },
      test: null,
      claims: [],
    };
    log.event('info', 'room-session', 'join.end', { outcome: 'ok', room_ref: protocol.refOf(roomId), sid });
    return {
      ok: true,
      room_id: room.room_id,
      server: room.server,
      name: room.name,
      participants: joined ? [peerView()] : [selfView()],
      test: null,
    };
  }

  function later(delayMs, callback) {
    const handle = timers.setTimeout(() => {
      pendingTimers.delete(handle);
      callback();
    }, delayMs);
    pendingTimers.add(handle);
  }

  function pushChat(text, from = FAKE_PEER, to = 'room') {
    inbox.push({ kind: 'chat', change: null, id: nextId(), from, to, ts: iso(), text, data: {} });
  }

  function command(input) {
    if (shuttingDown) return failure('CANCELLED');
    if (room === null) return failure('NOT_IN_ROOM');
    switch (input.type) {
      case 'set_status': {
        const presence = room.presence;
        if (input.status !== undefined) presence.status = input.status;
        if (input.role !== undefined) presence.role = input.role;
        if (input.tools !== undefined) presence.tools = [...input.tools];
        if (input.note !== undefined) presence.note = input.note;
        return { ok: true, presence: { ...presence, listening: inbox.listening() } };
      }
      case 'start_test': {
        if (room.test !== null) return failure(room.test.stopped === null ? 'TEST_ALREADY_ACTIVE' : 'TEST_ENDED');
        room.test = {
          test_id: nextId(),
          request: input.request,
          by: room.name,
          startedAt: now(),
          max_duration_min: input.max_duration_min,
          max_scenarios: input.max_scenarios,
          stopped: null,
          scenarios: [],
        };
        return {
          ok: true,
          test_id: room.test.test_id,
          limits: { max_duration_min: input.max_duration_min, max_scenarios: input.max_scenarios },
          sent_to: [FAKE_PEER],
          not_connected: [],
        };
      }
      case 'stop_test': {
        if (room.test === null) return failure('NO_ACTIVE_TEST');
        room.test.stopped ??= { reason: 'user', by: room.name, at: iso(), detail: input.reason };
        return { ok: true, stopped: true, test_id: room.test.test_id, sent_to: [FAKE_PEER], not_connected: [] };
      }
      case 'start_scenario': {
        const test = room.test;
        if (test === null) return failure('NO_ACTIVE_TEST');
        if (test.stopped !== null) return failure('TEST_STOPPED');
        if (test.scenarios.length >= test.max_scenarios) return failure('SCENARIO_LIMIT_REACHED');
        const scenarioId = nextId();
        test.scenarios.push(scenarioId);
        return { ok: true, scenario_id: scenarioId, index: test.scenarios.length, remaining: test.max_scenarios - test.scenarios.length };
      }
      case 'record_claim': {
        const test = room.test;
        if (test === null) return failure('NO_ACTIVE_TEST');
        if (!test.scenarios.includes(input.scenario_id)) return failure('UNKNOWN_SCENARIO');
        const claimId = nextId();
        room.claims.push({ claim_id: claimId, by: room.name });
        return { ok: true, claim_id: claimId, status: 'unverified', late: test.stopped !== null };
      }
      case 'record_verification': {
        const claim = room.claims.find((entry) => entry.claim_id === input.claim_id);
        if (claim === undefined) return failure('UNKNOWN_CLAIM');
        if (claim.by === room.name) return failure('SELF_VERIFY_FORBIDDEN');
        return { ok: true, verification_id: nextId(), claim_status: input.result === 'unable' ? 'unverified' : input.result };
      }
      default:
        return failure('INVALID_ARGUMENT', 'unknown command');
    }
  }

  return {
    async create(args) {
      return enter(args, false);
    },

    async join(args) {
      return enter(args, true);
    },

    async leave() {
      if (shuttingDown) return failure('CANCELLED');
      if (room === null) return failure('NOT_IN_ROOM');
      room = null;
      // 계약: 방을 나가는 모든 길의 정리에서 수신함을 비운다.
      return { ok: true, left: true, transcript_path: null, undelivered_events: inbox.discardAll() };
    },

    async sendChat(args) {
      if (shuttingDown) return failure('CANCELLED');
      if (room === null) return failure('NOT_IN_ROOM');
      if (protocol.utf8ByteLength(args.text) > protocol.LIMITS.CHAT_MAX_TEXT_BYTES) return failure('INVALID_ARGUMENT', 'text is too large');
      const unknown = (args.to ?? []).filter((name) => name !== FAKE_PEER);
      if (unknown.length > 0) return failure('INVALID_ARGUMENT', 'unknown recipient');
      const messageId = nextId();
      options.onSent?.({ ts: iso(), message_id: messageId, to: args.to ?? 'room', text: args.text });
      if (typeof options.echoDelayMs === 'number' && options.echoDelayMs >= 0) {
        const text = args.text;
        later(options.echoDelayMs, () => {
          if (room !== null) pushChat(`echo: ${text}`);
        });
      }
      return { ok: true, message_id: messageId, delivered: [FAKE_PEER], undelivered: [] };
    },

    async command(input) {
      return command(input);
    },

    status() {
      if (shuttingDown) return failure('CANCELLED');
      if (room === null) return failure('NOT_IN_ROOM');
      return {
        ok: true,
        room: { room_id: room.room_id, server: room.server, name: room.name, signaling: 'connected', net: { stun: config.iceServers.parsed.value.length > 0, srflx_seen: false } },
        participants: [peerView()],
        test: testStatus(),
        claims: { confirmed: 0, refuted: 0, unverified: room.claims.length, late: 0, waiting_for_you: [] },
        warnings: [],
      };
    },

    async writeReport() {
      if (shuttingDown) return failure('CANCELLED');
      if (room === null) return failure('NOT_IN_ROOM');
      if (room.test === null) return failure('NO_ACTIVE_TEST');
      return failure('RECORD_FAILED', 'the test entry has no report writer');
    },

    notice() {
      if (room === null) return null;
      const stopped = room.test?.stopped;
      return stopped ? { test_stopped: { reason: stopped.reason, by: stopped.by } } : {};
    },

    shutdown(budgetMs) {
      shuttingDown = true;
      room = null;
      for (const handle of pendingTimers) timers.clearTimeout(handle);
      pendingTimers.clear();
      log.event('info', 'room-session', 'session.shutdown', { duration_ms: budgetMs });
      if (options.shutdownHang === true) return new Promise(() => {});
      const delayMs = options.shutdownDelayMs ?? 0;
      if (delayMs <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        timers.setTimeout(resolve, delayMs);
      });
    },

    // ── 시험이 쓰는 조종 ──────────────────────────────────────────────────────

    /** 방에 있는가. */
    inRoom: () => room !== null,

    /**
     * "다른 참가자"가 한 일을 수신함에 넣는다. 방에 없으면 버리고 거짓을 돌려준다.
     * @param {{op: string}} op
     */
    inject(op) {
      if (room === null) return false;
      switch (op.op) {
        case 'chat':
          pushChat(String(op.text ?? ''), op.from ?? FAKE_PEER, op.to === 'you' ? 'you' : 'room');
          return true;
        case 'burst': {
          const count = Math.max(1, Math.min(2000, Number(op.count) || 1));
          const size = Math.max(0, Number(op.bytes) || 0);
          for (let i = 1; i <= count; i += 1) {
            const head = `${op.label ?? 'burst'} ${i}/${count}`;
            pushChat(size > head.length ? `${head} ${'x'.repeat(size - head.length - 1)}` : head);
          }
          return true;
        }
        case 'event':
          inbox.push(op.event);
          return true;
        case 'stop': {
          const testId = room.test?.test_id ?? nextId();
          const request = room.test?.request ?? 'test injected by the peer script';
          if (room.test === null) {
            room.test = { test_id: testId, request, by: FAKE_PEER, startedAt: now(), max_duration_min: 60, max_scenarios: 20, stopped: null, scenarios: [] };
          }
          room.test.stopped ??= { reason: 'user', by: FAKE_PEER, at: iso(), detail: String(op.reason ?? 'stop requested') };
          inbox.push({
            kind: 'test',
            change: 'stopped',
            id: nextId(),
            from: FAKE_PEER,
            to: 'room',
            ts: iso(),
            text: `${FAKE_PEER} stopped the test`,
            data: { test_id: testId, request, limits: { max_duration_min: room.test.max_duration_min, max_scenarios: room.test.max_scenarios }, reason: 'user', by: FAKE_PEER },
          });
          return true;
        }
        default:
          return false;
      }
    },
  };
}
