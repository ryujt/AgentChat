// 자체 호스팅 리스너의 시험. 실제 ws 소켓을 127.0.0.1 의 임의 포트에 붙이고, 시계와 타이머만 가짜로 준다.
// 기한(핸드셰이크 10초, 미입장 10초, 오래됨 90초, 통계 60초)을 기다리지 않고 움직여 본다.
// 프로세스 수준의 결함 주입(F-01~F-14)은 tests/wire/fault-injection.mjs 가 실제 시계로 한다.

import assert from 'node:assert/strict';
import { connect as tcpConnect } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import WebSocket from 'ws';
import type { ServerLogFields } from '../diagnostics/log-port.js';
import { LIMITS, encodeClientMessage, parseServerMessage } from '../protocol/index.js';
import type { ClientMessage, ServerMessage, Timers } from '../protocol/index.js';
import { DEFAULT_SELF_HOST_LIMITS, startSelfHostServer } from './index.js';
import type { SelfHostLimits, SelfHostServer } from './index.js';

const T0 = 1_800_000_000_000;
const ROOM = 'room0000cccc3333';

interface FakeClock {
  readonly now: () => number;
  readonly timers: Timers;
  /** 시각을 옮기며 그 사이에 걸린 타이머를 시각 순서대로 울린다. 울리는 동안 다시 건 것도 구간 안이면 울린다. */
  advance(ms: number): void;
  pending(): number;
}

