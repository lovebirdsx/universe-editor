/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiMcpServersPanel tests — scope grouping, per-name shadow notes, the
 *  enable/disable toggle write path, add/edit/remove flows through the edit
 *  dialog, invalid-entry warnings, the read-only .mcp.json group, and the
 *  active-session status dot.
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
    this._onDidChange.fire({ affectsConfiguration: (k: string) => k === key })
  }

  serversOf(target: ConfigurationTarget): Record<string, unknown> {
    return (this.layers.get(target)?.[CONFIG_KEY] ?? {}) as Record<string, unknown>
  }
}

function makeSessionService(mcpJson: Record<string, unknown>, activeSession?: IAcpSession) {
  return {
    activeSession: observableValue<IAcpSession | undefined>('active', activeSession),
    readProjectMcpJson: vi.fn(async () => mcpJson),
  } as unknown as IAcpSessionService
}

function renderPanel({
  config,
  withSessionService = true,
  mcpJson = {},
  activeSession,
  confirmResult = { confirmed: true },
  workspaceOpen = true,
  extensionRecord,
}: {
  config: FakeConfigurationService
  withSessionService?: boolean
  mcpJson?: Record<string, unknown>
  activeSession?: IAcpSession
  confirmResult?: { confirmed: boolean }
  workspaceOpen?: boolean
  extensionRecord?: Record<string, unknown>
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
  const inst = new InstantiationService(services)
  const utils = render(<AiMcpServersPanel />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { ...utils, commands, editorResolver, dialog }
}

function groupEl(id: string): HTMLElement {
  return screen.getByTestId(`ai-mcp-group-${id}`)
}

function rowIn(groupId: string, name: string): HTMLElement {
  const row = [...within(groupEl(groupId)).getAllByTestId('ai-mcp-row')].find(
    (n) => n.getAttribute('data-name') === name,
  )
  expect(row).toBeTruthy()
  return row!
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('AiMcpServersPanel', () => {
  it('groups rows by scope and annotates entries shadowed by a higher scope', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, {
      fs: { command: 'node' },
      docs: { command: 'npx' },
    })
    config.seed(ConfigurationTarget.Project, { fs: { command: 'bun' } })
    renderPanel({ config })
    await flushEffects()

    const userFs = rowIn('user', 'fs')
    expect(userFs.textContent).toContain('overridden by')
    expect(rowIn('user', 'docs').textContent).not.toContain('overridden by')
    expect(rowIn('workspace', 'fs').textContent).not.toContain('overridden by')
    expect(rowIn('workspace', 'fs').textContent).toContain('bun')
  })

  it('the toggle checkbox writes the disabled flag into the owning layer', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node', args: ['a'] } })
    renderPanel({ config })
    await flushEffects()

    const toggle = within(rowIn('user', 'fs')).getByTestId('ai-mcp-row-toggle')
    expect((toggle as HTMLInputElement).checked).toBe(true)
    fireEvent.click(toggle)
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({
      fs: { command: 'node', args: ['a'], disabled: true },
    })

    await flushEffects()
    const toggleAgain = within(rowIn('user', 'fs')).getByTestId('ai-mcp-row-toggle')
    expect((toggleAgain as HTMLInputElement).checked).toBe(false)
    fireEvent.click(toggleAgain)
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({
      fs: { command: 'node', args: ['a'] },
    })
  })

  it('surfaces a runtime warning for entries the wire path would skip', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { bad: { args: [] } })
    renderPanel({ config })
    await flushEffects()

    expect(rowIn('user', 'bad').textContent).toContain('Skipped at runtime')
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

  it('edits an existing user entry through the dialog', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, {
      docs: { type: 'http', url: 'https://x', headers: { A: 'b' }, disabled: true },
    })
    renderPanel({ config })
    await flushEffects()

    fireEvent.click(within(rowIn('user', 'docs')).getByRole('button', { name: 'Edit' }))
    const dialogEl = await screen.findByRole('dialog')

    const urlInput = within(dialogEl).getByPlaceholderText('https://example.com/mcp')
    expect((urlInput as HTMLInputElement).value).toBe('https://x')
    fireEvent.change(urlInput, { target: { value: 'https://y' } })
    fireEvent.click(within(dialogEl).getByRole('button', { name: 'Save' }))

    expect(config.serversOf(ConfigurationTarget.User)).toEqual({
      docs: { type: 'http', url: 'https://y', headers: { A: 'b' }, disabled: true },
    })
  })

  it('removes an entry only after the confirm dialog approves', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    const { dialog } = renderPanel({ config })
    await flushEffects()

    fireEvent.click(within(rowIn('user', 'fs')).getByRole('button', { name: 'Remove' }))
    await flushEffects()
    expect(dialog.confirm).toHaveBeenCalledOnce()
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({})
  })

  it('keeps the entry when the confirm dialog is cancelled', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    renderPanel({ config, confirmResult: { confirmed: false } })
    await flushEffects()

    fireEvent.click(within(rowIn('user', 'fs')).getByRole('button', { name: 'Remove' }))
    await flushEffects()
    expect(config.serversOf(ConfigurationTarget.User)).toEqual({ fs: { command: 'node' } })
  })

  it('shows the extension group read-only, shadowed by a same-named user entry', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { bridge: { command: 'node user.js' } })
    renderPanel({
      config,
      extensionRecord: {
        bridge: { command: '/app/editor' },
        extra: { command: '/app/editor', args: ['b.mjs'] },
      },
    })
    await flushEffects()

    const bridgeRow = rowIn('extension', 'bridge')
    expect(bridgeRow.textContent).toContain('overridden by')
    expect(within(bridgeRow).queryByTestId('ai-mcp-row-toggle')).toBeNull()
    expect(within(bridgeRow).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(bridgeRow).queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(rowIn('extension', 'extra').textContent).not.toContain('overridden by')
    // No JSON file backs the extension group — the open button is absent.
    expect(within(groupEl('extension')).queryByRole('button', { name: /Open JSON/ })).toBeNull()
  })

  it('hides the extension group when no extension contributes servers', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    renderPanel({ config, extensionRecord: {} })
    await flushEffects()

    expect(screen.queryByTestId('ai-mcp-group-extension')).toBeNull()
  })

  it('shows the .mcp.json group as read-only (no toggle, no row actions)', async () => {
    const config = new FakeConfigurationService()
    renderPanel({ config, mcpJson: { proj: { command: 'node p.js' } } })
    await flushEffects()
    await flushEffects() // readProjectMcpJson resolves after the first pass

    const row = rowIn('mcpJson', 'proj')
    expect(row.textContent).toContain('node p.js')
    expect(within(row).queryByTestId('ai-mcp-row-toggle')).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('renders the active-session status dot for matching server names', async () => {
    const config = new FakeConfigurationService()
    config.seed(ConfigurationTarget.User, { fs: { command: 'node' } })
    const session = {
      mcpServers: observableValue('mcp', [{ name: 'fs', status: 'connected' as const }]),
    } as unknown as IAcpSession
    renderPanel({ config, activeSession: session })
    await flushEffects()

    const dot = rowIn('user', 'fs').querySelector('[data-status]')
    expect(dot?.getAttribute('data-status')).toBe('connected')
  })

  it('shows the empty state when nothing is configured anywhere', async () => {
    const config = new FakeConfigurationService()
    renderPanel({ config })
    await flushEffects()

    expect(screen.getByTestId('ai-mcp-panel').textContent).toContain('No MCP servers configured')
  })
})
