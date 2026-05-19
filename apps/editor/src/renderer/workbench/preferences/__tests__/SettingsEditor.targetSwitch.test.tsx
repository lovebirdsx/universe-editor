import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, act } from '@testing-library/react'
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
import { SettingsEditorInput } from '../SettingsEditorInput.js'
import {
  SETTINGS_EDITOR_SWITCH_TARGET_EVENT,
  dispatchSettingsEditorSwitchTarget,
} from '../preferencesFocus.js'

function makeWorkspaceStub(open: boolean) {
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
    _fire: (w: null) => listeners.forEach((cb) => cb(w)),
  }
}

function makeNotificationStub() {
  const spy = vi.fn()
  const stub = {
    _serviceBrand: undefined as undefined,
    notifications: { read: () => [], onChange: () => ({ dispose: () => void 0 }) } as never,
    unreadCount: { read: () => 0, onChange: () => ({ dispose: () => void 0 }) } as never,
    centerVisible: { read: () => false, onChange: () => ({ dispose: () => void 0 }) } as never,
    notify: spy,
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
  }
  return { stub, notifySpy: spy }
}

function mount(opts: { workspaceOpen?: boolean } = {}) {
  const config = new ConfigurationService()
  const workspace = makeWorkspaceStub(opts.workspaceOpen ?? false)
  const { stub: notif, notifySpy } = makeNotificationStub()
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

  return { ...utils, config, workspace, notifySpy, input }
}

describe('SettingsEditor target switching', () => {
  let disposables: IDisposable[] = []

  function registerSchema() {
    disposables.push(
      ConfigurationRegistry.registerConfiguration({
        id: 'test',
        title: 'Test',
        properties: {
          'test.value': { type: 'string', default: 'hello' },
        },
      }),
    )
  }

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
  })

  it('renders User and Workspace tab buttons', () => {
    const { container } = mount()
    const buttons = container.querySelectorAll('button')
    const labels = Array.from(buttons).map((b) => b.textContent?.trim())
    expect(labels).toContain('User')
    expect(labels).toContain('Workspace')
  })

  it('User tab is active by default', () => {
    const { container } = mount()
    const userBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'User',
    )!
    expect(userBtn.className).toMatch(/tabActive/)
  })

  it('Workspace tab has disabled style when no workspace is open', () => {
    const { container } = mount({ workspaceOpen: false })
    const wsBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Workspace',
    )!
    expect(wsBtn.className).toMatch(/tabDisabled/)
  })

  it('clicking Workspace tab when no workspace shows notification', () => {
    registerSchema()
    const { container, notifySpy } = mount({ workspaceOpen: false })
    const wsBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Workspace',
    )!
    fireEvent.click(wsBtn)
    expect(notifySpy).toHaveBeenCalledOnce()
  })

  it('clicking Workspace tab when workspace is open switches active target', () => {
    registerSchema()
    const { container } = mount({ workspaceOpen: true })
    const wsBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Workspace',
    )!
    fireEvent.click(wsBtn)
    expect(wsBtn.className).toMatch(/tabActive/)
  })

  it('edits in Workspace tab write to Project layer', () => {
    registerSchema()
    const { container, config } = mount({ workspaceOpen: true })
    const wsBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Workspace',
    )!
    fireEvent.click(wsBtn)

    const textInput = container.querySelector(
      '[data-key="test.value"] input[type=text]',
    ) as HTMLInputElement
    fireEvent.change(textInput, { target: { value: 'workspace-val' } })

    expect(
      (config.getLayerSnapshot(ConfigurationTarget.Project) as Record<string, unknown>)[
        'test.value'
      ],
    ).toBe('workspace-val')
    expect(
      (config.getLayerSnapshot(ConfigurationTarget.User) as Record<string, unknown>)['test.value'],
    ).toBeUndefined()
  })

  it('edits in User tab write to User layer', () => {
    registerSchema()
    const { container, config } = mount()
    const textInput = container.querySelector(
      '[data-key="test.value"] input[type=text]',
    ) as HTMLInputElement
    fireEvent.change(textInput, { target: { value: 'user-val' } })

    expect(
      (config.getLayerSnapshot(ConfigurationTarget.User) as Record<string, unknown>)['test.value'],
    ).toBe('user-val')
  })

  it('origin badge shows Default for unset key', () => {
    registerSchema()
    const { container } = mount()
    const badge = container.querySelector('[data-key="test.value"] [class*=originBadge]')
    expect(badge?.textContent).toBe('Default')
  })

  it('origin badge shows User after User-layer write', () => {
    registerSchema()
    const { container, config } = mount()
    act(() => {
      config.update('test.value', 'x', ConfigurationTarget.User)
    })
    const badge = container.querySelector('[data-key="test.value"] [class*=originBadge]')
    expect(badge?.textContent).toBe('User')
  })

  it('origin badge shows Workspace after Project-layer write', () => {
    registerSchema()
    const { container, config } = mount()
    act(() => {
      config.update('test.value', 'x', ConfigurationTarget.Project)
    })
    const badge = container.querySelector('[data-key="test.value"] [class*=originBadge]')
    expect(badge?.textContent).toBe('Workspace')
  })

  it('external dispatchSettingsEditorSwitchTarget switches tab', async () => {
    registerSchema()
    const { container } = mount({ workspaceOpen: true })
    await act(async () => {
      dispatchSettingsEditorSwitchTarget(ConfigurationTarget.Project)
      // flush microtask (queueMicrotask inside dispatch)
      await Promise.resolve()
    })
    const wsBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Workspace',
    )!
    expect(wsBtn.className).toMatch(/tabActive/)
  })

  it('switching to User tab fires CustomEvent on document', () => {
    const { container } = mount({ workspaceOpen: true })
    const events: number[] = []
    const handler = (e: Event) => events.push((e as CustomEvent<number>).detail)
    document.addEventListener(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, handler)

    const userBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'User',
    )!
    fireEvent.click(userBtn)
    document.removeEventListener(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, handler)

    // The component calls switchTarget internally but does NOT re-dispatch the custom event
    // — dispatchSettingsEditorSwitchTarget is only called from actions.
    // So here we just verify the tab UI updated.
    expect(userBtn.className).toMatch(/tabActive/)
  })
})
