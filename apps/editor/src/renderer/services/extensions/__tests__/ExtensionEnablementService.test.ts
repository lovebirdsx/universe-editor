import { describe, expect, it, vi } from 'vitest'
import { Emitter, REMOTE_SCHEME } from '@universe-editor/platform'
import type { IStorageService, IWorkspaceService, IWorkspace } from '@universe-editor/platform'
import type { IExtensionManagementService } from '../../../../shared/ipc/extensionManagementService.js'
import { ExtensionEnablementService, EnablementState } from '../ExtensionEnablementService.js'

/** In-memory storage keyed by scope, good enough for enablement's WORKSPACE reads. */
function makeStorage() {
  const workspace = new Map<string, unknown>()
  const onDidChangeWorkspaceScope = new Emitter<void>()
  const storage = {
    onDidChangeWorkspaceScope: onDidChangeWorkspaceScope.event,
    get: vi.fn(async (key: string) => workspace.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      workspace.set(key, value)
    }),
    remove: vi.fn(async (key: string) => {
      workspace.delete(key)
    }),
  } as unknown as IStorageService
  return { storage, workspace, onDidChangeWorkspaceScope }
}

function makeMocks(
  opts: { hasWorkspace?: boolean; globalDisabled?: string[]; authority?: string } = {},
) {
  const globalDisabled = new Set(opts.globalDisabled ?? [])
  const onDidChangeExtensions = new Emitter<void>()
  const calls: { id: string; enabled: boolean; authority: string | undefined }[] = []
  const management = {
    onDidChangeExtensions: onDidChangeExtensions.event,
    getDisabledIds: vi.fn(async (_authority?: string) => [...globalDisabled]),
    setEnablement: vi.fn(async (id: string, enabled: boolean, authority?: string) => {
      calls.push({ id, enabled, authority })
      if (enabled) globalDisabled.delete(id)
      else globalDisabled.add(id)
    }),
  } as unknown as IExtensionManagementService
  const { storage, workspace } = makeStorage()
  const onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  const current: IWorkspace | null = opts.hasWorkspace
    ? ({
        folder: {
          fsPath: '/ws',
          scheme: opts.authority !== undefined ? REMOTE_SCHEME : 'file',
          ...(opts.authority !== undefined ? { authority: opts.authority } : {}),
        },
      } as unknown as IWorkspace)
    : null
  const workspaceService = {
    current,
    whenReady: Promise.resolve(),
    onDidChangeWorkspace: onDidChangeWorkspace.event,
  } as unknown as IWorkspaceService
  return {
    management,
    storage,
    workspace,
    workspaceService,
    globalDisabled,
    calls,
    onDidChangeWorkspace,
  }
}

function makeService(mocks: ReturnType<typeof makeMocks>): ExtensionEnablementService {
  return new ExtensionEnablementService(mocks.management, mocks.storage, mocks.workspaceService)
}

