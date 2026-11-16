// 와이어 계약만 아는 작은 클라이언트. 제품 클라이언트 코드(signaling-client, mesh)를 쓰지 않는다.
// 쓰는 것은 ws 패키지와 빌드된 protocol 스키마뿐이다. 보내는 글은 encodeClientMessage 로 만들고,
// 받은 프레임은 parseServerMessage 로 본다. 스키마에 맞지 않는 프레임은 따로 세어 시험이 실패로 삼는다.
//
// 빌드 결과의 위치는 tests/support/proc.mjs 의 distUrl 이 정한다(환경 변수 AGENT_CHAT_DIST).

import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { distUrl } from '../support/proc.mjs';

export const protocol = await import(distUrl('protocol/index.js'));

const { LIMITS, encodeClientMessage, newResumeKey, newRoomId, newSid, parseServerMessage } = protocol;

export { LIMITS };

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 조건이 참이 될 때까지 기다린다. 고정 대기가 아니라 기한이 있는 조건으로 판정한다. */
export async function until(what, condition, { timeoutMs = 10_000, pollMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`);
    await delay(pollMs);
  }
}

/** 실행마다 다른 방 ID. 공용 서버에 돌려도 다른 실행이나 실제 방과 겹치지 않는다. */
export function freshRoom() {
  return newRoomId();
}

/** 실행마다 다른 참가자 이름(형식에 맞는 32자 이하). */
export function freshName(label = 'w') {
  return `${label}-${randomBytes(4).toString('hex')}`.slice(0, 32);
}

/** 한 프로세스의 신원. key 는 프로세스마다 하나이고 sid 는 입장마다 새로 만든다. */
export function newIdentity(peer = freshName()) {
  return { peer, sid: newSid(), key: newResumeKey() };
}

/** 서버 로그의 peer_ref·room_ref 와 견줄 때 쓴다(SHA-256 앞 12자리). */
export function refOf(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

let requestSerial = 0;
export function nextRequestId(prefix = 'q') {
  requestSerial += 1;
  return `${prefix}${requestSerial.toString(36)}`;
}

/**
 * 서버에 연결한다. 열리면 클라이언트를, 핸드셰이크가 거절되면 `{status}` 가 든 오류를 던진다.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {Record<string, string>} [options.headers] 핸드셰이크에 더할 헤더(Origin 거절 시험).
 * @param {number} [options.timeoutMs] 연결과 요청의 기한. 기본은 계약의 SIGNAL_REQUEST_TIMEOUT_MS.
 * @param {string} [options.label] 오류 문구에 붙일 이름.
 */
export function openWire(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? LIMITS.SIGNAL_REQUEST_TIMEOUT_MS;
  const label = options.label ?? 'wire';
  return new Promise((resolve, reject) => {
    // 서브프로토콜과 압축은 쓰지 않는다(protocol.md 2.1).
    const socket = new WebSocket(url, { headers: options.headers ?? {}, perMessageDeflate: false, handshakeTimeout: timeoutMs });
    const client = wrap(socket, { timeoutMs, label, connectStartedAt: Date.now() });
    socket.once('open', () => {
      client.connectMs = Date.now() - client.connectStartedAt;
      resolve(client);
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      // 거절 응답 뒤에도 연결을 열어 두는 서버(API Gateway)가 있다. 끊지 않으면 시험 프로세스가 끝나지 않는다.
      socket.terminate();
      const error = new Error(`${label}: 핸드셰이크가 HTTP ${response.statusCode} 로 거절됐다`);
      error.status = response.statusCode;
      reject(error);
    });
    socket.once('error', (error) => reject(error));
  });
}

function wrap(socket, { timeoutMs, label, connectStartedAt }) {
  /** 스키마를 통과한 서버 메시지(받은 순서). */
  const messages = [];
  /** 프로토콜 메시지가 아닌 프레임의 건수. 본문은 남기지 않는다. */
  const stray = { empty: 0, gateway: 0, unknown: 0, bad: 0, binary: 0 };
  const watchers = new Set();
  let closeInfo = null;

  const notify = () => {
    for (const watcher of [...watchers]) watcher();
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      stray.binary += 1;
      notify();
      return;
    }
    const parsed = parseServerMessage(data.toString('utf8'));
    if (parsed.ok) {
      messages.push({ ...parsed.value, receivedAt: Date.now() });
    } else if (parsed.code === 'EMPTY_FRAME') stray.empty += 1;
    else if (parsed.code === 'GATEWAY_FRAME') stray.gateway += 1;
    else if (parsed.code === 'UNKNOWN_TYPE') stray.unknown += 1;
    else stray.bad += 1;
    notify();
  });
  socket.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString('utf8'), at: Date.now() };
    notify();
  });
  socket.on('error', () => {
    // 닫히는 길의 오류는 close 로 본다.
  });

  /** 조건에 맞는 값이 생길 때까지 받은 것을 본다. 닫히면 실패한다(closeOk 가 아니면). */
  function waitFor(what, pick, { timeoutMs: limit = timeoutMs, closeOk = false } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (fn, value) => {
        watchers.delete(check);
        if (timer !== null) clearTimeout(timer);
        fn(value);
      };
      const check = () => {
        const found = pick();
        if (found !== undefined && found !== null && found !== false) finish(resolve, found);
        else if (closeInfo !== null && !closeOk) finish(reject, new Error(`${label}: ${what} 을(를) 받기 전에 연결이 닫혔다(code ${closeInfo.code})`));
      };
      watchers.add(check);
      timer = setTimeout(() => finish(reject, new Error(`${label}: ${limit}ms 안에 ${what} 을(를) 받지 못했다`)), limit);
      check();
    });
  }

  const client = {
    label,
    socket,
    messages,
    stray,
    connectStartedAt,
    connectMs: null,
    /** 닫혔으면 {code, reason, at}, 아니면 null. */
    get closeInfo() {
      return closeInfo;
    },
    get isOpen() {
      return socket.readyState === WebSocket.OPEN;
    },

    /** 스키마로 검증한 메시지를 보낸다. 서버가 거절할 글은 여기서 던진다. */
    send(message) {
      const encoded = encodeClientMessage(message);
      if (!encoded.ok) throw new Error(`${label}: 보낼 수 없는 메시지다(${encoded.code}: ${encoded.detail})`);
      socket.send(encoded.value);
      return message.id;
    },

    /** 검증 없이 그대로 보낸다(잘못된 입력 시험). 문자열은 텍스트, Buffer 는 바이너리 프레임이다. */
    sendRaw(data) {
      socket.send(data);
    },

    /** 그 id 의 응답(joined, pong, error)을 기다린다. */
    reply(id, opts) {
      return waitFor(`${id} 의 응답`, () => messages.find((message) => message.type !== 'signal' && message.re === id), opts);
    },

    /** 보내고 같은 id 의 응답을 기다린다. */
    async request(message, opts) {
      const sentAt = Date.now();
      client.send(message);
      const reply = await client.reply(message.id, opts);
      return { ...reply, elapsedMs: Date.now() - sentAt };
    },

    join({ room, peer, sid, key, mode, seq = 1, id = nextRequestId('j'), v = LIMITS.SIGNAL_VERSION }, opts) {
      return client.request({ action: 'join', v, id, room, peer, sid, key, mode, seq }, opts);
    },

    ping(opts) {
      return client.request({ action: 'ping', id: nextRequestId('p') }, opts);
    },

    /** signal 을 보내고 요청 id 를 돌려준다. 성공 응답은 없다. 실패는 그 id 의 error 로 온다. */
    signal(to, payload = { kind: 'offer-request', data: {} }, id = nextRequestId('s')) {
      return client.send({ action: 'signal', id, to, ...payload });
    },

    /** signal 을 보내고, 그 id 의 error 가 오면 그것을, 기한까지 없으면 null 을 돌려준다. */
    async signalError(to, payload, { waitMs = 300 } = {}) {
      const id = client.signal(to, payload);
      try {
        return await waitFor(`${id} 의 오류`, () => messages.find((message) => message.type === 'error' && message.re === id), { timeoutMs: waitMs, closeOk: true });
      } catch {
        return null;
      }
    },

    leave() {
      if (socket.readyState === WebSocket.OPEN) client.send({ action: 'leave', id: nextRequestId('l') });
    },

    signals(filter = () => true) {
      return messages.filter((message) => message.type === 'signal' && filter(message));
    },

    errors(filter = () => true) {
      return messages.filter((message) => message.type === 'error' && filter(message));
    },

    waitFor,

    /** 닫힐 때까지 기다린다. 기한을 넘기면 던진다. */
    closed(opts = {}) {
      return waitFor('연결 종료', () => closeInfo, { ...opts, closeOk: true });
    },

    /** 정상 닫기(닫기 핸드셰이크). */
    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
    },

    /** 닫기 핸드셰이크 없이 소켓을 끊는다(갑작스러운 종료). */
    terminate() {
      socket.terminate();
    },
  };
  return client;
}

/** 열어 둔 클라이언트를 모아 두었다가 끝에 등록을 지우고 닫는다. 여분 프레임의 합계도 낸다. */
export function createWireSession(url, defaults = {}) {
  const clients = [];
  return {
    url,
    clients,
    async open(options = {}) {
      const client = await openWire(url, { ...defaults, ...options });
      clients.push(client);
      return client;
    },
    /** 새 신원으로 연결해 입장까지 한다. 응답이 joined 가 아니면 던진다. */
    async joined(room, mode, identity = newIdentity(), options = {}) {
      const client = await openWire(url, { ...defaults, ...options });
      clients.push(client);
      const reply = await client.join({ room, ...identity, mode });
      if (reply.type !== 'joined') throw new Error(`입장하지 못했다: ${reply.type === 'error' ? reply.code : reply.type}`);
      return Object.assign(client, { identity, joinedReply: reply });
    },
    strayTotals() {
      const total = { empty: 0, gateway: 0, unknown: 0, bad: 0, binary: 0 };
      for (const client of clients) for (const key of Object.keys(total)) total[key] += client.stray[key];
      return total;
    },
    /** 만든 등록을 모두 leave 로 지우고 연결을 닫는다. 닫히지 않은 연결의 수를 돌려준다. */
    async closeAll({ timeoutMs = 5_000 } = {}) {
      for (const client of clients) {
        try {
          client.leave();
        } catch {
          // 이미 닫힌 연결이다.
        }
        client.close();
      }
      const deadline = Date.now() + timeoutMs;
      while (clients.some((client) => client.closeInfo === null) && Date.now() < deadline) await delay(20);
      const stuck = clients.filter((client) => client.closeInfo === null);
      for (const client of stuck) client.terminate();
      return stuck.length;
    },
  };
}

/** `--name 값` 꼴의 인자를 읽는다. 없으면 undefined. */
export function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}
