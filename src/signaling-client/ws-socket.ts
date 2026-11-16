// 서버로 가는 실제 소켓(ws). 서브프로토콜·압축·Origin 헤더를 쓰지 않는다(protocol.md 2.1).

import WebSocket from 'ws';
import { LIMITS } from '../protocol/index.js';
import type { OpenSignalingSocket, SignalingSocket } from './contract.js';

// 서버 → 클라이언트 방향에는 와이어 상한이 없다. 전달받는 signal 은 보낸 것에 from·sid 가 붙어 조금 길다.
// 그래도 받는 프레임의 크기는 여기서 막는다. 보내는 상한의 4배면 정원이 찬 방의 목록도 든다.
const MAX_INCOMING_BYTES = LIMITS.SIGNAL_MAX_MESSAGE_BYTES * 4;

// 닫는 악수에 상대가 답하지 않을 때 소켓을 붙잡는 시간. ws 의 기본 30초는 죽은 연결을 그만큼 남긴다.
const CLOSE_HANDSHAKE_WAIT_MS = 2_000;

type ClientOptions = WebSocket.ClientOptions & { closeTimeout?: number };

function toText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export const openWsSocket: OpenSignalingSocket = (url, handlers): SignalingSocket => {
  let closed = false;
  const notifyClosed = (): void => {
    if (closed) return;
    closed = true;
    handlers.onClose();
  };

  const options: ClientOptions = {
    perMessageDeflate: false,
    followRedirects: false,
    maxPayload: MAX_INCOMING_BYTES,
    closeTimeout: CLOSE_HANDSHAKE_WAIT_MS,
  };

  let ws: WebSocket;
  try {
    ws = new WebSocket(url, options);
  } catch {
    // 주소가 틀리면 생성자가 던진다. 부르는 쪽이 소켓을 받은 뒤에 닫힘을 알게 한 박자 늦춘다.
    queueMicrotask(notifyClosed);
    return { send: () => false, close: () => {} };
  }

  ws.on('open', () => {
    if (!closed) handlers.onOpen();
  });
  ws.on('message', (data, isBinary) => {
    // 프레임은 텍스트뿐이다. 바이너리는 프로토콜 메시지가 아니다.
    if (closed || isBinary) return;
    handlers.onText(toText(data));
  });
  // 접속 실패와 프레임 오류는 뒤따르는 close 로 다룬다. 리스너가 없으면 프로세스가 죽는다.
  ws.on('error', () => {});
  ws.on('close', notifyClosed);

  return {
    send(text: string): boolean {
      if (ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(text);
        return true;
      } catch {
        return false;
      }
    },
    close(): void {
      try {
        // 접속 중에는 닫는 악수를 할 상대가 없다. 바로 끊는다.
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
      } catch {
        // 이미 닫힌 소켓이다.
      }
    },
  };
};
