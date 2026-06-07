/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Presentational state for the modal progress dialog. Produced by the host
 *  (editor's ProgressService) and consumed by ProgressDialog — pure data plus a
 *  cancel callback, no service dependency.
 *--------------------------------------------------------------------------------------------*/

export interface DialogProgressState {
  readonly title: string
  readonly message: string | undefined
  /** 0-100, or undefined for indeterminate. */
  readonly percent: number | undefined
  readonly cancellable: boolean
  readonly cancel: () => void
}
