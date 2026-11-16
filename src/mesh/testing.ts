// mesh 의 시험 전용 진입점. 제품 코드는 이 파일을 import 하지 않는다.
// 움직일 수 있는 시계, 메모리 로그, 시험이 서버 노릇을 하는 시그널 중계, 가짜 네이티브, 로컬 STUN 대역을 준다.

import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { LogFields, LogLevel, LogModule, LogPort } from '../diagnostics/log-port.js';
import type { IceServers, Now, ServerSignalMessage, SignalKind, SignalPayload, TimerHandle, Timers } from '../protocol/index.js';
import type { Mesh, SendSignal } from './contract.js';
import type { NativeChannel, NativePeer, NativeRtc } from './native.js';

// ── 시계 ────────────────────────────────────────────────────────────────────

export interface TestClock {
  readonly now: Now;
  readonly timers: Timers;
  /** 시간을 ms 만큼 건너뛴다. 그 사이에 찬 타이머를 시각 순서대로 울린다. */
  jump(ms: number): void;
  /** 참이면 실제 시간이 흐르는 만큼 함께 흐른다(실제 라이브러리의 진행에 맞춘다). 거짓이면 jump 로만 움직인다. */
  setRealtime(on: boolean): void;
  pending(): number;
  stop(): void;
}

/**
 * 실제 시간과 함께 흐르다가, 시험이 원할 때 건너뛸 수 있는 시계.
 * 실제 라이브러리는 실제 시간으로 움직이므로 후보 묶음 같은 짧은 타이머는 그대로 흐르게 두고,
 * 15초 기한 같은 긴 타이머는 건너뛰어 울린다.
 */
export function createTestClock(options: { readonly realtime?: boolean } = {}): TestClock {
  let virtual = 1_700_000_000_000;
  let realtime = options.realtime ?? true;
  let lastReal = Date.now();
  let nextHandle = 1;
  const pending = new Map<number, { readonly at: number; readonly callback: () => void }>();

  const drift = (): number => (realtime ? Date.now() - lastReal : 0);

  function advanceTo(target: number): void {
    for (;;) {
      let dueHandle: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [handle, timer] of pending) {
        if (timer.at <= target && timer.at < dueAt) {
          dueHandle = handle;
          dueAt = timer.at;
        }
      }
      if (dueHandle === null) break;
      const timer = pending.get(dueHandle);
      pending.delete(dueHandle);
      virtual = Math.max(virtual, dueAt);
      lastReal = Date.now();
      timer?.callback();
    }
    virtual = Math.max(virtual, target);
    lastReal = Date.now();
  }

  const pump = setInterval(() => {
    if (realtime) advanceTo(virtual + drift());
  }, 2);
  pump.unref();

  return {
    now: () => virtual + drift(),
    timers: {
      setTimeout(callback: () => void, delayMs: number): TimerHandle {
        const handle = nextHandle;
        nextHandle += 1;
        pending.set(handle, { at: virtual + drift() + Math.max(0, delayMs), callback });
        return handle;
      },
      clearTimeout(handle: TimerHandle): void {
        if (typeof handle === 'number') pending.delete(handle);
      },
    },
    jump(ms: number): void {
      advanceTo(virtual + drift() + ms);
    },
    setRealtime(on: boolean): void {
      if (on === realtime) return;
      if (realtime) advanceTo(virtual + drift());
      realtime = on;
      lastReal = Date.now();
    },
    pending: () => pending.size,
    stop(): void {
      clearInterval(pump);
      pending.clear();
    },
  };
}

// ── 메모리 로그 ─────────────────────────────────────────────────────────────

export interface LoggedEvent {
  readonly level: LogLevel;
  readonly module: LogModule;
  readonly event: string;
  readonly fields: LogFields;
}

export interface MemoryLog extends LogPort {
  readonly events: LoggedEvent[];
  named(event: string): LoggedEvent[];
  text(): string;
}

