import { describe, expect, it, vi } from 'vitest'
import type {
  IChatContextItemDto,
  IChatContextProviderDto,
  IExtHostChat,
} from '@universe-editor/extensions-common'
import { ChatContextService } from '../ChatContextService.js'

function providerDto(label: string): IChatContextProviderDto {
  return { label, keywords: [label] }
}

function fakeExtHost(item: IChatContextItemDto | undefined = undefined) {
  return {
    $resolveChatContextItem: vi.fn((_handle: number, _query: string) => Promise.resolve(item)),
  } satisfies IExtHostChat
}

describe('ChatContextService', () => {
  it('tracks provider registrations, including a no-op unregister', async () => {
    const service = new ChatContextService()

    expect(service.getProviders()).toEqual([])
    await service.$registerChatContextProvider(1, providerDto('Acme'))
    expect(service.getProviders()).toEqual([{ handle: 1, provider: providerDto('Acme') }])

    await service.$unregisterChatContextProvider(1)
    expect(service.getProviders()).toEqual([])
    // An unknown handle is a no-op.
    await service.$unregisterChatContextProvider(1)
    expect(service.getProviders()).toEqual([])
  })

  it('resolves an accepted entry through the ext host', async () => {
    const service = new ChatContextService()
    const extHost = fakeExtHost({ label: '#1234', text: 'Perforce changelist 1234' })
    service.setExtHost(extHost)
    await service.$registerChatContextProvider(7, providerDto('Acme'))

    await expect(service.resolveItem(7, 'acme')).resolves.toEqual({
      label: '#1234',
      text: 'Perforce changelist 1234',
    })
    expect(extHost.$resolveChatContextItem).toHaveBeenCalledWith(7, 'acme')
  })

  it('never calls the host for an unknown handle (provider vanished mid-flight)', async () => {
    const service = new ChatContextService()
    const extHost = fakeExtHost({ label: 'x', text: 'y' })
    service.setExtHost(extHost)

    await expect(service.resolveItem(7, 'acme')).resolves.toBeUndefined()
    expect(extHost.$resolveChatContextItem).not.toHaveBeenCalled()
  })

  it('reports undefined instead of throwing when the provider blows up', async () => {
    const service = new ChatContextService()
    service.setExtHost({
      $resolveChatContextItem: vi.fn(() => Promise.reject(new Error('picker died'))),
    })
    await service.$registerChatContextProvider(1, providerDto('Acme'))

    await expect(service.resolveItem(1, 'acme')).resolves.toBeUndefined()
  })

  it('reset drops providers and the proxy (a teardown leaves nothing to resolve)', async () => {
    const service = new ChatContextService()
    const extHost = fakeExtHost({ label: 'x', text: 'y' })
    service.setExtHost(extHost)
    await service.$registerChatContextProvider(1, providerDto('Acme'))

    service.reset()

    expect(service.getProviders()).toEqual([])
    await expect(service.resolveItem(1, 'acme')).resolves.toBeUndefined()
    expect(extHost.$resolveChatContextItem).not.toHaveBeenCalled()
  })
})
