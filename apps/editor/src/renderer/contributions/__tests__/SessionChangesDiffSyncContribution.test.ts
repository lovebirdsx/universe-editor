/*---------------------------------------------------------------------------------------------
 *  Tests for SessionChangesDiffSyncContribution — an already-open session diff
 *  tab must refresh in place when the change tracker reports newer content for
 *  the same file.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  Emitter,
  observableValue,
  URI,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupModelChangeEvent,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IObservable,
} from '@universe-editor/platform'
import { SessionChangesDiffSyncContribution } from '../SessionChangesDiffSyncContribution.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import {
  type ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../services/acp/sessionChangeTracker.js'
import { type IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { type IAcpSession } from '../../services/acp/acpSessionModel.js'

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
  return { uri, path: uri.fsPath, baseline, current, status: 'modified', batchCount: 1 }
}

describe('SessionChangesDiffSyncContribution', () => {
  it('refreshes an open diff tab when the tracker reports newer content', () => {
    const uri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(uri, 'base-1', 'current-1')
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

  it('ignores diff tabs with no matching tracked change', () => {
    const openUri = URI.file('/ws/foo.ts')
    const input = new DiffEditorInput(openUri, 'base', 'current')
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
    const input = new DiffEditorInput(uri, 'base', 'current')
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
