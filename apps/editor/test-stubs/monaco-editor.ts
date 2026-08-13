/* Test stub for monaco-editor — happy-dom has no Monaco runtime, so we hand it
 * a tiny lookalike that satisfies the slice exercised by MonacoModelRegistry,
 * FileEditorInput, LogOutputView and PromptMonacoEditor tests.
 *
 * PromptMonacoEditor note: `editor.create()` mounts a real <textarea> into the
 * container and bridges its input/keydown to the fake model + registered
 * commands, so component tests can drive the prompt the same way they drove the
 * old textarea (fireEvent.change / keyDown on `acp-prompt-input`).
 */

type ContentChangedEvent = { changes: ReadonlyArray<unknown> }
type Listener = (e: ContentChangedEvent) => void
type LanguageListener = (e: { oldLanguage: string; newLanguage: string }) => void

function normalizeModelText(initial: string): string {
  const crlf = initial.match(/\r\n/g)?.length ?? 0
  const lf = initial.match(/(?<!\r)\n/g)?.length ?? 0
  const cr = initial.match(/\r(?!\n)/g)?.length ?? 0
  const total = crlf + lf + cr
  if (total === 0) return initial
  const eol = cr + crlf > total / 2 ? '\r\n' : '\n'
  return initial.replace(/\r\n|\r|\n/g, eol)
}

interface Position {
  lineNumber: number
  column: number
}

function offsetToPosition(value: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, value.length))
  const before = value.slice(0, clamped)
  const lines = before.split('\n')
  return { lineNumber: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 }
}

function positionToOffset(value: string, pos: Position): number {
  const lines = value.split('\n')
  let offset = 0
  for (let i = 0; i < pos.lineNumber - 1 && i < lines.length; i++) {
    offset += (lines[i]?.length ?? 0) + 1
  }
  return offset + (pos.column - 1)
}

interface StoredDecoration {
  startOffset: number
  endOffset: number
  options: unknown
}

