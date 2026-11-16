// V-U12 의 관전자 처리 기준 1~14 (verification-plan.md 3.1, protocol.md 4.6, architecture.md 3.10 의 관전 모드).
// "관전 쪽"은 observe 로 들어간 room-session, "참가자 쪽"은 참가자 모드의 room-session 이다. 하위 모듈은 가짜다(testing.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../protocol/index.js';
import type { P2PFrame, StateRecord } from '../protocol/index.js';
import type { InboxEvent } from '../inbox/contract.js';
import type { RoomObserved, SessionResult, SessionStatus } from './contract.js';
import { createObserverBook } from './observers.js';
import type { FakeMesh, ScriptedPeer, SessionUnderTest, TestBed } from './testing.js';
import {
  MIN,
  ROOM,
  SEC,
  claimRecordOf,
  createTestBed,
  enterRoom,
  presenceRecord,
  scenarioRecordOf,
  sidOf,
  testRecordOf,
} from './testing.js';

const OBS = 'obs-o';

function statusOf(sut: SessionUnderTest): SessionStatus {
  const status = sut.session.status();
  assert.ok(status.ok);
  return status;
}

const codeOf = (result: { ok: boolean; code?: string }): string => (result.ok ? 'ok' : (result.code ?? ''));

/** 관전 쪽: 그 피어들이 있는 방에 observe 로 들어간다. 피어마다 링크를 열고 hello·스냅샷·sync_end 를 넣는다. */
async function observeRoom(
  bed: TestBed,
  sut: SessionUnderTest,
  name: string,
  peers: readonly string[],
  options: {
    hello?: (peer: string) => Record<string, unknown>;
    records?: (peer: string) => readonly StateRecord[];
    end?: (peer: string) => Record<string, unknown>;
  } = {},
): Promise<{ result: SessionResult<RoomObserved>; remotes: Map<string, ScriptedPeer>; mesh: FakeMesh }> {
  for (const peer of peers) bed.net.register(ROOM, peer, sidOf(peer));
  const entering = sut.session.observe({ room_id: ROOM, name });
  await bed.settle();
  const remotes = new Map<string, ScriptedPeer>();
  for (const peer of peers) {
    const remote = bed.remote(name, peer);
    remote.open().hello(options.hello?.(peer) ?? {});
    const records = options.records?.(peer) ?? [presenceRecord(peer, bed.clock.now() - SEC, { status: 'ready', listening: true })];
    if (records.length > 0) remote.state(records, true);
    remote.syncEnd({ count: records.length, ...(options.end?.(peer) ?? {}) });
    remotes.set(peer, remote);
  }
  await bed.settle();
  const result = await entering;
  const mesh = bed.net.meshOf(name);
  assert.ok(mesh);
  return { result, remotes, mesh };
}

/** 참가자 쪽: 들어간 뒤 관전자 하나와 링크를 열고 첫 동기화를 끝낸다. */
function openObserver(bed: TestBed, self: string, observer = OBS, sid = sidOf(observer)): ScriptedPeer {
  const remote = bed.remote(self, observer, sid);
  remote.open().hello({ observer: true });
  remote.syncEnd();
  return remote;
}

/** 관전 쪽이 보낸 프레임이 읽기만 하는 것인가(채팅과 변경이 없다). */
function onlyReadFrames(frames: readonly P2PFrame[]): boolean {
  return frames.every((frame) => frame.t !== 'chat' && !(frame.t === 'state' && frame.snap !== true));
}

const peerEvents = (events: readonly InboxEvent[], change: string): InboxEvent[] =>
  events.filter((event) => event.kind === 'peer' && event.change === change);

