import { afterEach, describe, expect, it, vi } from 'vitest'
import { URI, type IHostService, type ILoggerService } from '@universe-editor/platform'
import type {
  IExtHostTrustedViews,
  ITrustedViewContribution,
} from '@universe-editor/extensions-common'
import { IResourceAccessService } from '../../../../shared/ipc/resourceAccessService.js'
import { TrustedViewService } from '../TrustedViewService.js'

const EXTENSION_LOCATION = URI.file('/ext')

function viewContribution(
  overrides: Partial<ITrustedViewContribution> = {},
): ITrustedViewContribution {
  return {
    id: 'acme.status',
    name: 'Acme Status',
    location: 'view',
    container: 'explorer',
    entry: './dist/renderer/view.js',
    ...overrides,
  }
}

function editorContribution(): ITrustedViewContribution {
  return {
    id: 'acme.status',
    name: 'Acme Status',
    location: 'editor',
    entry: './dist/renderer/view.js',
  }
}

function setup(
  loader: (url: string) => Promise<unknown> = vi.fn().mockResolvedValue({ default: () => null }),
) {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const resourceAccess = { allowRoots: vi.fn().mockResolvedValue(undefined) }
  const extHost = {
    $resolveSession: vi.fn().mockResolvedValue(undefined),
    $request: vi.fn().mockResolvedValue('response'),
    $disposeSession: vi.fn().mockResolvedValue(undefined),
  } satisfies IExtHostTrustedViews
  const activateByEvent = vi.fn().mockResolvedValue(undefined)
  const service = new TrustedViewService(
    resourceAccess as unknown as IResourceAccessService,
    { createLogger: vi.fn().mockReturnValue(logger) } as unknown as ILoggerService,
    { platform: 'linux' } as IHostService,
  )
  service.setModuleLoader(loader)
  service.setExtHost(extHost, activateByEvent)
  return { service, logger, resourceAccess, extHost, activateByEvent }
}

