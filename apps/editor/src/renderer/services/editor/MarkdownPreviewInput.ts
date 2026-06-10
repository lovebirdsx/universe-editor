/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewInput — a virtual EditorInput that renders a markdown file as
 *  formatted HTML. It carries the source `file:` URI; the live text is read from
 *  the shared Monaco model (so the preview tracks unsaved edits) or, when the
 *  source is not open, from disk by the MarkdownPreviewEditor component.
 *
 *  When opened via "Open Preview" (Ctrl+Shift+V), the preview holds a strong
 *  reference to the original FileEditorInput so the Monaco model stays alive
 *  through the toggle cycle (source tab is detached but not disposed). Closing
 *  the preview without switching back disposes the held source input and
 *  releases the model.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, type UriComponents } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
import type { FileEditorInput } from './FileEditorInput.js'

interface ISerializedMarkdownPreview {
  readonly sourceResource: UriComponents
}

export class MarkdownPreviewInput extends EditorInput {
  static readonly TYPE_ID = 'markdown.preview'

  private readonly _sourceUri: URI
  /** Held when the preview was opened in "toggle" mode (source tab replaced). */
  private _sourceInput: FileEditorInput | undefined

  constructor(source: URI | FileEditorInput) {
    super()
    if (source instanceof URI) {
      this._sourceUri = source
    } else {
      this._sourceUri = source.resource as URI
      this._sourceInput = source
    }
  }

  override get typeId(): string {
    return MarkdownPreviewInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'markdown-preview', path: this._sourceUri.path })
  }

  /** Unique per source file so the same file never opens two preview tabs. */
  override get id(): string {
    return `markdown-preview:${this._sourceUri.toString()}`
  }

  override getName(): string {
    return `预览 ${basenameOfResource(this._sourceUri)}`
  }

  get sourceUri(): URI {
    return this._sourceUri
  }

  /** Returns the held FileEditorInput only when opened in toggle mode. */
  get sourceInput(): FileEditorInput | undefined {
    return this._sourceInput
  }

  /**
   * Hands back the held FileEditorInput and clears the internal reference so
   * that dispose() won't touch it. Called by OpenMarkdownSourceAction before
   * re-adding the source to the editor group.
   */
  releaseSource(): FileEditorInput | undefined {
    const input = this._sourceInput
    this._sourceInput = undefined
    return input
  }

  override get isDirty(): boolean {
    return this._sourceInput?.isDirty ?? false
  }

  override async save(): Promise<boolean> {
    return (await this._sourceInput?.save?.()) ?? true
  }

  override serialize(): ISerializedMarkdownPreview {
    return { sourceResource: this._sourceUri.toJSON() }
  }

  static deserialize(data: unknown): MarkdownPreviewInput | null {
    const d = data as ISerializedMarkdownPreview | null
    if (!d || !d.sourceResource) return null
    return new MarkdownPreviewInput(URI.revive(d.sourceResource) as URI)
  }

  override dispose(): void {
    if (this._sourceInput) {
      this._sourceInput.dispose()
      this._sourceInput = undefined
    }
    super.dispose()
  }
}
