/*---------------------------------------------------------------------------------------------
 *  Regression: under a remote-ssh workspace, SCM change rows must open their
 *  source file with a remote-ssh URI (authority reattached), not a client-local
 *  `file://` URI pointing at a non-existent path.
 *
 *  The SCM wire contract carries bare provider-host fs-path strings; the renderer
 *  must reattach the current workspace's remote authority via fsPathToWorkspaceUri.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IEditorGroupsService,
  IEditorResolverService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  type ICommandService as ICommandServiceType,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorResolverService as IEditorResolverServiceType,
  type IStorageService as IStorageServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ScmView } from '../ScmView.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'

const stubStorage: IStorageServiceType = {
  _serviceBrand: undefined,
  async get() {
    return undefined
  },
  async set() {},
  async remove() {},
  onDidChangeWorkspaceScope: Event.None,
}

const REMOTE_AUTHORITY = 'ssh-remote+host'
const REMOTE_ROOT = '/home/u/repo'
const REMOTE_FILE = `${REMOTE_ROOT}/src/a.ts`

function setup() {
  const scm = new ScmService()
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const openEditor = vi.fn().mockResolvedValue(undefined)
  const stubCommand: ICommandServiceType = { _serviceBrand: undefined, executeCommand }
  const stubEditorResolver: IEditorResolverServiceType = {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor,
  }
  const stubWorkspace: IWorkspaceServiceType = {
    _serviceBrand: undefined,
    current: {
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: REMOTE_AUTHORITY, path: REMOTE_ROOT }),
      name: 'repo',
    },
    onDidChangeWorkspace: Event.None,
    recent: [],
    onDidChangeRecent: Event.None,
    whenReady: Promise.resolve(),
    openFolder: async () => {},
    closeFolder: async () => {},
    removeRecent: async () => {},
    clearRecent: async () => {},
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { openEditor() {}, closeEditor() {}, indexOf: () => -1 },
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, stubEditorResolver)
  services.set(IWorkspaceService, stubWorkspace)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ScmView />
    </ServicesContext.Provider>,
  )
  return { scm, openEditor }
}

afterEach(() => cleanup())

describe('ScmView — remote workspace source-file open', () => {
  it('opens the file row with a remote-ssh URI (authority reattached, not file://)', async () => {
    const { scm, openEditor } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', REMOTE_ROOT)
      await scm.$registerGroup(0, 1, 'changes', 'Changes')
      await scm.$updateGroupResourceStates(1, [{ resourceUri: REMOTE_FILE, contextValue: 'M' }])
    })

    const label = await screen.findByText('a.ts')
    const row = label.closest('[role="treeitem"]') as HTMLElement
    expect(row).not.toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Open File' }))

    expect(openEditor).toHaveBeenCalledTimes(1)
    const [uri, options] = openEditor.mock.calls[0] as [URI, { pinned: boolean }]
    expect(uri.scheme).toBe(REMOTE_SCHEME)
    expect(uri.authority).toBe(REMOTE_AUTHORITY)
    expect(uri.path).toBe(REMOTE_FILE)
    expect(uri.toString()).toBe(`${REMOTE_SCHEME}://${REMOTE_AUTHORITY}${REMOTE_FILE}`)
    expect(options).toEqual({ pinned: true })
  })
})
