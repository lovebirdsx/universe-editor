/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/outline/OutlineView.tsx
 *
 *  Regression for "Outline shows nothing until you switch views and come back":
 *  the view must react to the outline observable filling in *after* it has
 *  already mounted with an empty (or absent) outline — without needing a remount.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  observableValue,
  type IObservable,
} from '@universe-editor/platform'
import type { monaco } from '../../editor/monaco/MonacoLoader.js'
import {
  IOutlineService,
  OutlineService,
  type OutlineModel,
} from '../../../services/languageFeatures/OutlineService.js'
import {
  Emitter,
  IEditorService,
  type IEditorService as IEditorServiceType,
} from '@universe-editor/platform'
import { AcpSessionEditorInput } from '../../../services/acp/acpSessionEditorInput.js'
import {
  IAcpSessionService,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../../services/acp/acpSessionHistory.js'
import {
  IAcpChatWidgetService,
  type IAcpChatWidgetService as IAcpChatWidgetServiceType,
} from '../../../services/acp/acpChatWidgetService.js'
import {
  AcpSessionOutlineRegistry,
  type IAcpSessionOutlineController,
} from '../../../services/acp/acpSessionOutlineRegistry.js'
import type { ILanguageFeaturesService } from '../../../services/languageFeatures/LanguageFeaturesService.js'
import type { TimelineItem } from '../../../services/acp/acpSessionModel.js'
import { ServicesContext } from '../../useService.js'
import { OutlineView } from '../OutlineView.js'
import { outlineViewState } from '../outlineViewState.js'

function makeSymbol(
  name: string,
  opts: {
    line?: number
    kind?: number
    children?: monaco.languages.DocumentSymbol[]
  } = {},
): monaco.languages.DocumentSymbol {
  const line = opts.line ?? 1
  return {
    name,
    detail: '',
    kind: (opts.kind ?? 14) as monaco.languages.SymbolKind,
    tags: [],
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 },
    selectionRange: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    children: opts.children ?? [],
  }
}

function setup(initial: OutlineModel | undefined) {
  const outline = observableValue<OutlineModel | undefined>('test.outline', initial)
  const activeSymbol = observableValue<monaco.languages.DocumentSymbol | undefined>(
    'test.activeSymbol',
    undefined,
  )
  const outlineService = {
    _serviceBrand: undefined,
    outline: outline as IObservable<OutlineModel | undefined>,
    activeSymbol,
    revealSymbol: () => {},
    captureViewState: () => undefined,
    previewSymbol: () => {},
    restoreViewState: () => {},
  }
  const services = new ServiceCollection()
  services.set(IOutlineService, outlineService as never)
  const instantiation = new InstantiationService(services)
  return { outline, activeSymbol, instantiation }
}

afterEach(() => cleanup())

beforeEach(() => {
  // outlineViewState is a module-level singleton — reset to defaults so cases
  // that flip preferences don't leak into one another.
  outlineViewState.setFollowCursor(true)
  outlineViewState.setFilterOnType(true)
  outlineViewState.setSortBy('position')
})

function renderView(instantiation: InstantiationService): void {
  render(
    <ServicesContext.Provider value={instantiation}>
      <OutlineView />
    </ServicesContext.Provider>,
  )
}

function rowLabels(): string[] {
  return Array.from(document.querySelectorAll('[role="treeitem"] > span:last-child')).map(
    (el) => el.textContent ?? '',
  )
}

