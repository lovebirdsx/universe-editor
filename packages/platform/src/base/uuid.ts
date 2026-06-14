/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RFC 4122 v4 UUID generation. Prefers the platform `crypto.randomUUID` (present
 *  in both Electron's renderer and a modern Node main process); falls back to a
 *  Math.random-based generator only where `crypto` is unavailable.
 *--------------------------------------------------------------------------------------------*/

interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T
}

const _crypto: CryptoLike | undefined = (globalThis as { crypto?: CryptoLike }).crypto

const _hex: string[] = []
for (let i = 0; i < 256; i++) {
  _hex.push(i.toString(16).padStart(2, '0'))
}

function fillRandom(bytes: Uint8Array): void {
  if (_crypto?.getRandomValues) {
    _crypto.getRandomValues(bytes)
    return
  }
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
}

export function generateUuid(): string {
  if (_crypto?.randomUUID) {
    return _crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  fillRandom(bytes)
  // Set the version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  let result = ''
  result += _hex[bytes[0]!]
  result += _hex[bytes[1]!]
  result += _hex[bytes[2]!]
  result += _hex[bytes[3]!]
  result += '-'
  result += _hex[bytes[4]!]
  result += _hex[bytes[5]!]
  result += '-'
  result += _hex[bytes[6]!]
  result += _hex[bytes[7]!]
  result += '-'
  result += _hex[bytes[8]!]
  result += _hex[bytes[9]!]
  result += '-'
  result += _hex[bytes[10]!]
  result += _hex[bytes[11]!]
  result += _hex[bytes[12]!]
  result += _hex[bytes[13]!]
  result += _hex[bytes[14]!]
  result += _hex[bytes[15]!]
  return result
}