function makeModel(initial: string, language: string, uri: unknown) {
  let value = normalizeModelText(initial)
  let versionId = 1
  let disposed = false
  let currentLanguage = language
  const listeners = new Set<Listener>()
  const languageListeners = new Set<LanguageListener>()
  const willDisposeListeners = new Set<() => void>()
  const decorations = new Map<string, StoredDecoration>()
  let decoSeq = 0
  const lines = () => value.split(/\r\n|\r|\n/)
  const fire = () => {
    versionId++
    for (const l of listeners) l({ changes: [] })
  }

  // Shift a decoration edge across a replace of [dStart,dEnd) with `insLen`
  // chars. `isStart` picks the NeverGrowsWhenTypingAtEdges bias: an insert at the
  // left edge pushes the whole pill right; an insert at the right edge leaves it.
  // `force` mirrors Monaco's forceMoveMarkers: a marker sitting exactly at the
  // edit point is pushed out regardless of stickiness.
  const shiftOffset = (
    o: number,
    dStart: number,
    dEnd: number,
    insLen: number,
    isStart: boolean,
    force: boolean,
  ): number => {
    if (dStart === dEnd) {
      // Pure insert of insLen chars at dStart.
      if (force) return dStart <= o ? o + insLen : o
      if (isStart) return dStart <= o ? o + insLen : o
      return dStart < o ? o + insLen : o
    }
    const removed = dEnd - dStart
    if (o <= dStart) return o
    if (o >= dEnd) return o + (insLen - removed)
    return dStart // inside the replaced span → clamp so content drift invalidates
  }

  const applyOneEdit = (dStart: number, dEnd: number, text: string, force = false): void => {
    const insLen = text.length
    value = value.slice(0, dStart) + text + value.slice(dEnd)
    for (const d of decorations.values()) {
      d.startOffset = shiftOffset(d.startOffset, dStart, dEnd, insLen, true, force)
      d.endOffset = shiftOffset(d.endOffset, dStart, dEnd, insLen, false, force)
    }
  }

  const model = {
    uri,
    getValue: () => value,
    getVersionId: () => versionId,
    getAlternativeVersionId: () => versionId,
    setValue: (next: string) => {
      const normalized = normalizeModelText(next)
      if (normalized === value) return
      applyOneEdit(0, value.length, normalized)
      fire()
    },
    getLanguageId: () => currentLanguage,
    getLineCount: () => lines().length,
    getLineContent: (n: number) => lines()[n - 1] ?? '',
    getLinesContent: () => lines(),
    getOffsetAt: (pos: Position) => positionToOffset(value, pos),
    getPositionAt: (offset: number) => offsetToPosition(value, offset),
    getFullModelRange: () => ({
      startColumn: 1,
      startLineNumber: 1,
      endColumn: 1,
      endLineNumber: 1,
    }),
    getValueInRange: (range: {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number
    }): string => {
      const start = positionToOffset(value, {
        lineNumber: range.startLineNumber,
        column: range.startColumn,
      })
      const end = positionToOffset(value, {
        lineNumber: range.endLineNumber,
        column: range.endColumn,
      })
      return value.slice(start, end)
    },
    deltaDecorations: (
      oldIds: readonly string[],
      newDecos: ReadonlyArray<{ range: unknown; options: unknown }>,
    ): string[] => {
      for (const id of oldIds) decorations.delete(id)
      const ids: string[] = []
      for (const d of newDecos) {
        const r = d.range as {
          startLineNumber: number
          startColumn: number
          endLineNumber: number
          endColumn: number
        }
        const id = `deco-${++decoSeq}`
        decorations.set(id, {
          startOffset: positionToOffset(value, {
            lineNumber: r.startLineNumber,
            column: r.startColumn,
          }),
          endOffset: positionToOffset(value, { lineNumber: r.endLineNumber, column: r.endColumn }),
          options: d.options,
        })
        ids.push(id)
      }
      return ids
    },
    getDecorationRange: (id: string): Range | null => {
      const d = decorations.get(id)
      if (!d) return null
      return new Range(
        offsetToPosition(value, d.startOffset).lineNumber,
        offsetToPosition(value, d.startOffset).column,
        offsetToPosition(value, d.endOffset).lineNumber,
        offsetToPosition(value, d.endOffset).column,
      )
    },
    applyEdits: (
      edits: Array<{
        range?: {
          startLineNumber: number
          startColumn: number
          endLineNumber: number
          endColumn: number
        }
        text: string
        forceMoveMarkers?: boolean
      }>,
    ) => {
      // Apply from the tail so earlier offsets stay valid across multiple edits.
      const resolved = edits.map((e) => {
        if (!e.range) {
          return {
            start: value.length,
            end: value.length,
            text: normalizeModelText(e.text),
            force: e.forceMoveMarkers ?? false,
          }
        }
        return {
          start: positionToOffset(value, {
            lineNumber: e.range.startLineNumber,
            column: e.range.startColumn,
          }),
          end: positionToOffset(value, {
            lineNumber: e.range.endLineNumber,
            column: e.range.endColumn,
          }),
          text: normalizeModelText(e.text),
          force: e.forceMoveMarkers ?? false,
        }
      })
      resolved.sort((a, b) => b.start - a.start)
      for (const e of resolved) applyOneEdit(e.start, e.end, e.text, e.force)
      fire()
    },
    _setValueDirect: (next: string) => {
      applyOneEdit(0, value.length, normalizeModelText(next))
      fire()
    },
    pushEditOperations: (
      _before: unknown,
      edits: Array<{
        range: {
          startLineNumber: number
          startColumn: number
          endLineNumber: number
          endColumn: number
        }
        text: string
        forceMoveMarkers?: boolean
      }>,
    ) => {
      model.applyEdits(edits)
      return null
    },
    isDisposed: () => disposed,
    onDidChangeContent: (cb: Listener) => {
      listeners.add(cb)
      return { dispose: () => listeners.delete(cb) }
    },
    onDidChangeLanguage: (cb: LanguageListener) => {
      languageListeners.add(cb)
      return { dispose: () => languageListeners.delete(cb) }
    },
    // Not part of the monaco API — driven by editor.setModelLanguage below.
    _setLanguage: (next: string) => {
      if (next === currentLanguage) return
      const oldLanguage = currentLanguage
      currentLanguage = next
      for (const l of languageListeners) l({ oldLanguage, newLanguage: next })
    },
    onWillDispose: (cb: () => void) => {
      willDisposeListeners.add(cb)
      return { dispose: () => willDisposeListeners.delete(cb) }
    },
    dispose: () => {
      if (disposed) return
      for (const l of [...willDisposeListeners]) l()
      disposed = true
      listeners.clear()
      languageListeners.clear()
      willDisposeListeners.clear()
      decorations.clear()
    },
  }
  return model
}

