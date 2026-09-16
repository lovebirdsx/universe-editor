/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for FocusContextKeyContribution — DOM-derived focus keys.
 *
 *  Every key here answers "where is DOM focus right now", and has to answer it
 *  in the same task the focus move happened in. The per-part booleans used to be
 *  book-kept through IFocusTrackerService, whose setTimeout(0) settle can leave
 *  `editorAreaFocus` on the wrong side of a move — and a stale `false` there
 *  silently disables everything gated on it (the Alt+<n> session config-bar
 *  chords, Ctrl+F, the pane-resize chords) until some unrelated focus move
 *  happens to fix it.
 *
 *  Which is why this suite drives real DOM focus and real Parts instead of
 *  settling a stub tracker: a stub that reports whatever the test tells it to
 *  cannot catch a lag, and a lag is the only failure mode that matters here.
 *---------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  InstantiationService,
  observableValue,
  Part,
  PartId,
  ServiceCollection,
  IContextKeyService,
  ILayoutService,
  type ILayoutService as ILayoutServiceType,
  type IPart,
} from '@universe-editor/platform'
import { FocusContextKeyContribution } from '../FocusContextKeyContribution.js'

class TestPart extends Part {}

interface LayoutHarness {
  readonly layout: ILayoutServiceType
  readonly setPanelVisible: (next: boolean) => void
}

function makeLayout(panelVisible = true): LayoutHarness {
  const visible = observableValue<Readonly<Record<PartId, boolean>>>('test.visible', {
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.SecondarySideBar]: false,
    [PartId.EditorArea]: true,
    [PartId.Panel]: panelVisible,
    [PartId.StatusBar]: true,
  })
  const parts = new Map<PartId, IPart>()
  const onDidRegisterPart = new Emitter<IPart>()
  const layout = {
    _serviceBrand: undefined,
    visible,
    getVisible: (part: PartId) => visible.get()[part],
    getParts: () => [...parts.values()],
    getPart: (id: PartId) => parts.get(id),
    registerPart: (part: IPart) => {
      parts.set(part.id, part)
      onDidRegisterPart.fire(part)
      return {
        dispose: () => {
          if (parts.get(part.id) === part) parts.delete(part.id)
        },
      }
    },
    onDidRegisterPart: onDidRegisterPart.event,
  } as unknown as ILayoutServiceType
  return {
    layout,
    setPanelVisible: (next) => visible.set({ ...visible.get(), [PartId.Panel]: next }, undefined),
  }
}

function makeContribution(layout: ILayoutServiceType) {
  const context = new ContextKeyService()
  const services = new ServiceCollection()
  services.set(IContextKeyService, context)
  services.set(ILayoutService, layout)
  const inst = new InstantiationService(services)
  return { contribution: inst.createInstance(FocusContextKeyContribution), context }
}

/** Mount `el` as `part`'s container, the way usePartContainer does at runtime. */
function mountPart(part: Part, el: HTMLElement): void {
  document.body.appendChild(el)
  ;(part as unknown as { _attachContainer(e: HTMLElement): void })._attachContainer(el)
}

