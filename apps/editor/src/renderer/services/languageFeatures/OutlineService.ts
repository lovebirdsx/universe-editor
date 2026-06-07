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
  Disposable,
  DisposableStore,
  IEditorService,
  observableValue,
  transaction,
  type IObservable,
} from '@universe-editor/platform'
import { type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../editor/FileEditorRegistry.js'
import { ILanguageFeaturesService } from './LanguageFeaturesService.js'
import { findSymbolAtLine } from './markdown/markdownSymbols.js'

export interface OutlineModel {
  readonly uri: string
  readonly roots: readonly monaco.languages.DocumentSymbol[]
  /** Monotonic counter; lets consumers detect a fresh tree even if roots is []. */
  readonly version: number
}

/** Snapshot of the active editor's selection + scroll, for preview cancel/restore. */
export interface OutlineViewState {
  readonly selection: monaco.Selection
  readonly scrollTop: number
  readonly scrollLeft: number
}

export interface IOutlineService {
  readonly _serviceBrand: undefined
  readonly outline: IObservable<OutlineModel | undefined>
  readonly activeSymbol: IObservable<monaco.languages.DocumentSymbol | undefined>
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

  /** Subscriptions bound to the currently-attached model + editor. */
  private readonly _attachListeners = this._register(new DisposableStore())
  private _currentInput: FileEditorInput | undefined
  private _currentModel: monaco.editor.ITextModel | undefined
  private _version = 0
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  /** Active live-preview highlight, owned by whichever editor it was set on. */
  private _previewDecorations: monaco.editor.IEditorDecorationsCollection | undefined

  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
  ) {
    super()

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

    // Providers register at AfterRestore — possibly after the first editor is
    // already active — so recompute when the provider set changes.
    this._register(
      this._languageFeatures.onDidChangeDocumentSymbolProviders(() => this._recomputeSymbols()),
    )
  }

  private _attachActiveEditor(): void {
    const input = this._editorService.activeEditor.get()
    const fileInput = input instanceof FileEditorInput ? input : undefined

    this._attachListeners.clear()
    this._clearDebounce()
    this._clearPreviewDecorations()
    this._currentInput = fileInput

    if (!fileInput) {
      this._currentModel = undefined
      this._publish(undefined, undefined)
      return
    }

    const editor = FileEditorRegistry.get(fileInput)
    const model = editor?.getModel() ?? MonacoModelRegistry.peek(fileInput.resource)
    this._currentModel = model ?? undefined

    if (!model) {
      // Editor not mounted yet; FileEditorRegistry.onDidChange will re-attach.
      this._publish(undefined, undefined)
      return
    }

    this._attachListeners.add(
      model.onDidChangeContent(() => {
        this._clearDebounce()
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = undefined
          this._recomputeSymbols()
        }, SYMBOL_RECOMPUTE_DEBOUNCE_MS)
      }),
    )
    if (editor) {
      this._attachListeners.add(
        editor.onDidChangeCursorPosition(() => this._recomputeActiveSymbol()),
      )
    }

    this._recomputeSymbols()
  }

  private _recomputeSymbols(): void {
    const model = this._currentModel
    if (!model || model.isDisposed()) return

    const providers = this._languageFeatures.getDocumentSymbolProviders(model.getLanguageId())
    const provider = providers[0]
    if (!provider) {
      this._publish({ uri: model.uri.toString(), roots: [], version: ++this._version }, undefined)
      return
    }

    void Promise.resolve(provider.provideDocumentSymbols(model, NONE_TOKEN)).then((result) => {
      // Discard if the model was swapped or disposed while we awaited.
      if (this._currentModel !== model || model.isDisposed()) return
      const roots = result ?? []
      this._outline.set({ uri: model.uri.toString(), roots, version: ++this._version }, undefined)
      this._recomputeActiveSymbol()
    })
  }

  private _recomputeActiveSymbol(): void {
    const model = this._currentModel
    const input = this._currentInput
    const editor = input ? FileEditorRegistry.get(input) : undefined
    const position = editor?.getPosition()
    const roots = this._outline.get()?.roots
    if (!model || !position || !roots) {
      this._activeSymbol.set(undefined, undefined)
      return
    }
    this._activeSymbol.set(findSymbolAtLine(roots, position.lineNumber), undefined)
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

  override dispose(): void {
    this._clearDebounce()
    this._clearPreviewDecorations()
    super.dispose()
  }
}
