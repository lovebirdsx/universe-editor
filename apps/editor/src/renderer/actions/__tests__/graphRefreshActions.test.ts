import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IEditorService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  observableValue,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { gitGraphViewState } from '../../services/gitGraph/gitGraphViewState.js'
import { perforceGraphViewState } from '../../services/perforceGraph/perforceGraphViewState.js'
import { PerforceGraphEditorInput } from '../../services/editor/PerforceGraphEditorInput.js'
import { GitGraphRefreshAction } from '../gitGraphActions.js'
import { GoToFileSymbolAction } from '../gotoSymbolActions.js'
import { PerforceGraphRefreshAction } from '../perforceGraphActions.js'
import { OpenRecentAction } from '../workspaceActions.js'

async function runCommand(id: string): Promise<void> {
  const inst = new InstantiationService(new ServiceCollection())
  await inst.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(id)!.handler(accessor)
  })
}

describe('graph refresh actions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    gitGraphViewState.refresh = null
    perforceGraphViewState.refresh = null
    vi.clearAllMocks()
  })

  it('GitGraphRefreshAction invokes the mounted editor refresh callback', async () => {
    disposables.push(registerAction2(GitGraphRefreshAction))
    const refresh = vi.fn()
    gitGraphViewState.refresh = refresh

    await runCommand(GitGraphRefreshAction.ID)

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('PerforceGraphRefreshAction invokes the mounted editor refresh callback', async () => {
    disposables.push(registerAction2(PerforceGraphRefreshAction))
    const refresh = vi.fn()
    perforceGraphViewState.refresh = refresh

    const services = new ServiceCollection()
    services.set(IEditorService, {
      _serviceBrand: undefined,
      activeEditor: observableValue<unknown>('t.activeEditor', new PerforceGraphEditorInput()),
    } as unknown as IEditorService)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      await CommandsRegistry.getCommand(PerforceGraphRefreshAction.ID)!.handler(accessor)
    })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('ctrl+shift+r resolves to the refresh command of the active graph editor only', () => {
    disposables.push(registerAction2(GitGraphRefreshAction))
    disposables.push(registerAction2(PerforceGraphRefreshAction))
    const ctx = new ContextKeyService()
    const activeEditorId = ctx.createKey<string>('activeEditorId', undefined)
    const activeEditorType = ctx.createKey<string>('activeEditorType', undefined)
    try {
      activeEditorId.set('universe:/gitGraph')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+r', ctx)).toMatchObject({
        kind: 'execute',
        command: GitGraphRefreshAction.ID,
      })
      activeEditorId.reset()
      activeEditorType.set('perforceGraph')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+r', ctx)).toMatchObject({
        kind: 'execute',
        command: PerforceGraphRefreshAction.ID,
      })
      activeEditorType.reset()
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+r', ctx).kind).not.toBe('execute')
    } finally {
      ctx.dispose()
    }
  })

  it('graph-scoped ctrl+r resolves to Go to Symbol, elsewhere to Open Recent', () => {
    disposables.push(registerAction2(GoToFileSymbolAction))
    disposables.push(registerAction2(OpenRecentAction))
    const ctx = new ContextKeyService()
    const activeEditorId = ctx.createKey<string>('activeEditorId', undefined)
    const activeEditorType = ctx.createKey<string>('activeEditorType', undefined)
    try {
      activeEditorId.set('universe:/gitGraph')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+r', ctx)).toMatchObject({
        kind: 'execute',
        command: GoToFileSymbolAction.ID,
      })
      activeEditorId.reset()
      activeEditorType.set('perforceGraph')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+r', ctx)).toMatchObject({
        kind: 'execute',
        command: GoToFileSymbolAction.ID,
      })
      activeEditorType.reset()
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+r', ctx)).toMatchObject({
        kind: 'execute',
        command: OpenRecentAction.ID,
      })
    } finally {
      ctx.dispose()
    }
  })
})
