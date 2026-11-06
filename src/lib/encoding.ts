// Pure encoding helpers that can be exercised without starting the application server.

const ENCODER = new TextEncoder();

export function utf8Encode(s: string): Uint8Array {
  return ENCODER.encode(s);
}

export function utf8ByteLength(s: string): number {
  return ENCODER.encode(s).byteLength;
}

// Use a runtime-native base64 method when available, with a bounded fallback
// for Node 22 and runtimes whose TypeScript lib does not expose it.
type Uint8ArrayWithBase64 = Uint8Array & { toBase64?: () => string };

export function bufferToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8ArrayWithBase64).toBase64;
  return typeof native === "function" ? native.call(bytes) : bufferToBase64Chunked(bytes);
}

/** Fallback for runtimes without toBase64. Exported so tests always cover it. */
export function bufferToBase64Chunked(bytes: Uint8Array): string {
  let bin = "";
  // String.fromCharCode(...spread) overflows the argument limit on large
  // buffers, so build the binary string in bounded chunks.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
