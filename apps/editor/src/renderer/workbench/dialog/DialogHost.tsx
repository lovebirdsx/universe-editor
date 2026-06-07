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
  const node =
    head.kind === 'confirm' ? (
      <ConfirmDialog
        key={`c-${service.queue.length}`}
        opts={head.opts}
        onResolve={(r) => service._resolveHead<IConfirmResult>(r)}
      />
    ) : (
      <PromptDialog
        key={`p-${service.queue.length}`}
        opts={head.opts}
        onResolve={(v) => service._resolveHead<string | undefined>(v)}
      />
    )
  return createPortal(node, document.body)
}
