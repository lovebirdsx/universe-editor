/*---------------------------------------------------------------------------------------------
 *  Vim tabs surface for EditorGroupView: h/l move the cursor and activate the
 *  adjacent editor while DOM focus stays on the tab, Enter hands focus to the
 *  editor body, x closes the focused tab, p pins, and the focus command lands
 *  on the active tab.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IEditorGroup,
} from '@universe-editor/platform'
import {
  __resetVimSurfacesForTests,
  getActiveVimSurface,
  type IVimSurfaceActions,
} from '@universe-editor/workbench-ui'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { focusActiveEditorTabs } from '../editorTabsFocus.js'

const stubDialog = {
  _serviceBrand: undefined,
  confirm: async () => ({ confirmed: false, choice: 'cancel' as const }),
  prompt: async () => undefined,
}

const stubCommand = {
  _serviceBrand: undefined,
  async executeCommand() {
    return undefined
  },
}

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

function FakeComponent({ input }: { input: { label: string } }) {
  return <div data-testid="fake-editor">{input.label}</div>
}

const components = new Map<string, ComponentType<{ input: { label: string } }>>([
  ['fake', FakeComponent],
])

function renderGroup(group: IEditorGroup, groupsService: EditorGroupsService) {
  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, new ContextKeyService())
  const instantiation = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={instantiation}>
      <EditorGroupView
        group={group}
        groupsService={groupsService}
        resolveComponent={((key: string) => components.get(key)) as never}
      />
    </ServicesContext.Provider>,
  )
}

function surfaceActions(): IVimSurfaceActions {
  const active = getActiveVimSurface(document)
  expect(active).toBeDefined()
  expect(active?.surface.kind).toBe('tabs')
  return active!.surface.actions
}

function tabFor(id: string): HTMLElement {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (element) => element.getAttribute('data-editor-id') === id,
  )
  expect(tab).toBeDefined()
  return tab!
}

describe('EditorGroupView vim tabs surface', () => {
  beforeEach(() => {
    __resetVimSurfacesForTests()
  })
  afterEach(() => {
    cleanup()
    __resetVimSurfacesForTests()
  })

  it('next/previous activate the adjacent editor and keep focus on the tab', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    const c = new FakeEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    renderGroup(svc.activeGroup, svc)

    tabFor(c.id).focus()
    act(() => surfaceActions().previous?.(1))
    expect(svc.activeGroup.activeEditor).toBe(b)
    expect(document.activeElement).toBe(tabFor(b.id))

    act(() => surfaceActions().next?.(1))
    expect(svc.activeGroup.activeEditor).toBe(c)
    expect(document.activeElement).toBe(tabFor(c.id))
  })

  it('first/last jump to the ends and activate', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    renderGroup(svc.activeGroup, svc)

    tabFor(b.id).focus()
    act(() => surfaceActions().first?.(0))
    expect(svc.activeGroup.activeEditor).toBe(a)
    expect(document.activeElement).toBe(tabFor(a.id))

    act(() => surfaceActions().last?.(0))
    expect(svc.activeGroup.activeEditor).toBe(b)
    expect(document.activeElement).toBe(tabFor(b.id))
  })

  it('1G jumps to the first tab (a typed count is the 1-based target)', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    renderGroup(svc.activeGroup, svc)

    tabFor(b.id).focus()
    act(() => surfaceActions().last?.(1))
    expect(svc.activeGroup.activeEditor).toBe(a)
    expect(document.activeElement).toBe(tabFor(a.id))
  })

  it('activate hands focus to the editor body', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a)
    renderGroup(svc.activeGroup, svc)

    tabFor(a.id).focus()
    act(() => surfaceActions().activate?.(1, false))
    expect(svc.activeGroup.activeEditor).toBe(a)
    expect((document.activeElement as HTMLElement | null)?.getAttribute('role')).not.toBe('tab')
  })

  // Escape leaves the strip through the same activation path as Enter, so
  // editors that self-focus on activation (image, settings, keybindings) get a
  // fresh activationId and land their own focus target.
  it('escape re-activates the editor and leaves the tab strip', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a)
    renderGroup(svc.activeGroup, svc)

    tabFor(a.id).focus()
    svc.activeGroup.preserveFocusOnActivation?.(true)
    const before = svc.activeGroup.activationId
    act(() => surfaceActions().escape?.(1))
    expect(svc.activeGroup.activeEditor).toBe(a)
    expect(svc.activeGroup.activationId).toBe(before + 1)
    expect(svc.activeGroup.lastActivationPreservedFocus).toBe(false)
    expect((document.activeElement as HTMLElement | null)?.getAttribute('role')).not.toBe('tab')
  })

  it('remove closes the focused tab', async () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    renderGroup(svc.activeGroup, svc)

    tabFor(b.id).focus()
    await act(async () => {
      surfaceActions().remove?.(1)
      await Promise.resolve()
    })
    expect(svc.activeGroup.editors.map((editor) => editor.id)).not.toContain(b.id)
  })

  it('toggle pins and unpins the focused tab', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { pinned: false })
    renderGroup(svc.activeGroup, svc)

    tabFor(a.id).focus()
    expect(svc.activeGroup.isSticky(a)).toBe(false)
    act(() => surfaceActions().toggle?.(1))
    expect(svc.activeGroup.isSticky(a)).toBe(true)
    act(() => surfaceActions().toggle?.(1))
    expect(svc.activeGroup.isSticky(a)).toBe(false)
  })

  it('focusActiveEditorTabs lands on the active tab', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    renderGroup(svc.activeGroup, svc)

    expect(focusActiveEditorTabs()).toBe(true)
    expect(document.activeElement).toBe(tabFor(b.id))
  })

  it('releases the preserve-focus hold when the strip unmounts', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    const preserve = vi.spyOn(svc.activeGroup, 'preserveFocusOnActivation')
    const view = renderGroup(svc.activeGroup, svc)

    tabFor(b.id).focus()
    act(() => surfaceActions().previous?.(1))
    expect(preserve).toHaveBeenCalledWith(true)

    view.unmount()
    expect(preserve).toHaveBeenLastCalledWith(false)
  })
})