/* Uri.parse/toString port of monaco's vs/base/common/uri.ts. Identity-critical:
 * monaco percent-ENCODES the Windows drive-letter colon on toString
 * (`file:///c%3A/x.txt`) while a naive stub would echo the input string back
 * (`file:///c:/x.txt`) — the document-mirror pipeline keys maps by these strings,
 * so the stub must format them exactly like the real thing. */
const uriParts = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/

// reserved characters: https://tools.ietf.org/html/rfc3986#section-2.2
const encodeTable: Record<number, string> = {
  [58]: '%3A', // : (gen-delims)
  [47]: '%2F',
  [63]: '%3F',
  [35]: '%23',
  [91]: '%5B',
  [93]: '%5D',
  [64]: '%40',
  [33]: '%21', // ! (sub-delims)
  [36]: '%24',
  [38]: '%26',
  [39]: '%27',
  [40]: '%28',
  [41]: '%29',
  [42]: '%2A',
  [43]: '%2B',
  [44]: '%2C',
  [59]: '%3B',
  [61]: '%3D',
  [32]: '%20',
}

function encodeURIComponentFast(uriComponent: string, isPath: boolean, isAuthority: boolean) {
  let res: string | undefined = undefined
  let nativeEncodePos = -1
  for (let pos = 0; pos < uriComponent.length; pos++) {
    const code = uriComponent.charCodeAt(pos)
    // unreserved characters: https://tools.ietf.org/html/rfc3986#section-2.3
    if (
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      code === 45 ||
      code === 46 ||
      code === 95 ||
      code === 126 ||
      (isPath && code === 47) ||
      (isAuthority && code === 91) ||
      (isAuthority && code === 93) ||
      (isAuthority && code === 58)
    ) {
      if (nativeEncodePos !== -1) {
        res += encodeURIComponent(uriComponent.substring(nativeEncodePos, pos))
        nativeEncodePos = -1
      }
      if (res !== undefined) res += uriComponent.charAt(pos)
    } else {
      if (res === undefined) res = uriComponent.substr(0, pos)
      const escaped = encodeTable[code]
      if (escaped !== undefined) {
        if (nativeEncodePos !== -1) {
          res += encodeURIComponent(uriComponent.substring(nativeEncodePos, pos))
          nativeEncodePos = -1
        }
        res += escaped
      } else if (nativeEncodePos === -1) {
        // batch raw encodeURIComponent so surrogate pairs stay intact
        nativeEncodePos = pos
      }
    }
  }
  if (nativeEncodePos !== -1) {
    res += encodeURIComponent(uriComponent.substring(nativeEncodePos))
  }
  return res !== undefined ? res : uriComponent
}

function decodeURIComponentGraceful(str: string): string {
  try {
    return decodeURIComponent(str)
  } catch {
    if (str.length > 3) return str.substr(0, 3) + decodeURIComponentGraceful(str.substr(3))
    return str
  }
}

const encodedAsHex = /(%[0-9A-Za-z][0-9A-Za-z])+/g

function percentDecode(str: string): string {
  if (!str.match(encodedAsHex)) return str
  return str.replace(encodedAsHex, (match) => decodeURIComponentGraceful(match))
}

