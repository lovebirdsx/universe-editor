/*---------------------------------------------------------------------------------------------
 *  Tests for WorkspaceTrustContribution — the Restricted Mode status entry shows
 *  only for an untrusted folder and reacts to trust changes.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter, type Event } from '@universe-editor/platform'
import type {
  ICommandService,
  IStorageService,
  IWorkspaceService,
  IWorkspaceTrustManagementService,
} from '@universe-editor/platform'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { WorkspaceTrustContribution } from '../WorkspaceTrustContribution.js'

function fakeTrust(opts: {
  canSet: boolean
  trusted: boolean
}): IWorkspaceTrustManagementService & {
  fire(trusted: boolean): void
  setTrusted(v: boolean): void
} {
  const onDidChangeTrust = new Emitter<boolean>()
  let trusted = opts.trusted
  return {
    _serviceBrand: undefined,
    onDidChangeTrust: onDidChangeTrust.event,
    onDidChangeTrustedFolders: (() => ({ dispose() {} })) as Event<void>,
    workspaceTrustInitialized: Promise.resolve(),
    isWorkspaceTrusted: () => trusted,
    canSetWorkspaceTrust: () => opts.canSet,
    setWorkspaceTrust: vi.fn(() => Promise.resolve()),
    getUriTrustInfo: vi.fn(),
    setUrisTrust: vi.fn(() => Promise.resolve()),
    getTrustedUris: () => [],
    setTrustedUris: vi.fn(() => Promise.resolve()),
    addWorkspaceTrustTransitionParticipant: vi.fn(() => ({ dispose() {} })),
    fire: (v: boolean) => onDidChangeTrust.fire(v),
    setTrusted: (v: boolean) => {
      trusted = v
    },
  } as unknown as IWorkspaceTrustManagementService & {
    fire(trusted: boolean): void
    setTrusted(v: boolean): void
  }
}

function fakeWorkspace(): IWorkspaceService {
  return {
    _serviceBrand: undefined,
    current: { folder: { fsPath: '/proj' }, name: 'proj' },
    onDidChangeWorkspace: (() => ({ dispose() {} })) as Event<never>,
    recent: [],
    onDidChangeRecent: (() => ({ dispose() {} })) as Event<never>,
    whenReady: Promise.resolve(),
  } as unknown as IWorkspaceService
}

function deps() {
  const statusBar = new StatusBarService()
  const commands = {
    executeCommand: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as ICommandService
  // Report "already prompted" so the startup modal path is inert in the test.
  const storage = {
    get: vi.fn(() => Promise.resolve(true)),
    set: vi.fn(() => Promise.resolve()),
  } as unknown as IStorageService
  return { statusBar, commands, storage }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('WorkspaceTrustContribution', () => {
  it('shows the Restricted Mode entry for an untrusted folder', async () => {
    const { statusBar, commands, storage } = deps()
    const trust = fakeTrust({ canSet: true, trusted: false })
    const contrib = new WorkspaceTrustContribution(
      trust,
      statusBar,
      commands,
      storage,
      fakeWorkspace(),
    )
    await flush()
    const texts = statusBar.entries.get().map((e) => e.entry.text)
    expect(texts).toContain('Restricted Mode')
    contrib.dispose()
  })

  it('shows nothing for a trusted folder', async () => {
    const { statusBar, commands, storage } = deps()
    const trust = fakeTrust({ canSet: true, trusted: true })
    const contrib = new WorkspaceTrustContribution(
      trust,
      statusBar,
      commands,
      storage,
      fakeWorkspace(),
    )
    await flush()
    expect(statusBar.entries.get()).toHaveLength(0)
    contrib.dispose()
  })

  it('shows nothing when there is no folder to trust', async () => {
    const { statusBar, commands, storage } = deps()
    const trust = fakeTrust({ canSet: false, trusted: true })
    const contrib = new WorkspaceTrustContribution(
      trust,
      statusBar,
      commands,
      storage,
      fakeWorkspace(),
    )
    await flush()
    expect(statusBar.entries.get()).toHaveLength(0)
    contrib.dispose()
  })

  it('removes the entry when trust is granted', async () => {
    const { statusBar, commands, storage } = deps()
    const trust = fakeTrust({ canSet: true, trusted: false })
    const contrib = new WorkspaceTrustContribution(
      trust,
      statusBar,
      commands,
      storage,
      fakeWorkspace(),
    )
    await flush()
    expect(statusBar.entries.get()).toHaveLength(1)

    trust.setTrusted(true)
    trust.fire(true)
    await flush()
    expect(statusBar.entries.get()).toHaveLength(0)
    contrib.dispose()
  })
})
