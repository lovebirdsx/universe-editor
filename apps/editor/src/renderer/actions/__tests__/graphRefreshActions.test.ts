import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { gitGraphViewState } from '../../services/gitGraph/gitGraphViewState.js'
import { perforceGraphViewState } from '../../services/perforceGraph/perforceGraphViewState.js'
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

    await runCommand(PerforceGraphRefreshAction.ID)

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('ctrl+shift+r resolves to the refresh command of the active graph editor only', () => {
    disposables.push(registerAction2(GitGraphRefreshAction))
    disposables.push(registerAction2(PerforceGraphRefreshAction))
    const ctx = new ContextKeyService()
    ctx.createKey('activeEditorId', 'universe:/gitGraph')
    try {
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+r', ctx)).toMatchObject({
        kind: 'execute',
        command: GitGraphRefreshAction.ID,
      })
      ctx.createKey('activeEditorId', 'universe:/perforceGraph')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+r', ctx)).toMatchObject({
        kind: 'execute',
        command: PerforceGraphRefreshAction.ID,
      })
      ctx.createKey('activeEditorId', 'default')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+r', ctx).kind).not.toBe('execute')
    } finally {
      ctx.dispose()
    }
  })

  it('graph-scoped ctrl+r resolves to Go to Symbol, elsewhere to Open Recent', () => {
    disposables.push(registerAction2(GoToFileSymbolAction))
    disposables.push(registerAction2(OpenRecentAction))
    const ctx = new ContextKeyService()
    ctx.createKey('activeEditorId', 'universe:/gitGraph')
    try {
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+r', ctx)).toMatchObject({
        kind: 'execute',
        command: GoToFileSymbolAction.ID,
      })
      ctx.createKey('activeEditorId', 'universe:/perforceGraph')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+r', ctx)).toMatchObject({
        kind: 'execute',
        command: GoToFileSymbolAction.ID,
      })
      ctx.createKey('activeEditorId', 'default')
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+r', ctx)).toMatchObject({
        kind: 'execute',
        command: OpenRecentAction.ID,
      })
    } finally {
      ctx.dispose()
    }
  })
})
