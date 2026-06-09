/* Test stub for monaco-editor — happy-dom has no Monaco runtime, so we hand it
 * a tiny lookalike that satisfies the slice exercised by MonacoModelRegistry,
 * FileEditorInput, and LogOutputView tests.
 */

type Listener = () => void

function makeModel(initial: string, language: string, uri: unknown) {
  let value = initial
  const listeners = new Set<Listener>()
  const lines = () => value.split('\n')
  return {
    uri,
    getValue: () => value,
    setValue: (next: string) => {
      if (next === value) return
      value = next
      for (const l of listeners) l()
    },
    getLanguageId: () => language,
    getLineCount: () => lines().length,
    getLineContent: (n: number) => lines()[n - 1] ?? '',
    applyEdits: (edits: Array<{ text: string }>) => {
      for (const e of edits) value += e.text
      for (const l of listeners) l()
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
  json: {
    jsonDefaults: makeDefaults(),
  },
  typescript: {
    typescriptDefaults: makeDefaults(),
    javascriptDefaults: makeDefaults(),
  },
  css: {
    cssDefaults: makeDefaults(),
    lessDefaults: makeDefaults(),
    scssDefaults: makeDefaults(),
  },
  html: {
    htmlDefaults: makeDefaults(),
    handlebarDefaults: makeDefaults(),
    razorDefaults: makeDefaults(),
  },
}

export default { Uri, Range, editor, languages }
