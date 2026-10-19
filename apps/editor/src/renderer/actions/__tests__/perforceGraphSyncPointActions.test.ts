import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { PerforceGraphEditorInput } from '../../services/editor/PerforceGraphEditorInput.js'
import { normalizeGraphScopeSelection } from '../../services/perforceGraph/graphScopeSelection.js'
import {
  _resetForTests,
  getPerforceGraphViewState,
  perforceGraphViewState,
} from '../../services/perforceGraph/perforceGraphViewState.js'
import {
  PerforceGraphQuerySyncPointAction,
  PerforceGraphRevealSyncPointAction,
} from '../perforceGraphActions.js'

async function runCommand(id: string, active: unknown): Promise<void> {
  const services = new ServiceCollection()
  services.set(IEditorService, {
    _serviceBrand: undefined,
    activeEditor: observableValue<unknown>('t.activeEditor', active),
  } as unknown as IEditorService)
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(id)!.handler(accessor)
  })
}

describe('perforce graph sync point actions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    _resetForTests()
    vi.clearAllMocks()
  })

  it('query action invokes the mounted editor query callback', async () => {
    disposables.push(registerAction2(PerforceGraphQuerySyncPointAction))
    const querySyncPoint = vi.fn()
    perforceGraphViewState.querySyncPoint = querySyncPoint

    await runCommand(PerforceGraphQuerySyncPointAction.ID, new PerforceGraphEditorInput())

    expect(querySyncPoint).toHaveBeenCalledTimes(1)
  })

  it('reveal action invokes the mounted editor reveal callback', async () => {
    disposables.push(registerAction2(PerforceGraphRevealSyncPointAction))
    const revealSyncPoint = vi.fn()
    perforceGraphViewState.revealSyncPoint = revealSyncPoint

    await runCommand(PerforceGraphRevealSyncPointAction.ID, new PerforceGraphEditorInput())

    expect(revealSyncPoint).toHaveBeenCalledTimes(1)
  })

  it('routes through the scoped bucket, never the global singleton', async () => {
    disposables.push(registerAction2(PerforceGraphQuerySyncPointAction))
    disposables.push(registerAction2(PerforceGraphRevealSyncPointAction))
    const globalQuery = vi.fn()
    const globalReveal = vi.fn()
    perforceGraphViewState.querySyncPoint = globalQuery
    perforceGraphViewState.revealSyncPoint = globalReveal

    const input = new PerforceGraphEditorInput(
      normalizeGraphScopeSelection([{ path: 'X:/p4ws/main', isDirectory: true }]),
    )
    const scoped = getPerforceGraphViewState(input.id)
    const scopedQuery = vi.fn()
    const scopedReveal = vi.fn()
    scoped.querySyncPoint = scopedQuery
    scoped.revealSyncPoint = scopedReveal

    await runCommand(PerforceGraphQuerySyncPointAction.ID, input)
    await runCommand(PerforceGraphRevealSyncPointAction.ID, input)

    expect(scopedQuery).toHaveBeenCalledTimes(1)
    expect(scopedReveal).toHaveBeenCalledTimes(1)
    expect(globalQuery).not.toHaveBeenCalled()
    expect(globalReveal).not.toHaveBeenCalled()
  })

  it('does nothing when the active editor is not a Perforce Graph', async () => {
    disposables.push(registerAction2(PerforceGraphQuerySyncPointAction))
    disposables.push(registerAction2(PerforceGraphRevealSyncPointAction))
    const querySyncPoint = vi.fn()
    const revealSyncPoint = vi.fn()
    perforceGraphViewState.querySyncPoint = querySyncPoint
    perforceGraphViewState.revealSyncPoint = revealSyncPoint

    await runCommand(PerforceGraphQuerySyncPointAction.ID, {})
    await runCommand(PerforceGraphRevealSyncPointAction.ID, {})

    expect(querySyncPoint).not.toHaveBeenCalled()
    expect(revealSyncPoint).not.toHaveBeenCalled()
  })
})
