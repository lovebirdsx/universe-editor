/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Minimal modal dialog abstraction (confirm / prompt).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'

export interface IConfirmCheckbox {
  readonly label: string
  readonly initiallyChecked?: boolean
}

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
  /** When set, renders a "don't ask again" checkbox at the bottom of the dialog. */
  readonly neverAskAgainLabel?: string
  /** When set, renders one generic checkbox row per entry (e.g. action toggles);
   *  their final states are echoed in {@link IConfirmResult.checkboxChecked} in
   *  the same order. Independent of `neverAskAgainLabel` — both may coexist. */
  readonly checkboxes?: IConfirmCheckbox[]
}

export interface IConfirmResult {
  /** True when the user picked the primary button. */
  readonly confirmed: boolean
  readonly choice: 'primary' | 'secondary' | 'cancel'
  /** True when the user checked the "don't ask again" checkbox. */
  readonly neverAskAgain?: boolean
  /** Final states of {@link IConfirmOptions.checkboxes}, same order, echoed on
   *  every exit path. */
  readonly checkboxChecked?: boolean[]
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
