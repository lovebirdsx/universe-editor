/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  InlineDirtyDiffController — VSCode-style "quick diff" peek shown when the user
 *  clicks a dirty-diff gutter bar. Mirrors VSCode's QuickDiffWidget: a header with
 *  a codicon action bar (previous / next change, revert, stage, open changes,
 *  close) over an EMBEDDED Monaco diff editor (HEAD ↔ current).
 *
 *  Rendering follows VSCode's ZoneWidget exactly: an EMPTY view zone reserves the
 *  vertical band (so it never paints over code) while the panel itself is an
 *  OVERLAY widget the zone repositions via onDomNodeTop / onComputedHeight. The
 *  overlay sits in the editor's interactive, scrollable layer and spans from the
 *  far left (over the line-number margin) to just inside the vertical scrollbar.
 *
 *  Sizing mirrors VSCode: the panel opens at min(change + context, 1/3 of the
 *  editor) lines and is resizable by dragging its bottom edge up to 80% of the
 *  editor height (ZoneWidget's _getMaximumHeightInLines). When the change sits
 *  outside the viewport the editor scrolls it to the centre first (revealRange).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, localize } from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../editor/monaco/MonacoLoader.js'
import type { DirtyDiffRegion } from '../../../contributions/dirtyDiff.js'

export interface InlineDirtyDiffCallbacks {
  /** Restore this region's lines to their HEAD content (undoable model edit). */
  readonly onRevert: (region: DirtyDiffRegion) => void
  /** Stage just this region's hunk into the git index. */
  readonly onStage: (region: DirtyDiffRegion) => void
  /** Open the full working-tree diff for the file in a new editor tab. */
  readonly onOpenChanges: () => void
}

/** Header height in px, matching VSCode's peek-view title bar. */
const HEADER_HEIGHT = 28
/** Context lines added above/below the change when sizing the panel (VSCode: ~6). */
const CONTEXT_LINES = 6
/** Floor on the panel's total height, in text lines. */
const MIN_PANEL_LINES = 8

let _peekModelSeq = 0

export class InlineDirtyDiffController extends Disposable {
  private _zoneId: string | undefined
  private _overlay: monaco.editor.IOverlayWidget | undefined
  private _node: HTMLElement | undefined
  private _bodyNode: HTMLElement | undefined
  private _diffEditor: monaco.editor.IStandaloneDiffEditor | undefined
  private _originalModel: monaco.editor.ITextModel | undefined
  private _modifiedModel: monaco.editor.ITextModel | undefined
  private _index = -1
  private _regions: readonly DirtyDiffRegion[] = []
  private _headText = ''
  /** Current panel height in text lines (header included); drag-resizable. */
  private _heightInLines = 0
  private readonly _sessionStore = this._register(new DisposableStore())

  constructor(
    private readonly _editor: monaco.editor.IStandaloneCodeEditor,
    private readonly _callbacks: InlineDirtyDiffCallbacks,
  ) {
    super()
    this._register({ dispose: () => this._teardown() })
  }

  get isOpen(): boolean {
    return this._index !== -1
  }

  get index(): number {
    return this._index
  }

  /** Open (or move) the peek to the region at `index`. */
  show(regions: readonly DirtyDiffRegion[], index: number, headText: string): void {
    if (!MonacoLoader.peek()) return
    if (index < 0 || index >= regions.length) return
    this._regions = regions
    this._headText = headText
    this._index = index
    this._heightInLines = this._initialHeightInLines(regions[index]!)
    this._render()
  }

  next(): void {
    if (this._index === -1 || this._regions.length === 0) return
    this.show(this._regions, (this._index + 1) % this._regions.length, this._headText)
  }

  previous(): void {
    if (this._index === -1 || this._regions.length === 0) return
    const n = this._regions.length
    this.show(this._regions, (this._index - 1 + n) % n, this._headText)
  }

  close(): void {
    if (this._index === -1) return
    this._index = -1
    this._sessionStore.clear()
    this._teardown()
    this._editor.focus()
  }

  /** Re-render against fresh regions/head while staying on the same change index. */
  refresh(regions: readonly DirtyDiffRegion[], headText: string): void {
    if (this._index === -1) return
    if (regions.length === 0) {
      this.close()
      return
    }
    this.show(regions, Math.min(this._index, regions.length - 1), headText)
  }

