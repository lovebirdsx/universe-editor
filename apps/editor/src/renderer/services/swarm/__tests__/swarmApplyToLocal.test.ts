/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  swarmApplyToLocal — shared flow regressions (guard, plan wording, checkbox
 *  persistence, outcome toasts, error surfacing).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type {
  ICommandService,
  IDialogService,
  INotificationService,
  IStorageService,
  IUriIdentityService,
  IWorkspaceService,
} from '@universe-editor/platform'
import type { SwarmReviewFileDto } from '@universe-editor/extensions-common'

const IN_WS: SwarmReviewFileDto = {
  status: 'M',
  path: 'src/editor/a.ts',
  depotFile: '//depot/src/editor/a.ts',
  baseRevision: '1',
  localPath: 'C:/workspace/src/editor/a.ts',
}

const OUTSIDE: SwarmReviewFileDto = {
  status: 'M',
  path: 'external/c.ts',
  depotFile: '//other/external/c.ts',
  baseRevision: '2',
  localPath: 'D:/outside/external/c.ts',
}

const UNMAPPED: SwarmReviewFileDto = {
  status: 'M',
  path: 'lib/d.ts',
  depotFile: '//depot/lib/d.ts',
  baseRevision: '3',
  localPath: null,
}

// The flow depends on the module-singleton swarmApplyStore (its attach binds
// the first storage it sees), so each test re-imports the whole chain fresh.
// Severity is a const enum (unusable as a value under isolatedModules) — the
// numeric literals below mirror it: Info = 0, Warning = 1, Error = 2.
async function freshModules() {
  vi.resetModules()
  const platform = await import('@universe-editor/platform')
  const apply = await import('../swarmApplyToLocal.js')
  const storeMod = await import('../swarmApplyStore.js')
  return {
    apply: apply.applySwarmReviewToLocal,
    store: storeMod.swarmApplyStore,
    URI: platform.URI,
    UriIdentityService: platform.UriIdentityService,
  }
}

interface Harness {
  commands: { executeCommand: ReturnType<typeof vi.fn> }
  dialog: { confirm: ReturnType<typeof vi.fn> }
  notifications: { notify: ReturnType<typeof vi.fn> }
  storage: IStorageService & { gets: ReturnType<typeof vi.fn> }
  onError: ReturnType<typeof vi.fn>
}

async function makeHarness(): Promise<{
  run: (input: Parameters<Awaited<ReturnType<typeof freshModules>>['apply']>[0]) => Promise<void>
  harness: Harness
  store: Awaited<ReturnType<typeof freshModules>>['store']
}> {
  const { apply, store, URI, UriIdentityService } = await freshModules()
  const storage: Harness['storage'] = {
    _serviceBrand: undefined,
    gets: vi.fn(async () => undefined),
    get: (...args) => storage.gets(...args),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    onDidChangeWorkspaceScope: { on: () => ({ dispose: () => {} }) } as never,
  }
  const harness: Harness = {
    commands: {
      executeCommand: vi.fn(async () => ({ applied: [], skipped: [], keptOpen: [] })),
    },
    dialog: {
      confirm: vi.fn(async () => ({ confirmed: false, choice: 'cancel' as const })),
    },
    notifications: { notify: vi.fn() },
    storage,
    onError: vi.fn(),
  }
  const uriIdentity = new UriIdentityService('win32') as unknown as IUriIdentityService
  const deps = {
    commands: harness.commands as unknown as ICommandService,
    dialog: harness.dialog as unknown as IDialogService,
    notifications: harness.notifications as unknown as INotificationService,
    storage: harness.storage,
    uriIdentity,
    workspaceService: {
      _serviceBrand: undefined,
      current: { folder: URI.file('C:/workspace') },
    } as unknown as IWorkspaceService,
    onError: harness.onError,
  }
  return {
    run: (input) => apply(input, deps),
    harness,
    store,
  }
}

