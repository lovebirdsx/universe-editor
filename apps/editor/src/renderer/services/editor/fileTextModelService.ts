/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileTextModelService — override for Monaco's ITextModelService. The standalone
 *  default (`StandaloneTextModelService`) rejects with "Model not found" for any
 *  resource that isn't already an open editor model, so the references peek tree
 *  throws when you expand a file group whose document hasn't been opened yet
 *  (each preview row needs a resolved model). We fix that: resources already
 *  backed by a model are reused; resources the user hasn't opened are read from
 *  disk via IFileService into a registry-managed model, disposed when the peek
 *  releases the reference.
 *
 *  Injected as an `overrideServices` entry at every `editor.create` call site
 *  (collected on MonacoLoader) so Monaco resolves this instance instead of the
 *  standalone one.
 *--------------------------------------------------------------------------------------------*/

import { IFileService, URI } from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'

interface ResolvedTextModel {
  readonly textEditorModel: monaco.editor.ITextModel
  isReadonly(): boolean
  dispose(): void
}

interface TextModelReference {
  readonly object: ResolvedTextModel
  dispose(): void
}

function makeReference(model: monaco.editor.ITextModel, release: () => void): TextModelReference {
  return {
    object: { textEditorModel: model, isReadonly: () => false, dispose() {} },
    dispose: release,
  }
}

export class FileTextModelService {
  constructor(@IFileService private readonly _fileService: IFileService) {}

  async createModelReference(resource: monaco.Uri): Promise<TextModelReference> {
    const monacoNs = MonacoLoader.get()
    const uri = URI.parse(resource.toString())

    // Already registry-managed (an open editor shares it): bump the refcount and
    // release on dispose so the buffer outlives the peek only as long as needed.
    if (MonacoModelRegistry.peek(uri)) {
      const model = MonacoModelRegistry.acquire(uri, '')
      return makeReference(model, () => MonacoModelRegistry.release(uri))
    }

    // A model exists outside the registry (e.g. a diff/log model created
    // directly): borrow it, never dispose what we don't own.
    const existing = monacoNs.editor.getModel(resource)
    if (existing) {
      return makeReference(existing, () => {})
    }

    const text = await this._fileService.readFileText(uri)

    // The model may have appeared while we awaited the read — re-check before
    // creating, otherwise a second createModel on the same URI would throw.
    if (MonacoModelRegistry.peek(uri)) {
      const model = MonacoModelRegistry.acquire(uri, '')
      return makeReference(model, () => MonacoModelRegistry.release(uri))
    }
    const appeared = monacoNs.editor.getModel(resource)
    if (appeared) {
      return makeReference(appeared, () => {})
    }

    const model = MonacoModelRegistry.acquire(uri, text)
    return makeReference(model, () => MonacoModelRegistry.release(uri))
  }
}
