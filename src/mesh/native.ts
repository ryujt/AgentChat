// node-datachannel 네이티브 API 가운데 mesh 가 쓰는 부분. polyfill 은 쓰지 않는다(architecture.md 3.6).
// 네이티브 모듈은 createMesh 가 불릴 때 처음 불러온다. 프로세스 시작을 실패시키지 않으려는 것이다.

import type { IceServers } from '../protocol/index.js';

export interface NativeChannel {
  close(): void;
  sendMessage(text: string): boolean;
  isOpen(): boolean;
  getLabel(): string;
  onOpen(callback: () => void): void;
  onClosed(callback: () => void): void;
  onError(callback: (error: string) => void): void;
  onMessage(callback: (message: string | Buffer | ArrayBuffer) => void): void;
}

export interface NativePeer {
  close(): void;
  /** offer 를 넣으면 answer 가 저절로 만들어져 onLocalDescription 으로 온다. */
  setRemoteDescription(sdp: string, type: 'offer' | 'answer'): void;
  /** 원격 설명을 넣기 전에 부르면 던진다. */
  addRemoteCandidate(candidate: string, mid: string): void;
  /** 채널을 만들면 offer 가 저절로 만들어져 onLocalDescription 으로 온다. */
  createDataChannel(label: string): NativeChannel;
  state(): string;
  iceState(): string;
  onLocalDescription(callback: (sdp: string, type: string) => void): void;
  onLocalCandidate(callback: (candidate: string, mid: string) => void): void;
  onStateChange(callback: (state: string) => void): void;
  onDataChannel(callback: (channel: NativeChannel) => void): void;
}

export interface NativeRtc {
  createPeer(name: string, iceServers: IceServers): NativePeer;
  /**
   * 프로세스 전체의 네이티브 정리다. 이 프로세스의 모든 pc 를 닫는다.
   * 상대가 닫아 closed 가 됐는데 이쪽에서 close() 를 부르지 않은 pc 가 하나라도 있으면 10초 멈춘 뒤 던진다(실측).
   */
  cleanup(): void;
}

export type LoadNative = () => Promise<NativeRtc>;

export const loadNative: LoadNative = async () => {
  const lib = await import('node-datachannel');
  return {
    createPeer: (name, iceServers) =>
      // url 문자열이 아니라 {hostname, port} 로 넘긴다. 고정한 라이브러리는 대괄호가 든 IPv6 URL 에 던진다.
      // 사용자 이름·암호·중계 종류는 넣지 않는다.
      new lib.PeerConnection(name, {
        iceServers: iceServers.map((server) => ({ hostname: server.hostname, port: server.port })),
      }),
    cleanup: () => lib.cleanup(),
  };
};
