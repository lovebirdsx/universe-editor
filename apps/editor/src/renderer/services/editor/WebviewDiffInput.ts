/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WebviewDiffInput — a transient, read-only EditorInput backed by an extension's
 *  custom editor, opened as a two-content comparison (via the internal command
 *  `_workbench.openWebviewDiff`) rather than a single file. Rendered by
 *  CustomEditorHost, which opens a webview panel carrying the two sides' bytes and
 *  hands them to the owning extension's `resolveCustomEditor` as `panel.diffContext`.
 *
 *  Like DiffEditorInput it is transient: it holds the left/right bytes in memory
 *  (a Git HEAD blob / Perforce have-revision may not exist on disk), so there is
 *  no deserialize — a webview diff tab does not survive a window restore, matching
 *  the built-in diff editor.
 *
 *  Identity is namespaced by `viewType` + both URIs so a diff stays distinct from
 *  the single-file custom editor of the same resource and from other comparisons.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'
import { WebviewFocusRegistry } from './WebviewFocusRegistry.js'

export class WebviewDiffInput extends EditorInput {
  static readonly TYPE_ID = 'webviewDiff'

  constructor(
    private readonly _viewType: string,
    private readonly _leftUri: URI,
    private readonly _rightUri: URI,
    private readonly _left: Uint8Array,
    private readonly _right: Uint8Array,
    private readonly _title: string,
  ) {
    super()
  }

  get viewType(): string {
    return this._viewType
  }

  get leftUri(): URI {
    return this._leftUri
  }

  get rightUri(): URI {
    return this._rightUri
  }

  get left(): Uint8Array {
    return this._left
  }

  get right(): Uint8Array {
    return this._right
  }

  get title(): string {
    return this._title
  }

  override get typeId(): string {
    return WebviewDiffInput.TYPE_ID
  }

  /** The right-hand (modified) side is the resource the tab represents (icon, decorations). */
  override get resource(): URI {
    return this._rightUri
  }

  /** Namespaced by viewType + both URIs so the diff stays a distinct tab. */
  override get id(): string {
    return `webviewDiff:${this._viewType}:${this._leftUri.toString()}↔${this._rightUri.toString()}`
  }

  override getName(): string {
    return this._title
  }

  /** Move keyboard focus into the webview iframe (see CustomEditorInput.focus). */
  override focus(): boolean {
    return WebviewFocusRegistry.requestFocus(this._viewType, this._rightUri)
  }
}
