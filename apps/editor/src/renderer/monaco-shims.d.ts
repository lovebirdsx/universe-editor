// Monaco's deep ESM path ships no .d.ts. We only consume EditorExtensionsRegistry
// via the IMonacoEditorExtensionsRegistry shape defined in monacoActionsBridge,
// so an empty ambient declaration suffices.
declare module 'monaco-editor/esm/vs/editor/browser/editorExtensions.js'

// Same deal for standaloneServices: no shipped .d.ts. We need
// StandaloneServices.initialize(overrides) to lock our override services in
// before any service is first resolved, and StandaloneServices.get(...) to
// reach the resolved ICodeEditorService (see MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  import type { editor } from 'monaco-editor'
  export namespace StandaloneServices {
    function initialize(overrides: editor.IEditorOverrideServices): unknown
    function get<T>(id: unknown): T
  }
}

// ICodeEditorService is a service decorator with no shipped .d.ts; we only use it
// as the lookup key for StandaloneServices.get (see MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/browser/services/codeEditorService.js' {
  export const ICodeEditorService: unknown
}

// ICommandService decorator, used as the lookup key for StandaloneServices.get so
// the workbench can invoke monaco-internal commands like the references-peek
// `openReference` (see MonacoLoader / PeekNavigationContribution).
declare module 'monaco-editor/esm/vs/platform/commands/common/commands.js' {
  export const ICommandService: unknown
}

// IListService decorator + lookup key for StandaloneServices.get. We reach
// `lastFocusedList` to mirror keyboard focus onto the selection inside the
// references peek (see PeekNavigationContribution).
declare module 'monaco-editor/esm/vs/platform/list/browser/listService.js' {
  export const IListService: unknown
}

// ILanguageFeaturesService decorator + lookup key for StandaloneServices.get. We
// reach its `documentPasteEditProvider` registry to register the markdown
// paste-to-link provider (no public monaco.languages.* API; see
// MarkdownPasteContribution / MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/common/services/languageFeatures.js' {
  export const ILanguageFeaturesService: unknown
}

// IBulkEditService decorator + lookup key for StandaloneServices.get. We resolve
// the effective service (our FileBulkEditService override) so the E2E probe can
// drive the real drop/paste-to-link execution path end to end (see MonacoLoader).
declare module 'monaco-editor/esm/vs/editor/browser/services/bulkEditService.js' {
  export const IBulkEditService: unknown
}
