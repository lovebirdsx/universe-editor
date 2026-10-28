/*---------------------------------------------------------------------------------------------
 *  Explicit reveals (`activateGroupAndFocus`) must win over the window-activation
 *  intent written when bringing another window forward.
 *
 *  Repro: main window shows a and b (b active), an auxiliary window owns focus.
 *  Ctrl+Tab selects the background tab a in the main window. `focusGroup` asks
 *  WorkbenchWindowService to activate the main window, whose bridge calls
 *  `activatePart(..., { preserveFocus: true })` synchronously — overwriting the
 *  reveal intent `setActive(a)` just wrote. The late-mounted FileEditor then sees
 *  `lastActivationPreservedFocus === true` and never focuses, leaving DOM focus
 *  on the group body (no caret, arrow keys dead).
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { ContextKeyService, EditorInput, URI, type IEditorGroup } from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { activateGroupAndFocus } from '../activateGroupAndFocus.js'
import { FileEditorRegistry } from '../FileEditorRegistry.js'
import { DiffEditorRegistry } from '../DiffEditorRegistry.js'
import { FakeWindowFocusService } from '../../windows/testing/fakeWindowFocusService.js'

class FakeEditor extends EditorInput {
  constructor(private readonly _name: string) {
    super()
  }
  get typeId() {
    return 'activateGroupAndFocus.test'
  }
  get resource() {
    return URI.file(`/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
}

/** Mirrors WindowFocusService.focusWindow → WorkbenchWindowService.setActiveWindow
 *  → AuxiliaryEditorWindowService.onDidChangeActiveWindow, which is synchronous. */
class BridgingWindowFocusService extends FakeWindowFocusService {
  preserveAfterBridge: boolean | undefined

  constructor(private readonly _groups: EditorGroupsService) {
    super()
  }

  override focusGroup(group: IEditorGroup): void {
    super.focusGroup(group)
    this._groups.activatePart(group.part, { preserveFocus: true, updateOpenTarget: false })
    this.preserveAfterBridge = group.lastActivationPreservedFocus
  }
}

function mountGroupBody(groupId: number): HTMLElement {
  const group = document.createElement('div')
  group.setAttribute('data-group-id', String(groupId))
  const body = document.createElement('div')
  body.setAttribute('data-testid', 'editor-group-body')
  body.tabIndex = -1
  group.appendChild(body)
  document.body.appendChild(group)
  return body
}

describe('activateGroupAndFocus — explicit reveal vs window activation', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    FileEditorRegistry._resetForTests()
    DiffEditorRegistry._resetForTests()
  })

  // Regression: Ctrl+Tab from an auxiliary window to a background tab in the
  // main window ended with the tab active but no caret in Monaco.
  it('clears the preserve intent written by bringing the target window forward', () => {
    const groups = new EditorGroupsService()
    const mainGroup = groups.mainPart.activeGroup
    const target = new FakeEditor('target-background')
    const mounted = new FakeEditor('currently-mounted')
    mainGroup.openEditor(target, { activate: false })
    mainGroup.openEditor(mounted)

    // An auxiliary part must be the active part, otherwise the window bridge
    // sees changed=false and never writes the intent this test is about.
    groups.createAuxiliaryPart({ activate: true })
    expect(groups.activePart).not.toBe(groups.mainPart)
    expect(mainGroup.activeEditor).toBe(mounted)

    const body = mountGroupBody(mainGroup.id)
    const windowFocus = new BridgingWindowFocusService(groups)
    const contextKeyService = new ContextKeyService()

    activateGroupAndFocus(mainGroup, { groups, contextKeyService, windowFocus }, target)

    // The bridge did run and wrote the window-activation intent...
    expect(windowFocus.focusedGroups).toEqual([mainGroup])
    expect(windowFocus.preserveAfterBridge).toBe(true)
    expect(groups.activePart).toBe(groups.mainPart)
    expect(mainGroup.activeEditor).toBe(target)
    // ...but the explicit reveal must clear it before any late-mounted editor
    // (double-rAF applyModel) reads the flag.
    expect(mainGroup.lastActivationPreservedFocus).toBe(false)
    // The target editor is not registered yet, so the synchronous fallback parks
    // focus on the group body; the late focus path above must not be vetoed.
    expect(document.activeElement).toBe(body)
  })
})