function asFormatted(
  scheme: string,
  authority: string,
  path: string,
  query: string,
  fragment: string,
): string {
  let res = ''
  if (scheme) {
    res += scheme
    res += ':'
  }
  if (authority || scheme === 'file') {
    res += '/'
    res += '/'
  }
  if (authority) {
    let idx = authority.indexOf('@')
    if (idx !== -1) {
      // <user>@<auth>
      const userinfo = authority.substr(0, idx)
      authority = authority.substr(idx + 1)
      idx = userinfo.lastIndexOf(':')
      if (idx === -1) {
        res += encodeURIComponentFast(userinfo, false, false)
      } else {
        // <user>:<pass>@<auth>
        res += encodeURIComponentFast(userinfo.substr(0, idx), false, false)
        res += ':'
        res += encodeURIComponentFast(userinfo.substr(idx + 1), false, true)
      }
      res += '@'
    }
    authority = authority.toLowerCase()
    idx = authority.lastIndexOf(':')
    if (idx === -1) {
      res += encodeURIComponentFast(authority, false, true)
    } else {
      // <auth>:<port>
      res += encodeURIComponentFast(authority.substr(0, idx), false, true)
      res += authority.substr(idx)
    }
  }
  if (path) {
    // lower-case windows drive letters in /C:/fff or C:/fff
    if (path.length >= 3 && path.charCodeAt(0) === 47 && path.charCodeAt(2) === 58) {
      const code = path.charCodeAt(1)
      if (code >= 65 && code <= 90) {
        path = `/${String.fromCharCode(code + 32)}:${path.substr(3)}`
      }
    } else if (path.length >= 2 && path.charCodeAt(1) === 58) {
      const code = path.charCodeAt(0)
      if (code >= 65 && code <= 90) {
        path = `${String.fromCharCode(code + 32)}:${path.substr(2)}`
      }
    }
    res += encodeURIComponentFast(path, true, false)
  }
  if (query) {
    res += '?'
    res += encodeURIComponentFast(query, false, false)
  }
  if (fragment) {
    res += '#'
    res += encodeURIComponentFast(fragment, false, false)
  }
  return res
}

export const Uri = {
  parse: (s: string) => {
    const match = uriParts.exec(s)
    if (!match) {
      return makeUri('', '', '', '', '')
    }
    return makeUri(
      match[2] ?? '',
      percentDecode(match[4] ?? ''),
      percentDecode(match[5] ?? ''),
      percentDecode(match[7] ?? ''),
      percentDecode(match[9] ?? ''),
    )
  },
}

function makeUri(scheme: string, authority: string, path: string, query: string, fragment: string) {
  return {
    scheme,
    authority,
    path,
    query,
    fragment,
    toString: () => asFormatted(scheme, authority, path, query, fragment),
    toJSON: () => ({ scheme, authority, path, query, fragment, $mid: 1 }),
  }
}

export class Range {
  constructor(
    public readonly startLineNumber: number,
    public readonly startColumn: number,
    public readonly endLineNumber: number,
    public readonly endColumn: number,
  ) {}
  static fromPositions(start: Position, end?: Position): Range {
    const e = end ?? start
    return new Range(start.lineNumber, start.column, e.lineNumber, e.column)
  }
}

export enum KeyCode {
  Enter = 3,
  UpArrow = 16,
  DownArrow = 18,
}

export enum EditorOption {
  lineHeight = 66,
}

const noopDisposable = { dispose: () => {} }
const listen = (set: Set<() => void>, cb: () => void) => {
  set.add(cb)
  return { dispose: () => set.delete(cb) }
}

// happy-dom has no layout, so Monaco's viewport-point → model-position hit
// test can't run. Tests pin the returned position directly (null = no hit).
let targetAtClientPoint: { position: Position } | null = null
export function _setTargetAtClientPointForTests(position: Position | null): void {
  targetAtClientPoint = position === null ? null : { position }
}

