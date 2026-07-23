/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  InlineConflictController — attaches to a single Monaco code editor and renders
 *  git merge-conflict markers inline: whole-line tints for the current / incoming
 *  / base regions plus a CodeLens-style action bar (Accept Current / Accept
 *  Incoming / Accept Both, optionally Compare) on its own view-zone line above
 *  each conflict. Resolving is a plain, undoable model edit — no git CLI needed.
 *
 *  Shared by GitMergeConflictContribution (plain file editors) and MergeEditor's
 *  editable Result pane, so the resolution behaviour stays identical in both.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  Emitter,
  ThrottledDelayer,
  localize,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../editor/monaco/MonacoLoader.js'
import { recordTabSwitchPhase } from '../../../services/performance/tabSwitchPerf.js'
import { CONFLICT_START_MARKER, parseConflicts, type ConflictRegion } from './conflictParser.js'

type Choice = 'current' | 'incoming' | 'both' | 'compare'

/** Vertical band reserved above each conflict. Taller than the bar itself so the
 *  ABOVE-positioned content widget clears the previous line by a visible gap. */
const ACTION_BAR_ZONE_HEIGHT = 30

/** Coalesce per-keystroke re-scans (VSCode's merge-conflict tracker delays the same way). */
const RESCAN_DELAY_MS = 200

/** Scan result per model, keyed by version — a controller is rebuilt on every
 *  tab switch, so without this even the cheap prefilter re-walks a multi-MB
 *  buffer each time the user returns to an unedited file. */
const scanCache = new WeakMap<
  monaco.editor.ITextModel,
  { versionId: number; conflicts: readonly ConflictRegion[] }
>()

function scanConflicts(model: monaco.editor.ITextModel): readonly ConflictRegion[] {
  const cached = scanCache.get(model)
  if (cached && cached.versionId === model.getVersionId()) return cached.conflicts
  return recordTabSwitchPhase('mergeConflict.scan', () => {
    // Cheap piece-tree prefilter before the full-text scan: getValue() on a
    // multi-MB model per tab switch / keystroke stalls the renderer, and the
    // overwhelmingly common case is "no conflict markers at all".
    const marker = model.findNextMatch(
      CONFLICT_START_MARKER,
      { lineNumber: 1, column: 1 },
      false,
      true,
      null,
      false,
    )
    const conflicts = marker ? parseConflicts(model.getValue()) : []
    scanCache.set(model, { versionId: model.getVersionId(), conflicts })
    return conflicts
  })
}

export interface InlineConflictOptions {
  /** When set, an extra "Compare Changes" action is shown and routed here. */
  readonly onCompare?: (conflict: ConflictRegion) => void
}

export class InlineConflictController extends Disposable {
  private readonly _decorations: monaco.editor.IEditorDecorationsCollection
  private _zoneIds: string[] = []
  private _widgets: monaco.editor.IContentWidget[] = []
  private _count = 0
  private readonly _onDidChangeCount = this._register(new Emitter<number>())
  /** Fires with the number of remaining conflicts whenever it changes. */
  readonly onDidChangeCount = this._onDidChangeCount.event
  private readonly _modelStore = this._register(new DisposableStore())
  private readonly _rescanDelayer = this._register(new ThrottledDelayer<void>(RESCAN_DELAY_MS))

  constructor(
    private readonly _editor: monaco.editor.IStandaloneCodeEditor,
    private readonly _options: InlineConflictOptions = {},
  ) {
    super()
    this._decorations = _editor.createDecorationsCollection()
    this._bindModel()
    this._register(_editor.onDidChangeModel(() => this._bindModel()))
    // Only needed when Monaco is still loading at construction (render() above
    // bailed); once loaded, _bindModel already rendered — don't scan twice.
    if (!MonacoLoader.peek()) {
      void MonacoLoader.ensureInitialized().then(() => {
        if (!this._store.isDisposed) this.render()
      })
    }
    this._register({ dispose: () => this._clear() })
  }

  get count(): number {
    return this._count
  }

  private _bindModel(): void {
    this._modelStore.clear()
    const model = this._editor.getModel()
    if (model) {
      this._modelStore.add(
        model.onDidChangeContent(() => {
          // A superseded trigger's promise rejects with CancellationError — expected.
          void this._rescanDelayer.trigger(async () => this.render()).catch(() => undefined)
        }),
      )
    }
    this.render()
  }

  render(): void {
    const model = this._editor.getModel()
    if (!model || !MonacoLoader.peek()) return

    const conflicts = scanConflicts(model)
    this._setCount(conflicts.length)

    if (conflicts.length === 0) {
      this._setZones([])
      this._decorations.clear()
      return
    }

    const m = MonacoLoader.get()
    const decorations: monaco.editor.IModelDeltaDecoration[] = []
    const wholeLine = (startLine: number, endLine: number, className: string): void => {
      if (endLine < startLine) return
      decorations.push({
        range: new m.Range(startLine, 1, endLine, 1),
        options: { isWholeLine: true, className },
      })
    }

    for (const c of conflicts) {
      wholeLine(c.startLine, c.startLine, 'merge-conflict-header')
      wholeLine(c.incoming.headerLine, c.incoming.headerLine, 'merge-conflict-header')
      wholeLine(c.endLine, c.endLine, 'merge-conflict-header')
      wholeLine(
        c.current.contentStartLine,
        c.current.contentEndLine,
        'merge-conflict-current-content',
      )
      wholeLine(
        c.incoming.contentStartLine,
        c.incoming.contentEndLine,
        'merge-conflict-incoming-content',
      )
      if (c.base) {
        wholeLine(c.base.headerLine, c.base.headerLine, 'merge-conflict-header')
        wholeLine(c.base.contentStartLine, c.base.contentEndLine, 'merge-conflict-base-content')
      }
    }

    this._setZones(conflicts)
    this._decorations.set(decorations)
  }

