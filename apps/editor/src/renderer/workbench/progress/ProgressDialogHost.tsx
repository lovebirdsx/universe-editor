/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProgressDialogHost — subscribes to ProgressService.dialogState and portals the
 *  presentational ProgressDialog (from workbench-ui). Mounted once at the
 *  workbench root; renders only when a dialog progress task is active.
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { IProgressService } from '@universe-editor/platform'
import { ProgressDialog } from '@universe-editor/workbench-ui'
import { useService, useObservable } from '../useService.js'
import type { ProgressService } from '../../services/progress/ProgressService.js'

export function ProgressDialogHost() {
  const service = useService(IProgressService) as ProgressService
  const state = useObservable(service.dialogState)
  if (state === null) return null
  return createPortal(<ProgressDialog state={state} />, document.body)
}
