import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, act, waitFor, cleanup } from '@testing-library/react'
import {
  ConfigurationRegistry,
  ConfigurationService,
  ConfigurationTarget,
  Event as PlatformEvent,
  IConfigurationService,
  INotificationService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { SettingsEditor } from '../SettingsEditor.js'
import { SettingsEditorInput } from '../../../services/editor/SettingsEditorInput.js'
import { SETTINGS_EDITOR_FOCUS_SEARCH_EVENT } from '../preferencesFocus.js'

// happy-dom has no layout engine — the real virtualizer would render 0 items.
// Render every item so row-level assertions work against the full list.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 100,
        size: 100,
      })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
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

function makeWorkspaceStub(open = false) {
  const listeners: Array<(w: null) => void> = []
  return {
    _serviceBrand: undefined as undefined,
    current: open ? { folder: { fsPath: '/tmp' } as never, name: 'test' } : null,
    onDidChangeWorkspace: (cb: (w: null) => void) => {
      listeners.push(cb)
      return { dispose: () => void 0 }
    },
    recent: [],
    onDidChangeRecent: () => ({ dispose: () => void 0 }),
    openFolder: async () => void 0,
    closeFolder: async () => void 0,
    clearRecent: async () => void 0,
  }
}

function makeNotificationStub() {
  const calls: Array<{ severity: number; message: string }> = []
  return {
    _serviceBrand: undefined as undefined,
    notifications: { read: () => [], onChange: () => ({ dispose: () => void 0 }) } as never,
    unreadCount: { read: () => 0, onChange: () => ({ dispose: () => void 0 }) } as never,
    centerVisible: { read: () => false, onChange: () => ({ dispose: () => void 0 }) } as never,
    notify: (opts: { severity: number; message: string }) => {
      calls.push(opts)
      return {
        id: 'x',
        progress: { report: () => void 0, done: () => void 0 },
        dispose: () => void 0,
        updateMessage: () => void 0,
        updateSeverity: () => void 0,
      }
    },
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
    _calls: calls,
  }
}

function mount(opts: { workspaceOpen?: boolean; storage?: FakeStorage } = {}) {
  const config = new ConfigurationService()
  const workspace = makeWorkspaceStub(opts.workspaceOpen ?? false)
  const notif = makeNotificationStub()
  const storage = opts.storage ?? new FakeStorage()
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  services.set(IWorkspaceService, workspace as never)
  services.set(INotificationService, notif as never)
  services.set(IStorageService, storage)
  const instantiation = new InstantiationService(services)
  const input = new SettingsEditorInput()

  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <SettingsEditor input={input} />
    </ServicesContext.Provider>,
  )

  return { ...utils, config, workspace, notif, input, storage }
}

afterEach(() => {
  cleanup()
})