export function createMemoryLog(): MemoryLog {
  const events: LoggedEvent[] = [];
  return {
    events,
    event(level, module, event, fields = {}): void {
      events.push({ level, module, event, fields });
    },
    named: (event) => events.filter((entry) => entry.event === event),
    text: () => events.map((entry) => JSON.stringify(entry)).join('\n'),
  };
}

// ── 시그널 중계 (시험이 서버 노릇을 한다) ───────────────────────────────────

export interface Envelope {
  readonly index: number;
  readonly from: string;
  /** 서버가 보낸 쪽의 등록에서 붙이는 sid. */
  readonly sid: string;
  readonly to: string;
  readonly payload: SignalPayload;
}

export type Route = 'pass' | 'drop' | 'hold';

export interface SignalHub {
  /** 그 참가자의 mesh 에 넣을 전송 함수. */
  sender(from: string, sid: string): SendSignal;
  /** 그 참가자에게 가는 시그널을 받을 곳. */
  attach(peer: string, handle: (signal: ServerSignalMessage) => void): void;
  /** 보낸 것마다 전달할지(pass), 버릴지(drop), 들고 있을지(hold) 정한다. 기본은 pass 다. */
  route: (envelope: Envelope) => Route;
  /** mesh 가 내보낸 모든 시그널(버린 것 포함). */
  readonly sent: Envelope[];
  readonly held: Envelope[];
  sentBy(from: string, kind?: SignalKind): Envelope[];
  /** 지금 바로 전달한다. 들고 있던 것이면 빼낸다. */
  deliver(envelope: Envelope): void;
  /** 들고 있던 것 가운데 맞는 것을 든 순서대로 전달한다. 전달한 수를 돌려준다. */
  release(match?: (envelope: Envelope) => boolean): number;
  /** 거짓이면 그 참가자의 전송 함수가 보내지 않고 false 를 돌려준다(등록 전, 재접속 중). */
  setOnline(peer: string, online: boolean): void;
  /** 전달을 기다리는 것이 없어질 때까지 기다린다. */
  settle(): Promise<void>;
}

export function toSignal(envelope: Envelope): ServerSignalMessage {
  return { type: 'signal', from: envelope.from, sid: envelope.sid, ...envelope.payload } as ServerSignalMessage;
}