/** A Part root wrapping `inner`, carrying the testid the e2e selectors look for. */
function partRoot(testId: string, ...inner: HTMLElement[]): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('data-testid', testId)
  for (const el of inner) root.appendChild(el)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FocusContextKeyContribution — per-part keys', () => {
  it('flips editorAreaFocus in the same task, under a view that owns its own testid', () => {
    const { layout } = makeLayout()
    const { contribution, context } = makeContribution(layout)
    const part = new TestPart(PartId.EditorArea, 'editor', layout)

    // The ACP prompt form carries its own testid. Harmless now, but it is the
    // shape that used to shadow the Part for `focusedPart` — the old lookup
    // stopped at the nearest data-testid and left the key empty for the whole
    // session input.
    const prompt = document.createElement('form')
    prompt.setAttribute('data-testid', 'acp-prompt')
    const trigger = document.createElement('button')
    prompt.appendChild(trigger)
    mountPart(part, partRoot('part-editorArea', prompt))

    expect(context.get('editorAreaFocus')).toBe(false)

    trigger.focus()

    // No await anywhere below this line: a keybinding resolved in the same task
    // as the click that moved focus has to read the new value. Every other test
    // in this file would still pass if this one were deferred by a macrotask.
    expect(context.get('editorAreaFocus')).toBe(true)
    expect(context.get('focusedPart')).toBe('editorArea')

    contribution.dispose()
  })

  it('derives focusedView and reports focusedPart as the camelCase PartId', () => {
    const { layout } = makeLayout()
    const { contribution, context } = makeContribution(layout)
    const part = new TestPart(PartId.SideBar, 'sidebar', layout)

    // Parts spell their testid all-lowercase while PartId is camelCase.
    const view = document.createElement('div')
    view.setAttribute('data-view-id', 'workbench.view.explorer.tree')
    const item = document.createElement('button')
    view.appendChild(item)
    mountPart(part, partRoot('part-sidebar', view))

    item.focus()
    expect(context.get('focusedPart')).toBe('sideBar')
    expect(context.get('focusedView')).toBe('workbench.view.explorer.tree')

    contribution.dispose()
  })

  it('ignores a part-* subtree whose Part is not registered', () => {
    // focusedPart is read off the same loop as the booleans — "whichever
    // xxxFocus is true" — so a Part-shaped element the layout never registered
    // cannot claim it. Reading the node's ancestors instead (the old
    // closestPartId lookup) would resolve here and the two could disagree.
    const { layout } = makeLayout()
    const { contribution, context } = makeContribution(layout)
    const trigger = document.createElement('button')
    document.body.appendChild(partRoot('part-editorArea', trigger))

    trigger.focus()

    expect(context.get('editorAreaFocus')).toBe(false)
    expect(context.get('focusedPart')).toBe('')

    contribution.dispose()
  })

  it('clears every key when focus lands outside the Part tree', () => {
    const { layout } = makeLayout()
    const { contribution, context } = makeContribution(layout)
    const part = new TestPart(PartId.EditorArea, 'editor', layout)
    const trigger = document.createElement('button')
    mountPart(part, partRoot('part-editorArea', trigger))

    trigger.focus()
    expect(context.get('editorAreaFocus')).toBe(true)

    const floating = document.createElement('button')
    document.body.appendChild(floating)
    floating.focus()

    expect(context.get('editorAreaFocus')).toBe(false)
    expect(context.get('focusedPart')).toBe('')
    expect(context.get('focusedView')).toBe('')

    contribution.dispose()
  })

  it('keeps the key for a Part whose container cannot take DOM focus', () => {
    const { layout } = makeLayout()
    const { contribution, context } = makeContribution(layout)
    const part = new TestPart(PartId.EditorArea, 'editor', layout)

    // The editor-area / activity-bar / status-bar roots carry no tabIndex, so
    // Part.focus() cannot move DOM focus into them — modelled with a disabled
    // button, which neither happy-dom nor Chromium will focus. Those paths (F6,
    // the bootstrap focus restore, LayoutService's focusPart fallback) still
    // announce focus through onDidFocus, and that intent is all they have.
    const unfocusable = document.createElement('button')
    unfocusable.disabled = true
    mountPart(part, unfocusable)

    part.focus()

    expect(part.isFocused()).toBe(false)
    expect(context.get('editorAreaFocus')).toBe(true)

    contribution.dispose()
  })

  it('picks up a Part that is registered after the contribution', () => {
    const { layout } = makeLayout()
    const { contribution, context } = makeContribution(layout)

    // BlockStartup registers this contribution before WorkbenchPartsContribution,
    // so at construction time getParts() is empty and the initial reconcile
    // lands on nothing.
    const part = new TestPart(PartId.StatusBar, 'statusbar', layout)
    const item = document.createElement('button')
    mountPart(part, partRoot('part-statusbar', item))

    item.focus()
    expect(context.get('statusBarFocus')).toBe(true)

    contribution.dispose()
  })
})

