import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '../bytes.js'

describe('base64 round-trip', () => {
  it('round-trips an empty array', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('')
    expect(base64ToBytes('')).toEqual(new Uint8Array())
  })

  it('round-trips small binary content', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 127, 128])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('round-trips content spanning the 0x8000 chunk boundary', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('encodes to standard base64', () => {
    // "hi" → 0x68 0x69 → "aGk="
    expect(bytesToBase64(new Uint8Array([0x68, 0x69]))).toBe('aGk=')
    expect(base64ToBytes('aGk=')).toEqual(new Uint8Array([0x68, 0x69]))
  })
})
