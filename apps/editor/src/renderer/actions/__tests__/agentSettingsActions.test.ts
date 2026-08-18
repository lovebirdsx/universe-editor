import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorResolverService,
  InstantiationService,
  IWorkspaceService,
  REMOTE_SCHEME,
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

const LOCAL_WORKSPACE = { folder: URI.file('/workspace'), name: 'workspace' }

async function setup(
  action: typeof OpenCodexConfigAction | typeof OpenClaudeConfigAction,
  configPath: ReturnType<typeof vi.fn>,
  folder: URI,
): Promise<{ openEditor: ReturnType<typeof vi.fn> }> {
  const openEditor = vi.fn().mockResolvedValue(undefined)
  const services = new ServiceCollection()
  services.set(IEditorResolverService, { openEditor } as unknown as IEditorResolverService)
  services.set(IWorkspaceService, {
    current: { folder, name: 'workspace' },
  } as unknown as IWorkspaceService)
  services.set(ICodexConfigService, { configPath } as unknown as ICodexConfigService)
  services.set(IClaudeConfigService, { configPath } as unknown as IClaudeConfigService)
  disposables.push(registerAction2(action))
  await run(services, action.ID)
  return { openEditor }
}

describe('Agent configuration actions', () => {
  it('opens the Codex config in a pinned editor', async () => {
    const path = 'C:/Users/test/.codex/config.toml'
    const configPath = vi.fn().mockResolvedValue(path)

    const { openEditor } = await setup(OpenCodexConfigAction, configPath, LOCAL_WORKSPACE.folder)

    expect(configPath).toHaveBeenCalledWith(undefined)
    expect(openEditor).toHaveBeenCalledWith(URI.file(path), { pinned: true })
  })

  it('opens the Claude config in a pinned editor', async () => {
    const path = 'C:/Users/test/.claude/settings.json'
    const configPath = vi.fn().mockResolvedValue(path)

    const { openEditor } = await setup(OpenClaudeConfigAction, configPath, LOCAL_WORKSPACE.folder)

    expect(configPath).toHaveBeenCalledWith(undefined)
    expect(openEditor).toHaveBeenCalledWith(URI.file(path), { pinned: true })
  })

  it('opens the Codex config on the remote host in a remote workspace', async () => {
    const authority = 'wsl+ubuntu'
    const path = '/home/user/.codex/config.toml'
    const configPath = vi.fn().mockResolvedValue(path)

    const { openEditor } = await setup(
      OpenCodexConfigAction,
      configPath,
      URI.from({ scheme: REMOTE_SCHEME, authority, path: '/home/user' }),
    )

    expect(configPath).toHaveBeenCalledWith(authority)
    const [uri, options] = openEditor.mock.calls[0] as [URI, { pinned: true }]
    expect(uri.scheme).toBe(REMOTE_SCHEME)
    expect(uri.authority).toBe(authority)
    expect(uri.path).toBe(path)
    expect(options).toEqual({ pinned: true })
  })

  it('opens the Claude config on the remote host in a remote workspace', async () => {
    const authority = 'wsl+ubuntu'
    const path = '/home/user/.claude/settings.json'
    const configPath = vi.fn().mockResolvedValue(path)

    const { openEditor } = await setup(
      OpenClaudeConfigAction,
      configPath,
      URI.from({ scheme: REMOTE_SCHEME, authority, path: '/home/user' }),
    )

    expect(configPath).toHaveBeenCalledWith(authority)
    const [uri, options] = openEditor.mock.calls[0] as [URI, { pinned: true }]
    expect(uri.scheme).toBe(REMOTE_SCHEME)
    expect(uri.authority).toBe(authority)
    expect(uri.path).toBe(path)
    expect(options).toEqual({ pinned: true })
  })
})