describe('OutlineView', () => {
  it('renders symbols that arrive after mount with an initially empty outline', () => {
    const { outline, instantiation } = setup(undefined)

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )

    // Mounts empty: shows the placeholder.
    expect(screen.getByText('No symbols found.')).toBeTruthy()

    // The language server finishes analysing and the outline fills in — without
    // any remount the view must now show the symbols.
    act(() => {
      outline.set(
        { uri: 'file:///x.ts', roots: [makeSymbol('Alpha')], languageId: 'typescript', version: 1 },
        undefined,
      )
    })

    expect(screen.queryByText('No symbols found.')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('updates the symbol list when the outline changes to another file', () => {
    const { outline, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha')],
      languageId: 'typescript',
      version: 1,
    })

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )

    expect(screen.getByText('Alpha')).toBeTruthy()

    act(() => {
      outline.set(
        { uri: 'file:///b.ts', roots: [makeSymbol('Beta')], languageId: 'typescript', version: 2 },
        undefined,
      )
    })

    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('recovers symbols after the outline empties then refills (file switch)', () => {
    const { outline, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha')],
      languageId: 'typescript',
      version: 1,
    })

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )
    expect(screen.getByText('Alpha')).toBeTruthy()

    // Switch file: the new editor isn't ready yet, so the outline empties.
    act(() => outline.set(undefined, undefined))
    expect(screen.getByText('No symbols found.')).toBeTruthy()

    // The new file's symbols arrive — must show WITHOUT a remount.
    act(() => {
      outline.set(
        { uri: 'file:///b.ts', roots: [makeSymbol('Beta')], languageId: 'typescript', version: 2 },
        undefined,
      )
    })
    expect(screen.queryByText('No symbols found.')).toBeNull()
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('sorts roots by name / position / kind', () => {
    const { instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [
        makeSymbol('Charlie', { line: 1, kind: 11 }),
        makeSymbol('Alpha', { line: 2, kind: 5 }),
        makeSymbol('Bravo', { line: 3, kind: 5 }),
      ],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)

    // position: document order
    expect(rowLabels()).toEqual(['Charlie', 'Alpha', 'Bravo'])

    act(() => outlineViewState.setSortBy('name'))
    expect(rowLabels()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    // kind: lower kind first (5 before 11), name as tiebreak
    act(() => outlineViewState.setSortBy('kind'))
    expect(rowLabels()).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('collapses and expands all on toolbar signals, syncing allCollapsed', () => {
    const { instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Parent', { children: [makeSymbol('Child', { line: 2 })] })],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)

    // Default-expanded: child visible, not all collapsed.
    expect(screen.getByText('Child')).toBeTruthy()
    expect(outlineViewState.allCollapsed.get()).toBe(false)

    act(() => outlineViewState.requestCollapseAll())
    expect(screen.queryByText('Child')).toBeNull()
    expect(outlineViewState.allCollapsed.get()).toBe(true)

    act(() => outlineViewState.requestExpandAll())
    expect(screen.getByText('Child')).toBeTruthy()
    expect(outlineViewState.allCollapsed.get()).toBe(false)
  })

  it('follow cursor expands ancestors of and selects the active symbol', () => {
    const child = makeSymbol('Child', { line: 2 })
    const { activeSymbol, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Parent', { children: [child] })],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)

    act(() => outlineViewState.requestCollapseAll())
    expect(screen.queryByText('Child')).toBeNull()

    // Cursor moves into the child — follow-cursor must reveal it.
    act(() => activeSymbol.set(child, undefined))
    expect(screen.getByText('Child')).toBeTruthy()
  })

  it('selects the first row when focused with nothing focused yet', () => {
    const { instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha', { line: 1 }), makeSymbol('Beta', { line: 2 })],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)

    const rows = () => Array.from(document.querySelectorAll('[role="treeitem"]'))
    expect(rows().some((r) => r.getAttribute('aria-selected') === 'true')).toBe(false)

    const view = document.querySelector('[role="tree"]') as HTMLElement
    act(() => view.focus())

    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('selects the active symbol over the first row on focus', () => {
    const beta = makeSymbol('Beta', { line: 2 })
    const { activeSymbol, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha', { line: 1 }), beta],
      languageId: 'typescript',
      version: 1,
    })
    // follow-cursor would also select; turn it off to isolate the focus path.
    outlineViewState.setFollowCursor(false)
    renderView(instantiation)
    act(() => activeSymbol.set(beta, undefined))

    const view = document.querySelector('[role="tree"]') as HTMLElement
    act(() => view.focus())

    const rows = Array.from(document.querySelectorAll('[role="treeitem"]'))
    expect(rows[0]?.getAttribute('aria-selected')).toBe('false')
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('filter on type prunes the tree to matches and ancestors', () => {
    const { instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [
        makeSymbol('Alpha', { line: 1 }),
        makeSymbol('Beta', { line: 2, children: [makeSymbol('Gamma', { line: 3 })] }),
      ],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)
    expect(rowLabels()).toEqual(['Alpha', 'Beta', 'Gamma'])

    // Type to filter — only Gamma (and its ancestor Beta) survive.
    const view = document.querySelector('[role="tree"]') as HTMLElement
    act(() => {
      view.focus()
      fireEvent.keyDown(view, { key: 'g' })
    })
    expect(rowLabels()).toEqual(['Beta', 'Gamma'])
    expect(screen.queryByText('Alpha')).toBeNull()
  })
})

// End-to-end repro: drive the REAL OutlineService for an agent session behind the
// view and reproduce the user-reported bug — moving the session's keyboard
// selection (Alt+Up/Down/Home/End) must move the outline highlight, exactly like
// follow-cursor does for a code editor. The three unit layers (service / pure
// timelineToOutline / ChatBody controller) each pass in isolation, so this wires
// them together the way the running app does.
describe('OutlineView — agent session active-slot sync (end-to-end)', () => {
  const flush = () => act(async () => await Promise.resolve())

  function makeSessionInput(sessionId: string): AcpSessionEditorInput {
    const sessions = {
      _serviceBrand: undefined,
      entries: observableValue<readonly unknown[]>('t.sessions', []),
      getById: () => undefined,
    } as unknown as IAcpSessionServiceType
    const history = {
      _serviceBrand: undefined,
      entries: observableValue<readonly unknown[]>('t.history', []),
      get: () => undefined,
    } as unknown as IAcpSessionHistoryServiceType
    const chatWidget = {
      _serviceBrand: undefined,
      focusSessionInput: () => false,
    } as unknown as IAcpChatWidgetServiceType
    const services = new ServiceCollection()
    services.set(IAcpSessionService, sessions)
    services.set(IAcpSessionHistoryService, history)
    services.set(IAcpChatWidgetService, chatWidget)
    const inst = new InstantiationService(services)
    return inst.createInstance(AcpSessionEditorInput, sessionId, 'fake', undefined)
  }

  function tlMessage(id: string, role: 'user' | 'agent' | 'thought', text: string): TimelineItem {
    return { kind: 'message', id, message: { id, role, text, blocks: [], streaming: false } }
  }

  function setupRealService() {
    const activeEditor = observableValue<AcpSessionEditorInput | undefined>('t.active', undefined)
    const editorService = { activeEditor } as unknown as IEditorServiceType
    const facade = {
      onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
      getDocumentSymbolProviders: () => [],
    } as unknown as ILanguageFeaturesService
    const svc = new OutlineService(editorService, facade)
    const services = new ServiceCollection()
    services.set(IEditorService, editorService as never)
    services.set(IOutlineService, svc as never)
    const instantiation = new InstantiationService(services)
    return { svc, activeEditor, instantiation }
  }

  function makeController(items: readonly TimelineItem[]) {
    const timeline = observableValue<readonly TimelineItem[]>('tl', items)
    const onDidChangeActive = new Emitter<void>()
    let activeKey: string | undefined
    const controller: IAcpSessionOutlineController = {
      timeline,
      scrollToKey: () => {},
      getActiveKey: () => activeKey,
      focus: () => {},
      onDidChangeActive: onDidChangeActive.event,
    }
    return {
      controller,
      setActiveKey: (k: string | undefined) => {
        activeKey = k
      },
      fire: () => onDidChangeActive.fire(),
    }
  }

  const selectedLabels = () =>
    Array.from(document.querySelectorAll('[role="treeitem"]'))
      .filter((r) => r.getAttribute('aria-selected') === 'true')
      .map((r) => r.querySelector('span:last-child')?.textContent ?? '')

  afterEach(() => {
    AcpSessionOutlineRegistry._resetForTests()
  })

  it('moves the outline highlight when the session keyboard selection changes', async () => {
    outlineViewState.setFollowCursor(true)
    const { svc, activeEditor, instantiation } = setupRealService()
    const input = makeSessionInput('s1')

    // Real mount order: the session editor activates BEFORE ChatBody mounts, so
    // the first attach finds no controller. Then ChatBody registers late.
    act(() => activeEditor.set(input, undefined))
    await flush()

    const { controller, setActiveKey, fire } = makeController([
      tlMessage('m1', 'user', 'First'),
      tlMessage('m2', 'agent', 'Second'),
    ])
    setActiveKey('m:m1')
    act(() => AcpSessionOutlineRegistry.register('s1', controller))
    await flush()

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )
    expect(rowLabels()).toEqual(['First', 'Second'])
    expect(selectedLabels()).toEqual(['First'])

    // User presses Alt+Down in the chat: selection moves to the second item.
    setActiveKey('m:m2')
    act(() => fire())
    expect(selectedLabels()).toEqual(['Second'])

    svc.dispose()
  })
})
