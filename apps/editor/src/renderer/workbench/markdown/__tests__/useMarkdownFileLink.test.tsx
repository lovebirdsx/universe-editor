/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for useMarkdownFileLink's `~` expansion. The path was written by a
 *  process on the workspace host — in a remote-ssh workspace that is the remote
 *  home, never the client's os.homedir() the preload bridge reports. Expanding
 *  against the client home names a file on the wrong machine: every candidate
 *  misses and the click ends in "File does not exist".
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  Emitter,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileSearchService,
  IFileService,
  INotificationService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import type {
  IEditorResolverService as IEditorResolverServiceType,
  IEditorService as IEditorServiceType,
  IFileSearchQuery as IFileSearchQueryType,
  IFileSearchService as IFileSearchServiceType,
  IFileService as IFileServiceType,
  INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import { IRemoteStatusService } from '../../../../shared/ipc/remoteStatusService.js'
import type {
  RemoteConnectionStatusDto,
  RemoteEnvironmentDto,
} from '../../../../shared/ipc/remoteStatusService.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { MarkdownPreviewInput } from '../../../services/editor/MarkdownPreviewInput.js'
import { IFocusScopeService } from '../../../services/focus/FocusScopeService.js'
import { IQuickAccessController } from '../../../services/quickInput/QuickAccessController.js'
import { IRecentFilesService } from '../../../services/recentFiles/recentFilesService.js'
import { IAuxiliaryEditorWindowService } from '../../../services/windows/auxiliaryEditorWindowService.js'
import { ServicesContext } from '../../useService.js'
import { useMarkdownFileLink, type OpenMarkdownLinkOptions } from '../useMarkdownFileLink.js'

const AUTHORITY = 'wsl+ubuntu2004'
const REMOTE_HOME = '/home/dev'
const CLIENT_HOME = 'C:/Users/testuser'
const PLAN_HREF = '~/.claude/plans/x.md'
const REMOTE_ROOT = URI.from({ scheme: 'remote-ssh', authority: AUTHORITY, path: '/home/dev/proj' })
const REMOTE_PLAN_URI = `remote-ssh://${AUTHORITY}${REMOTE_HOME}/.claude/plans/x.md`
const REMOTE_ENV: RemoteEnvironmentDto = {
  os: 'linux',
  arch: 'x64',
  homeDir: REMOTE_HOME,
  tmpDir: '/tmp',
  pathCaseSensitive: true,
  serverVersion: '0.0.0',
}

/** `getEnvironment` answers with a promise settled by {@link resolveEnv}. */
function makeRemoteStatus() {
  const emitter = new Emitter<RemoteConnectionStatusDto>()
  let settle: ((env: RemoteEnvironmentDto | null) => void) | undefined
  const pending = new Promise<RemoteEnvironmentDto | null>((resolve) => {
    settle = resolve
  })
  return {
    service: {
      _serviceBrand: undefined,
      getEnvironment: () => pending,
      onDidChangeState: emitter.event,
    } as unknown as IRemoteStatusService,
    async resolveEnv(env: RemoteEnvironmentDto | null) {
      settle?.(env)
      emitter.fire({ authority: AUTHORITY, state: 'connected' })
      await Promise.resolve()
    },
  }
}

function makeWorkspace() {
  return {
    _serviceBrand: undefined,
    current: { folder: REMOTE_ROOT, name: 'proj' },
    onDidChangeWorkspace: () => ({ dispose: () => {} }),
  }
}

function makeFileService(
  exists: (resource: URI) => boolean,
  isDirectory: (resource: URI) => boolean = () => false,
): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async exists(resource: URI) {
      return exists(resource)
    },
    async stat(resource: URI) {
      return {
        resource,
        isFile: !isDirectory(resource),
        isDirectory: isDirectory(resource),
        size: 0,
        mtime: 0,
      }
    },
  } as unknown as IFileServiceType
}

function makeFileSearch(
  relPaths: readonly string[] = [],
  limitHit = false,
): IFileSearchServiceType & { queries: IFileSearchQueryType[] } {
  const queries: IFileSearchQueryType[] = []
  return {
    _serviceBrand: undefined,
    queries,
    search: (query: IFileSearchQueryType) => {
      queries.push(query)
      return Promise.resolve({
        relPaths,
        limitHit,
        filesWalked: relPaths.length,
        directoriesWalked: 0,
        durationMs: 0,
      })
    },
  } as unknown as IFileSearchServiceType & { queries: IFileSearchQueryType[] }
}

