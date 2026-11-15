/*---------------------------------------------------------------------------------------------
 *  Tests for the create-trigger wizard: template prefill, step gating, id
 *  uniqueness/format validation, creating a new file and appending to an
 *  existing one, and the invalid-file guard.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  FileSystemError,
  IEditorGroupsService,
  IEditorService,
  IFileService,
  INotificationService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  Severity,
  URI,
  type IEditorGroup,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../../../shared/ipc/triggerService.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { triggersConfigUri } from '../../../services/triggers/triggerConfigFileService.js'
import { ServicesContext } from '../../useService.js'
import { TriggerCreateWizard } from '../TriggerCreateWizard.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const WORKSPACE = URI.file('X:/workspace')
const CONFIG_URI = triggersConfigUri(WORKSPACE)

class FakeFiles {
  readonly entries = new Map<string, { text: string; mtime: number }>()
  readonly directories: string[] = []
  readonly renames: { source: string; target: string }[] = []
  private clock = 100

  put(uri: URI, text: string): void {
    this.entries.set(uri.toString(), { text, mtime: ++this.clock })
  }

  get(uri: URI): { text: string; mtime: number } | undefined {
    return this.entries.get(uri.toString())
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

  async createDirectory(uri: URI): Promise<void> {
    this.directories.push(uri.toString())
  }

  async rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const entry = this.entries.get(source.toString())
    if (entry === undefined) throw new FileSystemError('not found', 'ENOENT')
    if (opts?.overwrite !== true && this.entries.has(target.toString())) {
      throw new FileSystemError('already exists', 'EEXIST')
    }
    this.entries.delete(source.toString())
    this.entries.set(target.toString(), { text: entry.text, mtime: ++this.clock })
    this.renames.push({ source: source.toString(), target: target.toString() })
  }

  async delete(uri: URI): Promise<void> {
    if (!this.entries.delete(uri.toString())) throw new FileSystemError('not found', 'ENOENT')
  }
}

interface Harness {
  readonly store: FakeFiles
  readonly onCreated: ReturnType<typeof vi.fn>
  readonly onClose: ReturnType<typeof vi.fn>
  readonly notify: ReturnType<typeof vi.fn>
  readonly ensureConfigFile: ReturnType<typeof vi.fn>
}

function renderWizard(
  options: { text?: string; dirtyEditor?: boolean; ensureFails?: boolean } = {},
): Harness {
  const store = new FakeFiles()
  if (options.text !== undefined) store.put(CONFIG_URI, options.text)
  const onCreated = vi.fn()
  const onClose = vi.fn()
  const notify = vi.fn()
  const openEditor = vi.fn()
  const ensureConfigFile = options.ensureFails
    ? vi.fn(async () => Promise.reject(new Error('register failed')))
    : vi.fn(async () => '')
  const groups: IEditorGroup[] = []
  if (options.dirtyEditor === true) {
    const input = new FileEditorInput(CONFIG_URI, store as unknown as IFileService)
    input.setDirty(true)
    groups.push({ editors: [input] } as unknown as IEditorGroup)
  }

  const services = new ServiceCollection()
  services.set(IFileService, store as unknown as IFileService)
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    ensureConfigFile,
    listWorkspaces: vi.fn(async () => [
      {
        workspace: WORKSPACE.toString(),
        name: 'workspace',
        configPath: CONFIG_URI.fsPath,
        available: true,
        triggerCount: 0,
      },
    ]),
  } as unknown as ITriggerMainService)
  services.set(INotificationService, { notify } as unknown as INotificationService)
  services.set(IWorkspaceService, {
    current: { folder: WORKSPACE },
  } as unknown as IWorkspaceService)
  services.set(IEditorGroupsService, { groups } as unknown as IEditorGroupsService)
  services.set(IUriIdentityService, {
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  } as unknown as IUriIdentityService)
  services.set(IEditorService, { openEditor } as unknown as IEditorService)

  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <TriggerCreateWizard onClose={onClose} onCreated={onCreated} />
    </ServicesContext.Provider>,
  )

  return { store, onCreated, onClose, notify, ensureConfigFile }
}

function goToBasics(): void {
  fireEvent.click(screen.getByTestId('trigger-manager-wizard-next'))
}

function fillBasics(id: string, name: string): void {
  fireEvent.change(screen.getByTestId('trigger-manager-wizard-id'), { target: { value: id } })
  fireEvent.change(screen.getByTestId('trigger-manager-wizard-name'), {
    target: { value: name },
  })
}

function goToSource(): void {
  fireEvent.click(screen.getByTestId('trigger-manager-wizard-next'))
}

function goToSession(): void {
  fireEvent.click(screen.getByTestId('trigger-manager-wizard-next'))
}

function goToLimits(prompt: string): void {
  fireEvent.change(screen.getByTestId('trigger-manager-wizard-prompt'), {
    target: { value: prompt },
  })
  fireEvent.click(screen.getByTestId('trigger-manager-wizard-next'))
}

describe('TriggerCreateWizard', () => {
  it('walks the template → basics → source → session → limits steps', async () => {
    renderWizard()
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    goToBasics()
    expect(screen.getByTestId('trigger-manager-wizard-body-1')).toBeDefined()
    expect((screen.getByTestId('trigger-manager-wizard-next') as HTMLButtonElement).disabled).toBe(
      true,
    )

    fillBasics('daily', 'Daily digest')
    expect((screen.getByTestId('trigger-manager-wizard-next') as HTMLButtonElement).disabled).toBe(
      false,
    )
    goToSource()
    expect(screen.getByTestId('trigger-manager-wizard-body-2')).toBeDefined()
    expect(screen.getByTestId('trigger-manager-wizard-source-type')).toBeDefined()

    goToSession()
    expect(screen.getByTestId('trigger-manager-wizard-body-3')).toBeDefined()

    goToLimits('Summarize the day')
    expect(screen.getByTestId('trigger-manager-wizard-body-4')).toBeDefined()
    expect(screen.getByTestId('trigger-manager-wizard-create')).toBeDefined()
  })

  it('prefills a skill template and links to its guide', async () => {
    const harness = renderWizard()
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    fireEvent.click(screen.getByTestId('trigger-manager-wizard-template-skill-biweekly-report'))
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-template-docs-biweekly-report'))
    expect(harness.onClose).not.toHaveBeenCalled()

    goToBasics()
    fillBasics('biweekly', 'Biweekly report')
    goToSource()
    expect((screen.getByTestId('trigger-manager-wizard-cron') as HTMLInputElement).value).toBe(
      '0 10 1,15 * *',
    )
    goToSession()
    expect((screen.getByTestId('trigger-manager-wizard-skill') as HTMLInputElement).value).toBe(
      'biweekly-report',
    )
    expect(
      (screen.getByTestId('trigger-manager-wizard-prompt') as HTMLTextAreaElement).value,
    ).toContain('双周报')
    goToLimits('whatever')
    expect((screen.getByTestId('trigger-manager-wizard-max-cost') as HTMLInputElement).value).toBe(
      '2',
    )
  })

  it('writes through a temporary file and atomically renames it into place', async () => {
    const harness = renderWizard({ text: '{ "version": 1, "triggers": [] }' })
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    goToBasics()
    fillBasics('daily', 'Daily digest')
    goToSource()
    goToSession()
    goToLimits('Summarize the day')
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-create'))

    await waitFor(() => expect(harness.onCreated).toHaveBeenCalledTimes(1))
    expect(harness.store.renames).toHaveLength(1)
    expect(harness.store.renames[0]?.target).toBe(CONFIG_URI.toString())
    expect(harness.store.renames[0]?.source).toContain('.tmp-')
    expect(harness.store.entries.has(harness.store.renames[0]?.source ?? '')).toBe(false)
  })

  it('creates a new triggers.json with the empty config header and the new trigger', async () => {
    const harness = renderWizard()
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    goToBasics()
    fillBasics('daily', 'Daily digest')
    goToSource()
    goToSession()
    goToLimits('Summarize the day')
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-create'))

    await waitFor(() => expect(harness.onCreated).toHaveBeenCalledTimes(1))
    expect(harness.onCreated).toHaveBeenCalledWith(WORKSPACE, 'daily')
    expect(harness.onClose).toHaveBeenCalledTimes(1)
    expect(harness.notify).toHaveBeenCalledTimes(1)
    expect(harness.store.directories).toHaveLength(1)
    const text = harness.store.get(CONFIG_URI)?.text ?? ''
    expect(text).toContain('// Agent 触发器配置')
    expect(text).toContain('"daily"')
    expect(text).toContain('"prompt": "Summarize the day"')
  })

  it('applies the poll template to the created definition', async () => {
    const harness = renderWizard()
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    fireEvent.click(screen.getByTestId('trigger-manager-wizard-template-poll'))
    goToBasics()
    fillBasics('reqs', 'Requisition poll')
    goToSource()
    goToSession()
    goToLimits('Handle new requisitions')
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-create'))

    await waitFor(() => expect(harness.onCreated).toHaveBeenCalledTimes(1))
    const text = harness.store.get(CONFIG_URI)?.text ?? ''
    expect(text).toContain('"type": "poll"')
    expect(text).toContain('"intervalSec": 600')
    expect(text).toContain('"keyField": "id"')
  })

  it('prefills the Swarm event source from the Swarm template', async () => {
    const harness = renderWizard()
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    fireEvent.click(screen.getByTestId('trigger-manager-wizard-template-swarm'))
    goToBasics()
    fillBasics('triage', 'Triage')
    goToSource()
    goToSession()
    goToLimits('Triage the review')

    fireEvent.click(screen.getByTestId('trigger-manager-wizard-create'))
    await waitFor(() => expect(harness.onCreated).toHaveBeenCalledTimes(1))
    const text = harness.store.get(CONFIG_URI)?.text ?? ''
    expect(text).toContain('"type": "event"')
    expect(text).toContain('"event": "swarm.reviewNeedsAction"')
  })

  it('rejects an invalid id format and a duplicate id', async () => {
    renderWizard({
      text: '{ "triggers": [ { "id": "taken", "source": { "type": "manual" } } ] }',
    })
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())
    goToBasics()
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-id')).toBeDefined())

    fireEvent.change(screen.getByTestId('trigger-manager-wizard-id'), {
      target: { value: 'Bad ID' },
    })
    expect(screen.getByText(/lowercase letters/)).toBeDefined()

    fireEvent.change(screen.getByTestId('trigger-manager-wizard-id'), {
      target: { value: 'taken' },
    })
    await waitFor(() =>
      expect(screen.getByText(/already has a trigger with that ID/)).toBeDefined(),
    )
    expect((screen.getByTestId('trigger-manager-wizard-next') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('refuses to extend a malformed triggers.json', async () => {
    renderWizard({ text: '{ not json' })
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())
    goToBasics()

    await waitFor(() =>
      expect(screen.getByTestId('trigger-manager-wizard-file-error')).toBeDefined(),
    )
    fillBasics('daily', 'Daily digest')
    expect((screen.getByTestId('trigger-manager-wizard-next') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('refuses to write while the JSON editor has unsaved changes', async () => {
    const harness = renderWizard({ dirtyEditor: true })
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    goToBasics()
    fillBasics('daily', 'Daily digest')
    goToSource()
    goToSession()
    goToLimits('Summarize the day')
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-create'))

    await waitFor(() =>
      expect(screen.getByTestId('trigger-manager-wizard-error').textContent).toContain(
        'unsaved changes',
      ),
    )
    expect(harness.store.get(CONFIG_URI)).toBeUndefined()
    expect(harness.onCreated).not.toHaveBeenCalled()
    expect(harness.onClose).not.toHaveBeenCalled()
  })

  it('warns with a recovery step when the workspace cannot register the new file', async () => {
    const harness = renderWizard({ ensureFails: true })
    await waitFor(() => expect(screen.getByTestId('trigger-manager-wizard-body-0')).toBeDefined())

    goToBasics()
    fillBasics('daily', 'Daily digest')
    goToSource()
    goToSession()
    goToLimits('Summarize the day')
    fireEvent.click(screen.getByTestId('trigger-manager-wizard-create'))

    await waitFor(() => expect(harness.onCreated).toHaveBeenCalledTimes(1))
    expect(harness.ensureConfigFile).toHaveBeenCalledWith(WORKSPACE.toString())
    expect(harness.notify).toHaveBeenCalledTimes(2)
    expect(harness.notify.mock.calls[0]?.[0]).toMatchObject({
      severity: Severity.Warning,
      message: expect.stringContaining('Reopen the workspace'),
    })
    expect(harness.notify.mock.calls[1]?.[0]).toMatchObject({ severity: Severity.Info })
  })

  it('shows a message when no workspace is available', async () => {
    servicesWithoutWorkspace()
    goToBasics()
    await waitFor(() =>
      expect(screen.getByTestId('trigger-manager-wizard-no-workspace')).toBeDefined(),
    )
  })
})

function servicesWithoutWorkspace(): void {
  cleanup()
  const services = new ServiceCollection()
  services.set(IFileService, new FakeFiles() as unknown as IFileService)
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    ensureConfigFile: vi.fn(async () => ''),
    listWorkspaces: vi.fn(async () => []),
  } as unknown as ITriggerMainService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(IWorkspaceService, { current: null } as unknown as IWorkspaceService)
  services.set(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService)
  services.set(IUriIdentityService, {
    isEqual: () => false,
  } as unknown as IUriIdentityService)
  services.set(IEditorService, { openEditor: vi.fn() } as unknown as IEditorService)
  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <TriggerCreateWizard onClose={vi.fn()} onCreated={vi.fn()} />
    </ServicesContext.Provider>,
  )
}
