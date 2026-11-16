// V-U2 가운데 포트와 맞닿는 부분: core 가 저장소와 전송을 어떤 순서·조건으로 부르는지, 포트가 실패할 때 무엇으로 답하는지.
// 저장소는 부른 기록을 남기는 대역이다. 규칙 전체(입장 판정, 인계, 정원, 동시 처리)는 메모리 저장소와 함께
// src/signaling-selfhost/core-rules.test.ts 가 본다. 형제 구현을 import 할 수 없어 그쪽에 둔다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { LogLevel, ServerLogFields } from '../diagnostics/log-port.js';
import { LIMITS, encodeClientMessage, parseServerMessage } from '../protocol/index.js';
import type { ClientMessage, ServerMessage } from '../protocol/index.js';
import type { ConnBinding, ConnectionSink, PeerRecord, RoomStore } from './contract.js';
import { createSignalingCore } from './index.js';

const T0 = 1_800_000_000_000;
const ROOM = 'roomsecret0000001';
const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(43);
const SID_A = 'aaaaaaaaaaaa';
const SID_B = 'bbbbbbbbbbbb';
const SDP = 'v=0 marker-sdp-body a=candidate:1 1 udp 2 192.0.2.1 9 typ host';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const ROOM_KEY = sha256(ROOM).slice(0, 32);

type Call = readonly [name: keyof RoomStore, ...args: unknown[]];

interface Harness {
  readonly core: ReturnType<typeof createSignalingCore>;
  readonly calls: Call[];
  readonly sent: { connId: string; message: ServerMessage }[];
  readonly closed: string[];
  readonly isOpenCalls: string[];
  readonly logs: { level: LogLevel; event: string; fields: ServerLogFields }[];
  /** 그 연결이 받은 글. */
  to(connId: string): ServerMessage[];
}

type StoreOverrides = { [K in keyof RoomStore]?: RoomStore[K] };

interface SinkOverrides {
  send?: ConnectionSink['send'];
  isOpen?: ConnectionSink['isOpen'];
  close?: ConnectionSink['close'];
}

/** 아무 것도 저장하지 않는 대역. 기본 답은 "빈 저장소"이고 시험이 연산별로 바꾼다. */
function harness(storeOverrides: StoreOverrides = {}, sinkOverrides: SinkOverrides = {}, startAt = T0): Harness {
  const calls: Call[] = [];
  const sent: Harness['sent'] = [];
  const closed: string[] = [];
  const isOpenCalls: string[] = [];
  const logs: Harness['logs'] = [];
  const defaults: RoomStore = {
    hitRate: async () => ({ count: 1, binding: null }),
    bind: async () => undefined,
    unbind: async () => null,
    getPeer: async () => null,
    putPeer: async () => true,
    listPeers: async () => [],
    touchPeer: async () => true,
    claimPeer: async () => true,
    deletePeer: async () => true,
    bumpJoinMiss: async () => 1,
  };
  const store = {} as Record<string, unknown>;
  for (const name of Object.keys(defaults) as (keyof RoomStore)[]) {
    const impl = (storeOverrides[name] ?? defaults[name]) as (...args: unknown[]) => Promise<unknown>;
    store[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return impl(...args);
    };
  }
  const sink: ConnectionSink = {
    send: async (connId, text) => {
      if (sinkOverrides.send !== undefined) {
        const outcome = await sinkOverrides.send(connId, text);
        if (outcome !== 'ok') return outcome;
      }
      const parsed = parseServerMessage(text);
      assert.ok(parsed.ok, `core 가 클라이언트가 버릴 글을 보냈다: ${text}`);
      sent.push({ connId, message: parsed.value });
      return 'ok';
    },
    isOpen: async (connId) => {
      isOpenCalls.push(connId);
      return sinkOverrides.isOpen === undefined ? true : sinkOverrides.isOpen(connId);
    },
    close: async (connId) => {
      closed.push(connId);
      await sinkOverrides.close?.(connId);
    },
  };
  const core = createSignalingCore({
    store: store as unknown as RoomStore,
    sink,
    now: () => startAt,
    log: { event: (level, _module, event, fields) => logs.push({ level, event, fields: fields ?? {} }) },
  });
  return { core, calls, sent, closed, isOpenCalls, logs, to: (connId) => sent.filter((s) => s.connId === connId).map((s) => s.message) };
}