function createFakeClock(startMs: number): FakeClock {
  interface Entry {
    at: number;
    order: number;
    callback: () => void;
    dead: boolean;
  }
  let current = startMs;
  let order = 0;
  let queue: Entry[] = [];
  return {
    now: () => current,
    timers: {
      setTimeout(callback, delayMs) {
        order += 1;
        const entry: Entry = { at: current + Math.max(0, delayMs), order, callback, dead: false };
        queue.push(entry);
        return entry;
      },
      clearTimeout(handle) {
        if (typeof handle === 'object' && handle !== null) (handle as Entry).dead = true;
      },
    },
    advance(ms) {
      const end = current + ms;
      for (;;) {
        const due = queue.filter((entry) => !entry.dead && entry.at <= end).sort((a, b) => a.at - b.at || a.order - b.order)[0];
        if (due === undefined) break;
        due.dead = true;
        current = Math.max(current, due.at);
        due.callback();
      }
      queue = queue.filter((entry) => !entry.dead);
      current = end;
    },
    pending: () => queue.filter((entry) => !entry.dead).length,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`);
    await sleep(5);
  }
}

interface Client {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  /** 닫혔으면 종료 코드, 아니면 null. */
  closeCode(): number | null;
  send(message: ClientMessage): void;
  raw(data: string | Buffer): void;
  /** 그 id 의 응답을 기다린다. */
  reply(id: string): Promise<ServerMessage>;
  request(message: ClientMessage): Promise<ServerMessage>;
  closed(): Promise<number>;
}

interface Bench {
  readonly server: SelfHostServer;
  readonly clock: FakeClock;
  readonly url: string;
  readonly http: string;
  readonly logs: { event: string; fields: ServerLogFields }[];
  connect(headers?: Record<string, string>): Promise<Client>;
  /** 핸드셰이크가 거절되면 그 HTTP 상태를 돌려준다. */
  refusedStatus(headers?: Record<string, string>): Promise<number>;
  join(client: Client, peer: string, mode?: 'create' | 'join' | 'resume', room?: string): Promise<ServerMessage>;
  health(): Promise<{ ok: boolean; connections: number; rooms: number }>;
}

const benches: Bench[] = [];
const sockets: (WebSocket | Socket)[] = [];

async function bench(limits: Partial<SelfHostLimits> = {}): Promise<Bench> {
  const clock = createFakeClock(T0);
  const logs: Bench['logs'] = [];
  const server = await startSelfHostServer({
    host: '127.0.0.1',
    port: 0,
    limits: { ...DEFAULT_SELF_HOST_LIMITS, ...limits },
    log: { event: (_level, _module, event, fields) => logs.push({ event, fields: fields ?? {} }) },
    now: clock.now,
    timers: clock.timers,
    rssBytes: () => 123 * 1024 * 1024,
  });
  const url = `ws://127.0.0.1:${server.address.port}`;

  const wrap = (socket: WebSocket): Client => {
    const messages: ServerMessage[] = [];
    let code: number | null = null;
    socket.on('message', (data, isBinary) => {
      assert.equal(isBinary, false, '서버는 텍스트 프레임만 보낸다');
      const parsed = parseServerMessage(data.toString());
      assert.ok(parsed.ok, `서버가 스키마에 맞지 않는 글을 보냈다: ${parsed.ok ? '' : parsed.code}`);
      messages.push(parsed.value);
    });
    socket.on('close', (closeCode) => {
      code = closeCode;
    });
    socket.on('error', () => undefined);
    const client: Client = {
      socket,
      messages,
      closeCode: () => code,
      send(message) {
        const encoded = encodeClientMessage(message);
        assert.ok(encoded.ok);
        socket.send(encoded.value);
      },
      raw: (data) => socket.send(data),
      async reply(id) {
        let found: ServerMessage | undefined;
        await until(`${id} 의 응답`, () => {
          found = messages.find((message) => message.type !== 'signal' && message.re === id);
          return found !== undefined;
        });
        return found as ServerMessage;
      },
      async request(message) {
        client.send(message);
        return client.reply(message.id);
      },
      async closed() {
        await until('연결 종료', () => code !== null);
        return code as number;
      },
    };
    return client;
  };

  let serial = 0;
  const made: Bench = {
    server,
    clock,
    url,
    http: `http://127.0.0.1:${server.address.port}`,
    logs,
    connect(headers = {}) {
      return new Promise<Client>((resolve, reject) => {
        const socket = new WebSocket(url, { headers, perMessageDeflate: true });
        sockets.push(socket);
        const client = wrap(socket);
        socket.once('open', () => resolve(client));
        socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
        socket.once('error', reject);
      });
    },
    refusedStatus(headers = {}) {
      return new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        sockets.push(socket);
        socket.once('open', () => reject(new Error('핸드셰이크가 거절되지 않았다')));
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        socket.once('error', (error) => reject(error));
      });
    },
    join(client, peer, mode = 'join', room = ROOM) {
      serial += 1;
      return client.request({
        action: 'join',
        v: 1,
        id: `j${serial}`,
        room,
        peer,
        sid: `sid${String(serial).padStart(9, '0')}`,
        key: `${'k'.repeat(40)}${String(serial).padStart(3, '0')}`,
        mode,
        seq: 1,
      });
    },
    async health() {
      const response = await fetch(`${made.http}/healthz`);
      assert.equal(response.status, 200);
      return (await response.json()) as { ok: boolean; connections: number; rooms: number };
    },
  };
  benches.push(made);
  return made;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket instanceof WebSocket) socket.terminate();
    else socket.destroy();
  }
  for (const made of benches.splice(0)) {
    const closing = made.server.close();
    // close() 의 유예 타이머도 가짜 시계에 걸린다.
    await sleep(20);
    made.clock.advance(5_000);
    await closing;
    assert.equal(made.clock.pending(), 0, '닫은 뒤에 타이머가 남았다');
  }
});

