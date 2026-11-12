import type {
  MobileMcpServerEntry,
  MobileMcpSessionSettings,
} from '@universe-editor/mobile-protocol'

/** Mirror of the desktop pool resolution: null = every entry that is not default-disabled. */
export function resolveEnabledMcpNames(
  pool: readonly MobileMcpServerEntry[],
  selection: readonly string[] | null,
): readonly string[] {
  if (selection === null) return pool.filter((server) => !server.defaultDisabled).map((s) => s.name)
  const wanted = new Set(selection)
  return pool.filter((server) => wanted.has(server.name)).map((server) => server.name)
}

/**
 * Build the next whitelist from a checkbox toggle. Inherited defaults become an
 * explicit selection, so a stale pinned name (absent from `enabled`) can never
 * leak into the new list.
 */
export function toggleMcpSelection(
  settings: MobileMcpSessionSettings,
  name: string,
): readonly string[] {
  const enabled = new Set(settings.enabled)
  const base = settings.selection ?? settings.enabled
  return enabled.has(name) ? base.filter((entry) => entry !== name) : [...base, name]
}

export type McpStatusTone = 'ok' | 'error' | 'pending'

/** Raw agent status → the dot tone the sheet paints. */
export function mcpStatusTone(status: string): McpStatusTone {
  if (status === 'connected') return 'ok'
  if (status === 'failed' || status === 'needs-auth' || status === 'needs_auth') return 'error'
  return 'pending'
}
