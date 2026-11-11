import { useState } from 'react'
import type { ReadableStore } from '../state/store.js'
import { useStore } from '../state/useStore.js'
import { strings } from '../strings.js'
import type { WebBuildMismatch } from '../webBuildId.js'

export interface UpdateBannerProps {
  readonly mismatchStore: ReadableStore<WebBuildMismatch | undefined>
  readonly onReload?: () => void
}

/**
 * The PC rebuilds `apps/mobile/dist` on every editor build. A page left open
 * keeps running its old JS, so `hello_ok` compares the entry script names and
 * this banner asks for the one action that actually switches bundles.
 */
export function UpdateBanner({ mismatchStore, onReload }: UpdateBannerProps) {
  const mismatch = useStore(mismatchStore)
  const [dismissedBuildId, setDismissedBuildId] = useState<string | undefined>(undefined)
  if (mismatch === undefined || mismatch.serverBuildId === dismissedBuildId) return null

  const reload = onReload ?? ((): void => window.location.reload())
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      <span className="update-banner__text">{strings.updateAvailable}</span>
      <button type="button" className="update-banner__reload" onClick={reload}>
        {strings.updateReload}
      </button>
      <button
        type="button"
        className="update-banner__dismiss"
        aria-label={strings.updateDismiss}
        onClick={() => setDismissedBuildId(mismatch.serverBuildId)}
      >
        ×
      </button>
    </div>
  )
}
