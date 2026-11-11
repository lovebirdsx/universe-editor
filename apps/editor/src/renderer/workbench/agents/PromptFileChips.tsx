/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only chips for non-image attachments uploaded by the phone. The PC has
 *  no file picker of its own; these travel with the shared draft and are sent
 *  with the prompt. Mirrors SelectionContextChips.
 *--------------------------------------------------------------------------------------------*/

import { FileText, X } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import type { PromptFileAttachment } from '../../services/acp/promptAttachment.js'
import styles from './agents.module.css'

export function PromptFileChips({
  files,
  onRemove,
}: {
  files: readonly PromptFileAttachment[]
  onRemove: (id: string) => void
}) {
  if (files.length === 0) return null
  return (
    <div className={styles['contextChips']} data-testid="acp-prompt-file-chips">
      {files.map((file) => (
        <span key={file.id} className={styles['contextChip']} data-tooltip={file.name}>
          <FileText size={11} strokeWidth={2} aria-hidden="true" />
          <span className={styles['contextChipLabel']}>
            {file.name} · {formatBytes(file.byteSize)}
          </span>
          <button
            type="button"
            className={styles['contextChipRemove']}
            data-tooltip={localize('acp.fileAttachment.remove', 'Remove attachment')}
            aria-label={localize('acp.fileAttachment.remove', 'Remove attachment')}
            onClick={() => onRemove(file.id)}
          >
            <X size={11} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
