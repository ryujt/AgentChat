// 기본 소켓(ws)을 이 PC 의 실제 ws 서버에 붙여 본다(로컬 실물). 서버는 시험이 만든 것이라 서버 규칙의 증거는 아니다.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIMITS } from '../protocol/index.js';
import { createSignalingClient } from './index.js';
import { createMemoryLog, createRealClock } from './testing.js';
import { openWsSocket } from './ws-socket.js';

const servers: WebSocketServer[] = [];

async function startServer(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(wss);
  await once(wss, 'listening');
  const { port } = wss.address() as AddressInfo;
  return { wss, url: `ws://127.0.0.1:${port}` };
}

function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if (condition()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

function record() {
  const seen = { opens: 0, texts: [] as string[], closes: 0 };
  const handlers = {
    onOpen: () => {
      seen.opens += 1;
    },
    onText: (text: string) => {
      seen.texts.push(text);
    },
    onClose: () => {
      seen.closes += 1;
    },
  };
  return { seen, handlers };
}

after(async () => {
  for (const wss of servers) {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

describe('signaling-client 의 기본 소켓 (실제 ws)', () => {
  it('서브프로토콜·압축·Origin 없이 접속하고 텍스트를 주고받는다. 닫힘은 한 번만 알린다', async () => {
    const { wss, url } = await startServer();
    const connections: { ws: WebSocket; request: IncomingMessage; received: string[] }[] = [];
    wss.on('connection', (ws, request) => {
      const entry = { ws, request, received: [] as string[] };
      ws.on('message', (data, isBinary) => {
        if (!isBinary) entry.received.push(data.toString());
      });
      connections.push(entry);
    });

    const { seen, handlers } = record();
    const socket = openWsSocket(url, handlers);
    assert.equal(socket.send('too early'), false, '열리기 전에는 보내지 않고 false 다');
    await waitFor(() => seen.opens === 1 && connections.length === 1, '접속');

    const headers = connections[0]?.request.headers ?? {};
    assert.equal(headers.origin, undefined, 'Origin 헤더가 없다');
    assert.equal(headers['sec-websocket-protocol'], undefined, '서브프로토콜이 없다');
    assert.equal(headers['sec-websocket-extensions'], undefined, '압축을 제안하지 않는다');

    assert.equal(socket.send('{"action":"ping","id":"p1"}'), true);
    await waitFor(() => connections[0]?.received.length === 1, '서버 수신');
    assert.deepEqual(connections[0]?.received, ['{"action":"ping","id":"p1"}']);

    connections[0]?.ws.send(Buffer.from([1, 2, 3]));
    connections[0]?.ws.send('{"type":"pong","re":"p1","members":[]}');
    await waitFor(() => seen.texts.length === 1, '클라이언트 수신');
    assert.deepEqual(seen.texts, ['{"type":"pong","re":"p1","members":[]}'], '바이너리 프레임은 넘기지 않는다');

    connections[0]?.ws.close();
    await waitFor(() => seen.closes === 1, '닫힘');
    assert.equal(socket.send('after close'), false);
    socket.close();
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.closes, 1);
    assert.equal(seen.opens, 1);
  });

  it('클라이언트가 닫으면 서버 쪽 연결이 닫히고 onClose 가 온다', async () => {
    const { wss, url } = await startServer();
    let serverClosed = false;
    wss.on('connection', (ws) => ws.on('close', () => (serverClosed = true)));
    const { seen, handlers } = record();
    const socket = openWsSocket(url, handlers);
    await waitFor(() => seen.opens === 1, '접속');
    socket.close();
    await waitFor(() => seen.closes === 1 && serverClosed, '양쪽 닫힘');
  });

  it('접속에 실패해도 onClose 를 한 번 부른다', async () => {
    const { wss, url } = await startServer();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    const { seen, handlers } = record();
    const socket = openWsSocket(url, handlers);
    await waitFor(() => seen.closes === 1, '닫힘 통지');
    assert.equal(seen.opens, 0);
    assert.equal(socket.send('x'), false);
  });

  it('WebSocket 이 아닌 응답(HTTP 403)도 닫힘으로 알린다', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (_info, done) => done(false, 403, 'Forbidden') });
    servers.push(wss);
    await once(wss, 'listening');
    const { seen, handlers } = record();
    openWsSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, handlers);
    await waitFor(() => seen.closes === 1, '닫힘 통지');
    assert.equal(seen.opens, 0);
  });

  it('틀린 주소는 던지지 않고 닫힘으로 알린다', async () => {
    const { seen, handlers } = record();
    const socket = openWsSocket('not a url', handlers);
    assert.equal(seen.closes, 0, '소켓을 돌려준 뒤에 알린다');
    await waitFor(() => seen.closes === 1, '닫힘 통지');
    assert.equal(socket.send('x'), false);
    socket.close();
  });

  it('접속 중에 닫으면 열림 없이 닫힘만 알린다', async () => {
    const { url } = await startServer();
    const { seen, handlers } = record();
    const socket = openWsSocket(url, handlers);
    socket.close();
    await waitFor(() => seen.closes === 1, '닫힘 통지');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.opens, 0);
    assert.equal(seen.closes, 1);
  });

  it('받는 프레임이 상한을 넘으면 넘기지 않고 연결이 닫힌다', async () => {
    const { wss, url } = await startServer();
    wss.on('connection', (ws) => {
      ws.send('x'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES * 4));
      ws.send('y'.repeat(LIMITS.SIGNAL_MAX_MESSAGE_BYTES * 4 + 1));
    });
    const { seen, handlers } = record();
    openWsSocket(url, handlers);
    await waitFor(() => seen.closes === 1, '닫힘');
    assert.equal(seen.texts.length, 1, '상한 이하의 프레임만 받았다');
  });
});

