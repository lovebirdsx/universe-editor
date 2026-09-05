/*---------------------------------------------------------------------------------------------
 *  Regression: under React StrictMode the SCM view must still show resources that
 *  arrive after the provider view has mounted. A TreeModel owned by a plain
 *  useMemo+dispose effect gets disposed by StrictMode's mount→unmount→mount dry
 *  run, leaving a dead model whose structure events never reach <Tree> — so the
 *  list/tree stayed permanently empty.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
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
import { MarkdownPreviewInput } from '../../../services/editor/MarkdownPreviewInput.js'
import { HtmlPreviewInput } from '../../../services/editor/HtmlPreviewInput.js'
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

class FakeEditorGroup {
  activeEditor: unknown
  opened: Array<{ input: unknown; options: unknown }> = []

  get editors(): unknown[] {
    return this.activeEditor ? [this.activeEditor] : []
  }

  indexOf(): number {
    return -1
  }

  findEditor(): undefined {
    return undefined
  }

  openEditor(input: unknown, options?: unknown): void {
    this.opened.push({ input, options })
    this.activeEditor = input
  }

  closeEditor(): void {}
}

function setup() {
  const scm = new ScmService()
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const openRealFile = vi.fn().mockResolvedValue(undefined)
  const editorGroup = new FakeEditorGroup()
  const stubCommand: ICommandServiceType = {
    _serviceBrand: undefined,
    executeCommand,
  }
  const stubEditorResolver: IEditorResolverServiceType = {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor: openRealFile,
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  // Row menus resolve their `when` clauses against a scoped context, so the real
  // service is needed rather than a stub.
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: editorGroup,
    getGroups: () => [editorGroup],
    activateGroup: (g: unknown) => g,
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, stubEditorResolver)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <StrictMode>
        <ScmView />
      </StrictMode>
    </ServicesContext.Provider>,
  )
  return { scm, executeCommand, openRealFile, editorGroup }
}

afterEach(() => cleanup())

describe('ScmView under StrictMode', () => {
  let contributions: IDisposable[] = []
  afterEach(() => {
    contributions.forEach((d) => d.dispose())
    contributions = []
  })

  it('renders resources that arrive after the provider view has mounted', async () => {
    const { scm } = setup()

    // 1. The provider view mounts with an empty group — this is when its
    //    TreeModel goes through StrictMode's mount→unmount→mount cycle.
    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$registerGroup(0, 1, 'changes', 'Changes')
    })

    // 2. Resources arrive later (the git scan finishes), driving the model via
    //    the snapshot rebuild + refresh path.
    await act(async () => {
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'M' },
      ])
    })

    expect(await screen.findByText('foo.txt')).toBeTruthy()
  })

  // Regression: the row menu's scoped ContextKeyService was created by a plain
  // useMemo and disposed from an effect cleanup, so StrictMode's dry run cleared
  // its keys before the real mount. Disposal is silent — reads fall through to
  // the parent — so every `scmProvider == …` clause turned false. Any re-render
  // that re-resolved the menu (the first ArrowDown does, via the menu's own
  // setState) then produced zero rows and the whole menu unmounted mid-keypress.
  it('keeps the row context menu open when the arrow keys move through it', async () => {
    contributions.push(
      MenuRegistry.addMenuItem(MenuId.ScmResourceStateContext, {
        command: 'perforce.reopen',
        title: 'Move to Changelist',
        when: 'scmProvider == perforce && scmResourceState == E',
        group: '2_modify',
        order: 1,
      }),
      MenuRegistry.addMenuItem(MenuId.ScmResourceStateContext, {
        command: 'perforce.revert',
        title: 'Revert',
        when: 'scmProvider == perforce && scmResourceState == E',
        group: '2_modify',
        order: 2,
      }),
    )

    const { scm } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'default', 'Default Changelist')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'E' },
      ])
    })

    const label = await screen.findByText('foo.txt')
    const row = label.closest('[role="treeitem"]') as HTMLElement
    fireEvent.click(row)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ContextMenu' })

    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Move to Changelist')).toBeTruthy()

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowDown' })
    })

    expect(screen.queryByRole('menu')).not.toBeNull()
    expect(document.querySelector('[role="menuitem"][data-active]')?.textContent).toContain(
      'Revert',
    )
  })

  it('disables Commit when git has no local changes and nothing to synchronize', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.commit', title: 'Commit', disabled: true },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Commit' })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('shows Pull Rebase when git has no local changes and local plus remote commits exist', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.pullRebase', title: 'Pull Rebase' },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Pull Rebase' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.pullRebase', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })

  it('shows Push when git has no local changes and only local commits exist', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.push', title: 'Push' },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Push' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.push', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })

  it('shows Pull when git has no local changes and only remote commits exist', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.pull', title: 'Pull' },
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
    })

    const button = (await screen.findByRole('button', { name: 'Pull' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.pull', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })

  it('keeps Commit enabled when git has local changes', async () => {
    const { scm, executeCommand } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$updateSourceControl(0, {
        acceptInputCommand: { command: 'git.commit', title: 'Commit' },
        // With changes present, git reports the full commit split-button actions;
        // the primary (first) is Commit.
        acceptInputActions: [
          { command: 'git.commit', title: 'Commit', icon: 'git-commit' },
          { command: 'git.commitAmend', title: 'Commit (Amend)', icon: 'git-commit' },
          { command: 'git.commitAndPush', title: 'Commit & Push', icon: 'push' },
          { command: 'git.commitAndSync', title: 'Commit & Sync', icon: 'sync' },
        ],
      })
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'M' },
      ])
    })

    const button = (await screen.findByRole('button', { name: 'Commit' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(executeCommand).toHaveBeenCalledWith('git.commit', {
      rootUri: 'D:/repo',
      sourceControlId: 'git',
    })
  })
})

describe('ScmView — markdown preview action', () => {
  it('shows a preview button for markdown files and opens a markdown preview', async () => {
    const { scm, executeCommand, openRealFile, editorGroup } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
      await scm.$updateGroupResourceStates(1, [
        {
          resourceUri: 'D:/repo/README.md',
          contextValue: 'M',
          command: { command: 'git.openChange', title: 'Open Change' },
        },
      ])
    })

    const label = await screen.findByText('README.md')
    const row = label.closest('[role="treeitem"]')
    expect(row).not.toBeNull()
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Open Preview' }))

    expect(editorGroup.opened).toHaveLength(1)
    const previewInput = editorGroup.opened[0]?.input
    expect(previewInput).toBeInstanceOf(MarkdownPreviewInput)
    expect(editorGroup.opened[0]?.options).toEqual({ activate: true, pinned: true })
    expect((previewInput as MarkdownPreviewInput | undefined)?.sourceUri.fsPath).toContain(
      'README.md',
    )
    expect(executeCommand).not.toHaveBeenCalled()
    expect(openRealFile).not.toHaveBeenCalled()
  })

  it('does not show a preview button for non-markdown files', async () => {
    const { scm } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
      await scm.$updateGroupResourceStates(1, [
        {
          resourceUri: 'D:/repo/src/main.ts',
          contextValue: 'M',
          command: { command: 'git.openChange', title: 'Open Change' },
        },
      ])
    })

    await screen.findByText('main.ts')
    expect(screen.queryByRole('button', { name: 'Open Preview' })).toBeNull()
  })

  it('shows a preview button for html files and opens an html preview', async () => {
    const { scm, editorGroup } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
      await scm.$registerGroup(0, 1, 'workingTree', 'Changes')
      await scm.$updateGroupResourceStates(1, [
        {
          resourceUri: 'D:/repo/index.html',
          contextValue: 'M',
          command: { command: 'git.openChange', title: 'Open Change' },
        },
      ])
    })

    const label = await screen.findByText('index.html')
    const row = label.closest('[role="treeitem"]')
    expect(row).not.toBeNull()
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Open Preview' }))

    expect(editorGroup.opened).toHaveLength(1)
    const previewInput = editorGroup.opened[0]?.input
    expect(previewInput).toBeInstanceOf(HtmlPreviewInput)
    expect(editorGroup.opened[0]?.options).toEqual({ activate: true, pinned: true })
    expect((previewInput as HtmlPreviewInput | undefined)?.sourceUri.fsPath).toContain('index.html')
  })
})
