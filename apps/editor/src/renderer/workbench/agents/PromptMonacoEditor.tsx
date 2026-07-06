/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptMonacoEditor — a single-model Monaco editor wrapping the agent prompt
 *  input, exposing a small textarea-like imperative handle so <PromptInput> can
 *  keep driving its popover/submit/draft logic off plain (text, caret) state.
 *
 *  Why Monaco (not a textarea): `@`/`#` references render as by-range decoration
 *  "pills" and are tracked by character range (see promptRefTracker.ts), which a
 *  plain textarea cannot do. Monaco's decorations follow edits automatically and
 *  survive reference labels that contain spaces.
 *
 *  Mount model mirrors LogOutputView: create the editor once, self-own the model
 *  and dispose it on unmount, guard the async init with `disposed`. editContext
 *  is ON — required so CJK IME composition doesn't bold the active line
 *  (monaco 0.55, see memory monaco-055-editcontext-nls).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { IConfigurationService, IContextKeyService } from '@universe-editor/platform'
import type { monaco } from '../editor/monaco/MonacoLoader.js'
import { MonacoLoader } from '../editor/monaco/MonacoLoader.js'
import { syncEditorFocusContext } from '../../services/editor/editorFocus.js'
import { PromptRefTracker } from '../../services/acp/promptRefTracker.js'
import type { PlacedRef, PromptRef } from '../../services/acp/promptRef.js'
import styles from './agents.module.css'

/** Global CSS class Monaco paints on the inline reference-pill decoration. */
const PILL_CLASS_NAME = 'acp-prompt-ref-pill'

// unicodeHighlight matching FileEditor: never flag CJK. Without this Monaco's
// default ambiguous-character highlight paints a yellow box around full-width
// punctuation (，。！…), which is wrong for a prose prompt input.
const PROMPT_UNICODE_HIGHLIGHT: NonNullable<monaco.editor.IEditorOptions['unicodeHighlight']> = {
  nonBasicASCII: false,
  allowedLocales: { _os: true, _vscode: true, 'zh-hans': true, 'zh-hant': true },
}

// Minimal shape of Monaco's inline-completions controller, just enough to read
// whether ghost text is currently on screen at the cursor.
interface GhostTextLike {
  isEmpty(): boolean
}
interface InlineStateLike {
  readonly primaryGhostText?: GhostTextLike
}
interface ObservableLike<T> {
  get(): T
}
interface InlineModelLike {
  readonly inlineCompletionState: ObservableLike<InlineStateLike | undefined>
}
interface InlineControllerLike {
  readonly model: ObservableLike<InlineModelLike | undefined>
  dispose(): void
}

/**
 * Whether an inline suggestion (ghost text) is visible at the cursor. Read
 * synchronously off the controller so a Tab keydown can decide, in the same
 * tick, whether to accept it (like a normal editor) or fall through to indent.
 * Mirrors the observable bridgeInlineSuggestionVisible follows in editorFocus.ts.
 */
function isInlineSuggestionVisible(ed: monaco.editor.IStandaloneCodeEditor): boolean {
  if (typeof ed.getContribution !== 'function') return false
  const controller = ed.getContribution<InlineControllerLike>(
    'editor.contrib.inlineCompletionsController',
  )
  const ghost = controller?.model.get()?.inlineCompletionState.get()?.primaryGhostText
  return !!ghost && !ghost.isEmpty()
}

