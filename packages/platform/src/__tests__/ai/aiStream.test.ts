/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiStream.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { toDisposable } from '../../base/lifecycle.js'
import { AiResponseReassembler } from '../../ai/aiStream.js'
import { getTextResponse } from '../../ai/aiModelService.js'
import type { AiResponseChunk } from '../../ai/aiModelTypes.js'

describe('AiResponseReassembler', () => {
  it('reassembles text chunks into the stream and resolves result with usage', async () => {
    const r = new AiResponseReassembler()
    const collected: AiResponseChunk[] = []
    const drain = (async () => {
      for await (const c of r.response.stream) collected.push(c)
    })()

    r.acceptChunk({ type: 'text', value: 'Hello ' })
    r.acceptChunk({ type: 'text', value: 'world' })
    r.acceptChunk({ type: 'usage', inputTokens: 5, outputTokens: 2 })
    r.acceptEnd()

    await drain
    expect(
      collected.filter((c) => c.type === 'text').map((c) => (c as { value: string }).value),
    ).toEqual(['Hello ', 'world'])
    await expect(r.response.result).resolves.toEqual({ usage: { inputTokens: 5, outputTokens: 2 } })
  })

  it('acceptEnd(error) rejects both stream and result', async () => {
    const r = new AiResponseReassembler()
    r.acceptChunk({ type: 'text', value: 'partial' })
    r.acceptEnd(new Error('boom'))

    await expect(
      (async () => {
        for await (const _ of r.response.stream) {
          // drain
        }
      })(),
    ).rejects.toThrow('boom')
    await expect(r.response.result).rejects.toThrow('boom')
  })

  it('disposes bound subscriptions on end', () => {
    const r = new AiResponseReassembler()
    const dispose = vi.fn()
    r.bindSubscriptions(toDisposable(dispose))
    r.acceptEnd()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('binding subscriptions after end disposes immediately', () => {
    const r = new AiResponseReassembler()
    r.acceptEnd()
    const dispose = vi.fn()
    r.bindSubscriptions(toDisposable(dispose))
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('ignores chunks after end', async () => {
    const r = new AiResponseReassembler()
    r.acceptChunk({ type: 'text', value: 'a' })
    r.acceptEnd()
    r.acceptChunk({ type: 'text', value: 'b' })
    expect(await getTextResponse(r.response)).toBe('a')
  })
})

describe('getTextResponse', () => {
  it('returns partial text when the stream errors after yielding', async () => {
    const r = new AiResponseReassembler()
    r.acceptChunk({ type: 'text', value: 'partial' })
    r.acceptEnd(new Error('late failure'))
    expect(await getTextResponse(r.response)).toBe('partial')
  })

  it('throws when the stream errors with no text yielded', async () => {
    const r = new AiResponseReassembler()
    r.acceptEnd(new Error('immediate'))
    await expect(getTextResponse(r.response)).rejects.toThrow('immediate')
  })
})
