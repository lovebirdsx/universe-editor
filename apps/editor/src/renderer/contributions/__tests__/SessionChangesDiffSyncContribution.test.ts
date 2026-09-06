/*---------------------------------------------------------------------------------------------
 *  Tests for SessionChangesDiffSyncContribution — an already-open session diff
 *  tab must refresh in place when the change tracker reports newer content for
 *  the same file.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  observableValue,
  URI,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupModelChangeEvent,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileService,
  type IObservable,
} from '@universe-editor/platform'
import { SessionChangesDiffSyncContribution } from '../SessionChangesDiffSyncContribution.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import {
  type ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../services/acp/session/sessionChangeTracker.js'
import { type IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { type IAcpSession } from '../../services/acp/session/acpSessionModel.js'

// Stub the model registry so a test can inject a live shared model for a URI
// (the editable diff's modified side). Default: no live model (peek → undefined).
const liveModels = new Map<
  string,
  { getValue: () => string; setValue?: (v: string) => void; isDisposed: () => boolean }
>()
const markCleanCalls: unknown[] = []
vi.mock('../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: {
    peek: (uri: { toString: () => string }) => liveModels.get(uri.toString()),
    onDidMarkModelClean: () => ({ dispose() {} }),
    markModelClean(model: unknown) {
      markCleanCalls.push(model)
    },
  },
}))

function makeGroups(editors: EditorInput[]): IEditorGroupsServiceType {
  const modelEmitter = new Emitter<IEditorGroupModelChangeEvent>()
  const addGroupEmitter = new Emitter<IEditorGroup>()
  const removeGroupEmitter = new Emitter<IEditorGroup>()
  const group = {
    id: 1,
    editors,
    onDidChangeModel: modelEmitter.event,
  } as unknown as IEditorGroup
  return {
    groups: [group],
    onDidAddGroup: addGroupEmitter.event,
    onDidRemoveGroup: removeGroupEmitter.event,
  } as unknown as IEditorGroupsServiceType
}

function makeSessions(idOnAgent: string | undefined): IAcpSessionService {
  const session = {
    sessionIdOnAgent: observableValue<string | undefined>('sid', idOnAgent),
  } as unknown as IAcpSession
  return {
    sessions: observableValue<readonly IAcpSession[]>('sessions', [session]),
  } as unknown as IAcpSessionService
}

function makeTracker(obs: IObservable<readonly SessionFileChange[]>): ISessionChangeTrackerService {
  return {
    changesFor: () => obs,
  } as unknown as ISessionChangeTrackerService
}

function change(uri: URI, baseline: string, current: string): SessionFileChange {
  return {
    uri,
    path: uri.fsPath,
    baseline,
    current,
    status: 'modified',
    origin: 'agent',
    baselineSource: 'reported',
    hasTexts: true,
    batchCount: 1,
  }
}

const fileService = {} as IFileService

describe('SessionChangesDiffSyncContribution', () => {
  it('refreshes an open diff tab when the tracker reports newer content', () => {
    const uri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(
      uri,
      'base-1',
      'current-1',
      undefined,
      undefined,
      false,
      fileService,
    )
    const groups = makeGroups([input])
    const sessions = makeSessions('agent-1')
    const changesObs = observableValue<readonly SessionFileChange[]>('changes', [
      change(uri, 'base-1', 'current-1'),
    ])
    const tracker = makeTracker(changesObs)

    let fired = 0
    input.onDidChangeContent(() => fired++)

    const contrib = new SessionChangesDiffSyncContribution(sessions, tracker, groups)

    // The agent edits the file again; the tracker recomputes and publishes.
    changesObs.set([change(uri, 'base-2', 'current-2')], undefined)

    expect(input.originalContent).toBe('base-2')
    expect(input.modifiedContent).toBe('current-2')
    expect(fired).toBe(1)
    contrib.dispose()
  })

  it('refreshes an editable diff from the tracker disk read, not its stale shared model', () => {
    // An editable (liveModified=true) session diff owns the shared model under
    // originalUri. After a second agent edit that model still holds the first
    // edit, so the sync must reconcile it from the tracker's fresh disk read
    // instead of pinning the stale buffer — otherwise the tab never refreshes.
    const uri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(
      uri,
      'base-1',
      'current-1',
      undefined,
      undefined,
      true,
      fileService,
    )
    let modelValue = 'current-1'
    const model = {
      getValue: () => modelValue,
      setValue: (v: string) => (modelValue = v),
      isDisposed: () => false,
    }
    liveModels.set(uri.toString(), model)
    markCleanCalls.length = 0

    const groups = makeGroups([input])
    const sessions = makeSessions('agent-1')
    const changesObs = observableValue<readonly SessionFileChange[]>('changes', [
      change(uri, 'base-1', 'current-1'),
    ])
    const contrib = new SessionChangesDiffSyncContribution(
      sessions,
      makeTracker(changesObs),
      groups,
    )

    changesObs.set([change(uri, 'base-2', 'current-2')], undefined)

    expect(modelValue).toBe('current-2')
    expect(input.modifiedContent).toBe('current-2')
    expect(input.originalContent).toBe('base-2')
    expect(markCleanCalls).toContain(model)
    liveModels.delete(uri.toString())
    contrib.dispose()
  })

  it('never pushes a textless row into an editable diff (it would blank the file)', () => {
    // A textless row carries no content — the file was never read (too large,
    // not a regular file, or released under memory pressure). The editable path
    // writes `current` straight into the SHARED buffer and marks it clean, so
    // syncing one would blank the user's open document and let the next save
    // persist the empty content.
    const uri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(
      uri,
      'base-1',
      'current-1',
      undefined,
      undefined,
      true,
      fileService,
    )
    let modelValue = 'current-1'
    const model = {
      getValue: () => modelValue,
      setValue: (v: string) => (modelValue = v),
      isDisposed: () => false,
    }
    liveModels.set(uri.toString(), model)
    markCleanCalls.length = 0

    const changesObs = observableValue<readonly SessionFileChange[]>('changes', [
      change(uri, 'base-1', 'current-1'),
    ])
    const contrib = new SessionChangesDiffSyncContribution(
      makeSessions('agent-1'),
      makeTracker(changesObs),
      makeGroups([input]),
    )

    changesObs.set([{ ...change(uri, '', ''), status: 'degraded', hasTexts: false }], undefined)

    expect(modelValue).toBe('current-1')
    expect(input.modifiedContent).toBe('current-1')
    expect(input.originalContent).toBe('base-1')
    expect(markCleanCalls).not.toContain(model)
    liveModels.delete(uri.toString())
    contrib.dispose()
  })

  it('still refreshes a degraded row that carries both texts', () => {
    // `degraded` covers two unrelated things, and only one of them means "no
    // content": a row whose baseline could not be reconstructed precisely (a
    // hunk failed to locate, or there is no comparable pre-change content)
    // still carries both texts in full. Gating the sync on the status instead
    // of on `hasTexts` froze such a tab on its first edit forever.
    const uri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(
      uri,
      'base-1',
      'current-1',
      undefined,
      undefined,
      false,
      fileService,
    )
    const changesObs = observableValue<readonly SessionFileChange[]>('changes', [
      change(uri, 'base-1', 'current-1'),
    ])
    const contrib = new SessionChangesDiffSyncContribution(
      makeSessions('agent-1'),
      makeTracker(changesObs),
      makeGroups([input]),
    )

    changesObs.set([{ ...change(uri, 'base-1', 'current-2'), status: 'degraded' }], undefined)

    expect(input.modifiedContent).toBe('current-2')
    expect(input.originalContent).toBe('base-1')
    contrib.dispose()
  })

  it('ignores diff tabs with no matching tracked change', () => {
    const openUri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(
      openUri,
      'base',
      'current',
      undefined,
      undefined,
      false,
      fileService,
    )
    const groups = makeGroups([input])
    const sessions = makeSessions('agent-1')
    const changesObs = observableValue<readonly SessionFileChange[]>('changes', [
      change(URI.file('/ws/other.ts'), 'x', 'y'),
    ])
    const contrib = new SessionChangesDiffSyncContribution(
      sessions,
      makeTracker(changesObs),
      groups,
    )

    expect(input.originalContent).toBe('base')
    expect(input.modifiedContent).toBe('current')
    contrib.dispose()
  })

  it('does nothing while the session has no agent id yet', () => {
    const uri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(
      uri,
      'base',
      'current',
      undefined,
      undefined,
      false,
      fileService,
    )
    const groups = makeGroups([input])
    const sessions = makeSessions(undefined)
    const changesObs = observableValue<readonly SessionFileChange[]>('changes', [
      change(uri, 'base-2', 'current-2'),
    ])
    const contrib = new SessionChangesDiffSyncContribution(
      sessions,
      makeTracker(changesObs),
      groups,
    )

    expect(input.originalContent).toBe('base')
    contrib.dispose()
  })
})
