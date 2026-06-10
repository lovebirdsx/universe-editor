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

export const MermaidLoader = {
  ensureInitialized(): Promise<Mermaid> {
    return load()
  },

  /** Render `code` to an SVG string. Throws on a mermaid syntax error. */
  async render(id: string, code: string, theme: MermaidTheme): Promise<string> {
    const mermaid = await load()
    // mermaid config is global; re-applying the theme before each render keeps
    // every diagram in sync with the active workbench colour theme.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
    const { svg } = await mermaid.render(id, code)
    return svg
  },
}
