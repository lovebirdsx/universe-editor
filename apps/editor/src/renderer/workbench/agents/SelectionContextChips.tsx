/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SelectionContextChips — the row of attached editor selections shown above the
 *  prompt textarea. Each chip shows `file:line-range`, removes on ×, and reveals
 *  the source selection on click. Pure presentation: state + callbacks come from
 *  PromptInput.
 *--------------------------------------------------------------------------------------------*/

import { FileCode, X } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import type { SelectionContext } from '../../services/acp/acpSessionService.js'
import { formatSelectionLabel } from '../../services/acp/promptContext.js'
import styles from './agents.module.css'

export function SelectionContextChips({
  contexts,
  onRemove,
  onReveal,
}: {
  contexts: readonly SelectionContext[]
  onRemove: (index: number) => void
  onReveal: (ctx: SelectionContext) => void
}) {
  if (contexts.length === 0) return null
  return (
    <div className={styles['contextChips']}>
      {contexts.map((ctx, i) => {
        const label = formatSelectionLabel(ctx)
        return (
          <span
            key={`${ctx.uri}:${ctx.startLine}-${ctx.endLine}:${i}`}
            className={styles['contextChip']}
            title={`${label}\n\n${ctx.text}`}
            onClick={() => onReveal(ctx)}
          >
            <FileCode size={12} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles['contextChipLabel']}>{label}</span>
            <button
              type="button"
              className={styles['contextChipRemove']}
              title={localize('acp.context.remove', 'Remove context')}
              aria-label={localize('acp.context.remove', 'Remove context')}
              onClick={(e) => {
                e.stopPropagation()
                onRemove(i)
              }}
            >
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
        )
      })}
    </div>
  )
}
