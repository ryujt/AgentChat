// 스테이지 스로틀을 "다른 연결"로 넘기는 부하. 제품 코드가 아니다(V-P5, V-P7 나).
// 와이어 계약만 아는 클라이언트(tests/wire/wire-client.mjs)로 입장하지 않은 연결 여러 개를 열고,
// 각 연결이 일정한 간격으로 `ping` 을 보낸다. 서버를 지나간 ping 은 NOT_JOINED 로 답을 받고,
// 게이트웨이가 버린 것은 `type` 없는 프레임(게이트웨이 프레임)으로 돌아온다.
// 스테이지 스로틀 설정은 바꾸지 않는다. 연결별 속도 제한(60초 300건)에 닿지 않게 연결 수를 넉넉히 둔다.
//
// 게이트웨이 프레임은 본문을 남기지 않고 JSON 키 목록과 `message` 값만 모은다.

import { openWire } from '../../wire/wire-client.mjs';

/**
 * @param {object} options
 * @param {string} options.url
 * @param {number} options.connections 연결 수
 * @param {number} options.ratePerSec 전체 초당 보낼 건수(연결마다 고르게 나눈다)
 */
export async function startFlood({ url, connections, ratePerSec }) {
  const clients = [];
  const gatewayShapes = new Map();
  for (let i = 0; i < connections; i += 1) {
    const client = await openWire(url, { label: `flood-${i}` });
    client.socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString('utf8');
      if (!text.startsWith('{') || text.includes('"type"')) return;
      try {
        const value = JSON.parse(text);
        const shape = `${Object.keys(value).sort().join(',')}|${typeof value.message === 'string' ? value.message : ''}`;
        gatewayShapes.set(shape, (gatewayShapes.get(shape) ?? 0) + 1);
      } catch {
        gatewayShapes.set('(JSON 아님)', (gatewayShapes.get('(JSON 아님)') ?? 0) + 1);
      }
    });
    clients.push(client);
  }
  const perConnIntervalMs = (1000 * connections) / ratePerSec;
  let sent = 0;
  const startedAt = Date.now();
  const timers = clients.map((client, index) =>
    setTimeout(
      () => {
        timers[index] = setInterval(() => {
          if (!client.isOpen) return;
          client.send({ action: 'ping', id: `f${index.toString(36)}x${(sent += 1).toString(36)}` });
        }, perConnIntervalMs);
      },
      (perConnIntervalMs * index) / connections,
    ),
  );
  return {
    startedAt,
    get sent() {
      return sent;
    },
    stats() {
      let replies = 0;
      let notJoined = 0;
      let rateLimited = 0;
      let gateway = 0;
      let closed = 0;
      for (const client of clients) {
        replies += client.messages.length;
        notJoined += client.messages.filter((message) => message.type === 'error' && message.code === 'NOT_JOINED').length;
        rateLimited += client.messages.filter((message) => message.type === 'error' && message.code === 'RATE_LIMITED').length;
        gateway += client.stray.gateway;
        if (client.closeInfo !== null) closed += 1;
      }
      return { connections, sent, replies, notJoined, rateLimited, gateway, closed, gatewayShapes: Object.fromEntries(gatewayShapes) };
    },
    /** 보내기를 멈추고 응답을 잠깐 더 받은 뒤 닫는다. 통계를 돌려준다. */
    async stop({ drainMs = 3_000 } = {}) {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      const stoppedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, drainMs));
      const result = { ...this.stats(), seconds: Math.round((stoppedAt - startedAt) / 100) / 10 };
      for (const client of clients) client.close();
      const deadline = Date.now() + 5_000;
      while (clients.some((client) => client.closeInfo === null) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      for (const client of clients) if (client.closeInfo === null) client.terminate();
      return result;
    },
  };
}