describe('ExtensionEnablementService', () => {
  it('defaults to EnabledGlobally', async () => {
    const svc = makeService(makeMocks())
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.EnabledGlobally)
    expect(await svc.isEnabled('a.b')).toBe(true)
  })

  it('reflects a global disable', async () => {
    const svc = makeService(makeMocks({ globalDisabled: ['a.b'] }))
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.DisabledGlobally)
    expect(await svc.isEnabled('a.b')).toBe(false)
  })

  it('writes global enable/disable through management', async () => {
    const mocks = makeMocks()
    const svc = makeService(mocks)
    await svc.setEnablement('a.b', EnablementState.DisabledGlobally)
    expect(mocks.calls).toEqual([{ id: 'a.b', enabled: false, authority: undefined }])
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.DisabledGlobally)

    await svc.setEnablement('a.b', EnablementState.EnabledGlobally)
    expect(mocks.calls).toEqual([
      { id: 'a.b', enabled: false, authority: undefined },
      { id: 'a.b', enabled: true, authority: undefined },
    ])
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.EnabledGlobally)
  })

  it('throws for workspace scope when no folder is open', async () => {
    const svc = makeService(makeMocks({ hasWorkspace: false }))
    await expect(svc.setEnablement('a.b', EnablementState.DisabledWorkspace)).rejects.toThrow()
    expect(svc.canChangeWorkspaceEnablement()).toBe(false)
  })

  it('workspace disable overrides global enable', async () => {
    const mocks = makeMocks({ hasWorkspace: true })
    const svc = makeService(mocks)
    await svc.setEnablement('a.b', EnablementState.DisabledWorkspace)
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.DisabledWorkspace)
    expect(await svc.isEnabled('a.b')).toBe(false)
  })

  it('workspace enable overrides global disable', async () => {
    const mocks = makeMocks({ hasWorkspace: true, globalDisabled: ['a.b'] })
    const svc = makeService(mocks)
    await svc.setEnablement('a.b', EnablementState.EnabledWorkspace)
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.EnabledWorkspace)
    expect(await svc.isEnabled('a.b')).toBe(true)
    // Effective disabled must NOT include it (workspace enable wins).
    expect(await svc.getEffectiveDisabledIds()).not.toContain('a.b')
  })

  it('computes effective disabled ids merging global + workspace', async () => {
    const mocks = makeMocks({ hasWorkspace: true, globalDisabled: ['g.only'] })
    const svc = makeService(mocks)
    await svc.setEnablement('w.only', EnablementState.DisabledWorkspace)
    const effective = await svc.getEffectiveDisabledIds()
    expect(new Set(effective)).toEqual(new Set(['g.only', 'w.only']))
  })

  it('setting global enablement clears a prior workspace override', async () => {
    const mocks = makeMocks({ hasWorkspace: true })
    const svc = makeService(mocks)
    await svc.setEnablement('a.b', EnablementState.DisabledWorkspace)
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.DisabledWorkspace)
    await svc.setEnablement('a.b', EnablementState.EnabledGlobally)
    // Workspace override gone → resolves to the global state.
    expect(await svc.getEnablementState('a.b')).toBe(EnablementState.EnabledGlobally)
  })

  it('fires onDidChangeEnablement on set', async () => {
    const svc = makeService(makeMocks())
    const fired = vi.fn()
    svc.onDidChangeEnablement(fired)
    await svc.setEnablement('a.b', EnablementState.DisabledGlobally)
    expect(fired).toHaveBeenCalled()
  })

  it('routes global enable/disable through the remote authority', async () => {
    const mocks = makeMocks({ hasWorkspace: true, authority: 'host' })
    const svc = makeService(mocks)
    await svc.setEnablement('a.b', EnablementState.DisabledGlobally)
    expect(mocks.calls).toEqual([{ id: 'a.b', enabled: false, authority: 'host' }])
  })

  it('reads the remote disabled set in a remote workspace', async () => {
    const remoteDisabled = new Set(['a.remote'])
    const mocks = makeMocks({ hasWorkspace: true, authority: 'host' })
    vi.mocked(mocks.management.getDisabledIds).mockImplementation(async (authority?: string) =>
      authority === 'host' ? [...remoteDisabled] : [],
    )
    const svc = makeService(mocks)
    expect(await svc.getEnablementState('a.remote')).toBe(EnablementState.DisabledGlobally)
    expect(await svc.getEffectiveDisabledIds()).toContain('a.remote')
  })

  it('re-fires enablement change when the authority changes', async () => {
    const mocks = makeMocks({ hasWorkspace: true, authority: 'host' })
    const svc = makeService(mocks)
    const fired = vi.fn()
    svc.onDidChangeEnablement(fired)
    ;(mocks.workspaceService as { current: IWorkspace | null }).current = {
      folder: { fsPath: '/ws', scheme: 'file' },
    } as unknown as IWorkspace
    mocks.onDidChangeWorkspace.fire(mocks.workspaceService.current)
    expect(fired).toHaveBeenCalled()
  })
})