describe('signaling-client 를 기본 소켓과 실제 타이머로 돌린다', () => {
  it('join → joined, signal 수신, sendSignal, leave 가 실제 소켓으로 오간다', async () => {
    const { wss, url } = await startServer();
    const received: Record<string, unknown>[] = [];
    let closed = false;
    wss.on('connection', (ws) => {
      ws.on('close', () => (closed = true));
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(message);
        if (message['action'] === 'join') {
          // joined 보다 signal 을 먼저 보낸다(공용 서버에서 생기는 순서).
          ws.send(JSON.stringify({ type: 'signal', from: 'bob', sid: 'bbbbbbbbbbbb', kind: 'offer-request', data: {} }));
          ws.send(JSON.stringify({ type: 'joined', re: message['id'], members: [{ peer: 'bob', sid: 'bbbbbbbbbbbb' }], max_peers: 8, ping_interval_ms: 30_000, stale_after_ms: 90_000 }));
        }
      });
    });

    const log = createMemoryLog();
    const client = createSignalingClient({ url, ...createRealClock(), log });
    const signals: unknown[] = [];
    client.on('signal', (signal) => signals.push(signal));
    const joined = await client.join({ room: 'room0secret0id01', peer: 'alice', sid: 'aaaaaaaaaaaa', key: 'K'.repeat(43), mode: 'create' });
    assert.deepEqual(joined.members, [{ peer: 'bob', sid: 'bbbbbbbbbbbb' }]);
    assert.equal(signals.length, 1);

    assert.equal(client.sendSignal('bob', { kind: 'offer', cid: 'aaaaaaaaaaaa.1', data: { sdp: 'v=0' } }), true);
    await client.leave();
    await waitFor(() => closed, '서버 쪽 닫힘');
    assert.deepEqual(received.map((message) => message['action']), ['join', 'signal', 'leave'], 'leave 가 닫히기 전에 도착했다');
  });

  it('닫힌 포트에는 SERVER_UNREACHABLE 로 끝나고 타이머가 남지 않는다', async () => {
    const { wss, url } = await startServer();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    const client = createSignalingClient({ url, ...createRealClock(), log: createMemoryLog() });
    await assert.rejects(
      client.join({ room: 'room0secret0id01', peer: 'alice', sid: 'aaaaaaaaaaaa', key: 'K'.repeat(43), mode: 'join' }),
      (failure: unknown) => {
        assert.deepEqual(failure, { code: 'SERVER_UNREACHABLE' });
        return true;
      },
    );
  });
});