describe('FocusContextKeyContribution — focus event contract', () => {
  it('reconciles on focusin synchronously, and on focusout only after the deferred read', () => {
    vi.useFakeTimers()
    try {
      const { layout } = makeLayout()
      const { contribution, context } = makeContribution(layout)
      const part = new TestPart(PartId.EditorArea, 'editor', layout)
      const trigger = document.createElement('button')
      mountPart(part, partRoot('part-editorArea', trigger))

      trigger.focus()
      expect(context.get('editorAreaFocus')).toBe(true)

      // A move that lands on nothing focusable fires focusout with no focusin
      // behind it: during the pair activeElement is momentarily <body>, and
      // other handlers reclaim focus from there in a microtask. Reading
      // synchronously would clear the keys out from under a re-focused element,
      // so the read is deferred — the key is deliberately still true here.
      trigger.blur()
      expect(context.get('editorAreaFocus')).toBe(true)

      vi.runAllTimers()
      expect(context.get('editorAreaFocus')).toBe(false)
      expect(context.get('focusedPart')).toBe('')

      contribution.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('FocusContextKeyContribution — terminalFocus', () => {
  it('is true when focus is inside a visible panel terminal', () => {
    const { layout } = makeLayout(true)
    const { contribution, context } = makeContribution(layout)
    const { textarea } = makePanelTerminalHost()

    textarea.focus()
    expect(context.get('terminalFocus')).toBe(true)

    contribution.dispose()
  })

  it('stays false when focus is inside a hidden panel terminal', () => {
    const { layout } = makeLayout(false)
    const { contribution, context } = makeContribution(layout)
    const { textarea } = makePanelTerminalHost()

    textarea.focus()
    expect(context.get('terminalFocus')).toBe(false)

    contribution.dispose()
  })

  it('is true for an editor-area terminal regardless of panel visibility', () => {
    const { layout } = makeLayout(false)
    const { contribution, context } = makeContribution(layout)
    const textarea = makeEditorTerminalHost()

    textarea.focus()
    expect(context.get('terminalFocus')).toBe(true)

    contribution.dispose()
  })

  it('clears when focus leaves the terminal', () => {
    const { layout } = makeLayout(true)
    const { contribution, context } = makeContribution(layout)
    const { textarea } = makePanelTerminalHost()

    textarea.focus()
    expect(context.get('terminalFocus')).toBe(true)

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    expect(context.get('terminalFocus')).toBe(false)

    contribution.dispose()
  })

  it('flips when panel visibility changes while focus stays in the terminal', () => {
    const { layout, setPanelVisible } = makeLayout(false)
    const { contribution, context } = makeContribution(layout)
    const { textarea } = makePanelTerminalHost()

    textarea.focus()
    expect(context.get('terminalFocus')).toBe(false)

    // A visibility toggle moves no DOM focus, so no focus event follows it.
    setPanelVisible(true)
    expect(context.get('terminalFocus')).toBe(true)

    setPanelVisible(false)
    expect(context.get('terminalFocus')).toBe(false)

    contribution.dispose()
  })
})

describe('FocusContextKeyContribution — editorFocus derivation', () => {
  // Wiring contract: the contribution installs the DOM derivation, so an embedded
  // Monaco (the ACP prompt input) needs no `editorFocus` bridge of its own. Before
  // this, the key was book-kept per editor and focus leaving a bridgeless one left a
  // stale `true` behind that swallowed the global Escape binding.
  it('reconciles editorFocus from DOM focus, in and out of a Monaco editor', () => {
    const { layout } = makeLayout(true)
    const { contribution, context } = makeContribution(layout)

    const editor = document.createElement('div')
    editor.className = 'monaco-editor'
    const host = document.createElement('div')
    host.tabIndex = 0
    editor.appendChild(host)
    document.body.appendChild(editor)

    host.focus()
    expect(context.get('editorFocus')).toBe(true)

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    expect(context.get('editorFocus')).toBe(false)

    contribution.dispose()
  })
})

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
