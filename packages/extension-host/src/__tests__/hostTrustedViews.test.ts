import { describe, expect, it, vi } from 'vitest'
import { CancellationToken } from '@universe-editor/platform'
import type { TrustedViewProvider, TrustedViewSession } from '@universe-editor/extension-api'
import type { IMainThreadTrustedViews } from '@universe-editor/extensions-common'
import type { IScannedExtension } from '../extensionScanner.js'
import { HostTrustedViewsRegistry } from '../hostTrustedViews.js'

function fakeMainThread() {
  return {
    $registerProvider: vi.fn(() => Promise.resolve()),
    $unregisterProvider: vi.fn(() => Promise.resolve()),
    $postEvent: vi.fn(() => Promise.resolve()),
    $openEditor: vi.fn(() => Promise.resolve()),
  } satisfies IMainThreadTrustedViews
}

function extension(id: string, viewIds: string[]): IScannedExtension {
  return {
    id,
    extensionPath: `/ext/${id}`,
    builtin: false,
    manifest: {
      name: id,
      version: '1.0.0',
      publisher: 'test',
      engines: { universe: '*' },
      contributes: {
        trustedViews: viewIds.map((viewId) => ({
          id: viewId,
          name: viewId,
          location: 'view' as const,
          container: 'test',
          entry: './dist/view.js',
        })),
      },
    },
  }
}

function provider(
  overrides: Partial<TrustedViewProvider> = {},
): TrustedViewProvider & { requests: unknown[][] } {
  const requests: unknown[][] = []
  return {
    requests,
    handleRequest: (session, method, args, token) => {
      requests.push([session.id, method, args, token])
      return { method, args }
    },
    ...overrides,
  }
}

const VIEW_ID = 'test.status'
const EXT_ID = 'test.ext'

function setup(exts = [extension(EXT_ID, [VIEW_ID])]) {
  const mainThread = fakeMainThread()
  const registry = new HostTrustedViewsRegistry(mainThread, exts)
  return { mainThread, registry }
}

