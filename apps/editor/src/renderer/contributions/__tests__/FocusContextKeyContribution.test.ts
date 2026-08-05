/*---------------------------------------------------------------------------------------------
 *  Tests for FocusContextKeyContribution — terminalFocus derivation.
 *
 *  terminalFocus must mirror the focus tracker's settled element, never the
 *  per-instance focusin/focusout bookkeeping: startup spawns panel terminals
 *  while the panel is still hidden, and a transient focus landing there must
 *  not leave the key stuck true (it would swallow every `!terminalFocus`
 *  keybinding, e.g. Ctrl+P quick open).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  InstantiationService,
  observableValue,
  PartId,
  ServiceCollection,
  IContextKeyService,
  IFocusTrackerService,
  ILayoutService,
  type IFocusChangeEvent,
  type IFocusTrackerService as IFocusTrackerServiceType,
  type ILayoutService as ILayoutServiceType,
} from '@universe-editor/platform'
import { FocusContextKeyContribution } from '../FocusContextKeyContribution.js'

function makeFocusTracker(): IFocusTrackerServiceType & {
  settle(el: HTMLElement | null): void
} {
  const emitter = new Emitter<IFocusChangeEvent>()
  let current: HTMLElement | null = null
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidFocusChange: emitter.event,
    trackElement: () => ({ dispose() {} }),
    settle(el: HTMLElement | null) {
      const previous = current
      current = el
      emitter.fire({ current: el, previous })
    },
  }
}

function makeLayoutService(panelVisible: boolean) {
  const visible = observableValue<Readonly<Record<PartId, boolean>>>('test.visible', {
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.SecondarySideBar]: false,
    [PartId.EditorArea]: true,
    [PartId.Panel]: panelVisible,
    [PartId.StatusBar]: true,
  })
  const layout = {
    _serviceBrand: undefined,
    visible,
    getVisible: (part: PartId) => visible.get()[part],
    getParts: () => [],
    getPart: () => undefined,
    onDidRegisterPart: new Emitter<never>().event,
  } as unknown as ILayoutServiceType
  const setPanelVisible = (next: boolean) =>
    visible.set({ ...visible.get(), [PartId.Panel]: next }, undefined)
  return { layout, setPanelVisible }
}

function makePanelTerminalHost(): { panel: HTMLElement; textarea: HTMLElement } {
  const panel = document.createElement('div')
  panel.setAttribute('data-testid', 'part-panel')
  const host = document.createElement('div')
  host.setAttribute('data-terminal-id', 't1')
  const textarea = document.createElement('textarea')
  host.appendChild(textarea)
  panel.appendChild(host)
  document.body.appendChild(panel)
  return { panel, textarea }
}

function makeEditorTerminalHost(): HTMLElement {
  const editorArea = document.createElement('div')
  editorArea.setAttribute('data-testid', 'part-editorArea')
  const host = document.createElement('div')
  host.setAttribute('data-terminal-id', 't2')
  const textarea = document.createElement('textarea')
  host.appendChild(textarea)
  editorArea.appendChild(host)
  document.body.appendChild(editorArea)
  return textarea
}

function makeContribution(layout: ILayoutServiceType, tracker: IFocusTrackerServiceType) {
  const context = new ContextKeyService()
  const services = new ServiceCollection()
  services.set(IContextKeyService, context)
  services.set(IFocusTrackerService, tracker)
  services.set(ILayoutService, layout)
  const inst = new InstantiationService(services)
  return { contribution: inst.createInstance(FocusContextKeyContribution), context }
}

describe('FocusContextKeyContribution — terminalFocus', () => {
  it('is true when focus settles inside a visible panel terminal', () => {
    const tracker = makeFocusTracker()
    const { layout } = makeLayoutService(true)
    const { contribution, context } = makeContribution(layout, tracker)
    const { textarea } = makePanelTerminalHost()

    tracker.settle(textarea)
    expect(context.get('terminalFocus')).toBe(true)

    contribution.dispose()
  })

  it('stays false when focus is inside a hidden panel terminal', () => {
    const tracker = makeFocusTracker()
    const { layout } = makeLayoutService(false)
    const { contribution, context } = makeContribution(layout, tracker)
    const { textarea } = makePanelTerminalHost()

    tracker.settle(textarea)
    expect(context.get('terminalFocus')).toBe(false)

    contribution.dispose()
  })

  it('is true for an editor-area terminal regardless of panel visibility', () => {
    const tracker = makeFocusTracker()
    const { layout } = makeLayoutService(false)
    const { contribution, context } = makeContribution(layout, tracker)
    const textarea = makeEditorTerminalHost()

    tracker.settle(textarea)
    expect(context.get('terminalFocus')).toBe(true)

    contribution.dispose()
  })

  it('clears when focus leaves the terminal', () => {
    const tracker = makeFocusTracker()
    const { layout } = makeLayoutService(true)
    const { contribution, context } = makeContribution(layout, tracker)
    const { textarea } = makePanelTerminalHost()

    tracker.settle(textarea)
    expect(context.get('terminalFocus')).toBe(true)

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    tracker.settle(outside)
    expect(context.get('terminalFocus')).toBe(false)

    contribution.dispose()
  })

  it('flips when panel visibility changes while focus stays in the terminal', () => {
    const tracker = makeFocusTracker()
    const { layout, setPanelVisible } = makeLayoutService(false)
    const { contribution, context } = makeContribution(layout, tracker)
    const { textarea } = makePanelTerminalHost()

    tracker.settle(textarea)
    expect(context.get('terminalFocus')).toBe(false)

    setPanelVisible(true)
    expect(context.get('terminalFocus')).toBe(true)

    setPanelVisible(false)
    expect(context.get('terminalFocus')).toBe(false)

    contribution.dispose()
  })
})
