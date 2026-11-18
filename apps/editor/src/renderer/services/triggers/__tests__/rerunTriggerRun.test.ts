/*---------------------------------------------------------------------------------------------
 *  Tests for re-running a finished trigger run from its saved event.json.
 *--------------------------------------------------------------------------------------------*/

import {
  Severity,
  type IFileService,
  type ILogger,
  type INotificationService,
} from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import type { ITriggerMainService } from '../../../../shared/ipc/triggerService.js'
import type { TriggerRunHistoryEntry } from '../../../../shared/triggers/types.js'
import { rerunTriggerRun, type RerunTriggerServices } from '../rerunTriggerRun.js'

const VALID_EVENT = '{"version":1,"eventKey":"event:1","payload":{"title":"Bug","count":2}}'

function entry(overrides: Partial<TriggerRunHistoryEntry> = {}): TriggerRunHistoryEntry {
  return {
    runId: 'run-1',
    triggerKey: 'file:///X%3A/workspace\u0000triage',
    triggerId: 'triage',
    triggerName: 'Triage',
    workspace: 'file:///X%3A/workspace',
    workspaceName: 'workspace',
    runDir: '/userData/triggers/runs/run-1',
    startedAt: 1_000,
    endedAt: 2_000,
    outcome: 'completed',
    ...overrides,
  }
}

function entryWithoutRunDir(): TriggerRunHistoryEntry {
  const { runDir: _runDir, ...rest } = entry()
  return rest
}

interface Harness {
  readonly services: RerunTriggerServices
  readonly getRun: ReturnType<typeof vi.fn>
  readonly runNow: ReturnType<typeof vi.fn>
  readonly stat: ReturnType<typeof vi.fn>
  readonly readFileText: ReturnType<typeof vi.fn>
  readonly notify: ReturnType<typeof vi.fn>
}

function makeHarness(
  options: {
    entry?: TriggerRunHistoryEntry | undefined
    eventText?: string
    statSize?: number
    readError?: Error
    statError?: Error
    runNowError?: Error
  } = {},
): Harness {
  const runNow = vi.fn(async () => {
    if (options.runNowError !== undefined) throw options.runNowError
  })
  const getRun = vi.fn(async () => ('entry' in options ? options.entry : entry()))
  const stat = vi.fn(async () => {
    if (options.statError !== undefined) throw options.statError
    return { isFile: true, size: options.statSize ?? 100 }
  })
  const readFileText = vi.fn(async () => {
    if (options.readError !== undefined) throw options.readError
    return options.eventText ?? VALID_EVENT
  })
  const notify = vi.fn()
  const logger = { warn: vi.fn() } as unknown as ILogger
  return {
    services: {
      triggers: { getRun, runNow } as unknown as ITriggerMainService,
      files: { stat, readFileText } as unknown as IFileService,
      notifications: { notify } as unknown as INotificationService,
      logger,
    },
    getRun,
    runNow,
    stat,
    readFileText,
    notify,
  }
}

describe('rerunTriggerRun', () => {
  it('replays the saved payload as a manual event', async () => {
    const h = makeHarness()
    await rerunTriggerRun(h.services, 'run-1')

    const [uri] = h.readFileText.mock.calls[0] as [unknown]
    expect(String(uri)).toBe('file:///userData/triggers/runs/run-1/event.json')
    expect(h.runNow).toHaveBeenCalledWith(entry().triggerKey, {
      payload: { title: 'Bug', count: 2 },
    })
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Info }))
  })

  it('does not re-run a run that predates saved input', async () => {
    const h = makeHarness({ entry: entryWithoutRunDir() })
    await rerunTriggerRun(h.services, 'run-1')

    expect(h.stat).not.toHaveBeenCalled()
    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Info }))
  })

  it('does not re-run a run that left the history', async () => {
    const h = makeHarness({ entry: undefined })
    await rerunTriggerRun(h.services, 'missing')

    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Info }))
  })

  it('warns and stops when the saved event is unreadable', async () => {
    const h = makeHarness({ readError: new Error('ENOENT') })
    await rerunTriggerRun(h.services, 'run-1')

    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Warning }))
  })

  it('refuses oversized saved input before reading it', async () => {
    const h = makeHarness({ statSize: 2 * 1024 * 1024 })
    await rerunTriggerRun(h.services, 'run-1')

    expect(h.readFileText).not.toHaveBeenCalled()
    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Warning }))
  })

  it('rejects an unknown record version', async () => {
    const h = makeHarness({ eventText: '{"version":2,"payload":{"title":"Bug"}}' })
    await rerunTriggerRun(h.services, 'run-1')

    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Warning }))
  })

  it('rejects a record without an object payload', async () => {
    const h = makeHarness({ eventText: '{"version":1,"payload":null}' })
    await rerunTriggerRun(h.services, 'run-1')

    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Warning }))
  })

  it('reports a runNow failure', async () => {
    const h = makeHarness({ runNowError: new Error('all triggers are paused') })
    await rerunTriggerRun(h.services, 'run-1')

    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: Severity.Error }))
  })

  it('keeps only scalar payload fields and cannot pollute the prototype', async () => {
    // A real `__proto__` own property only survives as JSON text: an object
    // literal would set the prototype instead of creating the key.
    const h = makeHarness({
      eventText:
        '{"version":1,"payload":{"title":"Bug","count":2,"critical":false,"nested":{"nope":true},"list":[1,2],"__proto__":{"polluted":true}}}',
    })
    await rerunTriggerRun(h.services, 'run-1')

    const [, event] = h.runNow.mock.calls[0] as [string, { payload: Record<string, unknown> }]
    expect(event.payload).toEqual({ title: 'Bug', count: 2, critical: false })
    expect(Object.prototype.hasOwnProperty.call(event.payload, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(event.payload)).toBe(Object.prototype)
  })
})
