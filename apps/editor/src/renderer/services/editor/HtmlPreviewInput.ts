/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HtmlPreviewInput — a virtual EditorInput that renders an HTML file in a live
 *  iframe (our equivalent of VSCode's Live Preview, opened on demand rather than
 *  as the default editor for .html). It carries the source `file:` URI; the
 *  HtmlPreviewEditor component navigates an iframe straight at the file over the
 *  `universe-app://` resource protocol, so relative assets (css/js/images) load
 *  from the document's own directory.
 *
 *  When opened via "Open Preview" (Ctrl+Shift+V) it holds a strong reference to
 *  the original FileEditorInput so its Monaco model stays alive through the
 *  toggle cycle (source tab is detached but not disposed). Mirrors
 *  MarkdownPreviewInput.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, type UriComponents } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'
import type { FileEditorInput } from './FileEditorInput.js'

interface ISerializedHtmlPreview {
  readonly sourceResource: UriComponents
}

export class HtmlPreviewInput extends EditorInput {
  static readonly TYPE_ID = 'html.preview'

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
    return HtmlPreviewInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'html-preview', path: this._sourceUri.path })
  }

  /** Unique per source file so the same file never opens two preview tabs. */
  override get id(): string {
    return `html-preview:${this._sourceUri.toString()}`
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
   * Take ownership of the held source's lifecycle after it has been detached
   * from its editor group (detachEditor cuts the parent chain without disposing
   * it). Rooting it here keeps it off the leak tracker's parentless set and ties
   * its disposal to the preview's.
   */
  adoptSource(): void {
    if (this._sourceInput) this._register(this._sourceInput)
  }

  /**
   * Hands back the held FileEditorInput and clears the internal reference so
   * dispose() won't touch it. Called by OpenHtmlSourceAction before re-adding
   * the source to the editor group.
   */
  releaseSource(): FileEditorInput | undefined {
    const input = this._sourceInput
    this._sourceInput = undefined
    if (input) this._store.deleteAndLeak(input)
    return input
  }

  override get isDirty(): boolean {
    return this._sourceInput?.isDirty ?? false
  }

  override async save(): Promise<boolean> {
    return (await this._sourceInput?.save?.()) ?? true
  }

  override serialize(): ISerializedHtmlPreview {
    return { sourceResource: this._sourceUri.toJSON() }
  }

  static deserialize(data: unknown): HtmlPreviewInput | null {
    const d = data as ISerializedHtmlPreview | null
    if (!d || !d.sourceResource) return null
    return new HtmlPreviewInput(URI.revive(d.sourceResource) as URI)
  }

  override dispose(): void {
    this._sourceInput = undefined
    super.dispose()
  }
}
