/*---------------------------------------------------------------------------------------------
 *  Regression: SCM file rows and group headers must open a context menu on
 *  right-click, surfacing provider commands that live in non-inline menu groups.
 *
 *  The reported p4 bug: "Move to Changelist" (and the other reopen/shelve commands)
 *  sat in `2_modify` / `1_edit` groups, but the file row only rendered `inline`
 *  actions and the view had no context menu — so those commands had no UI entry
 *  point at all. This guards the right-click menu + that it includes non-inline
 *  commands.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
  CommandsRegistry,
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IEditorResolverService,
  IStorageService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  type IDisposable,
  type ICommandService as ICommandServiceType,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorResolverService as IEditorResolverServiceType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { ScmView } from '../ScmView.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { scmViewState } from '../scmViewState.js'
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

function setup() {
  const scm = new ScmService()
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const stubCommand: ICommandServiceType = { _serviceBrand: undefined, executeCommand }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  // The row context menu resolves its `when` clauses against a scoped context
  // (Explorer parity), so the real service is needed rather than a stub.
  const contextKeyService = new ContextKeyService()
  services.set(IContextKeyService, contextKeyService)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { openEditor() {}, closeEditor() {}, indexOf: () => -1 },
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEditorResolverServiceType)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ScmView />
    </ServicesContext.Provider>,
  )
  return { scm, executeCommand, contextKeyService }
}

afterEach(() => cleanup())

describe('ScmView — file-row context menu', () => {
  let contributions: IDisposable[] = []
  afterEach(() => {
    contributions.forEach((d) => d.dispose())
    contributions = []
  })

  it('right-clicking a file row shows a non-inline provider command and runs it with the selection', async () => {
    // Contribute a non-inline command exactly like perforce's "Move to Changelist"
    // (group 2_modify): it must NOT render as an inline button, but MUST appear in
    // the right-click menu.
    contributions.push(
      MenuRegistry.addMenuItem(MenuId.ScmResourceStateContext, {
        command: 'perforce.reopen',
        title: 'Move to Changelist',
        when: 'scmProvider == perforce && scmResourceState == E',
        group: '2_modify',
        order: 1,
      }),
    )

    const { scm, executeCommand } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'default', 'Default Changelist')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'E' },
      ])
    })

    const label = await screen.findByText('foo.txt')
    const row = label.closest('[role="treeitem"]') as HTMLElement
    expect(row).not.toBeNull()

    // The command lives in a non-inline group, so it must not be an inline button.
    expect(screen.queryByRole('button', { name: 'Move to Changelist' })).toBeNull()

    fireEvent.contextMenu(row)

    const menuItem = await screen.findByText('Move to Changelist')
    // A mouse-opened menu starts with nothing highlighted: the pointer is the
    // cursor, and a pre-highlighted row would read as a pending action.
    expect(document.querySelector('[role="menuitem"][data-active]')).toBeNull()
    fireEvent.click(menuItem)

    expect(executeCommand).toHaveBeenCalledWith(
      'perforce.reopen',
      expect.objectContaining({ resourceUri: 'D:/repo/foo.txt', scmResourceGroupId: 'default' }),
      expect.arrayContaining([expect.objectContaining({ resourceUri: 'D:/repo/foo.txt' })]),
    )
  })

  // Regression: the ContextMenu key opened a menu that was a mouse-only widget —
  // no arrow-key navigation, no Enter, nothing marking a current row — so the
  // menu looked unfocused and could only be driven with the mouse. Explorer had
  // keyboard navigation all along because it renders the shared ContextMenu.
  //
  // The resource carries a Windows path on purpose: row ids embed it, and <Tree>
  // used to interpolate the id straight into a CSS selector, where a backslash
  // reads as an escape introducer. The lookup then found no row and the key
  // press produced no menu at all.
  it('the ContextMenu key opens a menu focused on its first entry', async () => {
    contributions.push(
      MenuRegistry.addMenuItem(MenuId.ScmResourceStateContext, {
        command: 'perforce.reopen',
        title: 'Move to Changelist',
        when: 'scmProvider == perforce && scmResourceState == E',
        group: '2_modify',
        order: 1,
      }),
    )

    const resourceUri = 'D:\\repo\\foo.txt'
    const { scm, executeCommand } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:\\repo')
      await scm.$registerGroup(0, 1, 'default', 'Default Changelist')
      await scm.$updateGroupResourceStates(1, [{ resourceUri, contextValue: 'E' }])
    })

    const label = await screen.findByText('foo.txt')
    const row = label.closest('[role="treeitem"]') as HTMLElement
    expect(row).not.toBeNull()

    // Focus the row, then press the ContextMenu key on the tree: <Tree> turns it
    // into a contextmenu dispatched on the focused row (Tree.openKeyboardContextMenu).
    const tree = screen.getByRole('tree')
    fireEvent.click(row)
    fireEvent.keyDown(tree, { key: 'ContextMenu' })

    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Move to Changelist')).toBeTruthy()

    // A keyboard-opened menu highlights its first entry right away (VSCode
    // parity) — there is no pointer to aim, so Enter must work immediately.
    // Navigation uses a virtual cursor (data-active / aria-activedescendant)
    // and deliberately leaves DOM focus on the tree.
    const active = document.querySelector('[role="menuitem"][data-active]')
    expect(active?.textContent).toContain('Move to Changelist')
    expect(menu.getAttribute('aria-activedescendant')).toBe(active?.id)

    act(() => {
      fireEvent.keyDown(window, { key: 'Enter' })
    })

    expect(executeCommand).toHaveBeenCalledWith(
      'perforce.reopen',
      expect.objectContaining({ resourceUri, scmResourceGroupId: 'default' }),
      expect.arrayContaining([expect.objectContaining({ resourceUri })]),
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('ScmView — folder-row context menu (tree mode)', () => {
  let contributions: IDisposable[] = []
  afterEach(() => {
    contributions.forEach((d) => d.dispose())
    contributions = []
    scmViewState.setViewMode('list')
  })

  it('right-clicking a folder runs a folder command over every file beneath it', async () => {
    scmViewState.setViewMode('tree')
    contributions.push(
      MenuRegistry.addMenuItem(MenuId.ScmResourceFolderContext, {
        command: 'perforce.reopen',
        title: 'Move to Changelist',
        when: 'scmProvider == perforce',
        group: 'inline',
        order: 1,
      }),
    )

    const { scm, executeCommand } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'default', 'Default Changelist')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/src/a.txt', contextValue: 'E' },
        { resourceUri: 'D:/repo/src/b.txt', contextValue: 'E' },
      ])
    })

    // The folder row for "src" must exist and be right-clickable.
    const folderLabel = await screen.findByText('src')
    const folderRow = folderLabel.closest('[role="treeitem"]') as HTMLElement
    expect(folderRow).not.toBeNull()

    fireEvent.contextMenu(folderRow)
    const menu = await screen.findByRole('menu')
    const menuItem = within(menu).getByText('Move to Changelist')
    fireEvent.click(menuItem)

    // Primary arg is the folder path (isDirectory), selection is every file below.
    expect(executeCommand).toHaveBeenCalledWith(
      'perforce.reopen',
      expect.objectContaining({ isDirectory: true, scmResourceGroupId: 'default' }),
      expect.arrayContaining([
        expect.objectContaining({ resourceUri: 'D:/repo/src/a.txt' }),
        expect.objectContaining({ resourceUri: 'D:/repo/src/b.txt' }),
      ]),
    )
  })
})

describe('ScmView — drag files onto a changelist group', () => {
  let registered: IDisposable | undefined
  afterEach(() => {
    registered?.dispose()
    registered = undefined
  })

  it('dropping file URIs on a group header runs the provider reopen-to command', async () => {
    // The group becomes a drop target only because the provider registers the
    // `<providerId>.reopenTo` convention command (probed via CommandsRegistry).
    registered = CommandsRegistry.registerCommand('perforce.reopenTo', () => undefined)

    const { scm, executeCommand } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'cl:5', '#5: feature')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'E' },
      ])
    })

    const groupRow = (await screen.findByText('#5: feature')).closest(
      '[role="treeitem"]',
    ) as HTMLElement
    expect(groupRow).not.toBeNull()

    const dataTransfer = {
      types: ['text/uri-list'],
      files: [] as unknown as FileList,
      getData: (type: string) => (type === 'text/uri-list' ? 'file:///D:/repo/bar.txt' : ''),
      setData: () => {},
      dropEffect: 'none',
      effectAllowed: 'all',
    }

    fireEvent.drop(groupRow, { dataTransfer })

    expect(executeCommand).toHaveBeenCalledWith(
      'perforce.reopenTo',
      expect.objectContaining({ scmResourceGroupId: 'cl:5' }),
      expect.arrayContaining([
        expect.objectContaining({ resourceUri: 'D:/repo/bar.txt', scmResourceGroupId: 'cl:5' }),
      ]),
    )
  })
})
