/* Test stub for monaco-editor — happy-dom has no Monaco runtime, so we hand it
 * a tiny lookalike that satisfies the slice exercised by MonacoModelRegistry,
 * FileEditorInput, and LogOutputView tests.
 */

type ContentChangedEvent = { changes: ReadonlyArray<unknown> }
type Listener = (e: ContentChangedEvent) => void

function normalizeModelText(initial: string): string {
  const crlf = initial.match(/\r\n/g)?.length ?? 0
  const lf = initial.match(/(?<!\r)\n/g)?.length ?? 0
  const cr = initial.match(/\r(?!\n)/g)?.length ?? 0
  const total = crlf + lf + cr
  if (total === 0) return initial
  const eol = cr + crlf > total / 2 ? '\r\n' : '\n'
  return initial.replace(/\r\n|\r|\n/g, eol)
}

function makeModel(initial: string, language: string, uri: unknown) {
  let value = normalizeModelText(initial)
  let versionId = 1
  const listeners = new Set<Listener>()
  const lines = () => value.split(/\r\n|\r|\n/)
  return {
    uri,
    getValue: () => value,
    getVersionId: () => versionId,
    getAlternativeVersionId: () => versionId,
    setValue: (next: string) => {
      const normalized = normalizeModelText(next)
      if (normalized === value) return
      value = normalized
      versionId++
      for (const l of listeners) l({ changes: [] })
    },
    getLanguageId: () => language,
    getLineCount: () => lines().length,
    getLineContent: (n: number) => lines()[n - 1] ?? '',
    applyEdits: (edits: Array<{ text: string }>) => {
      for (const e of edits) value += normalizeModelText(e.text)
      versionId++
      for (const l of listeners) l({ changes: [] })
    },
    onDidChangeContent: (cb: Listener) => {
      listeners.add(cb)
      return { dispose: () => listeners.delete(cb) }
    },
    dispose: () => {
      listeners.clear()
    },
  }
}

export const Uri = {
  parse: (s: string) => ({ toString: () => s }),
}

export class Range {
  constructor(
    public readonly startLineNumber: number,
    public readonly startColumn: number,
    public readonly endLineNumber: number,
    public readonly endColumn: number,
  ) {}
}

export const editor = {
  createModel: (text: string, language: string, uri: unknown) => makeModel(text, language, uri),
  create: () => ({
    setModel: () => {},
    onDidChangeCursorPosition: () => ({ dispose: () => {} }),
    onDidFocusEditorWidget: () => ({ dispose: () => {} }),
    onDidBlurEditorWidget: () => ({ dispose: () => {} }),
    getModel: () => null,
    getContainerDomNode: () => document.createElement('div'),
    addCommand: () => {},
    revealLine: () => {},
    getScrollTop: () => 0,
    getScrollHeight: () => 100,
    getLayoutInfo: () => ({ height: 200 }),
    updateOptions: () => {},
    dispose: () => {},
  }),
  getModel: () => null,
  defineTheme: () => {},
  setTheme: () => {},
  addKeybindingRule: () => {},
}

function makeDefaults() {
  return {
    diagnosticsOptions: {},
    modeConfiguration: {},
    options: {},
    setDiagnosticsOptions: (_options: unknown) => {},
    setModeConfiguration: (_options: unknown) => {},
    setOptions: (_options: unknown) => {},
  }
}

export const languages = {
  register: () => {},
  setMonarchTokensProvider: () => ({ dispose: () => {} }),
}

// monaco 0.55 moved these language-service namespaces from `monaco.languages.*`
// up to the package top level (`monaco.json` / `monaco.typescript` / ...).
export const json = {
  jsonDefaults: makeDefaults(),
}

export const typescript = {
  typescriptDefaults: makeDefaults(),
  javascriptDefaults: makeDefaults(),
}

export const css = {
  cssDefaults: makeDefaults(),
  lessDefaults: makeDefaults(),
  scssDefaults: makeDefaults(),
}

export const html = {
  htmlDefaults: makeDefaults(),
  handlebarDefaults: makeDefaults(),
  razorDefaults: makeDefaults(),
}

export default { Uri, Range, editor, languages, json, typescript, css, html }