describe('SettingsEditor', () => {
  let disposables: IDisposable[] = []

  function registerSeedSchema() {
    disposables.push(
      ConfigurationRegistry.registerConfiguration({
        id: 'editor',
        title: 'Editor',
        properties: {
          'editor.fontSize': { type: 'number', default: 14, minimum: 6, maximum: 100 },
          'editor.minimap.enabled': { type: 'boolean', default: true },
        },
      }),
      ConfigurationRegistry.registerConfiguration({
        id: 'files',
        title: 'Files',
        properties: {
          'files.autoSave': { type: 'string', default: 'off', enum: ['off', 'afterDelay'] },
        },
      }),
    )
  }

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
  })

  it('renders a group header per registered node', () => {
    registerSeedSchema()
    const { container } = mount()
    const headers = container.querySelectorAll('[data-testid^="settings-group-"]')
    expect(headers.length).toBe(2)
    const titles = Array.from(headers).map((h) => h.textContent)
    expect(titles).toEqual(['Editor2', 'Files1'])
  })

  it('renders a TOC entry per group with the setting count', () => {
    registerSeedSchema()
    const { container } = mount()
    const toc = container.querySelector('[data-testid="settings-toc"]')!
    const items = toc.querySelectorAll('button')
    expect(items.length).toBe(2)
    expect(items[0]?.textContent).toBe('Editor2')
    expect(items[1]?.textContent).toBe('Files1')
  })

  it('renders one row per property, with correct controls', () => {
    registerSeedSchema()
    const { container } = mount()
    expect(container.querySelector('[data-key="editor.fontSize"] input[type=number]')).toBeTruthy()
    expect(
      container.querySelector('[data-key="editor.minimap.enabled"] input[type=checkbox]'),
    ).toBeTruthy()
    // Enum settings use the themed Select (button trigger), not a native select.
    const trigger = container.querySelector(
      '[data-key="files.autoSave"] [data-testid="setting-control-files.autoSave"] button',
    )
    expect(trigger?.textContent).toContain('off')
  })

  it('shows the wordified label with the full key as tooltip', () => {
    registerSeedSchema()
    const { container } = mount()
    const title = container.querySelector('[data-key="editor.fontSize"] [title]')
    expect(title?.getAttribute('title')).toBe('editor.fontSize')
    expect(title?.textContent).toContain('Font Size')
  })

  it('search filter narrows visible rows', () => {
    registerSeedSchema()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'fontSize' } })

    expect(container.querySelector('[data-key="editor.fontSize"]')).toBeTruthy()
    expect(container.querySelector('[data-key="editor.minimap.enabled"]')).toBeNull()
    expect(container.querySelector('[data-key="files.autoSave"]')).toBeNull()
  })

  it('search matches descriptions and shows a count badge', () => {
    disposables.push(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench',
        title: 'Workbench',
        properties: {
          'workbench.colorTheme': {
            type: 'string',
            default: 'dark',
            description: 'Controls the colors of the window',
          },
        },
      }),
    )
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'colors window' } })

    expect(container.querySelector('[data-key="workbench.colorTheme"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="settings-count"]')?.textContent).toContain('1')
  })

  it('@modified shows only settings owned by the viewed layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    act(() => {
      config.update('editor.fontSize', 20, ConfigurationTarget.User)
    })
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: '@modified' } })

    expect(container.querySelector('[data-key="editor.fontSize"]')).toBeTruthy()
    expect(container.querySelector('[data-key="editor.minimap.enabled"]')).toBeNull()
    expect(container.querySelector('[data-key="files.autoSave"]')).toBeNull()
  })

  it('empty result shows a clear-search action that resets the query', () => {
    registerSeedSchema()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'no-such-setting-anywhere' } })

    expect(container.querySelector('[data-key="editor.fontSize"]')).toBeNull()
    const clear = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear Search',
    )!
    fireEvent.click(clear)
    expect(search.value).toBe('')
    expect(container.querySelector('[data-key="editor.fontSize"]')).toBeTruthy()
  })

  it('restores the persisted query from storage on mount', async () => {
    registerSeedSchema()
    const storage = new FakeStorage()
    storage.store.set('settingsEditor.query', 'fontSize')
    const { container } = mount({ storage })

    await waitFor(() => {
      const search = container.querySelector('input[type=search]') as HTMLInputElement
      expect(search.value).toBe('fontSize')
    })
    expect(container.querySelector('[data-key="editor.minimap.enabled"]')).toBeNull()
  })

  it('focuses the search input on mount', async () => {
    registerSeedSchema()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('re-focuses the search input when the focus event fires', async () => {
    registerSeedSchema()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(search))

    const other = document.createElement('button')
    document.body.appendChild(other)
    other.focus()
    expect(document.activeElement).toBe(other)

    act(() => {
      document.dispatchEvent(new Event(SETTINGS_EDITOR_FOCUS_SEARCH_EVENT))
    })

    await waitFor(() => expect(document.activeElement).toBe(search))
    other.remove()
  })

  it('editing a number writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const input = container.querySelector(
      '[data-key="editor.fontSize"] input[type=number]',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: '20' } })

    expect(config.get('editor.fontSize')).toBe(20)
    expect(
      (config.getLayerSnapshot(ConfigurationTarget.User) as Record<string, unknown>)[
        'editor.fontSize'
      ],
    ).toBe(20)
  })

  it('writing back the default value removes the override (write-default = reset)', () => {
    registerSeedSchema()
    const { container, config } = mount()
    act(() => {
      config.update('editor.fontSize', 20, ConfigurationTarget.User)
    })
    const input = container.querySelector(
      '[data-key="editor.fontSize"] input[type=number]',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: '14' } })

    expect(config.get('editor.fontSize')).toBe(14)
    expect(
      Object.prototype.hasOwnProperty.call(
        config.getLayerSnapshot(ConfigurationTarget.User),
        'editor.fontSize',
      ),
    ).toBe(false)
  })

  it('clearing a number input and blurring resets to the default', () => {
    registerSeedSchema()
    const { container, config } = mount()
    act(() => {
      config.update('editor.fontSize', 20, ConfigurationTarget.User)
    })
    const input = container.querySelector(
      '[data-key="editor.fontSize"] input[type=number]',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    // Held as a draft while editing — no snap-back to the default yet.
    expect(input.value).toBe('')
    fireEvent.blur(input)

    expect(
      Object.prototype.hasOwnProperty.call(
        config.getLayerSnapshot(ConfigurationTarget.User),
        'editor.fontSize',
      ),
    ).toBe(false)
    expect(config.get('editor.fontSize')).toBe(14)
  })

  it('editing a boolean writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const cb = container.querySelector(
      '[data-key="editor.minimap.enabled"] input[type=checkbox]',
    ) as HTMLInputElement
    fireEvent.click(cb)
    expect(config.get('editor.minimap.enabled')).toBe(false)
  })

  it('editing an enum writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const trigger = container.querySelector(
      '[data-key="files.autoSave"] [data-testid="setting-control-files.autoSave"] button',
    ) as HTMLButtonElement
    fireEvent.click(trigger)
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === 'afterDelay',
    )!
    fireEvent.click(option)
    expect(config.get('files.autoSave')).toBe('afterDelay')
  })

  it('marks modified rows and resets them via the gear menu', () => {
    registerSeedSchema()
    const { container, config } = mount()

    const row = () => container.querySelector('[data-key="editor.fontSize"]')
    expect(row()?.getAttribute('data-modified')).toBeNull()

    act(() => {
      config.update('editor.fontSize', 20, ConfigurationTarget.User)
    })
    expect(row()?.getAttribute('data-modified')).toBe('true')

    const gear = row()!.querySelector('button[aria-label="More Actions"]') as HTMLButtonElement
    fireEvent.click(gear)
    const reset = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (i) => i.textContent === 'Reset Setting',
    )!
    fireEvent.click(reset)

    expect(
      Object.prototype.hasOwnProperty.call(
        config.getLayerSnapshot(ConfigurationTarget.User),
        'editor.fontSize',
      ),
    ).toBe(false)
    expect(row()?.getAttribute('data-modified')).toBeNull()
  })

  it('gear menu reset is disabled for unmodified settings', () => {
    registerSeedSchema()
    const { container } = mount()
    const gear = container.querySelector(
      '[data-key="editor.fontSize"] button[aria-label="More Actions"]',
    ) as HTMLButtonElement
    fireEvent.click(gear)
    const reset = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (i) => i.textContent === 'Reset Setting',
    )!
    expect(reset.getAttribute('aria-disabled')).toBe('true')
  })

  it('gear menu copies the setting id and JSON to the clipboard', async () => {
    registerSeedSchema()
    const { container } = mount()
    const written: string[] = []
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
    })

    const gear = container.querySelector(
      '[data-key="editor.fontSize"] button[aria-label="More Actions"]',
    ) as HTMLButtonElement
    fireEvent.click(gear)
    fireEvent.click(
      Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (i) => i.textContent === 'Copy Setting ID',
      )!,
    )
    expect(written).toEqual(['editor.fontSize'])

    fireEvent.click(gear)
    fireEvent.click(
      Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (i) => i.textContent === 'Copy Setting as JSON',
      )!,
    )
    expect(JSON.parse(written[1]!)).toEqual({ 'editor.fontSize': 14 })
    vi.unstubAllGlobals()
  })

  it('external config.update is reflected in the input', () => {
    registerSeedSchema()
    const { container, config } = mount()
    act(() => {
      config.update('editor.fontSize', 22, ConfigurationTarget.User)
    })
    const input = container.querySelector(
      '[data-key="editor.fontSize"] input[type=number]',
    ) as HTMLInputElement
    expect(Number(input.value)).toBe(22)
  })
})