describe('자체 호스팅 리스너: 핸드셰이크와 HTTP', () => {
  it('/healthz 는 연결 수와 방 수만 돌려준다. 다른 경로의 HTTP 요청은 426 이다', async () => {
    const b = await bench();
    assert.deepEqual(await b.health(), { ok: true, connections: 0, rooms: 0 });
    const alice = await b.connect();
    assert.equal((await b.join(alice, 'alice', 'create')).type, 'joined');
    const body = await (await fetch(`${b.http}/healthz?x=1`)).text();
    assert.equal(body, '{"ok":true,"connections":1,"rooms":1}');
    assert.equal(body.includes(ROOM) || body.includes('alice'), false);
    assert.equal((await fetch(`${b.http}/`)).status, 426);
    assert.equal((await fetch(`${b.http}/healthz`, { method: 'POST' })).status, 426);
  });

  it('Origin 헤더가 있는 핸드셰이크는 HTTP 403 으로 거절한다', async () => {
    const b = await bench();
    assert.equal(await b.refusedStatus({ Origin: 'https://example.com' }), 403);
    assert.equal(await b.refusedStatus({ Origin: 'null' }), 403);
    assert.equal((await b.health()).connections, 0);
    assert.equal(b.logs.filter((entry) => entry.event === 'conn.refused' && entry.fields.reason === 'origin').length, 2);
  });

  it('총 연결 수를 넘으면 503 으로 거절하고, 자리가 나면 다시 받는다. 그동안 /healthz 는 응답한다', async () => {
    const b = await bench({ maxConnections: 2, maxConnectionsPerIp: 10 });
    const first = await b.connect();
    await b.connect();
    assert.equal(await b.refusedStatus(), 503);
    assert.deepEqual(await b.health(), { ok: true, connections: 2, rooms: 0 });
    first.socket.close();
    await first.closed();
    await until('자리 비움', () => b.logs.some((entry) => entry.event === 'conn.closed'));
    const third = await b.connect();
    assert.equal(third.socket.readyState, WebSocket.OPEN);
  });

  it('주소별 연결 수를 넘으면 429 로 거절한다', async () => {
    const b = await bench({ maxConnectionsPerIp: 2 });
    await b.connect();
    await b.connect();
    assert.equal(await b.refusedStatus(), 429);
    assert.equal(b.logs.some((entry) => entry.event === 'conn.refused' && entry.fields.reason === 'max_connections_per_ip'), true);
  });

  it('trust-proxy 를 켜면 X-Forwarded-For 의 마지막 주소로 센다. 끄면 그 헤더를 보지 않는다', async () => {
    const trusting = await bench({ maxConnectionsPerIp: 1, trustProxy: true });
    await trusting.connect({ 'X-Forwarded-For': '203.0.113.1' });
    await trusting.connect({ 'X-Forwarded-For': '203.0.113.1, 203.0.113.2' });
    // 앞쪽 값은 클라이언트가 지어낼 수 있다. 바로 앞 프록시가 붙인 마지막 값만 믿는다.
    assert.equal(await trusting.refusedStatus({ 'X-Forwarded-For': '198.51.100.99, 203.0.113.2' }), 429);

    const plain = await bench({ maxConnectionsPerIp: 1 });
    await plain.connect({ 'X-Forwarded-For': '203.0.113.1' });
    assert.equal(await plain.refusedStatus({ 'X-Forwarded-For': '203.0.113.2' }), 429);
  });

  it('압축(permessage-deflate)과 서브프로토콜을 받아들이지 않는다', async () => {
    const b = await bench();
    const client = await b.connect();
    assert.equal(client.socket.extensions, '');
    assert.equal(client.socket.protocol, '');
  });

  it('핸드셰이크를 10초 안에 끝내지 않은 소켓을 끊는다. 한 바이트씩 보내도 같다', async () => {
    const b = await bench();
    const open = (): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = tcpConnect({ host: '127.0.0.1', port: b.server.address.port }, () => resolve(socket));
        sockets.push(socket);
        socket.on('error', reject);
      });
    const silent = await open();
    const slow = await open();
    let silentClosed = false;
    let slowClosed = false;
    silent.on('close', () => (silentClosed = true));
    slow.on('close', () => (slowClosed = true));
    slow.on('error', () => undefined);
    silent.on('error', () => undefined);
    slow.write('GET / HTTP/1.1\r\nHost: x\r\nUpg');
    await sleep(30);
    b.clock.advance(9_999);
    slow.write('r');
    await sleep(30);
    assert.equal(silentClosed || slowClosed, false, '기한 전에 끊겼다');
    b.clock.advance(1);
    await until('핸드셰이크 기한', () => silentClosed && slowClosed);
    assert.equal(b.logs.filter((entry) => entry.event === 'conn.refused' && entry.fields.reason === 'handshake_timeout').length, 2);
    // 무관한 연결은 그대로 된다.
    const alice = await b.connect();
    assert.equal((await b.join(alice, 'alice', 'create')).type, 'joined');
  });
});

