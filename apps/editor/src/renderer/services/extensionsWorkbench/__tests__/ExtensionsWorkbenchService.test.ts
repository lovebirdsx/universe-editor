import { describe, expect, it, vi } from 'vitest'
import { Emitter, REMOTE_SCHEME, Severity, URI } from '@universe-editor/platform'
import { GallerySortBy } from '@universe-editor/extension-gallery'
import type {
  IDialogService,
  IHostService,
  INotificationService,
  IStorageService,
  IWorkspaceService,
} from '@universe-editor/platform'
import type {
  ILocalExtension,
  IExtensionManagementService,
} from '../../../../shared/ipc/extensionManagementService.js'
import type {
  IExtensionGalleryService,
  IGalleryExtension,
} from '../../../../shared/ipc/extensionGalleryService.js'
import { ExtensionsWorkbenchService } from '../ExtensionsWorkbenchService.js'
import {
  EnablementState,
  type IExtensionEnablementService,
} from '../../extensions/ExtensionEnablementService.js'
import { IExtensionHostClientService } from '../../extensions/ExtensionHostClientService.js'
import type {
  IExtensionActivationErrorDto,
  IExtensionDescriptionDto,
} from '@universe-editor/extensions-common'

function localExtension(overrides: Partial<ILocalExtension> = {}): ILocalExtension {
  return {
    identifier: 'acme.installed',
    version: '1.0.0',
    location: '/ext/acme.installed-1.0.0',
    source: 'gallery',
    installedAt: 0,
    manifest: {
      name: 'installed',
      publisher: 'acme',
      displayName: 'Installed',
      description: 'An installed extension',
      version: '1.0.0',
      engines: { universe: '^0.1.0' },
    } as ILocalExtension['manifest'],
    ...overrides,
  }
}

function galleryExtension(overrides: Partial<IGalleryExtension> = {}): IGalleryExtension {
  const base = {
    identifier: 'acme.market',
    name: 'market',
    publisher: 'acme',
    displayName: 'Market',
    description: 'A marketplace extension',
    version: '2.0.0',
    vsixUrl: 'https://host/market.vsix',
    ...overrides,
  }
  return {
    ...base,
    versions: overrides.versions ?? [
      {
        version: base.version,
        vsixUrl: base.vsixUrl,
        ...(base.engineConstraint !== undefined ? { engineConstraint: base.engineConstraint } : {}),
        ...(base.vsixHash !== undefined ? { vsixHash: base.vsixHash } : {}),
        ...(base.vsixSignature !== undefined ? { vsixSignature: base.vsixSignature } : {}),
      },
    ],
  }
}

