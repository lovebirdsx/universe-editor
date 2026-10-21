/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: the tab right-click menu must compute position-gated entries from
 *  the *clicked* tab, not from the workbench-active editor. Right-clicking a tab
 *  does not activate it, so with tabs [A, B, C] and A active, the root context
 *  says "first in group" while the cursor is over C. Before the fix only
 *  editor type / resource scheme / pin state were scoped, so `activeEditorIsFirstInGroup`
 *  and `activeEditorIsLastInGroup` leaked in from the root context and Close
 *  Left/Right visibility was inverted.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  Action2,
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  GroupDirection,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  MenuId,
  ServiceCollection,
  URI,
  registerAction2,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
  type IDisposable,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import {
  CloseEditorsToTheLeftAction,
  CloseEditorsToTheRightAction,
} from '../../../actions/editorActions.js'

class FakeEditor extends EditorInput {
  constructor(private readonly _name: string) {
    super()
  }
  get typeId() {
    return 'fake'
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
}

function FakeComponent() {
  return <div data-testid="fake-editor" />
}

const stubDialog: IDialogServiceType = {
  _serviceBrand: undefined,
  confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
  prompt: async () => undefined,
}

const executed: Array<{ id: string; args: unknown[] }> = []
const stubCommand: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand(id: string, ...args: unknown[]) {
    executed.push({ id, args })
    return undefined
  },
}

const disposables: IDisposable[] = []

afterEach(() => {
  executed.length = 0
  while (disposables.length) disposables.pop()!.dispose()
})

function setup(): {
  groups: EditorGroupsService
  a: FakeEditor
  b: FakeEditor
  c: FakeEditor
  rootContext: ContextKeyService
} {
  disposables.push(
    registerAction2(CloseEditorsToTheLeftAction),
    registerAction2(CloseEditorsToTheRightAction),
    EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
  )
  const groups = new EditorGroupsService()
  disposables.push(groups)
  const a = new FakeEditor('a')
  const b = new FakeEditor('b')
  const c = new FakeEditor('c')
  groups.activeGroup.openEditor(a)
  groups.activeGroup.openEditor(b)
  groups.activeGroup.openEditor(c)
  groups.activeGroup.setActive(a)

  const rootContext = new ContextKeyService()
  disposables.push(rootContext)
  // Mirrors what ContextKeyContribution syncs from activeGroup.activeEditor.
  rootContext.set('hasActiveEditor', true)
  rootContext.set('editorIsOpen', true)
  rootContext.set('groupEditorsCount', 3)
  rootContext.set('activeEditorIsFirstInGroup', true)
  rootContext.set('activeEditorIsLastInGroup', false)
  return { groups, a, b, c, rootContext }
}

function renderGroup(
  groups: EditorGroupsService,
  rootContext: ContextKeyService,
  group = groups.activeGroup,
): ReturnType<typeof render> {
  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, rootContext)
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <EditorGroupView
        group={group}
        groupsService={groups}
        resolveComponent={(() => FakeComponent) as never}
      />
    </ServicesContext.Provider>,
  )
}

class TabsBarProbeAction extends Action2 {
  static readonly ID = 'test.tabsBar.onlyFirst'
  constructor() {
    super({
      id: TabsBarProbeAction.ID,
      title: 'Tabs Bar Probe',
      menu: {
        id: MenuId.EditorTabsBarContext,
        group: '9_probe',
        when: 'activeEditorIsFirstInGroup',
      },
    })
  }
  override run(): void {}
}

// Keeps the menu non-empty so it renders even when the probe is filtered out.
class TabsBarSentinelAction extends Action2 {
  static readonly ID = 'test.tabsBar.sentinel'
  constructor() {
    super({
      id: TabsBarSentinelAction.ID,
      title: 'Tabs Bar Sentinel',
      menu: { id: MenuId.EditorTabsBarContext, group: '9_probe' },
    })
  }
  override run(): void {}
}

async function openTabMenu(index: number): Promise<void> {
  const tabs = await screen.findAllByRole('tab')
  fireEvent.contextMenu(tabs[index]!, { clientX: 10, clientY: 10 })
}

