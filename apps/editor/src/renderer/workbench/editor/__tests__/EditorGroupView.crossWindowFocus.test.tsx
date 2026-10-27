/*---------------------------------------------------------------------------------------------
 *  An activation that focuses an editor in another window's group must bring
 *  that window forward (e.g. Explorer in main opening into an auxiliary part).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IEditorPart,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import type { EditorGroup } from '../../../services/editor/EditorGroup.js'
import { ServicesContext } from '../../useService.js'
import { IWindowFocusService } from '../../../services/windows/windowFocusService.js'
import { FakeWindowFocusService } from '../../../services/windows/testing/fakeWindowFocusService.js'
import {
  IWorkbenchWindowService,
  type IWorkbenchWindowService as IWorkbenchWindowServiceType,
} from '../../../services/windows/workbenchWindowService.js'

class FakeEditor extends EditorInput {
  constructor(private readonly _name: string) {
    super()
  }
  get typeId() {
    return 'fake'
  }
  get resource() {
    return URI.file(`/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
}

function setup() {
  const groups = new EditorGroupsService()
  const aux = groups.createAuxiliaryPart({ activate: false })
  const auxGroup = aux.activeGroup as EditorGroup
  auxGroup.openEditor(new FakeEditor('a'))
  let activePart: IEditorPart = groups.mainPart
  const windows = {
    get activeWindow() {
      return { part: activePart }
    },
  } as unknown as IWorkbenchWindowServiceType
  const focus = new FakeWindowFocusService()
  const services = new ServiceCollection()
  services.set(IDialogService, {} as never)
  services.set(ICommandService, { executeCommand: async () => undefined } as never)
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IWorkbenchWindowService, windows)
  services.set(IWindowFocusService, focus)
  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <EditorGroupView group={auxGroup} groupsService={groups} resolveComponent={() => undefined} />
    </ServicesContext.Provider>,
  )
  return {
    groups,
    aux,
    auxGroup,
    focus,
    setActiveWindowPart: (p: IEditorPart) => (activePart = p),
  }
}

describe('EditorGroupView cross-window activation focus', () => {
  it('requests window focus when the activated group lives in another window', () => {
    const { groups, auxGroup, focus } = setup()
    act(() => groups.activateGroup(auxGroup))
    expect(groups.openTargetGroup).toBe(auxGroup)
    expect(focus.focusedGroups).toEqual([auxGroup])
  })

  it('does not request window focus for a preserveFocus window activation', () => {
    const { groups, aux, focus } = setup()
    act(() => groups.activatePart(aux, { preserveFocus: true, updateOpenTarget: true }))
    expect(groups.openTargetPart).toBe(aux)
    expect(focus.focusedGroups).toHaveLength(0)
  })

  it('does not request window focus when the group is in the active window', () => {
    const { groups, aux, auxGroup, focus, setActiveWindowPart } = setup()
    setActiveWindowPart(aux)
    act(() => groups.activateGroup(auxGroup))
    expect(focus.focusedGroups).toHaveLength(0)
  })

  it('does not bring a background window forward for a close-driven activation', () => {
    const { groups, aux, auxGroup, focus } = setup()
    const second = new FakeEditor('b')
    // Make the auxiliary group the open target without focusing it, then add a
    // non-active second tab so closing the active one triggers auto-activation.
    act(() => groups.activatePart(aux, { preserveFocus: true, updateOpenTarget: true }))
    act(() => auxGroup.openEditor(second, { activate: false }))
    expect(groups.openTargetGroup).toBe(auxGroup)

    act(() => auxGroup.closeEditor(auxGroup.activeEditor!))

    expect(auxGroup.activeEditor).toBe(second)
    expect(focus.focusedGroups).toHaveLength(0)
  })
})
