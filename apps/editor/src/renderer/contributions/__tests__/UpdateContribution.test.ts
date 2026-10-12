/*---------------------------------------------------------------------------------------------
 *  Tests for UpdateContribution — the notification / status-bar policy around an
 *  important update: the unattended download must not raise a prompt whose primary
 *  action is already obsolete, but the user must never be left without a way to get
 *  the fix (a failed auto-download falls back to the prompt).
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, Severity } from '@universe-editor/platform'
import { UpdateContribution } from '../UpdateContribution.js'
import type { IUpdateService, UpdateState } from '../../../shared/ipc/updateService.js'

interface StatusEntry {
  text: string
  tooltip?: string
  kind?: string
  command?: string
}

function setup(initial: UpdateState = { type: 'idle', currentVersion: '1.0.0' }) {
  const emitter = new Emitter<UpdateState>()
  const notify = vi.fn()
  const addEntry = vi.fn((_entry: StatusEntry) => ({
    update: vi.fn(),
    dispose: vi.fn(),
  }))

  const update: IUpdateService = {
    _serviceBrand: undefined,
    onDidChangeState: emitter.event,
    getState: async () => initial,
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    quitAndInstall: vi.fn(async () => {}),
  }

  const contribution = new UpdateContribution(update, { notify } as never, { addEntry } as never)

  return {
    emitter,
    notify,
    addEntry,
    contribution,
    dispose: () => {
      contribution.dispose()
      emitter.dispose()
    },
  }
}

const available = (extra: Partial<UpdateState> = {}): UpdateState =>
  ({
    type: 'available',
    currentVersion: '1.0.0',
    version: '2.0.0',
    explicit: false,
    ...extra,
  }) as UpdateState

describe('UpdateContribution', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    ctx = setup()
  })

  it('prompts on a normal update and shows a non-prominent status entry', () => {
    ctx.emitter.fire(available())

    expect(ctx.notify).toHaveBeenCalledOnce()
    expect(ctx.notify.mock.calls[0]?.[0]).toMatchObject({ severity: Severity.Info })
    expect(ctx.addEntry.mock.calls[0]?.[0]).toMatchObject({ kind: 'default' })
  })

  it('warns instead of informing when the update is important', () => {
    ctx.emitter.fire(available({ urgency: 'important' }))

    expect(ctx.notify.mock.calls[0]?.[0]).toMatchObject({ severity: Severity.Warning })
    expect(ctx.addEntry.mock.calls[0]?.[0]?.text).toContain('Important')
  })

  it('stays silent while downloading an important update unattended', () => {
    ctx.emitter.fire(available({ urgency: 'important', autoDownload: true }))

    // The download is already running — a Download/Later prompt would be dead on arrival.
    expect(ctx.notify).not.toHaveBeenCalled()
    expect(ctx.addEntry.mock.calls[0]?.[0]?.text).toContain('Important')
  })

  it('prompts anyway when main decided not to auto-download (manual / none mode)', () => {
    ctx.emitter.fire(available({ urgency: 'important' }))

    expect(ctx.notify).toHaveBeenCalledOnce()
  })

  it('prompts after a failed unattended download republishes available', () => {
    ctx.emitter.fire(available({ urgency: 'important', autoDownload: true }))
    expect(ctx.notify).not.toHaveBeenCalled()

    // Main falls back to `available` with the flag cleared — now the user needs a button.
    ctx.emitter.fire(available({ urgency: 'important' }))

    expect(ctx.notify).toHaveBeenCalledOnce()
    expect(ctx.notify.mock.calls[0]?.[0]).toMatchObject({ severity: Severity.Warning })
  })

  it('shows a status entry while an important download runs, and hides a normal one', () => {
    ctx.emitter.fire(available({ urgency: 'important', autoDownload: true }))
    const entry = ctx.addEntry.mock.results[0]?.value

    ctx.emitter.fire({
      type: 'downloading',
      currentVersion: '1.0.0',
      version: '2.0.0',
      percent: 10,
      urgency: 'important',
    })
    expect(entry.update).toHaveBeenCalled()
    expect(entry.dispose).not.toHaveBeenCalled()

    ctx.emitter.fire({
      type: 'downloading',
      currentVersion: '1.0.0',
      version: '2.0.0',
      percent: 20,
    })
    // A normal download is already visible in the title bar — no status-bar noise.
    expect(entry.dispose).toHaveBeenCalled()
  })

  it('makes the restart prompt prominent and sticky for an important update', () => {
    ctx.emitter.fire({
      type: 'downloaded',
      currentVersion: '1.0.0',
      version: '2.0.0',
      urgency: 'important',
    })

    expect(ctx.notify.mock.calls[0]?.[0]).toMatchObject({
      severity: Severity.Warning,
      sticky: true,
    })
    expect(ctx.addEntry.mock.calls[0]?.[0]).toMatchObject({ kind: 'prominent' })
  })

  it('keeps the ordinary restart prompt quiet for a normal update', () => {
    ctx.emitter.fire({ type: 'downloaded', currentVersion: '1.0.0', version: '2.0.0' })

    expect(ctx.notify.mock.calls[0]?.[0]).toMatchObject({ severity: Severity.Info, sticky: true })
    expect(ctx.addEntry.mock.calls[0]?.[0]).toMatchObject({ kind: 'prominent' })
  })

  it('does not announce a quiet (background) check result', () => {
    ctx.emitter.fire({ type: 'idle', currentVersion: '1.0.0', notAvailable: true, explicit: false })

    expect(ctx.notify).not.toHaveBeenCalled()
  })
})