  /** Current panel height in px (for E2E introspection), or undefined when closed. */
  get panelHeightPx(): number | undefined {
    if (this._index === -1) return undefined
    return Math.round(this._heightInLines * this._fontInfo().lineHeight)
  }

  /** The capped maximum panel height in px (for E2E introspection). */
  get maxHeightPx(): number | undefined {
    if (this._index === -1) return undefined
    return Math.round(this._maxHeightInLines() * this._fontInfo().lineHeight)
  }

  /**
   * Grow / shrink the panel by `deltaPx`, clamped to [MIN_PANEL_LINES, max].
   * Returns the resulting height in px. Backs both the drag handle and the E2E
   * resize probe.
   */
  resizeByPx(deltaPx: number): number | undefined {
    if (this._index === -1) return undefined
    const lineHeight = this._fontInfo().lineHeight
    const deltaLines = deltaPx / lineHeight
    const rounded = deltaLines < 0 ? Math.ceil(deltaLines) : Math.floor(deltaLines)
    const next = Math.max(
      MIN_PANEL_LINES,
      Math.min(this._maxHeightInLines(), this._heightInLines + rounded),
    )
    if (next !== this._heightInLines) {
      this._heightInLines = next
      this._relayoutZone()
    }
    return this.panelHeightPx
  }

  private _render(): void {
    const region = this._regions[this._index]
    const model = this._editor.getModel()
    if (!region || !model) return
    const m = MonacoLoader.get()

    this._teardown()

    const panelHeight = this._heightInLines * this._fontInfo().lineHeight

    // Panel DOM = header + body + drag handle; the body hosts the embedded diff
    // editor. The panel is an OVERLAY widget (interactive + scrollable layer); an
    // empty view zone of the same height reserves the band and drives the
    // overlay's top/height.
    const node = document.createElement('div')
    node.className = `inline-dirty-diff inline-dirty-diff-${region.kind}`
    node.style.top = '-1000px'
    node.appendChild(this._buildHeader(region))

    const body = document.createElement('div')
    body.className = 'inline-dirty-diff-body'
    node.appendChild(body)
    node.appendChild(this._buildResizeHandle())
    this._node = node
    this._bodyNode = body

    const overlay: monaco.editor.IOverlayWidget = {
      getId: () => 'inline-dirty-diff-peek',
      getDomNode: () => node,
      getPosition: () => null,
    }
    this._overlay = overlay
    this._editor.addOverlayWidget(overlay)

    this._setZone(region.endLine, panelHeight)
    this._layoutNode()

    // Build the embedded diff editor in the body (now attached to the DOM).
    const languageId = model.getLanguageId()
    const seq = _peekModelSeq++
    const original = m.editor.createModel(
      this._headText.replace(/\r\n/g, '\n'),
      languageId,
      m.Uri.parse(`dirtydiff-peek://original/${seq}`),
    )
    const modified = m.editor.createModel(
      model.getValue(),
      languageId,
      m.Uri.parse(`dirtydiff-peek://modified/${seq}`),
    )
    this._originalModel = original
    this._modifiedModel = modified

    const font = this._fontInfo()
    const diffEditor = m.editor.createDiffEditor(body, {
      automaticLayout: false,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      renderOverviewRuler: false,
      renderMarginRevertIcon: false,
      diffAlgorithm: 'advanced',
      ignoreTrimWhitespace: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      folding: false,
      lineNumbers: 'on',
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      lineHeight: font.lineHeight,
      scrollbar: {
        alwaysConsumeMouseWheel: true,
        verticalScrollbarSize: 12,
        horizontal: 'auto',
        useShadows: true,
        verticalHasArrows: false,
        horizontalHasArrows: false,
      },
    })
    this._diffEditor = diffEditor
    diffEditor.setModel({ original, modified })
    this._layoutDiff(panelHeight)

    // The diff is computed asynchronously; reveal the change once it lands so a
    // long hunk opens scrolled to its first changed line (VSCode parity).
    const sub = diffEditor.onDidUpdateDiff(() => {
      sub.dispose()
      const reveal = region.kind === 'deleted' ? Math.max(1, region.startLine) : region.startLine
      diffEditor.getModifiedEditor().revealLineInCenter(reveal)
    })
    this._sessionStore.add(sub)
    this._sessionStore.add(this._editor.onDidLayoutChange(() => this._layoutNode()))

    // Scroll the change (and the panel below it) into view if it's off-screen.
    // Matches VSCode QuickDiffWidget.revealRange: centre the change's end line.
    this._editor.revealLineInCenterIfOutsideViewport(region.endLine)
  }