// PromptMonacoEditor-flavoured fake editor: mounts a real textarea so component
// tests can fireEvent against it, and bridges to a provided/created model.
function makePromptEditor(
  container: HTMLElement,
  options: { model?: ReturnType<typeof makeModel> },
) {
  const model = options.model ?? makeModel('', 'plaintext', undefined)
  const ta = container.ownerDocument.createElement('textarea')
  ta.setAttribute('data-testid', 'acp-prompt-input')
  ta.value = model.getValue()
  container.appendChild(ta)

  const contentListeners = new Set<() => void>()
  const cursorListeners = new Set<() => void>()
  const focusListeners = new Set<() => void>()
  const blurListeners = new Set<() => void>()
  const commands = new Map<number, () => void>()

  model.onDidChangeContent(() => {
    if (ta.value !== model.getValue()) ta.value = model.getValue()
    for (const l of contentListeners) l()
  })

  const syncFromTextarea = (): void => {
    model._setValueDirect(ta.value)
  }
  // React tests drive the textarea with fireEvent.change (a `change` event) and
  // real typing fires `input`; bridge both to the fake model.
  ta.addEventListener('input', syncFromTextarea)
  ta.addEventListener('change', syncFromTextarea)
  ta.addEventListener('keyup', () => {
    for (const l of cursorListeners) l()
  })
  ta.addEventListener('click', () => {
    for (const l of cursorListeners) l()
  })
  ta.addEventListener('focus', () => {
    for (const l of focusListeners) l()
  })
  ta.addEventListener('blur', () => {
    for (const l of blurListeners) l()
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const cmd = commands.get(KeyCode.Enter)
      if (cmd) {
        e.preventDefault()
        cmd()
      }
    }
  })

  const getPosition = (): Position =>
    offsetToPosition(model.getValue(), ta.selectionStart ?? model.getValue().length)

  // Output-view support: the editor starts on the bridge model but LogOutputView
  // swaps per-channel models via setModel. The textarea stays bound to the
  // bridge model — component tests assert on the service-layer models instead.
  let current: ReturnType<typeof makeModel> | null = model

  return {
    getModel: () => current,
    setModel: (m: unknown) => {
      current = (m ?? null) as ReturnType<typeof makeModel> | null
    },
    saveViewState: () => null,
    restoreViewState: () => {},
    onDidScrollChange: () => noopDisposable,
    getContainerDomNode: () => container,
    getValue: () => model.getValue(),
    focus: () => ta.focus(),
    getPosition,
    setPosition: (pos: Position) => {
      const off = positionToOffset(model.getValue(), pos)
      ta.setSelectionRange(off, off)
      for (const l of cursorListeners) l()
    },
    getOption: () => 18,
    getContentHeight: () => 60,
    getTopForPosition: (lineNumber: number) => (lineNumber - 1) * 18,
    getTopForLineNumber: (lineNumber: number) => (lineNumber - 1) * 18,
    getTargetAtClientPoint: () => targetAtClientPoint,
    trigger: (_src: string, _handler: string, payload?: { text?: string }) => {
      if (payload?.text) model._setValueDirect(model.getValue() + payload.text)
    },
    addCommand: (keybinding: number, handler: () => void) => {
      commands.set(keybinding, handler)
    },
    createDecorationsCollection: () => ({
      set: () => {},
      clear: () => {},
      getRange: () => null,
      length: 0,
    }),
    onDidChangeModelContent: (cb: () => void) => listen(contentListeners, cb),
    onDidChangeCursorPosition: (cb: () => void) => listen(cursorListeners, cb),
    onDidFocusEditorText: (cb: () => void) => listen(focusListeners, cb),
    onDidBlurEditorText: (cb: () => void) => listen(blurListeners, cb),
    onDidFocusEditorWidget: () => noopDisposable,
    onDidBlurEditorWidget: () => noopDisposable,
    onDidContentSizeChange: () => noopDisposable,
    onDidDispose: () => noopDisposable,
    onKeyDown: () => noopDisposable,
    updateOptions: () => {},
    revealLine: () => {},
    getScrollTop: () => 0,
    getScrollHeight: () => 100,
    getLayoutInfo: () => ({ height: 200 }),
    dispose: () => {
      contentListeners.clear()
      cursorListeners.clear()
      focusListeners.clear()
      blurListeners.clear()
      commands.clear()
      ta.remove()
    },
  }
}

export const editor = {
  createModel: (text: string, language: string, uri: unknown) => makeModel(text, language, uri),
  setModelLanguage: (model: ReturnType<typeof makeModel>, languageId: string) =>
    model._setLanguage(languageId),
  create: (container: HTMLElement, options?: { model?: ReturnType<typeof makeModel> }) =>
    makePromptEditor(container, options ?? {}),
  getModel: () => null,
  defineTheme: () => {},
  setTheme: () => {},
  addKeybindingRule: () => {},
  EditorOption,
  TrackedRangeStickiness: {
    AlwaysGrowsWhenTypingAtEdges: 0,
    NeverGrowsWhenTypingAtEdges: 1,
    GrowsOnlyWhenTypingBefore: 2,
    GrowsOnlyWhenTypingAfter: 3,
  },
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
  registerTokensProviderFactory: () => ({ dispose: () => {} }),
  getLanguages: () => [] as { id: string; aliases?: string[] }[],
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

export default { Uri, Range, KeyCode, editor, languages, json, typescript, css, html }
