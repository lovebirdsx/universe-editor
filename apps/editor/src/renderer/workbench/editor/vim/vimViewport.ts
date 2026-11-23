/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Viewport and fold geometry for the editor controller: screen-row motions that
 *  count a closed fold as one row, `zt/zz/zb`, `H/M/L`, `[z/]z` and `Ctrl+E/Y`.
 *  None of this is text logic — it exists because Monaco keeps folds, sticky
 *  scroll and the visible ranges outside the text model.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../monaco/MonacoLoader.js'
import { scrollViewportPayload } from './vimKeyUtils.js'
import { firstNonBlankColumn, getVimMotion, lineLength, type VimScreenOps } from './vimMotions.js'
import type {
  VimCommand,
  VimEditor,
  VimLineReader,
  VimMotion,
  VimMotionArgs,
  VimPosition,
  VimTextModel,
} from './vimTypes.js'

const STICKY_SCROLL_CONTRIBUTION_ID = 'store.contrib.stickyScrollController'
const FOLDING_CONTRIBUTION_ID = 'editor.contrib.folding'
/** Row count assumed when the editor reports no visible range (not laid out yet). */
const FALLBACK_VISIBLE_ROWS = 20
const FALLBACK_LINE_HEIGHT = 20

interface StickyScrollContribution extends monaco.editor.IEditorContribution {
  readonly stickyScrollWidgetHeight: number
}

interface FoldingRegionLike {
  readonly startLineNumber: number
  readonly endLineNumber: number
  readonly isCollapsed: boolean
}

interface FoldingModelLike {
  getAllRegionsAtLine(lineNumber: number): readonly FoldingRegionLike[]
}

interface FoldingControllerLike extends monaco.editor.IEditorContribution {
  readonly foldingModel?: FoldingModelLike | null
}

export interface VimViewportOptions {
  readonly editor: VimEditor
  /** Monaco's configured line height; only the sticky-scroll row math needs it. */
  readonly getLineHeight?: (() => number) | undefined
  readonly getCursor: () => VimPosition
}

export interface VimViewport {
  /**
   * Resolve a motion the way the user sees the buffer: screen-row motions count
   * a closed fold as one row, others are snapped out of closed folds.
   */
  resolveScreenMotion(
    lines: VimLineReader,
    from: VimPosition,
    motion: VimMotion,
    count: number,
    args?: VimMotionArgs,
  ): VimPosition | null
  /** The same fold-aware row counting `j` / `k` use, for callers that resolve ranges themselves. */
  createScreenOps(lines: VimLineReader): VimScreenOps
  /** The outermost closed fold covering `line` (its header included), or null. */
  closedFoldAt(line: number): { readonly start: number; readonly end: number } | null
  scrollViewport(command: Extract<VimCommand, { type: 'scroll-viewport' }>): void
  revealLine(command: Extract<VimCommand, { type: 'reveal-line' }>, model: VimTextModel): void
  gotoViewportLine(
    command: Extract<VimCommand, { type: 'goto-viewport-line' }>,
    model: VimTextModel,
  ): void
  foldGoto(command: Extract<VimCommand, { type: 'fold-goto' }>, model: VimTextModel): void
}

