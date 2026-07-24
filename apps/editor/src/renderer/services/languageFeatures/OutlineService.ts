/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineService — derives the active editor's document-symbol tree (and the
 *  symbol under the cursor) from the language features facade, exposing them as
 *  observables shared by the Outline view and the Breadcrumbs. It re-pulls
 *  symbols on content change (debounced) and on provider registration, and
 *  recomputes only the active symbol on cursor movement.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  createDecorator,
  createNamedLogger,
  Disposable,
  DisposableStore,
  IEditorService,
  ILoggerService,
  observableValue,
  transaction,
  type ILogger,
  type IObservable,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../editor/MarkdownPreviewInput.js'
import { MarkdownPreviewRegistry } from '../editor/MarkdownPreviewRegistry.js'
import { DocEditorInput } from '../editor/DocEditorInput.js'
import { docSymbolsFromMarkdown } from '../editor/docOutline.js'
import { getDocContent } from '../editor/docRegistry.js'
import { AcpSessionEditorInput } from '../acp/acpSessionEditorInput.js'
import { AcpSessionOutlineRegistry } from '../acp/acpSessionOutlineRegistry.js'
import {
  ACP_OUTLINE_LANGUAGE_ID,
  timelineToOutline,
  type TimelineOutline,
} from '../acp/acpTimelineOutline.js'
import { ILanguageFeaturesService } from './LanguageFeaturesService.js'
import { findSymbolAtLine } from './symbolTree.js'

export interface OutlineModel {
  readonly uri: string
  readonly roots: readonly monaco.languages.DocumentSymbol[]
  /** Language id of the model, so consumers can special-case symbol icons (e.g. markdown headings). */
  readonly languageId: string
  /** Monotonic counter; lets consumers detect a fresh tree even if roots is []. */
  readonly version: number
}

/** Snapshot of the active editor's selection + scroll, for preview cancel/restore. */
export interface OutlineViewState {
  readonly selection: monaco.Selection
  readonly scrollTop: number
  readonly scrollLeft: number
}

/** Which kind of editor the current outline is derived from (undefined when none). */
export type OutlineSourceKind = 'file' | 'preview' | 'doc' | 'session'

export interface IOutlineService {
  readonly _serviceBrand: undefined
  readonly outline: IObservable<OutlineModel | undefined>
  readonly activeSymbol: IObservable<monaco.languages.DocumentSymbol | undefined>
  /**
   * The kind of editor backing the current outline. Consumers use it to gate
   * file-only actions (e.g. Go to Definition works only for a code editor).
   */
  readonly sourceKind: IObservable<OutlineSourceKind | undefined>
  /** Move the active editor's cursor to a symbol and focus it. */
  revealSymbol(symbol: monaco.languages.DocumentSymbol): void
  /** Snapshot the active editor's selection + scroll (for preview restore). */
  captureViewState(): OutlineViewState | undefined
  /** Scroll a symbol into view and highlight it WITHOUT moving the cursor or stealing focus. */
  previewSymbol(symbol: monaco.languages.DocumentSymbol): void
  /** Restore a snapshot taken by captureViewState and clear any preview highlight. */
  restoreViewState(state: OutlineViewState): void
}

export const IOutlineService = createDecorator<IOutlineService>('outlineService')

const SYMBOL_RECOMPUTE_DEBOUNCE_MS = 200

// A just-opened (or restored) file's language server may not have analysed it yet
// — a cold tsserver start on a large project can take a minute or more, and a
// clean file with no diagnostics never fires a marker change to re-trigger a pull.
// The first pull then returns [] and, without a re-pull, the outline stays blank
// permanently (which is why a restored editor's outline could be stuck empty, and
// why toggling the view didn't fix it — the service value never became non-empty).
// Keep re-pulling with exponential backoff (250 → 500 → 1000 → 2000, then 2000
// each) for as long as the outline is still empty, up to a generous total budget
// so it fills in once the server finally answers.
const INITIAL_PULL_RETRY_MS = 250
const MAX_PULL_RETRY_MS = 2000
const PULL_RETRY_BUDGET_MS = 180_000

// A single symbol pull must always settle so the retry chain (which schedules the
// next attempt only from a pull's then/catch) keeps turning. A `.catch()` handles
// a rejected pull, but NOT one that hangs forever: the JSON symbol provider awaits
// Monaco's JSON worker (a web-worker RPC + dynamic import), which on a cold,
// contended Ubuntu CI runner can leave a request queued and never resolving —
// then/catch never fire, `_maybeRetry` is never called, and the outline stays
// stuck at the empty tree. Race every pull against a timeout so a stuck pull is
// treated as one failed attempt and retried, instead of silently killing the
// chain. A healthy pull is far faster than this; a timeout only costs one extra
// retry (the worker is warm by the next attempt).
const PULL_TIMEOUT_MS = 5000

