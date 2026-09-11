/*---------------------------------------------------------------------------------------------
 *  Tests for binaryDetection — the NUL-byte heuristic, and the fail-open contract
 *  of probeIsBinary (an unreadable head must report "unknown", never "text").
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  BINARY_DETECTION_BUFFER_MAX_LEN,
  isBinaryBytes,
  probeIsBinary,
} from '../binaryDetection.js'

const uri = URI.file('/x.bin')

function headSource(result: Uint8Array | Error): { readFileHead: () => Promise<Uint8Array> } {
  return {
    async readFileHead() {
      if (result instanceof Error) throw result
      return result
    },
  }
}

describe('isBinaryBytes', () => {
  it('returns true when the buffer contains a NUL byte', () => {
    expect(isBinaryBytes(new Uint8Array([0x61, 0x00, 0x62]))).toBe(true)
  })

  it('returns false when the buffer has no NUL byte', () => {
    expect(isBinaryBytes(new Uint8Array([0x61, 0x62]))).toBe(false)
  })

  it('returns false for an empty buffer', () => {
    expect(isBinaryBytes(new Uint8Array())).toBe(false)
  })
})

describe('probeIsBinary', () => {
  it('reports text for a NUL-free head', async () => {
    expect(await probeIsBinary(headSource(new TextEncoder().encode('hello')), uri)).toBe(false)
  })

  it('reports binary for a head holding a NUL byte', async () => {
    expect(await probeIsBinary(headSource(new Uint8Array([0x7f, 0x45, 0x4c, 0x00])), uri)).toBe(
      true,
    )
  })

  it('reports unknown (undefined) when the head read fails', async () => {
    expect(await probeIsBinary(headSource(new Error('EACCES')), uri)).toBeUndefined()
  })

  it('reads an empty file as text, not binary', async () => {
    expect(await probeIsBinary(headSource(new Uint8Array()), uri)).toBe(false)
  })

  it('asks for the shared sample window', async () => {
    let asked = -1
    await probeIsBinary(
      {
        async readFileHead(_resource, maxBytes) {
          asked = maxBytes
          return new Uint8Array()
        },
      },
      uri,
    )
    expect(asked).toBe(BINARY_DETECTION_BUFFER_MAX_LEN)
  })
})