function encode(message: ClientMessage): string {
  const encoded = encodeClientMessage(message);
  assert.ok(encoded.ok, 'encodeClientMessage');
  return encoded.value;
}

const joinText = (more: Partial<Extract<ClientMessage, { action: 'join' }>> = {}): string =>
  encode({ action: 'join', v: 1, id: 'j1', room: ROOM, peer: 'alice', sid: SID_A, key: KEY_A, mode: 'create', seq: 1, ...more });

const offerText = (to = 'bob'): string =>
  encode({ action: 'signal', id: 's1', to, kind: 'offer', cid: `${SID_A}.1`, data: { sdp: SDP } });

const bound = (peer = 'alice', sid = SID_A): ConnBinding => ({ roomKey: ROOM_KEY, peer, sid });

const peerRecord = (peer: string, connId: string, more: Partial<PeerRecord> = {}): PeerRecord => ({
  roomKey: ROOM_KEY,
  peer,
  connId,
  sid: SID_B,
  keyHash: sha256(KEY_B),
  seq: 1,
  lastSeenAt: T0,
  ...more,
});

const names = (h: Harness): string[] => h.calls.map((call) => call[0]);
const errorOf = (message: ServerMessage | undefined): { code: string; re: string | undefined } | null =>
  message?.type === 'error' ? { code: message.code, re: message.re } : null;

