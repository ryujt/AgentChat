import type { InboxEvent } from '../src/inbox/contract.js';
import { createMeshWith } from '../src/mesh/mesh.js';
import { createMonitorSink } from '../src/monitor/sink.js';
import { parseIceServers, randomLowerAlnum } from '../src/protocol/index.js';
import { createRoomSession, DEFAULT_ROOM_SESSION_LIMITS, type RoomSession } from '../src/room-session/index.js';
import { createReplica } from '../src/shared-state/index.js';
import { createSignalingClient } from '../src/signaling-client/index.js';
import { loadBrowserRtc } from './web-rtc.js';

export { parseChatInput } from '../src/monitor/input.js';
export { DEFAULT_SERVER_URL, LIMITS, isRoomId, checkPeerName, normalizeServerAddress } from '../src/protocol/index.js';

declare const AGENT_CHAT_VERSION: string;

export interface MonitorOptions {
  readonly onEvent: (event: InboxEvent) => void;
  readonly iceServers?: string | null;
}

export type BrowserMonitor = Pick<RoomSession, 'observe' | 'observed' | 'sendChat'> & {
  shutdown(budgetMs?: number): Promise<void>;
};

const recordingDisabled = async () => ({
  ok: false,
  code: 'RECORD_FAILED',
  detail: 'Browser observers do not record local files.',
} as const);

export function createBrowserMonitor({ onEvent, iceServers = null }: MonitorOptions): BrowserMonitor {
  const now = Date.now;
  const sink = createMonitorSink({ now, onEvent });
  const session = createRoomSession({
    app: { name: 'agent-chat', version: AGENT_CHAT_VERSION },
    config: {
      defaultServer: null,
      name: 'observer-' + randomLowerAlnum(4),
      client: 'monitor',
      iceServers: { raw: iceServers, parsed: parseIceServers(iceServers) },
      home: '',
    },
    limits: DEFAULT_ROOM_SESSION_LIMITS,
    inbox: sink,
    createSignalingClient,
    createMesh: (deps) => createMeshWith(deps, loadBrowserRtc),
    createReplica,
    openTranscript: recordingDisabled,
    writeReport: recordingDisabled,
    log: { event() {} },
    now,
    timers: {
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
  });

  return {
    async observe(args) {
      const result = await session.observe(args);
      if (result.ok) sink.start();
      return result;
    },
    observed: session.observed,
    sendChat: session.sendChat,
    shutdown(budgetMs = 500) {
      sink.close();
      return session.shutdown(budgetMs);
    },
  };
}