  /**
   * Initial panel height in lines. Mirrors VSCode QuickDiffWidget.showChange:
   * min(change height + context + header, 1/3 of the editor in lines), floored at
   * MIN_PANEL_LINES.
   */
  private _initialHeightInLines(region: DirtyDiffRegion): number {
    const lineHeight = this._fontInfo().lineHeight
    const origCount =
      region.originalEndLine >= region.originalStartLine
        ? region.originalEndLine - region.originalStartLine + 1
        : 0
    const modCount = region.kind === 'deleted' ? 0 : region.endLine - region.startLine + 1
    const changeHeight =
      region.kind === 'added'
        ? modCount
        : region.kind === 'deleted'
          ? origCount
          : origCount + modCount
    const headerLines = Math.ceil(HEADER_HEIGHT / lineHeight)
    const desired = changeHeight + CONTEXT_LINES + headerLines
    const editorLines = Math.floor(this._editor.getLayoutInfo().height / lineHeight)
    const cap = Math.max(MIN_PANEL_LINES, Math.floor(editorLines / 3))
    return Math.max(MIN_PANEL_LINES, Math.min(desired, cap))
  }

  /** Maximum panel height in lines: 80% of the editor (ZoneWidget parity). */
  private _maxHeightInLines(): number {
    const lineHeight = this._fontInfo().lineHeight
    const editorLines = this._editor.getLayoutInfo().height / lineHeight
    return Math.max(MIN_PANEL_LINES, Math.floor(editorLines * 0.8))
  }

  private _fontInfo(): monaco.editor.FontInfo {
    const m = MonacoLoader.get()
    return this._editor.getOption(m.editor.EditorOption.fontInfo)
  }

  private _setZone(afterLine: number, heightPx: number): void {
    try {
      this._editor.changeViewZones((accessor) => {
        if (this._zoneId) {
          accessor.removeZone(this._zoneId)
          this._zoneId = undefined
        }
        const zoneDomNode = document.createElement('div')
        zoneDomNode.style.overflow = 'hidden'
        this._zoneId = accessor.addZone({
          afterLineNumber: afterLine,
          heightInPx: heightPx,
          domNode: zoneDomNode,
          onDomNodeTop: (top) => {
            if (this._node) this._node.style.top = `${top}px`
          },
          onComputedHeight: (height) => {
            if (this._node) this._node.style.height = `${height}px`
            this._layoutDiff(height)
          },
        })
      })
    } catch {
      this._zoneId = undefined
    }
  }

  /** Re-lay out the existing view zone after a height change (drag resize). */
  private _relayoutZone(): void {
    if (this._zoneId === undefined) return
    const heightPx = this._heightInLines * this._fontInfo().lineHeight
    try {
      this._editor.changeViewZones((accessor) => {
        if (this._zoneId) accessor.layoutZone(this._zoneId)
      })
    } catch {
      /* editor disposed */
    }
    if (this._node) this._node.style.height = `${heightPx}px`
    this._layoutDiff(heightPx)
  }

  /**
   * Position the overlay like VSCode's ZoneWidget: left = 0 (covers the line-number
   * margin, far left) and width = editor width minus the minimap and the vertical
   * scrollbar, so it never overlaps the scrollbar.
   */
  private _layoutNode(): void {
    if (!this._node) return
    const info = this._editor.getLayoutInfo()
    const left =
      info.minimap.minimapWidth > 0 && info.minimap.minimapLeft === 0
        ? info.minimap.minimapWidth
        : 0
    const width = info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth
    this._node.style.left = `${left}px`
    this._node.style.width = `${Math.max(0, width)}px`
    if (this._node.style.height) this._layoutDiff(parseInt(this._node.style.height, 10))
  }

