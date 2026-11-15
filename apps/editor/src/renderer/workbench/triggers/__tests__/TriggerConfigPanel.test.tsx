/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger configuration form: field mapping, dirty tracking,
 *  minimal JSONC save with confirmation, validation errors, JSON-editor dirty
 *  refusal and external-change handling.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  Emitter,
  FileSystemError,
  IDialogService,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  INotificationService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IEditorGroup,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../../../shared/ipc/triggerService.js'
import type { TriggerSummary } from '../../../../shared/triggers/types.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { triggersConfigUri } from '../../../services/triggers/triggerConfigFileService.js'
import { ServicesContext } from '../../useService.js'
import { TriggerConfigPanel } from '../TriggerConfigPanel.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const WORKSPACE = URI.file('X:/workspace')
const CONFIG_URI = triggersConfigUri(WORKSPACE)

const CONFIG_TEXT = `// Header comment.
{
  "version": 1,
  "triggers": [
    {
      "id": "alpha",
      "name": "Alpha", // inline comment
      "enabled": false,
      "source": { "type": "manual" },
      "session": {
        "agent": "claude-code",
        "prompt": "Do it",
        "budget": { "maxCostUsd": 1, "timeoutMin": 30, "approvalTimeoutMin": 1440 }
      }
    }
  ]
}
`

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  return {
    key: 'alpha',
    id: 'alpha',
    fingerprint: 'fp-alpha',
    name: 'Alpha',
    workspace: WORKSPACE.toString(),
    workspaceName: 'workspace',
    sourceType: 'manual',
    source: { type: 'manual' },
    status: 'idle',
    enabled: false,
    paused: false,
    pausedAll: false,
    autoPaused: false,
    activationConfirmed: true,
    elevatedMode: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

class FakeFiles {
  readonly entries = new Map<string, { text: string; mtime: number }>()
  private clock = 100
  readonly writes: string[] = []
  reads = 0
  readFails = false

  put(uri: URI, text: string): void {
    this.entries.set(uri.toString(), { text, mtime: ++this.clock })
  }

  get(uri: URI): { text: string; mtime: number } | undefined {
    return this.entries.get(uri.toString())
  }

  async readFileText(uri: URI): Promise<string> {
    this.reads += 1
    if (this.readFails) throw new Error('disk unavailable')
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
    this.writes.push(uri.toString())
    this.entries.set(uri.toString(), { text, mtime: ++this.clock })
  }

  async exists(uri: URI): Promise<boolean> {
    return this.entries.has(uri.toString())
  }

  async createDirectory(): Promise<void> {}

  async rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const entry = this.entries.get(source.toString())
    if (entry === undefined) throw new FileSystemError('not found', 'ENOENT')
    if (opts?.overwrite !== true && this.entries.has(target.toString())) {
      throw new FileSystemError('already exists', 'EEXIST')
    }
    this.entries.delete(source.toString())
    this.entries.set(target.toString(), { text: entry.text, mtime: ++this.clock })
  }

  async delete(uri: URI): Promise<void> {
    if (!this.entries.delete(uri.toString())) throw new FileSystemError('not found', 'ENOENT')
  }
}

interface Harness {
  readonly store: FakeFiles
  readonly confirm: ReturnType<typeof vi.fn>
  readonly editorGroups: { groups: IEditorGroup[] }
  readonly fireChange: (list?: readonly TriggerSummary[]) => void
  readonly configText: () => string
}

function renderPanel(
  options: {
    text?: string
    groupEditors?: IEditorGroup[]
    summary?: TriggerSummary
  } = {},
): Harness {
  const store = new FakeFiles()
  store.put(CONFIG_URI, options.text ?? CONFIG_TEXT)
  const changeEmitter = new Emitter<readonly TriggerSummary[]>()
  const confirm = vi.fn(async () => ({ confirmed: true, choice: 'primary' as const }))
  const editorGroups: { groups: IEditorGroup[] } = { groups: options.groupEditors ?? [] }
  const panelSummary = options.summary ?? summary()

  const services = new ServiceCollection()
  services.set(IFileService, store as unknown as IFileService)
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    onDidChangeTriggers: (listener: (list: readonly TriggerSummary[]) => void) =>
      changeEmitter.event(listener),
  } as unknown as ITriggerMainService)
  services.set(IEditorResolverService, {
    openEditor: vi.fn(async () => undefined),
    createEditorInput: vi.fn(
      () => new FileEditorInput(CONFIG_URI, store as unknown as IFileService),
    ),
  } as unknown as IEditorResolverService)
  services.set(IEditorService, {
    openEditor: vi.fn((input: unknown) => input),
  } as unknown as IEditorService)
  services.set(IEditorGroupsService, editorGroups as unknown as IEditorGroupsService)
  services.set(IUriIdentityService, {
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  } as unknown as IUriIdentityService)
  services.set(IDialogService, { confirm } as unknown as IDialogService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)

  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <TriggerConfigPanel summary={panelSummary} />
    </ServicesContext.Provider>,
  )

  return {
    store,
    confirm,
    editorGroups,
    configText: () => store.get(CONFIG_URI)?.text ?? '',
    fireChange: (list) =>
      act(() =>
        changeEmitter.fire(list ?? [summary({ fingerprint: 'fp-remote', name: 'Remote' })]),
      ),
  }
}