export function createVimViewport(options: VimViewportOptions): VimViewport {
  const { editor, getLineHeight, getCursor } = options

  function visibleRowCount(): number {
    const ranges = editor.getVisibleRanges()
    if (ranges.length === 0) return FALLBACK_VISIBLE_ROWS
    let count = 0
    for (const range of ranges) count += range.endLineNumber - range.startLineNumber + 1
    return Math.max(1, count)
  }

  /**
   * The sticky-scroll widget is an opaque overlay at the top of the viewport;
   * `getVisibleRanges()` still counts the lines behind it. Vim's `zt`/`H` must
   * treat the covered rows as invisible.
   */
  function stickyScrollHeight(): number {
    const contribution = editor.getContribution?.<StickyScrollContribution>(
      STICKY_SCROLL_CONTRIBUTION_ID,
    )
    const height = contribution?.stickyScrollWidgetHeight
    return typeof height === 'number' && height > 0 ? height : 0
  }

  function editorLineHeight(): number {
    const height = getLineHeight?.()
    return typeof height === 'number' && height > 0 ? height : FALLBACK_LINE_HEIGHT
  }

  /**
   * Monaco exposes no public hidden-range accessor, and `getVisibleRanges()`
   * only covers the viewport. The folding controller is the one source that
   * also knows about folds below the viewport; feature-detect it so a Monaco
   * upgrade degrades to the old model-line behaviour instead of throwing.
   */
  function foldingModel(): FoldingModelLike | null {
    const controller = editor.getContribution?.<FoldingControllerLike>(FOLDING_CONTRIBUTION_ID)
    const model = controller?.foldingModel
    return typeof model?.getAllRegionsAtLine === 'function' ? model : null
  }

  /**
   * A collapsed fold hides `(start, end]`; its start line stays visible. Take
   * the outermost collapsed ancestor so nested folds count as one screen row
   * and the snapped target is guaranteed visible.
   */
  function hiddenFoldAt(model: FoldingModelLike | null, line: number): FoldingRegionLike | null {
    if (model === null) return null
    const regions = model.getAllRegionsAtLine(line)
    for (let index = regions.length - 1; index >= 0; index--) {
      const region = regions[index]!
      if (region.isCollapsed && line > region.startLineNumber) return region
    }
    return null
  }

  /**
   * Vim counts a closed fold as one screen row. A fold reaching EOF has no row
   * below it, so a downward step stays on the fold start instead of escaping.
   */
  function advanceVisibleLines(
    model: FoldingModelLike | null,
    line: number,
    delta: 1 | -1,
    steps: number,
    lineCount: number,
  ): number {
    // Keep the common no-folds case O(1); large counts must not loop.
    if (model === null) return Math.max(1, Math.min(lineCount, line + delta * steps))
    const hidden = hiddenFoldAt(model, line)
    let current = hidden === null ? line : hidden.startLineNumber
    for (let index = 0; index < steps; index++) {
      if (delta > 0) {
        if (current >= lineCount) break
        const fold = hiddenFoldAt(model, current + 1)
        if (fold === null) current += 1
        else if (fold.endLineNumber < lineCount) current = fold.endLineNumber + 1
        else break
      } else {
        if (current <= 1) break
        const fold = hiddenFoldAt(model, current - 1)
        current = fold === null ? current - 1 : fold.startLineNumber
      }
    }
    return current
  }

  /** A hidden cursor is displayed on the fold start; normalize before moving. */
  function normalizeHiddenPosition(
    model: FoldingModelLike | null,
    position: VimPosition,
  ): VimPosition {
    const fold = hiddenFoldAt(model, position.line)
    return fold === null ? position : { line: fold.startLineNumber, column: position.column }
  }

  /**
   * A motion landing inside a closed fold is displayed on its start line. The
   * one exception is moving forward from that start line: snapping back would
   * stall, so escape to the first visible line after the fold.
   */
  function snapHiddenMotionTarget(
    model: FoldingModelLike | null,
    from: VimPosition,
    target: VimPosition,
    motion: VimMotion,
    lines: VimLineReader,
  ): VimPosition {
    const fold = hiddenFoldAt(model, target.line)
    if (fold === null) return target
    const line =
      target.line >= from.line &&
      fold.startLineNumber <= from.line &&
      fold.endLineNumber < lines.getLineCount()
        ? fold.endLineNumber + 1
        : fold.startLineNumber
    if (motion === 'gg' || motion === 'G') {
      return { line, column: firstNonBlankColumn(lines.getLineContent(line)) }
    }
    if (motion === '{' || motion === '}') return { line, column: 1 }
    const length = lineLength(lines, line)
    return { line, column: length === 0 ? 1 : Math.max(1, Math.min(length, from.column)) }
  }

  function createScreenOps(lines: VimLineReader): VimScreenOps {
    const folding = foldingModel()
    return {
      advanceRows: (line, delta, steps) =>
        advanceVisibleLines(folding, line, delta, steps, lines.getLineCount()),
      pageRows: visibleRowCount,
    }
  }

  /**
   * Line-wise operators act on a closed fold as a whole (`dd` on a fold header
   * deletes the fold). The outermost collapsed region is the one on screen.
   */
  function closedFoldAt(line: number): { start: number; end: number } | null {
    const model = foldingModel()
    if (model === null) return null
    const regions = model.getAllRegionsAtLine(line)
    for (let index = regions.length - 1; index >= 0; index--) {
      const region = regions[index]!
      if (region.isCollapsed) return { start: region.startLineNumber, end: region.endLineNumber }
    }
    return null
  }

  function resolveScreenMotion(
    lines: VimLineReader,
    from: VimPosition,
    motion: VimMotion,
    count: number,
    args: VimMotionArgs = {},
  ): VimPosition | null {
    const folding = foldingModel()
    const screen = createScreenOps(lines)
    const def = getVimMotion(motion)
    // Screen-row motions already count folds through `screen`; the rest resolve
    // on model lines and are then snapped out of any closed fold they landed in.
    if (def.screenAware === true) return def.resolve({ lines, from, screen, ...args }, count)
    const origin = normalizeHiddenPosition(folding, from)
    const target = def.resolve({ lines, from: origin, screen, ...args }, count)
    if (target === null) return null
    return snapHiddenMotionTarget(folding, origin, target, motion, lines)
  }

  function scrollViewport(command: Extract<VimCommand, { type: 'scroll-viewport' }>): void {
    editor.trigger('vim', 'editorScroll', scrollViewportPayload(command.direction, command.count))
  }

  function revealLine(
    command: Extract<VimCommand, { type: 'reveal-line' }>,
    model: VimTextModel,
  ): void {
    const cursor = getCursor()
    const requested = Math.max(1, Math.min(model.getLineCount(), command.line ?? cursor.line))
    // A collapsed fold displays only its start line; scrolling to a hidden
    // line would make Monaco unfold it 200 ms later.
    const targetLine = hiddenFoldAt(foldingModel(), requested)?.startLineNumber ?? requested
    if (command.at === 'center') {
      editor.trigger('vim', 'revealLine', { lineNumber: targetLine - 1, at: 'center' })
    } else if (command.at === 'top') {
      // Monaco's core `revealLine` intentionally reserves cursorSurroundingLines
      // / sticky-scroll padding for Top/Bottom, so the target would not sit
      // flush with the content area the way Vim's zt promises. Set the offset
      // ourselves; subtract the real sticky-widget height so the target is not
      // hidden underneath it. Monaco clamps both ends.
      editor.setScrollTop(
        Math.max(0, editor.getTopForLineNumber(targetLine) - stickyScrollHeight()),
      )
    } else {
      const height = editor.getLayoutInfo().height
      editor.setScrollTop(Math.max(0, editor.getBottomForLineNumber(targetLine) - height))
    }
    // Vim's `[count]zt/zz/zb` also moves the cursor to that line, keeping the
    // original column (clamped to the target line).
    if (command.line !== null) {
      const column = Math.min(cursor.column, model.getLineContent(targetLine).length + 1)
      editor.setPosition({ lineNumber: targetLine, column }, 'vim')
    }
  }

  function gotoViewportLine(
    command: Extract<VimCommand, { type: 'goto-viewport-line' }>,
    model: VimTextModel,
  ): void {
    const ranges = editor.getVisibleRanges()
    if (ranges.length === 0) return
    let total = 0
    for (const range of ranges) total += range.endLineNumber - range.startLineNumber + 1
    // Rows covered by sticky scroll are visible to Monaco's range math but not
    // to the user; H/M start below them.
    const hidden = Math.min(total - 1, Math.ceil(stickyScrollHeight() / editorLineHeight()))
    const usable = Math.max(1, total - hidden)
    // Walk the ranges so a folded hole between two ranges is never chosen.
    const lineAtIndex = (input: number): number => {
      let remaining = Math.max(0, Math.min(total - 1, input))
      let fallback = 1
      for (const range of ranges) {
        fallback = range.endLineNumber
        const length = range.endLineNumber - range.startLineNumber + 1
        if (remaining < length) return range.startLineNumber + remaining
        remaining -= length
      }
      return fallback
    }
    const steps = Math.max(1, command.count)
    let index: number
    if (command.at === 'top') {
      index = hidden + steps - 1
    } else if (command.at === 'bottom') {
      index = total - steps
    } else {
      // Vim's M ignores a count: it is the middle of what is visible.
      index = hidden + Math.floor(usable / 2)
    }
    const target = lineAtIndex(index)
    // The target is already visible; setPosition directly so the reveal in the
    // wrapper does not scroll it back to the center.
    editor.setPosition(
      { lineNumber: target, column: firstNonBlankColumn(model.getLineContent(target)) },
      'vim',
    )
  }

  function foldGoto(
    command: Extract<VimCommand, { type: 'fold-goto' }>,
    model: VimTextModel,
  ): void {
    const folding = foldingModel()
    if (folding === null) return
    const line = getCursor().line
    // Vim only operates on open folds: a closed fold's inner lines are not
    // visible, so the cursor can only sit on its start line.
    const regions = folding.getAllRegionsAtLine(line).filter((region) => !region.isCollapsed)
    const target = regions.find((region) =>
      command.edge === 'start' ? region.startLineNumber !== line : region.endLineNumber !== line,
    )
    if (target === undefined) return
    const targetLine = command.edge === 'start' ? target.startLineNumber : target.endLineNumber
    editor.setPosition(
      { lineNumber: targetLine, column: firstNonBlankColumn(model.getLineContent(targetLine)) },
      'vim',
    )
  }

  return {
    resolveScreenMotion,
    createScreenOps,
    closedFoldAt,
    scrollViewport,
    revealLine,
    gotoViewportLine,
    foldGoto,
  }
}