/** Imperative surface <PromptInput> uses in place of a textarea DOM node. */
export interface PromptEditorHandle {
  focus(): boolean
  getText(): string
  /** Replace the whole buffer and place the caret (default: end). */
  setText(text: string, caret?: number): void
  getCaret(): number
  setCaret(offset: number): void
  /** Textarea-compatible collapsed/selection caret set (start===end → caret). */
  setSelectionRange(start: number, end: number): void
  /** Replace `[start, end)` with `insert`, leaving the caret after the insert. */
  replaceRange(start: number, end: number, insert: string): void
  /** True when the caret sits on the first visual line (history ↑ gating). */
  isCaretOnFirstLine(): boolean
  /**
   * Replace `[start, end)` with `ref`'s display text, painted as a tracked pill,
   * then append a trailing space if `trailingSpace` and none follows. Leaves the
   * caret after the inserted text (past the space). No-op before the editor mounts.
   */
  insertRef(ref: PromptRef, start: number, end: number, trailingSpace?: boolean): void
  /** Live placed refs (range-tracked), ordered by start offset. */
  listRefs(): PlacedRef[]
  /** Rebuild pills over already-present display text (draft restore). */
  restoreRefs(placed: readonly PlacedRef[]): void
  /** Drop all pills + tracking (after submit clears the buffer). */
  clearRefs(): void
  /** The live Monaco editor + monaco namespace, for the ref tracker (M2). Null pre-init. */
  peek(): { editor: monaco.editor.IStandaloneCodeEditor; ns: typeof monaco } | null
}

/**
 * Origin of a content/caret change. `user` = a keystroke/IME/paste inside the
 * editor; `program` = an imperative `setText`/`replaceRange`/caret call from the
 * host. The old controlled textarea only fired onChange for user input, so the
 * host relies on this to keep programmatic writes (history nav, accept-pick,
 * draft restore) from being mistaken for typing.
 */
export type PromptChangeSource = 'user' | 'program'

/**
 * Whether a change event carried a genuine text edit (`content`) or was only a
 * caret/selection move (`cursor`). Real Monaco fires a deferred cursor-position
 * event *after* a programmatic `setText` settles — outside the `runProgrammatic`
 * window, so it arrives as `source: 'user'` even though the user typed nothing.
 * The host must not run content-dependent side effects (history close, `@@`
 * picker, popover dismissal resets) for a bare cursor move, or that stray event
 * would close a just-opened history popover. Mirrors the old textarea, where
 * caret moves went through a separate handler that never touched those effects.
 */
export type PromptChangeKind = 'content' | 'cursor'

export interface PromptMonacoEditorProps {
  readonly handleRef: Ref<PromptEditorHandle>
  readonly configService: IConfigurationService
  readonly contextKeyService: IContextKeyService
  readonly placeholder: string
  readonly autoFocus?: boolean
  /** Seed text (restored draft), applied once on mount. */
  readonly initialText?: string
  /** Caret offset for the seed text (default: end). */
  readonly initialCaret?: number
  /** Fired on every content/cursor change with the full text, caret offset, origin, and kind. */
  readonly onChange: (
    text: string,
    caret: number,
    source: PromptChangeSource,
    kind: PromptChangeKind,
  ) => void
  /** Enter with no modifier and no open popover: submit. Returns true if consumed. */
  readonly onEnter: () => boolean
  /** ArrowUp on the first line with no popover: open history. Returns true if consumed. */
  readonly onArrowUp?: () => boolean
  readonly onEditorReady?: (editor: monaco.editor.IStandaloneCodeEditor, ns: typeof monaco) => void
}

