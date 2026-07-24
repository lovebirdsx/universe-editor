import { commands, window, workspace, type ExtensionContext } from '@universe-editor/extension-api'

const SERVER_NAME = 'universe-editor'
const CONFIG_SECTION = 'universeEditorMcp'

interface McpServerConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function bridgeEntry(context: ExtensionContext): string {
  return `${context.extensionPath.replace(/\\/g, '/')}/resources/bridge/bridge.mjs`
}

function mcpConfigFor(context: ExtensionContext): McpServerConfig {
  return {
    command: process.execPath,
    args: [bridgeEntry(context)],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
    },
  }
}

async function installMcpServer(context: ExtensionContext, interactive: boolean): Promise<void> {
  const enabled = await workspace.getConfiguration(CONFIG_SECTION).get('enabled', true)
  if (!enabled) return

  const acpConfig = workspace.getConfiguration('acp')
  const current = asRecord(await acpConfig.get('mcpServers', {}))
  await acpConfig.update('mcpServers', {
    ...current,
    [SERVER_NAME]: mcpConfigFor(context),
  })

  if (interactive) {
    await window.showInformationMessage('Universe Editor MCP 已重新注册。')
  }
  console.error('[universe-editor-mcp-bridge] registered MCP server')
}

export async function activate(context: ExtensionContext): Promise<void> {
  context.subscriptions.push(
    commands.registerCommand('universeEditorMcp.reconnect', () => installMcpServer(context, true)),
  )

  await installMcpServer(context, false)
  console.error('[universe-editor-mcp-bridge] activated')
}

export function deactivate(): void {
  // no-op
}