describe('applySwarmReviewToLocal', () => {
  it('returns without any dialog/command when change or files are missing', async () => {
    const { run, harness } = await makeHarness()
    await run({ reviewId: '1001', change: '', files: [IN_WS] })
    await run({ reviewId: '1001', change: '2001', files: [] })
    expect(harness.dialog.confirm).not.toHaveBeenCalled()
    expect(harness.commands.executeCommand).not.toHaveBeenCalled()
    expect(harness.notifications.notify).not.toHaveBeenCalled()
  })

  it('reports the mismatch wording when every file is unmapped', async () => {
    const { run, harness } = await makeHarness()
    await run({ reviewId: '1001', change: '2001', files: [UNMAPPED] })
    expect(harness.dialog.confirm).not.toHaveBeenCalled()
    expect(harness.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('different stream/branch'),
      }),
    )
  })

  it('reports the nothing wording when mapped files are all outside the workspace', async () => {
    const { run, harness } = await makeHarness()
    await run({ reviewId: '1001', change: '2001', files: [OUTSIDE] })
    expect(harness.dialog.confirm).not.toHaveBeenCalled()
    expect(harness.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Nothing to apply'),
      }),
    )
  })

  it('does nothing on cancel and leaves the toggles untouched', async () => {
    const { run, harness, store } = await makeHarness()
    await run({ reviewId: '1001', change: '2001', files: [IN_WS] })
    expect(harness.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(harness.commands.executeCommand).not.toHaveBeenCalled()
    expect(store.includeOutside).toBe(false)
    expect(store.intoChangelist).toBe(true)
  })

  it('re-plans with the checkbox finals, sends them and persists the toggles', async () => {
    const { run, harness, store } = await makeHarness()
    harness.dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [true, false],
    })
    harness.commands.executeCommand.mockResolvedValueOnce({
      applied: ['//depot/src/editor/a.ts', '//other/external/c.ts'],
      skipped: [],
      keptOpen: [],
    })
    await run({ reviewId: '1001', change: '2001', files: [IN_WS, OUTSIDE] })
    expect(harness.commands.executeCommand).toHaveBeenCalledWith('perforce.swarm.applyToLocal', {
      change: '2001',
      depotFiles: ['//depot/src/editor/a.ts', '//other/external/c.ts'],
      intoChangelist: false,
    })
    expect(store.includeOutside).toBe(true)
    expect(store.intoChangelist).toBe(false)
  })

  it('toasts the applied-only outcome', async () => {
    const { run, harness } = await makeHarness()
    harness.dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, true],
    })
    harness.commands.executeCommand.mockResolvedValueOnce({
      applied: ['//depot/src/editor/a.ts'],
      skipped: [],
      keptOpen: [],
    })
    await run({ reviewId: '1001', change: '2001', files: [IN_WS] })
    expect(harness.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 0,
        message: 'Applied 1 file(s) to the workspace.',
      }),
    )
  })

  it('warns with skipped files and reports keptOpen on top', async () => {
    const { run, harness } = await makeHarness()
    harness.dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, true],
    })
    harness.commands.executeCommand.mockResolvedValueOnce({
      applied: ['//depot/src/editor/a.ts'],
      skipped: [{ depotFile: '//depot/src/runtime/b.ts', reason: 'already opened for edit' }],
      keptOpen: [{ depotFile: '//depot/src/editor/a.ts', reason: 'opened for edit' }],
    })
    await run({ reviewId: '1001', change: '2001', files: [IN_WS] })
    expect(harness.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 1,
        message: expect.stringContaining('already opened for edit'),
      }),
    )
    expect(harness.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 1,
        message: expect.stringContaining('remain open'),
      }),
    )
  })

  it('reports nothing applied when the host applied and skipped nothing', async () => {
    const { run, harness } = await makeHarness()
    harness.dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, true],
    })
    harness.commands.executeCommand.mockResolvedValueOnce({
      applied: [],
      skipped: [],
      keptOpen: [],
    })
    await run({ reviewId: '1001', change: '2001', files: [IN_WS] })
    expect(harness.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'No files were applied.' }),
    )
  })

  it('surfaces a host failure through onError', async () => {
    const { run, harness } = await makeHarness()
    harness.dialog.confirm.mockResolvedValueOnce({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, true],
    })
    harness.commands.executeCommand.mockRejectedValueOnce(new Error('unshelve boom'))
    await run({ reviewId: '1001', change: '2001', files: [IN_WS] })
    expect(harness.onError).toHaveBeenCalledWith('unshelve boom')
  })

  it('attach is idempotent across repeated runs', async () => {
    const { run, harness } = await makeHarness()
    harness.dialog.confirm.mockResolvedValue({
      confirmed: true,
      choice: 'primary' as const,
      checkboxChecked: [false, true],
    })
    await run({ reviewId: '1001', change: '2001', files: [IN_WS] })
    await run({ reviewId: '1001', change: '2001', files: [IN_WS] })
    // Two persisted toggles read once; the second run reuses the ready promise.
    expect(harness.storage.gets).toHaveBeenCalledTimes(2)
  })
})
