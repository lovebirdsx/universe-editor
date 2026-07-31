import { workspace } from '@universe-editor/extension-api'

const SERVER_NAME = 'universe-editor'

// 清理 0.1.1 及更早版本的 MCP 配置
const SETTINGS_MIGRATION_VERSION = [0, 1, 2] as const

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isVersionLessThan(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < Math.max(version.length, minimum.length); index++) {
    const current = version[index] ?? 0
    const required = minimum[index] ?? 0
    if (current !== required) return current < required
  }
  return false
}

function shouldRemoveLegacyBridgeConfig(value: unknown): boolean {
  const config = asRecord(value)
  const args = config['args']
  if (!Array.isArray(args)) return false
  for (const arg of args) {
    if (typeof arg !== 'string') continue
    const match =
      /[/\\]universe\.universe-editor-mcp-bridge-(\d+)\.(\d+)\.(\d+)[/\\]resources[/\\]bridge[/\\]bridge\.mjs$/i.exec(
        arg,
      )
    if (!match) continue
    return isVersionLessThan(
      [Number(match[1]), Number(match[2]), Number(match[3])],
      SETTINGS_MIGRATION_VERSION,
    )
  }
  return false
}

export async function migrateSettings(): Promise<void> {
  const acpConfig = workspace.getConfiguration('acp')
  const current = asRecord(await acpConfig.get('mcpServers', {}))
  if (!shouldRemoveLegacyBridgeConfig(current[SERVER_NAME])) return

  const next = { ...current }
  delete next[SERVER_NAME]
  await acpConfig.update('mcpServers', next)
  console.info('[universe-editor-mcp-bridge] removed legacy settings entry')
}