function makeMocks() {
  const onDidChangeExtensions = new Emitter<void>()
  const onDidChangeEnablement = new Emitter<void>()
  const management = {
    onDidChangeExtensions: onDidChangeExtensions.event,
    getInstalled: vi.fn(async () => [] as ILocalExtension[]),
    listBuiltinExtensions: vi.fn(async () => [] as ILocalExtension[]),
    listDevExtensions: vi.fn(async () => [] as ILocalExtension[]),
    installFromGallery: vi.fn(async () => localExtension()),
    installVSIX: vi.fn(async () => localExtension()),
    uninstall: vi.fn(async () => undefined),
    getLocalIcon: vi.fn(async () => ''),
  } as unknown as IExtensionManagementService
  const gallery = {
    isEnabled: vi.fn(async () => true),
    query: vi.fn(async () => ({ extensions: [], total: 0 })),
    getExtensions: vi.fn(async () => [] as IGalleryExtension[]),
    download: vi.fn(),
    getReadme: vi.fn(async () => 'readme text'),
    getControlManifest: vi.fn(),
  } as unknown as IExtensionGalleryService
  const dialog = {
    confirm: vi.fn(async () => ({ confirmed: true, choice: 'primary' })),
  } as unknown as IDialogService
  // Storage: trusts every publisher by default so install() doesn't prompt.
  const storage = {
    get: vi.fn(async () => ['acme']),
    set: vi.fn(async () => undefined),
  } as unknown as IStorageService
  const notification = { notify: vi.fn() } as unknown as INotificationService
  const enablement = {
    onDidChangeEnablement: onDidChangeEnablement.event,
    hasWorkspace: vi.fn(() => false),
    getEnablementState: vi.fn(async () => EnablementState.EnabledGlobally),
    isEnabled: vi.fn(async () => true),
    canChangeWorkspaceEnablement: vi.fn(() => false),
    setEnablement: vi.fn(async () => undefined),
    getEffectiveDisabledIds: vi.fn(async () => [] as string[]),
  } as unknown as IExtensionEnablementService
  const onDidActivationError = new Emitter<IExtensionActivationErrorDto>()
  const onDidChangeContributions = new Emitter<readonly IExtensionDescriptionDto[]>()
  const hostClient = {
    onDidActivationError: onDidActivationError.event,
    onDidChangeContributions: onDidChangeContributions.event,
  } as unknown as IExtensionHostClientService
  const workspace = {
    _serviceBrand: undefined,
    current: null as IWorkspaceService['current'],
    onDidChangeWorkspace: new Emitter().event,
    recent: [] as IWorkspaceService['recent'],
    onDidChangeRecent: new Emitter().event,
    whenReady: Promise.resolve(),
    openFolder: vi.fn(async () => undefined),
    closeFolder: vi.fn(async () => undefined),
    removeRecent: vi.fn(async () => undefined),
    clearRecent: vi.fn(async () => undefined),
  } as IWorkspaceService
  const host = {
    getVersionInfo: vi.fn(async () => ({ version: '0.13.0' })),
  } as unknown as IHostService
  return {
    management,
    gallery,
    dialog,
    storage,
    notification,
    enablement,
    hostClient,
    workspace,
    host,
    onDidChangeExtensions,
    onDidChangeEnablement,
    onDidActivationError,
    onDidChangeContributions,
  }
}

function makeService(mocks: ReturnType<typeof makeMocks>): ExtensionsWorkbenchService {
  return new ExtensionsWorkbenchService(
    mocks.management,
    mocks.gallery,
    mocks.dialog,
    mocks.storage,
    mocks.notification,
    mocks.enablement,
    mocks.hostClient,
    mocks.workspace,
    mocks.host,
  )
}

