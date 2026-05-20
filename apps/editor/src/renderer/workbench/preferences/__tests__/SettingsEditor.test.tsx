import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, act, waitFor } from '@testing-library/react'
import {
  ConfigurationRegistry,
  ConfigurationService,
  ConfigurationTarget,
  IConfigurationService,
  INotificationService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { SettingsEditor } from '../SettingsEditor.js'
import { SettingsEditorInput } from '../../../services/editor/SettingsEditorInput.js'
import { SETTINGS_EDITOR_FOCUS_SEARCH_EVENT } from '../preferencesFocus.js'

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

function mount(opts: { workspaceOpen?: boolean } = {}) {
  const config = new ConfigurationService()
  const workspace = makeWorkspaceStub(opts.workspaceOpen ?? false)
  const notif = makeNotificationStub()
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  services.set(IWorkspaceService, workspace as never)
  services.set(INotificationService, notif as never)
  const instantiation = new InstantiationService(services)
  const input = new SettingsEditorInput()

  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <SettingsEditor input={input} />
    </ServicesContext.Provider>,
  )

  return { ...utils, config, workspace, notif, input }
}

describe('SettingsEditor', () => {
  let disposables: IDisposable[] = []

  function registerSeedSchema() {
    disposables.push(
      ConfigurationRegistry.registerConfiguration({
        id: 'editor',
        title: 'Editor',
        properties: {
          'editor.fontSize': { type: 'number', default: 14, minimum: 8, maximum: 32 },
          'editor.wordWrap': { type: 'boolean', default: false },
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

  it('renders a section per registered node', () => {
    registerSeedSchema()
    const { container } = mount()
    const sections = container.querySelectorAll('section')
    expect(sections.length).toBe(2)
    const titles = Array.from(sections).map((s) => s.querySelector('h2')?.textContent)
    expect(titles).toEqual(['Editor', 'Files'])
  })

  it('renders one row per property, with correct controls', () => {
    registerSeedSchema()
    const { container } = mount()
    expect(container.querySelector('[data-key="editor.fontSize"] input[type=number]')).toBeTruthy()
    expect(
      container.querySelector('[data-key="editor.wordWrap"] input[type=checkbox]'),
    ).toBeTruthy()
    expect(container.querySelector('[data-key="files.autoSave"] select')).toBeTruthy()
  })

  it('search filter narrows visible rows', () => {
    registerSeedSchema()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'fontSize' } })

    expect(container.querySelector('[data-key="editor.fontSize"]')).toBeTruthy()
    expect(container.querySelector('[data-key="editor.wordWrap"]')).toBeNull()
    expect(container.querySelector('[data-key="files.autoSave"]')).toBeNull()
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

  it('editing a boolean writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const cb = container.querySelector(
      '[data-key="editor.wordWrap"] input[type=checkbox]',
    ) as HTMLInputElement
    fireEvent.click(cb)
    expect(config.get('editor.wordWrap')).toBe(true)
  })

  it('editing an enum writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const select = container.querySelector(
      '[data-key="files.autoSave"] select',
    ) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'afterDelay' } })
    expect(config.get('files.autoSave')).toBe('afterDelay')
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
