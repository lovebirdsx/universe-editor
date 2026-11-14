/*---------------------------------------------------------------------------------------------
 *  Tests for the Trigger Manager shell: workspace grouping, search, selection,
 *  pause toggles (setPaused, never `enabled`), the pausedAll lock, subscription
 *  cleanup and the pending-selection hand-off from the editor input.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  Emitter,
  FileSystemError,
  ICommandService,
  IDialogService,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  IInstantiationService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IOutputService,
  IQuickInputService,
  IUriIdentityService,
  IViewsService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
} from '@universe-editor/platform'
import { ILogFilesService } from '../../../../shared/ipc/services.js'
import { ITriggerMainService } from '../../../../shared/ipc/triggerService.js'
import {
  TriggerManagerEditorInput,
  type TriggerManagerEditorInputOptions,
} from '../../../services/triggers/triggerManagerEditorInput.js'
import { IAcpSessionService } from '../../../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../../services/acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../../../services/acp/session/acpChatWidgetService.js'
import { IWindowFocusService } from '../../../services/windows/windowFocusService.js'
import type { TriggerSummary } from '../../../../shared/triggers/types.js'
import { ServicesContext } from '../../useService.js'
import { TriggerManagerEditor } from '../TriggerManagerEditor.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  const id = overrides.id ?? 'triage'
  return {
    key: id,
    id,
    name: 'Triage',
    workspace: 'X:/workspace',
    workspaceName: 'workspace',
    sourceType: 'swarm-review',
    source: { type: 'swarm-review' },
    status: 'idle',
    enabled: true,
    paused: false,
    pausedAll: false,
    autoPaused: false,
    activationConfirmed: true,
    elevatedMode: false,
    elevatedModeConfirmed: false,
    approveAction: false,
    approveConfirmed: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

interface HarnessOptions {
  readonly summaries?: readonly TriggerSummary[]
  readonly inputOptions?: TriggerManagerEditorInputOptions
  readonly runs?: readonly import('../../../../shared/triggers/types.js').TriggerRunHistoryEntry[]
}

class FakeFiles {
  readonly entries = new Map<string, { text: string; mtime: number }>()
  private clock = 100

  put(uri: URI, text: string): void {
    this.entries.set(uri.toString(), { text, mtime: ++this.clock })
  }

  async readFileText(uri: URI): Promise<string> {
    const entry = this.entries.get(uri.toString())
    if (entry === undefined) throw new FileSystemError('not found', 'ENOENT')
    return entry.text
  }

  async stat(uri: URI): Promise<{ mtime: number }> {
    const entry = this.entries.get(uri.toString())
    if (entry === undefined) throw new FileSystemError('not found', 'ENOENT')
    return { mtime: entry.mtime }
  }

  async writeFile(uri: URI, content: string | Uint8Array): Promise<void> {
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    this.entries.set(uri.toString(), { text, mtime: ++this.clock })
  }

  async exists(uri: URI): Promise<boolean> {
    return this.entries.has(uri.toString())
  }

  async createDirectory(): Promise<void> {}
}

function renderEditor(options: HarnessOptions = {}) {
  const changeEmitter = new Emitter<readonly TriggerSummary[]>()
  const subscriptionDispose = vi.fn()
  const listTriggers = vi.fn(async () => options.summaries ?? [])
  const setPaused = vi.fn(async () => undefined)
  const setAllPaused = vi.fn(async () => undefined)
  const runNow = vi.fn(async () => undefined)
  const listRuns = vi.fn(async () => options.runs ?? [])
  const listWorkspaces = vi.fn(async () => [
    {
      workspace: URI.file('X:/workspace').toString(),
      name: 'workspace',
      configPath: 'X:/workspace/.universe-editor/triggers.json',
      available: true,
      triggerCount: 0,
    },
  ])
  const files = new FakeFiles()

  const services = new ServiceCollection()
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    listTriggers,
    listWorkspaces,
    ensureConfigFile: vi.fn(async () => ''),
    setPaused,
    setAllPaused,
    runNow,
    listRuns,
    onDidChangeTriggers: (listener: (list: readonly TriggerSummary[]) => void) => {
      const subscription = changeEmitter.event(listener)
      return {
        dispose: () => {
          subscriptionDispose()
          subscription.dispose()
        },
      }
    },
  } as unknown as ITriggerMainService)
  services.set(IQuickInputService, {} as never)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(IDialogService, { confirm: vi.fn() } as unknown as IDialogService)
  services.set(IEditorResolverService, {
    openEditor: vi.fn(),
    createEditorInput: vi.fn(),
  } as unknown as IEditorResolverService)
  services.set(IEditorService, {
    openEditor: vi.fn((input: unknown) => input),
  } as unknown as IEditorService)
  services.set(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService)
  services.set(IUriIdentityService, {
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  } as unknown as IUriIdentityService)
  services.set(IFileService, files as unknown as IFileService)
  services.set(ILogFilesService, {} as never)
  services.set(IOutputService, {} as never)
  services.set(ILayoutService, {} as never)
  services.set(IViewsService, {} as never)
  services.set(IWorkspaceService, {
    current: { folder: URI.file('X:/workspace') },
  } as unknown as IWorkspaceService)
  services.set(ICommandService, { executeCommand: vi.fn() } as unknown as ICommandService)
  services.set(ILoggerService, {
    createLogger: () => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
      setLevel: vi.fn(),
    }),
  } as unknown as ILoggerService)
  const instantiation = new InstantiationService(services)
  services.set(IInstantiationService, instantiation)
  services.set(IAcpSessionService, {
    sessions: observableValue('test.sessions', []),
  } as unknown as IAcpSessionService)
  services.set(IAcpSessionHistoryService, {
    entries: observableValue('test.history', []),
    get: () => undefined,
  } as unknown as IAcpSessionHistoryService)
  services.set(IAcpChatWidgetService, {
    focusSessionInput: vi.fn(),
  } as unknown as IAcpChatWidgetService)
  services.set(IWindowFocusService, {} as never)

  const input = new TriggerManagerEditorInput(options.inputOptions ?? {})
  const view = render(
    <ServicesContext.Provider value={instantiation}>
      <TriggerManagerEditor input={input} />
    </ServicesContext.Provider>,
  )

  return {
    input,
    view,
    files,
    listWorkspaces,
    setPaused,
    setAllPaused,
    runNow,
    listTriggers,
    listRuns,
    subscriptionDispose,
    fireChange: (list: readonly TriggerSummary[]) => act(() => changeEmitter.fire(list)),
  }
}

function rowByKey(key: string): HTMLElement {
  const row = screen
    .getAllByTestId('trigger-manager-row')
    .find((element) => element.getAttribute('data-trigger-key') === key)
  if (row === undefined) throw new Error(`row ${key} not found`)
  return row
}

const TWO_WORKSPACES = [
  summary({ id: 'a', name: 'Alpha', workspace: 'ws-1', workspaceName: 'alpha' }),
  summary({ id: 'b', name: 'Beta', workspace: 'ws-2', workspaceName: 'beta' }),
]

describe('TriggerManagerEditor', () => {
  it('renders one group header per workspace and one row per trigger', async () => {
    renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    const groups = screen.getAllByTestId('trigger-manager-group')
    expect(groups.map((group) => group.textContent)).toEqual(['alpha', 'beta'])
    expect(screen.getAllByTestId('trigger-manager-row')).toHaveLength(2)
  })

  it('filters rows by name', async () => {
    renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    fireEvent.change(screen.getByTestId('trigger-manager-search'), {
      target: { value: 'beta' },
    })

    expect(screen.getAllByTestId('trigger-manager-row')).toHaveLength(1)
    expect(rowByKey('b')).toBeDefined()
  })

  it('shows the clicked row in the overview panel', async () => {
    renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')
    expect(screen.getByTestId('trigger-manager-overview-name').textContent).toBe('Alpha')

    fireEvent.click(rowByKey('b'))

    expect(screen.getByTestId('trigger-manager-overview-name').textContent).toBe('Beta')
  })

  it('pauses through setPaused instead of touching the config', async () => {
    const harness = renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    fireEvent.click(within(rowByKey('b')).getByTestId('trigger-manager-row-toggle'))

    expect(harness.setPaused).toHaveBeenCalledWith('b', true)
    expect(harness.setAllPaused).not.toHaveBeenCalled()
  })

  it('resumes a paused trigger through setPaused', async () => {
    const harness = renderEditor({
      summaries: [summary({ id: 'a', paused: true, status: 'paused' })],
    })
    await screen.findAllByTestId('trigger-manager-row')

    fireEvent.click(within(rowByKey('a')).getByTestId('trigger-manager-row-toggle'))

    expect(harness.setPaused).toHaveBeenCalledWith('a', false)
  })

  it('disables the row toggle while every trigger is paused', async () => {
    renderEditor({
      summaries: [summary({ id: 'a', paused: true, pausedAll: true, status: 'paused' })],
    })
    await screen.findAllByTestId('trigger-manager-row')

    const toggle = within(rowByKey('a')).getByTestId('trigger-manager-row-toggle')
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('trigger-manager-paused-all-banner')).toBeDefined()
  })

  it('pauses and resumes all triggers from the toolbar', async () => {
    const harness = renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    fireEvent.click(screen.getByTestId('trigger-manager-pause-all'))
    expect(harness.setAllPaused).toHaveBeenCalledWith(true)
  })

  it('disposes the trigger subscription when unmounted', async () => {
    const harness = renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    harness.view.unmount()

    expect(harness.subscriptionDispose).toHaveBeenCalledTimes(1)
  })

  it('applies the list pushed by the change event', async () => {
    const harness = renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    harness.fireChange([summary({ id: 'c', name: 'Gamma', workspaceName: 'gamma' })])

    expect(screen.getAllByTestId('trigger-manager-row')).toHaveLength(1)
    expect(rowByKey('c')).toBeDefined()
  })

  it('honours the pending selection carried by the editor input', async () => {
    renderEditor({ summaries: TWO_WORKSPACES, inputOptions: { pendingSelection: 'b' } })
    await screen.findAllByTestId('trigger-manager-row')

    expect(screen.getByTestId('trigger-manager-overview-name').textContent).toBe('Beta')
  })

  it('switches selection when a duplicate open transfers a pending key', async () => {
    const harness = renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    act(() => {
      harness.input.updateFrom(new TriggerManagerEditorInput({ pendingSelection: 'b' }))
    })

    expect(screen.getByTestId('trigger-manager-overview-name').textContent).toBe('Beta')
  })

  it('switches between the overview, configuration and run-history tabs', async () => {
    renderEditor({ summaries: TWO_WORKSPACES })
    await screen.findAllByTestId('trigger-manager-row')

    fireEvent.click(screen.getByTestId('trigger-manager-tab-configuration'))
    expect(await screen.findByTestId('trigger-manager-config-readonly')).toBeDefined()

    fireEvent.click(screen.getByTestId('trigger-manager-tab-runs'))
    expect(await screen.findByTestId('trigger-manager-runs-empty')).toBeDefined()

    fireEvent.click(screen.getByTestId('trigger-manager-tab-overview'))
    expect(screen.getByTestId('trigger-manager-overview')).toBeDefined()
  })

  it('creates a trigger through the wizard and selects it when the list refreshes', async () => {
    const harness = renderEditor({ summaries: [summary({ id: 'alpha', name: 'Alpha' })] })
    await screen.findAllByTestId('trigger-manager-row')

    fireEvent.click(screen.getByTestId('trigger-manager-create'))
    await screen.findByTestId('trigger-manager-wizard')

    fireEvent.click(screen.getByTestId('trigger-manager-wizard-next'))
    fireEvent.change(screen.getByTestId('trigger-manager-wizard-id'), {
      target: { value: 'beta' },
    })
    fireEvent.change(screen.getByTestId('trigger-manager-wizard-name'), {
      target: { value: 'Beta' },
    })
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-next'))
    fireEvent.change(screen.getByTestId('trigger-manager-wizard-prompt'), {
      target: { value: 'Do beta things' },
    })
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-next'))
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-create'))

    await waitFor(() => expect(screen.queryByTestId('trigger-manager-wizard')).toBeNull())
    harness.fireChange([
      summary({ id: 'alpha', name: 'Alpha' }),
      summary({ id: 'beta', name: 'Beta' }),
    ])

    await waitFor(() =>
      expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
        'Beta',
      ),
    )
  })

  it('shows the confirmation banner and the empty state', async () => {
    renderEditor({ summaries: [] })
    await screen.findByTestId('trigger-manager-empty')
    expect(screen.queryByTestId('trigger-manager-pending-banner')).toBeNull()

    cleanup()
    renderEditor({
      summaries: [summary({ id: 'a', activationConfirmed: false, status: 'needs-confirmation' })],
    })
    await screen.findByTestId('trigger-manager-pending-banner')
  })
})
