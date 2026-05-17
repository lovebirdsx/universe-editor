/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MonacoModelRegistry — reference-counted URI ↔ ITextModel registry.
 *
 *  In VSCode, a single TextModel can back any number of editors. We model that
 *  here so two FileEditorInputs pointing at the same URI (e.g. opened in two
 *  split groups) share one model: edits in one view are visible in the other,
 *  and the underlying buffer is only disposed once all consumers release it.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import type { monaco } from './MonacoLoader.js'
import { MonacoLoader } from './MonacoLoader.js'

const LANG_BY_EXT: Record<string, string> = {
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'plaintext',
  '.ini': 'ini',
  '.sh': 'shell',
}

export function languageForResource(resource: URI): string {
  const path = resource.path
  const dot = path.lastIndexOf('.')
  if (dot === -1) return 'plaintext'
  const ext = path.slice(dot).toLowerCase()
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

interface Entry {
  readonly model: monaco.editor.ITextModel
  refs: number
}

class Registry {
  private readonly _entries = new Map<string, Entry>()

  /**
   * Acquire a TextModel for `resource`. Creates it (with `text` as initial
   * content) on first call; subsequent callers receive the existing model and
   * bump its refcount. The `text` argument is **ignored** when an entry
   * already exists — callers wanting to overwrite should mutate the model
   * directly via `model.setValue()`.
   */
  acquire(resource: URI, text: string): monaco.editor.ITextModel {
    const key = resource.toString()
    const existing = this._entries.get(key)
    if (existing) {
      existing.refs++
      return existing.model
    }
    const m = MonacoLoader.get()
    const uri = m.Uri.parse(resource.toString())
    const language = languageForResource(resource)
    const model = m.editor.createModel(text, language, uri)
    this._entries.set(key, { model, refs: 1 })
    return model
  }

  /** Look up an existing model without changing its refcount. */
  peek(resource: URI): monaco.editor.ITextModel | undefined {
    return this._entries.get(resource.toString())?.model
  }

  /**
   * Release one reference; if the refcount drops to zero the model is disposed
   * and removed from the registry. Calls past the last release are no-ops.
   */
  release(resource: URI): void {
    const key = resource.toString()
    const entry = this._entries.get(key)
    if (!entry) return
    entry.refs--
    if (entry.refs <= 0) {
      this._entries.delete(key)
      entry.model.dispose()
    }
  }

  /** Test-only: drop everything. */
  _resetForTests(): void {
    for (const entry of this._entries.values()) entry.model.dispose()
    this._entries.clear()
  }
}

export const MonacoModelRegistry = new Registry()
