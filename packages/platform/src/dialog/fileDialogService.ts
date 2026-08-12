/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File picker abstraction (open file / folder, save file). Inspired by VSCode's
 *  IFileDialogService — implemented in the renderer as a QuickInput-based browser
 *  (the "simple dialog"), replacing native OS dialogs.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../base/uri.js'
import { createDecorator } from '../di/instantiation.js'

/** A file-type filter group (mirrors Electron's FileFilter / VSCode's dialog filters). */
export interface IFileDialogFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

export interface IFileDialogOptions {
  /** Title bar text (e.g. "Open Folder"). */
  readonly title: string
  /** Folder to start browsing in. Defaults to the workspace / home folder. */
  readonly defaultUri?: URI
  readonly canSelectFiles: boolean
  readonly canSelectFolders: boolean
  /** Allow picking several entries (open dialog only). Defaults to false. */
  readonly canSelectMany?: boolean
  /**
   * File-type filter groups. A listed file must match one extension from any
   * group (case-insensitive, leading dot optional); `*` matches every file.
   * Folders are always listed so the user can keep navigating.
   */
  readonly filters?: readonly IFileDialogFilter[]
  /** Confirm button label (e.g. "Open", "Save"). */
  readonly openLabel?: string
}

export interface IFileDialogService {
  readonly _serviceBrand: undefined
  /**
   * Browse for files or folders; resolves with the chosen URIs (more than one
   * only when `canSelectMany` is set), or `undefined` if cancelled.
   */
  showOpenDialog(opts: IFileDialogOptions): Promise<URI[] | undefined>
  /** Browse for a save location; resolves with the target file URI, or `undefined` if cancelled. */
  showSaveDialog(opts: IFileDialogOptions): Promise<URI | undefined>
}

export const IFileDialogService = createDecorator<IFileDialogService>('fileDialogService')
