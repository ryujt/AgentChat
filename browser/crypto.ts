import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));

// The shared protocol uses Node's synchronous SHA-256 interface.
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error('Unsupported hash');
  const hash = sha256.create();
  return {
    update(text: string) {
      hash.update(new TextEncoder().encode(text));
      return this;
    },
    digest(encoding: string) {
      if (encoding !== 'hex') throw new Error('Unsupported hash encoding');
      return bytesToHex(hash.digest());
    },
  };
}
