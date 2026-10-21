/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DialogHost — React portal host that renders the head of
 *  RendererDialogService's queue as a modal confirm/prompt dialog. The dialog
 *  views themselves live in workbench-ui (ConfirmDialog / PromptDialog).
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { markAsSingleton, type IConfirmResult } from '@universe-editor/platform'
import { ConfirmDialog, PromptDialog } from '@universe-editor/workbench-ui'
import type { RendererDialogService } from '../../services/dialog/RendererDialogService.js'

export function DialogHost({ service }: { service: RendererDialogService }) {
  const head = useSyncExternalStore(
    (onChange) => {
      const d = markAsSingleton(service.onDidChange(onChange))
      return () => d.dispose()
    },
    () => service.queue[0],
  )
  if (!head) return null
  // Key by enqueue identity, not queue position: resolving the head and enqueueing
  // its successor in the same batch keeps queue.length unchanged, so a length-derived
  // key would make React reuse the old instance and carry its checkbox state over.
  const node =
    head.kind === 'confirm' ? (
      <ConfirmDialog
        key={head.id}
        opts={head.opts}
        targetDocument={head.document}
        onResolve={(r) => service._resolveEntry<IConfirmResult>(head, r)}
      />
    ) : (
      <PromptDialog
        key={head.id}
        opts={head.opts}
        targetDocument={head.document}
        onResolve={(v) => service._resolveEntry<string | undefined>(head, v)}
      />
    )
  return createPortal(node, head.document.body)
}
