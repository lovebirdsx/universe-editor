/*---------------------------------------------------------------------------------------------
 *  Tests for WebviewDiffInput's serialize/deserialize round-trip. The history,
 *  Ctrl+Shift+T and workspace-restore paths rebuild the comparison from the
 *  persisted base64 bytes without reading either side from disk.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { WEBVIEW_DIFF_PERSIST_BUDGET_BYTES, WebviewDiffInput } from '../WebviewDiffInput.js'

const LEFT_URI = URI.parse('swarm:///101/main/src/book.xlsx?l=')
const RIGHT_URI = URI.parse('swarm:///101/main/src/book.xlsx?r=9001')

function makeInput(
  left = new Uint8Array([1, 2, 3]),
  right = new Uint8Array([0, 255]),
): WebviewDiffInput {
  return new WebviewDiffInput('universe.excel', LEFT_URI, RIGHT_URI, left, right, 'book.xlsx')
}

describe('WebviewDiffInput serialize/deserialize', () => {
  it('round-trips view type, title, URIs and both byte sides', () => {
    const input = makeInput()
    const revived = WebviewDiffInput.deserialize(input.serialize())

    expect(revived).toBeInstanceOf(WebviewDiffInput)
    expect(revived!.viewType).toBe(input.viewType)
    expect(revived!.title).toBe(input.title)
    expect(revived!.leftUri.toString()).toBe(input.leftUri.toString())
    expect(revived!.rightUri.toString()).toBe(input.rightUri.toString())
    expect(Array.from(revived!.left)).toEqual([1, 2, 3])
    expect(Array.from(revived!.right)).toEqual([0, 255])
    expect(revived!.id).toBe(input.id)
    expect(revived!.resource.toString()).toBe(input.resource.toString())
    expect(revived!.getName()).toBe(input.getName())
  })

  it('round-trips empty and high-byte sides', () => {
    const input = makeInput(new Uint8Array(0), new Uint8Array([0x00, 0xff, 0x80]))
    const revived = WebviewDiffInput.deserialize(input.serialize())
    expect(revived!.left).toHaveLength(0)
    expect(Array.from(revived!.right)).toEqual([0x00, 0xff, 0x80])
  })

  it('caches the base64 encoding across serializations', () => {
    const input = makeInput()
    expect(input.serialize().leftBase64).toBe(input.serialize().leftBase64)
    expect(input.serialize().rightBase64).toBe(input.serialize().rightBase64)
  })

  it('persists the bytes within the budget and drops them over budget', () => {
    const small = makeInput()
    const budgeted = small.serializeForPersistence(WEBVIEW_DIFF_PERSIST_BUDGET_BYTES)
    expect('contentDropped' in budgeted).toBe(false)
    expect(budgeted).toEqual(small.serialize())

    const big = makeInput(new Uint8Array(WEBVIEW_DIFF_PERSIST_BUDGET_BYTES), new Uint8Array(0))
    const dropped = big.serializeForPersistence(WEBVIEW_DIFF_PERSIST_BUDGET_BYTES)
    expect(dropped.contentDropped).toBe(true)
    expect(dropped.leftBase64).toBe('')
    expect(WebviewDiffInput.deserialize(dropped)).toBeNull()
  })

  it('rejects corrupt or incomplete payloads', () => {
    const valid = makeInput().serialize()
    const cases: unknown[] = [
      null,
      undefined,
      {},
      { ...valid, viewType: '' },
      { ...valid, title: 42 },
      { ...valid, leftUri: undefined },
      { ...valid, rightUri: null },
      { ...valid, leftBase64: undefined },
      { ...valid, rightBase64: 7 },
      { ...valid, leftBase64: '!!!' },
      { ...valid, contentDropped: true },
    ]
    for (const data of cases) {
      expect(WebviewDiffInput.deserialize(data)).toBeNull()
    }
  })
})