describe('V-U12 관전 쪽 (observe)', () => {
  it('1: join(mode=join) 으로 들어가 hello 에 observer: true 를 싣는다. 결과에 방 ID 가 없다. 채팅과 변경을 보내지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    const { result, remotes } = await observeRoom(bed, me, 'zz-watch', ['A', 'B']);
    assert.ok(result.ok, codeOf(result));
    assert.equal(bed.net.joins[0]?.mode, 'join');
    for (const remote of remotes.values()) {
      const hello = remote.frames().find((frame) => frame.t === 'hello');
      assert.ok(hello?.t === 'hello');
      assert.equal(hello.observer, true);
    }
    assert.equal('room_id' in result, false);
    assert.equal(JSON.stringify(result).includes(ROOM), false, '요약 어디에도 방 ID 가 없다');
    assert.deepEqual(
      result.participants.map((participant) => [participant.name, participant.shown_as]),
      [
        ['A', 'ready'],
        ['B', 'ready'],
      ],
    );
    assert.deepEqual(result.observers, []);
    assert.deepEqual(result.unaware, []);
    assert.equal(result.name, 'zz-watch');
    assert.equal(result.server, 'ws://127.0.0.1:8787');

    // 들어간 뒤: 채팅을 받고, ping 을 받고, 상대가 상태를 바꿔도 관전 쪽은 읽기 프레임만 보낸다.
    const a = remotes.get('A') as ScriptedPeer;
    a.chat(`${sidOf('A')}-1`, '안녕');
    a.state([presenceRecord('A', bed.clock.now() + 5, { status: 'working' })]);
    a.ping(99, '0123456789ab');
    await bed.settle();
    for (const remote of remotes.values()) {
      const frames = remote.frames();
      assert.ok(onlyReadFrames(frames), `${remote.name}: ${frames.map((frame) => frame.t).join(',')}`);
      assert.ok(frames.every((frame) => ['hello', 'state', 'sync_end', 'ack', 'ping', 'pong', 'bye'].includes(frame.t)));
    }
    assert.equal(me.records.transcripts.length, 0, '기록 파일을 열지 않는다');
  });

  it('2: 기한이 지나도 stop{time_limit} 을 쓰지 않는다. presence 를 쓰지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    const testId = `${sidOf('A')}-1`;
    const { result, remotes } = await observeRoom(bed, me, 'zz-watch', ['A'], {
      records: () => [
        presenceRecord('A', bed.clock.now() - SEC, { status: 'ready', listening: true }),
        testRecordOf('A', bed.clock.now(), testId, { max_duration_min: 60 }),
      ],
      end: () => ({ test_id: testId, test_elapsed_ms: 0 }),
    });
    assert.ok(result.ok);
    assert.equal(result.test?.test_id, testId);
    await bed.clock.advance(61 * MIN);
    const a = remotes.get('A') as ScriptedPeer;
    assert.ok(onlyReadFrames(a.frames()));
    const authored = me.replica().snapshot().filter((record) => record.author === 'zz-watch');
    assert.deepEqual(authored, [], '관전자가 쓴 기록(presence, stop)이 없다');
    assert.equal(me.records.transcripts.length, 0);
    assert.equal(me.log.named('test.stopped').length, 0);
  });

  it('3: command(종류마다), writeReport, ping 은 NOT_IN_ROOM(observing read-only)이고 아무 것도 보내지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    const { remotes } = await observeRoom(bed, me, 'zz-watch', ['A']);
    const a = remotes.get('A') as ScriptedPeer;
    a.take();
    const results = [
      await me.session.ping({ timeoutMs: 1000 }),
      await me.session.command({ type: 'set_status', status: 'ready' }),
      await me.session.command({ type: 'stop_test', reason: 'x' }),
      await me.session.command({ type: 'start_test', request: 'x', max_duration_min: 60, max_scenarios: 20 }),
      await me.session.command({ type: 'start_scenario', title: 'x' }),
      await me.session.command({ type: 'record_claim', scenario_id: `${sidOf('A')}-2`, action: 'a', observed: 'o', outcome: 'pass', steps: 's' }),
      await me.session.command({ type: 'record_verification', claim_id: `${sidOf('A')}-3`, result: 'confirmed', evidence: 'e' }),
      await me.session.writeReport(),
    ];
    for (const result of results) {
      assert.equal(codeOf(result), 'NOT_IN_ROOM');
      assert.equal(result.ok ? '' : result.detail, 'observing read-only');
    }
    await bed.settle();
    assert.deepEqual(a.take(), []);
    // 상태 보기는 된다.
    const observed = me.session.observed();
    assert.ok(observed.ok);
    assert.equal(statusOf(me).participants.length, 1);
  });

  it('3-1: 관전자도 채팅은 보낸다(사람이 관전 콘솔에서 지시한다). 공유 상태에는 쓰지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    const { remotes } = await observeRoom(bed, me, 'zz-watch', ['A']);
    const a = remotes.get('A') as ScriptedPeer;
    a.take();
    const sending = me.session.sendChat({ text: '다음 시나리오를 시작해 줘' });
    await bed.settle();
    const frames = a.take();
    assert.deepEqual(frames.map((frame) => frame.t), ['chat']);
    const chat = frames[0];
    assert.ok(chat?.t === 'chat');
    a.ack(chat.id);
    const result = await sending;
    assert.ok(result.ok);
    assert.deepEqual(result.delivered, ['A']);
  });

  it('4: 방 전체 글과 나를 지정한 글은 ack 하고 사건으로 넣는다. 남을 지정한 글은 버린다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    const { remotes } = await observeRoom(bed, me, 'zz-watch', ['A', 'B']);
    const a = remotes.get('A') as ScriptedPeer;
    a.take();
    a.chat(`${sidOf('A')}-1`, '방 전체');
    a.chat(`${sidOf('A')}-2`, '관전자에게', ['zz-watch']);
    a.chat(`${sidOf('A')}-3`, 'B 에게만', ['B']);
    await bed.settle();
    const chats = me.inbox.pushed.filter((event) => event.kind === 'chat');
    assert.deepEqual(
      chats.map((event) => [event.id, event.to, event.text]),
      [
        [`${sidOf('A')}-1`, 'room', '방 전체'],
        [`${sidOf('A')}-2`, 'you', '관전자에게'],
      ],
    );
    const acks = a.take().filter((frame) => frame.t === 'ack');
    assert.deepEqual(acks.map((frame) => (frame.t === 'ack' ? frame.id : '')), [`${sidOf('A')}-1`, `${sidOf('A')}-2`]);
  });

  it('5: 상대의 status 가 joined → working → ready 로 바뀌면 status 사건 둘, ready 사건 하나. 참가자 쪽은 ready 하나뿐이다', async () => {
    const run = async (observer: boolean): Promise<InboxEvent[]> => {
      const bed = createTestBed();
      const me = bed.session({ name: 'zz-watch' });
      const joined = (peer: string): StateRecord[] => [presenceRecord(peer, bed.clock.now() - SEC, { status: 'joined', listening: true })];
      let a: ScriptedPeer;
      if (observer) {
        const { remotes } = await observeRoom(bed, me, 'zz-watch', ['A'], { records: joined });
        a = remotes.get('A') as ScriptedPeer;
      } else {
        const room = await enterRoom(bed, me, 'zz-watch', ['A'], { records: joined });
        a = room.remote('A');
      }
      const before = me.inbox.pushed.length;
      a.state([presenceRecord('A', bed.clock.now() + 1, { status: 'working', listening: true })]);
      a.state([presenceRecord('A', bed.clock.now() + 2, { status: 'ready', listening: true })]);
      await bed.settle();
      return me.inbox.pushed.slice(before);
    };
    const watching = await run(true);
    assert.deepEqual(
      watching.map((event) => [event.kind, event.change, event.kind === 'peer' ? event.data.status : null]),
      [
        ['peer', 'status', 'working'],
        ['peer', 'status', 'ready'],
        ['peer', 'ready', 'ready'],
      ],
    );
    const participating = await run(false);
    assert.deepEqual(
      participating.map((event) => [event.kind, event.change]),
      [['peer', 'ready']],
    );
  });

  it('6: hello 에 observer 가 없는 상대(구버전)는 그 상대마다 observer_unaware 한 번이고 요약의 unaware 에 실린다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    const { result, remotes, mesh } = await observeRoom(bed, me, 'zz-watch', ['A', 'B'], {
      hello: (peer) => (peer === 'B' ? { observer: undefined } : {}),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.unaware, ['B']);
    // 링크가 다시 열려도 되풀이하지 않는다.
    mesh.dropLink('B', 'ping_timeout');
    const again = bed.remote('zz-watch', 'B');
    again.open().hello({ observer: undefined });
    again.syncEnd();
    await bed.settle();
    const unaware = me.inbox.pushed.filter((event) => event.kind === 'system' && event.data.code === 'observer_unaware');
    assert.equal(unaware.length, 1);
    assert.deepEqual(unaware[0]?.data, { peer: 'B', code: 'observer_unaware' });
    assert.ok(remotes.get('A'));
  });

  it('6: 참가자 쪽은 observer 가 없는 상대를 보통 참가자로 다룬다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    for (const peer of ['A']) bed.net.register(ROOM, peer, sidOf(peer));
    const entering = me.session.join({ room_id: ROOM, name: 'alpha' });
    await bed.settle();
    const a = bed.remote('alpha', 'A');
    a.open().hello({ observer: undefined });
    a.state([presenceRecord('A', bed.clock.now() - SEC, { status: 'ready', listening: true })], true);
    a.syncEnd({ count: 1 });
    await bed.settle();
    const entered = await entering;
    assert.ok(entered.ok);
    assert.deepEqual(entered.observers, []);
    assert.deepEqual(statusOf(me).participants.map((participant) => [participant.name, participant.shown_as]), [['A', 'ready']]);
    assert.equal(me.inbox.pushed.some((event) => event.kind === 'system' && event.data.code === 'observer_unaware'), false);
  });

  it('입장 중의 사건과 실패: 필수 피어가 동기화되지 않으면 join 과 같이 실패하고 남기지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    bed.net.register(ROOM, 'A', sidOf('A'));
    const entering = me.session.observe({ room_id: ROOM, name: 'zz-watch' });
    await bed.settle();
    await bed.clock.advance(LIMITS.JOIN_MESH_TIMEOUT_MS + SEC);
    const result = await entering;
    assert.equal(codeOf(result), 'DIRECT_CONNECT_FAILED');
    assert.equal(codeOf(me.session.observed()), 'NOT_IN_ROOM');
    assert.equal(me.records.transcripts.length, 0);
  });

  it('종료와 퇴장: bye 를 보내고 presence{left} 를 쓰지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'zz-watch' });
    const { remotes } = await observeRoom(bed, me, 'zz-watch', ['A']);
    const a = remotes.get('A') as ScriptedPeer;
    a.take();
    await me.session.shutdown(1500);
    const frames = a.take();
    assert.deepEqual(frames.map((frame) => frame.t), ['bye']);
    assert.ok(frames[0]?.t === 'bye' && frames[0].reason === 'shutdown');

    const bed2 = createTestBed();
    const me2 = bed2.session({ name: 'zz-watch' });
    const second = await observeRoom(bed2, me2, 'zz-watch', ['A']);
    const a2 = second.remotes.get('A') as ScriptedPeer;
    a2.take();
    const left = await me2.session.leave();
    assert.ok(left.ok);
    assert.equal(left.transcript_path, null);
    assert.deepEqual(a2.take().map((frame) => frame.t), ['bye']);
  });
});

