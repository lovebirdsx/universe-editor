/*---------------------------------------------------------------------------------------------
 *  Register an auxiliary window with Monaco's internal window registry.
 *
 *  Monaco 0.55 keeps a main-window-only registry (`dom.js`) and does not export
 *  its `registerWindow` function. Our vendored patch adds the export; without it
 *  active-document resolution, context menus, hovers and widgets created by an
 *  editor in the auxiliary document resolve against the main window.
 *
 *  The deep imports resolve to the same module instances as `import('monaco-editor')`
 *  in MonacoLoader (Vite dedupes by resolved package path), so registering here
 *  is visible to every editor created later.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '@universe-editor/platform'

let nextWindowId = 2

export interface RegisteredMonacoWindow {
  readonly dispose: () => void
}

export async function registerMonacoWindow(targetWindow: Window): Promise<RegisteredMonacoWindow> {
  const [{ ensureCodeWindow }, { registerWindow }] = await Promise.all([
    import('monaco-editor/esm/vs/base/browser/window.js'),
    import('monaco-editor/esm/vs/base/browser/dom.js'),
  ])
  ensureCodeWindow(targetWindow, nextWindowId++)
  const registration = (registerWindow as unknown as (win: Window) => IDisposable)(targetWindow)
  return { dispose: () => registration.dispose() }
}
