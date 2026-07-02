/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptImageChips — the row of attached image thumbnails shown above the
 *  prompt textarea. Each chip shows an 88×88 thumbnail (shared ChatImage control,
 *  click opens the lightbox) and removes on ×. Pure presentation: state +
 *  callbacks come from PromptInput. Mirrors SelectionContextChips.
 *--------------------------------------------------------------------------------------------*/

import { X } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import type { PromptImage } from '../../services/acp/promptImage.js'
import { ChatImage } from './ChatImage.js'
import styles from './agents.module.css'

export function PromptImageChips({
  images,
  onRemove,
}: {
  images: readonly PromptImage[]
  onRemove: (id: string) => void
}) {
  if (images.length === 0) return null
  return (
    <div className={styles['imageChips']} data-testid="acp-prompt-image-chips">
      {images.map((img) => {
        const src = `data:${img.mimeType};base64,${img.dataBase64}`
        const label = img.name ?? formatBytes(img.byteSize)
        return (
          <span key={img.id} className={styles['imageChip']} title={label}>
            <ChatImage src={src} alt={label} mimeType={img.mimeType} />
            <button
              type="button"
              className={styles['imageChipRemove']}
              title={localize('acp.image.remove', 'Remove image')}
              aria-label={localize('acp.image.remove', 'Remove image')}
              onClick={() => onRemove(img.id)}
            >
              <X size={11} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </span>
        )
      })}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
