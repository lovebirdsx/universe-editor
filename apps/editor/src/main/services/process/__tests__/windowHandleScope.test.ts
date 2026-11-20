import { describe, expect, it } from 'vitest'
import { Emitter } from '@universe-editor/platform'
import { WindowHandleScope } from '../windowHandleScope.js'

interface Chunk {
  readonly handle: string
  readonly data: string
}

describe('WindowHandleScope', () => {
  it('passes events through while a start is in flight, then only tracked handles', async () => {
    const scope = new WindowHandleScope()
    const emitter = new Emitter<Chunk>()
    const seen: string[] = []
    const sub = scope.filter(emitter.event)((c) => seen.push(c.data))

    let resolve!: (r: { handle: string }) => void
    const started = scope.track(new Promise<{ handle: string }>((r) => (resolve = r)))
    emitter.fire({ handle: 'mine', data: 'early' })
    resolve({ handle: 'mine' })
    await started
    emitter.fire({ handle: 'mine', data: 'later' })
    emitter.fire({ handle: 'other', data: 'foreign' })

    expect(seen).toEqual(['early', 'later'])
    sub.dispose()
    emitter.dispose()
  })

  it('stops filtering-in a handle after its exit reached every listener', async () => {
    const scope = new WindowHandleScope()
    const exit = new Emitter<Chunk>()
    const seen: string[] = []
    const onExit = scope.filterExit(exit.event)
    const subs = [onExit((e) => seen.push(`a:${e.data}`)), onExit((e) => seen.push(`b:${e.data}`))]
    await scope.track(Promise.resolve({ handle: 'h' }))

    exit.fire({ handle: 'h', data: '1' })
    await Promise.resolve()
    exit.fire({ handle: 'h', data: '2' })

    expect(seen).toEqual(['a:1', 'b:1'])
    for (const s of subs) s.dispose()
    exit.dispose()
  })

  it('does not stay in pass-through mode after a failed start', async () => {
    const scope = new WindowHandleScope()
    const emitter = new Emitter<Chunk>()
    const seen: string[] = []
    const sub = scope.filter(emitter.event)((c) => seen.push(c.data))

    await expect(scope.track(Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    emitter.fire({ handle: 'x', data: 'stray' })

    expect(seen).toEqual([])
    sub.dispose()
    emitter.dispose()
  })
})
