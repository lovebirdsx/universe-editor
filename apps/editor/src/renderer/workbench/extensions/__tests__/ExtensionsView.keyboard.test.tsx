/*---------------------------------------------------------------------------------------------
 *  Keyboard navigation for ExtensionsView.
 *
 *  The view is not a tree — it is a couple of fixed sections, each a flat list —
 *  so it renders `useFlatListNavigation` rather than `Tree`. What this asserts is
 *  the thing flattening bought: one index space, so the arrow keys cross a
 *  section boundary without the user noticing there is one.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  Emitter,
  IEditorService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type IEditorService as IEditorServiceType,
  type INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import { ExtensionsView } from '../ExtensionsView.js'
import {
  EnablementState,
  IExtensionsWorkbenchService,
  type IExtensionEntry,
} from '../../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { ServicesContext } from '../../useService.js'

function entry(id: string, over: Partial<IExtensionEntry> = {}): IExtensionEntry {
  return {
    id,
    displayName: id,
    publisher: 'acme',
    description: `${id} description`,
    version: '1.0.0',
    installed: true,
    outdated: false,
    installing: false,
    isBuiltin: false,
    isUnderDevelopment: false,
    enabled: true,
    enablementState: EnablementState.EnabledGlobally,
    isVersionIncompatible: false,
    installIncompatible: false,
    ...over,
  } as IExtensionEntry
}

interface SetupInput {
  readonly installed?: readonly IExtensionEntry[]
  readonly results?: readonly IExtensionEntry[]
  readonly marketplace?: boolean
}

function setup(input: SetupInput = {}) {
  const onDidChange = new Emitter<void>()
  const workbench = {
    _serviceBrand: undefined,
    onDidChange: onDidChange.event,
    isMarketplaceEnabled: vi.fn(async () => input.marketplace === true),
    getInstalled: vi.fn(() => input.installed ?? []),
    getSearchResults: vi.fn(() => input.results ?? []),
    searchText: '',
    searching: false,
    search: vi.fn(async () => undefined),
    loadFeatured: vi.fn(async () => undefined),
    refreshInstalled: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    installVSIX: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    setEnablement: vi.fn(async () => undefined),
    installInRemote: vi.fn(async () => undefined),
    hasWorkspace: vi.fn(() => false),
    getReadme: vi.fn(async () => ''),
    getIcon: vi.fn(async () => ''),
    find: vi.fn(() => undefined),
  }
  const openEditor = vi.fn(async () => undefined)
  const services = new ServiceCollection()
  services.set(IExtensionsWorkbenchService, workbench as unknown as IExtensionsWorkbenchService)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify: vi.fn(),
  } as unknown as INotificationServiceType)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor,
  } as unknown as IEditorServiceType)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ExtensionsView />
    </ServicesContext.Provider>,
  )
  return { workbench, openEditor }
}

const list = () => screen.getByRole('listbox')

/** The label of whatever row the arrow keys are currently on. */
function focusedLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-row-key][aria-selected="true"]')].map(
    (el) => el.textContent ?? '',
  )
}

afterEach(() => cleanup())