describe('V-U2 signaling-core: 포트를 부르는 순서와 조건', () => {
  it('상한을 넘는 글은 건수만 세고, 파싱 없이 MESSAGE_TOO_LARGE 다', async () => {
    const h = harness();
    await h.core.onMessage('c1', `{"action":"ping","id":"p1","pad":"${'x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES)}"}`);
    assert.deepEqual(h.calls, [['hitRate', 'c1', T0]]);
    // 파싱했다면 id 를 읽어 re 에 실었을 것이다.
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'MESSAGE_TOO_LARGE', re: undefined });
    assert.deepEqual(h.closed, []);
  });

  it('상한을 넘는 글의 건수 세기가 실패해도 그 글을 파싱하지 않고 SERVER_ERROR 로 답한다', async () => {
    const h = harness({
      hitRate: async () => {
        throw new Error('store down');
      },
    });
    await h.core.onMessage('c1', `{"action":"ping","id":"p1","pad":"${'x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES)}"}`);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: undefined });
  });

  it('상한과 같은 크기의 글은 받는다', async () => {
    const h = harness();
    const head = '{"action":"ping","id":"p1","pad":"';
    const text = `${head}${'x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES - head.length - 2)}"}`;
    assert.equal(Buffer.byteLength(text), LIMITS.SIGNAL_MAX_MESSAGE_BYTES);
    await h.core.onMessage('c1', text);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'NOT_JOINED', re: 'p1' });
  });

  it('저장소에는 방 ID 와 key 의 해시만 넘긴다', async () => {
    const h = harness();
    await h.core.onMessage('c1', joinText());
    assert.deepEqual(names(h), ['hitRate', 'getPeer', 'putPeer', 'listPeers', 'claimPeer', 'bind']);
    // 판정을 통과하면 판정에 쓴 그 판(쓴 lastSeenAt)을 차지한 뒤 등록한다(검토 1차 SERVER-R1-01).
    assert.deepEqual(h.calls[4], ['claimPeer', ROOM_KEY, 'alice', { connId: 'c1', writtenAt: T0 }]);
    const written = h.calls[2]?.[1] as PeerRecord;
    assert.deepEqual(written, {
      roomKey: ROOM_KEY,
      peer: 'alice',
      connId: 'c1',
      sid: SID_A,
      keyHash: sha256(KEY_A),
      seq: 1,
      lastSeenAt: T0,
    });
    assert.deepEqual(h.calls[2]?.[2], { absent: true });
    assert.deepEqual(h.calls[5], ['bind', 'c1', bound()]);
    const everything = JSON.stringify(h.calls);
    assert.equal(everything.includes(ROOM), false, '방 ID 원문이 저장소로 갔다');
    assert.equal(everything.includes(KEY_A), false, 'key 원문이 저장소로 갔다');
  });

  it('signal 은 대상 기록 하나만 읽는다. 보낸 쪽 기록을 읽지 않고 from 과 sid 는 등록에서 붙인다', async () => {
    const h = harness({
      hitRate: async () => ({ count: 5, binding: bound('alice', SID_A) }),
      getPeer: async () => peerRecord('bob', 'c2'),
    });
    await h.core.onMessage('c1', offerText('bob'));
    assert.deepEqual(h.calls, [
      ['hitRate', 'c1', T0],
      ['getPeer', ROOM_KEY, 'bob'],
    ]);
    assert.deepEqual(h.sent, [
      { connId: 'c2', message: { type: 'signal', from: 'alice', sid: SID_A, kind: 'offer', cid: `${SID_A}.1`, data: { sdp: SDP } } },
    ]);
  });

  it('ping 은 연결 ID 와 "아직 오래되지 않음" 조건으로 lastSeenAt 을 올린 뒤 목록을 읽는다', async () => {
    const h = harness({
      hitRate: async () => ({ count: 2, binding: bound() }),
      listPeers: async () => [peerRecord('alice', 'c1'), peerRecord('bob', 'c2')],
    });
    await h.core.onMessage('c1', encode({ action: 'ping', id: 'p1' }));
    assert.deepEqual(h.calls, [
      ['hitRate', 'c1', T0],
      ['touchPeer', ROOM_KEY, 'alice', { connId: 'c1', seenSince: T0 - LIMITS.PARTICIPANT_STALE_MS }, T0],
      ['listPeers', ROOM_KEY],
    ]);
    assert.deepEqual(h.to('c1'), [{ type: 'pong', re: 'p1', members: [{ peer: 'bob', sid: SID_B }] }]);
  });

  it('ping 의 조건이 맞지 않으면(인계됐거나 지워졌거나 오래됨) 목록을 읽지 않고 NOT_JOINED 다', async () => {
    const h = harness({ hitRate: async () => ({ count: 2, binding: bound() }), touchPeer: async () => false });
    await h.core.onMessage('c1', encode({ action: 'ping', id: 'p1' }));
    assert.deepEqual(names(h), ['hitRate', 'touchPeer']);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'NOT_JOINED', re: 'p1' });
  });

  it('leave 와 종료 통지는 등록을 지우고 참가자 기록을 연결 ID 조건으로 지운다. 응답은 없다', async () => {
    for (const run of ['leave', 'disconnect'] as const) {
      const h = harness({ hitRate: async () => ({ count: 2, binding: bound() }), unbind: async () => bound() });
      if (run === 'leave') await h.core.onMessage('c1', encode({ action: 'leave', id: 'l1' }));
      else await h.core.onDisconnect('c1');
      const tail = h.calls.slice(run === 'leave' ? 1 : 0);
      assert.deepEqual(tail, [
        ['unbind', 'c1'],
        ['deletePeer', ROOM_KEY, 'alice', { connId: 'c1' }],
      ]);
      assert.deepEqual(h.sent, []);
    }
  });

  it('등록이 없는 연결의 종료 통지는 참가자 기록을 건드리지 않는다', async () => {
    const h = harness();
    await h.core.onDisconnect('c9');
    assert.deepEqual(h.calls, [['unbind', 'c9']]);
  });

  it('key 가 같은 기록에는 연결이 열려 있는지 묻지 않는다. key 가 다를 때만 묻는다', async () => {
    const same = harness({ getPeer: async () => peerRecord('alice', 'c0', { keyHash: sha256(KEY_A), seq: 1 }) });
    await same.core.onMessage('c1', joinText({ seq: 2, mode: 'resume' }));
    assert.deepEqual(same.isOpenCalls, []);
    assert.deepEqual(same.calls[2]?.[2], { connId: 'c0', seq: 1 }, '덮어쓰기 조건은 방금 읽은 연결 ID 와 seq 다');

    const other = harness({ getPeer: async () => peerRecord('alice', 'c0') }, { isOpen: async () => false });
    await other.core.onMessage('c1', joinText({ mode: 'resume' }));
    assert.deepEqual(other.isOpenCalls, ['c0']);
    assert.deepEqual(other.calls[2]?.[2], { connId: 'c0', seq: 1 });
    assert.equal(other.to('c1')[0]?.type, 'joined');
  });

  it('오래된 기록은 연결이 열려 있는지 묻지 않고 조건부로 덮어쓴다', async () => {
    const stale = peerRecord('alice', 'c0', { lastSeenAt: T0 - LIMITS.PARTICIPANT_STALE_MS - 1, seq: 7 });
    const h = harness({ getPeer: async () => stale });
    await h.core.onMessage('c1', joinText({ mode: 'resume' }));
    assert.deepEqual(h.isOpenCalls, []);
    assert.deepEqual(h.calls[2]?.[2], { connId: 'c0', seq: 7 });
    assert.equal(h.to('c1')[0]?.type, 'joined');
    assert.deepEqual(h.closed, [], '오래된 기록의 연결을 core 가 닫지 않는다');
  });

  it('사후 판정에 실패하면 이번 처리에서 쓴 기록만 연결 ID 와 쓴 판(lastSeenAt, 차지되지 않음) 조건으로 지운다', async () => {
    const h = harness({ listPeers: async () => [peerRecord('alice', 'c1'), peerRecord('bob', 'c2')] });
    await h.core.onMessage('c1', joinText({ mode: 'create' }));
    assert.deepEqual(names(h), ['hitRate', 'getPeer', 'putPeer', 'listPeers', 'deletePeer']);
    assert.deepEqual(h.calls[4], ['deletePeer', ROOM_KEY, 'alice', { connId: 'c1', writtenAt: T0 }]);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'ROOM_EXISTS', re: 'j1' });
  });

  it('(검토 1차 SERVER-R1-01) 판정을 통과했는데 그 판을 차지하지 못하면(다른 처리가 지웠다) 등록하지 않고 SERVER_ERROR 다', async () => {
    const h = harness({ claimPeer: async () => false });
    await h.core.onMessage('c1', joinText({ mode: 'create' }));
    assert.deepEqual(names(h), ['hitRate', 'getPeer', 'putPeer', 'listPeers', 'claimPeer']);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: 'j1' });
    assert.equal(h.to('c1').some((message) => message.type === 'joined'), false);
    assert.equal(h.logs.some((entry) => entry.event === 'conn.join' && entry.fields['reason'] === 'record_changed'), true);
  });

  it('앞선 처리가 남긴 자기 기록(key·seq·연결 ID 가 같다)은 다시 쓰지 않는다. 판정에 실패하면 읽은 판(차지되지 않음) 조건으로 지운다(검토 2차 SERVER-R2-01)', async () => {
    const mine = peerRecord('alice', 'c1', { keyHash: sha256(KEY_A), seq: 1, sid: SID_A });
    const pass = harness({ getPeer: async () => mine, listPeers: async () => [mine] });
    await pass.core.onMessage('c1', joinText({ mode: 'create' }));
    assert.deepEqual(names(pass), ['hitRate', 'getPeer', 'listPeers', 'claimPeer', 'bind']);
    assert.deepEqual(pass.calls[3], ['claimPeer', ROOM_KEY, 'alice', { connId: 'c1', writtenAt: mine.lastSeenAt }], '읽은 판을 차지한다');
    assert.equal(pass.to('c1')[0]?.type, 'joined');

    // 앞선 처리가 쓰고 등록 전에 끊긴 기록이다. 지우지 않으면 실패를 받은 연결의 기록이 정원에 남는다.
    const failing = harness({ getPeer: async () => mine, listPeers: async () => [mine, peerRecord('bob', 'c2')] });
    await failing.core.onMessage('c1', joinText({ mode: 'create' }));
    assert.deepEqual(names(failing), ['hitRate', 'getPeer', 'listPeers', 'deletePeer']);
    assert.deepEqual(failing.calls[3], ['deletePeer', ROOM_KEY, 'alice', { connId: 'c1', writtenAt: mine.lastSeenAt }]);
    assert.deepEqual(errorOf(failing.to('c1')[0]), { code: 'ROOM_EXISTS', re: 'j1' });
  });

  it('(검토 2차 SERVER-R2-01) 판정에 실패했지만 그 판을 지우지 못했고 기록이 아직 이 연결이면(같은 join 의 다른 처리가 차지했다) 실패 코드를 보내지 않는다', async () => {
    const mine = peerRecord('alice', 'c1', { keyHash: sha256(KEY_A), seq: 1, sid: SID_A });
    for (const mode of ['create', 'join'] as const) {
      const others = mode === 'create' ? [mine, peerRecord('bob', 'c2')] : [mine];
      const h = harness({ getPeer: async () => mine, listPeers: async () => others, deletePeer: async () => false });
      await h.core.onMessage('c1', joinText({ mode }));
      assert.deepEqual(names(h), ['hitRate', 'getPeer', 'listPeers', 'deletePeer', 'getPeer'], mode);
      assert.deepEqual(h.sent, [], `${mode}: 차지한 처리가 joined 를 보낸다. 반대 답을 함께 보내지 않는다`);
      assert.equal(names(h).includes('bumpJoinMiss'), false, `${mode}: 없는 방 입장 횟수를 올리지 않는다`);
      assert.equal(
        h.logs.some((entry) => entry.event === 'conn.join' && entry.fields['outcome'] === 'superseded'),
        true,
        `${mode}: 로그는 남긴다`,
      );
    }
  });

  it('(검토 3차 SERVER-R3-01) 등록 없이 남은 자기 기록이 차지돼 있으면(앞선 처리가 판정을 통과한 뒤 등록 전에 실패) 다시 판정하지 않고 등록해 joined 로 답한다', async () => {
    const mine = { ...peerRecord('alice', 'c1', { keyHash: sha256(KEY_A), seq: 1, sid: SID_A }), claimed: true as const };
    // 그 사이 다른 참가자가 들어왔다. 다시 판정하면 create 는 ROOM_EXISTS 다.
    const h = harness({ getPeer: async () => mine, listPeers: async () => [mine, peerRecord('bob', 'c2')] });
    await h.core.onMessage('c1', joinText({ mode: 'create' }));
    assert.deepEqual(names(h), ['hitRate', 'getPeer', 'listPeers', 'bind']);
    assert.deepEqual(h.calls[3], ['bind', 'c1', { roomKey: ROOM_KEY, peer: 'alice', sid: SID_A }]);
    const reply = h.to('c1');
    assert.equal(reply.length, 1);
    assert.equal(reply[0]?.type, 'joined');
    assert.deepEqual(reply[0]?.type === 'joined' ? reply[0].members.map((member) => member.peer) : null, ['bob']);
    const join = h.logs.find((entry) => entry.event === 'conn.join');
    assert.deepEqual([join?.fields['outcome'], join?.fields['cause']], ['joined', 'claimed']);
  });

  it('(검토 3차 SERVER-R3-01) 판정에 실패해 지우지 못했고 다시 읽은 기록이 이 연결·이 join 이며 차지돼 있으면, 이 처리가 등록하고 joined 로 답한다', async () => {
    const mine = peerRecord('alice', 'c1', { keyHash: sha256(KEY_A), seq: 1, sid: SID_A });
    for (const mode of ['create', 'join'] as const) {
      let reads = 0;
      const others = mode === 'create' ? [mine, peerRecord('bob', 'c2')] : [mine];
      const h = harness({
        getPeer: async () => {
          reads += 1;
          return reads === 1 ? mine : { ...mine, claimed: true as const };
        },
        listPeers: async () => others,
        deletePeer: async () => false,
      });
      await h.core.onMessage('c1', joinText({ mode }));
      assert.deepEqual(names(h), ['hitRate', 'getPeer', 'listPeers', 'deletePeer', 'getPeer', 'bind'], mode);
      assert.deepEqual(h.to('c1').map((message) => message.type), ['joined'], `${mode}: 반대 답을 보내지 않고 joined 하나다`);
      assert.equal(names(h).includes('bumpJoinMiss'), false);
      assert.equal(h.logs.some((entry) => entry.event === 'conn.join' && entry.fields['outcome'] === 'joined' && entry.fields['cause'] === 'claimed'), true, mode);
    }
  });

  it('(검토 2차 SERVER-R2-01) 판정에 실패했고 지우지 못했는데 기록이 다른 연결이거나 없으면 실패 코드를 보낸다', async () => {
    for (const after of [null, peerRecord('alice', 'c9', { keyHash: sha256(KEY_A), seq: 2 })]) {
      let reads = 0;
      const h = harness({
        getPeer: async () => {
          reads += 1;
          return reads === 1 ? null : after;
        },
        listPeers: async () => [peerRecord('bob', 'c2')],
        deletePeer: async () => false,
      });
      await h.core.onMessage('c1', joinText({ mode: 'create' }));
      assert.deepEqual(names(h), ['hitRate', 'getPeer', 'putPeer', 'listPeers', 'deletePeer', 'getPeer']);
      assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'ROOM_EXISTS', re: 'j1' }, `뒤에 읽은 기록: ${after?.connId ?? 'null'}`);
    }
  });

  it('(검토 2차 SERVER-R2-02) 등록한 뒤 joined 전송이 "연결 없음"이면 등록과 기록을 지우고 outcome=gone 으로 남긴다', async () => {
    const h = harness({}, { send: async () => 'gone' });
    await h.core.onMessage('c1', joinText());
    assert.deepEqual(names(h), ['hitRate', 'getPeer', 'putPeer', 'listPeers', 'claimPeer', 'bind', 'unbind', 'deletePeer']);
    assert.deepEqual(h.calls.at(-2), ['unbind', 'c1']);
    // 연결 ID 조건이다. 그 사이 다른 연결에 인계된 새 기록은 지우지 못한다.
    assert.deepEqual(h.calls.at(-1), ['deletePeer', ROOM_KEY, 'alice', { connId: 'c1' }]);
    const join = h.logs.find((entry) => entry.event === 'conn.join');
    assert.equal(join?.fields['outcome'], 'gone');
  });

  it('조건부 쓰기에서 지면 기록을 다시 읽어 평가한다', async () => {
    let reads = 0;
    const h = harness({
      getPeer: async () => {
        reads += 1;
        // 처음엔 없었고, 그 사이 다른 연결이 같은 이름으로 썼다.
        return reads === 1 ? null : peerRecord('alice', 'c0');
      },
      putPeer: async () => false,
    });
    await h.core.onMessage('c1', joinText({ mode: 'join' }));
    assert.deepEqual(names(h), ['hitRate', 'getPeer', 'putPeer', 'getPeer']);
    assert.deepEqual(h.isOpenCalls, ['c0']);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'NAME_IN_USE', re: 'j1' });
  });

  it('조건부 쓰기에서 계속 지면 끝없이 돌지 않고 SERVER_ERROR 로 답한다', async () => {
    const h = harness({ putPeer: async () => false });
    await h.core.onMessage('c1', joinText());
    assert.equal(names(h).filter((name) => name === 'putPeer').length, 4);
    assert.equal(names(h).includes('bind'), false);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: 'j1' });
  });
});

