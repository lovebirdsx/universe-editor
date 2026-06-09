// Monaco's deep ESM path ships no .d.ts. We only consume EditorExtensionsRegistry
// via the IMonacoEditorExtensionsRegistry shape defined in monacoActionsBridge,
// so an empty ambient declaration suffices.
declare module 'monaco-editor/esm/vs/editor/browser/editorExtensions.js'

// Same deal for standaloneServices: no shipped .d.ts. We only need
// StandaloneServices.initialize(overrides) to lock our override services in
// before any service is first resolved (see MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  import type { editor } from 'monaco-editor'
  export namespace StandaloneServices {
    function initialize(overrides: editor.IEditorOverrideServices): unknown
  }
}
