import type { MobileMcpSessionSettings } from '@universe-editor/mobile-protocol'
import { BottomSheet } from '../components/BottomSheet.js'
import { strings } from '../strings.js'
import { mcpStatusTone } from './sessionSettings.js'

export interface McpServersSheetProps {
  readonly settings: MobileMcpSessionSettings
  readonly online: boolean
  readonly busy: boolean
  readonly onToggle: (name: string) => void
  readonly onReset: () => void
  readonly onClose: () => void
}

/** Session-level MCP enablement over the pool the PC resolved for this agent. */
export function McpServersSheet({
  settings,
  online,
  busy,
  onToggle,
  onReset,
  onClose,
}: McpServersSheetProps) {
  const enabled = new Set(settings.enabled)
  const live = new Map(settings.live.map((server) => [server.name, server.status]))
  const custom = settings.selection !== null

  return (
    <BottomSheet
      title={strings.mcpSheetTitle}
      icon="🔌"
      testId="mcp-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
    >
      <div className="mcp-sheet__state">
        <span>{custom ? strings.mcpCustomSelection : strings.mcpFollowingDefaults}</span>
        {custom && (
          <button
            type="button"
            data-testid="mcp-reset"
            disabled={busy || !online}
            onClick={onReset}
          >
            {strings.mcpReset}
          </button>
        )}
      </div>
      {settings.pool.length === 0 ? (
        <p className="sheet__hint">{strings.mcpEmpty}</p>
      ) : (
        <ul className="mcp-servers">
          {settings.pool.map((server) => {
            const status = live.get(server.name)
            return (
              <li key={server.name}>
                <label
                  className="sheet-checkbox mcp-server-row"
                  data-testid="mcp-server-row"
                  data-name={server.name}
                  data-status={status}
                >
                  <input
                    type="checkbox"
                    checked={enabled.has(server.name)}
                    disabled={busy || !online}
                    onChange={() => onToggle(server.name)}
                  />
                  {status !== undefined && (
                    <span
                      className="mcp-status-dot"
                      data-tone={mcpStatusTone(status)}
                      aria-hidden="true"
                    />
                  )}
                  <span className="mcp-server-row__name">{server.name}</span>
                  {server.defaultDisabled && (
                    <span className="mcp-default-badge">{strings.mcpDefaultOff}</span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <p className="sheet__hint">{strings.mcpCacheHint}</p>
      {!online && <p className="sheet__hint sheet__hint--danger">{strings.pendingOffline}</p>}
    </BottomSheet>
  )
}