describe('자체 호스팅 리스너: 프레임과 규칙 연결', () => {
  it('입장, ping, 시그널 전달이 실제 소켓으로 된다. 한 연결의 메시지는 보낸 순서대로 처리된다', async () => {
    const b = await bench();
    const alice = await b.connect();
    const bob = await b.connect();
    assert.equal((await b.join(alice, 'alice', 'create')).type, 'joined');
    const joined = await b.join(bob, 'bob');
    assert.deepEqual(joined.type === 'joined' ? joined.members.map((member) => member.peer) : null, ['alice']);

    for (let i = 0; i < 40; i += 1) {
      bob.send({ action: 'signal', id: `s${i}`, to: 'alice', kind: 'candidate', cid: 'sid000000002.1', data: { list: [{ candidate: `candidate:${i} 1 udp 1 192.0.2.1 9 typ host`, mid: '0' }] } });
    }
    await until('시그널 40건', () => alice.messages.filter((message) => message.type === 'signal').length === 40);
    const order = alice.messages.flatMap((message) => (message.type === 'signal' && message.kind === 'candidate' ? [message.data.list[0]?.candidate.split(' ')[0]] : []));
    assert.deepEqual(order, Array.from({ length: 40 }, (_, i) => `candidate:${i}`));
    assert.equal(alice.messages.every((message) => message.type !== 'signal' || (message.from === 'bob' && message.sid === 'sid000000002')), true);

    const pong = await alice.request({ action: 'ping', id: 'p1' });
    assert.deepEqual(pong, { type: 'pong', re: 'p1', members: [{ peer: 'bob', sid: 'sid000000002' }] });
  });

  it('상한을 넘는 텍스트는 MESSAGE_TOO_LARGE 다. 연결은 유지된다', async () => {
    const b = await bench();
    const client = await b.connect();
    client.raw('x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES + 1));
    await until('MESSAGE_TOO_LARGE', () => client.messages.length === 1);
    assert.deepEqual(client.messages.map((message) => (message.type === 'error' ? message.code : message.type)), ['MESSAGE_TOO_LARGE']);
    assert.equal((await b.join(client, 'alice', 'create')).type, 'joined');
    assert.equal(client.closeCode(), null);
  });

  it('바이너리 프레임을 받으면 응답 없이 1003 으로 닫고 기록을 지운다. 앞서 받은 글은 처리한다', async () => {
    const b = await bench();
    const alice = await b.connect();
    const bob = await b.connect();
    await b.join(alice, 'alice', 'create');
    await b.join(bob, 'bob');
    bob.raw(JSON.stringify({ action: 'ping', id: 'before' }));
    bob.raw(Buffer.from([1, 2, 3]));
    assert.equal(await bob.closed(), 1003);
    assert.deepEqual(bob.messages.map((message) => (message.type === 'error' ? message.code : message.type)), ['joined', 'pong']);
    assert.equal(b.logs.some((entry) => entry.event === 'conn.drop' && entry.fields.reason === 'binary_frame'), true);
    await until('종료 통지', () => b.logs.some((entry) => entry.event === 'conn.closed'));
    assert.deepEqual(await alice.request({ action: 'ping', id: 'p1' }), { type: 'pong', re: 'p1', members: [] });
  });

  it('와이어 상한의 네 배를 넘는 프레임은 ws 가 받지 않고 그 연결만 닫는다', async () => {
    const b = await bench();
    const other = await b.connect();
    await b.join(other, 'other', 'create');
    const client = await b.connect();
    client.raw('x'.repeat(4 * LIMITS.SIGNAL_MAX_MESSAGE_BYTES + 1));
    assert.equal(await client.closed(), 1009);
    assert.equal(b.logs.some((entry) => entry.event === 'conn.drop' && entry.fields.reason === 'frame_too_large'), true);
    assert.equal((await other.request({ action: 'ping', id: 'p1' })).type, 'pong');
  });

  it('연결이 닫히면 그 참가자의 기록이 바로 지워진다. 종료 처리는 한 번만 반영된다', async () => {
    const b = await bench();
    const alice = await b.connect();
    const bob = await b.connect();
    await b.join(alice, 'alice', 'create');
    await b.join(bob, 'bob');
    bob.socket.terminate();
    await until('종료 통지', () => b.logs.some((entry) => entry.event === 'conn.closed'));
    assert.deepEqual(await alice.request({ action: 'ping', id: 'p1' }), { type: 'pong', re: 'p1', members: [] });
    const refused = await alice.request({ action: 'signal', id: 's1', to: 'bob', kind: 'offer-request', data: {} });
    assert.equal(refused.type === 'error' ? refused.code : '', 'PEER_NOT_FOUND');
    await sleep(30);
    assert.equal(b.logs.filter((entry) => entry.event === 'conn.closed').length, 1);
    assert.deepEqual(await b.health(), { ok: true, connections: 1, rooms: 1 });
  });

  it('규칙이 닫으라고 한 연결은 오류를 받은 뒤 닫힌다(없는 방 입장 5회)', async () => {
    const b = await bench();
    const client = await b.connect();
    const codes: string[] = [];
    for (let i = 0; i < LIMITS.JOIN_MISS_MAX; i += 1) {
      const reply = await b.join(client, 'alice', 'join', `nosuchroom00000${i}`);
      codes.push(reply.type === 'error' ? reply.code : reply.type);
    }
    assert.deepEqual(codes, ['ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'RATE_LIMITED']);
    assert.equal(await client.closed(), 1000);
    assert.deepEqual(await b.health(), { ok: true, connections: 0, rooms: 0 });
  });
});

describe('자체 호스팅 리스너: 기한과 주기 작업', () => {
  it('연결 뒤 미입장 기한 안에 등록되지 않으면 닫는다. 등록된 연결은 닫지 않는다', async () => {
    const b = await bench({ joinDeadlineMs: 10_000 });
    const joined = await b.connect();
    const idle = await b.connect();
    const failing = await b.connect();
    assert.equal((await b.join(joined, 'alice', 'create')).type, 'joined');
    assert.equal((await b.join(failing, 'bob', 'create')).type, 'error', '실패한 join 은 등록이 아니다');
    b.clock.advance(9_999);
    await sleep(30);
    assert.equal(idle.closeCode(), null);
    b.clock.advance(1);
    await idle.closed();
    await failing.closed();
    assert.equal(joined.closeCode(), null);
    assert.equal(b.logs.filter((entry) => entry.event === 'conn.drop' && entry.fields.reason === 'join_deadline').length, 2);
    assert.equal((await joined.request({ action: 'ping', id: 'p1' })).type, 'pong');
  });

  it('미입장 기한은 실행 옵션으로 바뀐다', async () => {
    const b = await bench({ joinDeadlineMs: 500 });
    const idle = await b.connect();
    b.clock.advance(499);
    await sleep(30);
    assert.equal(idle.closeCode(), null);
    b.clock.advance(1);
    await idle.closed();
  });

  it('leave 뒤에도 닫지 않고 남은 연결은 미입장 기한이 지나면 닫는다', async () => {
    const b = await bench();
    const client = await b.connect();
    await b.join(client, 'alice', 'create');
    b.clock.advance(60_000);
    client.send({ action: 'leave', id: 'l1' });
    await until('leave 처리', () => b.logs.some((entry) => entry.event === 'conn.closed' && entry.fields.reason === 'leave'));
    b.clock.advance(5_000);
    await sleep(30);
    assert.equal(client.closeCode(), null, '정리 주기가 등록이 풀린 것을 본 때부터 기한을 잰다');
    b.clock.advance(10_000);
    await client.closed();
  });

  it(`등록된 연결이 ${LIMITS.PARTICIPANT_STALE_MS}ms 넘게 아무 것도 보내지 않으면 닫고 기록을 지운다. ping 을 보내는 연결은 남는다`, async () => {
    const b = await bench();
    const alive = await b.connect();
    const silent = await b.connect();
    await b.join(alive, 'alive', 'create');
    await b.join(silent, 'silent');
    for (let elapsed = 0; elapsed < 90_000; elapsed += 30_000) {
      b.clock.advance(30_000);
      assert.equal((await alive.request({ action: 'ping', id: `p${elapsed}` })).type, 'pong');
    }
    assert.equal(silent.closeCode(), null, '90초까지는 닫지 않는다');
    b.clock.advance(5_001);
    await silent.closed();
    await until('종료 통지', () => b.logs.some((entry) => entry.event === 'conn.closed' && entry.fields.outcome === 'removed'));
    assert.equal(b.logs.some((entry) => entry.event === 'conn.drop' && entry.fields.reason === 'stale'), true);
    assert.deepEqual(await alive.request({ action: 'ping', id: 'last' }), { type: 'pong', re: 'last', members: [] });
    assert.equal(alive.closeCode(), null);
  });

  it('60초마다 server.stats 를 남긴다', async () => {
    const b = await bench({ maxConnectionsPerIp: 1 });
    const client = await b.connect();
    await b.join(client, 'alice', 'create');
    assert.equal(await b.refusedStatus(), 429);
    b.clock.advance(59_999);
    assert.equal(b.logs.some((entry) => entry.event === 'server.stats'), false);
    b.clock.advance(1);
    const stats = b.logs.filter((entry) => entry.event === 'server.stats');
    assert.equal(stats.length, 1);
    assert.deepEqual(stats[0]?.fields, { connections: 1, rooms: 1, rejected: 1, loop_lag_ms: 0, rss_mb: 123 });
    b.clock.advance(60_000);
    assert.equal(b.logs.filter((entry) => entry.event === 'server.stats').length, 2);
  });
});

describe('자체 호스팅 리스너: 종료', () => {
  it('close() 는 신규 수락을 멈추고 열린 연결을 닫는다. 여러 번 불러도 같다', async () => {
    const b = await bench();
    const clients = [await b.connect(), await b.connect(), await b.connect()];
    await b.join(clients[0] as Client, 'alice', 'create');
    const first = b.server.close();
    const second = b.server.close();
    assert.equal(first, second);
    for (const client of clients) assert.equal(await client.closed(), 1001);
    await first;
    await assert.rejects(b.connect(), /ECONNREFUSED/);
    assert.equal(b.logs.filter((entry) => entry.event === 'conn.closed').length, 3, '닫힌 연결마다 종료 처리가 한 번씩 됐다');
    assert.equal(b.clock.pending(), 0);
  });

  it('닫기 핸드셰이크에 답하지 않는 연결이 있어도 유예가 지나면 끊고 끝낸다', async () => {
    const b = await bench();
    // 핸드셰이크만 하고 그 뒤로는 아무 것도 읽지 않는 상대.
    const raw = await new Promise<Socket>((resolve, reject) => {
      const socket = tcpConnect({ host: '127.0.0.1', port: b.server.address.port }, () => {
        socket.write(
          'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      sockets.push(socket);
      socket.once('data', () => {
        socket.pause();
        resolve(socket);
      });
      socket.on('error', reject);
    });
    let rawClosed = false;
    raw.on('close', () => (rawClosed = true));
    // 101 응답을 받았으므로 서버는 이 연결을 이미 받아들였다.
    assert.equal((await b.health()).connections, 1);

    let done = false;
    void b.server.close().then(() => (done = true));
    await sleep(50);
    assert.equal(done, false, '답하지 않는 연결을 유예 동안 기다린다');
    b.clock.advance(1_500);
    raw.resume();
    await until('강제 종료', () => done && rawClosed);
  });
});