describe('HostTrustedViewsRegistry', () => {
  it('rejects a view id no manifest declares', () => {
    const { registry } = setup()
    expect(() => registry.registerProvider(EXT_ID, 'unknown.view', provider())).toThrow(
      /not declared/,
    )
  })

  it('rejects a view id declared by another extension', () => {
    const { registry } = setup([
      extension(EXT_ID, [VIEW_ID]),
      extension('other.ext', ['other.view']),
    ])
    expect(() => registry.registerProvider('other.ext', VIEW_ID, provider())).toThrow(
      /not declared by extension "other.ext"/,
    )
  })

  it('rejects every registration for an id two extensions declare, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { registry } = setup([extension(EXT_ID, [VIEW_ID]), extension('other.ext', [VIEW_ID])])
    expect(() => registry.registerProvider(EXT_ID, VIEW_ID, provider())).toThrow(
      /declared by multiple extensions/,
    )
    expect(() => registry.registerProvider('other.ext', VIEW_ID, provider())).toThrow(
      /declared by multiple extensions/,
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(VIEW_ID))
    warn.mockRestore()
  })

  it('announces the owning extension and rejects a duplicate', () => {
    const { mainThread, registry } = setup()
    registry.registerProvider(EXT_ID, VIEW_ID, provider())
    expect(mainThread.$registerProvider).toHaveBeenCalledWith(EXT_ID, VIEW_ID)
    expect(() => registry.registerProvider(EXT_ID, VIEW_ID, provider())).toThrow(
      /already registered/,
    )
  })

  it('createApi binds every call to the extension that owns the context', async () => {
    const { mainThread, registry } = setup([
      extension(EXT_ID, [VIEW_ID]),
      extension('other.ext', ['other.view']),
    ])
    const api = registry.createApi(EXT_ID)
    const registration = api.registerProvider(VIEW_ID, provider())
    expect(mainThread.$registerProvider).toHaveBeenCalledWith(EXT_ID, VIEW_ID)

    expect(() => registry.createApi('other.ext').registerProvider(VIEW_ID, provider())).toThrow(
      /not declared by extension "other.ext"/,
    )

    await api.openEditor(VIEW_ID, { key: 'k' })
    expect(mainThread.$openEditor).toHaveBeenCalledWith(EXT_ID, VIEW_ID, expect.any(Object))
    registration.dispose()
  })

  it('rejects resolveSession when no provider is registered', async () => {
    const { registry } = setup()
    await expect(registry.resolveSession(VIEW_ID, 's1', undefined)).rejects.toThrow(
      /no trusted view provider/,
    )
  })

  it('creates a session, calls resolveSession and routes requests with a token', async () => {
    const { registry } = setup()
    const resolveSession = vi.fn()
    const p = provider({ resolveSession })
    registry.registerProvider(EXT_ID, VIEW_ID, p)

    await registry.resolveSession(VIEW_ID, 's1', { tab: 1 })
    expect(resolveSession).toHaveBeenCalledTimes(1)
    const session = resolveSession.mock.calls[0]?.[0] as TrustedViewSession
    expect(session.id).toBe('s1')
    expect(session.viewId).toBe(VIEW_ID)
    expect(session.state).toEqual({ tab: 1 })

    await expect(registry.request('s1', 'ping', [1, 'a'], CancellationToken.None)).resolves.toEqual(
      { method: 'ping', args: [1, 'a'] },
    )
    expect(p.requests[0]?.[0]).toBe('s1')
  })

  it('does not keep a session whose resolveSession threw', async () => {
    const { registry } = setup()
    const resolveSession = vi.fn(() => {
      throw new Error('init failed')
    })
    registry.registerProvider(EXT_ID, VIEW_ID, provider({ resolveSession }))
    await expect(registry.resolveSession(VIEW_ID, 's1', undefined)).rejects.toThrow(/init failed/)
    await expect(registry.request('s1', 'ping', [])).rejects.toThrow(/unknown trusted view session/)
  })

  it('posts session events through the main thread', async () => {
    const { mainThread, registry } = setup()
    const resolveSession = vi.fn()
    registry.registerProvider(EXT_ID, VIEW_ID, provider({ resolveSession }))
    await registry.resolveSession(VIEW_ID, 's1', undefined)
    const session = resolveSession.mock.calls[0]?.[0] as TrustedViewSession

    session.postEvent('stateChanged', { busy: true })
    expect(mainThread.$postEvent).toHaveBeenCalledWith('s1', 'stateChanged', { busy: true })
  })

  it('fires onDidDispose and drops the session on disposeSession', async () => {
    const { registry } = setup()
    const resolveSession = vi.fn()
    registry.registerProvider(EXT_ID, VIEW_ID, provider({ resolveSession }))
    await registry.resolveSession(VIEW_ID, 's1', undefined)
    const session = resolveSession.mock.calls[0]?.[0] as TrustedViewSession
    const onDispose = vi.fn()
    session.onDidDispose(onDispose)

    registry.disposeSession('s1')
    expect(onDispose).toHaveBeenCalledTimes(1)
    await expect(registry.request('s1', 'ping', [])).rejects.toThrow(/unknown trusted view session/)
    registry.disposeSession('s1')
    expect(onDispose).toHaveBeenCalledTimes(1)
  })

  it('disposes sessions when the provider unregisters', async () => {
    const { mainThread, registry } = setup()
    const resolveSession = vi.fn()
    const registration = registry.registerProvider(EXT_ID, VIEW_ID, provider({ resolveSession }))
    await registry.resolveSession(VIEW_ID, 's1', undefined)
    const session = resolveSession.mock.calls[0]?.[0] as TrustedViewSession
    const onDispose = vi.fn()
    session.onDidDispose(onDispose)

    registration.dispose()
    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(mainThread.$unregisterProvider).toHaveBeenCalledWith(VIEW_ID)
  })

  it('openEditor maps options to the wire DTO', async () => {
    const { mainThread, registry } = setup()
    await registry.openEditor(EXT_ID, VIEW_ID, {
      title: 'Status',
      key: 'k',
      preserveFocus: true,
    })
    expect(mainThread.$openEditor).toHaveBeenCalledWith(EXT_ID, VIEW_ID, {
      title: 'Status',
      state: null,
      key: 'k',
      preserveFocus: true,
    })
  })

  it('openEditor rejects a view the extension does not declare', async () => {
    const { registry } = setup()
    await expect(registry.openEditor('other.ext', VIEW_ID)).rejects.toThrow(
      /not declared by extension "other.ext"/,
    )
  })
})
