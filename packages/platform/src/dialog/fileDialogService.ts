/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File picker abstraction (open file / folder, save file). Inspired by VSCode's
 *  IFileDialogService — implemented in the renderer as a QuickInput-based browser
 *  (the "simple dialog"), replacing native OS dialogs.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../base/uri.js'
import { createDecorator } from '../di/instantiation.js'

export interface IFileDialogOptions {
  /** Title bar text (e.g. "Open Folder"). */
  readonly title: string
  /** Folder to start browsing in. Defaults to the workspace / home folder. */
  readonly defaultUri?: URI
  readonly canSelectFiles: boolean
  readonly canSelectFolders: boolean
  /** Confirm button label (e.g. "Open", "Save"). */
  readonly openLabel?: string
}

export interface IFileDialogService {
  readonly _serviceBrand: undefined
  /** Browse for a file or folder; resolves with the chosen URI, or `undefined` if cancelled. */
  showOpenDialog(opts: IFileDialogOptions): Promise<URI | undefined>
  /** Browse for a save location; resolves with the target file URI, or `undefined` if cancelled. */
  showSaveDialog(opts: IFileDialogOptions): Promise<URI | undefined>
}

export const IFileDialogService = createDecorator<IFileDialogService>('fileDialogService')