  private _setCount(n: number): void {
    if (n === this._count) return
    this._count = n
    this._onDidChangeCount.fire(n)
  }

  private _setZones(conflicts: readonly ConflictRegion[]): void {
    const model = this._editor.getModel()
    // Clear previous widgets first (they reference disposed conflicts).
    for (const w of this._widgets) this._editor.removeContentWidget(w)
    this._widgets = []

    try {
      this._editor.changeViewZones((accessor) => {
        for (const id of this._zoneIds) accessor.removeZone(id)
        this._zoneIds = []
        if (!model) return
        for (const conflict of conflicts) {
          // A view zone only reserves the vertical band above the `<<<<<<<` marker
          // line; the clickable bar is a content widget rendered ABOVE that line,
          // so it lands at the band's bottom (a clear gap from the previous line)
          // and sits in Monaco's interactive overlay layer where clicks register —
          // view-zone DOM is non-interactive and would swallow the click.
          this._zoneIds.push(
            accessor.addZone({
              afterLineNumber: conflict.startLine - 1,
              heightInPx: ACTION_BAR_ZONE_HEIGHT,
              domNode: document.createElement('div'),
            }),
          )
          this._addActionsWidget(model, conflict)
        }
      })
    } catch {
      // The editor was disposed between scheduling and applying — nothing to clean.
      this._zoneIds = []
    }
  }

  private _addActionsWidget(model: monaco.editor.ITextModel, conflict: ConflictRegion): void {
    const m = MonacoLoader.get()
    const node = this._buildActionsBar(model, conflict)
    const widget: monaco.editor.IContentWidget = {
      getId: () => `merge-conflict-actions-${conflict.startLine}`,
      getDomNode: () => node,
      getPosition: () => ({
        position: { lineNumber: conflict.startLine, column: 1 },
        preference: [m.editor.ContentWidgetPositionPreference.ABOVE],
      }),
    }
    this._widgets.push(widget)
    this._editor.addContentWidget(widget)
  }

  private _buildActionsBar(model: monaco.editor.ITextModel, conflict: ConflictRegion): HTMLElement {
    const node = document.createElement('div')
    node.className = 'merge-conflict-actions'

    const addButton = (label: string, choice: Choice): void => {
      const btn = document.createElement('a')
      btn.className = 'merge-conflict-action'
      btn.textContent = label
      btn.setAttribute('role', 'button')
      btn.addEventListener('mousedown', (e) => {
        // Act on mousedown so the click isn't swallowed by the editor stealing focus.
        e.preventDefault()
        e.stopPropagation()
        this._resolve(model, conflict, choice)
      })
      node.appendChild(btn)
    }

    addButton(localize('mergeConflict.acceptCurrent', 'Accept Current Change'), 'current')
    addButton(localize('mergeConflict.acceptIncoming', 'Accept Incoming Change'), 'incoming')
    addButton(localize('mergeConflict.acceptBoth', 'Accept Both Changes'), 'both')
    if (this._options.onCompare) {
      addButton(localize('mergeConflict.compare', 'Compare Changes'), 'compare')
    }

    return node
  }

  private _resolve(
    model: monaco.editor.ITextModel,
    conflict: ConflictRegion,
    choice: Choice,
  ): void {
    if (choice === 'compare') {
      this._options.onCompare?.(conflict)
      return
    }

    const replacement =
      choice === 'current'
        ? conflict.current.content
        : choice === 'incoming'
          ? conflict.incoming.content
          : `${conflict.current.content}\n${conflict.incoming.content}`

    const m = MonacoLoader.get()
    const lineCount = model.getLineCount()
    // Replace whole lines startLine..endLine. When the conflict isn't at EOF,
    // extend to the start of the following line and re-append a newline so an
    // empty chosen side removes the lines entirely instead of leaving a blank.
    let range: monaco.Range
    let text: string
    if (conflict.endLine < lineCount) {
      range = new m.Range(conflict.startLine, 1, conflict.endLine + 1, 1)
      text = replacement === '' ? '' : `${replacement}\n`
    } else {
      range = new m.Range(
        conflict.startLine,
        1,
        conflict.endLine,
        model.getLineMaxColumn(conflict.endLine),
      )
      text = replacement
    }

    this._editor.pushUndoStop()
    this._editor.executeEdits('mergeConflict', [{ range, text, forceMoveMarkers: true }])
    this._editor.pushUndoStop()
  }

  private _clear(): void {
    this._modelStore.clear()
    for (const w of this._widgets) this._editor.removeContentWidget(w)
    this._widgets = []
    this._setZones([])
    this._decorations.clear()
  }
}