describe('EditorGroupView — tab context menu follows the clicked tab', () => {
  it('right-clicking the last tab offers Close Left even when the first tab is active', async () => {
    const { groups, a, c, rootContext } = setup()
    renderGroup(groups, rootContext)

    await openTabMenu(2)

    // Right-click must not activate the clicked tab (VSCode parity).
    expect(groups.activeGroup.activeEditor).toBe(a)
    expect(await screen.findByText('Close Editors to the Left')).toBeTruthy()
    expect(screen.queryByText('Close Editors to the Right')).toBeNull()

    fireEvent.click(screen.getByText('Close Editors to the Left'))
    expect(executed.at(-1)?.id).toBe(CloseEditorsToTheLeftAction.ID)
    expect(executed.at(-1)?.args[0]).toMatchObject({
      editorId: c.id,
      groupId: groups.activeGroup.id,
    })
  })

  it('right-clicking the first tab offers Close Right even when the last tab is active', async () => {
    const { groups, c, a, rootContext } = setup()
    // Flip the root context to "C is active": first=false, last=true.
    groups.activeGroup.setActive(c)
    rootContext.set('activeEditorIsFirstInGroup', false)
    rootContext.set('activeEditorIsLastInGroup', true)
    renderGroup(groups, rootContext)

    await openTabMenu(0)

    expect(await screen.findByText('Close Editors to the Right')).toBeTruthy()
    expect(screen.queryByText('Close Editors to the Left')).toBeNull()

    fireEvent.click(screen.getByText('Close Editors to the Right'))
    expect(executed.at(-1)?.id).toBe(CloseEditorsToTheRightAction.ID)
    expect(executed.at(-1)?.args[0]).toMatchObject({
      editorId: a.id,
      groupId: groups.activeGroup.id,
    })
  })
})

// The group right-click menu is evaluated on its own scoped context during the
// very first render, before any effect could seed it. It must already describe
// the right-clicked group instead of falling through to the root (active group).
describe('EditorGroupView — group context menu scoped on first render', () => {
  it('evaluates when-clauses against the right-clicked group, not the active group', async () => {
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const g1 = groups.activeGroup
    g1.openEditor(new FakeEditor('a'))
    g1.openEditor(new FakeEditor('b'))
    g1.setActive(g1.editors[1]!) // first=false in g1
    const g2 = groups.addGroup(g1, GroupDirection.Right)
    g2.openEditor(new FakeEditor('other')) // first=true in g2
    groups.activateGroup(g2)
    disposables.push(
      registerAction2(TabsBarProbeAction),
      registerAction2(TabsBarSentinelAction),
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )

    const rootContext = new ContextKeyService()
    disposables.push(rootContext)
    rootContext.set('activeEditorIsFirstInGroup', true)
    renderGroup(groups, rootContext, g1)

    const tabBar = await screen.findByTestId('editor-group-tabbar')
    fireEvent.contextMenu(tabBar, { clientX: 10, clientY: 10 })

    // g1's active tab is last, so the first-only entry must stay hidden even
    // though the workbench-active group's active tab is first.
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(screen.getByText('Tabs Bar Sentinel')).toBeTruthy()
    expect(screen.queryByText('Tabs Bar Probe')).toBeNull()
  })

  it('shows the entry when the right-clicked group matches the condition', async () => {
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const g1 = groups.activeGroup
    g1.openEditor(new FakeEditor('a'))
    g1.openEditor(new FakeEditor('b'))
    g1.setActive(g1.editors[0]!) // first=true in g1
    const g2 = groups.addGroup(g1, GroupDirection.Right)
    g2.openEditor(new FakeEditor('other'))
    groups.activateGroup(g2)
    disposables.push(
      registerAction2(TabsBarProbeAction),
      registerAction2(TabsBarSentinelAction),
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )

    const rootContext = new ContextKeyService()
    disposables.push(rootContext)
    rootContext.set('activeEditorIsFirstInGroup', false)
    renderGroup(groups, rootContext, g1)

    const tabBar = await screen.findByTestId('editor-group-tabbar')
    fireEvent.contextMenu(tabBar, { clientX: 10, clientY: 10 })

    expect(await screen.findByText('Tabs Bar Probe')).toBeTruthy()
  })
})
