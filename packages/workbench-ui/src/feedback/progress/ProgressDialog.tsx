/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProgressDialog — presentational modal progress overlay. The host wraps it in
 *  a portal and feeds it DialogProgressState.
 *--------------------------------------------------------------------------------------------*/

import type { DialogProgressState } from './progressViewModel.js'
import styles from './ProgressDialog.module.css'

export interface ProgressDialogProps {
  readonly state: DialogProgressState
}

export function ProgressDialog({ state }: ProgressDialogProps) {
  const determinate = state.percent !== undefined
  return (
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
    </div>
  )
}
