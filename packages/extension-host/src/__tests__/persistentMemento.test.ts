import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createExtensionContext, type IExtensionStorage } from '../apiFactory.js'
import type { IScannedExtension } from '../extensionScanner.js'

const EXT: IScannedExtension = {
  id: 'test.ext',
  extensionPath: '/fake/path',
  manifest: { name: 'ext', version: '0.0.0', engines: { universe: '^0.1.0' } },
  mainPath: '/fake/path/main.js',
}

/** In-memory storage backend mimicking the MainThreadStorage RPC, per scope+extId. */
function fakeStorage(): IExtensionStorage & { dump(scope: 0 | 1, id: string): string | undefined } {
  const store = new Map<string, string>()
  const k = (scope: number, id: string): string => `${scope}:${id}`
  return {
    $get: (scope, id) => Promise.resolve(store.get(k(scope, id))),
    $set: (scope, id, json) => {
      store.set(k(scope, id), json)
      return Promise.resolve()
    },
    dump: (scope, id) => store.get(k(scope, id)),
  }
}

describe('persistent Memento', () => {
  it('falls back to in-memory mementos with no storage', async () => {
    const ctx = await createExtensionContext(EXT)
    await ctx.workspaceState.update('k', 1)
    expect(ctx.workspaceState.get('k')).toBe(1)
  })

  it('reads back values written before activation (in-memory mirror)', async () => {
    const storage = fakeStorage()
    await storage.$set(1, EXT.id, JSON.stringify({ slots: [1, 2, 3] }))
    const ctx = await createExtensionContext(EXT, storage)
    expect(ctx.workspaceState.get('slots')).toEqual([1, 2, 3])
  })

  it('flushes the whole object to storage on update (scope-separated)', async () => {
    const storage = fakeStorage()
    const ctx = await createExtensionContext(EXT, storage)
    await ctx.workspaceState.update('a', 1)
    await ctx.workspaceState.update('b', 2)
    await ctx.globalState.update('g', 'x')
    expect(JSON.parse(storage.dump(1, EXT.id)!)).toEqual({ a: 1, b: 2 })
    expect(JSON.parse(storage.dump(0, EXT.id)!)).toEqual({ g: 'x' })
  })

  it('deletes a key when updated to undefined', async () => {
    const storage = fakeStorage()
    const ctx = await createExtensionContext(EXT, storage)
    await ctx.workspaceState.update('a', 1)
    await ctx.workspaceState.update('a', undefined)
    expect(ctx.workspaceState.get('a')).toBeUndefined()
    expect(JSON.parse(storage.dump(1, EXT.id)!)).toEqual({})
  })

  it('tolerates malformed persisted JSON', async () => {
    const storage = fakeStorage()
    await storage.$set(1, EXT.id, '{ not valid json')
    const ctx = await createExtensionContext(EXT, storage)
    expect(ctx.workspaceState.get('x')).toBeUndefined()
  })

  it('derives globalStoragePath as <home>/<extId>, empty when no home', async () => {
    const withHome = await createExtensionContext(EXT, fakeStorage(), join('/storage/home'))
    expect(withHome.globalStoragePath).toBe(join('/storage/home', 'test.ext'))
    const withoutHome = await createExtensionContext(EXT, fakeStorage())
    expect(withoutHome.globalStoragePath).toBe('')
  })
})
