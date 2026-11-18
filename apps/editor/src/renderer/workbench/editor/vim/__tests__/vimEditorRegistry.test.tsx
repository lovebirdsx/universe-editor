/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setKeybindingChordPending } from '@universe-editor/workbench-ui'
import { __resetVimEditorRegistryForTests, registerVimEditor } from '../vimEditorRegistry.js'
import type { IVimEditorController } from '../vimEditorController.js'

function createController(container: HTMLElement) {
  const handleKeyDown = vi.fn(() => true)
  const controller: IVimEditorController = {
    editor: { getContainerDomNode: () => container } as never,
    isEnabled: () => true,
    hasTextFocus: () => true,
    handleKeyDown,
    dispose: vi.fn(),
  }
  return { controller, handleKeyDown }
}

function setActiveElement(element: HTMLElement): void {
  Object.defineProperty(document, 'activeElement', { value: element, configurable: true })
}

function press(key = 'j'): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
}

describe('vimEditorRegistry', () => {
  afterEach(() => {
    __resetVimEditorRegistryForTests()
    setKeybindingChordPending(document, false)
    document.body.innerHTML = ''
  })

  it('routes the stroke to the focused controller', () => {
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(first, second)
    const a = createController(first)
    const b = createController(second)
    const registrationA = registerVimEditor(a.controller)
    registerVimEditor(b.controller)

    setActiveElement(second)
    document.dispatchEvent(press('j'))

    expect(b.handleKeyDown).toHaveBeenCalledTimes(1)
    expect(a.handleKeyDown).not.toHaveBeenCalled()
    registrationA.dispose()
  })

  it('ignores a stroke another listener already prevented', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const { controller, handleKeyDown } = createController(container)
    registerVimEditor(controller)
    setActiveElement(container)

    const event = press('j')
    event.preventDefault()
    document.dispatchEvent(event)

    expect(handleKeyDown).not.toHaveBeenCalled()
  })

  it('yields while a chord is pending', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const { controller, handleKeyDown } = createController(container)
    registerVimEditor(controller)
    setActiveElement(container)

    setKeybindingChordPending(document, true)
    document.dispatchEvent(press('j'))

    expect(handleKeyDown).not.toHaveBeenCalled()
  })

  it('removes the listener when the last controller unregisters', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const { controller, handleKeyDown } = createController(container)
    const registration = registerVimEditor(controller)
    setActiveElement(container)

    registration.dispose()
    document.dispatchEvent(press('j'))

    expect(handleKeyDown).not.toHaveBeenCalled()
  })
})