describe('V-U2 signaling-core: 포트가 실패할 때', () => {
  const failing = async (): Promise<never> => {
    throw new Error(`store exploded with ${ROOM}`);
  };

  it('속도 제한 계수가 실패하면 그 요청의 SERVER_ERROR 로 답하고 reject 하지 않는다', async () => {
    const h = harness({ hitRate: failing });
    await h.core.onMessage('c1', joinText());
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: 'j1' });
    assert.equal(h.logs.some((entry) => entry.level === 'error'), true);
  });

  it('join 도중의 저장소 실패(읽기, 쓰기, 목록, 등록)는 모두 SERVER_ERROR 다', async () => {
    for (const name of ['getPeer', 'putPeer', 'listPeers', 'bind'] as const) {
      const h = harness({ [name]: failing });
      await h.core.onMessage('c1', joinText());
      assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: 'j1' }, name);
      assert.equal(h.to('c1').length, 1, name);
    }
  });

  it('ping 과 signal 도중의 저장소 실패도 그 요청의 SERVER_ERROR 다', async () => {
    const ping = harness({ hitRate: async () => ({ count: 1, binding: bound() }), touchPeer: failing });
    await ping.core.onMessage('c1', encode({ action: 'ping', id: 'p1' }));
    assert.deepEqual(errorOf(ping.to('c1')[0]), { code: 'SERVER_ERROR', re: 'p1' });

    const signal = harness({ hitRate: async () => ({ count: 1, binding: bound() }), getPeer: failing });
    await signal.core.onMessage('c1', offerText());
    assert.deepEqual(errorOf(signal.to('c1')[0]), { code: 'SERVER_ERROR', re: 's1' });
  });

  it('종료 통지 처리의 저장소 실패는 로그만 남기고 reject 하지 않는다', async () => {
    const h = harness({ unbind: failing });
    await h.core.onDisconnect('c1');
    assert.deepEqual(h.sent, []);
    assert.equal(h.logs.some((entry) => entry.level === 'error' && entry.event === 'disconnect.failed'), true);
  });

  it('대상으로의 전송이 "연결 없음"이면 그 기록을 연결 ID 조건으로 지우고 PEER_NOT_FOUND 다', async () => {
    const h = harness(
      { hitRate: async () => ({ count: 1, binding: bound() }), getPeer: async () => peerRecord('bob', 'c2') },
      { send: async (connId) => (connId === 'c2' ? 'gone' : 'ok') },
    );
    await h.core.onMessage('c1', offerText('bob'));
    assert.deepEqual(h.calls[2], ['deletePeer', ROOM_KEY, 'bob', { connId: 'c2' }]);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'PEER_NOT_FOUND', re: 's1' });
  });

  it('대상으로의 전송이 그 밖의 이유로 실패하면 기록을 지우지 않고 SERVER_ERROR 다', async () => {
    const h = harness(
      { hitRate: async () => ({ count: 1, binding: bound() }), getPeer: async () => peerRecord('bob', 'c2') },
      {
        send: async (connId) => {
          if (connId === 'c2') throw new Error('transport down');
          return 'ok';
        },
      },
    );
    await h.core.onMessage('c1', offerText('bob'));
    assert.equal(names(h).includes('deletePeer'), false);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: 's1' });
  });

  it('(검토 1차 SERVER-R1-03) 대상으로의 전송이 스로틀에 걸리면(throttled) 기록을 지우지 않고 보낸 쪽에 SERVER_ERROR 도 보내지 않는다', async () => {
    const posted: string[] = [];
    const h = harness(
      { hitRate: async () => ({ count: 1, binding: bound() }), getPeer: async () => peerRecord('bob', 'c2') },
      {
        send: async (connId) => {
          posted.push(connId);
          return connId === 'c2' ? 'throttled' : 'ok';
        },
      },
    );
    await h.core.onMessage('c1', offerText('bob'));
    assert.deepEqual(posted, ['c2'], '스로틀 중에 오류 응답으로 요구량을 더 늘리지 않는다. 보낸 쪽은 3초 뒤 같은 signal 을 다시 보낸다');
    assert.equal(names(h).includes('deletePeer'), false);
    assert.deepEqual(h.to('c1'), []);
    assert.equal(h.logs.some((entry) => entry.event === 'relay' && entry.fields['outcome'] === 'throttled'), true);
  });

  it('(검토 1차 SERVER-R1-03) 응답(joined·pong·error)이 스로틀에 걸려도 그 요청에 다른 글을 또 보내지 않는다', async () => {
    const posted: string[] = [];
    const h = harness({}, { send: async (connId) => (posted.push(connId), 'throttled') });
    await h.core.onMessage('c1', joinText());
    assert.deepEqual(posted, ['c1'], 'joined 하나만 보내 본다');
    assert.equal(h.logs.some((entry) => entry.event === 'conn.join' && entry.fields['outcome'] === 'joined' && entry.fields['reason'] === 'throttled'), true);
  });

  it('응답 전송의 실패는 무시한다(상대가 이미 없다). "연결 없음"이 아닌 실패에는 등록을 지우지 않는다', async () => {
    for (const send of [failing as unknown as ConnectionSink['send']]) {
      const h = harness({}, { send });
      await h.core.onMessage('c1', joinText());
      await h.core.onMessage('c1', 'not json');
      assert.deepEqual(h.sent, []);
      assert.equal(names(h).includes('bind'), true, '등록은 끝났다');
      assert.equal(names(h).includes('unbind'), false, '연결이 없다는 증거가 없으면 등록을 지우지 않는다');
    }
  });

  it('인계할 때 옛 연결에 REPLACED 를 보내고 닫는다. 그 전송과 닫기가 실패해도 새 연결은 등록된다', async () => {
    const h = harness(
      { getPeer: async () => peerRecord('alice', 'c0', { keyHash: sha256(KEY_A), seq: 1 }) },
      {
        send: async (connId) => {
          if (connId === 'c0') throw new Error('old socket broken');
          return 'ok';
        },
        close: async () => {
          throw new Error('close failed');
        },
      },
    );
    await h.core.onMessage('c1', joinText({ seq: 2, mode: 'resume' }));
    assert.deepEqual(h.closed, ['c0']);
    assert.equal(h.to('c1')[0]?.type, 'joined');
    assert.equal(names(h).includes('bind'), true);
  });
});