function mount(options: {
  exists: (uri: URI) => boolean
  remoteStatus?: IRemoteStatusService
  previewLinks?: boolean
  isDirectory?: (uri: URI) => boolean
  fileSearch?: IFileSearchServiceType & { queries: IFileSearchQueryType[] }
  recentFiles?: readonly { uri: URI; name: string }[]
  focus?: {
    active: boolean
    scanPaths: readonly string[]
    rootFilesInScope: boolean
    fingerprint: string
  }
}) {
  const openEditor = vi.fn().mockResolvedValue(undefined)
  const notify = vi.fn()
  const showQuickAccess = vi.fn()
  const groups = new EditorGroupsService()
  const services = new ServiceCollection()
  services.set(IWorkspaceService, makeWorkspace() as never)
  services.set(IEditorGroupsService, groups as never)
  const openInNewWindow = vi.fn(async (editor: unknown, _options?: unknown) => ({
    ok: true,
    editor,
    window: { part: { activeGroup: {} } },
  }))
  services.set(IAuxiliaryEditorWindowService, {
    _serviceBrand: undefined,
    openEditorInNewWindow: openInNewWindow,
  } as never)
  services.set(IUriIdentityService, {
    _serviceBrand: undefined,
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
    isCaseSensitive: () => true,
    getComparisonKey: (uri: URI) => uri.toString(),
    relativePath: (from: URI, to: URI) => {
      const base = from.path.endsWith('/') ? from.path.slice(0, -1) : from.path
      if (to.path === base) return ''
      if (!to.path.startsWith(`${base}/`)) return null
      return to.path.slice(base.length + 1)
    },
  } as never)
  services.set(IRecentFilesService, {
    _serviceBrand: undefined,
    getAll: async () => options.recentFiles ?? [],
    add: () => {},
    clear: () => {},
  } as never)
  if (options.focus) {
    services.set(IFocusScopeService, { _serviceBrand: undefined, ...options.focus } as never)
  }
  services.set(IQuickAccessController, {
    _serviceBrand: undefined,
    show: showQuickAccess,
  } as never)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor,
    createEditorInput: (resource: URI) => ({
      id: resource.toString(),
      resource,
      isDisposed: false,
      dispose: vi.fn(),
    }),
  } as unknown as IEditorResolverServiceType)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(),
  } as unknown as IEditorServiceType)
  services.set(IFileService, makeFileService(options.exists, options.isDirectory))
  const fileSearch = options.fileSearch ?? makeFileSearch()
  services.set(IFileSearchService, fileSearch)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify,
  } as unknown as INotificationServiceType)
  if (options.remoteStatus) services.set(IRemoteStatusService, options.remoteStatus)
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  const { result } = renderHook(
    () => useMarkdownFileLink(REMOTE_ROOT, options.previewLinks ?? false),
    { wrapper },
  )
  return {
    openEditor,
    openInNewWindow,
    notify,
    showQuickAccess,
    groups,
    click: (href: string, opts?: OpenMarkdownLinkOptions) =>
      result.current(href, undefined, undefined, undefined, opts),
  }
}

afterEach(() => {
  cleanup()
  delete (window as { ipc?: unknown }).ipc
})

describe('useMarkdownFileLink remote ~ expansion', () => {
  it('expands ~ against the remote home, not the client home', async () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const remoteStatus = makeRemoteStatus()
    const { openEditor, notify, click } = mount({
      exists: (uri) => uri.toString() === REMOTE_PLAN_URI,
      remoteStatus: remoteStatus.service,
    })
    await remoteStatus.resolveEnv(REMOTE_ENV)

    click(PLAN_HREF)

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(openEditor.mock.calls[0]?.[0]?.toString()).toBe(REMOTE_PLAN_URI)
    expect(notify).not.toHaveBeenCalled()
  })

  it('never probes the client home for a remote workspace', async () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const remoteStatus = makeRemoteStatus()
    const probed: string[] = []
    const { notify, click } = mount({
      exists: (uri) => {
        probed.push(uri.toString())
        return false
      },
      remoteStatus: remoteStatus.service,
    })
    await remoteStatus.resolveEnv(REMOTE_ENV)

    click(PLAN_HREF)

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(probed.some((uri) => uri.includes(CLIENT_HOME))).toBe(false)
  })

  it('expands ~ against the remote home when the click lands before the handshake answers', async () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const remoteStatus = makeRemoteStatus()
    const { openEditor, click } = mount({
      exists: (uri) => uri.toString() === REMOTE_PLAN_URI,
      remoteStatus: remoteStatus.service,
    })

    // Click while the environment is still in flight: the hook's `home` is not
    // there yet, so only an awaited lookup can still name the right machine.
    click(PLAN_HREF)
    await act(async () => {
      await remoteStatus.resolveEnv(REMOTE_ENV)
    })

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(openEditor.mock.calls[0]?.[0]?.toString()).toBe(REMOTE_PLAN_URI)
  })

  it('falls back to the client home when no remote-status service is bound', async () => {
    ;(window as { ipc?: unknown }).ipc = { home: CLIENT_HOME, platform: 'win32' }
    const clientUri = `remote-ssh://${AUTHORITY}/${CLIENT_HOME}/.claude/plans/x.md`
    const { openEditor, click } = mount({ exists: (uri) => uri.toString() === clientUri })

    click(PLAN_HREF)

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(openEditor.mock.calls[0]?.[0]?.toString()).toBe(clientUri)
  })
})

