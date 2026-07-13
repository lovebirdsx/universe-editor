/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditorInput — a transient, read-only EditorInput that drives the Monaco
 *  diff editor. Holds original and modified text for a single file.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, Emitter, URI, type Event } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
export class DiffEditorInput extends EditorInput {
  static readonly TYPE_ID: string = 'diff'

  private readonly _onDidChangeContent = this._register(new Emitter<void>())
  /** Fires when original/modified content is refreshed in place (e.g. after a discard). */
  readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event

  constructor(
    private readonly _originalUri: URI,
    private _originalContent: string,
    private _modifiedContent: string,
    private readonly _modifiedUri?: URI,
    private readonly _openableResource?: URI,
  ) {
    super()
  }

  override get typeId(): string {
    return DiffEditorInput.TYPE_ID
  }

  /** True when the two sides are different files (Explorer "Compare With…"). */
  private get _isCrossFile(): boolean {
    return (
      this._modifiedUri !== undefined &&
      this._modifiedUri.toString() !== this._originalUri.toString()
    )
  }

  /**
   * True for a cross-file comparison (Explorer "Compare"), where the two sides are
   * distinct files. Live-content sync contributions key off `originalUri` and would
   * otherwise clobber the modified side with the original file's content — they must
   * skip these.
   */
  get isCrossFile(): boolean {
    return this._isCrossFile
  }

  override get resource(): URI {
    if (this._isCrossFile) {
      return URI.from({
        scheme: 'diff',
        path: `${this._originalUri.path}↔${this._modifiedUri!.path}`,
      })
    }
    return URI.from({ scheme: 'diff', path: this._originalUri.path })
  }

  override get id(): string {
    if (this._isCrossFile) {
      return `diff:${this._originalUri.toString()}↔${this._modifiedUri!.toString()}`
    }
    return `diff:${this._originalUri.toString()}`
  }

  override getName(): string {
    if (this._isCrossFile) {
      return `${basenameOfResource(this._originalUri)} ↔ ${basenameOfResource(this._modifiedUri!)}`
    }
    return `${basenameOfResource(this._originalUri)} (Diff)`
  }

  get originalUri(): URI {
    return this._originalUri
  }

  /** The right-hand side's file URI. Falls back to the original for same-file diffs. */
  get modifiedUri(): URI {
    return this._modifiedUri ?? this._originalUri
  }

  /**
   * The real, on-disk file this diff should open when the user clicks "Open File"
   * in the diff editor title bar. Undefined when there is no such file — e.g. an
   * Explorer cross-file compare (no single "source"), or a diff whose sides are
   * depot/revision blobs with no local counterpart — in which case the title-bar
   * button is hidden rather than opening a bogus path.
   */
  get openableResource(): URI | undefined {
    return this._openableResource
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

  /** Absorb newer content when the workbench reuses this tab for a re-opened
   *  diff of the same file (the file changed again while the tab was open). */
  override updateFrom(other: EditorInput): void {
    if (other instanceof DiffEditorInput) {
      this.update(other._originalContent, other._modifiedContent)
    }
  }
}
