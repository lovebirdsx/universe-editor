/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The sync-history CSV export action: it must export the WHOLE history (not the
 *  page's current slice), and a cancelled save must leave no trace. The file
 *  write itself is the platform's; what is asserted here is the chain — which
 *  `max` it asks for, what lands in the file, and what the user is told.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ICommandService,
  IFileDialogService,
  IFileService,
  INotificationService,
  InstantiationService,
  IWorkspaceService,
  ServiceCollection,
  Severity,
  URI,
} from '@universe-editor/platform'
import { PerforceSyncHistoryCommands, type P4SyncRunDto } from '@universe-editor/extensions-common'
import { ExportPerforceSyncHistoryAction } from '../perforceSyncHistoryActions.js'

const ROOT = 'X:/p4ws/main'

function makeRun(id: string): P4SyncRunDto {
  return {
    id,
    at: Date.UTC(2026, 9, 10, 3, 35, 22),
    startedAt: Date.UTC(2026, 9, 10, 3, 32, 29),
    durationMs: 1000,
    clientRoot: ROOT,
    spec: '#head',
    force: false,
    trigger: 'explorer',
    outcome: 'applied',
    engine: 'p4',
    engineFallback: false,
    parallelThreads: 0,
    counts: {
      applied: 1,
      refusedModified: 0,
      refusedOverwrite: 0,
      keptOpen: 0,
      mustResolve: 0,
      handoff: 0,
    },
    io: { readBytes: 10, writeBytes: 20 },
    diskWrites: 1,
    scopeNarrowed: false,
    scopeFirst: [{ path: `${ROOT}/src`, isDirectory: true }],
    scopeCount: 1,
  }
}

interface Harness {
  /** The `max` each `getRuns` call asked for, in call order. */
  readonly askedMax: unknown[]
  readonly showSaveDialog: ReturnType<typeof vi.fn>
  readonly writeFile: ReturnType<typeof vi.fn>
  readonly notify: ReturnType<typeof vi.fn>
}

async function runExport(options: {
  runs?: readonly P4SyncRunDto[] | undefined
  saveAs?: URI | undefined
  writeError?: Error
  noWorkspace?: boolean
}): Promise<Harness> {
  const askedMax: unknown[] = []
  const executeCommand = vi.fn(async (id: string, arg?: { max?: number }) => {
    if (id !== PerforceSyncHistoryCommands.getRuns) return undefined
    askedMax.push(arg?.max)
    if (options.runs === undefined) return undefined
    return { runs: options.runs, total: options.runs.length, hasMore: false }
  })
  const showSaveDialog = vi.fn().mockResolvedValue(options.saveAs)
  const writeFile = options.writeError
    ? vi.fn().mockRejectedValue(options.writeError)
    : vi.fn().mockResolvedValue(undefined)
  const notify = vi.fn()

  const services = new ServiceCollection(
    [ICommandService, { _serviceBrand: undefined, executeCommand } as never],
    [
      IFileDialogService,
      { _serviceBrand: undefined, showSaveDialog, showOpenDialog: vi.fn() } as never,
    ],
    [IFileService, { _serviceBrand: undefined, writeFile } as never],
    [INotificationService, { _serviceBrand: undefined, notify } as never],
    [
      IWorkspaceService,
      {
        _serviceBrand: undefined,
        current: options.noWorkspace ? null : { folder: URI.file('X:/p4ws/main'), name: 'main' },
      } as never,
    ],
  )

  const inst = new InstantiationService(services)
  try {
    await inst.invokeFunction((accessor) => new ExportPerforceSyncHistoryAction().run(accessor))
  } finally {
    inst.dispose()
  }
  return { askedMax, showSaveDialog, writeFile, notify }
}

describe('ExportPerforceSyncHistoryAction', () => {
  it('exports the whole history, not the page slice, and says where it landed', async () => {
    const target = URI.file('X:/exports/runs.csv')
    const harness = await runExport({
      runs: [makeRun('run-1'), makeRun('run-2')],
      saveAs: target,
    })

    expect(harness.askedMax).toEqual([200])
    expect(harness.writeFile).toHaveBeenCalledTimes(1)
    const [uri, content] = harness.writeFile.mock.calls[0] as [URI, string]
    expect(uri.toString()).toBe(target.toString())
    expect(content.startsWith('\uFEFF')).toBe(true)
    expect(content.split('\r\n').filter((line) => line !== '')).toHaveLength(3)
    expect(harness.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: Severity.Info,
        message: expect.stringContaining('runs.csv'),
      }),
    )
  })

  it('offers the workspace folder and the fixed file name as the default target', async () => {
    const harness = await runExport({
      runs: [makeRun('run-1')],
      saveAs: URI.file('X:/exports/runs.csv'),
    })

    expect(harness.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultUri: URI.joinPath(URI.file('X:/p4ws/main'), 'perforce-sync-history.csv'),
      }),
    )
  })

  it('writes nothing and says nothing when the save dialog is cancelled', async () => {
    const harness = await runExport({ runs: [makeRun('run-1')], saveAs: undefined })

    expect(harness.writeFile).not.toHaveBeenCalled()
    expect(harness.notify).not.toHaveBeenCalled()
  })

  it('reports a failed write as an error, with no success notice', async () => {
    const harness = await runExport({
      runs: [makeRun('run-1')],
      saveAs: URI.file('X:/exports/runs.csv'),
      writeError: new Error('disk full'),
    })

    expect(harness.notify).toHaveBeenCalledTimes(1)
    expect(harness.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: Severity.Error,
        message: expect.stringContaining('disk full'),
      }),
    )
  })

  it('says the extension is missing when the command is not registered', async () => {
    const harness = await runExport({ runs: undefined })

    expect(harness.showSaveDialog).not.toHaveBeenCalled()
    expect(harness.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: Severity.Error }),
    )
  })

  it('omits the default target when no folder is open', async () => {
    const harness = await runExport({
      runs: [makeRun('run-1')],
      saveAs: URI.file('X:/exports/runs.csv'),
      noWorkspace: true,
    })

    expect(harness.showSaveDialog).toHaveBeenCalledTimes(1)
    const options = harness.showSaveDialog.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).not.toHaveProperty('defaultUri')
  })
})
