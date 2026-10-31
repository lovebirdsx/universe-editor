/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Lazy entry point for the KaTeX renderer. `import type` keeps the compiler from
 *  pulling the real module into the initial renderer bundle; the first formula
 *  that mounts triggers `import('./mathRenderer.js')`, which Vite emits as its
 *  own chunk.
 *--------------------------------------------------------------------------------------------*/

export type MathRenderer = (
  tex: string,
  display: boolean,
  macros: Readonly<Record<string, string>>,
) => string

let renderer: MathRenderer | undefined
let promise: Promise<MathRenderer> | undefined

function load(): Promise<MathRenderer> {
  if (renderer) return Promise.resolve(renderer)
  if (!promise) {
    promise = import('./mathRenderer.js')
      .then((mod) => {
        renderer = mod.renderMathToString
        return renderer
      })
      .catch((error: unknown) => {
        // Drop the rejected promise so a later formula can retry the import;
        // otherwise one transient chunk-load failure disables math for the
        // whole window.
        promise = undefined
        throw error
      })
  }
  return promise
}

export const MathLoader = {
  ensureInitialized(): Promise<MathRenderer> {
    return load()
  },

  /** Already-loaded renderer, so a mount after the first formula renders synchronously. */
  getLoaded(): MathRenderer | undefined {
    return renderer
  },
}