const NONE_TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as monaco.CancellationToken

export class OutlineService extends Disposable implements IOutlineService {
  declare readonly _serviceBrand: undefined

  private readonly _outline = observableValue<OutlineModel | undefined>(
    'OutlineService.outline',
    undefined,
  )
  private readonly _activeSymbol = observableValue<monaco.languages.DocumentSymbol | undefined>(
    'OutlineService.activeSymbol',
    undefined,
  )
  readonly outline: IObservable<OutlineModel | undefined> = this._outline
  readonly activeSymbol: IObservable<monaco.languages.DocumentSymbol | undefined> =
    this._activeSymbol

  private readonly _sourceKind = observableValue<OutlineSourceKind | undefined>(
    'OutlineService.sourceKind',
    undefined,
  )
  readonly sourceKind: IObservable<OutlineSourceKind | undefined> = this._sourceKind

  /** Subscriptions bound to the currently-attached model + editor. */
  private readonly _attachListeners = this._register(new DisposableStore())
  private _currentInput: FileEditorInput | undefined
  /** Set instead of `_currentInput` when the active editor is a markdown preview. */
  private _currentPreview: MarkdownPreviewInput | undefined
  /** Set instead of `_currentInput` when the active editor is a built-in guide doc. */
  private _currentDoc: DocEditorInput | undefined
  /** Set instead of `_currentInput` when the active editor is an agent session. */
  private _currentSession: AcpSessionEditorInput | undefined
  /** Key↔pseudo-line maps for the current session outline, bridging slot keys to lines. */
  private _sessionOutline: TimelineOutline | undefined
  private _currentModel: monaco.editor.ITextModel | undefined
  private _version = 0
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  private _retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped on every (re)attach; pending retries from a superseded attach bail. */
  private _attachGeneration = 0
  /** Active live-preview highlight, owned by whichever editor it was set on. */
  private _previewDecorations: monaco.editor.IEditorDecorationsCollection | undefined

  private readonly _logger: ILogger

  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()

    this._logger = createNamedLogger(loggerService, { id: 'outline', name: 'Outline' })

    // Re-attach whenever the active editor changes.
    this._register(
      autorun((r) => {
        this._editorService.activeEditor.read(r)
        this._attachActiveEditor()
      }),
    )

    // The Monaco editor mounts asynchronously after the input becomes active;
    // FileEditorRegistry fires once it (un)mounts, so re-attach then too.
    this._register(
      FileEditorRegistry.onDidChange((input) => {
        if (input === this._currentInput) this._attachActiveEditor()
      }),
    )

    // The preview component mounts asynchronously too; its controller registers
    // once the DOM is ready, so re-attach to pull symbols when it appears. The
    // built-in doc reader registers its controller in the same registry (keyed
    // on the doc resource), so re-attach then as well to pick up scroll tracking.
    this._register(
      MarkdownPreviewRegistry.onDidChange((uri) => {
        if (this._currentPreview && uri.toString() === this._currentPreview.sourceUri.toString()) {
          this._attachActiveEditor()
          return
        }
        if (this._currentDoc && uri.toString() === this._currentDoc.resource.toString()) {
          this._attachActiveEditor()
        }
      }),
    )

    // A link-navigated preview acquires its source model on demand (after an
    // async disk read), so the model can appear AFTER we first attached and found
    // none. Re-attach when the source model we were waiting on shows up.
    this._register(
      MonacoModelRegistry.onDidAddModel((uri) => {
        if (this._currentPreview && uri.toString() === this._currentPreview.sourceUri.toString()) {
          this._attachActiveEditor()
        }
      }),
    )

    // The agent-session ChatBody mounts asynchronously after its editor input
    // becomes active (and re-mounts on chat-location swaps); its outline
    // controller registers once the DOM is ready, so re-attach when it appears.
    this._register(
      AcpSessionOutlineRegistry.onDidChange((sessionId) => {
        if (this._currentSession && sessionId === this._currentSession.sessionId) {
          this._attachActiveEditor()
        }
      }),
    )

