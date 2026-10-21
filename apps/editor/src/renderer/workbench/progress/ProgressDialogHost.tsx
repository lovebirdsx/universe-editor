/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProgressDialogHost — subscribes to ProgressService.dialogState and portals the
 *  presentational ProgressDialog (from workbench-ui) into the window that started
 *  the task. Mounted once at the workbench root; renders only when a dialog
 *  progress task is active.
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { IProgressService } from '@universe-editor/platform'
import { OwnerDocumentProvider, ProgressDialog } from '@universe-editor/workbench-ui'
import { useService, useObservable } from '../useService.js'
import type { ProgressService } from '../../services/progress/ProgressService.js'
import { workbenchDocumentOrMain } from '../../services/windows/workbenchDocuments.js'

export function ProgressDialogHost() {
  const service = useService(IProgressService) as ProgressService
  const state = useObservable(service.dialogState)
  const dialogDocument = useObservable(service.dialogDocument)
  if (state === null) return null
  const doc = workbenchDocumentOrMain(dialogDocument)
  if (!doc) return null
  return createPortal(
    <OwnerDocumentProvider targetDocument={doc}>
      <ProgressDialog state={state} />
    </OwnerDocumentProvider>,
    doc.body,
  )
}
