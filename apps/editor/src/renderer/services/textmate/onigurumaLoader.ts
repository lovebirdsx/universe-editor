/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  oniguruma wasm lazy loading (VSCode `_getVSCodeOniguruma` equivalent).
 *  Isolated in its own module: the `?url` asset import only resolves through
 *  vite, so unit tests inject a stub IOnigLib and never touch this file.
 *--------------------------------------------------------------------------------------------*/

import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url'
import type { IOnigLib } from 'vscode-textmate'

let onigLibPromise: Promise<IOnigLib> | undefined

async function loadOniguruma(): Promise<IOnigLib> {
  const [onigurumaModule, wasmBuffer] = await Promise.all([
    import('vscode-oniguruma'),
    fetch(onigWasmUrl).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch onig.wasm: ${response.status}`)
      }
      return response.arrayBuffer()
    }),
  ])
  // CJS/ESM interop: the package ships a CJS main, so named exports may live
  // on the namespace or on `default` depending on the bundler's interop.
  const interop = onigurumaModule as unknown as {
    loadWASM?: typeof import('vscode-oniguruma').loadWASM
    default?: typeof import('vscode-oniguruma')
  }
  const oniguruma = (
    interop.loadWASM !== undefined ? interop : interop.default
  ) as typeof import('vscode-oniguruma')
  await oniguruma.loadWASM({ data: wasmBuffer })
  return {
    createOnigScanner: (sources: string[]) => oniguruma.createOnigScanner(sources),
    createOnigString: (str: string) => oniguruma.createOnigString(str),
  }
}

/** Memoized wasm boot; concurrent callers share one compile. */
export function getOnigLib(): Promise<IOnigLib> {
  onigLibPromise ??= loadOniguruma()
  return onigLibPromise
}
