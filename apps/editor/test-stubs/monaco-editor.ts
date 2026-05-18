/* Test stub for monaco-editor — happy-dom has no Monaco runtime, so we hand it
 * a tiny lookalike that satisfies the slice exercised by MonacoModelRegistry
 * and FileEditorInput tests.
 */

type Listener = () => void

function makeModel(initial: string, language: string, uri: unknown) {
  let value = initial
  const listeners = new Set<Listener>()
  return {
    uri,
    getValue: () => value,
    setValue: (next: string) => {
      if (next === value) return
      value = next
      for (const l of listeners) l()
    },
    getLanguageId: () => language,
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

export const editor = {
  createModel: (text: string, language: string, uri: unknown) => makeModel(text, language, uri),
  create: () => ({
    setModel: () => {},
    onDidChangeCursorPosition: () => ({ dispose: () => {} }),
    getModel: () => null,
    dispose: () => {},
  }),
  getModel: () => null,
}

export const languages = {
  json: {
    jsonDefaults: {
      setDiagnosticsOptions: (_options: unknown) => {},
    },
  },
}

export default { Uri, editor, languages }
