import { describe, expect, it, vi } from 'vitest'
import type { IChatContextProviderDto, IMainThreadChat } from '@universe-editor/extensions-common'
import type { ChatContextItem, ChatContextResolveContext } from '@universe-editor/extension-api'
import { HostChatContextRegistry } from '../hostChat.js'

function fakeMainThread() {
  return {
    $registerChatContextProvider: vi.fn((_handle: number, _provider: IChatContextProviderDto) =>
      Promise.resolve(),
    ),
    $unregisterChatContextProvider: vi.fn((_handle: number) => Promise.resolve()),
  } satisfies IMainThreadChat
}

function fakeProvider(
  resolve: (
    query: string,
    context: ChatContextResolveContext,
  ) => ChatContextItem | undefined | Promise<ChatContextItem | undefined>,
) {
  return {
    label: 'Acme Changelists…',
    description: 'Pick one',
    keywords: ['acme', 'cl'],
    resolve: (query: string, context: ChatContextResolveContext) => resolve(query, context),
  }
}

describe('HostChatContextRegistry', () => {
  it('announces the provider DTO on register and unregisters on dispose', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostChatContextRegistry(mainThread)

    const registration = registry.registerChatContextProvider(fakeProvider(() => undefined))
    expect(mainThread.$registerChatContextProvider).toHaveBeenCalledWith(1, {
      label: 'Acme Changelists…',
      description: 'Pick one',
      keywords: ['acme', 'cl'],
    })

    registration.dispose()
    expect(mainThread.$unregisterChatContextProvider).toHaveBeenCalledWith(1)
  })

  it('omits optional DTO fields the provider left undefined', () => {
    const mainThread = fakeMainThread()
    const registry = new HostChatContextRegistry(mainThread)

    registry.registerChatContextProvider({
      label: 'Bare',
      keywords: [],
      resolve: () => undefined,
    })

    // `exactOptionalPropertyTypes`: absent keys, never `undefined` values — the
    // wire drops undefined anyway, and the renderer reads `?? fallback`.
    expect(mainThread.$registerChatContextProvider).toHaveBeenCalledWith(1, {
      label: 'Bare',
      keywords: [],
    })
  })

  it('treats missing keywords as "match on the label only" instead of failing', () => {
    const mainThread = fakeMainThread()
    const registry = new HostChatContextRegistry(mainThread)

    // A plain-JS extension can leave the required-by-types array out; that must
    // not throw out of `activate()`.
    registry.registerChatContextProvider({
      label: 'Bare',
      resolve: () => undefined,
    } as never)

    expect(mainThread.$registerChatContextProvider).toHaveBeenCalledWith(1, {
      label: 'Bare',
      keywords: [],
    })
  })

  it('resolves through the registered provider and shapes the item for the wire', async () => {
    const registry = new HostChatContextRegistry(fakeMainThread())
    registry.registerChatContextProvider(
      fakeProvider((query) => ({ label: `#${query}`, text: `Perforce changelist ${query}` })),
    )

    await expect(registry.resolve(1, '1234')).resolves.toEqual({
      label: '#1234',
      text: 'Perforce changelist 1234',
    })
  })

  it('returns undefined for a cancelled pick', async () => {
    const registry = new HostChatContextRegistry(fakeMainThread())
    registry.registerChatContextProvider(fakeProvider(() => undefined))
    await expect(registry.resolve(1, 'x')).resolves.toBeUndefined()
  })

  it('forwards the session context to the provider, and an empty one when absent', async () => {
    const registry = new HostChatContextRegistry(fakeMainThread())
    const seen: ChatContextResolveContext[] = []
    registry.registerChatContextProvider(
      fakeProvider((_query, context) => {
        seen.push(context)
        return { label: 'x', text: 'y' }
      }),
    )

    await registry.resolve(1, 'cl', { sessionDir: 'X:/workspace/sub' })
    await registry.resolve(1, 'cl')
    expect(seen).toEqual([{ sessionDir: 'X:/workspace/sub' }, {}])
  })

  it('ignores handles that were never registered (or already disposed)', async () => {
    const registry = new HostChatContextRegistry(fakeMainThread())
    const registration = registry.registerChatContextProvider(
      fakeProvider(() => ({ label: 'x', text: 'y' })),
    )
    registration.dispose()

    await expect(registry.resolve(1, 'x')).resolves.toBeUndefined()
    await expect(registry.resolve(99, 'x')).resolves.toBeUndefined()
  })

  it('dispose() unregisters every live provider exactly once', () => {
    const mainThread = fakeMainThread()
    const registry = new HostChatContextRegistry(mainThread)
    const first = registry.registerChatContextProvider(fakeProvider(() => undefined))
    registry.registerChatContextProvider(fakeProvider(() => undefined))
    first.dispose()

    registry.dispose()

    expect(mainThread.$unregisterChatContextProvider.mock.calls).toEqual([[1], [2]])
  })
})
