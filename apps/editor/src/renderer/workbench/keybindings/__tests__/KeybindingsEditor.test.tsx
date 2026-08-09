import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type * as ReactVirtual from '@tanstack/react-virtual'
import {
  CommandsRegistry,
  ContextKeyService,
  Emitter,
  IContextKeyService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { KeybindingsEditor } from '../KeybindingsEditor.js'
import {
  IUserKeybindingsService,
  type IUserKeybindingsService as IUserKeybindingsServiceType,
  type IUserKeybindingEntry,
} from '../../../services/keybindings/UserKeybindingsService.js'
import {
  dispatchKeybindingsEditorFocusSearch,
  KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT,
} from '../../preferences/preferencesFocus.js'

// happy-dom has no layout engine, so @tanstack/react-virtual would render 0
// items (container height stays 0). Stub the virtualizer to lay out every row
// in document order; the real virtualization contract is covered by
// workbench-ui's own VirtualList tests.
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const mod = await importOriginal<typeof ReactVirtual>()
  return {
    ...mod,
    useVirtualizer: (options: {
      count: number
      estimateSize: (index: number) => number
      getItemKey?: (index: number) => string | number
      getScrollElement: () => HTMLElement | null
    }) => {
      // Mirror the real hook's reflow on mount so VirtualList's parentRef is set.
      const [, force] = useState(0)
      useEffect(() => {
        force(1)
      }, [])
      return {
        getVirtualItems: () =>
          Array.from({ length: options.count }, (_, index) => ({
            index,
            key: options.getItemKey?.(index) ?? index,
            start: index * options.estimateSize(index),
            size: options.estimateSize(index),
          })),
        getTotalSize: () => options.count * options.estimateSize(0),
        scrollToIndex: () => undefined,
        measureElement: () => undefined,
      }
    },
  }
})

function mount(userEntries: readonly IUserKeybindingEntry[] = []) {
  const onDidChangeEmitter = new Emitter<void>()
  const userKeybindingsService: IUserKeybindingsServiceType = {
    _serviceBrand: undefined,
    onDidChange: onDidChangeEmitter.event,
    userEntries,
    disabledCommands: [],
    disabledBindings: [],
    initialize: async () => undefined,
    reload: async () => undefined,
    setKeybinding: vi.fn(),
    resetKeybinding: vi.fn(),
    getUserEntry: () => undefined,
    getDefaultKey: () => undefined,
    addKeybinding: vi.fn(),
    editKeybinding: vi.fn(),
    removeKeybinding: vi.fn(),
    getUserEntries: () => [],
    diagnostics: { vscodeFilePath: undefined, vscodeParsedCount: 0, vscodeRegisteredCount: 0 },
  }

  const services = new ServiceCollection()
  services.set(IUserKeybindingsService, userKeybindingsService)
  const contextKeyService = new ContextKeyService()
  services.set(IContextKeyService, contextKeyService)
  const instantiation = new InstantiationService(services)

  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <KeybindingsEditor />
    </ServicesContext.Provider>,
  )

  return { ...utils, onDidChangeEmitter, userKeybindingsService, contextKeyService }
}

/** Data rows only (the header row carries no parity marker). */
function gridRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-parity]')]
}

function openMenuOnRow(container: HTMLElement, rowText: string): HTMLElement {
  const row = gridRows(container).find((el) => el.textContent?.includes(rowText))
  expect(row, `row containing "${rowText}"`).toBeDefined()
  fireEvent.contextMenu(row!)
  const menu = document.querySelector<HTMLElement>('[role=menu]')
  expect(menu).not.toBeNull()
  return menu!
}

function menuItemEnabled(menu: HTMLElement, label: string): boolean {
  const item = [...menu.querySelectorAll('[role=menuitem]')].find((el) =>
    el.textContent?.includes(label),
  )
  expect(item, `menu item "${label}"`).toBeDefined()
  return item!.getAttribute('aria-disabled') !== 'true'
}