describe('V-U12 참가자 쪽의 관전자 처리', () => {
  /** A 의 스냅샷에 테스트·시나리오·주장(A 의 것)을 넣어 waiting_for_you 가 생기게 한다. */
  const roomWithClaim = (bed: TestBed) => (peer: string): StateRecord[] => {
    const now = bed.clock.now();
    const presence = presenceRecord(peer, now - SEC, { status: 'ready', listening: true });
    if (peer !== 'A') return [presence];
    const testId = `${sidOf('A')}-1`;
    const scenario = scenarioRecordOf('A', now - 900, `${sidOf('A')}-2`, testId, '손들기');
    return [presence, testRecordOf('A', now - 950, testId), scenario, claimRecordOf('A', now - 800, `${sidOf('A')}-3`, testId, scenario.rid)];
  };

  it('7: 관전자 링크가 동기화되면 observer_joined 한 번. participants 에 없고 observers 에 있다. 다른 참가자의 표시는 그대로다', async () => {
    const make = async (withObserver: boolean): Promise<{ me: SessionUnderTest; bed: TestBed }> => {
      const bed = createTestBed();
      const me = bed.session({ name: 'alpha' });
      const room = await enterRoom(bed, me, 'alpha', ['A', 'B'], { records: roomWithClaim(bed) });
      const members = [
        { peer: 'A', sid: sidOf('A') },
        { peer: 'B', sid: sidOf('B') },
      ];
      if (withObserver) {
        room.client.emitMembers([...members, { peer: OBS, sid: sidOf(OBS) }]);
        openObserver(bed, 'alpha');
      } else {
        room.client.emitMembers(members);
      }
      await bed.settle();
      return { me, bed };
    };
    const watched = await make(true);
    const plain = await make(false);
    const joined = peerEvents(watched.me.inbox.pushed, 'observer_joined');
    assert.equal(joined.length, 1);
    assert.equal(joined[0]?.from, OBS);
    const status = statusOf(watched.me);
    assert.deepEqual(status.observers, [{ name: OBS, link: 'open', since: new Date(watched.bed.clock.now()).toISOString() }]);
    assert.equal(status.participants.some((participant) => participant.name === OBS), false);
    const other = statusOf(plain.me);
    assert.deepEqual(status.participants, other.participants);
    assert.deepEqual(status.claims.waiting_for_you, other.claims.waiting_for_you);
    assert.equal(status.claims.waiting_for_you.length, 1);
    assert.deepEqual(status.warnings, other.warnings);
    assert.deepEqual(watched.me.session.notice(), plain.me.session.notice());
    // 관전 요약도 같은 규칙이다. 방 ID 가 없다.
    const observed = watched.me.session.observed();
    assert.ok(observed.ok);
    assert.deepEqual(observed.observers, status.observers);
    assert.equal(JSON.stringify(observed).includes(ROOM), false);
    // 기록 파일의 peer 줄에 남는다.
    assert.ok(watched.me.records.last.entries.some((entry) => entry.kind === 'peer' && entry.change === 'observer_joined' && entry.name === OBS));
  });

  it('8: 관전자 링크의 chat 은 ack 하고 data.observer 가 참인 chat 사건으로 넣는다. 잘못된 프레임으로 세지 않는다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    await enterRoom(bed, me, 'alpha', ['A']);
    const o = openObserver(bed, 'alpha');
    await bed.settle();
    o.take();
    const before = me.inbox.pushed.length;
    o.chat(`${sidOf(OBS)}-1`, '관전자의 지시');
    await bed.settle();
    const chats = me.inbox.pushed.slice(before).filter((event) => event.kind === 'chat');
    assert.equal(chats.length, 1);
    assert.deepEqual([chats[0]?.from, chats[0]?.text, chats[0]?.data], [OBS, '관전자의 지시', { observer: true }]);
    assert.deepEqual(o.take().filter((frame) => frame.t === 'ack').length, 1);
    assert.deepEqual(me.log.named('p2p.bad_frame'), []);
    assert.ok(me.records.last.entries.some((entry) => entry.kind === 'chat_in' && entry.from === OBS));
  });

  it('9: 관전자 링크의 변경 state 는 버리고 잘못된 프레임(observer_write)으로 센다. 복제본과 지문이 그대로다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    await enterRoom(bed, me, 'alpha', ['A']);
    const o = openObserver(bed, 'alpha');
    await bed.settle();
    const fingerprint = me.replica().fingerprint();
    const records = me.replica().snapshot().length;
    const merges = me.fake().control.merges.length;
    o.state([presenceRecord(OBS, bed.clock.now() + 10, { status: 'ready' })]);
    await bed.settle();
    assert.equal(me.replica().fingerprint(), fingerprint);
    assert.equal(me.replica().snapshot().length, records);
    assert.equal(me.fake().control.merges.length, merges);
    assert.deepEqual(me.log.named('p2p.bad_frame').map((entry) => entry.fields.error_code), ['observer_write']);
  });

  it('10: 관전자 링크의 스냅샷은 받되 그 관전자가 쓴 기록은 뺀다(ignored 로 센다)', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    await enterRoom(bed, me, 'alpha', ['A']);
    const o = openObserver(bed, 'alpha');
    await bed.settle();
    const now = bed.clock.now();
    o.state(
      [
        presenceRecord('A', now + 20, { status: 'working' }),
        presenceRecord('B', now + 21, { status: 'ready' }),
        presenceRecord(OBS, now + 22, { status: 'ready' }),
      ],
      true,
    );
    await bed.settle();
    const merge = me.fake().control.merges.at(-1);
    assert.deepEqual(merge, { from: OBS, snapshot: true, count: 2 });
    const logged = me.log.named('state.merge').at(-1);
    assert.ok(Number(logged?.fields.ignored) >= 1);
    assert.equal(me.replica().snapshot().some((record) => record.author === OBS), false);
  });

  it('11: 방 전체 글은 관전자에게도 가고 delivered 에 실린다. to 에 관전자를 줄 수 있다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    const o = openObserver(bed, 'alpha');
    await bed.settle();
    for (const remote of [room.remote('A'), room.remote('B'), o]) remote.take();
    const sending = me.session.sendChat({ text: '모두에게' });
    await bed.settle();
    for (const remote of [room.remote('A'), room.remote('B'), o]) {
      const chat = remote.take().find((frame) => frame.t === 'chat');
      assert.ok(chat?.t === 'chat', remote.name);
      remote.ack(chat.id);
    }
    await bed.settle();
    const sent = await sending;
    assert.ok(sent.ok);
    assert.deepEqual([...sent.delivered].sort(), ['A', 'B', OBS].sort());
    const direct = me.session.sendChat({ text: '관전자에게만', to: [OBS] });
    await bed.settle();
    const chat = o.take().find((frame) => frame.t === 'chat');
    assert.ok(chat?.t === 'chat');
    assert.deepEqual(chat.to, [OBS]);
    o.ack(chat.id);
    await bed.settle();
    const result = await direct;
    assert.ok(result.ok, codeOf(result));
    assert.deepEqual(result.delivered, [OBS]);
  });

  it('12: start_test 와 stop_test 의 sent_to·not_connected 에 관전자가 없다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A', 'B']);
    room.client.emitMembers([
      { peer: 'A', sid: sidOf('A') },
      { peer: 'B', sid: sidOf('B') },
      { peer: 'C', sid: sidOf('C') },
      { peer: OBS, sid: sidOf(OBS) },
      { peer: 'obs-p', sid: sidOf('obs-p') },
    ]);
    openObserver(bed, 'alpha');
    // 링크가 끊긴 관전자(obs-p)도 서버 목록에 있지만 not_connected 에 들지 않는다.
    openObserver(bed, 'alpha', 'obs-p');
    await bed.settle();
    room.mesh.dropLink('obs-p', 'ping_timeout');
    await bed.settle();
    const started = await me.session.command({ type: 'start_test', request: '요청', max_duration_min: 60, max_scenarios: 20 });
    assert.ok(started.ok);
    assert.deepEqual([started.sent_to, started.not_connected], [['A', 'B'], ['C']]);
    const stopped = await me.session.command({ type: 'stop_test', reason: '그만' });
    assert.ok(stopped.ok);
    assert.deepEqual([stopped.sent_to, stopped.not_connected], [['A', 'B'], ['C']]);
  });

  it('13: 관전자 링크가 bye{shutdown}·ping_timeout 으로 닫히면 각각 observer_left 한 번(사유 포함). 참가자 사건은 없다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    room.client.emitMembers([
      { peer: 'A', sid: sidOf('A') },
      { peer: OBS, sid: sidOf(OBS) },
      { peer: 'obs-p', sid: sidOf('obs-p') },
    ]);
    const o = openObserver(bed, 'alpha');
    openObserver(bed, 'alpha', 'obs-p');
    await bed.settle();
    const before = me.inbox.pushed.length;
    o.bye('shutdown');
    room.mesh.dropLink('obs-p', 'ping_timeout');
    await bed.settle();
    const events = me.inbox.pushed.slice(before);
    assert.deepEqual(
      events.map((event) => [event.kind, event.change, event.from, event.kind === 'peer' ? event.data.reason : null]),
      [
        ['peer', 'observer_left', OBS, 'bye_shutdown'],
        ['peer', 'observer_left', 'obs-p', 'ping_timeout'],
      ],
    );
    const observers = statusOf(me).observers;
    assert.equal(observers.some((observer) => observer.name === OBS), false, 'bye 로 끝낸 관전자는 빠진다');
    assert.deepEqual(observers, [{ name: 'obs-p', link: 'none', since: new Date(bed.clock.now()).toISOString() }]);
    assert.equal(statusOf(me).participants.some((participant) => participant.name === 'obs-p' || participant.name === OBS), false);
  });

  it('14: 같은 이름이 hello.observer: false 로 다시 들어오면 observers 에서 빠지고 participants 에 나온다', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    const room = await enterRoom(bed, me, 'alpha', ['A']);
    room.client.emitMembers([
      { peer: 'A', sid: sidOf('A') },
      { peer: OBS, sid: sidOf(OBS) },
    ]);
    openObserver(bed, 'alpha');
    await bed.settle();
    assert.deepEqual(statusOf(me).observers.map((observer) => observer.name), [OBS]);
    room.mesh.dropLink(OBS, 'ping_timeout');
    room.client.emitMembers([
      { peer: 'A', sid: sidOf('A') },
      { peer: OBS, sid: sidOf(OBS, 1) },
    ]);
    const again = bed.remote('alpha', OBS, sidOf(OBS, 1));
    again.open().hello({ observer: false });
    again.state([presenceRecord(OBS, bed.clock.now() + 30, { status: 'ready', listening: true })], true);
    again.syncEnd({ count: 1 });
    await bed.settle();
    const status = statusOf(me);
    assert.deepEqual(status.observers, []);
    assert.deepEqual(
      status.participants.map((participant) => [participant.name, participant.shown_as]),
      [
        ['A', 'ready'],
        [OBS, 'ready'],
      ],
    );
  });

  it('입장하는 참가자는 이미 있던 관전자를 입장 결과의 observers 로 받는다(입장 필수 피어다)', async () => {
    const bed = createTestBed();
    const me = bed.session({ name: 'alpha' });
    for (const peer of ['A', OBS]) bed.net.register(ROOM, peer, sidOf(peer));
    const entering = me.session.join({ room_id: ROOM, name: 'alpha' });
    await bed.settle();
    const a = bed.remote('alpha', 'A');
    a.sync([presenceRecord('A', bed.clock.now() - SEC, { status: 'ready', listening: true })]);
    // 관전자와 동기화하기 전에는 입장이 끝나지 않는다(서버 목록에 표시가 없다).
    await bed.settle();
    openObserver(bed, 'alpha');
    await bed.settle();
    const entered = await entering;
    assert.ok(entered.ok, codeOf(entered));
    assert.deepEqual(entered.participants.map((participant) => participant.name), ['A']);
    assert.deepEqual(entered.observers.map((observer) => [observer.name, observer.link]), [[OBS, 'open']]);
    // 입장 중에 생긴 관전자 사건은 수신함에 넣지 않는다(입장 결과가 싣는다).
    assert.equal(peerEvents(me.inbox.pushed, 'observer_joined').length, 0);
  });
});