describe('ExtensionsView keyboard navigation', () => {
  it('is a single focusable listbox, with rows as data rather than tab stops', () => {
    setup({ installed: [entry('acme.one')] })
    expect(list().getAttribute('tabindex')).toBe('0')
    for (const row of document.querySelectorAll('[data-row-key]')) {
      expect(row.hasAttribute('tabindex')).toBe(false)
    }
  })

  it('landing focus on the list selects the first row', () => {
    setup({ installed: [entry('acme.one')] })
    expect(focusedLabels()).toEqual([])
    fireEvent.focus(list())
    expect(focusedLabels()).toEqual(['Installed'])
  })

  it('leaves an existing cursor alone when focus returns', () => {
    setup({ installed: [entry('acme.one'), entry('acme.two')] })
    fireEvent.keyDown(list(), { key: 'End' })
    expect(focusedLabels()[0]).toContain('acme.two')
    fireEvent.blur(list())
    fireEvent.focus(list())
    expect(focusedLabels()[0]).toContain('acme.two')
  })

  it('walks header -> entries with ArrowDown and back with ArrowUp', () => {
    setup({ installed: [entry('acme.one'), entry('acme.two')] })

    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['Installed'])
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()[0]).toContain('acme.one')
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()[0]).toContain('acme.two')

    fireEvent.keyDown(list(), { key: 'ArrowUp' })
    expect(focusedLabels()[0]).toContain('acme.one')
  })

  it('crosses the section boundary in one index space', async () => {
    setup({
      installed: [entry('acme.one')],
      results: [entry('acme.market', { installed: false })],
      marketplace: true,
    })
    await waitFor(() => expect(screen.getAllByTestId('extension-section-header')).toHaveLength(2))

    // Installed header -> acme.one -> Market header -> acme.market, with no
    // hidden stop and no reset at the boundary.
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['Installed'])
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()[0]).toContain('acme.one')
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['Market Extensions'])
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()[0]).toContain('acme.market')
  })

  it('Enter on a header folds the section away and re-expands it', () => {
    setup({ installed: [entry('acme.one'), entry('acme.two')] })
    expect(screen.getAllByTestId('extension-row')).toHaveLength(2)

    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    fireEvent.keyDown(list(), { key: 'Enter' })
    expect(screen.queryAllByTestId('extension-row')).toHaveLength(0)
    expect(screen.getByTestId('extension-section-header').getAttribute('aria-expanded')).toBe(
      'false',
    )

    fireEvent.keyDown(list(), { key: 'Enter' })
    expect(screen.getAllByTestId('extension-row')).toHaveLength(2)
  })

  it('Enter on an entry opens its detail editor', () => {
    const { openEditor } = setup({ installed: [entry('acme.one')] })
    fireEvent.keyDown(list(), { key: 'End' })
    fireEvent.keyDown(list(), { key: 'Enter' })
    expect(openEditor).toHaveBeenCalledTimes(1)
  })

  it('Home and End jump to the ends', () => {
    setup({ installed: [entry('acme.one'), entry('acme.two')] })
    fireEvent.keyDown(list(), { key: 'End' })
    expect(focusedLabels()[0]).toContain('acme.two')
    fireEvent.keyDown(list(), { key: 'Home' })
    expect(focusedLabels()).toEqual(['Installed'])
  })

  it('Shift+Tab hands focus back to the search box', () => {
    setup({ installed: [entry('acme.one')] })
    fireEvent.keyDown(list(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByLabelText('Search Extensions'))
  })

  it('drops the cursor when collapsing a section shortens the list past it', () => {
    setup({ installed: [entry('acme.one'), entry('acme.two')] })
    fireEvent.keyDown(list(), { key: 'End' })
    expect(focusedLabels()[0]).toContain('acme.two')

    // Collapse from the header row: the cursor's index no longer exists.
    fireEvent.click(screen.getByTestId('extension-section-header'))
    expect(screen.queryAllByTestId('extension-row')).toHaveLength(0)
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['Installed'])
  })

  it('raises the row action menu from the ContextMenu key, already highlighted', async () => {
    setup({ installed: [entry('acme.one')] })
    fireEvent.keyDown(list(), { key: 'End' })
    fireEvent.keyDown(list(), { key: 'ContextMenu' })

    const menu = await screen.findByRole('menu')
    expect(screen.getByText('Uninstall')).toBeTruthy()
    // A keyboard user has no pointer to aim, so the first entry opens highlighted.
    expect(menu.querySelectorAll('[role="menuitem"][data-active]')).toHaveLength(1)
  })

  it('skips the "no extensions" placeholder instead of stopping the cursor on it', () => {
    // The placeholder has no action, so a cursor parked on it would be an
    // invisible dead stop between two sections.
    setup({ installed: [], results: [entry('acme.market', { installed: false })] })

    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['Installed'])
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(focusedLabels()).toEqual(['Installed'])
    // End lands on a real row, never on the placeholder.
    fireEvent.keyDown(list(), { key: 'End' })
    expect(focusedLabels()).toEqual(['Installed'])
    expect(screen.getByText('No extensions installed')).toBeTruthy()
  })

  it('lets Ctrl combinations through to the global keybinding handler', () => {
    setup({ installed: [entry('acme.one')] })
    fireEvent.keyDown(list(), { key: 'ArrowDown', ctrlKey: true })
    expect(focusedLabels()).toEqual([])
  })
})
