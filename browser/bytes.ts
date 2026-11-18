const encoder = new TextEncoder();

class ResumeKeyBytes extends Uint8Array {
  override toString(encoding?: 'base64url'): string {
    if (encoding !== 'base64url') return super.toString();
    return btoa(String.fromCharCode(...this)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }
}

// Module-scoped esbuild injection for the three Buffer operations used by
// shared protocol code. The Node build still uses Node's own implementation.
export const Buffer = {
  byteLength: (text: string) => encoder.encode(text).length,
  from(value: string | Uint8Array) {
    return typeof value === 'string' ? encoder.encode(value) : new ResumeKeyBytes(value);
  },
  compare(a: Uint8Array, b: Uint8Array) {
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  },
};