export function PromptMonacoEditor({
  handleRef,
  configService,
  contextKeyService,
  placeholder,
  autoFocus,
  initialText,
  initialCaret,
  onChange,
  onEnter,
  onArrowUp,
  onEditorReady,
}: PromptMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const monacoRef = useRef<typeof monaco | null>(null)
  const trackerRef = useRef<PromptRefTracker | null>(null)

  // Keep callbacks in refs so the create-once effect reads the latest without
  // re-running (which would rebuild the editor).
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onEnterRef = useRef(onEnter)
  onEnterRef.current = onEnter
  const onArrowUpRef = useRef(onArrowUp)
  onArrowUpRef.current = onArrowUp
  const onEditorReadyRef = useRef(onEditorReady)
  onEditorReadyRef.current = onEditorReady

  const caretOffset = (): number => {
    const ed = editorRef.current
    const model = modelRef.current
    if (!ed || !model) return 0
    const pos = ed.getPosition()
    return pos ? model.getOffsetAt(pos) : 0
  }

  // Non-zero while an imperative method drives the model/cursor, so the change
  // and cursor listeners report `'program'` instead of `'user'`. A counter (not
  // a boolean) survives nested/synchronous edits.
  const programDepthRef = useRef(0)
  const runProgrammatic = (fn: () => void): void => {
    programDepthRef.current++
    try {
      fn()
    } finally {
      programDepthRef.current--
    }
  }

  const emitChange = (kind: PromptChangeKind): void => {
    const model = modelRef.current
    if (!model) return
    const source: PromptChangeSource = programDepthRef.current > 0 ? 'program' : 'user'
    onChangeRef.current(model.getValue(), caretOffset(), source, kind)
  }

  useImperativeHandle(
    handleRef,
    (): PromptEditorHandle => ({
      focus: () => {
        const ed = editorRef.current
        if (!ed) return false
        ed.focus()
        return true
      },
      getText: () => modelRef.current?.getValue() ?? '',
      setText: (text, caret) =>
        runProgrammatic(() => {
          const ed = editorRef.current
          const model = modelRef.current
          if (!ed || !model) return
          if (model.getValue() !== text) model.setValue(text)
          const off = caret ?? text.length
          ed.setPosition(model.getPositionAt(off))
        }),
      getCaret: caretOffset,
      setCaret: (offset) =>
        runProgrammatic(() => {
          const ed = editorRef.current
          const model = modelRef.current
          if (!ed || !model) return
          ed.setPosition(model.getPositionAt(offset))
        }),
      setSelectionRange: (start, _end) =>
        runProgrammatic(() => {
          const ed = editorRef.current
          const model = modelRef.current
          if (!ed || !model) return
          ed.setPosition(model.getPositionAt(start))
        }),
      replaceRange: (start, end, insert) =>
        runProgrammatic(() => {
          const ed = editorRef.current
          const model = modelRef.current
          const m = monacoRef.current
          if (!ed || !model || !m) return
          const range = m.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end))
          model.applyEdits([{ range, text: insert, forceMoveMarkers: true }])
          ed.setPosition(model.getPositionAt(start + insert.length))
        }),
      isCaretOnFirstLine: () => {
        const ed = editorRef.current
        const pos = ed?.getPosition()
        if (!ed || !pos) return true
        // Compare the caret's visual top with the very first visual row. On a
        // soft-wrapped logical line 1, later visual rows sit lower, so ArrowUp
        // there should move up within the buffer — not open history.
        return ed.getTopForPosition(pos.lineNumber, pos.column) === ed.getTopForPosition(1, 1)
      },
      insertRef: (ref, start, end, trailingSpace = true) =>
        runProgrammatic(() => {
          const ed = editorRef.current
          const model = modelRef.current
          const m = monacoRef.current
          const tracker = trackerRef.current
          if (!ed || !model || !m || !tracker) return
          let caret = tracker.insert(ref, start, end)
          const nextChar = model.getValue().slice(caret, caret + 1)
          if (trailingSpace && (nextChar === '' || !/\s/.test(nextChar))) {
            const at = model.getPositionAt(caret)
            // No forceMoveMarkers: it would override the pill decoration's
            // NeverGrowsWhenTypingAtEdges stickiness and pull the trailing space
            // into the tracked range, so reconcile() would later see the range
            // text drift from its snapshot and delete the whole pill.
            model.applyEdits([{ range: m.Range.fromPositions(at, at), text: ' ' }])
            caret += 1
          }
          ed.setPosition(model.getPositionAt(caret))
        }),
      listRefs: () => trackerRef.current?.list() ?? [],
      restoreRefs: (placed) => runProgrammatic(() => trackerRef.current?.restore(placed)),
      clearRefs: () => runProgrammatic(() => trackerRef.current?.clear()),
      peek: () => {
        const editor = editorRef.current
        const ns = monacoRef.current
        return editor && ns ? { editor, ns } : null
      },
    }),
    [],
  )

  useEffect(() => {
    let disposed = false
    const disposables: monaco.IDisposable[] = []
    const mount = (m: typeof monaco): void => {
      if (disposed || !containerRef.current) return
      monacoRef.current = m
      const model = m.editor.createModel(initialText ?? '', 'plaintext')
      modelRef.current = model
      const theme =
        configService.get<string>('workbench.colorTheme') === 'light'
          ? 'output-light'
          : 'output-dark'
      const fontSize = configService.get<number>('editor.fontSize') ?? 13
      const ed = m.editor.create(
        containerRef.current,
        {
          model,
          editContext: true,
          theme,
          automaticLayout: true,
          fontSize,
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          minimap: { enabled: false },
          // A prose prompt input has no scopes to pin; sticky scroll here only
          // races model swaps/dispose and crashes in StickyScrollController
          // (modelPositionIsVisible → undefined line projection).
          stickyScroll: { enabled: false },
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          renderLineHighlight: 'none',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          wrappingStrategy: 'advanced',
          scrollbar: { vertical: 'auto', horizontal: 'hidden', useShadows: false },
          suggestOnTriggerCharacters: false,
          quickSuggestions: false,
          contextmenu: false,
          occurrencesHighlight: 'off',
          selectionHighlight: false,
          matchBrackets: 'never',
          unicodeHighlight: PROMPT_UNICODE_HIGHLIGHT,
          // The host <div> owns resource drops (insert @-mention / attach image).
          // Leaving Monaco's own drop-into-editor on would let its default text
          // provider paste the raw `file:///…` uri-list into the buffer too, so a
          // dropped file lands twice. Turn both editor-level DnD behaviours off.
          dropIntoEditor: { enabled: false },
          dragAndDrop: false,
          padding: { top: 4, bottom: 4 },
          placeholder,
        },
        MonacoLoader.getOverrideServices(),
      )
      editorRef.current = ed
      const tracker = new PromptRefTracker(model, m, PILL_CLASS_NAME)
      trackerRef.current = tracker

      // On a genuine user edit, drop any pill the user broke (edited inside /
      // backspaced its edge). Skip while a programmatic write is in flight — the
      // tracker's own insert()/restore() must not be reconciled mid-operation.
      disposables.push(
        ed.onDidChangeModelContent(() => {
          if (programDepthRef.current === 0) tracker.reconcile()
          emitChange('content')
        }),
      )
      disposables.push(ed.onDidChangeCursorPosition(() => emitChange('cursor')))

      // Bridge Monaco text focus → the global `editorTextFocus` contextKey, the
      // same split FileEditor maintains. With editContext: true the editor's
      // focus host is not a DOM-editable element, so isEditableTarget() can't see
      // it; the global keybinding handler relies on `editorTextFocus` to reserve
      // native editing keys (Delete/Backspace) for the editor. Without this a
      // global `delete` binding (delete-file) steals the key and Delete does
      // nothing in the prompt. Clear on blur; also re-sync on unmount so a
      // lingering true (blur can lag dispose) doesn't leak.
      disposables.push(
        ed.onDidFocusEditorText(() => contextKeyService.set('editorTextFocus', true)),
      )
      disposables.push(
        ed.onDidBlurEditorText(() => contextKeyService.set('editorTextFocus', false)),
      )

      // Auto-grow: size the container to the content between a 3-line floor and
      // a 16-line ceiling (past which Monaco's own scrollbar takes over). Mirrors
      // the old textarea's field-sizing min/max.
      const lineHeight = ed.getOption(m.editor.EditorOption.lineHeight)
      const minH = lineHeight * 3 + 8
      const maxH = lineHeight * 16 + 8
      const applyHeight = (): void => {
        const container = containerRef.current
        if (!container) return
        const h = Math.min(maxH, Math.max(minH, ed.getContentHeight() + 8))
        container.style.height = `${h}px`
      }
      disposables.push(ed.onDidContentSizeChange(() => applyHeight()))
      applyHeight()

      // ArrowUp on the first visual row opens prompt history. Registered as a
      // raw keydown listener (not addCommand) so it only fires from the top row
      // and lets Monaco move the cursor up within a soft-wrapped line elsewhere.
      //
      // Enter is handled here too, for the SAME scoping reason: a standalone
      // editor's `addCommand(KeyCode.Enter, …)` registers on Monaco's shared
      // StandaloneKeybindingService with no editor scope, so it fires for Enter
      // in EVERY Monaco editor — including file editors — and there it ran this
      // prompt's onEnter (submitting/swallowing), which is why pressing Enter in
      // a .ts file stopped inserting a newline once a session editor mounted.
      // A capture-phase keydown on THIS editor's own DOM node is naturally scoped.
      const dom = ed.getContainerDomNode()
      const keydownHandler = (e: KeyboardEvent): void => {
        // Enter (no modifier) submits unless a popover consumes it; Shift+Enter
        // (and other modifiers) fall through to Monaco as a newline. The popover
        // Accept command (gated on acpPromptPopupVisible) resolves first through
        // the global handler when a popover is open, so onEnter returns false
        // then and we let the key through.
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          if (onEnterRef.current()) {
            e.preventDefault()
            e.stopPropagation()
          }
          return
        }
        // Tab accepts an inline completion when ghost text is showing, matching a
        // normal editor. With editContext: true Monaco's own Tab dispatch can't be
        // relied on to commit (see inlineCompletionActions.ts), so we drive the
        // commit command here. No ghost text → let Tab fall through to indent.
        if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          if (isInlineSuggestionVisible(ed)) {
            // stopPropagation (not just preventDefault) is essential: this runs
            // in the capture phase, but Monaco's keybinding dispatch listens on
            // the same node in the bubble phase and ignores defaultPrevented, so
            // without stopping propagation Tab would also indent (a stray tab
            // after the accepted completion).
            e.preventDefault()
            e.stopPropagation()
            ed.trigger('keyboard', 'editor.action.inlineSuggest.commit', undefined)
          }
          return
        }
        if (e.key !== 'ArrowUp' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
        const pos = ed.getPosition()
        if (!pos) return
        if (ed.getTopForPosition(pos.lineNumber, pos.column) !== ed.getTopForPosition(1, 1)) return
        if (onArrowUpRef.current?.()) e.preventDefault()
      }
      dom.addEventListener('keydown', keydownHandler, true)
      disposables.push({ dispose: () => dom.removeEventListener('keydown', keydownHandler, true) })

      if (initialText) {
        const off = initialCaret ?? initialText.length
        ed.setPosition(model.getPositionAt(off))
      }
      if (autoFocus) ed.focus()
      onEditorReadyRef.current?.(ed, m)
      emitChange('content')
    }

    // Mount synchronously when Monaco is already loaded (reopening the panel,
    // and unit tests that preload it) so there's no empty-input flash; otherwise
    // wait for the lazy first load.
    const loaded = MonacoLoader.peek()
    if (loaded) mount(loaded)
    else void MonacoLoader.ensureInitialized().then(mount)

    return () => {
      disposed = true
      for (const d of disposables) d.dispose()
      trackerRef.current?.dispose()
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      trackerRef.current = null
      editorRef.current = null
      modelRef.current = null
      monacoRef.current = null
      // onDidBlurEditorText may not fire before dispose, leaving editorTextFocus
      // stuck true (see editor-text-focus-stuck-swallows-keys). Reconcile it
      // against actual DOM focus so it never lingers past unmount.
      queueMicrotask(() => syncEditorFocusContext(contextKeyService))
    }
    // Create once; theme/font live-updates handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={containerRef} className={styles['promptEditorInner']} />
}