    // Providers register at AfterRestore — possibly after the first editor is
    // already active — and a freshly-registered server still needs a moment to
    // analyse the file, so its first pull may be empty. Recompute WITH retries.
    this._register(
      this._languageFeatures.onDidChangeDocumentSymbolProviders(() =>
        this._recomputeSymbols({
          generation: this._attachGeneration,
          delay: INITIAL_PULL_RETRY_MS,
          elapsed: 0,
        }),
      ),
    )
  }

  private _attachActiveEditor(): void {
    const input = this._editorService.activeEditor.get()
    const fileInput = input instanceof FileEditorInput ? input : undefined
    const previewInput = input instanceof MarkdownPreviewInput ? input : undefined
    const docInput = input instanceof DocEditorInput ? input : undefined
    const sessionInput = input instanceof AcpSessionEditorInput ? input : undefined
    const sameInput = fileInput !== undefined && fileInput === this._currentInput

    this._attachListeners.clear()
    this._clearDebounce()
    this._clearPreviewDecorations()

    // Switching to a DIFFERENT file invalidates the old file's in-flight retries
    // (bump generation) and clears its timer. A SAME-file re-attach — the editor
    // re-mounting / re-registering while the language server is still analysing —
    // must NOT cancel the running retry chain, or the outline can stay stuck empty
    // as repeated re-registrations keep killing each scheduled retry.
    const samePreview =
      previewInput !== undefined &&
      this._currentPreview !== undefined &&
      previewInput.sourceUri.toString() === this._currentPreview.sourceUri.toString()
    const sameDoc =
      docInput !== undefined &&
      this._currentDoc !== undefined &&
      docInput.docId === this._currentDoc.docId
    const sameSession =
      sessionInput !== undefined &&
      this._currentSession !== undefined &&
      sessionInput.sessionId === this._currentSession.sessionId
    if (!sameInput && !samePreview && !sameDoc && !sameSession) {
      this._clearRetry()
      this._attachGeneration++
    }
    const generation = this._attachGeneration
    this._currentInput = fileInput
    this._currentPreview = previewInput
    this._currentDoc = docInput
    this._currentSession = sessionInput
    if (!sessionInput) this._sessionOutline = undefined

    if (sessionInput) {
      this._sourceKind.set('session', undefined)
      this._attachSession(sessionInput)
      return
    }

    if (previewInput) {
      this._sourceKind.set('preview', undefined)
      this._attachPreview(previewInput, samePreview, generation)
      return
    }

    if (docInput) {
      this._sourceKind.set('doc', undefined)
      this._attachDoc(docInput)
      return
    }

    if (!fileInput) {
      this._sourceKind.set(undefined, undefined)
      this._currentModel = undefined
      this._clearRetry()
      this._publish(undefined, undefined)
      return
    }

    this._sourceKind.set('file', undefined)

    const editor = FileEditorRegistry.get(fileInput)
    const model = editor?.getModel() ?? MonacoModelRegistry.peek(fileInput.resource)

    if (!model) {
      // Editor not mounted yet; FileEditorRegistry.onDidChange will re-attach.
      // On a same-file re-attach the editor is just transiently unmounted (e.g. a
      // re-layout): keep the previous model + any in-flight retry so the outline
      // doesn't blank out and the retry can still fill it once the editor is back.
      if (!sameInput) {
        this._currentModel = undefined
        this._publish(undefined, undefined)
      }
      return
    }
    this._currentModel = model

    this._attachListeners.add(model.onDidChangeContent(() => this._scheduleRecompute()))
    // Symbols are pulled, but a language server (e.g. tsserver) isn't ready when a
    // file first opens — that first pull returns []. A diagnostics push means the
    // server has now parsed this file, so re-pull when its markers change;
    // otherwise the outline stays empty until the editor is re-activated.
    const monacoNs = MonacoLoader.peek()
    if (monacoNs) {
      this._attachListeners.add(
        monacoNs.editor.onDidChangeMarkers((resources) => {
          const uri = model.uri.toString()
          if (resources.some((r) => r.toString() === uri)) this._scheduleRecompute()
        }),
      )
    }
    if (editor) {
      this._attachListeners.add(
        editor.onDidChangeCursorPosition(() => this._recomputeActiveSymbol()),
      )
    }

    // Start the initial pull + retry chain. On a same-file re-attach, leave an
    // already-running retry alone (and don't re-pull when we already have this
    // file's symbols) — only (re)start when nothing is working on it yet.
    const current = this._outline.get()
    const haveSymbols =
      current !== undefined && current.uri === model.uri.toString() && current.roots.length > 0
    if (!sameInput || (!haveSymbols && this._retryTimer === undefined)) {
      this._recomputeSymbols({
        generation,
        delay: INITIAL_PULL_RETRY_MS,
        elapsed: 0,
      })
    }
  }

  /**
   * Attach to a markdown preview: pull symbols from the source file's shared
   * model (the preview holds the source open, so it stays alive), and track the
   * active heading from the preview's top visible line instead of a cursor.
   */
  private _attachPreview(
    preview: MarkdownPreviewInput,
    samePreview: boolean,
    generation: number,
  ): void {
    const model = MonacoModelRegistry.peek(preview.sourceUri)
    if (!model) {
      // Source not open (e.g. a restored standalone preview): no shared model to
      // pull symbols from. DocumentSyncContribution mirrors it on activation, so
      // MarkdownPreviewRegistry.onDidChange / a later mount re-attaches.
      if (!samePreview) {
        this._currentModel = undefined
        this._publish(undefined, undefined)
      }
      return
    }
    this._currentModel = model

    this._attachListeners.add(model.onDidChangeContent(() => this._scheduleRecompute()))
    const controller = MarkdownPreviewRegistry.get(preview.sourceUri)
    if (controller) {
      this._attachListeners.add(controller.onDidScroll(() => this._recomputeActiveSymbol()))
    }

    const current = this._outline.get()
    const haveSymbols =
      current !== undefined && current.uri === model.uri.toString() && current.roots.length > 0
    if (!samePreview || (!haveSymbols && this._retryTimer === undefined)) {
      this._recomputeSymbols({ generation, delay: INITIAL_PULL_RETRY_MS, elapsed: 0 })
    }
  }

  /**
   * Attach to a built-in guide doc: the markdown is a static string in the
   * docRegistry cache (no Monaco model, no language server), so the heading tree
   * is parsed synchronously — no pull, no retry chain. Scroll tracking and
   * reveal go through the reader controller the DocEditor registers in
   * MarkdownPreviewRegistry (keyed on the doc resource), same as the preview.
   */
  private _attachDoc(doc: DocEditorInput): void {
    this._currentModel = undefined
    this._clearRetry()

    const content = getDocContent(doc.docId)
    const roots = content !== undefined ? docSymbolsFromMarkdown(content) : []
    this._outline.set(
      { uri: doc.resource.toString(), roots, languageId: 'markdown', version: ++this._version },
      undefined,
    )

    const controller = MarkdownPreviewRegistry.get(doc.resource)
    if (controller) {
      this._attachListeners.add(controller.onDidScroll(() => this._recomputeActiveSymbol()))
    }
    this._recomputeActiveSymbol()
  }

  /**
   * Attach to a full-screen agent session: synthesize the outline from the
   * session's timeline (message / tool-call slots, sub-agents nested) rather than
   * a language provider. Tracks the active item from the chat's top-visible slot,
   * mirroring the preview's top-visible-line tracking. No Monaco model is involved,
   * so there is no retry chain — the timeline observable drives recomputes.
   */
  private _attachSession(session: AcpSessionEditorInput): void {
    this._currentModel = undefined
    this._clearRetry()

    const controller = AcpSessionOutlineRegistry.get(session.sessionId)
    if (!controller) {
      // ChatBody not mounted yet; AcpSessionOutlineRegistry.onDidChange re-attaches.
      this._sessionOutline = undefined
      this._publish(undefined, undefined)
      return
    }

    // Rebuild the outline whenever the timeline changes, and retrack the active
    // item as the user scrolls the chat or moves the keyboard selection.
    this._attachListeners.add(
      autorun((r) => {
        controller.timeline.read(r)
        this._recomputeSessionOutline(session)
      }),
    )
    this._attachListeners.add(controller.onDidChangeActive(() => this._recomputeActiveSymbol()))
  }

  private _recomputeSessionOutline(session: AcpSessionEditorInput): void {
    const controller = AcpSessionOutlineRegistry.get(session.sessionId)
    if (!controller || this._currentSession !== session) return
    const built = timelineToOutline(controller.timeline.get())
    this._sessionOutline = built
    const uri = session.resource.toString()
    this._outline.set(
      { uri, roots: built.roots, languageId: ACP_OUTLINE_LANGUAGE_ID, version: ++this._version },
      undefined,
    )
    this._recomputeActiveSymbol()
  }

  private _scheduleRecompute(): void {
    this._clearDebounce()
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined
      this._recomputeSymbols()
    }, SYMBOL_RECOMPUTE_DEBOUNCE_MS)
  }

  private _recomputeSymbols(retry?: { generation: number; delay: number; elapsed: number }): void {
    const model = this._currentModel
    if (!model || model.isDisposed()) return

    const providers = this._languageFeatures.getDocumentSymbolProviders(model.getLanguageId())
    const provider = providers[0]
    const languageId = model.getLanguageId()
    if (!provider) {
      // The provider may simply not be registered yet (language plugins activate
      // lazily). Publish empty for now but keep retrying so the outline fills in
      // once the provider appears, instead of staying blank until re-activation.
      this._publish(
        { uri: model.uri.toString(), roots: [], languageId, version: ++this._version },
        undefined,
      )
      this._maybeRetry([], retry)
      return
    }

    const pullStarted = performance.now()
    void this._pullWithTimeout(provider, model)
      .then((result) => {
        // Discard if the model was swapped or disposed while we awaited.
        if (this._currentModel !== model || model.isDisposed()) return
        const roots = result ?? []
        const pullMs = performance.now() - pullStarted
        if (pullMs > 500) {
          this._logger.info(
            `document-symbol pull ${model.uri.toString()} took ${pullMs.toFixed(0)}ms roots=${roots.length} lines=${model.getLineCount()}`,
          )
        }
        this._outline.set(
          { uri: model.uri.toString(), roots, languageId, version: ++this._version },
          undefined,
        )
        this._recomputeActiveSymbol()
        this._maybeRetry(roots, retry)
      })
      .catch((err: unknown) => {
        // A provider can reject — or hang past PULL_TIMEOUT_MS — during a cold
        // start: the JSON symbol provider delegates to Monaco's JSON worker, which
        // may not be warm yet (the workbench now mounts before Monaco finishes
        // loading) and can either reject OR never settle. Without this catch (and
        // the timeout that guarantees we reach it) the retry chain would die
        // silently here and the outline would stay stuck at the empty tree
        // published before the provider appeared.
        if (this._currentModel !== model || model.isDisposed()) return
        this._logger.debug(
          `document-symbol pull failed for ${languageId} (${model.uri.toString()}); retrying: ${
            (err as Error).message
          }`,
        )
        this._maybeRetry([], retry)
      })
  }

  /**
   * Pull symbols, but reject if the provider hasn't answered within
   * PULL_TIMEOUT_MS. Guarantees the returned promise always settles so the retry
   * chain (driven from the pull's then/catch) can't stall on a provider whose
   * underlying worker RPC never resolves.
   */
  private _pullWithTimeout(
    provider: monaco.languages.DocumentSymbolProvider,
    model: monaco.editor.ITextModel,
  ): Promise<monaco.languages.DocumentSymbol[] | null | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`document-symbol pull timed out after ${PULL_TIMEOUT_MS}ms`))
      }, PULL_TIMEOUT_MS)
      Promise.resolve(provider.provideDocumentSymbols(model, NONE_TOKEN)).then(
        (result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        },
        (err: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  }

  /** Schedule another pull (with exponential backoff) while the outline is still empty and the time budget remains. */
  private _maybeRetry(
    roots: readonly monaco.languages.DocumentSymbol[],
    retry: { generation: number; delay: number; elapsed: number } | undefined,
  ): void {
    if (
      roots.length > 0 ||
      !retry ||
      retry.elapsed >= PULL_RETRY_BUDGET_MS ||
      retry.generation !== this._attachGeneration
    ) {
      return
    }
    this._clearRetry()
    this._retryTimer = setTimeout(() => {
      this._retryTimer = undefined
      if (retry.generation !== this._attachGeneration) return
      this._recomputeSymbols({
        generation: retry.generation,
        delay: Math.min(retry.delay * 2, MAX_PULL_RETRY_MS),
        elapsed: retry.elapsed + retry.delay,
      })
    }, retry.delay)
  }

  private _recomputeActiveSymbol(): void {
    const roots = this._outline.get()?.roots

    // Agent session: the "cursor" is the session's active slot — the
    // keyboard-selected item, or the top-visible slot when nothing is selected.
    // Map its slot key back to a pseudo-line, then to the deepest symbol there.
    if (this._currentSession) {
      const built = this._sessionOutline
      if (!roots || !built) {
        this._activeSymbol.set(undefined, undefined)
        return
      }
      const key = AcpSessionOutlineRegistry.get(this._currentSession.sessionId)?.getActiveKey()
      const line = key !== undefined ? built.lineByKey.get(key) : undefined
      this._activeSymbol.set(
        line !== undefined ? findSymbolAtLine(roots, line) : undefined,
        undefined,
      )
      return
    }

    const model = this._currentModel
    if (!roots) {
      this._activeSymbol.set(undefined, undefined)
      return
    }

    // In a preview or doc reader the "cursor" is the top of the viewport (a doc
    // has no Monaco model, hence no model guard on that path); otherwise it's
    // the Monaco editor's cursor line.
    let line: number | undefined
    const readerUri = this._currentPreview?.sourceUri ?? this._currentDoc?.resource
    if (readerUri !== undefined) {
      line = MarkdownPreviewRegistry.get(readerUri)?.getTopVisibleLine()
    } else {
      if (!model) {
        this._activeSymbol.set(undefined, undefined)
        return
      }
      const editor = this._currentInput ? FileEditorRegistry.get(this._currentInput) : undefined
      line = editor?.getPosition()?.lineNumber
    }

    if (line === undefined) {
      this._activeSymbol.set(undefined, undefined)
      return
    }
    this._activeSymbol.set(findSymbolAtLine(roots, line), undefined)
  }

  private _publish(
    outline: OutlineModel | undefined,
    active: monaco.languages.DocumentSymbol | undefined,
  ): void {
    transaction((tx) => {
      this._outline.set(outline, tx)
      this._activeSymbol.set(active, tx)
    })
  }

  revealSymbol(symbol: monaco.languages.DocumentSymbol): void {
    if (this._currentSession) {
      // Map the symbol's pseudo-line back to its slot key, then scroll+focus the
      // chat — the session equivalent of the preview's scrollToLine + focus.
      const built = this._sessionOutline
      const key = built?.keyByLine.get(symbol.selectionRange.startLineNumber)
      if (key === undefined) return
      const controller = AcpSessionOutlineRegistry.get(this._currentSession.sessionId)
      controller?.scrollToKey(key)
      controller?.focus()
      return
    }
    const readerUri = this._currentPreview?.sourceUri ?? this._currentDoc?.resource
    if (readerUri !== undefined) {
      const controller = MarkdownPreviewRegistry.get(readerUri)
      controller?.scrollToLine(symbol.selectionRange.startLineNumber)
      controller?.focus()
      return
    }
    const input = this._currentInput
    if (!input) return
    const editor = FileEditorRegistry.get(input)
    if (!editor) return
    const { startLineNumber, startColumn } = symbol.selectionRange
    editor.setPosition({ lineNumber: startLineNumber, column: startColumn })
    editor.revealLineInCenterIfOutsideViewport(startLineNumber)
    editor.focus()
  }

  captureViewState(): OutlineViewState | undefined {
    const input = this._currentInput
    if (!input) return undefined
    const editor = FileEditorRegistry.get(input)
    const selection = editor?.getSelection()
    if (!editor || !selection) return undefined
    return { selection, scrollTop: editor.getScrollTop(), scrollLeft: editor.getScrollLeft() }
  }

  previewSymbol(symbol: monaco.languages.DocumentSymbol): void {
    const input = this._currentInput
    if (!input) return
    const editor = FileEditorRegistry.get(input)
    if (!editor) return
    editor.revealLineInCenter(symbol.selectionRange.startLineNumber)
    const collection = this._previewDecorations ?? editor.createDecorationsCollection()
    this._previewDecorations = collection
    collection.set([
      {
        range: symbol.range,
        options: { isWholeLine: true, className: 'rangeHighlight' },
      },
    ])
  }

  restoreViewState(state: OutlineViewState): void {
    this._clearPreviewDecorations()
    const input = this._currentInput
    if (!input) return
    const editor = FileEditorRegistry.get(input)
    if (!editor) return
    editor.setSelection(state.selection)
    editor.setScrollTop(state.scrollTop)
    editor.setScrollLeft(state.scrollLeft)
  }

  private _clearPreviewDecorations(): void {
    this._previewDecorations?.clear()
    this._previewDecorations = undefined
  }

  private _clearDebounce(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = undefined
    }
  }

  private _clearRetry(): void {
    if (this._retryTimer !== undefined) {
      clearTimeout(this._retryTimer)
      this._retryTimer = undefined
    }
  }

  override dispose(): void {
    this._clearDebounce()
    this._clearRetry()
    this._clearPreviewDecorations()
    super.dispose()
  }
}