describe('V-U2 signaling-core: 스키마에 맞지 않는 글을 만들었을 때(규칙 코드의 결함)', () => {
  const broken = peerRecord('not a valid name!', 'c2', { sid: 'BAD' });

  it('joined 를 만들 수 없으면 그 글을 보내지 않고 join 의 SERVER_ERROR 로 답한다', async () => {
    const h = harness({ listPeers: async () => [broken, peerRecord('carol', 'c3')] });
    await h.core.onMessage('c1', joinText({ mode: 'join' }));
    assert.deepEqual(h.to('c1'), [{ type: 'error', code: 'SERVER_ERROR', message: 'internal server error', re: 'j1' }]);
    assert.equal(h.logs.some((entry) => entry.level === 'error' && entry.event === 'send.invalid'), true);
  });

  it('pong 을 만들 수 없으면 ping 의 SERVER_ERROR 로 답한다', async () => {
    const h = harness({ hitRate: async () => ({ count: 1, binding: bound() }), listPeers: async () => [broken] });
    await h.core.onMessage('c1', encode({ action: 'ping', id: 'p1' }));
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: 'p1' });
    assert.equal(h.to('c1').length, 1);
  });

  it('전달할 signal 을 만들 수 없으면 대상에 보내지 않고 보낸 쪽에 그 signal 의 SERVER_ERROR 로 답한다', async () => {
    const h = harness({
      hitRate: async () => ({ count: 1, binding: bound('alice', 'BAD-SID') }),
      getPeer: async () => peerRecord('bob', 'c2'),
    });
    await h.core.onMessage('c1', offerText('bob'));
    assert.deepEqual(h.to('c2'), []);
    assert.deepEqual(errorOf(h.to('c1')[0]), { code: 'SERVER_ERROR', re: 's1' });
    assert.equal(names(h).includes('deletePeer'), false);
  });
});

