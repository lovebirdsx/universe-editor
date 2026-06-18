/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SchemaViewerInput — a read-only in-memory tab showing the JSON schema that
 *  applies to a source file. Mirrors UntitledEditorInput's MonacoModelRegistry
 *  plumbing, but the buffer never changes and is never dirty. The resource is
 *  derived from the source file name so opening the same file's schema twice
 *  reuses one tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, localize } from '@universe-editor/platform'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export class SchemaViewerInput extends EditorInput {
  static readonly TYPE_ID = 'schemaViewer'

  private readonly _resource: URI
  private _modelRefAcquired = false

  constructor(
    private readonly _sourceName: string,
    private readonly _content: string,
  ) {
    super()
    this._resource = URI.from({ scheme: 'schema-viewer', path: `/${_sourceName}.schema.json` })
  }

  override get typeId(): string {
    return SchemaViewerInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override getName(): string {
    return localize('schemaViewer.name', 'Schema: {name}', { name: this._sourceName })
  }

  get language(): string {
    return 'json'
  }

  get isReadonly(): boolean {
    return true
  }

  get isResolved(): boolean {
    return true
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
    const model = MonacoModelRegistry.acquire(this._resource, this._content)
    this._modelRefAcquired = true
    return model
  }

  peekModel(): monaco.editor.ITextModel | undefined {
    if (!this._modelRefAcquired) return undefined
    return MonacoModelRegistry.peek(this._resource)
  }

  /** Read-only: nothing to persist, report success so save flows are no-ops. */
  override async save(): Promise<boolean> {
    return true
  }

  /** Read-only: dirty state never updates. */
  updateDirtyFromModel(): void {}

  override dispose(): void {
    if (this._modelRefAcquired) {
      MonacoModelRegistry.release(this._resource)
      this._modelRefAcquired = false
    }
    super.dispose()
  }
}
