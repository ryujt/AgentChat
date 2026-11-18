import type { LoadNative, NativeChannel, NativePeer } from '../src/mesh/native.js';
import type { IceServers } from '../src/protocol/index.js';

function wrapChannel(channel: RTCDataChannel): NativeChannel {
  return {
    close: () => channel.close(),
    sendMessage(text) {
      if (channel.readyState !== 'open') return false;
      try {
        channel.send(text);
        return true;
      } catch {
        return false;
      }
    },
    isOpen: () => channel.readyState === 'open',
    getLabel: () => channel.label,
    onOpen: (callback) => channel.addEventListener('open', callback),
    onClosed: (callback) => channel.addEventListener('close', callback),
    onError: (callback) => channel.addEventListener('error', () => callback('data channel error')),
    onMessage: (callback) => channel.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') callback(data);
    }),
  };
}

function wrapPeer(peer: RTCPeerConnection, forget: () => void): NativePeer {
  let operations = Promise.resolve();
  let localDescription: (sdp: string, type: string) => void = () => {};
  let onState: (state: string) => void = () => {};

  // The mesh uses a synchronous native API. Keep the browser operations in
  // that same order when signaling delivers candidates before SDP has resolved.
  function enqueue(operation: () => Promise<void>) {
    operations = operations.then(async () => {
      if (peer.signalingState !== 'closed') await operation();
    }).catch(() => {
      if (peer.signalingState !== 'closed') onState('failed');
    });
  }

  async function publish(description: RTCSessionDescriptionInit) {
    await peer.setLocalDescription(description);
    if (peer.signalingState !== 'closed' && description.sdp) {
      localDescription(description.sdp, description.type);
    }
  }

  peer.addEventListener('connectionstatechange', () => onState(peer.connectionState));
  peer.addEventListener('iceconnectionstatechange', () => {
    if (peer.iceConnectionState === 'failed') onState('failed');
  });

  return {
    close() {
      peer.close();
      forget();
    },
    setRemoteDescription(sdp, type) {
      enqueue(async () => {
        await peer.setRemoteDescription({ sdp, type });
        if (type === 'offer') await publish(await peer.createAnswer());
      });
    },
    addRemoteCandidate(candidate, sdpMid) {
      enqueue(async () => {
        try {
          await peer.addIceCandidate({ candidate, sdpMid });
        } catch {
          // As with native ICE, a rejected individual candidate is nonfatal.
        }
      });
    },
    createDataChannel(label) {
      const channel = wrapChannel(peer.createDataChannel(label));
      enqueue(async () => publish(await peer.createOffer()));
      return channel;
    },
    state: () => peer.connectionState,
    iceState: () => peer.iceConnectionState,
    onLocalDescription: (callback) => { localDescription = callback; },
    onLocalCandidate: (callback) => peer.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate?.candidate && candidate.sdpMid !== null) callback(candidate.candidate, candidate.sdpMid);
    }),
    onStateChange: (callback) => { onState = callback; },
    onDataChannel: (callback) => peer.addEventListener('datachannel', ({ channel }) => callback(wrapChannel(channel))),
  };
}

export const loadBrowserRtc: LoadNative = async () => {
  if (typeof RTCPeerConnection !== 'function') throw new Error('WebRTC is unavailable');
  const peers = new Set<NativePeer>();

  return {
    createPeer(_name: string, iceServers: IceServers) {
      const peer = new RTCPeerConnection({ iceServers: iceServers.map(({ url }) => ({ urls: url })) });
      const wrapper = wrapPeer(peer, () => peers.delete(wrapper));
      peers.add(wrapper);
      return wrapper;
    },
    cleanup() {
      for (const peer of peers) peer.close();
    },
  };
};
