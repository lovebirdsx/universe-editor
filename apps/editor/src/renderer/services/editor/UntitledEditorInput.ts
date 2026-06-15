/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  UntitledEditorInput — a tabbed buffer without a backing file. Save delegates
 *  to Save-As, which writes the text to a user-picked location and replaces
 *  this input with a FileEditorInput.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export class UntitledEditorInput extends EditorInput {
  static readonly TYPE_ID = 'untitled'
  private static _counter = 1

  private readonly _resource: URI
  private readonly _name: string
  private _content: string
  private _modelRefAcquired = false

  constructor(restoredName?: string, restoredContent?: string) {
    super()
    if (restoredName) {
      this._name = restoredName
    } else {
      const n = UntitledEditorInput._counter++
      this._name = `Untitled-${n}`
    }
    this._resource = URI.from({ scheme: 'untitled', path: '/' + this._name })
    this._content = restoredContent ?? ''
  }

  override get typeId(): string {
    return UntitledEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override getName(): string {
    return this._name
  }

  async resolve(): Promise<string> {
    return this._content
  }

  async resolveModel(): Promise<monaco.editor.ITextModel> {
    if (this._modelRefAcquired) {
      const existing = MonacoModelRegistry.peek(this._resource)
      if (existing) return existing
      this._modelRefAcquired = false
    }
    const text = await this.resolve()
    const model = MonacoModelRegistry.acquire(this._resource, text)
    this._modelRefAcquired = true
    return model
  }

  /**
   * The already-acquired model, if any — lets FileEditor swap synchronously
   * (before paint) when switching back to this buffer. See FileEditorInput.peekModel.
   */
  peekModel(): monaco.editor.ITextModel | undefined {
    if (!this._modelRefAcquired) return undefined
    return MonacoModelRegistry.peek(this._resource)
  }

  get backupContent(): string {
    return ''
  }

  /** Untitled buffers are dirty whenever they hold any text. */
  updateDirtyFromModel(model: monaco.editor.ITextModel): void {
    this.setDirty(model.getValue() !== '')
  }

  get language(): string {
    return 'plaintext'
  }

  get isResolved(): boolean {
    return true
  }

  /**
   * Returning false tells callers (`SaveFileAction`) that the buffer cannot be
   * saved in place — they should fall back to Save-As.
   */
  override async save(): Promise<boolean> {
    return false
  }

  override async revert(): Promise<void> {
    MonacoModelRegistry.peek(this._resource)?.setValue('')
    this.setDirty(false)
  }

  override serialize(): { name: string; content: string } {
    const model = MonacoModelRegistry.peek(this._resource)
    return { name: this._name, content: model?.getValue() ?? this._content }
  }

  static deserialize(data: unknown): UntitledEditorInput | null {
    const d = data as { name?: string; content?: string } | null
    if (!d?.name) return null
    const match = /^Untitled-(\d+)$/.exec(d.name)
    if (match) {
      const n = parseInt(match[1]!, 10)
      if (n >= UntitledEditorInput._counter) UntitledEditorInput._counter = n + 1
    }
    return new UntitledEditorInput(d.name, d.content ?? '')
  }

  override dispose(): void {
    if (this._modelRefAcquired) {
      MonacoModelRegistry.release(this._resource)
      this._modelRefAcquired = false
    }
    super.dispose()
  }
}