describe('V-U2 signaling-core: 진단 로그', () => {
  it('방 ID, 참가자 이름, key, SDP, 연결 ID 의 원문을 남기지 않는다', async () => {
    const h = harness({
      getPeer: async (_room, peer) => (peer === 'bob' ? peerRecord('bob', 'conn-raw-2') : null),
    });
    await h.core.onMessage('conn-raw-1', joinText());
    await h.core.onMessage('conn-raw-1', 'garbage');
    const joined = harness({
      hitRate: async () => ({ count: 1, binding: bound() }),
      getPeer: async () => peerRecord('bob', 'conn-raw-2'),
      unbind: async () => bound(),
    });
    await joined.core.onMessage('conn-raw-1', offerText('bob'));
    await joined.core.onMessage('conn-raw-1', offerText('alice'));
    await joined.core.onMessage('conn-raw-1', encode({ action: 'leave', id: 'l1' }));
    await joined.core.onDisconnect('conn-raw-1');

    const lines = JSON.stringify([...h.logs, ...joined.logs]);
    for (const secret of [ROOM, KEY_A, 'marker-sdp-body', 'conn-raw-1', 'conn-raw-2', ROOM_KEY, '"alice"', '"bob"']) {
      assert.equal(lines.includes(secret), false, `로그에 원문이 남았다: ${secret}`);
    }
    const events = [...h.logs, ...joined.logs].map((entry) => entry.event);
    for (const expected of ['conn.join', 'conn.rejected', 'relay', 'conn.closed']) {
      assert.equal(events.includes(expected), true, `${expected} 사건이 없다`);
    }
    const join = h.logs.find((entry) => entry.event === 'conn.join');
    assert.equal(join?.fields.room_ref, ROOM_KEY.slice(0, 12), 'room_ref 는 방 키와 같은 해시의 앞 12자리다');
    assert.equal(join?.fields.peer_ref, sha256('alice').slice(0, 12));
    assert.equal(join?.fields.conn_ref, sha256('conn-raw-1').slice(0, 12));
  });
});
