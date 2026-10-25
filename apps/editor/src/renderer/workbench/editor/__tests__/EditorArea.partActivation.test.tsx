/*---------------------------------------------------------------------------------------------
 *  Interaction inside an editor area makes its part the open target; window
 *  focus elsewhere (main sidebar) does not.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  IDialogService,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { EditorArea } from '../EditorArea.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'

vi.mock('../WelcomeEditor.js', () => ({ WelcomeEditor: () => null }))

function setup() {
  const groups = new EditorGroupsService()
  const aux = groups.createAuxiliaryPart({ activate: true })
  const services = new ServiceCollection()
  services.set(IDialogService, {} as never)
  services.set(ICommandService, { executeCommand: async () => undefined } as never)
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IEditorGroupsService, groups)
  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <EditorArea />
    </ServicesContext.Provider>,
  )
  return { groups, aux, area: screen.getByTestId('part-editorArea') }
}

describe('EditorArea part activation', () => {
  it('focus entering the main editor area activates the main part without a focus intent', () => {
    const { groups, aux, area } = setup()
    expect(groups.activePart).toBe(aux)
    fireEvent.focusIn(area)
    expect(groups.activePart).toBe(groups.mainPart)
    expect(groups.mainPart.activeGroup.lastActivationPreservedFocus).toBe(true)
  })

  it('pointerdown in the main editor area activates the main part', () => {
    const { groups, area } = setup()
    fireEvent.pointerDown(area)
    expect(groups.activePart).toBe(groups.mainPart)
  })
})
