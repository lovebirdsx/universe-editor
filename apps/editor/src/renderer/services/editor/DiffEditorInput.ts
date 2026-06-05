/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditorInput — a transient, read-only EditorInput that drives the Monaco
 *  diff editor. Holds original and modified text for a single file.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, Emitter, URI, type Event } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'

export class DiffEditorInput extends EditorInput {
  static readonly TYPE_ID = 'diff'

  private readonly _onDidChangeContent = this._register(new Emitter<void>())
  /** Fires when original/modified content is refreshed in place (e.g. after a discard). */
  readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event

  constructor(
    private readonly _originalUri: URI,
    private _originalContent: string,
    private _modifiedContent: string,
  ) {
    super()
  }

  override get typeId(): string {
    return DiffEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'diff', path: this._originalUri.path })
  }

  override get id(): string {
    return `diff:${this._originalUri.toString()}`
  }

  override getName(): string {
    return `${basenameOfResource(this._originalUri)} (Diff)`
  }

  get originalUri(): URI {
    return this._originalUri
  }

  get originalContent(): string {
    return this._originalContent
  }

  get modifiedContent(): string {
    return this._modifiedContent
  }

  /** Refresh both sides in place and notify the mounted DiffEditor to re-render. */
  update(originalContent: string, modifiedContent: string): void {
    if (this._originalContent === originalContent && this._modifiedContent === modifiedContent) {
      return
    }
    this._originalContent = originalContent
    this._modifiedContent = modifiedContent
    this._onDidChangeContent.fire()
  }
}
