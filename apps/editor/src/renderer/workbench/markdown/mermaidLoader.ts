/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mermaid loader — lazy-loads the `mermaid` package on demand so it stays in a
 *  separate chunk and never weighs on the initial renderer bundle. Loading is
 *  only triggered when a markdown document or chat message actually contains a
 *  ```mermaid block (see MermaidBlock), so diagram-free content pays nothing.
 *--------------------------------------------------------------------------------------------*/

import type { Mermaid } from 'mermaid'

export type MermaidTheme = 'dark' | 'default'

let _mermaid: Mermaid | undefined
let _promise: Promise<Mermaid> | undefined

async function load(): Promise<Mermaid> {
  if (_mermaid) return _mermaid
  if (!_promise) {
    _promise = import('mermaid').then((mod) => {
      const mermaid = mod.default
      // securityLevel 'strict' is the default; it encodes tags in labels and
      // disables click interactions, and mermaid runs its SVG output through
      // DOMPurify — safe for untrusted diagram text.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
      _mermaid = mermaid
      return mermaid
    })
  }
  return _promise
}

// mermaid.render() creates temporary measurement nodes keyed by the render id and
// calls removeExistingElements on entry — so two renders sharing an id (e.g. React
// StrictMode's double-invoke, or several diagrams rendering at once) delete each
// other's measurement nodes mid-flight and produce empty diagrams (pie is the most
// sensitive, as it leans on getBBox text measurement). Guard both: a per-call
// unique id so ids never collide, and a serial queue so renders never overlap.
let _renderSeq = 0
let _queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = _queue.then(task, task)
  // Keep the chain alive regardless of individual outcomes.
  _queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export const MermaidLoader = {
  ensureInitialized(): Promise<Mermaid> {
    return load()
  },

  /** Render `code` to an SVG string. Throws on a mermaid syntax error. */
  async render(code: string, theme: MermaidTheme): Promise<string> {
    return enqueue(async () => {
      const mermaid = await load()
      // mermaid config is global; re-applying the theme before each render keeps
      // every diagram in sync with the active workbench colour theme.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
      const id = `mermaid-render-${_renderSeq++}`
      const { svg } = await mermaid.render(id, code)
      return svg
    })
  },
}
