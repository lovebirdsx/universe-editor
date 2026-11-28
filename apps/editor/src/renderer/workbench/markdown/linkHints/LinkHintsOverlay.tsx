/*---------------------------------------------------------------------------------------------
 *  LinkHintsOverlay — the vimium-style label layer shared by every markdown
 *  reader (preview, doc center, trigger report, AI chat, extension README).
 *  Rendered as the first child of a `position: relative` scroll container; the
 *  layer itself is `position: fixed` to the viewport.
 *--------------------------------------------------------------------------------------------*/

import type { MarkdownLinkHintsState } from './useMarkdownLinkHints.js'
import styles from './LinkHints.module.css'

export function LinkHintsOverlay({ linkHints }: { readonly linkHints: MarkdownLinkHintsState }) {
  if (!linkHints.active) return null
  return (
    <div className={styles['linkHintsLayer']} data-find-widget aria-hidden="true">
      {linkHints.markers.map((m, i) => (
        <span
          key={i}
          className={styles['linkHint']}
          style={{ left: `${m.left}px`, top: `${m.top}px` }}
          data-testid="md-link-hint"
          data-link-label={m.label}
        >
          {m.label.split('').map((ch, j) => (
            <span
              key={j}
              className={j < linkHints.typed.length ? styles['linkHintTyped'] : undefined}
            >
              {ch}
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}
