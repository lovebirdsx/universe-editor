// Monaco's deep ESM path ships no .d.ts. We only consume EditorExtensionsRegistry
// via the IMonacoEditorExtensionsRegistry shape defined in monacoActionsBridge,
// so an empty ambient declaration suffices.
declare module 'monaco-editor/esm/vs/editor/browser/editorExtensions.js'
