/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiMcpServersPanel tests — merged single-list rendering (one row per
 *  server, source badges, shadow dimming), two-level enablement toggles,
 *  edit/remove targeting the highest-priority writable definition, source
 *  badge routing, the toolbar config-file menu, and the active-session status dot.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  ConfigurationTarget,
  Emitter,
  Event,
  InstantiationService,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorResolverService,
  IUserDataFilesService,
  IWorkspaceService,
  ServiceCollection,
  StorageScope,
  URI,
  observableValue,
  type IConfigurationChangeEvent,
} from '@universe-editor/platform'
import type {
  IAcpSession,
  IAcpSessionService,
} from '../../../services/acp/session/acpSessionService.js'
import { IAcpSessionService as IAcpSessionServiceId } from '../../../services/acp/session/acpSessionService.js'
import type { IExtensionMcpServersService } from '../../../services/extensions/extensionMcpServersService.js'
import { IExtensionMcpServersService as IExtensionMcpServersServiceId } from '../../../services/extensions/extensionMcpServersService.js'
import type { IMcpServerEnablementService } from '../../../services/acp/mcpServerEnablementService.js'
import { IMcpServerEnablementService as IMcpServerEnablementServiceId } from '../../../services/acp/mcpServerEnablementService.js'
import type { IAgentMcpConfigService } from '../../../services/acp/agentMcpConfigService.js'
import { IAgentMcpConfigService as IAgentMcpConfigServiceId } from '../../../services/acp/agentMcpConfigService.js'
import type { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import { IClaudeConfigService as IClaudeConfigServiceId } from '../../../../shared/ipc/claudeConfigService.js'
import type { ICodexConfigService } from '../../../../shared/ipc/codexConfigService.js'
import { ICodexConfigService as ICodexConfigServiceId } from '../../../../shared/ipc/codexConfigService.js'
import type { McpAgentAffinity } from '../../../services/acp/acpMcpServers.js'
import { AiMcpServersPanel } from '../AiMcpServersPanel.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const CONFIG_KEY = 'acp.mcpServers'

class FakeConfigurationService {
  private readonly _onDidChange = new Emitter<IConfigurationChangeEvent>()
  readonly onDidChangeConfiguration = this._onDidChange.event
  private readonly layers = new Map<ConfigurationTarget, Record<string, unknown>>()

  seed(target: ConfigurationTarget, value: Record<string, unknown>): void {
    this.layers.set(target, { [CONFIG_KEY]: value })
  }

  getLayerSnapshot(target: ConfigurationTarget): Readonly<Record<string, unknown>> {
    return this.layers.get(target) ?? {}
  }

  update(key: string, value: unknown, target?: ConfigurationTarget): void {
    const layer = { ...(this.layers.get(target ?? ConfigurationTarget.User) ?? {}) }
    layer[key] = value
    this.layers.set(target ?? ConfigurationTarget.User, layer)
    this._onDidChange.fire({ keys: [key], affectsConfiguration: (k: string) => k === key })
  }

  serversOf(target: ConfigurationTarget): Record<string, unknown> {
    return (this.layers.get(target)?.[CONFIG_KEY] ?? {}) as Record<string, unknown>
  }
}

/** In-memory two-scope enablement stub (fires synchronously like the real one). */
class StubEnablementService implements IMcpServerEnablementService {
  declare readonly _serviceBrand: undefined
  readonly whenReady = Promise.resolve()
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange = this._onDidChange.event
  readonly records: Record<StorageScope, Record<string, boolean>> = {
    [StorageScope.GLOBAL]: {},
    [StorageScope.WORKSPACE]: {},
  }
  isEnabled(name: string): boolean {
    return (
      this.records[StorageScope.WORKSPACE][name] ?? this.records[StorageScope.GLOBAL][name] ?? true
    )
  }
  getOverride(name: string, scope: StorageScope): boolean | undefined {
    return this.records[scope][name]
  }
  setEnabled(name: string, enabled: boolean, scope: StorageScope): Promise<void> {
    this.records[scope][name] = enabled
    this._onDidChange.fire()
    return Promise.resolve()
  }
  removeOverride(name: string, scope: StorageScope): Promise<void> {
    delete this.records[scope][name]
    this._onDidChange.fire()
    return Promise.resolve()
  }
}

function makeSessionService(mcpJson: Record<string, unknown>, activeSession?: IAcpSession) {
  return {
    activeSession: observableValue<IAcpSession | undefined>('active', activeSession),
    readProjectMcpJson: vi.fn(async () => mcpJson),
  } as unknown as IAcpSessionService
}

/** Stub routing service: fixed per-agent raw records, Event.None change. */
function makeAgentMcpConfigService(layers: {
  claudeUser?: Record<string, unknown>
  codexUser?: Record<string, unknown>
  codexProject?: Record<string, unknown>
}) {
  return {
    onDidChange: Event.None as Event<{ readonly agentAffinity: McpAgentAffinity }>,
    readAgentMcpLayers: vi.fn(async (agentId: string) => ({
      userLayers:
        agentId === 'claude-code'
          ? [{ raw: layers.claudeUser ?? {} }]
          : agentId === 'codex'
            ? [{ raw: layers.codexUser ?? {} }]
            : [],
      projectLayers: agentId === 'codex' ? [{ raw: layers.codexProject ?? {} }] : [],
    })),
  } as unknown as IAgentMcpConfigService
}

function renderPanel({
  config,
  withSessionService = true,
  mcpJson = {},
  activeSession,
  confirmResult = { confirmed: true },
  workspaceOpen = true,
  extensionRecord,
  agentLayers,
  withClaudeConfig = false,
  withCodexConfig = false,
  claudeConfigPath = '/home/testuser/.claude.json',
  codexConfigPath = '/home/testuser/.codex/config.toml',
}: {
  config: FakeConfigurationService
  withSessionService?: boolean
  mcpJson?: Record<string, unknown>
  activeSession?: IAcpSession
  confirmResult?: { confirmed: boolean }
  workspaceOpen?: boolean
  extensionRecord?: Record<string, unknown>
  agentLayers?: Parameters<typeof makeAgentMcpConfigService>[0]
  withClaudeConfig?: boolean
  withCodexConfig?: boolean
  claudeConfigPath?: string
  codexConfigPath?: string
}) {
  const services = new ServiceCollection()
  services.set(IConfigurationService, config as unknown as IConfigurationService)
  services.set(IWorkspaceService, {
    current: workspaceOpen ? { folder: URI.file('/ws') } : null,
    onDidChangeWorkspace: Event.None,
  } as unknown as IWorkspaceService)
  services.set(IUserDataFilesService, {
    getFileUri: async (f: string) => URI.file(`/fake/${f}.json`),
  } as unknown as IUserDataFilesService)
  const commands = { executeCommand: vi.fn(async () => undefined) }
  services.set(ICommandService, commands as unknown as ICommandService)
  const editorResolver = { openEditor: vi.fn(async () => undefined) }
  services.set(IEditorResolverService, editorResolver as unknown as IEditorResolverService)
  const dialog = { confirm: vi.fn(async () => confirmResult) }
  services.set(IDialogService, dialog as unknown as IDialogService)
  const enablement = new StubEnablementService()
  services.set(IMcpServerEnablementServiceId, enablement)
  if (withSessionService) {
    services.set(IAcpSessionServiceId, makeSessionService(mcpJson, activeSession))
  }
  if (extensionRecord) {
    services.set(IExtensionMcpServersServiceId, {
      rawRecord: extensionRecord,
      whenReady: Promise.resolve(),
      onDidChange: Event.None,
      setContributions: () => {},
    } as unknown as IExtensionMcpServersService)
  }
  if (agentLayers) {
    services.set(IAgentMcpConfigServiceId, makeAgentMcpConfigService(agentLayers))
  }
  if (withClaudeConfig) {
    services.set(IClaudeConfigServiceId, {
      configPath: vi.fn(async () => claudeConfigPath),
    } as unknown as IClaudeConfigService)
  }
  if (withCodexConfig) {
    services.set(ICodexConfigServiceId, {
      configPath: vi.fn(async () => codexConfigPath),
    } as unknown as ICodexConfigService)
  }
  const inst = new InstantiationService(services)
  const utils = render(<AiMcpServersPanel />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { ...utils, commands, editorResolver, dialog, enablement }
}

function rowOf(name: string): HTMLElement {
  const row = [...screen.getAllByTestId('ai-mcp-row')].find(
    (n) => n.getAttribute('data-name') === name,
  )
  expect(row, `row for "${name}"`).toBeTruthy()
  return row!
}

function badgeOf(row: HTMLElement, source: string): HTMLElement {
  const badge = [...within(row).getAllByTestId('ai-mcp-source-badge')].find(
    (b) => b.getAttribute('data-source') === source,
  )
  expect(badge, `${source} badge`).toBeTruthy()
  return badge!
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('AiMcpServersPanel', () => {
  it('merges same-named definitions into one row with per-source badges, winner last priority', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    config.seed(ConfigurationTarget.Project, { fs: { command: 'bun' } })
    renderPanel({ config })
    await flushEffects()

    const row = rowOf('fs')
    // One row only (no per-group duplication), summary from the winner.
    expect(screen.getAllByTestId('ai-mcp-row')).toHaveLength(1)
    expect(row.textContent).toContain('bun')
    const userBadge = badgeOf(row, 'user')
    const wsBadge = badgeOf(row, 'workspace')
    expect(userBadge.getAttribute('data-shadowed')).toBe('true')
    expect(userBadge.getAttribute('data-tooltip')).toContain('overridden by')
    expect(wsBadge.getAttribute('data-shadowed')).toBeNull()
  })

  it('shows the user-level toggle only when a user-level source defines the name', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { shared: { command: 'node' } })
    config.seed(ConfigurationTarget.Project, {
      shared: { command: 'bun' },
      local: { command: 'deno' },
    })
    renderPanel({ config, mcpJson: { proj: { command: 'node p.js' } } })
    await flushEffects()
    await flushEffects()

    // 'shared' has a user-level definition → both switches.
    expect(within(rowOf('shared')).getByTestId('mcp-ena-user-toggle')).toBeTruthy()
    expect(within(rowOf('shared')).getByTestId('mcp-ena-ws-toggle')).toBeTruthy()
    // 'local' is workspace-only → only the workspace switch.
    expect(within(rowOf('local')).queryByTestId('mcp-ena-user-toggle')).toBeNull()
    expect(within(rowOf('local')).getByTestId('mcp-ena-ws-toggle')).toBeTruthy()
    // 'proj' lives only in .mcp.json → only the workspace switch.
    expect(within(rowOf('proj')).queryByTestId('mcp-ena-user-toggle')).toBeNull()
  })

  it('the user-level switch writes GLOBAL; the workspace switch cycles three states', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node', args: ['a'] } })
    const { enablement } = renderPanel({ config })
    await flushEffects()

    const row = rowOf('fs')
    fireEvent.click(within(row).getByTestId('mcp-ena-user-toggle'))
    expect(enablement.getOverride('fs', StorageScope.GLOBAL)).toBe(false)
    // The definition in settings stays untouched.
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({
      fs: { command: 'node', args: ['a'] },
    })
    await flushEffects()
    expect(rowOf('fs').getAttribute('data-disabled')).toBe('true')

    const wsToggle = within(rowOf('fs')).getByTestId('mcp-ena-ws-toggle')
    fireEvent.click(wsToggle)
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBe(true)
    await flushEffects()
    expect(rowOf('fs').getAttribute('data-disabled')).toBe('false')
    fireEvent.click(within(rowOf('fs')).getByTestId('mcp-ena-ws-toggle'))
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBe(false)
    fireEvent.click(within(rowOf('fs')).getByTestId('mcp-ena-ws-toggle'))
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBeUndefined()
  })

  it('edit/remove act on the highest-priority writable definition (workspace over user)', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    config.seed(ConfigurationTarget.Project, { fs: { command: 'bun' } })
    const { dialog } = renderPanel({ config })
    await flushEffects()

    const row = rowOf('fs')
    fireEvent.click(within(row).getByRole('button', { name: /Edit .* definition/ }))
    const dialogEl = await screen.findByRole('dialog')
    // Prefilled from the workspace definition.
    expect((within(dialogEl).getByPlaceholderText('npx') as HTMLInputElement).value).toBe('bun')
    fireEvent.click(within(dialogEl).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    await flushEffects()
    expect(dialog.confirm).toHaveBeenCalledOnce()
    // The workspace definition is removed; the user one survives and wins now.
    expect(config.serversOf(ConfigurationTarget.Project)).toEqual({})
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({ fs: { command: 'node' } })
  })

  it('clicking a user/workspace badge opens the edit dialog for that exact source', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    config.seed(ConfigurationTarget.Project, { fs: { command: 'bun' } })
    renderPanel({ config })
    await flushEffects()

    fireEvent.click(badgeOf(rowOf('fs'), 'user'))
    const dialogEl = await screen.findByRole('dialog')
    expect((within(dialogEl).getByPlaceholderText('npx') as HTMLInputElement).value).toBe('node')
  })

  it('clicking a file-source badge opens the backing file', async () => {
    const config = new FakeConfigurationService()
    const { editorResolver } = renderPanel({ config, mcpJson: { proj: { command: 'node p.js' } } })
    await flushEffects()
    await flushEffects()

    fireEvent.click(badgeOf(rowOf('proj'), 'mcpJson'))
    expect(editorResolver.openEditor).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('.mcp.json') }),
      expect.anything(),
    )
  })

  it('renders agent source badges with affinity tooltips and the agent shadow order', async () => {
    const config = new FakeConfigurationService()
    // 'shared' is defined by the extension, claude user, and the VSCode user
    // layers: extension < claudeUser < vscodeUser, so the vscode user layer
    // wins and both agent/extension badges are shadowed.
    config.seed(ConfigurationTarget.VSCodeUser, { shared: { command: 'node' } })
    renderPanel({
      config,
      extensionRecord: { shared: { command: 'ext-bin' } },
      agentLayers: {
        claudeUser: { shared: { command: 'claude-bin' }, claudeOnly: { command: 'c1' } },
        codexUser: { codexOnly: { command: 'x1' } },
        codexProject: { projOnly: { command: 'p1' } },
      },
    })
    await flushEffects()
    await flushEffects()

    // New badge captions appear on their rows.
    expect(badgeOf(rowOf('claudeOnly'), 'claudeUser').textContent).toBe('claude')
    expect(badgeOf(rowOf('codexOnly'), 'codexUser').textContent).toBe('codex')
    expect(badgeOf(rowOf('projOnly'), 'codexProject').textContent).toBe('codex-proj')
    // Affinity notes in the badge tooltips.
    expect(badgeOf(rowOf('claudeOnly'), 'claudeUser').getAttribute('data-tooltip')).toContain(
      'Claude Code sessions only',
    )
    expect(badgeOf(rowOf('codexOnly'), 'codexUser').getAttribute('data-tooltip')).toContain(
      'Codex sessions only',
    )
    // Shadow order: extension < claudeUser < vscodeUser (winner).
    const shared = rowOf('shared')
    expect(badgeOf(shared, 'vscodeUser').getAttribute('data-shadowed')).toBeNull()
    expect(badgeOf(shared, 'claudeUser').getAttribute('data-shadowed')).toBe('true')
    expect(badgeOf(shared, 'extension').getAttribute('data-shadowed')).toBe('true')
    // claudeUser is shadowed by the vscode user layer specifically.
    expect(badgeOf(shared, 'claudeUser').getAttribute('data-tooltip')).toContain('overridden by')
    // Agent-user definitions count as user-level for the user toggle.
    expect(within(rowOf('claudeOnly')).getByTestId('mcp-ena-user-toggle')).toBeTruthy()
    // …but the codex project layer is not user-level.
    expect(within(rowOf('projOnly')).queryByTestId('mcp-ena-user-toggle')).toBeNull()
  })

  it('clicking an agent badge opens its backing config file read-only', async () => {
    const config = new FakeConfigurationService()
    const { editorResolver } = renderPanel({
      config,
      agentLayers: {
        claudeUser: { claudeOnly: { command: 'c1' } },
        codexUser: { codexOnly: { command: 'x1' } },
        codexProject: { projOnly: { command: 'p1' } },
      },
      withClaudeConfig: true,
      withCodexConfig: true,
      claudeConfigPath: '/home/testuser/.claude.json',
      codexConfigPath: '/home/testuser/.codex/config.toml',
    })
    await flushEffects()
    await flushEffects()

    // Agent user files resolve through the config services' absolute paths.
    fireEvent.click(badgeOf(rowOf('claudeOnly'), 'claudeUser'))
    await flushEffects()
    expect(editorResolver.openEditor).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/home/testuser/.claude.json' }),
      expect.anything(),
    )
    fireEvent.click(badgeOf(rowOf('codexOnly'), 'codexUser'))
    await flushEffects()
    expect(editorResolver.openEditor).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/home/testuser/.codex/config.toml' }),
      expect.anything(),
    )
    // The codex project badge opens <workspace>/.codex/config.toml.
    fireEvent.click(badgeOf(rowOf('projOnly'), 'codexProject'))
    await flushEffects()
    expect(editorResolver.openEditor).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('.codex/config.toml') }),
      expect.anything(),
    )
    // Read-only sources never open the edit dialog.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('agent rows have enablement switches but no edit/remove actions', async () => {
    const config = new FakeConfigurationService()
    renderPanel({
      config,
      agentLayers: { claudeUser: { claudeOnly: { command: 'c1' } } },
    })
    await flushEffects()
    await flushEffects()

    const row = rowOf('claudeOnly')
    expect(within(row).getByTestId('mcp-ena-ws-toggle')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /Edit .* definition/ })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('the extension badge is inert (no edit affordance)', async () => {
    const config = new FakeConfigurationService()
    renderPanel({ config, extensionRecord: { bridge: { command: '/app/editor' } } })
    await flushEffects()

    const badge = badgeOf(rowOf('bridge'), 'extension')
    fireEvent.click(badge)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('extension rows have both enablement switches but no edit/remove', async () => {
    const config = new FakeConfigurationService()
    const { enablement } = renderPanel({
      config,
      extensionRecord: { bridge: { command: '/app/editor' } },
    })
    await flushEffects()

    const row = rowOf('bridge')
    fireEvent.click(within(row).getByTestId('mcp-ena-user-toggle'))
    expect(enablement.getOverride('bridge', StorageScope.GLOBAL)).toBe(false)
    expect(within(row).queryByRole('button', { name: /Edit .* definition/ })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('surfaces a runtime warning when the winning definition is invalid', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { bad: { args: [] } })
    renderPanel({ config })
    await flushEffects()

    const row = rowOf('bad')
    expect(row.textContent).toContain('Skipped at runtime')
    expect((within(row).getByTestId('mcp-ena-ws-toggle') as HTMLInputElement).disabled).toBe(true)
  })

  it('adds a stdio server through the dialog into the workspace layer', async () => {
    const config = new FakeConfigurationService()
    renderPanel({ config })
    await flushEffects()

    fireEvent.click(screen.getAllByRole('button', { name: /Add Server/ })[0]!)
    const dialogEl = await screen.findByRole('dialog')

    fireEvent.change(within(dialogEl).getByPlaceholderText('filesystem'), {
      target: { value: 'fs' },
    })
    fireEvent.change(within(dialogEl).getByPlaceholderText('npx'), {
      target: { value: 'node server.js' },
    })
    fireEvent.click(within(dialogEl).getByRole('button', { name: 'Save' }))

    // Workspace is open, so the default scope is the workspace layer.
    expect(config.serversOf(ConfigurationTarget.Project)).toEqual({
      fs: { command: 'node server.js' },
    })
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edits an entry through the dialog and persists enablement separately', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, {
      docs: { type: 'http', url: 'https://x', headers: { A: 'b' } },
    })
    const { enablement } = renderPanel({ config })
    await flushEffects()

    fireEvent.click(within(rowOf('docs')).getByRole('button', { name: /Edit .* definition/ }))
    const dialogEl = await screen.findByRole('dialog')

    const urlInput = within(dialogEl).getByPlaceholderText('https://example.com/mcp')
    expect((urlInput as HTMLInputElement).value).toBe('https://x')
    fireEvent.change(urlInput, { target: { value: 'https://y' } })
    // Uncheck "Enabled by default" — saved as an enablement override, not an entry field.
    const enabledToggle = dialogEl.querySelector('input[type="checkbox"]')!
    expect((enabledToggle as HTMLInputElement).checked).toBe(true)
    fireEvent.click(enabledToggle)
    fireEvent.click(within(dialogEl).getByRole('button', { name: 'Save' }))

    expect(config.serversOf(ConfigurationTarget.User)).toEqual({
      docs: { type: 'http', url: 'https://y', headers: { A: 'b' } },
    })
    expect(enablement.getOverride('docs', StorageScope.GLOBAL)).toBe(false)
  })

  it('keeps the entry when the confirm dialog is cancelled', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    renderPanel({ config, confirmResult: { confirmed: false } })
    await flushEffects()

    fireEvent.click(within(rowOf('fs')).getByRole('button', { name: 'Remove' }))
    await flushEffects()
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({ fs: { command: 'node' } })
  })

  it('renders the active-session status dot for matching server names', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    const session = {
      mcpServers: observableValue('mcp', [{ name: 'fs', status: 'connected' as const }]),
    } as unknown as IAcpSession
    renderPanel({ config, activeSession: session })
    await flushEffects()

    const dot = rowOf('fs').querySelector('[data-status]')
    expect(dot?.getAttribute('data-status')).toBe('connected')
  })

  it('shows the empty state when nothing is configured anywhere', async () => {
    const config = new FakeConfigurationService()
    renderPanel({ config })
    await flushEffects()

    expect(screen.getByTestId('ai-mcp-panel').textContent).toContain('No MCP servers configured')
  })

  it('toolbar opens a config-file menu listing only present sources', async () => {
    const config = new FakeConfigurationService()
    const { commands } = renderPanel({ config })
    await flushEffects()

    const panel = screen.getByTestId('ai-mcp-panel')
    fireEvent.click(within(panel).getByRole('button', { name: 'Open a configuration file' }))
    const menu = screen.getByTestId('ai-mcp-config-menu')
    expect(within(menu).getByText('User settings.json')).toBeTruthy()
    expect(within(menu).getByText('Workspace settings.json')).toBeTruthy()
    expect(within(menu).queryByText('.mcp.json')).toBeNull()
    fireEvent.click(within(menu).getByText('User settings.json'))
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsJson')
  })
})
