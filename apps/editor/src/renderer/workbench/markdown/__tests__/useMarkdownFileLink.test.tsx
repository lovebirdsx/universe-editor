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
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import type {
  IEditorResolverService as IEditorResolverServiceType,
  IEditorService as IEditorServiceType,
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

function makeFileSearch(): IFileSearchServiceType {
  return {
    _serviceBrand: undefined,
    search: () => Promise.resolve({ results: [] }),
  } as unknown as IFileSearchServiceType
}

function mount(options: {
  exists: (uri: URI) => boolean
  remoteStatus?: IRemoteStatusService
  previewLinks?: boolean
  isDirectory?: (uri: URI) => boolean
}) {
  const openEditor = vi.fn().mockResolvedValue(undefined)
  const notify = vi.fn()
  const groups = new EditorGroupsService()
  const services = new ServiceCollection()
  services.set(IWorkspaceService, makeWorkspace() as never)
  services.set(IEditorGroupsService, groups as never)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor,
  } as unknown as IEditorResolverServiceType)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(),
  } as unknown as IEditorServiceType)
  services.set(IFileService, makeFileService(options.exists, options.isDirectory))
  services.set(IFileSearchService, makeFileSearch())
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
    notify,
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

// Ctrl/Cmd+click sends the target to the group beside the active one. The group
// has to be created and activated at the open itself, because the resolver and
// the editor service route a new editor through `activeGroupForOpen`. A click
// that ends up opening nothing must not leave an empty group behind.
describe('useMarkdownFileLink open to the side', () => {
  const ABS_FILE = '/repo/src/a.ts'
  const ABS_MD = '/repo/docs/readme.md'

  it('creates and activates the side group for a plain file', async () => {
    const { openEditor, groups, click } = mount({ exists: () => true })

    click(ABS_FILE, { toSide: true })

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

    click(ABS_MD, { toSide: true })

    await waitFor(() => expect(groups.count).toBe(2))
    const side = groups.getGroups()[1]!
    expect(side.editors).toHaveLength(1)
    expect(side.editors[0]!).toBeInstanceOf(MarkdownPreviewInput)
  })

  it('creates no group when the file does not exist', async () => {
    const { notify, groups, click } = mount({ exists: () => false })

    click(ABS_FILE, { toSide: true })

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    expect(groups.count).toBe(1)
  })

  it('creates no group for a directory target', async () => {
    const { groups, click } = mount({ exists: () => true, isDirectory: () => true })

    await act(async () => {
      click(ABS_FILE, { toSide: true })
    })

    expect(groups.count).toBe(1)
  })
})