describe('KeybindingsEditor', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function registerTestCommands() {
    disposables.push(
      CommandsRegistry.registerCommand('test.kb.alpha', () => undefined, {
        description: 'Alpha Command',
        category: 'Test',
      }),
      CommandsRegistry.registerCommand('test.kb.beta', () => undefined, {
        description: 'Beta Command',
        category: 'Test',
      }),
    )
  }

  it('focuses the search input on mount', async () => {
    registerTestCommands()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('re-focuses the search input when the focus event fires', async () => {
    registerTestCommands()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(search))

    const other = document.createElement('button')
    document.body.appendChild(other)
    other.focus()
    expect(document.activeElement).toBe(other)

    act(() => {
      document.dispatchEvent(new Event(KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT))
    })

    await waitFor(() => expect(document.activeElement).toBe(search))
    other.remove()
  })

  it('applies a pending query dispatched before mount (freshly opened editor)', async () => {
    registerTestCommands()
    dispatchKeybindingsEditorFocusSearch('@command:test.kb.alpha')
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    await waitFor(() => expect(search.value).toBe('@command:test.kb.alpha'))
  })

  it('applies a query dispatched to an already-mounted editor (tab reuse)', async () => {
    registerTestCommands()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    expect(search.value).toBe('')

    act(() => {
      dispatchKeybindingsEditorFocusSearch('@command:test.kb.beta')
    })
    // dispatch is deferred via queueMicrotask
    await waitFor(() => expect(search.value).toBe('@command:test.kb.beta'))
  })

  it('filters rows by the debounced search text', async () => {
    vi.useFakeTimers()
    try {
      registerTestCommands()
      const { container } = mount()
      const initialCount = gridRows(container).length
      expect(initialCount).toBeGreaterThanOrEqual(2)

      const search = container.querySelector('input[type=search]') as HTMLInputElement
      fireEvent.change(search, { target: { value: 'alpha' } })

      // Debounced: the filter only applies after the 300ms timer fires.
      expect(gridRows(container)).toHaveLength(initialCount)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(350)
      })
      const rowsAfter = gridRows(container)
      expect(rowsAfter).toHaveLength(1)
      expect(rowsAfter[0]!.textContent).toContain('Alpha Command')
    } finally {
      vi.useRealTimers()
    }
  })

  it('enables context-menu entries per row binding state', () => {
    registerTestCommands()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+alt+t', command: 'test.kb.alpha' }),
    )
    const { container } = mount()

    // Bound row: Change/Remove/When/Show Same enabled; Reset disabled (not a user row).
    let menu = openMenuOnRow(container, 'Alpha Command')
    expect(menuItemEnabled(menu, 'Copy Command ID')).toBe(true)
    expect(menuItemEnabled(menu, 'Copy Command Title')).toBe(true)
    expect(menuItemEnabled(menu, 'Change Keybinding...')).toBe(true)
    expect(menuItemEnabled(menu, 'Remove Keybinding')).toBe(true)
    expect(menuItemEnabled(menu, 'Reset Keybinding')).toBe(false)
    expect(menuItemEnabled(menu, 'Change When Expression')).toBe(true)
    expect(menuItemEnabled(menu, 'Show Same Keybindings')).toBe(true)
    fireEvent.keyDown(menu, { key: 'Escape' })

    // Unbound row: only Add Keybinding; remove/when/show-same disabled.
    menu = openMenuOnRow(container, 'Beta Command')
    expect(menuItemEnabled(menu, 'Add Keybinding...')).toBe(true)
    expect(menuItemEnabled(menu, 'Remove Keybinding')).toBe(false)
    expect(menuItemEnabled(menu, 'Change When Expression')).toBe(false)
    expect(menuItemEnabled(menu, 'Show Same Keybindings')).toBe(false)
    fireEvent.keyDown(menu, { key: 'Escape' })
  })

  it('enables Reset Keybinding only for user-source rows and routes it to the service', () => {
    registerTestCommands()
    const { container, userKeybindingsService } = mount([
      { command: 'test.kb.alpha', key: 'ctrl+alt+u' },
    ])

    const userRow = gridRows(container).find((el) => el.textContent?.includes('User'))
    expect(userRow).toBeDefined()

    const menu = openMenuOnRow(container, 'User')
    expect(menuItemEnabled(menu, 'Reset Keybinding')).toBe(true)

    const resetItem = [...menu.querySelectorAll('[role=menuitem]')].find((el) =>
      el.textContent?.includes('Reset Keybinding'),
    )!
    fireEvent.click(resetItem)
    expect(userKeybindingsService.resetKeybinding).toHaveBeenCalledWith('test.kb.alpha')
  })

  it('routes Remove Keybinding to the service with the row target', () => {
    registerTestCommands()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+alt+t', command: 'test.kb.alpha' }),
    )
    const { container, userKeybindingsService } = mount()

    const menu = openMenuOnRow(container, 'Alpha Command')
    const removeItem = [...menu.querySelectorAll('[role=menuitem]')].find((el) =>
      el.textContent?.includes('Remove Keybinding'),
    )!
    fireEvent.click(removeItem)
    expect(userKeybindingsService.removeKeybinding).toHaveBeenCalledWith({
      command: 'test.kb.alpha',
      // Registry key space normalizes modifier order (alt before ctrl).
      key: 'alt+ctrl+t',
      when: undefined,
      isDefault: true,
    })
  })

  it('navigates the selection with arrow keys and maintains keybindingFocus', () => {
    registerTestCommands()
    const { container, contextKeyService } = mount()

    const grid = container.querySelector('[role=grid]') as HTMLElement
    // The Monaco test stub registers a handful of its own commands, so only
    // relative order (first/second/last in DOM order) is asserted.
    const rowCount = gridRows(container).length
    expect(rowCount).toBeGreaterThanOrEqual(2)

    // keybindingFocus requires both table focus and a selection.
    expect(contextKeyService.get('keybindingFocus')).toBe(false)

    act(() => {
      grid.focus()
    })
    expect(contextKeyService.get('keybindingFocus')).toBe(false)

    act(() => {
      fireEvent.keyDown(grid, { key: 'ArrowDown' })
    })
    expect(gridRows(container)[0]!.getAttribute('aria-selected')).toBe('true')
    expect(contextKeyService.get('keybindingFocus')).toBe(true)

    act(() => {
      fireEvent.keyDown(grid, { key: 'ArrowDown' })
    })
    expect(gridRows(container)[0]!.getAttribute('aria-selected')).toBe('false')
    expect(gridRows(container)[1]!.getAttribute('aria-selected')).toBe('true')

    // End jumps to the last row, ArrowUp walks back.
    act(() => {
      fireEvent.keyDown(grid, { key: 'End' })
    })
    expect(gridRows(container)[rowCount - 1]!.getAttribute('aria-selected')).toBe('true')
    act(() => {
      fireEvent.keyDown(grid, { key: 'ArrowUp' })
    })
    expect(gridRows(container)[rowCount - 2]!.getAttribute('aria-selected')).toBe('true')

    // Blurring the table clears the focus key again.
    act(() => {
      grid.blur()
    })
    expect(contextKeyService.get('keybindingFocus')).toBe(false)
  })

  it('record-keys mode writes a quoted complete-match query and Escape exits it', async () => {
    registerTestCommands()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement

    const recordButton = container.querySelector(
      'button[aria-label="Record Keys"]',
    ) as HTMLButtonElement
    expect(recordButton).not.toBeNull()
    fireEvent.click(recordButton)

    await waitFor(() => expect(document.activeElement).toBe(search))
    expect(search.placeholder).toBe('Recording Keys. Press Escape to exit.')
    expect(container.textContent).toContain('Recording Keys')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(search.value).toBe('"ctrl+k"')

    // Second stroke extends the chord; a third would clear and restart.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(search.value).toBe('"ctrl+k ctrl+s"')
    fireEvent.keyDown(window, { key: 'x', altKey: true })
    expect(search.value).toBe('"alt+x"')

    // Escape exits recording but keeps the recorded query.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(search.placeholder).toBe('Type to search in keybindings')
    expect(container.querySelector('button[aria-label="Record Keys"]')).not.toBeNull()
    expect(search.value).toBe('"alt+x"')
  })

  it('opens the define overlay on double-click and confirms via editKeybinding', () => {
    registerTestCommands()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+alt+t', command: 'test.kb.alpha' }),
    )
    const { container, userKeybindingsService } = mount()

    const row = gridRows(container).find((el) => el.textContent?.includes('Alpha Command'))!
    fireEvent.doubleClick(row)
    expect(container.textContent).toContain('Press desired key combination and then press ENTER.')

    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(userKeybindingsService.editKeybinding).toHaveBeenCalledWith(
      { command: 'test.kb.alpha', key: 'alt+ctrl+t', when: undefined, isDefault: true },
      'alt+ctrl+p',
      undefined,
    )
    expect(container.textContent).not.toContain(
      'Press desired key combination and then press ENTER.',
    )
  })

  it('adds a binding for an unbound row via addKeybinding', () => {
    registerTestCommands()
    const { container, userKeybindingsService } = mount()

    const row = gridRows(container).find((el) => el.textContent?.includes('Beta Command'))!
    fireEvent.doubleClick(row)
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(userKeybindingsService.addKeybinding).toHaveBeenCalledWith(
      'test.kb.beta',
      'alt+ctrl+b',
      undefined,
    )
  })

  it('Change When Expression opens the inline editor and commits through editKeybinding', () => {
    registerTestCommands()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+alt+t', command: 'test.kb.alpha' }),
    )
    const { container, userKeybindingsService, contextKeyService } = mount()

    const menu = openMenuOnRow(container, 'Alpha Command')
    const whenItem = [...menu.querySelectorAll('[role=menuitem]')].find((el) =>
      el.textContent?.includes('Change When Expression'),
    )!
    fireEvent.click(whenItem)

    const input = container.querySelector('input[aria-label="When expression"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(contextKeyService.get('whenFocus')).toBe(true)

    fireEvent.change(input, { target: { value: 'editorTextFocus' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(userKeybindingsService.editKeybinding).toHaveBeenCalledWith(
      { command: 'test.kb.alpha', key: 'alt+ctrl+t', when: undefined, isDefault: true },
      'alt+ctrl+t',
      'editorTextFocus',
    )
    expect(contextKeyService.get('whenFocus')).toBe(false)
    // Keyboard exit hands focus back to the table so arrow navigation keeps working.
    expect(document.activeElement).toBe(container.querySelector('[role=grid]'))
  })

  it('keeps End/Home/PageDown inside the when editor input instead of navigating the table', () => {
    registerTestCommands()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+alt+t', command: 'test.kb.alpha' }),
    )
    const { container } = mount()

    const menu = openMenuOnRow(container, 'Alpha Command')
    const whenItem = [...menu.querySelectorAll('[role=menuitem]')].find((el) =>
      el.textContent?.includes('Change When Expression'),
    )!
    fireEvent.click(whenItem)

    const input = container.querySelector('input[aria-label="When expression"]') as HTMLInputElement
    const selectedIndex = () =>
      gridRows(container).findIndex((el) => el.getAttribute('aria-selected') === 'true')
    const before = selectedIndex()
    expect(before).toBeGreaterThanOrEqual(0)

    // Without the grid's target guard these bubble up and jump the selection.
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.keyDown(input, { key: 'Home' })
    fireEvent.keyDown(input, { key: 'PageDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(selectedIndex()).toBe(before)
  })

  it('Escape cancels the when editor and returns focus to the table', () => {
    registerTestCommands()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+alt+t', command: 'test.kb.alpha' }),
    )
    const { container, userKeybindingsService } = mount()

    const menu = openMenuOnRow(container, 'Alpha Command')
    const whenItem = [...menu.querySelectorAll('[role=menuitem]')].find((el) =>
      el.textContent?.includes('Change When Expression'),
    )!
    fireEvent.click(whenItem)

    const input = container.querySelector('input[aria-label="When expression"]') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(container.querySelector('input[aria-label="When expression"]')).toBeNull()
    expect(userKeybindingsService.editKeybinding).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(container.querySelector('[role=grid]'))
  })

  it('re-selects the rebuilt row after a when commit changes its identity', () => {
    registerTestCommands()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+alt+t', command: 'test.kb.alpha' }),
    )
    const { container, userKeybindingsService, onDidChangeEmitter } = mount()
    // Behave like the real service: the edit lands in the user layer and fires
    // a change, rebuilding the model with a new row id (when + source change).
    vi.mocked(userKeybindingsService.editKeybinding).mockImplementation((target, key, when) => {
      ;(userKeybindingsService as unknown as { userEntries: IUserKeybindingEntry[] }).userEntries =
        [{ command: target.command, key, ...(when !== undefined ? { when } : {}) }]
      onDidChangeEmitter.fire()
    })

    const menu = openMenuOnRow(container, 'Alpha Command')
    const whenItem = [...menu.querySelectorAll('[role=menuitem]')].find((el) =>
      el.textContent?.includes('Change When Expression'),
    )!
    fireEvent.click(whenItem)

    const input = container.querySelector('input[aria-label="When expression"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'editorTextFocus' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const editedRow = gridRows(container).find(
      (el) => el.textContent?.includes('Alpha Command') && el.textContent?.includes('User'),
    )
    expect(editedRow, 'rebuilt user row carrying the new when').toBeDefined()
    expect(editedRow!.textContent).toContain('editorTextFocus')
    expect(editedRow!.getAttribute('aria-selected')).toBe('true')
  })
})
