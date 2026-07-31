import {
  McpStdioServerDefinition,
  lm,
  workspace,
  type ExtensionContext,
} from '@universe-editor/extension-api'
import { migrateSettings } from './extensionUpdateMigration.js'

const SERVER_NAME = 'universe-editor'
const CONFIG_SECTION = 'universeEditorMcp'

function bridgeEntry(context: ExtensionContext): string {
  return `${context.extensionPath.replace(/\\/g, '/')}/resources/bridge/bridge.mjs`
}

function mcpDefinitionFor(context: ExtensionContext): McpStdioServerDefinition {
  return new McpStdioServerDefinition(SERVER_NAME, process.execPath, [bridgeEntry(context)], {
    ELECTRON_RUN_AS_NODE: '1',
  })
}

export async function activate(context: ExtensionContext): Promise<void> {
  const enabled = await workspace.getConfiguration(CONFIG_SECTION).get('enabled', true)
  if (!enabled) return

  await migrateSettings()

  context.subscriptions.push(
    lm.registerMcpServerDefinitionProvider(SERVER_NAME, {
      provideMcpServerDefinitions: () => [mcpDefinitionFor(context)],
    }),
  )
  console.info('[universe-editor-mcp-bridge] activated')
}

export function deactivate(): void {
  // no-op
}
