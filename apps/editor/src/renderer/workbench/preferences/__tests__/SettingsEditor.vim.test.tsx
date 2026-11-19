/*---------------------------------------------------------------------------------------------
 *  Settings editor as Vim surfaces.
 *
 *  The rows are a flat list (j/k/gg/G/Ctrl+d/u, Enter focuses the row control,
 *  Esc returns to the list) and the TOC is a second surface (j/k highlight,
 *  Enter/l jump to the group and hand focus back to the rows). The tests drive
 *  the surface actions directly — that is what the dispatcher executes after a
 *  keymap match — and assert the DOM focus model, mirroring the workbench-ui
 *  adapter suite.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  ConfigurationRegistry,
  ConfigurationService,
  ContextKeyService,
  Event as PlatformEvent,
  IConfigurationService,
  IContextKeyService,
  INotificationService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { __resetVimSurfacesForTests, getActiveVimSurface } from '@universe-editor/workbench-ui'
import { ServicesContext } from '../../useService.js'
import { SettingsEditor } from '../SettingsEditor.js'
import { SettingsEditorInput } from '../../../services/editor/SettingsEditorInput.js'
import { dispatchSettingsEditorFocusList } from '../preferencesFocus.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getScrollElement,
  }: {
    count: number
    getScrollElement: () => HTMLElement | null
  }) => {
    const size = 100
    return {
      getTotalSize: () => count * size,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: index,
          start: index * size,
          size,
        })),
      scrollToIndex: (index: number) => {
        const el = getScrollElement()
        if (!el) return
        el.scrollTop = index * size
        el.dispatchEvent(new Event('scroll'))
      },
      measureElement: () => {},
      getVirtualItemForOffset: (offset: number) => {
        if (count === 0) return undefined
        const index = Math.min(count - 1, Math.max(0, Math.floor(offset / size)))
        return { index, key: index, start: index * size, size }
      },
    }
  },
}))

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspaceScope = PlatformEvent.None
  store = new Map<string, unknown>()
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

const workspaceStub = {
  _serviceBrand: undefined,
  current: null as null,
  onDidChangeWorkspace: () => ({ dispose: () => void 0 }),
  recent: [],
  onDidChangeRecent: () => ({ dispose: () => void 0 }),
  openFolder: async () => void 0,
  closeFolder: async () => void 0,
  clearRecent: async () => void 0,
}

const notificationStub = {
  _serviceBrand: undefined,
  notifications: { read: () => [], onChange: () => ({ dispose: () => void 0 }) },
  unreadCount: { read: () => 0, onChange: () => ({ dispose: () => void 0 }) },
  centerVisible: { read: () => false, onChange: () => ({ dispose: () => void 0 }) },
  notify: () => ({
    id: 'x',
    progress: { report: () => void 0, done: () => void 0 },
    dispose: () => void 0,
    updateMessage: () => void 0,
    updateSeverity: () => void 0,
  }),
  prompt: async () => void 0,
  status: () => ({
    id: 'x',
    progress: { report: () => void 0, done: () => void 0 },
    dispose: () => void 0,
    updateMessage: () => void 0,
    updateSeverity: () => void 0,
  }),
  dismiss: () => void 0,
  clearAll: () => void 0,
  toggleCenter: () => void 0,
  markAllAsRead: () => void 0,
}

function mount(contextKeyService?: ContextKeyService) {
  const services = new ServiceCollection()
  services.set(IConfigurationService, new ConfigurationService())
  services.set(IWorkspaceService, workspaceStub as never)
  services.set(INotificationService, notificationStub as never)
  services.set(IStorageService, new FakeStorage())
  if (contextKeyService !== undefined) services.set(IContextKeyService, contextKeyService)
  const instantiation = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={instantiation}>
      <SettingsEditor input={new SettingsEditorInput()} />
    </ServicesContext.Provider>,
  )
}

function row(container: HTMLElement, key: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-key="${key}"]`)
  if (element === null) throw new Error(`missing row ${key}`)
  return element
}

function focusedRowKey(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLElement>('[data-vim-focused="true"]')?.dataset['key']
}

describe('SettingsEditor Vim surfaces', () => {
  let disposables: IDisposable[] = []

  function registerSchema(): void {
    for (const id of ['alpha', 'beta', 'gamma']) {
      disposables.push(
        ConfigurationRegistry.registerConfiguration({
          id,
          title: id,
          properties: {
            [`${id}.one`]: { type: 'number' as const, default: 1 },
            [`${id}.two`]: { type: 'string' as const, default: '' },
          },
        }),
      )
    }
  }

  afterEach(() => {
    cleanup()
    __resetVimSurfacesForTests()
    disposables.forEach((d) => d.dispose())
    disposables = []
  })

  it('drives the row list with j/k/gg/G and counts', () => {
    registerSchema()
    const { container } = mount()
    const list = container.querySelector<HTMLElement>('[data-testid="settings-list"]')!
    act(() => list.focus())

    expect(getActiveVimSurface(document)?.surfaceKey).toBe('list:settings')
    const actions = getActiveVimSurface(document)!.surface.actions

    // Focus seeds the cursor onto the first row; j moves from there.
    expect(focusedRowKey(container)).toBe('alpha.one')
    act(() => actions.move?.('down', 1))
    expect(focusedRowKey(container)).toBe('alpha.two')
    act(() => actions.move?.('down', 2))
    expect(focusedRowKey(container)).toBe('beta.two')
    act(() => actions.move?.('up', 1))
    expect(focusedRowKey(container)).toBe('beta.one')
    act(() => actions.last?.(1))
    expect(focusedRowKey(container)).toBe('gamma.two')
    act(() => actions.first?.(1))
    expect(focusedRowKey(container)).toBe('alpha.one')
  })

  it('Enter focuses the row control and Escape returns to the list', () => {
    registerSchema()
    const { container } = mount()
    const list = container.querySelector<HTMLElement>('[data-testid="settings-list"]')!
    act(() => list.focus())
    const actions = getActiveVimSurface(document)!.surface.actions

    act(() => actions.move?.('down', 1))
    act(() => actions.activate?.(1, false))

    const input = row(container, 'alpha.two').querySelector('input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)

    act(() => {
      fireEvent.keyDown(input!, { key: 'Escape' })
    })
    expect(document.activeElement).toBe(list)
  })

  it('TOC j/k highlights a group and Enter hands focus to the rows', () => {
    registerSchema()
    const { container } = mount()
    const toc = container.querySelector<HTMLElement>('[data-testid="settings-toc"]')!
    const list = container.querySelector<HTMLElement>('[data-testid="settings-list"]')!

    act(() => toc.focus())
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('list:settings-toc')
    const actions = getActiveVimSurface(document)!.surface.actions

    // Focus seeds the first group; one j moves to the second.
    act(() => actions.move?.('down', 1))
    const active = toc.querySelector<HTMLElement>('[aria-current="true"]')
    expect(active?.textContent).toContain('beta')

    act(() => actions.activate?.(1, false))
    expect(document.activeElement).toBe(list)
    expect(focusedRowKey(container)).toBe('beta.one')
  })

  it('keeps the focus wiring after a zero-result search remounts the list', async () => {
    registerSchema()
    const context = new ContextKeyService()
    const { container } = mount(context)
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!

    await act(async () => {
      fireEvent.change(search, { target: { value: 'zzz-no-such-setting' } })
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="settings-list"]')).toBeNull()

    await act(async () => {
      fireEvent.change(search, { target: { value: '' } })
      await Promise.resolve()
    })
    const list = container.querySelector<HTMLElement>('[data-testid="settings-list"]')!
    expect(list).not.toBeNull()

    act(() => list.focus())
    const actions = getActiveVimSurface(document)!.surface.actions
    act(() => actions.move?.('down', 1))
    act(() => actions.activate?.(1, false))
    const input = row(container, 'alpha.two').querySelector('input')
    expect(document.activeElement).toBe(input)
    expect(context.get('settingsListControlFocus')).toBe(true)

    // Escape inside the control returns to the list.
    act(() => {
      fireEvent.keyDown(input!, { key: 'Escape' })
    })
    expect(document.activeElement).toBe(list)
    expect(context.get('settingsListControlFocus')).toBe(false)

    // The document-level "focus the list" event must reach the remounted pane.
    act(() => input!.focus())
    await act(async () => {
      dispatchSettingsEditorFocusList()
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(list)
  })

  it('keeps the search box typing to itself', () => {
    registerSchema()
    const { container } = mount()
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!

    act(() => search.focus())
    fireEvent.change(search, { target: { value: 'gamma' } })
    act(() => {
      fireEvent.keyDown(search, { key: 'j' })
    })

    expect(search.value).toBe('gamma')
    expect(document.activeElement).toBe(search)
    expect(focusedRowKey(container)).toBeUndefined()
  })
})
