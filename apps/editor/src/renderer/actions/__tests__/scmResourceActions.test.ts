/*---------------------------------------------------------------------------------------------
 *  Tests for the SCM row's open actions. They used to be buttons hard-coded in
 *  ScmView, so no context menu could reach them; they are menu commands now and
 *  both surfaces render the same contribution.
 *
 *  Two things in the click path aren't visible from the ScmView test and are
 *  asserted here: the action reattaches the *window's* remote authority — the
 *  workspace-folder derivation the extension API uses answers undefined for an
 *  empty remote window and would open a client-local file:// instead — and it
 *  ignores payloads that carry no path rather than opening something arbitrary.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Event,
  IEditorGroupsService,
  IEditorResolverService,
  IWorkspaceService,
  REMOTE_SCHEME,
  URI,
  runWithInvocationModifiers,
  type IEditorResolverService as IEditorResolverServiceType,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { openResourcePreview } from '../../services/resourcePreview/openResourcePreview.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { FakeWindowFocusService } from '../../services/windows/testing/fakeWindowFocusService.js'
import { ScmOpenFileAction, ScmOpenPreviewAction } from '../scmResourceActions.js'

// The preview plumbing has its own tests (openPreviewInGroup / EditorGroups); what
// matters here is that the action routes the row's resource into the active group.
vi.mock('../../services/resourcePreview/openResourcePreview.js', () => ({
  openResourcePreview: vi.fn(() => true),
}))

const REMOTE_AUTHORITY = 'ssh-remote+host'
const REMOTE_ROOT = '/home/u/repo'
const ROW_PATH = `${REMOTE_ROOT}/src/a.ts`

function makeAccessor(current: { folder: URI } | null): {
  accessor: ServicesAccessor
  openEditor: ReturnType<typeof vi.fn>
  activeGroup: object
  windowFocus: FakeWindowFocusService
} {
  const openEditor = vi.fn().mockResolvedValue(undefined)
  const activeGroup = { id: 'group' }
  const windowFocus = new FakeWindowFocusService()
  const resolver: IEditorResolverServiceType = {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    createEditorInput: () => {
      throw new Error('unused')
    },
    resolveEditors: () => [],
    openEditor,
  }
  const byId = new Map<unknown, unknown>([
    [IEditorResolverService, resolver],
    [IEditorGroupsService, { _serviceBrand: undefined, activeGroup }],
    [IWorkspaceService, { _serviceBrand: undefined, current, onDidChangeWorkspace: Event.None }],
    [IWindowFocusService, windowFocus],
  ])
  const accessor = {
    get: (id: unknown) => {
      const service = byId.get(id)
      if (service === undefined) throw new Error('unexpected service lookup')
      return service
    },
  } as unknown as ServicesAccessor
  return { accessor, openEditor, activeGroup, windowFocus }
}

const remoteFolder = (): URI =>
  URI.from({ scheme: REMOTE_SCHEME, authority: REMOTE_AUTHORITY, path: REMOTE_ROOT })

const rowArg = (resourceUri: string): unknown => ({ resourceUri, scmResourceGroupId: 'changes' })

beforeEach(() => {
  vi.mocked(openResourcePreview).mockClear()
})

describe('ScmOpenFileAction', () => {
  it('opens the row file with the window remote authority reattached', () => {
    const { accessor, openEditor } = makeAccessor({ folder: remoteFolder() })

    new ScmOpenFileAction().run(accessor, rowArg(ROW_PATH))

    expect(openEditor).toHaveBeenCalledTimes(1)
    const [uri, options] = openEditor.mock.calls[0] as [URI, { pinned: boolean }]
    expect(uri.scheme).toBe(REMOTE_SCHEME)
    expect(uri.authority).toBe(REMOTE_AUTHORITY)
    expect(uri.path).toBe(ROW_PATH)
    expect(options).toEqual({ pinned: true })
  })

  // The window's authority, not the workspace folder's: an empty remote window
  // ("New Window" off a remote session) has no folder to derive it from.
  it('falls back to the window argv authority when there is no workspace folder', () => {
    const host = window as unknown as { ipc?: unknown }
    host.ipc = { remoteAuthority: REMOTE_AUTHORITY }
    try {
      const { accessor, openEditor } = makeAccessor(null)

      new ScmOpenFileAction().run(accessor, rowArg(ROW_PATH))

      const [uri] = openEditor.mock.calls[0] as [URI]
      expect(uri.scheme).toBe(REMOTE_SCHEME)
      expect(uri.authority).toBe(REMOTE_AUTHORITY)
    } finally {
      delete host.ipc
    }
  })

  it('ignores payloads that carry no resource path', () => {
    const { accessor, openEditor } = makeAccessor(null)
    const action = new ScmOpenFileAction()

    action.run(accessor)
    action.run(accessor, undefined)
    action.run(accessor, {})
    action.run(accessor, { resourceUri: '' })
    action.run(accessor, 'D:/repo/a.ts')

    expect(openEditor).not.toHaveBeenCalled()
  })
})

describe('ScmOpenPreviewAction', () => {
  it('opens the row preview with the same URI, honouring the click modifiers', () => {
    const { accessor } = makeAccessor({ folder: remoteFolder() })
    const action = new ScmOpenPreviewAction()

    action.run(accessor, rowArg(ROW_PATH))
    runWithInvocationModifiers({ ctrlKey: true }, () => action.run(accessor, rowArg(ROW_PATH)))

    expect(openResourcePreview).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(openResourcePreview).mock.calls as unknown as [
      ServicesAccessor,
      URI,
      string,
    ][]
    const [passed, uri, target] = calls[0]!
    expect(passed).toBe(accessor)
    expect(uri.authority).toBe(REMOTE_AUTHORITY)
    expect(uri.path).toBe(ROW_PATH)
    expect(target).toBe('default')
    expect(calls[1]![2]).toBe('side')
  })

  it('ignores payloads that carry no resource path', () => {
    const { accessor } = makeAccessor(null)

    new ScmOpenPreviewAction().run(accessor, {})

    expect(openResourcePreview).not.toHaveBeenCalled()
  })
})
