/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Minimal modal dialog abstraction (confirm / prompt).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'

export interface IConfirmOptions {
  readonly message: string
  readonly detail?: string
  readonly primaryButton?: string
  readonly cancelButton?: string
  /** Optional middle button — enables the three-button "Save / Don't Save / Cancel" shape. */
  readonly secondaryButton?: string
  /** When set, renders an extra button that copies `detail` to the clipboard without closing the dialog. */
  readonly copyButton?: string
  readonly type?: 'info' | 'warning' | 'error'
}

export interface IConfirmResult {
  /** True when the user picked the primary button. */
  readonly confirmed: boolean
  readonly choice: 'primary' | 'secondary' | 'cancel'
}

export interface IPromptOptions {
  readonly title: string
  readonly placeholder?: string
  readonly initialValue?: string
}

export interface IDialogService {
  readonly _serviceBrand: undefined
  confirm(opts: IConfirmOptions): Promise<IConfirmResult>
  /** Resolves with the entered string, or `undefined` if the user cancelled. */
  prompt(opts: IPromptOptions): Promise<string | undefined>
}

export const IDialogService = createDecorator<IDialogService>('dialogService')