// A path that misses every concrete candidate is resolved by a live,
// suffix-targeted enumeration. The walk never reads the on-disk listing, so a
// file created after that listing was built is still found, and a truncated
// walk never turns into a definitive "file does not exist".
describe('useMarkdownFileLink workspace suffix fallback', () => {
  const TARGET = URI.joinPath(REMOTE_ROOT, 'open-file/foo/bar/test.md')

  it('opens the single suffix match from the live walk', async () => {
    const fileSearch = makeFileSearch(['open-file/foo/bar/test.md'])
    const { openEditor, notify, click } = mount({ exists: () => false, fileSearch })

    click('bar/test.md')

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(openEditor.mock.calls[0]?.[0]?.toString()).toBe(TARGET.toString())
    expect(notify).not.toHaveBeenCalled()
    expect(fileSearch.queries).toHaveLength(1)
    expect(fileSearch.queries[0]).toMatchObject({
      matchAll: true,
      pattern: '',
      glob: ['**/bar/test.md'],
      omitTruncatedListing: true,
      timeoutMs: 10_000,
    })
  })

  it('opens a recent suffix match without walking the workspace', async () => {
    const recentUri = URI.joinPath(REMOTE_ROOT, 'open-file/foo/bar/test.md')
    const fileSearch = makeFileSearch()
    const { openEditor, notify, click } = mount({
      exists: (uri) => uri.toString() === recentUri.toString(),
      fileSearch,
      recentFiles: [{ uri: recentUri, name: 'test.md' }],
    })

    click('bar/test.md')

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(openEditor.mock.calls[0]?.[0]?.toString()).toBe(recentUri.toString())
    expect(fileSearch.queries).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('hands several recent suffix matches to Go to File', async () => {
    const first = URI.joinPath(REMOTE_ROOT, 'a/bar/test.md')
    const second = URI.joinPath(REMOTE_ROOT, 'b/bar/test.md')
    const fileSearch = makeFileSearch()
    const { openEditor, showQuickAccess, click } = mount({
      exists: (uri) => uri.toString() === first.toString() || uri.toString() === second.toString(),
      fileSearch,
      recentFiles: [
        { uri: first, name: 'test.md' },
        { uri: second, name: 'test.md' },
      ],
    })

    click('bar/test.md')

    await waitFor(() => expect(showQuickAccess).toHaveBeenCalledWith('bar/test.md'))
    expect(openEditor).not.toHaveBeenCalled()
    expect(fileSearch.queries).toHaveLength(0)
  })

  it('ignores a stale recent entry and falls back to the live walk', async () => {
    const stale = URI.joinPath(REMOTE_ROOT, 'stale/bar/test.md')
    const fileSearch = makeFileSearch(['live/bar/test.md'])
    const { openEditor, click } = mount({
      exists: () => false,
      fileSearch,
      recentFiles: [{ uri: stale, name: 'test.md' }],
    })

    click('bar/test.md')

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(openEditor.mock.calls[0]?.[0]?.toString()).toBe(
      URI.joinPath(REMOTE_ROOT, 'live/bar/test.md').toString(),
    )
    expect(fileSearch.queries).toHaveLength(1)
  })

  it('narrows the live walk to the focus scope', async () => {
    const fileSearch = makeFileSearch(['focus/bar/test.md'])
    const { openEditor, click } = mount({
      exists: () => false,
      fileSearch,
      focus: {
        active: true,
        scanPaths: ['focus'],
        rootFilesInScope: false,
        fingerprint: 'focus:test',
      },
    })

    click('bar/test.md')

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(fileSearch.queries[0]).toMatchObject({
      matchAll: true,
      scanPaths: ['focus'],
    })
    expect(fileSearch.queries[0]).not.toHaveProperty('rootFilesInScope')
  })

  it('reports unavailable, not missing, when the focus-scoped walk finds nothing', async () => {
    const fileSearch = makeFileSearch([], false)
    const { notify, click } = mount({
      exists: () => false,
      fileSearch,
      focus: {
        active: true,
        scanPaths: ['focus'],
        rootFilesInScope: false,
        fingerprint: 'focus:test',
      },
    })

    click('bar/test.md')

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(notify.mock.calls[0]?.[0]?.message).toContain('Unable to confirm')
  })

  it('hands several suffix matches to Go to File', async () => {
    const fileSearch = makeFileSearch(['a/bar/test.md', 'b/bar/test.md'])
    const { openEditor, notify, showQuickAccess, click } = mount({
      exists: () => false,
      fileSearch,
    })

    click('bar/test.md')

    await waitFor(() => expect(showQuickAccess).toHaveBeenCalledWith('bar/test.md'))
    expect(openEditor).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('reports unavailable, not missing, when the walk is truncated', async () => {
    const fileSearch = makeFileSearch([], true)
    const { notify, click } = mount({ exists: () => false, fileSearch })

    click('bar/test.md')

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(notify.mock.calls[0]?.[0]?.message).toContain('Unable to confirm')
    expect(fileSearch.queries).toHaveLength(1)
  })

  it('does not cache unavailable results so a retry walks again', async () => {
    const fileSearch = makeFileSearch([], true)
    const { notify, click } = mount({ exists: () => false, fileSearch })

    click('bar/test.md')
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    click('bar/test.md')
    await waitFor(() => expect(fileSearch.queries).toHaveLength(2))
  })

  it('reports missing only after a complete walk found no suffix match', async () => {
    const fileSearch = makeFileSearch(['other/test.md'])
    const { notify, click } = mount({ exists: () => false, fileSearch })

    click('bar/test.md')

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(notify.mock.calls[0]?.[0]?.message).toContain('File does not exist')
    expect(fileSearch.queries).toHaveLength(1)
  })
})

// Ctrl/Cmd+click sends the target to the group beside the active one. The group
// has to be created and activated at the open itself, because the resolver and
// the editor service route a new editor through `activeGroupForOpen`. A click
// that ends up opening nothing must not leave an empty group behind.
describe('useMarkdownFileLink open to the side', () => {
  const ABS_FILE = '/repo/src/a.ts'
  const ABS_MD = '/repo/docs/readme.md'

  it('creates and activates the side group for a plain file', async () => {
    const { openEditor, groups, click } = mount({ exists: () => true })

    click(ABS_FILE, { target: 'side' })

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(groups.count).toBe(2)
    expect(groups.activeGroup).not.toBe(groups.getGroups()[0])
  })

  it('leaves the layout alone on a plain click', async () => {
    const { openEditor, groups, click } = mount({ exists: () => true })

    click(ABS_FILE)

    await waitFor(() => expect(openEditor).toHaveBeenCalledTimes(1))
    expect(groups.count).toBe(1)
  })

  it('opens the markdown preview into the side group in preview mode', async () => {
    const { groups, click } = mount({ exists: () => true, previewLinks: true })

    click(ABS_MD, { target: 'side' })

    await waitFor(() => expect(groups.count).toBe(2))
    const side = groups.getGroups()[1]!
    expect(side.editors).toHaveLength(1)
    expect(side.editors[0]!).toBeInstanceOf(MarkdownPreviewInput)
  })

  it('creates no group when the file does not exist', async () => {
    const { notify, groups, click } = mount({ exists: () => false })

    click(ABS_FILE, { target: 'side' })

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(groups.count).toBe(1)
  })

  it('creates no group for a directory target', async () => {
    const { groups, click } = mount({ exists: () => true, isDirectory: () => true })

    await act(async () => {
      click(ABS_FILE, { target: 'side' })
    })

    expect(groups.count).toBe(1)
  })
})

// Alt+click sends the target to an auxiliary window without touching the
// current layout. The already-open file is copied or moved by the shared
// helper; a fresh resource is created through the resolver.
describe('useMarkdownFileLink open in a new window', () => {
  const ABS_FILE = '/repo/src/a.ts'
  const ABS_MD = '/repo/docs/readme.md'

  it('opens a plain file in an auxiliary window', async () => {
    const { openEditor, openInNewWindow, groups, click } = mount({ exists: () => true })

    click(ABS_FILE, { target: 'newWindow' })

    await waitFor(() => expect(openInNewWindow).toHaveBeenCalledTimes(1))
    expect(openInNewWindow.mock.calls[0]?.[1]).toMatchObject({ mode: 'open', pinned: true })
    expect(openEditor).not.toHaveBeenCalled()
    expect(groups.count).toBe(1)
  })

  it('opens a markdown preview in the auxiliary window', async () => {
    const { openInNewWindow, click } = mount({ exists: () => true, previewLinks: true })

    click(ABS_MD, { target: 'newWindow' })

    await waitFor(() => expect(openInNewWindow).toHaveBeenCalledTimes(1))
    expect(openInNewWindow.mock.calls[0]?.[0]).toBeInstanceOf(MarkdownPreviewInput)
  })
})
