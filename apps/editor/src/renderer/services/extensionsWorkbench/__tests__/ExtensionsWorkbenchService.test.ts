import { describe, expect, it, vi } from 'vitest'
import { Emitter, Severity } from '@universe-editor/platform'
import { GallerySortBy } from '@universe-editor/extension-gallery'
import type {
  IDialogService,
  INotificationService,
  IStorageService,
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
  return {
    identifier: 'acme.market',
    name: 'market',
    publisher: 'acme',
    displayName: 'Market',
    description: 'A marketplace extension',
    version: '2.0.0',
    vsixUrl: 'https://host/market.vsix',
    ...overrides,
  }
}

function makeMocks() {
  const onDidChangeExtensions = new Emitter<void>()
  const onDidChangeEnablement = new Emitter<void>()
  const management = {
    onDidChangeExtensions: onDidChangeExtensions.event,
    getInstalled: vi.fn(async () => [] as ILocalExtension[]),
    listBuiltinExtensions: vi.fn(async () => [] as ILocalExtension[]),
    installFromGallery: vi.fn(async () => localExtension()),
    installVSIX: vi.fn(async () => localExtension()),
    uninstall: vi.fn(async () => undefined),
  } as unknown as IExtensionManagementService
  const gallery = {
    isEnabled: vi.fn(async () => true),
    query: vi.fn(async () => ({ extensions: [], total: 0 })),
    getExtensions: vi.fn(),
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
  return {
    management,
    gallery,
    dialog,
    storage,
    notification,
    enablement,
    onDidChangeExtensions,
    onDidChangeEnablement,
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
    expect(mocks.management.installFromGallery).toHaveBeenCalledWith(entry.gallery)
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

    expect(mocks.management.installVSIX).toHaveBeenCalledWith('/tmp/ext.vsix')
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
})
