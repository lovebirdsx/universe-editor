import { Square } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { CancelAgentTurnAction } from '../../actions/agentSessionActions.js'
import styles from './agents.module.css'

/**
 * Circular Stop control shown next to the Send button while a turn is running.
 * Clicking interrupts the current turn (same as pressing Shift+Esc). Kept
 * separate from SendButton so the send action stays available for mid-turn
 * steering.
 */
export function StopButton({ onCancel }: { onCancel: () => void }) {
  const title = localize('acp.stop', 'Stop')
  return (
    <button
      type="button"
      className={styles['sendButtonCircle']}
      data-tooltip={title}
      data-tooltip-command={CancelAgentTurnAction.ID}
      aria-label={title}
      onClick={onCancel}
      data-testid="acp-prompt-cancel"
    >
      <span className={styles['sendButtonIcon']} aria-hidden="true">
        <Square size={11} fill="currentColor" />
      </span>
    </button>
  )
}