export function createSignalHub(): SignalHub {
  const handlers = new Map<string, (signal: ServerSignalMessage) => void>();
  const offline = new Set<string>();
  const sent: Envelope[] = [];
  const held: Envelope[] = [];
  const queue: Envelope[] = [];
  let draining = false;

  function deliverNow(envelope: Envelope): void {
    handlers.get(envelope.to)?.(toSignal(envelope));
  }

  // 전달은 다음 박자에 한다. 실제 서버를 거친 시그널은 보낸 호출 안에서 돌아오지 않는다.
  function drain(): void {
    if (draining) return;
    draining = true;
    setImmediate(() => {
      draining = false;
      const batch = queue.splice(0, queue.length);
      for (const envelope of batch) deliverNow(envelope);
      if (queue.length > 0) drain();
    });
  }

  const hub: SignalHub = {
    route: () => 'pass',
    sent,
    held,
    sender(from: string, sid: string): SendSignal {
      return (to, payload) => {
        if (offline.has(from)) return false;
        const envelope: Envelope = { index: sent.length, from, sid, to, payload };
        sent.push(envelope);
        const decision = hub.route(envelope);
        if (decision === 'hold') held.push(envelope);
        else if (decision === 'pass') {
          queue.push(envelope);
          drain();
        }
        return true;
      };
    },
    attach(peer, handle): void {
      handlers.set(peer, handle);
    },
    sentBy: (from, kind) => sent.filter((envelope) => envelope.from === from && (kind === undefined || envelope.payload.kind === kind)),
    deliver(envelope): void {
      const index = held.indexOf(envelope);
      if (index >= 0) held.splice(index, 1);
      deliverNow(envelope);
    },
    release(match = () => true): number {
      const chosen = held.filter(match);
      for (const envelope of chosen) hub.deliver(envelope);
      return chosen.length;
    },
    setOnline(peer, online): void {
      if (online) offline.delete(peer);
      else offline.add(peer);
    },
    async settle(): Promise<void> {
      while (queue.length > 0 || draining) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  return hub;
}

// ── 기다리기 ────────────────────────────────────────────────────────────────

/** 조건이 참이 될 때까지 실제 시간으로 기다린다. 기한을 넘기면 던진다. */
export function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      let met = false;
      try {
        met = condition();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (met) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`));
      else setTimeout(poll, 3);
    };
    poll();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 한 프로세스의 mesh 여럿을 함께 끝낸다. 네이티브 정리는 프로세스 전체의 것이라,
 * 한쪽만 먼저 끝내면 다른 쪽의 pc 가 콜백 없이 닫히고 정리가 10초 멈출 수 있다(실측).
 * 모든 mesh 의 shutdown() 을 같은 박자에 불러 pc 를 모두 닫은 뒤에 정리가 돌게 한다.
 */
export async function shutdownAll(meshes: readonly Mesh[]): Promise<void> {
  await Promise.all(meshes.map((mesh) => mesh.shutdown()));
}

// ── 가짜 네이티브 ───────────────────────────────────────────────────────────

export interface FakeChannel extends NativeChannel {
  readonly label: string;
  readonly sent: string[];
  closed: boolean;
  fireOpen(): void;
  fireClosed(): void;
  fireMessage(message: string | Buffer): void;
}

export interface FakePeer extends NativePeer {
  readonly name: string;
  readonly iceServers: IceServers;
  closed: boolean;
  readonly remoteDescriptions: { sdp: string; type: string }[];
  readonly remoteCandidates: { candidate: string; mid: string }[];
  /** 이 pc 에서 만든(또는 받은) 채널. */
  readonly channels: FakeChannel[];
  fireLocalDescription(sdp: string, type: string): void;
  fireLocalCandidate(candidate: string, mid?: string): void;
  fireState(state: string): void;
  /** 상대가 만든 채널이 도착한 것처럼 한다. */
  fireDataChannel(label?: string, open?: boolean): FakeChannel;
}

export interface FakeNative {
  readonly rtc: NativeRtc;
  readonly peers: FakePeer[];
  cleanups: number;
  last(): FakePeer;
}

function createFakeChannel(label: string, initiallyOpen: boolean): FakeChannel {
  let open = initiallyOpen;
  const callbacks: { open?: () => void; closed?: () => void; message?: (message: string | Buffer | ArrayBuffer) => void } = {};
  const channel: FakeChannel = {
    label,
    sent: [],
    closed: false,
    close(): void {
      channel.closed = true;
      open = false;
    },
    sendMessage(text: string): boolean {
      if (!open) throw new Error('sendMessage() called on destroyed channel');
      channel.sent.push(text);
      return true;
    },
    isOpen: () => open,
    getLabel: () => label,
    onOpen(callback): void {
      callbacks.open = callback;
    },
    onClosed(callback): void {
      callbacks.closed = callback;
    },
    onError(): void {},
    onMessage(callback): void {
      callbacks.message = callback;
    },
    fireOpen(): void {
      open = true;
      callbacks.open?.();
    },
    fireClosed(): void {
      open = false;
      callbacks.closed?.();
    },
    fireMessage(message): void {
      callbacks.message?.(message);
    },
  };
  return channel;
}

export function createFakeNative(): FakeNative {
  const peers: FakePeer[] = [];
  const fake: FakeNative = {
    peers,
    cleanups: 0,
    last(): FakePeer {
      const peer = peers[peers.length - 1];
      if (peer === undefined) throw new Error('아직 만든 pc 가 없다');
      return peer;
    },
    rtc: {
      createPeer(name, iceServers): NativePeer {
        const callbacks: {
          description?: (sdp: string, type: string) => void;
          candidate?: (candidate: string, mid: string) => void;
          state?: (state: string) => void;
          channel?: (channel: NativeChannel) => void;
        } = {};
        let state = 'new';
        const peer: FakePeer = {
          name,
          iceServers,
          closed: false,
          remoteDescriptions: [],
          remoteCandidates: [],
          channels: [],
          close(): void {
            peer.closed = true;
            state = 'closed';
          },
          setRemoteDescription(sdp, type): void {
            if (!sdp.startsWith('v=0')) throw new Error('Remote description has no ICE user fragment');
            peer.remoteDescriptions.push({ sdp, type });
          },
          addRemoteCandidate(candidate, mid): void {
            if (peer.remoteDescriptions.length === 0) throw new Error('Got a remote candidate without remote description');
            peer.remoteCandidates.push({ candidate, mid });
          },
          createDataChannel(label): NativeChannel {
            const channel = createFakeChannel(label, false);
            peer.channels.push(channel);
            return channel;
          },
          state: () => state,
          iceState: () => (state === 'new' ? 'new' : 'checking'),
          onLocalDescription(callback): void {
            callbacks.description = callback;
          },
          onLocalCandidate(callback): void {
            callbacks.candidate = callback;
          },
          onStateChange(callback): void {
            callbacks.state = callback;
          },
          onDataChannel(callback): void {
            callbacks.channel = callback;
          },
          fireLocalDescription(sdp, type): void {
            callbacks.description?.(sdp, type);
          },
          fireLocalCandidate(candidate, mid = '0'): void {
            callbacks.candidate?.(candidate, mid);
          },
          fireState(next): void {
            state = next;
            callbacks.state?.(next);
          },
          fireDataChannel(label = 'agent-chat', open = true): FakeChannel {
            const channel = createFakeChannel(label, open);
            peer.channels.push(channel);
            callbacks.channel?.(channel);
            return channel;
          },
        };
        peers.push(peer);
        return peer;
      },
      cleanup(): void {
        fake.cleanups += 1;
      },
    },
  };
  return fake;
}

// ── 로컬 STUN 대역 ──────────────────────────────────────────────────────────

export interface StunStub {
  readonly port: number;
  requests(): number;
  close(): Promise<void>;
}

/**
 * 127.0.0.1 에서 STUN Binding 요청에 답하는 작은 서버. 답을 delayMs 만큼 늦출 수 있다.
 * 공개 STUN 서버 없이 srflx 후보가 나오게 한다. 실제 STUN 서버에 닿는다는 증거는 아니다.
 */
export async function startStunStub(delayMs = 0): Promise<StunStub> {
  const socket = dgram.createSocket('udp4');
  let requests = 0;
  const cookie = [0x21, 0x12, 0xa4, 0x42];
  socket.on('message', (message, remote) => {
    if (message.length < 20 || message.readUInt16BE(0) !== 0x0001) return;
    requests += 1;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0);
    response.writeUInt16BE(12, 2);
    message.copy(response, 4, 4, 20);
    // XOR-MAPPED-ADDRESS
    response.writeUInt16BE(0x0020, 20);
    response.writeUInt16BE(8, 22);
    response.writeUInt8(0x01, 25);
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    remote.address.split('.').forEach((part, index) => response.writeUInt8(Number(part) ^ (cookie[index] ?? 0), 28 + index));
    setTimeout(() => {
      try {
        socket.send(response, remote.port, remote.address);
      } catch {
        // 이미 닫은 소켓이다.
      }
    }, delayMs);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: (socket.address() as AddressInfo).port,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

// ── 날 pc (시험이 직접 모는 상대) ───────────────────────────────────────────

export interface RawItem {
  readonly candidate: string;
  readonly mid: string;
}

/** 시험이 직접 모는 실제 pc 하나. mesh 의 상대 노릇을 한다. ping 에 답하지 않게 둘 수 있다(죽은 상대). */
export interface RawConn {
  /** 이 pc 가 만든 offer 또는 answer. */
  readonly sdp: string;
  /** 지금까지 모은 로컬 후보. */
  readonly candidates: RawItem[];
  /** 받은 텍스트 프레임. */
  readonly messages: string[];
  /** 참이면 ping 에 pong 으로 답한다. 기본은 거짓이다. */
  answerPings: boolean;
  setRemote(sdp: string, type: 'offer' | 'answer'): void;
  addCandidates(items: readonly RawItem[]): void;
  isOpen(): boolean;
  send(text: string): void;
  close(): void;
}

export interface RawPeers {
  /** 채널을 만들어 offer 를 낸다. */
  offer(): Promise<RawConn>;
  /** 받은 offer 에 answer 를 낸다. */
  answer(offerSdp: string): Promise<RawConn>;
  /** 만든 pc 를 모두 닫는다. mesh 의 shutdown 보다 먼저 부른다. */
  closeAll(): void;
}

export async function createRawPeers(): Promise<RawPeers> {
  const lib = await import('node-datachannel');
  const closers: (() => void)[] = [];

  async function make(offerSdp: string | null): Promise<RawConn> {
    const pc = new lib.PeerConnection(offerSdp === null ? 'raw-offer' : 'raw-answer', { iceServers: [] });
    let sdp: string | null = null;
    let channel: ReturnType<typeof pc.createDataChannel> | null = null;
    let closed = false;
    const candidates: RawItem[] = [];
    const messages: string[] = [];

    const attach = (dc: ReturnType<typeof pc.createDataChannel>): void => {
      channel = dc;
      dc.onMessage((message) => {
        if (typeof message !== 'string' || closed) return;
        messages.push(message);
        if (!conn.answerPings) return;
        try {
          const frame = JSON.parse(message) as { t?: unknown; n?: unknown };
          if (frame.t === 'ping') dc.sendMessage(JSON.stringify({ v: 1, t: 'pong', n: frame.n }));
        } catch {
          // 프레임이 아니다.
        }
      });
      dc.onClosed(() => {});
      dc.onOpen(() => {});
    };

    pc.onLocalDescription((description) => {
      sdp ??= description;
    });
    pc.onLocalCandidate((candidate, mid) => {
      candidates.push({ candidate, mid });
    });
    pc.onStateChange(() => {});
    pc.onDataChannel(attach);

    const conn: RawConn = {
      get sdp(): string {
        return sdp ?? '';
      },
      candidates,
      messages,
      answerPings: false,
      setRemote(remoteSdp, type): void {
        pc.setRemoteDescription(remoteSdp, type);
      },
      addCandidates(items): void {
        for (const item of items) pc.addRemoteCandidate(item.candidate, item.mid);
      },
      isOpen: () => !closed && channel !== null && channel.isOpen(),
      send(text): void {
        channel?.sendMessage(text);
      },
      close(): void {
        if (closed) return;
        closed = true;
        try {
          channel?.close();
        } catch {
          // 이미 닫혔다.
        }
        try {
          pc.close();
        } catch {
          // 네이티브 정리가 먼저 닫았다.
        }
      },
    };
    closers.push(() => conn.close());

    if (offerSdp === null) attach(pc.createDataChannel('agent-chat'));
    else pc.setRemoteDescription(offerSdp, 'offer');
    await until(() => sdp !== null && candidates.length > 0, '날 pc 의 설명과 후보');
    // 같은 묶음의 나머지 후보가 모일 시간을 조금 준다.
    await sleep(30);
    return conn;
  }

  return {
    offer: () => make(null),
    answer: (offerSdp) => make(offerSdp),
    closeAll(): void {
      for (const close of closers.splice(0, closers.length)) close();
    },
  };
}
