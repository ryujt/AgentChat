import type { OpenSignalingSocket } from '../src/signaling-client/contract.js';
import { LIMITS } from '../src/protocol/index.js';

const maxIncomingBytes = LIMITS.SIGNAL_MAX_MESSAGE_BYTES * 4;
const encoder = new TextEncoder();

export const openWsSocket: OpenSignalingSocket = (url, handlers) => {
  const socket = new WebSocket(url);

  socket.addEventListener('open', handlers.onOpen);
  socket.addEventListener('close', handlers.onClose, { once: true });
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    if (data.length > maxIncomingBytes || encoder.encode(data).length > maxIncomingBytes) {
      socket.close();
      return;
    }
    handlers.onText(data);
  });

  return {
    send(text) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(text);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      socket.close();
    },
  };
};
