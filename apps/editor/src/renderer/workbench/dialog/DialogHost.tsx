/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DialogHost — React portal host that renders the head of
 *  RendererDialogService's queue as a modal confirm/prompt dialog. The dialog
 *  views themselves live in workbench-ui (ConfirmDialog / PromptDialog).
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { markAsSingleton, type IConfirmResult } from '@universe-editor/platform'
import { ConfirmDialog, OwnerDocumentProvider, PromptDialog } from '@universe-editor/workbench-ui'
import type { RendererDialogService } from '../../services/dialog/RendererDialogService.js'
import {
  getActiveWorkbenchDocument,
  workbenchDocumentOrMain,
} from '../../services/windows/workbenchDocuments.js'

export function DialogHost({ service }: { service: RendererDialogService }) {
  const head = useSyncExternalStore(
    (onChange) => {
      const d = markAsSingleton(service.onDidChange(onChange))
      return () => d.dispose()
    },
    () => service.queue[0],
  )
  if (!head) return null
  // The service settles entries whose document unregisters; `?? head.document`
  // is a type-level fallback (the helper returns undefined only in a DOM-less
  // environment, which this portal host cannot run in).
  const targetDocument = workbenchDocumentOrMain(head.document) ?? head.document
  // A resolving action may have already activated another workbench window;
  // restoring focus into this one would yank the user back (same gate as
  // QuickInputPortal). The activeElement check keeps react-aria's guard for the
  // same-window case: a caller that moved focus right after `await` owns it, so
  // only restore when focus fell back to the body with the dialog's removal.
  const shouldRestoreFocus = () =>
    getActiveWorkbenchDocument() === targetDocument &&
    targetDocument.activeElement === targetDocument.body
  // Key by enqueue identity, not queue position: resolving the head and enqueueing
  // its successor in the same batch keeps queue.length unchanged, so a length-derived
  // key would make React reuse the old instance and carry its checkbox state over.
  const node =
    head.kind === 'confirm' ? (
      <ConfirmDialog
        key={head.id}
        opts={head.opts}
        targetDocument={targetDocument}
        shouldRestoreFocus={shouldRestoreFocus}
        onResolve={(r) => service._resolveEntry<IConfirmResult>(head, r)}
      />
    ) : (
      <PromptDialog
        key={head.id}
        opts={head.opts}
        targetDocument={targetDocument}
        shouldRestoreFocus={shouldRestoreFocus}
        onResolve={(v) => service._resolveEntry<string | undefined>(head, v)}
      />
    )
  return createPortal(
    <OwnerDocumentProvider targetDocument={targetDocument}>{node}</OwnerDocumentProvider>,
    targetDocument.body,
  )
}
