/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProgressDialogHost — modal overlay driven by ProgressService.dialogState.
 *  Mounted once at the workbench root; renders only when a dialog progress
 *  task is active.
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { IProgressService } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import type { ProgressService } from '../../services/progress/ProgressService.js'
import styles from './ProgressDialogHost.module.css'

export function ProgressDialogHost() {
  const service = useService(IProgressService) as ProgressService
  const state = useObservable(service.dialogState)
  if (state === null) return null

  const determinate = state.percent !== undefined
  return createPortal(
    <div
      className={styles['backdrop']}
      role="dialog"
      aria-modal="true"
      data-testid="progress-dialog"
    >
      <div className={styles['dialog']}>
        <p className={styles['title']}>{state.title}</p>
        {state.message !== undefined && state.message !== '' && (
          <p className={styles['message']}>{state.message}</p>
        )}
        <div className={styles['progress']}>
          {determinate ? (
            <div className={styles['barDeterminate']} style={{ width: `${state.percent ?? 0}%` }} />
          ) : (
            <div className={styles['barIndeterminate']} />
          )}
        </div>
        {state.cancellable && (
          <div className={styles['buttons']}>
            <button
              type="button"
              className={styles['cancelBtn']}
              onClick={state.cancel}
              data-testid="progress-dialog-cancel"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
