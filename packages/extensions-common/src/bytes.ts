/**
 * Base64 codecs for moving binary file contents across the newline-delimited
 * JSON RPC framing (which can't carry a raw `Uint8Array`). Works in both the
 * Node-based extension host and the browser-based renderer via the global
 * `btoa`/`atob` (present in Node ≥16 and in the DOM).
 */

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
