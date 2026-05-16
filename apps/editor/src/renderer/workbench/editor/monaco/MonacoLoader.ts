/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Monaco loader — installs MonacoEnvironment with self-hosted workers.
 *
 *  Vite's `?worker` import compiles each worker entry to a separate chunk and
 *  exposes it as a constructor that produces a Worker instance (under the hood
 *  it uses `blob:` URLs in dev and module workers in prod). We only ship the
 *  editor + json workers — TS / CSS / HTML files still get syntax tokenisation
 *  through Monaco's built-in monarch grammars, but lose IntelliSense.
 *--------------------------------------------------------------------------------------------*/

import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'

let _installed = false

function install(): void {
  if (_installed) return
  _installed = true
  ;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === 'json') return new JsonWorker()
      return new EditorWorker()
    },
  }
}

install()

export { monaco }

export const MonacoLoader = {
  ensureInitialized(): typeof monaco {
    install()
    return monaco
  },
}
