/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IEditorResolverService.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { IDisposable } from '../base/lifecycle.js'
import type { URI } from '../base/uri.js'
import type { EditorInput } from './editorService.js'

export interface IEditorResolverInfo {
  typeId: string
  displayName: string
  /**
   * Priority determines which registration wins when multiple match the same URI.
   * Suggested values: builtin=1, registered=100, override=1000.
   * Defaults to 1 if not provided.
   */
  priority?: number
}

export interface IEditorResolverRegistration {
  readonly glob: string
  readonly info: Required<IEditorResolverInfo>
  readonly factory: (uri: URI) => EditorInput
}

export interface IEditorResolverService {
  readonly _serviceBrand: undefined

  /**
   * Register an editor factory for a glob pattern. Returns a disposable that
   * removes the registration when disposed.
   *
   * Registering the same (typeId, glob) combination twice emits a warning and
   * returns a no-op disposable.
   */
  registerEditor(
    glob: string,
    info: IEditorResolverInfo,
    factory: (uri: URI) => EditorInput,
  ): IDisposable

  /**
   * Returns all registrations whose glob matches `uri`, sorted by priority
   * descending (highest priority first). Callers use this to populate
   * "Reopen With..." picker items.
   */
  resolveEditors(uri: URI): IEditorResolverRegistration[]

  /**
   * Resolve the best editor for `uri` and open it in the active editor group.
   *
   * - `preferredTypeId`: if specified, selects the matching registration over
   *   the highest-priority one (used by "Reopen With...").
   * - `pinned`: passed through to IEditorService.openEditor (default true).
   *
   * Falls back to creating a FileEditorInput when no registration matches.
   */
  openEditor(uri: URI, options?: { preferredTypeId?: string; pinned?: boolean }): Promise<void>
}

export const IEditorResolverService =
  createDecorator<IEditorResolverService>('editorResolverService')
