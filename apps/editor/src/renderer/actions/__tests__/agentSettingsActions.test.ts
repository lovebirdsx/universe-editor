import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { IClaudeConfigService } from '../../../shared/ipc/claudeConfigService.js'
import { ICodexConfigService } from '../../../shared/ipc/codexConfigService.js'
import { OpenClaudeConfigAction, OpenCodexConfigAction } from '../agentSettingsActions.js'

const disposables: IDisposable[] = []

afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
  vi.restoreAllMocks()
})

async function run(services: ServiceCollection, commandId: string): Promise<void> {
  const instantiationService = new InstantiationService(services)
  await instantiationService.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(commandId)!.handler(accessor)
  })
}

describe('Agent configuration actions', () => {
  it('opens the Codex config in a pinned editor', async () => {
    const path = 'C:/Users/test/.codex/config.toml'
    disposables.push(registerAction2(OpenCodexConfigAction))
    const openEditor = vi.fn().mockResolvedValue(undefined)
    const services = new ServiceCollection()
    services.set(IEditorResolverService, { openEditor } as unknown as IEditorResolverService)
    services.set(ICodexConfigService, {
      configPath: vi.fn().mockResolvedValue(path),
    } as unknown as ICodexConfigService)

    await run(services, OpenCodexConfigAction.ID)

    expect(openEditor).toHaveBeenCalledWith(URI.file(path), { pinned: true })
  })

  it('opens the Claude config in a pinned editor', async () => {
    const path = 'C:/Users/test/.claude/settings.json'
    disposables.push(registerAction2(OpenClaudeConfigAction))
    const openEditor = vi.fn().mockResolvedValue(undefined)
    const services = new ServiceCollection()
    services.set(IEditorResolverService, { openEditor } as unknown as IEditorResolverService)
    services.set(IClaudeConfigService, {
      configPath: vi.fn().mockResolvedValue(path),
    } as unknown as IClaudeConfigService)

    await run(services, OpenClaudeConfigAction.ID)

    expect(openEditor).toHaveBeenCalledWith(URI.file(path), { pinned: true })
  })
})