describe('ExtensionsWorkbenchService', () => {
  it('maps installed extensions to entries', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entries = svc.getInstalled()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'acme.installed', installed: true, outdated: false })
  })

  it('surfaces dev extensions first with the development flag (and both entries on an id collision)', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.listDevExtensions).mockResolvedValue([
      localExtension({ identifier: 'acme.dev', source: 'development' }),
    ])
    vi.mocked(mocks.management.listBuiltinExtensions).mockResolvedValue([
      localExtension({ identifier: 'acme.dev', source: 'builtin' }),
      localExtension({ identifier: 'acme.tool', source: 'builtin' }),
    ])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entries = svc.getInstalled()
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({
      id: 'acme.dev',
      isUnderDevelopment: true,
      isBuiltin: false,
      enabled: true,
      installed: true,
    })
    // The same-id built-in still shows (badge distinguishes them); scan dedupe
    // governs which activates, the UI presents "what is installed".
    expect(entries[1]).toMatchObject({ id: 'acme.dev', isUnderDevelopment: false, isBuiltin: true })
    expect(entries[2]).toMatchObject({ id: 'acme.tool', isBuiltin: true })
  })

  it('marks a search result as installed + outdated when a lower version is installed', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([
      localExtension({ identifier: 'acme.market', version: '1.0.0' }),
    ])
    vi.mocked(mocks.gallery.query).mockResolvedValue({
      extensions: [galleryExtension({ identifier: 'acme.market', version: '2.0.0' })],
      total: 1,
    })
    const svc = makeService(mocks)
    await svc.refreshInstalled()
    await svc.search('market')

    const results = svc.getSearchResults()
    expect(results[0]).toMatchObject({ id: 'acme.market', installed: true, outdated: true })
  })

  it('clears results and does not query on an empty search', async () => {
    const mocks = makeMocks()
    const svc = makeService(mocks)
    await svc.search('   ')
    expect(mocks.gallery.query).not.toHaveBeenCalled()
    expect(svc.getSearchResults()).toHaveLength(0)
  })

  it('ignores a stale search that resolves after a newer one', async () => {
    const mocks = makeMocks()
    let resolveFirst: (v: { extensions: IGalleryExtension[]; total: number }) => void = () => {}
    vi.mocked(mocks.gallery.query)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          }),
      )
      .mockResolvedValueOnce({
        extensions: [galleryExtension({ identifier: 'acme.new' })],
        total: 1,
      })

    const svc = makeService(mocks)
    const first = svc.search('old')
    const second = svc.search('new')
    await second
    // Now let the stale first query resolve — it must not overwrite results.
    resolveFirst({ extensions: [galleryExtension({ identifier: 'acme.old' })], total: 1 })
    await first

    expect(svc.getSearchResults().map((e) => e.id)).toEqual(['acme.new'])
  })

  it('refreshes installed when the management service fires a change', async () => {
    const mocks = makeMocks()
    const svc = makeService(mocks)
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    mocks.onDidChangeExtensions.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.management.getInstalled).toHaveBeenCalled()
    expect(svc.getInstalled()).toHaveLength(1)
  })

  it('tracks installing state around install() for a trusted publisher', async () => {
    const mocks = makeMocks()
    const svc = makeService(mocks)
    vi.mocked(mocks.gallery.query).mockResolvedValue({
      extensions: [galleryExtension()],
      total: 1,
    })
    await svc.search('market')
    const entry = svc.getSearchResults()[0]!
    await svc.install(entry)
    expect(mocks.management.installFromGallery).toHaveBeenCalledWith(entry.gallery, undefined)
    // Trusted publisher (storage returns ['acme']) → no confirm dialog.
    expect(mocks.dialog.confirm).not.toHaveBeenCalled()
  })

  it('prompts to trust a new publisher and remembers it on confirm', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.storage.get).mockResolvedValue([]) // nobody trusted yet
    const svc = makeService(mocks)
    vi.mocked(mocks.gallery.query).mockResolvedValue({
      extensions: [galleryExtension()],
      total: 1,
    })
    await svc.search('market')
    const entry = svc.getSearchResults()[0]!
    await svc.install(entry)

    expect(mocks.dialog.confirm).toHaveBeenCalled()
    expect(mocks.management.installFromGallery).toHaveBeenCalled()
    expect(mocks.storage.set).toHaveBeenCalledWith(
      'extensions.trustedPublishers',
      ['acme'],
      expect.anything(),
    )
  })

  it('aborts install when the trust prompt is declined', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.storage.get).mockResolvedValue([])
    vi.mocked(mocks.dialog.confirm).mockResolvedValue({ confirmed: false, choice: 'cancel' })
    const svc = makeService(mocks)
    vi.mocked(mocks.gallery.query).mockResolvedValue({
      extensions: [galleryExtension()],
      total: 1,
    })
    await svc.search('market')
    await svc.install(svc.getSearchResults()[0]!)

    expect(mocks.management.installFromGallery).not.toHaveBeenCalled()
  })

  it('merges built-in extensions and marks them isBuiltin', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.listBuiltinExtensions).mockResolvedValue([
      localExtension({ identifier: 'universe.git', source: 'builtin' }),
    ])
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entries = svc.getInstalled()
    expect(entries.map((e) => e.id)).toEqual(['universe.git', 'acme.installed'])
    expect(entries.find((e) => e.id === 'universe.git')?.isBuiltin).toBe(true)
    expect(entries.find((e) => e.id === 'acme.installed')?.isBuiltin).toBe(false)
  })

  it('reflects a disabled enablement state on the entry', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    vi.mocked(mocks.enablement.getEnablementState).mockResolvedValue(
      EnablementState.DisabledGlobally,
    )
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entry = svc.getInstalled()[0]!
    expect(entry.enabled).toBe(false)
    expect(entry.enablementState).toBe(EnablementState.DisabledGlobally)
  })

  it('maps a version-incompatible local extension to isVersionIncompatible + message', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([
      localExtension({
        isVersionCompatible: false,
        validationMessage: 'requires universe ^9.0.0, host is 0.1.0',
      }),
    ])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entry = svc.getInstalled()[0]!
    expect(entry.isVersionIncompatible).toBe(true)
    expect(entry.validationMessage).toBe('requires universe ^9.0.0, host is 0.1.0')
  })

  it('leaves a compatible local extension unflagged', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([
      localExtension({ isVersionCompatible: true }),
    ])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entry = svc.getInstalled()[0]!
    expect(entry.isVersionIncompatible).toBe(false)
    expect(entry.validationMessage).toBeUndefined()
  })

  it('forwards setEnablement to the enablement service', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    await svc.setEnablement(svc.getInstalled()[0]!, EnablementState.DisabledGlobally)
    expect(mocks.enablement.setEnablement).toHaveBeenCalledWith(
      'acme.installed',
      EnablementState.DisabledGlobally,
    )
  })

  it('loadFeatured queries the marketplace sorted by install count', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.gallery.query).mockResolvedValue({
      extensions: [galleryExtension()],
      total: 1,
    })
    const svc = makeService(mocks)
    await svc.loadFeatured()

    expect(mocks.gallery.query).toHaveBeenCalledWith({ sortBy: GallerySortBy.InstallCount })
    expect(svc.getSearchResults().map((e) => e.id)).toEqual(['acme.market'])
    expect(svc.searchText).toBe('')
  })

  it('installVSIX forwards the path, refreshes, and notifies', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    const svc = makeService(mocks)
    await svc.installVSIX('/tmp/ext.vsix')

    expect(mocks.management.installVSIX).toHaveBeenCalledWith('/tmp/ext.vsix', undefined)
    expect(mocks.management.getInstalled).toHaveBeenCalled()
    expect(mocks.notification.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: Severity.Info }),
    )
  })

  it('installVSIX notifies an error and still refreshes when install fails', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.installVSIX).mockRejectedValue(new Error('bad package'))
    const svc = makeService(mocks)
    await svc.installVSIX('/tmp/broken.vsix')

    expect(mocks.notification.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: Severity.Error }),
    )
    expect(mocks.management.getInstalled).toHaveBeenCalled()
  })

  it('attaches an activation error to the matching installed entry + fires change', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    let ticked = false
    svc.onDidChange(() => (ticked = true))
    mocks.onDidActivationError.fire({
      extensionId: 'acme.installed',
      displayName: 'Installed',
      message: 'boom',
      stack: 'Error: boom\n  at activate',
    })

    expect(ticked).toBe(true)
    const entry = svc.getInstalled().find((e) => e.id === 'acme.installed')
    expect(entry?.activationError).toEqual({
      message: 'boom',
      stack: 'Error: boom\n  at activate',
    })
  })

  it('clears activation errors when the host relaunches (contributions change)', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    mocks.onDidActivationError.fire({ extensionId: 'acme.installed', message: 'boom' })
    expect(svc.getInstalled().find((e) => e.id === 'acme.installed')?.activationError).toBeDefined()

    mocks.onDidChangeContributions.fire([])
    expect(
      svc.getInstalled().find((e) => e.id === 'acme.installed')?.activationError,
    ).toBeUndefined()
  })

  it('splits remote-installed and local user extensions across the remote/local sides', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) =>
      Promise.resolve(
        authority
          ? [localExtension({ identifier: 'acme.remote', location: '' })]
          : [localExtension()],
      ),
    )
    vi.mocked(mocks.management.listBuiltinExtensions).mockResolvedValue([
      localExtension({ identifier: 'universe.git', source: 'builtin' }),
    ])
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entries = svc.getInstalled()
    const remoteEntry = entries.find((e) => e.id === 'acme.remote')
    expect(remoteEntry?.remote).toBe(true)
    expect(remoteEntry?.installableInRemote).toBeUndefined()
    expect(entries.find((e) => e.id === 'universe.git')).toMatchObject({
      remote: true,
      isBuiltin: true,
    })
    const localEntry = entries.find((e) => e.id === 'acme.installed')
    expect(localEntry?.remote).toBeUndefined()
    expect(localEntry?.installableInRemote).toBe(true)
    // Dev extensions aren't listed in a remote workspace (the host never loads them).
    expect(entries.some((e) => e.isUnderDevelopment)).toBe(false)
    // The facade exposes the authority + its label.
    expect(svc.authority).toBe('host')
    expect(svc.remoteLabel).toBe('SSH: host')
  })

  it('does not mark remote/local side flags in a local workspace', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockResolvedValue([localExtension()])
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    expect(svc.authority).toBeUndefined()
    expect(svc.getInstalled()[0]?.remote).toBeUndefined()
    expect(svc.getInstalled()[0]?.installableInRemote).toBeUndefined()
  })

  it('routes gallery + VSIX installs through the remote authority in a remote workspace', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.gallery.query).mockResolvedValue({
      extensions: [galleryExtension()],
      total: 1,
    })
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()
    await svc.search('market')

    await svc.install(svc.getSearchResults()[0]!)
    expect(mocks.management.installFromGallery).toHaveBeenCalledWith(expect.anything(), 'host')

    await svc.installVSIX('/tmp/ext.vsix')
    expect(mocks.management.installVSIX).toHaveBeenCalledWith('/tmp/ext.vsix', 'host')
  })

  it('uninstalls a remote-side entry remotely and a local-side entry locally', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) =>
      Promise.resolve(
        authority
          ? [localExtension({ identifier: 'acme.remote', location: '' })]
          : [localExtension()],
      ),
    )
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const remoteEntry = svc.getInstalled().find((e) => e.id === 'acme.remote')!
    await svc.uninstall(remoteEntry)
    expect(mocks.management.uninstall).toHaveBeenCalledWith('acme.remote', 'host')

    const localEntry = svc.getInstalled().find((e) => e.id === 'acme.installed')!
    await svc.uninstall(localEntry)
    expect(mocks.management.uninstall).toHaveBeenCalledWith('acme.installed', undefined)
  })

  it('installInRemote looks up the marketplace and installs into the remote', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) =>
      Promise.resolve(authority ? [] : [localExtension()]),
    )
    vi.mocked(mocks.gallery.getExtensions).mockResolvedValue([
      galleryExtension({ identifier: 'acme.installed' }),
    ])
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const entry = svc.getInstalled().find((e) => e.id === 'acme.installed')!
    expect(entry.installableInRemote).toBe(true)

    await expect(svc.canInstallInRemote('acme.installed')).resolves.toBe(true)
    await expect(svc.installInRemote(entry)).resolves.toBe(true)
    expect(mocks.gallery.getExtensions).toHaveBeenCalledWith(['acme.installed'])
    expect(mocks.management.installFromGallery).toHaveBeenCalledWith(expect.anything(), 'host')
  })

  it('installInRemote returns false without installing when the marketplace has no entry', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) =>
      Promise.resolve(authority ? [] : [localExtension()]),
    )
    vi.mocked(mocks.gallery.getExtensions).mockResolvedValue([])
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    await expect(svc.canInstallInRemote('acme.installed')).resolves.toBe(false)
    await expect(svc.installInRemote(svc.getInstalled()[0]!)).resolves.toBe(false)
    expect(mocks.management.installFromGallery).not.toHaveBeenCalled()
  })

  it('resolves built-in icons locally and remote user-extension icons remotely', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) =>
      Promise.resolve(
        authority ? [localExtension({ identifier: 'acme.remote', location: '' })] : [],
      ),
    )
    vi.mocked(mocks.management.listBuiltinExtensions).mockResolvedValue([
      localExtension({ identifier: 'universe.git', source: 'builtin' }),
    ])
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    const builtin = svc.getInstalled().find((e) => e.id === 'universe.git')!
    const remoteUser = svc.getInstalled().find((e) => e.id === 'acme.remote')!

    await svc.getIcon(builtin)
    await svc.getIcon(remoteUser)

    expect(mocks.management.getLocalIcon).toHaveBeenCalledWith('universe.git', undefined)
    expect(mocks.management.getLocalIcon).toHaveBeenCalledWith('acme.remote', 'host')
  })

  it('ignores a stale refresh whose remote response lands after a newer one', async () => {
    const mocks = makeMocks()
    let resolveFirstRemote: (v: ILocalExtension[]) => void = () => {}
    let firstRemoteCalled = false
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) => {
      if (!authority) return Promise.resolve([localExtension({ identifier: 'acme.local' })])
      if (!firstRemoteCalled) {
        firstRemoteCalled = true
        return new Promise<ILocalExtension[]>((res) => {
          resolveFirstRemote = res
        })
      }
      return Promise.resolve([localExtension({ identifier: 'acme.second', location: '' })])
    })
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)

    const first = svc.refreshInstalled()
    const second = svc.refreshInstalled()
    await second

    // Now let the stale first remote response land — it must not overwrite state.
    resolveFirstRemote([localExtension({ identifier: 'acme.first', location: '' })])
    await first

    const ids = svc.getInstalled().map((e) => e.id)
    expect(ids).toContain('acme.second')
    expect(ids).not.toContain('acme.first')
  })

  it('keeps the last remote set and updates the local set when the remote host is unreachable', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) =>
      Promise.resolve(
        authority
          ? [localExtension({ identifier: 'acme.remote', location: '' })]
          : [localExtension()],
      ),
    )
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    // Remote goes down; the remote branch now rejects while the local branch returns a new set.
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) => {
      if (authority) return Promise.reject(new Error('disconnected'))
      return Promise.resolve([localExtension({ identifier: 'acme.updated' })])
    })

    await expect(svc.refreshInstalled()).resolves.toBeUndefined()

    const entries = svc.getInstalled()
    expect(entries.find((e) => e.id === 'acme.remote')?.remote).toBe(true)
    expect(entries.find((e) => e.id === 'acme.updated')).toBeDefined()
  })

  it('prefetches the marketplace once for all installable-in-remote ids', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.management.getInstalled).mockImplementation((authority?: string) =>
      Promise.resolve(
        authority
          ? []
          : [
              localExtension({ identifier: 'acme.one' }),
              localExtension({ identifier: 'acme.two' }),
            ],
      ),
    )
    vi.mocked(mocks.gallery.getExtensions).mockResolvedValue([
      galleryExtension({ identifier: 'acme.one' }),
      galleryExtension({ identifier: 'acme.two' }),
    ])
    ;(mocks.workspace as { current: IWorkspaceService['current'] }).current = {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/root' }),
      name: 'root',
    }
    const svc = makeService(mocks)
    await svc.refreshInstalled()

    await expect(svc.canInstallInRemote('acme.one')).resolves.toBe(true)
    await expect(svc.canInstallInRemote('acme.two')).resolves.toBe(true)

    expect(mocks.gallery.getExtensions).toHaveBeenCalledTimes(1)
    expect(mocks.gallery.getExtensions).toHaveBeenCalledWith(['acme.one', 'acme.two'])
  })

  it('annotates gallery version compatibility (fallback version + all-incompatible)', async () => {
    const mocks = makeMocks()
    vi.mocked(mocks.gallery.query).mockResolvedValue({
      extensions: [
        galleryExtension({
          version: '2.0.0',
          versions: [
            {
              version: '2.0.0',
              vsixUrl: 'https://host/market-2.vsix',
              engineConstraint: '>=9.0.0',
            },
            { version: '1.0.0', vsixUrl: 'https://host/market.vsix' },
          ],
        }),
        galleryExtension({
          identifier: 'acme.broken',
          name: 'broken',
          displayName: 'Broken',
          version: '2.0.0',
          versions: [
            {
              version: '2.0.0',
              vsixUrl: 'https://host/broken.vsix',
              engineConstraint: '>=9.0.0',
            },
          ],
        }),
      ],
      total: 2,
    })
    const svc = makeService(mocks)
    await svc.search('market')

    const [fallback, broken] = svc.getSearchResults()
    expect(fallback?.installIncompatible).toBe(false)
    expect(fallback?.installCompatibleVersion).toBe('1.0.0')
    expect(broken?.installIncompatible).toBe(true)
    expect(broken?.installCompatibleVersion).toBeUndefined()
  })
})