async function loaded(): Promise<void> {
  await screen.findByTestId('trigger-manager-config')
}

describe('TriggerConfigPanel', () => {
  it('maps the parsed trigger onto the form fields', async () => {
    renderPanel()
    await loaded()

    expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
      'Alpha',
    )
    expect(screen.getByTestId('trigger-manager-config-source-type').textContent).toContain('Manual')
    expect((screen.getByTestId('trigger-manager-config-prompt') as HTMLTextAreaElement).value).toBe(
      'Do it',
    )
    expect((screen.getByTestId('trigger-manager-config-agent') as HTMLInputElement).value).toBe(
      'claude-code',
    )
    expect((screen.getByTestId('trigger-manager-config-max-cost') as HTMLInputElement).value).toBe(
      '1',
    )
  })

  it('tracks dirty state and reverts local edits', async () => {
    const harness = renderPanel()
    await loaded()
    const name = screen.getByTestId('trigger-manager-config-name') as HTMLInputElement

    fireEvent.change(name, { target: { value: 'Changed' } })
    expect(screen.getByTestId('trigger-manager-config-dirty')).toBeDefined()
    expect(name.value).toBe('Changed')

    fireEvent.click(screen.getByTestId('trigger-manager-config-revert'))
    await waitFor(() => expect(name.value).toBe('Alpha'))
    expect(harness.confirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('trigger-manager-config-dirty')).toBeNull()
    expect(harness.configText()).toBe(CONFIG_TEXT)
  })

  it('saves only the changed field after the re-confirmation dialog', async () => {
    const harness = renderPanel()
    await loaded()

    fireEvent.change(screen.getByTestId('trigger-manager-config-name'), {
      target: { value: 'Alpha renamed' },
    })
    fireEvent.click(screen.getByTestId('trigger-manager-config-save'))

    await waitFor(() => expect(harness.store.writes).toHaveLength(1))
    expect(harness.confirm).toHaveBeenCalledTimes(1)
    expect(harness.configText()).toContain('"name": "Alpha renamed", // inline comment')
    expect(harness.configText()).toContain('// Header comment.')
    await screen.findByTestId('trigger-manager-config-status')
  })

  it('warns that rewriting the source drops comments inside it', async () => {
    const harness = renderPanel()
    await loaded()

    fireEvent.click(screen.getByTestId('trigger-manager-config-source-type'))
    fireEvent.click(screen.getByRole('option', { name: 'Event' }))
    fireEvent.click(screen.getByTestId('trigger-manager-config-save'))

    await waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(1))
    expect(harness.confirm.mock.calls[0]?.[0]).toMatchObject({
      detail: expect.stringContaining('comments'),
    })
  })

  it('shows the event name selector for an event source', async () => {
    const harness = renderPanel()
    await loaded()

    fireEvent.click(screen.getByTestId('trigger-manager-config-source-type'))
    fireEvent.click(screen.getByRole('option', { name: 'Event' }))
    expect(screen.getByTestId('trigger-manager-config-event')).toBeDefined()
    fireEvent.click(screen.getByTestId('trigger-manager-config-save'))

    await waitFor(() => expect(harness.store.writes).toHaveLength(1))
    expect(harness.configText()).toContain('"type": "event"')
    expect(harness.configText()).toContain('"event": "swarm.reviewNeedsAction"')
  })

  it('does not write when the JSON editor has unsaved changes', async () => {
    const input = new FileEditorInput(CONFIG_URI, new FakeFiles() as unknown as IFileService)
    input.setDirty(true)
    const group = { editors: [input] } as unknown as IEditorGroup
    const harness = renderPanel({ groupEditors: [group] })
    await loaded()

    fireEvent.change(screen.getByTestId('trigger-manager-config-name'), {
      target: { value: 'Changed' },
    })
    fireEvent.click(screen.getByTestId('trigger-manager-config-save'))

    await screen.findByTestId('trigger-manager-config-status')
    expect(harness.confirm).not.toHaveBeenCalled()
    expect(harness.store.writes).toHaveLength(0)
  })

  it('shows parser errors and disables saving when the draft is invalid', async () => {
    renderPanel()
    await loaded()

    fireEvent.change(screen.getByTestId('trigger-manager-config-prompt'), {
      target: { value: '' },
    })

    await screen.findByTestId('trigger-manager-config-errors')
    expect(screen.getByTestId('trigger-manager-config-errors').textContent).toContain('"session"')
    // The structured issue path highlights the offending field, not just the banner.
    expect(screen.getByTestId('trigger-manager-config-prompt').getAttribute('aria-invalid')).toBe(
      'true',
    )
    expect((screen.getByTestId('trigger-manager-config-save') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('reloads automatically when the definition fingerprint changes and the form is clean', async () => {
    const harness = renderPanel()
    await loaded()

    // Prompt changes do not change the summary name, so only the definition
    // fingerprint can tell the form that the file needs re-reading.
    harness.store.put(CONFIG_URI, CONFIG_TEXT.replace('"Do it"', '"Do it now"'))
    harness.fireChange([summary({ fingerprint: 'fp-remote', name: 'Alpha' })])

    await waitFor(() =>
      expect(
        (screen.getByTestId('trigger-manager-config-prompt') as HTMLTextAreaElement).value,
      ).toBe('Do it now'),
    )
    expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
      'Alpha',
    )
  })

  it('shows an external-change banner instead of discarding a dirty draft', async () => {
    const harness = renderPanel()
    await loaded()

    fireEvent.change(screen.getByTestId('trigger-manager-config-name'), {
      target: { value: 'Local' },
    })
    harness.store.put(CONFIG_URI, CONFIG_TEXT.replace('"name": "Alpha"', '"name": "Remote"'))
    harness.fireChange()

    await screen.findByTestId('trigger-manager-config-external-change')
    expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
      'Local',
    )

    fireEvent.click(screen.getByTestId('trigger-manager-config-external-keep'))
    expect(screen.queryByTestId('trigger-manager-config-external-change')).toBeNull()
    expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
      'Local',
    )

    harness.store.put(CONFIG_URI, CONFIG_TEXT.replace('"name": "Alpha"', '"name": "Remote 2"'))
    harness.fireChange([summary({ fingerprint: 'fp-remote-2', name: 'Remote 2' })])
    await screen.findByTestId('trigger-manager-config-external-change')
    fireEvent.click(screen.getByTestId('trigger-manager-config-external-reload'))

    await waitFor(() =>
      expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
        'Remote 2',
      ),
    )
    expect(harness.confirm).toHaveBeenCalledTimes(1)
  })

  it('saves kept local edits on top of an external change to another field', async () => {
    const harness = renderPanel()
    await loaded()

    fireEvent.change(screen.getByTestId('trigger-manager-config-name'), {
      target: { value: 'Local' },
    })
    harness.store.put(CONFIG_URI, CONFIG_TEXT.replace('"Do it"', '"Do it now"'))
    harness.fireChange()
    await screen.findByTestId('trigger-manager-config-external-change')

    fireEvent.click(screen.getByTestId('trigger-manager-config-external-keep'))
    fireEvent.click(screen.getByTestId('trigger-manager-config-save'))

    await waitFor(() => expect(harness.store.writes).toHaveLength(1))
    expect(harness.confirm).toHaveBeenCalledTimes(1)
    expect(harness.configText()).toContain('"name": "Local", // inline comment')
    expect(harness.configText()).toContain('"prompt": "Do it now"')
    expect(harness.configText()).toContain('// Header comment.')
    expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
      'Local',
    )
  })

  it('asks before overwriting a field that changed on disk too', async () => {
    const harness = renderPanel()
    await loaded()

    fireEvent.change(screen.getByTestId('trigger-manager-config-name'), {
      target: { value: 'Local' },
    })
    harness.store.put(CONFIG_URI, CONFIG_TEXT.replace('"name": "Alpha"', '"name": "Remote"'))
    harness.fireChange()
    await screen.findByTestId('trigger-manager-config-external-change')

    fireEvent.click(screen.getByTestId('trigger-manager-config-external-keep'))
    fireEvent.click(screen.getByTestId('trigger-manager-config-save'))

    await waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(2))
    expect(harness.confirm.mock.calls[1]?.[0]).toMatchObject({
      message: expect.stringContaining('name'),
    })
    await waitFor(() => expect(harness.store.writes).toHaveLength(1))
    expect(harness.configText()).toContain('"name": "Local"')
  })

  it('leaves the file untouched when the overwrite choice is declined', async () => {
    const harness = renderPanel()
    harness.confirm
      .mockResolvedValueOnce({ confirmed: true, choice: 'primary' as const })
      .mockResolvedValueOnce({ confirmed: false, choice: 'cancel' as const })
    await loaded()

    fireEvent.change(screen.getByTestId('trigger-manager-config-name'), {
      target: { value: 'Local' },
    })
    harness.store.put(CONFIG_URI, CONFIG_TEXT.replace('"name": "Alpha"', '"name": "Remote"'))
    harness.fireChange()
    await screen.findByTestId('trigger-manager-config-external-change')

    fireEvent.click(screen.getByTestId('trigger-manager-config-external-keep'))
    fireEvent.click(screen.getByTestId('trigger-manager-config-save'))

    await waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(2))
    expect(harness.store.writes).toHaveLength(0)
    expect(screen.getByTestId('trigger-manager-config-external-change')).toBeDefined()
    expect(screen.getByTestId('trigger-manager-config-status').textContent).toContain('cancelled')
  })

  it('does not stat + read the file for run-status updates', async () => {
    const harness = renderPanel()
    await loaded()
    const reads = harness.store.reads

    harness.fireChange([
      summary({ running: 3, queued: 2, lastRunId: 'run-9', lastRunAt: Date.now() }),
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.store.reads).toBe(reads)
  })

  it('survives a failed automatic reload without replacing the form with an error', async () => {
    const harness = renderPanel()
    await loaded()

    harness.store.readFails = true
    harness.fireChange([summary({ fingerprint: 'fp-remote', name: 'Remote' })])

    await waitFor(() => expect(harness.store.reads).toBe(2))
    expect(screen.queryByTestId('trigger-manager-config-load-error')).toBeNull()
    expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
      'Alpha',
    )
  })

  it('skips automatic reloads while the workspace is offline', async () => {
    const harness = renderPanel({ summary: summary({ offline: true }) })
    await loaded()
    const reads = harness.store.reads

    harness.fireChange([summary({ offline: true, fingerprint: 'fp-remote', name: 'Remote' })])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.store.reads).toBe(reads)
    expect((screen.getByTestId('trigger-manager-config-name') as HTMLInputElement).value).toBe(
      'Alpha',
    )
  })

  it('is read-only when the document root is not a valid trigger config', async () => {
    renderPanel({ text: '[]' })
    await screen.findByTestId('trigger-manager-config-readonly')
    expect(screen.getByTestId('trigger-manager-config-readonly').textContent).toContain(
      'cannot be parsed',
    )
  })

  it('reports the line and column of a JSON syntax error', async () => {
    renderPanel({ text: '{\n  \"triggers": [\n}\n' })
    await screen.findByTestId('trigger-manager-config-readonly')
    expect(screen.getByTestId('trigger-manager-config-readonly').textContent).toMatch(
      /line \d+, column \d+/,
    )
  })

  it('localizes document shape errors by code', async () => {
    renderPanel({ text: '{ "version": 2 }' })
    await screen.findByTestId('trigger-manager-config-readonly')
    const text = screen.getByTestId('trigger-manager-config-readonly').textContent ?? ''
    expect(text).toContain('configuration version must be 1')
    expect(text).not.toContain('"version" must be 1')
  })

  it('is read-only and lists errors for an invalid trigger entry', async () => {
    renderPanel({
      text: '{ "triggers": [ { "id": "alpha", "source": { "type": "nope" } } ] }',
    })
    await screen.findByTestId('trigger-manager-config-readonly')
    expect(screen.getByTestId('trigger-manager-config-readonly').textContent).toContain(
      'source.type',
    )
  })
})
