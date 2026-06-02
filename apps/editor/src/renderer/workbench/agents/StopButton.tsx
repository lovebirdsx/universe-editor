import { Square } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import styles from './agents.module.css'

/**
 * Circular Stop control shown next to the Send button while a turn is running.
 * Clicking interrupts the current turn (same as pressing Esc). Kept separate
 * from SendButton so the send action stays available for mid-turn steering.
 */
export function StopButton({ onCancel }: { onCancel: () => void }) {
  const title = localize('acp.stop', 'Stop (Esc)')
  return (
    <button
      type="button"
      className={styles['sendButtonCircle']}
      title={title}
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