function register(
  service: TrustedViewService,
  overrides: Partial<ITrustedViewContribution> = {},
  extensionId = 'acme.ext',
): void {
  service.registerView({
    viewId: overrides.id ?? 'acme.status',
    extensionId,
    extensionLocation: EXTENSION_LOCATION,
    contribution: viewContribution(overrides),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TrustedViewService', () => {
  it('imports the entry once, imports before render, and resolves a session', async () => {
    const loader = vi.fn().mockResolvedValue({ default: () => null })
    const { service, resourceAccess, extHost, activateByEvent } = setup(loader)
    register(service)
    service.markProviderRegistered('acme.status')

    const handle = service.beginSession('acme.status', { state: { ignored: true } })
    const component = await handle.ready

    expect(typeof component).toBe('function')
    expect(activateByEvent).toHaveBeenCalledWith('onView:acme.status')
    expect(resourceAccess.allowRoots).toHaveBeenCalledWith(['/ext/dist/renderer'])
    expect(loader.mock.calls[0]?.[0]).toContain(
      'universe-app://root/_resource_/ext/dist/renderer/view.js',
    )
    expect(extHost.$resolveSession).toHaveBeenCalledWith('acme.status', handle.sessionId, null)
    expect(handle.context.location).toBe('view')
    expect(handle.context.state).toBeUndefined()
    expect(handle.context.extensionId).toBe('acme.ext')

    handle.dispose()
    expect(extHost.$disposeSession).toHaveBeenCalledWith(handle.sessionId)
    service.dispose()
  })

  it('caches the module import per view id', async () => {
    const loader = vi.fn().mockResolvedValue({ default: () => null })
    const { service } = setup(loader)
    register(service)
    service.markProviderRegistered('acme.status')

    const first = service.beginSession('acme.status')
    const second = service.beginSession('acme.status')
    await Promise.all([first.ready, second.ready])
    expect(loader).toHaveBeenCalledTimes(1)
    first.dispose()
    second.dispose()
    service.dispose()
  })

  it('rejects an entry that escapes the extension directory', async () => {
    const { service, resourceAccess } = setup()
    register(service, { entry: '../evil.js' })
    service.markProviderRegistered('acme.status')

    const handle = service.beginSession('acme.status')
    await expect(handle.ready).rejects.toThrow(/escapes the extension directory/)
    expect(resourceAccess.allowRoots).not.toHaveBeenCalled()
    service.dispose()
  })

  it('rejects a module whose default export is not a function', async () => {
    const { service } = setup(vi.fn().mockResolvedValue({ default: {} }))
    register(service)
    service.markProviderRegistered('acme.status')

    const handle = service.beginSession('acme.status')
    await expect(handle.ready).rejects.toThrow(/default-export a React function component/)
    service.dispose()
  })

  it('routes provider requests and events into the session', async () => {
    const { service, extHost } = setup()
    register(service)
    service.markProviderRegistered('acme.status')

    const handle = service.beginSession('acme.status')
    await handle.ready
    const events: unknown[] = []
    handle.context.onEvent((name, data) => events.push([name, data]))

    await expect(handle.context.request('ping', 1, 'two')).resolves.toBe('response')
    expect(extHost.$request).toHaveBeenCalledWith(handle.sessionId, 'ping', [1, 'two'])

    service.postEvent(handle.sessionId, 'changed', { n: 2 })
    expect(events).toEqual([['changed', { n: 2 }]])

    handle.dispose()
    service.dispose()
  })

  it('waits for a provider that registers after the component mounts', async () => {
    const { service } = setup()
    service.setSessionTimeouts(1000, 1000)
    register(service)

    const handle = service.beginSession('acme.status')
    await Promise.resolve()
    service.markProviderRegistered('acme.status')
    await expect(handle.ready).resolves.toBeTypeOf('function')
    handle.dispose()
    service.dispose()
  })

  it('replays a provider announced before its view was registered', async () => {
    const { service, extHost } = setup()
    service.setSessionTimeouts(1000, 1000)
    // Startup-activated untrusted extension: the host announces the provider
    // while the renderer has not translated (or trusted) the view yet.
    service.markProviderPending('acme.ext', 'acme.status')
    register(service)

    const handle = service.beginSession('acme.status')
    await expect(handle.ready).resolves.toBeTypeOf('function')
    expect(extHost.$resolveSession).toHaveBeenCalledWith('acme.status', handle.sessionId, null)
    handle.dispose()
    service.dispose()
  })

  it('drops a deferred provider owned by another extension', async () => {
    const { service } = setup()
    service.setSessionTimeouts(25, 1000)
    service.markProviderPending('evil.ext', 'acme.status')
    register(service)

    const handle = service.beginSession('acme.status')
    await expect(handle.ready).rejects.toThrow(/no provider registered/)
    service.dispose()
  })

  it('times out when no provider ever registers', async () => {
    const { service } = setup()
    service.setSessionTimeouts(25, 1000)
    register(service)

    const handle = service.beginSession('acme.status')
    await expect(handle.ready).rejects.toThrow(/no provider registered/)
    service.dispose()
  })

  it('reports a failed session once when its view registration arrives late', async () => {
    const { service } = setup()
    service.setSessionTimeouts(1000, 25)
    const available: Array<{ viewId: string; sessionId: string }> = []
    service.onDidBecomeAvailable((event) => available.push(event))

    const handle = service.beginSession('acme.status')
    await expect(handle.ready).rejects.toThrow(/not available/)
    register(service)
    expect(available).toEqual([{ viewId: 'acme.status', sessionId: handle.sessionId }])

    // Replaying the provider must not fire a second remount for the same session.
    service.markProviderRegistered('acme.status')
    expect(available).toHaveLength(1)
    handle.dispose()
    service.dispose()
  })

  it('reports a failed session once when its provider arrives late', async () => {
    const { service } = setup()
    service.setSessionTimeouts(25, 1000)
    register(service)
    const available: Array<{ viewId: string; sessionId: string }> = []
    service.onDidBecomeAvailable((event) => available.push(event))

    const handle = service.beginSession('acme.status')
    await expect(handle.ready).rejects.toThrow(/no provider registered/)
    service.markProviderRegistered('acme.status')
    expect(available).toEqual([{ viewId: 'acme.status', sessionId: handle.sessionId }])

    handle.dispose()
    service.dispose()
  })

  it('does not disturb a healthy session when the provider re-announces', async () => {
    const { service } = setup()
    register(service)
    service.markProviderRegistered('acme.status')
    const handle = service.beginSession('acme.status')
    await handle.ready

    const available: unknown[] = []
    service.onDidBecomeAvailable((event) => available.push(event))
    service.markProviderRegistered('acme.status')
    expect(available).toEqual([])

    handle.dispose()
    service.dispose()
  })

  it('times out when the view is never registered (untrusted / missing)', async () => {
    const { service } = setup()
    service.setSessionTimeouts(1000, 25)
    const handle = service.beginSession('acme.missing')
    await expect(handle.ready).rejects.toThrow(/not available/)
    service.dispose()
  })

  it('invalidates every session on extension-host reset and lets them re-resolve', async () => {
    const { service, extHost } = setup()
    service.setSessionTimeouts(25, 1000)
    register(service)
    service.markProviderRegistered('acme.status')

    const invalidations: Array<{ viewId?: string }> = []
    service.onDidInvalidateSessions((event) => invalidations.push(event))
    const handle = service.beginSession('acme.status')
    await handle.ready

    service.reset()
    expect(invalidations).toEqual([{}])
    // The dead host must not receive a dispose call.
    expect(extHost.$disposeSession).not.toHaveBeenCalled()

    // The provider set was dropped with the host; a remount waits for re-registration.
    const remount = service.beginSession('acme.status')
    await expect(remount.ready).rejects.toThrow(/no provider registered/)
    service.dispose()
  })

  it('invalidates only the affected sessions when a provider unregisters', async () => {
    const { service } = setup()
    register(service)
    service.markProviderRegistered('acme.status')
    const handle = service.beginSession('acme.status')
    await handle.ready

    const invalidations: Array<{ viewId?: string }> = []
    service.onDidInvalidateSessions((event) => invalidations.push(event))
    service.markProviderUnregistered('acme.status')
    expect(invalidations).toEqual([{ viewId: 'acme.status' }])
    service.dispose()
  })

  it('rejects duplicate view ids', () => {
    const { service } = setup()
    register(service)
    expect(() => register(service)).toThrow(/already registered/)
    service.dispose()
  })

  it('normalizes editor state with null instead of undefined on the wire', async () => {
    const { service, extHost } = setup()
    service.registerView({
      viewId: 'acme.status',
      extensionId: 'acme.ext',
      extensionLocation: EXTENSION_LOCATION,
      contribution: editorContribution(),
    })
    service.markProviderRegistered('acme.status')

    const handle = service.beginSession('acme.status', { state: { job: 1 } })
    await handle.ready
    expect(extHost.$resolveSession).toHaveBeenCalledWith('acme.status', handle.sessionId, {
      job: 1,
    })
    expect(handle.context.state).toEqual({ job: 1 })

    const empty = service.beginSession('acme.status')
    await empty.ready
    expect(extHost.$resolveSession).toHaveBeenLastCalledWith('acme.status', empty.sessionId, null)
    expect(empty.context.state).toBeUndefined()
    handle.dispose()
    empty.dispose()
    service.dispose()
  })
})
