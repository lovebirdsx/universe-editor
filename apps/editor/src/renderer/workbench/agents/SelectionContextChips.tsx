/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SelectionContextChips — the row of attached editor selections shown above the
 *  prompt textarea or inside a submitted user message. Each chip shows
 *  `file:line-range` and reveals the source selection on click. Editable prompt
 *  chips also expose ×; submitted-message chips omit `onRemove` and stay read-only.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { FileCode, X } from 'lucide-react'
import { IOpenerService, localize, URI, withSelection } from '@universe-editor/platform'
import type { SelectionContext } from '../../services/acp/session/acpSessionService.js'
import { formatSelectionLabel } from '../../services/acp/promptContext.js'
import { useOptionalService } from '../useService.js'
import styles from './agents.module.css'

export function useSelectionContextReveal(): (context: SelectionContext) => void {
  const openerService = useOptionalService(IOpenerService)
  return useCallback(
    (context: SelectionContext): void => {
      if (!openerService) return
      let resource: URI
      try {
        resource = URI.parse(context.uri)
      } catch {
        return
      }
      const target = withSelection(resource, {
        startLineNumber: context.startLine,
        startColumn: 1,
        endLineNumber: context.endLine,
        endColumn: 1,
      })
      void openerService.open(target, { fromUserGesture: true })
    },
    [openerService],
  )
}

export function SelectionContextChips({
  contexts,
  onRemove,
  onReveal,
}: {
  contexts: readonly SelectionContext[]
  onRemove?: (index: number) => void
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
            data-testid="acp-selection-context-chip"
            data-tooltip={`${label}\n\n${ctx.text}`}
            data-context-text={ctx.text}
            onClick={() => onReveal(ctx)}
          >
            <FileCode size={12} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles['contextChipLabel']}>{label}</span>
            {onRemove !== undefined && (
              <button
                type="button"
                className={styles['contextChipRemove']}
                data-tooltip={localize('acp.context.remove', 'Remove context')}
                aria-label={localize('acp.context.remove', 'Remove context')}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(i)
                }}
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}