describe('createObserverBook (순수한 표)', () => {
  it('관전자로 적고, 같은 sid 면 since 를 그대로 두고, 거짓·null 이면 뺀다. bye 는 같은 sid 만 뺀다', () => {
    const book = createObserverBook();
    book.greeted('o1', 'sid000000001', true, 1000);
    book.greeted('o1', 'sid000000001', true, 2000);
    book.greeted('o2', 'sid000000002', true, 1500);
    assert.deepEqual(book.names(), ['o1', 'o2']);
    const all = book.list(() => 'open', []);
    assert.deepEqual(all.map((view) => [view.name, view.since]), [
      ['o1', new Date(1000).toISOString()],
      ['o2', new Date(1500).toISOString()],
    ]);
    book.greeted('o1', 'sid000000003', true, 3000);
    assert.equal(book.list(() => 'open', [])[0]?.since, new Date(3000).toISOString(), '새 sid 면 새로 잰다');
    book.left('o2', 'sid-other');
    assert.deepEqual(book.list(() => 'open', []).map((view) => view.name), ['o1', 'o2'], '다른 sid 의 bye 로는 빼지 않는다');
    book.left('o2', 'sid000000002');
    assert.deepEqual(book.list(() => 'open', []).map((view) => view.name), ['o1']);
    assert.equal(book.has('o2'), true, '끝낸 관전자도 참가자로 보이지 않게 이름은 남긴다');
    book.greeted('o2', 'sid000000002', true, 5000);
    assert.deepEqual(book.list(() => 'open', []).map((view) => view.name), ['o1', 'o2'], '다시 hello 를 받으면 다시 싣는다');
    book.greeted('o1', 'sid000000003', false, 4000);
    assert.equal(book.has('o1'), false);
    book.greeted('o3', 'sid000000004', null, 4000);
    assert.equal(book.has('o3'), false);
  });

  it('list 는 링크가 있거나 서버 목록에 있는 관전자만 싣는다', () => {
    const book = createObserverBook();
    book.greeted('o1', 'sid000000001', true, 1000);
    book.greeted('o2', 'sid000000002', true, 1000);
    book.greeted('o3', 'sid000000003', true, 1000);
    const links: Record<string, 'open' | 'connecting' | 'none'> = { o1: 'open', o2: 'none', o3: 'none' };
    assert.deepEqual(book.list((peer) => links[peer] ?? 'none', ['o2']).map((view) => [view.name, view.link]), [
      ['o1', 'open'],
      ['o2', 'none'],
    ]);
  });
});