  private _layoutDiff(panelHeight: number): void {
    if (!this._diffEditor || !this._bodyNode) return
    const info = this._editor.getLayoutInfo()
    const width = info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth
    const height = Math.max(0, panelHeight - HEADER_HEIGHT)
    this._bodyNode.style.height = `${height}px`
    this._diffEditor.layout({ width: Math.max(0, width), height })
  }

  private _buildHeader(region: DirtyDiffRegion): HTMLElement {
    const header = document.createElement('div')
    header.className = 'inline-dirty-diff-header'
    header.style.height = `${HEADER_HEIGHT}px`

    const title = document.createElement('span')
    title.className = 'inline-dirty-diff-title'
    title.textContent =
      this._regions.length > 1
        ? localize('dirtyDiff.peek.title', '{0} of {1} changes', {
            0: this._index + 1,
            1: this._regions.length,
          })
        : localize('dirtyDiff.peek.titleOne', '1 change')
    header.appendChild(title)

    const actions = document.createElement('div')
    actions.className = 'inline-dirty-diff-actions'
    const addAction = (codicon: string, title2: string, run: () => void): void => {
      const btn = document.createElement('a')
      btn.className = `inline-dirty-diff-action codicon codicon-${codicon}`
      btn.setAttribute('role', 'button')
      btn.title = title2
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        run()
      })
      actions.appendChild(btn)
    }

    if (this._regions.length > 1) {
      addAction('arrow-up', localize('dirtyDiff.peek.previous', 'Previous Change'), () =>
        this.previous(),
      )
      addAction('arrow-down', localize('dirtyDiff.peek.next', 'Next Change'), () => this.next())
    }
    addAction('discard', localize('dirtyDiff.peek.revert', 'Revert Change'), () =>
      this._callbacks.onRevert(region),
    )
    addAction('add', localize('dirtyDiff.peek.stage', 'Stage Change'), () =>
      this._callbacks.onStage(region),
    )
    addAction('go-to-file', localize('dirtyDiff.peek.openChanges', 'Open Changes'), () =>
      this._callbacks.onOpenChanges(),
    )
    addAction('close', localize('dirtyDiff.peek.close', 'Close'), () => this.close())

    header.appendChild(actions)
    return header
  }

  /**
   * A thin grab handle along the panel's bottom edge. Dragging it resizes the
   * panel (VSCode uses a Sash; the math — px delta → rounded line delta, clamped —
   * is identical via resizeByPx).
   */
  private _buildResizeHandle(): HTMLElement {
    const handle = document.createElement('div')
    handle.className = 'inline-dirty-diff-resize'
    handle.addEventListener('mousedown', (down) => {
      down.preventDefault()
      down.stopPropagation()
      const startY = down.clientY
      const startLines = this._heightInLines
      const lineHeight = this._fontInfo().lineHeight
      const onMove = (move: MouseEvent): void => {
        const deltaPx = move.clientY - startY
        const target =
          startLines +
          (deltaPx < 0 ? Math.ceil(deltaPx / lineHeight) : Math.floor(deltaPx / lineHeight))
        const clamped = Math.max(MIN_PANEL_LINES, Math.min(this._maxHeightInLines(), target))
        if (clamped !== this._heightInLines) {
          this._heightInLines = clamped
          this._relayoutZone()
        }
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('mouseup', onUp, true)
      }
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onUp, true)
    })
    return handle
  }

  private _teardown(): void {
    if (this._diffEditor) {
      this._diffEditor.setModel(null)
      this._diffEditor.dispose()
      this._diffEditor = undefined
    }
    this._originalModel?.dispose()
    this._originalModel = undefined
    this._modifiedModel?.dispose()
    this._modifiedModel = undefined
    if (this._overlay) {
      this._editor.removeOverlayWidget(this._overlay)
      this._overlay = undefined
    }
    this._node = undefined
    this._bodyNode = undefined
    if (this._zoneId !== undefined) {
      try {
        this._editor.changeViewZones((accessor) => {
          if (this._zoneId) accessor.removeZone(this._zoneId)
        })
      } catch {
        /* editor disposed */
      }
      this._zoneId = undefined
    }
  }
}
