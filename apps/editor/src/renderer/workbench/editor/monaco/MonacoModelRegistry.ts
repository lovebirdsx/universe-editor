/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MonacoModelRegistry — reference-counted URI ↔ ITextModel registry.
 *
 *  In VSCode, a single TextModel can back any number of editors. We model that
 *  here so two FileEditorInputs pointing at the same URI (e.g. opened in two
 *  split groups) share one model: edits in one view are visible in the other,
 *  and the underlying buffer is only disposed once all consumers release it.
 *--------------------------------------------------------------------------------------------*/

import { URI, canonicalResourceKey } from '@universe-editor/platform'
import type { monaco } from './MonacoLoader.js'
import { MonacoLoader } from './MonacoLoader.js'
import { languageForResource } from '../../files/resourceLanguage.js'

export { languageForResource }

interface Entry {
  readonly model: monaco.editor.ITextModel
  refs: number
  /** Whether this registry created the model (and so may dispose it). A model
   *  adopted via `getModel` belongs to someone else — never dispose it. */
  readonly owned: boolean
}

class Registry {
  private readonly _entries = new Map<string, Entry>()

  /**
   * Acquire a TextModel for `resource`. Creates it (with `text` as initial
   * content) on first call; subsequent callers receive the existing model and
   * bump its refcount. The `text` argument is **ignored** when an entry
   * already exists — callers wanting to overwrite should mutate the model
   * directly via `model.setValue()`.
   *
   * Keyed by {@link canonicalResourceKey} so the same file reached via an
   * uppercase-drive platform URI (an open editor) and a lowercased one (a value
   * round-tripped through Monaco, e.g. a workspace-symbol target) maps to a
   * single entry and model — otherwise the second `createModel` for what Monaco
   * sees as one URI throws "Cannot add model because it already exists!".
   */
  acquire(resource: URI, text: string): monaco.editor.ITextModel {
    const m = MonacoLoader.get()
    const uri = m.Uri.parse(resource.toString())
    const key = canonicalResourceKey(resource)
    const existing = this._entries.get(key)
    if (existing) {
      existing.refs++
      return existing.model
    }
    // A model may already exist outside the registry (e.g. created directly).
    // Adopt it rather than throwing on a duplicate createModel.
    const found = m.editor.getModel(uri)
    if (found && !found.isDisposed()) {
      this._entries.set(key, { model: found, refs: 1, owned: false })
      return found
    }
    const model = m.editor.createModel(text, languageForResource(resource), uri)
    this._entries.set(key, { model, refs: 1, owned: true })
    return model
  }

  /** Look up an existing model without changing its refcount. */
  peek(resource: URI): monaco.editor.ITextModel | undefined {
    return this._entries.get(canonicalResourceKey(resource))?.model
  }

  /**
   * Release one reference; if the refcount drops to zero the entry is removed
   * and the model disposed (only if this registry created it). Calls past the
   * last release are no-ops.
   */
  release(resource: URI): void {
    const key = canonicalResourceKey(resource)
    const entry = this._entries.get(key)
    if (!entry) return
    entry.refs--
    if (entry.refs <= 0) {
      this._entries.delete(key)
      if (entry.owned) entry.model.dispose()
    }
  }

  /** Test-only: drop everything. */
  _resetForTests(): void {
    for (const entry of this._entries.values()) if (entry.owned) entry.model.dispose()
    this._entries.clear()
  }
}

export const MonacoModelRegistry = new Registry()
