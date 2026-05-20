/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupView — tab activation.
 *
 *  Regression: clicking a tab that was not active did not visually activate it
 *  because useGroupVersion's snapshot only tracked *whether* an active editor
 *  existed, not *which* editor was active. All subsequent snapshots returned the
 *  same number, so React skipped the re-render.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ComponentType } from 'react'
import {
  EditorInput,
  EditorRegistry,
  ICommandService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IDisposable,
  type IEditorInput,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { EditorGroupView } from '../EditorGroupView.js'
import { ServicesContext } from '../../useService.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_ID = 'test-tab-switch'
const COMPONENT_KEY = 'testTabSwitchEditor'

class TabTestInput extends EditorInput {
  constructor(
    private readonly _name: string,
    private readonly _uri: URI,
  ) {
    super()
  }

  get typeId() {
    return TYPE_ID
  }
  get resource() {
    return this._uri
  }
  getName() {
    return this._name
  }
}

const FakeEditor: ComponentType<{ input: IEditorInput }> = ({ input }) => (
  <div data-testid="active-editor">{input.label}</div>
)

const componentMap = new Map([[COMPONENT_KEY, FakeEditor]])

function makeFakeInstantiation(): InstantiationService {
  const sc = new ServiceCollection()
  sc.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: () => Promise.resolve({ confirmed: false, choice: 'cancel' as const }),
    prompt: () => Promise.resolve(undefined),
  } as IDialogService)
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  } as ICommandService)
  return new InstantiationService(sc)
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let providerDisposable: IDisposable

beforeEach(() => {
  providerDisposable = EditorRegistry.registerEditorProvider({
    typeId: TYPE_ID,
    componentKey: COMPONENT_KEY,
  })
})

afterEach(() => {
  providerDisposable.dispose()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EditorGroupView — tab switching', () => {
  it('clicking a non-active tab sets it as active (aria-selected and content)', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const a = new TabTestInput('Alpha', URI.file('/test/a.txt'))
    const b = new TabTestInput('Beta', URI.file('/test/b.txt'))
    const c = new TabTestInput('Gamma', URI.file('/test/c.txt'))
    // Open A, B, C in order — C ends up active.
    group.openEditor(a)
    group.openEditor(b)
    group.openEditor(c)

    render(
      <ServicesContext.Provider value={makeFakeInstantiation()}>
        <EditorGroupView group={group} groupsService={svc} componentMap={componentMap} />
      </ServicesContext.Provider>,
    )

    const tabs = screen.getAllByRole('tab')
    // Initial state: tabs are [Alpha, Beta, Gamma]; Gamma is active.
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('active-editor').textContent).toBe('Gamma')

    // Click the first tab (Alpha).
    fireEvent.click(tabs[0]!)

    // Alpha must now be active; Gamma must no longer be active.
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('false')
    // The editor content area must also update.
    expect(screen.getByTestId('active-editor').textContent).toBe('Alpha')

    svc.dispose()
  })

  it('active tab updates correctly across multiple successive switches', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const a = new TabTestInput('First', URI.file('/test/first.txt'))
    const b = new TabTestInput('Second', URI.file('/test/second.txt'))
    group.openEditor(a)
    group.openEditor(b)
    // Second is active.

    render(
      <ServicesContext.Provider value={makeFakeInstantiation()}>
        <EditorGroupView group={group} groupsService={svc} componentMap={componentMap} />
      </ServicesContext.Provider>,
    )

    const tabs = screen.getAllByRole('tab')

    // Switch to First.
    fireEvent.click(tabs[0]!)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('active-editor').textContent).toBe('First')

    // Switch back to Second.
    fireEvent.click(tabs[1]!)
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('active-editor').textContent).toBe('Second')

    svc.dispose()
  })

  it('clicking the already-active tab is a no-op (stays active)', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const a = new TabTestInput('OnlyOne', URI.file('/test/only.txt'))
    const b = new TabTestInput('Other', URI.file('/test/other.txt'))
    group.openEditor(a)
    group.openEditor(b)
    // b is active

    render(
      <ServicesContext.Provider value={makeFakeInstantiation()}>
        <EditorGroupView group={group} groupsService={svc} componentMap={componentMap} />
      </ServicesContext.Provider>,
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')

    // Click the already-active tab.
    fireEvent.click(tabs[1]!)
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')

    svc.dispose()
  })

  it('renders file icons in tabs from the shared resolver', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const a = new TabTestInput('Alpha', URI.file('/test/alpha.ts'))
    const b = new TabTestInput('Beta', URI.file('/test/package.json'))
    group.openEditor(a)
    group.openEditor(b)

    render(
      <ServicesContext.Provider value={makeFakeInstantiation()}>
        <EditorGroupView group={group} groupsService={svc} componentMap={componentMap} />
      </ServicesContext.Provider>,
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]?.querySelector('[data-file-icon="file-typescript"]')).toBeTruthy()
    expect(tabs[1]?.querySelector('[data-file-icon="file-package"]')).toBeTruthy()

    svc.dispose()
  })
})
