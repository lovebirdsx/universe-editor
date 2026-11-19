/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Binds the pure Vim core to one Monaco instance. The controller owns the
 *  Normal/Insert state, executes commands through Monaco's public editor API,
 *  and mirrors the mode onto the `vimMode` / `vimNormalMode` context keys plus
 *  the status-bar entry. It never installs DOM listeners itself — the registry
 *  routes keystrokes here on window capture.
 *--------------------------------------------------------------------------------------------*/

import {
  localize,
  type IConfigurationService,
  type IContextKeyService,
  type IDisposable,
} from '@universe-editor/platform'
import type { IVimModeService } from '../../../services/vim/vimModeService.js'
import type { IVimInputMethodService } from '../../../../shared/ipc/vimInputMethodService.js'
import { reduceVimKey } from './vimKeymap.js'
import { clampNormalPosition, firstNonBlankColumn, resolveMotion } from './vimMotions.js'
import { linewiseRange, resolveOperatorRange } from './vimOperators.js'
import { getVimRegister, setVimRegister } from './vimRegisters.js'
import {
  findAllVimMatches,
  findVimMatch,
  getLastVimSearch,
  oppositeSearchDirection,
  resolveVimSearchPattern,
  setLastVimSearch,
  VIM_SEARCH_HIGHLIGHT_LIMITS,
  type VimSearchCaseMode,
  type VimSearchCaseOverride,
  type VimSearchMatch,
  type VimSearchPattern,
  type VimSearchSpan,
} from './vimSearch.js'
import { createVimSearchWidget, type VimSearchWidget } from './vimSearchWidget.js'
import {
  INITIAL_VIM_STATE,
  type VimCommand,
  type VimEditor,
  type VimMotion,
  type VimPosition,
  type VimRange,
  type VimSearchDirection,
  type VimState,
  type VimTextModel,
} from './vimTypes.js'

const SEARCH_HIGHLIGHT_REFRESH_MS = 150
const PREVIEW_HIGHLIGHT_REFRESH_MS = 120
/** Below this size a preview keystroke can afford a synchronous full-file scan. */
const SEARCH_SYNC_HIGHLIGHT_MAX_LINES = 5000

/**
 * Shared by every controller in this window. Main keeps one saved input method
 * per window (`VimInputMethodMainService.saved`), so ownership has to be
 * tracked at the same granularity — a per-controller copy would let a newly
 * mounted editor group restore Chinese under the focused group's feet.
 */
let inputMethodState: 'english' | 'native' | null = null
let inputMethodChain: Promise<void> = Promise.resolve()

export interface IVimEditorController extends IDisposable {
  readonly editor: VimEditor
  isEnabled(): boolean
  /** Whether this editor is the one currently holding Monaco's text focus. */
  hasTextFocus(): boolean
  /** Route one keydown; returns true when Vim consumed it. */
  handleKeyDown(event: KeyboardEvent): boolean
}

export interface IVimEditorControllerOptions {
  readonly editor: VimEditor
  /**
   * Identifies this editor surface for per-surface mode memory. A function is
   * re-read when the Monaco model changes, so one editor instance reused across
   * tabs follows the active input's key without being rebuilt.
   */
  readonly surfaceKey: string | (() => string)
  readonly configService: IConfigurationService
  readonly contextKeyService: IContextKeyService
  readonly vimModeService: IVimModeService
  readonly inputMethodService: IVimInputMethodService
  /**
   * Executes workbench command ids that are not Monaco actions (`]c` / `[c`).
   * Monaco actions go through `editor.trigger` instead so the controller keeps
   * working when the commands registry is not ready yet.
   */
  readonly executeCommand?: (id: string, args?: unknown) => unknown
}

function readLines(model: VimTextModel): string[] {
  const count = model.getLineCount()
  const lines: string[] = []
  for (let line = 1; line <= count; line++) lines.push(model.getLineContent(line))
  return lines
}

function toMonacoPosition(position: VimPosition): { lineNumber: number; column: number } {
  return { lineNumber: position.line, column: position.column }
}

export function createVimEditorController(
  options: IVimEditorControllerOptions,
): IVimEditorController {
  const {
    editor,
    surfaceKey,
    configService,
    contextKeyService,
    vimModeService,
    inputMethodService,
    executeCommand: runPlatformCommand,
  } = options
  const resolveSurfaceKey = typeof surfaceKey === 'function' ? surfaceKey : () => surfaceKey
  // The key follows the model: until Monaco swaps models the controller is still
  // driving the old input, so writes must not land on the newly active key.
  let currentSurfaceKey = resolveSurfaceKey()
  // A surface returns in the mode it left (focus may sit in a list meanwhile).
  let state: VimState = { ...INITIAL_VIM_STATE, mode: readStoredMode() }
  let enabled = configService.get<boolean>('vim.enabled') === true
  let autoSwitchInputMethod = configService.get<boolean>('vim.autoSwitchInputMethod') !== false
  let searchCaseMode: VimSearchCaseMode = readSearchCaseMode()
  let searchCaseOverride: VimSearchCaseOverride = null
  let highlightSearch = readHighlightSearch()
  let searchHighlightSuppressed = false
  let searchComposing = false
  let compositionJustEnded = false
  let searchRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let previewHighlightTimer: ReturnType<typeof setTimeout> | null = null
  let textFocused = false
  let searchWidget: VimSearchWidget | null = null
  let searchOrigin: VimPosition | null = null
  let searchDirection: VimSearchDirection = 'forward'
  let searchOpenCount = 1
  let searchFocused = false
  let searchDecorations: ReturnType<VimEditor['createDecorationsCollection']> | null = null
  let closingSearch = false

  function readSearchCaseMode(): VimSearchCaseMode {
    const value = configService.get<string>('vim.searchCaseSensitivity')
    return value === 'sensitive' || value === 'insensitive' ? value : 'smart'
  }

  function readHighlightSearch(): boolean {
    return configService.get<boolean>('vim.highlightSearch') === true
  }

  function resolveCurrentSearch(raw: string): VimSearchPattern {
    return resolveVimSearchPattern(raw, searchCaseMode, searchCaseOverride)
  }

  function setSearchFocused(next: boolean): void {
    if (searchFocused === next) return
    searchFocused = next
    contextKeyService.set('vimSearchFocused', next)
  }

  const disposables: IDisposable[] = []

  /**
   * Renderer keystrokes cannot suppress IME composition, so Normal mode leaves
   * the input method instead: main switches the focused window to English there
   * and Insert mode restores it. Only mode *transitions* reach main — this runs
   * on every keystroke via `syncContextKeys`, and the guard collapses those.
   */
  function syncInputMethod(): void {
    const desired: 'english' | 'native' =
      enabled && autoSwitchInputMethod && textFocused && state.mode === 'normal'
        ? 'english'
        : 'native'
    if (desired === inputMethodState) return
    inputMethodState = desired
    // Serialize: a fast Esc → i pair must not reorder the two IPC calls.
    inputMethodChain = inputMethodChain
      .then(async () => {
        if (desired === 'native') {
          await inputMethodService.restore()
          return
        }
        // `switchToEnglish` reports whether English is active, not whether it
        // switched, so an already-English IME stays deduped; a refusal (null
        // HWND, no IME context) falls back to `native` and retries next stroke.
        if (!(await inputMethodService.switchToEnglish()) && inputMethodState === 'english') {
          inputMethodState = 'native'
        }
      })
      .catch(() => {
        inputMethodState = 'native'
      })
  }

  function readStoredMode(): VimState['mode'] {
    return vimModeService.getMode(currentSurfaceKey, 'normal') === 'insert' ? 'insert' : 'normal'
  }

  function syncContextKeys(): void {
    syncInputMethod()
    // Blur keeps this surface's mode memory; while it does not hold text focus
    // the service's active-surface snapshot owns the root context keys.
    if (textFocused) vimModeService.setMode(currentSurfaceKey, state.mode)
  }

  function setMode(mode: VimState['mode']): void {
    state = { ...state, mode }
    syncContextKeys()
  }

  function setPosition(position: VimPosition): void {
    editor.setPosition(toMonacoPosition(position), 'vim')
    editor.revealPositionInCenterIfOutsideViewport(toMonacoPosition(position))
  }

  function applyDelete(range: VimRange): void {
    if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) {
      return
    }
    editor.pushUndoStop()
    editor.executeEdits('vim', [{ range, text: '' }])
    editor.pushUndoStop()
    const model = editor.getModel()
    const lines = model ? readLines(model) : []
    const target = clampNormalPosition(lines, {
      line: range.startLineNumber,
      column: range.startColumn,
    })
    editor.setPosition(toMonacoPosition(target), 'vim')
  }

  function visibleRowCount(): number {
    const ranges = editor.getVisibleRanges()
    if (ranges.length === 0) return 20
    let count = 0
    for (const range of ranges) count += range.endLineNumber - range.startLineNumber + 1
    return Math.max(1, count)
  }

  function resolveVisualMotion(
    lines: readonly string[],
    from: VimPosition,
    motion: VimMotion,
    count: number,
  ): VimPosition | null {
    const visible = visibleRowCount()
    switch (motion) {
      case 'pageDown':
        return resolveMotion(lines, from, 'j', visible)
      case 'pageUp':
        return resolveMotion(lines, from, 'k', visible)
      case 'halfPageDown':
        return resolveMotion(lines, from, 'j', Math.max(1, Math.floor(visible / 2)))
      case 'halfPageUp':
        return resolveMotion(lines, from, 'k', Math.max(1, Math.floor(visible / 2)))
      default:
        return resolveMotion(lines, from, motion, count)
    }
  }

  /**
   * Motions that need only the cursor line and the line count. Resolving them
   * without materialising the whole buffer keeps every Normal-mode keystroke
   * O(1) on large files; `undefined` means the motion needs the full text.
   */
  function resolveSimpleMotion(
    model: VimTextModel,
    from: VimPosition,
    motion: VimMotion,
    count: number,
  ): VimPosition | null | undefined {
    const steps = Math.max(1, count)
    const clampColumn = (line: number, column: number): VimPosition => {
      const len = model.getLineContent(line).length
      return { line, column: len === 0 ? 1 : Math.max(1, Math.min(len, column)) }
    }
    switch (motion) {
      case 'h':
        return clampColumn(from.line, from.column - steps)
      case 'l':
        return clampColumn(from.line, from.column + steps)
      case '0':
        return { line: from.line, column: 1 }
      case '$':
        return { line: from.line, column: Math.max(1, model.getLineContent(from.line).length) }
      case '^':
        return { line: from.line, column: firstNonBlankColumn(model.getLineContent(from.line)) }
      case 'j':
        return clampColumn(Math.min(model.getLineCount(), from.line + steps), from.column)
      case 'k':
        return clampColumn(Math.max(1, from.line - steps), from.column)
      case 'enter': {
        if (from.line >= model.getLineCount()) return from
        const targetLine = Math.min(model.getLineCount(), from.line + steps)
        return { line: targetLine, column: firstNonBlankColumn(model.getLineContent(targetLine)) }
      }
      default:
        return undefined
    }
  }

  function ensureSearchWidget(): VimSearchWidget {
    if (searchWidget !== null) return searchWidget
    const widget = createVimSearchWidget(editor)
    widget.input.addEventListener('keydown', onSearchKeyDown)
    widget.input.addEventListener('input', onSearchInput)
    widget.input.addEventListener('focus', onSearchFocus)
    widget.input.addEventListener('blur', onSearchBlur)
    widget.input.addEventListener('compositionstart', onSearchCompositionStart)
    widget.input.addEventListener('compositionend', onSearchCompositionEnd)
    widget.caseButton.addEventListener('click', onSearchCaseClick)
    searchWidget = widget
    return widget
  }

  function onSearchKeyDown(event: KeyboardEvent): void {
    // Let the IME commit/cancel the composition with Enter/Escape first.
    if (event.isComposing || event.keyCode === 229) return
    // The document-capture dispatcher runs before this handler; the
    // `vimSearchFocused` context key keeps the Find family from claiming these.
    // Swallow them here as well so an inactive Find binding (or Monaco's own
    // container listener) cannot close the box and discard the typed pattern.
    const findKey =
      (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        ? event.key.toLowerCase()
        : ''
    if (findKey === 'f' || findKey === 'h' || event.key === 'F3') {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      commitSearch()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      cancelSearch()
    }
  }

  function onSearchFocus(): void {
    setSearchFocused(true)
  }

  function onSearchCompositionStart(): void {
    searchComposing = true
    compositionJustEnded = false
  }

  /**
   * Some IMEs deliver the final `input` with `isComposing` still true, which
   * used to leave the preview one keystroke behind until a later deletion. The
   * composition-end microtask is the authoritative "text is final" signal.
   */
  function onSearchCompositionEnd(): void {
    searchComposing = false
    compositionJustEnded = true
    queueMicrotask(() => {
      compositionJustEnded = false
      if (searchOrigin !== null) previewSearch()
    })
  }

  function onSearchInput(event: Event): void {
    if (searchComposing) return
    if ((event as InputEvent).isComposing === true && !compositionJustEnded) return
    previewSearch()
  }

  function onSearchCaseClick(): void {
    toggleSearchCase()
  }

  /**
   * Clicking away closes the box. Keep the visible preview and remember its
   * pattern so `n` continues the search the user just typed; a miss (or an
   * empty box) restores the cursor instead, because there is nothing to keep.
   */
  function onSearchBlur(): void {
    if (closingSearch) return
    const widget = searchWidget
    const origin = searchOrigin
    const model = editor.getModel()
    if (widget === null || origin === null || model === null) {
      closeSearch(false, false)
      return
    }
    const pattern = resolveCurrentSearch(widget.input.value)
    const match =
      pattern.text.length === 0
        ? null
        : findVimMatch(model, origin, pattern.text, {
            direction: searchDirection,
            count: searchOpenCount,
            caseSensitive: pattern.caseSensitive,
          })
    if (pattern.text.length === 0 || match === null) {
      closeSearch(true, false)
      if (highlightSearch) refreshSearchHighlights()
      return
    }
    setLastVimSearch({
      text: pattern.text,
      direction: searchDirection,
      caseSensitive: pattern.caseSensitive,
    })
    searchHighlightSuppressed = false
    setPosition({ line: match.line, column: match.column })
    closeSearch(false, false)
    if (highlightSearch) refreshSearchHighlights()
    else clearSearchHighlight()
  }

  function clearSearchHighlight(): void {
    searchDecorations?.clear()
  }

  function cancelSearchRefreshTimer(): void {
    if (searchRefreshTimer !== null) {
      clearTimeout(searchRefreshTimer)
      searchRefreshTimer = null
    }
  }

  function cancelPreviewHighlightTimer(): void {
    if (previewHighlightTimer !== null) {
      clearTimeout(previewHighlightTimer)
      previewHighlightTimer = null
    }
  }

  function spanFor(match: VimSearchMatch, length: number): VimSearchSpan {
    return { line: match.line, column: match.column, length }
  }

  function sameSpan(a: VimSearchSpan, b: VimSearchSpan): boolean {
    return a.line === b.line && a.column === b.column
  }

  function renderAllMatches(spans: readonly VimSearchSpan[], current: VimSearchSpan | null): void {
    if (spans.length === 0) {
      clearSearchHighlight()
      return
    }
    searchDecorations ??= editor.createDecorationsCollection()
    searchDecorations.set(
      spans.map((span) => ({
        range: {
          startLineNumber: span.line,
          startColumn: span.column,
          endLineNumber: span.line,
          endColumn: span.column + span.length,
        },
        options: {
          inlineClassName:
            current !== null && sameSpan(span, current)
              ? 'vim-search-match-current'
              : 'vim-search-match',
        },
      })),
    )
  }

  /** The span under the cursor when it starts a match the capped scan may miss. */
  function matchAtCursor(query: string, caseSensitive: boolean): VimSearchSpan | null {
    const model = editor.getModel()
    if (model === null || query.length === 0) return null
    const cursor = primaryPosition()
    const line = model.getLineContent(cursor.line)
    const start = cursor.column - 1
    if (start + query.length > line.length) return null
    const slice = line.slice(start, start + query.length)
    const equal = caseSensitive ? slice === query : slice.toLowerCase() === query.toLowerCase()
    return equal ? { line: cursor.line, column: cursor.column, length: query.length } : null
  }

  /**
   * Scan the whole model for `hlsearch`. The scan is capped in vimSearch.ts so a
   * large or minified file cannot make every edit rescans the buffer unbounded.
   * `forcedCurrent` lets a preview keep its cursor match when the cap truncates
   * the scan before reaching it, so the current highlight never flickers away.
   */
  function renderAllMatchesFor(
    query: string,
    caseSensitive: boolean,
    forcedCurrent: VimSearchSpan | null = null,
  ): void {
    const model = editor.getModel()
    if (model === null || query.length === 0) {
      clearSearchHighlight()
      return
    }
    const { matches } = findAllVimMatches(model, query, {
      caseSensitive,
      ...VIM_SEARCH_HIGHLIGHT_LIMITS,
    })
    const cursor = primaryPosition()
    const current =
      forcedCurrent ??
      matches.find(
        (span) =>
          span.line === cursor.line &&
          cursor.column >= span.column &&
          cursor.column < span.column + span.length,
      ) ??
      matchAtCursor(query, caseSensitive)
    if (current === null) {
      renderAllMatches(matches, null)
      return
    }
    const rendered = matches.some((span) => sameSpan(span, current))
      ? matches
      : [...matches, current]
    renderAllMatches(rendered, current)
  }

  function renderStoredHighlights(): void {
    const last = getLastVimSearch()
    if (last === null) {
      clearSearchHighlight()
      return
    }
    renderAllMatchesFor(last.text, last.caseSensitive)
  }

  function refreshSearchHighlights(): void {
    if (!enabled) return
    if (!highlightSearch || searchHighlightSuppressed || searchOrigin !== null) return
    renderStoredHighlights()
  }

  function scheduleSearchHighlightRefresh(): void {
    if (!enabled) return
    if (!highlightSearch || searchHighlightSuppressed || searchOrigin !== null) return
    cancelSearchRefreshTimer()
    searchRefreshTimer = setTimeout(() => {
      searchRefreshTimer = null
      refreshSearchHighlights()
    }, SEARCH_HIGHLIGHT_REFRESH_MS)
  }

  /** Keep the preview's cursor match even when the full scan is capped. */
  function previewCurrentSpan(text: string): VimSearchSpan {
    const cursor = primaryPosition()
    return { line: cursor.line, column: cursor.column, length: text.length }
  }

  function schedulePreviewHighlightRefresh(): void {
    if (!enabled) return
    if (!highlightSearch || searchHighlightSuppressed) return
    cancelPreviewHighlightTimer()
    previewHighlightTimer = setTimeout(() => {
      previewHighlightTimer = null
      if (searchOrigin === null) return
      const widget = searchWidget
      if (widget === null) return
      const pattern = resolveCurrentSearch(widget.input.value)
      if (pattern.text.length === 0) return
      renderAllMatchesFor(pattern.text, pattern.caseSensitive, previewCurrentSpan(pattern.text))
    }, PREVIEW_HIGHLIGHT_REFRESH_MS)
  }

  /**
   * A case-sensitive miss often means the user wants a case-insensitive search;
   * probing once with `ignoreCase` lets the hint suggest `\c` only when it would
   * actually help. The probe reuses the capped scan and stops at the first hit.
   */
  function noMatchHint(model: VimTextModel, pattern: VimSearchPattern): string {
    if (pattern.caseSensitive && pattern.text.length > 0) {
      const relaxed = findAllVimMatches(model, pattern.text, {
        ...VIM_SEARCH_HIGHLIGHT_LIMITS,
        caseSensitive: false,
        maxMatches: 1,
      })
      if (relaxed.matches.length > 0) {
        return localize('vim.search.noMatchCaseSensitive', 'No match — add \\c to ignore case')
      }
    }
    return localize('vim.search.noMatch', 'No match')
  }

  function syncSearchCaseUi(pattern: VimSearchPattern): void {
    searchWidget?.setCaseState({
      caseSensitive: pattern.caseSensitive,
      caseMode: pattern.caseMode,
      caseSource: pattern.caseSource,
    })
  }

  /**
   * Hide the box and drop its transient state. `restoreOrigin` puts the cursor
   * back where the search started (Esc); `refocus` returns text focus to Monaco
   * so Normal-mode keystrokes resume (Enter/Esc, but not a blur away). The
   * transient preview highlight is always cleared here; `hlsearch` highlights
   * are rebuilt explicitly after the box closes.
   */
  function closeSearch(restoreOrigin: boolean, refocus: boolean): void {
    if (closingSearch) return
    closingSearch = true
    try {
      cancelPreviewHighlightTimer()
      searchComposing = false
      compositionJustEnded = false
      const origin = searchOrigin
      searchOrigin = null
      searchWidget?.clearHint()
      searchWidget?.hide()
      setSearchFocused(false)
      clearSearchHighlight()
      if (restoreOrigin && origin !== null) setPosition(origin)
      if (refocus) editor.focus()
    } finally {
      closingSearch = false
    }
  }

  function openSearch(direction: VimSearchDirection, count: number): void {
    if (editor.getModel() === null) return
    closeSearch(false, false)
    searchOrigin = primaryPosition()
    searchDirection = direction
    searchOpenCount = Math.max(1, count)
    searchCaseOverride = null
    searchHighlightSuppressed = false
    searchComposing = false
    compositionJustEnded = false
    const widget = ensureSearchWidget()
    widget.setDirection(direction)
    widget.setValue('')
    widget.clearHint()
    syncSearchCaseUi(resolveCurrentSearch(''))
    widget.show()
    if (highlightSearch && !searchHighlightSuppressed) renderStoredHighlights()
    queueMicrotask(() => {
      if (searchOrigin === null) return
      widget.input.focus()
      widget.input.select()
    })
  }

  function previewSearch(): void {
    const widget = searchWidget
    const origin = searchOrigin
    const model = editor.getModel()
    if (widget === null || origin === null || model === null) return
    const raw = widget.input.value
    const pattern = resolveCurrentSearch(raw)
    syncSearchCaseUi(pattern)

    if (raw.length === 0) {
      cancelPreviewHighlightTimer()
      setPosition(origin)
      widget.clearHint()
      if (highlightSearch && !searchHighlightSuppressed) renderStoredHighlights()
      else clearSearchHighlight()
      return
    }

    if (pattern.text.length === 0) {
      cancelPreviewHighlightTimer()
      setPosition(origin)
      clearSearchHighlight()
      widget.showHint(localize('vim.search.emptyPattern', 'Empty search pattern'))
      return
    }

    const match = findVimMatch(model, origin, pattern.text, {
      direction: searchDirection,
      count: searchOpenCount,
      caseSensitive: pattern.caseSensitive,
    })
    if (match === null) {
      cancelPreviewHighlightTimer()
      setPosition(origin)
      clearSearchHighlight()
      widget.showHint(noMatchHint(model, pattern))
      return
    }

    widget.clearHint()
    setPosition({ line: match.line, column: match.column })
    const current = spanFor(match, pattern.text.length)
    if (highlightSearch && !searchHighlightSuppressed) {
      if (model.getLineCount() <= SEARCH_SYNC_HIGHLIGHT_MAX_LINES) {
        renderAllMatchesFor(pattern.text, pattern.caseSensitive, current)
      } else {
        renderAllMatches([current], current)
        schedulePreviewHighlightRefresh()
      }
    } else {
      renderAllMatches([current], current)
    }
  }

  function commitSearch(): void {
    const widget = searchWidget
    const origin = searchOrigin
    if (widget === null || origin === null) return
    const model = editor.getModel()
    if (model === null) return

    const raw = widget.input.value
    const last = getLastVimSearch()
    let pattern: VimSearchPattern
    if (raw.length === 0) {
      if (last === null) {
        widget.showHint(localize('vim.search.noPrevious', 'No previous search'))
        return
      }
      const caseSensitive =
        searchCaseOverride === null ? last.caseSensitive : searchCaseOverride === 'sensitive'
      pattern = {
        text: last.text,
        caseSensitive,
        caseMode: searchCaseMode,
        caseSource: searchCaseOverride === null ? 'default' : 'user',
        marker: null,
      }
    } else {
      pattern = resolveCurrentSearch(raw)
    }

    if (pattern.text.length === 0) {
      widget.showHint(localize('vim.search.emptyPattern', 'Empty search pattern'))
      return
    }

    setLastVimSearch({
      text: pattern.text,
      direction: searchDirection,
      caseSensitive: pattern.caseSensitive,
    })
    searchHighlightSuppressed = false

    const match = findVimMatch(model, origin, pattern.text, {
      direction: searchDirection,
      count: searchOpenCount,
      caseSensitive: pattern.caseSensitive,
    })
    if (match === null) {
      setPosition(origin)
      clearSearchHighlight()
      widget.showHint(noMatchHint(model, pattern))
      return
    }

    setPosition({ line: match.line, column: match.column })
    closeSearch(false, true)
    if (highlightSearch) refreshSearchHighlights()
    else clearSearchHighlight()
  }

  function cancelSearch(): void {
    closeSearch(true, true)
    // Esc before committing keeps the previous search result visible again.
    if (highlightSearch && !searchHighlightSuppressed) renderStoredHighlights()
  }

  function repeatSearch(reverse: boolean, count: number): void {
    const last = getLastVimSearch()
    const model = editor.getModel()
    if (last === null || model === null) return
    const direction = reverse ? oppositeSearchDirection(last.direction) : last.direction
    const match = findVimMatch(model, primaryPosition(), last.text, {
      direction,
      count,
      caseSensitive: last.caseSensitive,
    })
    if (match === null) return
    searchHighlightSuppressed = false
    setPosition({ line: match.line, column: match.column })
    if (highlightSearch) refreshSearchHighlights()
    else clearSearchHighlight()
  }

  /**
   * `*` / `#`: search for the keyword under the cursor. The search core is
   * literal, so this matches the word as plain text rather than Vim's
   * `\<...\>` whole-word pattern.
   */
  function searchWord(direction: VimSearchDirection, count: number): void {
    const model = editor.getModel()
    if (model === null) return
    const from = primaryPosition()
    const line = model.getLineContent(from.line)
    const isKeyword = (value: string | undefined): boolean =>
      value !== undefined && /[A-Za-z0-9_$]/.test(value)

    let start = from.column - 1
    if (!isKeyword(line[start])) {
      while (start < line.length && !isKeyword(line[start])) start++
      if (start >= line.length) return
    }
    let end = start
    while (end < line.length && isKeyword(line[end])) end++
    const word = line.slice(start, end)
    if (word.length === 0) return

    searchCaseOverride = null
    const pattern = resolveCurrentSearch(word)
    setLastVimSearch({
      text: pattern.text,
      direction,
      caseSensitive: pattern.caseSensitive,
    })
    searchHighlightSuppressed = false
    // Start after the word so `*` / `#` skip the match under the cursor.
    let origin: VimPosition
    if (direction === 'forward') {
      origin = { line: from.line, column: end + 1 }
    } else if (start > 0) {
      origin = { line: from.line, column: start }
    } else {
      const previousLine = from.line - 1
      if (previousLine >= 1) {
        origin = { line: previousLine, column: model.getLineContent(previousLine).length + 1 }
      } else {
        const lastLine = model.getLineCount()
        origin = { line: lastLine, column: model.getLineContent(lastLine).length + 1 }
      }
    }
    const match = findVimMatch(model, origin, pattern.text, {
      direction,
      count: Math.max(1, count),
      caseSensitive: pattern.caseSensitive,
    })
    if (match === null) return
    setPosition({ line: match.line, column: match.column })
    if (highlightSearch) refreshSearchHighlights()
    else clearSearchHighlight()
  }

  function toggleSearchCase(): void {
    const widget = searchWidget
    if (widget === null || searchOrigin === null) return
    const resolved = resolveCurrentSearch(widget.input.value)
    const nextSensitive = !resolved.caseSensitive
    if (resolved.marker !== null) {
      widget.setValue(`${resolved.text}${nextSensitive ? '\\C' : '\\c'}`)
      searchCaseOverride = null
    } else {
      searchCaseOverride = nextSensitive ? 'sensitive' : 'insensitive'
    }
    previewSearch()
    widget.input.focus()
  }

  function executeSearchCommand(
    command: Extract<VimCommand, { type: 'search-open' } | { type: 'search-repeat' }>,
  ): void {
    if (command.type === 'search-open') {
      openSearch(command.direction, command.count)
      return
    }
    repeatSearch(command.reverse, command.count)
  }

  function disposeSearch(): void {
    cancelSearchRefreshTimer()
    cancelPreviewHighlightTimer()
    if (searchWidget !== null) {
      searchWidget.input.removeEventListener('compositionstart', onSearchCompositionStart)
      searchWidget.input.removeEventListener('compositionend', onSearchCompositionEnd)
      searchWidget.input.removeEventListener('keydown', onSearchKeyDown)
      searchWidget.input.removeEventListener('input', onSearchInput)
      searchWidget.input.removeEventListener('focus', onSearchFocus)
      searchWidget.input.removeEventListener('blur', onSearchBlur)
      searchWidget.caseButton.removeEventListener('click', onSearchCaseClick)
    }
    closeSearch(false, false)
    searchWidget?.dispose()
    searchWidget = null
    clearSearchHighlight()
    searchDecorations = null
  }

  function executeCommand(command: VimCommand): void {
    if (command.type === 'search-open' || command.type === 'search-repeat') {
      executeSearchCommand(command)
      return
    }
    if (command.type === 'search-highlight-clear') {
      searchHighlightSuppressed = true
      cancelSearchRefreshTimer()
      cancelPreviewHighlightTimer()
      clearSearchHighlight()
      return
    }
    if (command.type === 'editor-command') {
      editor.trigger('vim', command.commandId, null)
      return
    }
    if (command.type === 'platform-command') {
      const steps = Math.max(1, command.count)
      for (let index = 0; index < steps; index++) void runPlatformCommand?.(command.commandId)
      return
    }
    if (command.type === 'search-word') {
      searchWord(command.direction, command.count)
      return
    }

    const model = editor.getModel()
    if (!model) return
    const from = primaryPosition()

    if (command.type === 'motion') {
      const target = resolveSimpleMotion(model, from, command.motion, command.count)
      if (target !== undefined) {
        if (target !== null) setPosition(target)
        return
      }
    }

    const lines = readLines(model)

    switch (command.type) {
      case 'motion': {
        const target = resolveVisualMotion(lines, from, command.motion, command.count)
        if (target !== null) setPosition(target)
        return
      }
      case 'operator': {
        const opRange = resolveOperatorRange(lines, from, command.motion, command.count)
        if (opRange === null) return
        // Vim's delete operator also yanks into the unnamed register, so
        // `dd` followed by `p` is the everyday move-line idiom.
        setVimRegister({
          text: model.getValueInRange(opRange.range),
          linewise: opRange.linewise,
        })
        if (command.operator === 'y') return
        applyDelete(opRange.range)
        if (command.operator === 'c') setMode('insert')
        return
      }
      case 'linewise': {
        const startLine = Math.min(from.line, lines.length)
        const endLine = Math.min(lines.length, startLine + Math.max(1, command.count) - 1)
        setVimRegister({
          text: `${lines.slice(startLine - 1, endLine).join('\n')}\n`,
          linewise: true,
        })
        if (command.operator === 'y') return
        if (command.operator === 'c') {
          // `cc` keeps one empty line instead of deleting the line break.
          const endColumn = (lines[endLine - 1] ?? '').length + 1
          editor.pushUndoStop()
          editor.executeEdits('vim', [
            {
              range: {
                startLineNumber: startLine,
                startColumn: 1,
                endLineNumber: endLine,
                endColumn,
              },
              text: '',
            },
          ])
          editor.pushUndoStop()
          editor.setPosition(toMonacoPosition({ line: startLine, column: 1 }), 'vim')
          setMode('insert')
          return
        }
        applyDelete(linewiseRange(lines, startLine, endLine))
        return
      }
      case 'indent': {
        const steps = Math.max(1, command.count)
        const commandId =
          command.direction === 'in' ? 'editor.action.indentLines' : 'editor.action.outdentLines'
        for (let index = 0; index < steps; index++) editor.trigger('vim', commandId, null)
        return
      }
      case 'enter-insert': {
        enterInsert(command)
        return
      }
      case 'delete-char': {
        deleteChars(command.count, command.backward)
        return
      }
      case 'substitute-char': {
        deleteChars(command.count, false)
        setMode('insert')
        return
      }
      case 'paste': {
        paste(command.count, command.before)
        return
      }
      case 'undo': {
        editor.trigger('vim', 'undo', null)
        return
      }
      case 'join-lines': {
        // `J` joins two lines and every extra count one more, so the number of
        // joins is `count - 1` (a bare `J` still joins once).
        const joins = Math.max(1, command.count - 1)
        for (let i = 0; i < joins; i++) {
          editor.trigger('vim', 'editor.action.joinLines', null)
        }
        return
      }
    }
  }

  function enterInsert(command: Extract<VimCommand, { type: 'enter-insert' }>): void {
    const model = editor.getModel()
    if (!model) return
    const from = primaryPosition()
    const lineEnd = model.getLineContent(from.line).length + 1
    switch (command.placement) {
      case 'before':
        setPosition(from)
        break
      case 'after':
        setPosition({ line: from.line, column: Math.min(lineEnd, from.column + 1) })
        break
      case 'line-start':
        setPosition({ line: from.line, column: 1 })
        break
      case 'line-end':
        setPosition({ line: from.line, column: lineEnd })
        break
      case 'new-line-below':
        editor.trigger('vim', 'editor.action.insertLineAfter', null)
        break
      case 'new-line-above':
        editor.trigger('vim', 'editor.action.insertLineBefore', null)
        break
    }
    setMode('insert')
  }

  function deleteChars(count: number, backward: boolean): void {
    const model = editor.getModel()
    if (!model) return
    const from = primaryPosition()
    const lineLength = model.getLineContent(from.line).length
    const startColumn = backward ? Math.max(1, from.column - Math.max(1, count)) : from.column
    const endColumn = backward ? from.column : Math.min(lineLength + 1, from.column + count)
    if (startColumn === endColumn) return
    const range = {
      startLineNumber: from.line,
      startColumn,
      endLineNumber: from.line,
      endColumn,
    }
    setVimRegister({ text: model.getValueInRange(range), linewise: false })
    editor.pushUndoStop()
    editor.executeEdits('vim', [{ range, text: '' }])
    editor.pushUndoStop()
    editor.setPosition(toMonacoPosition({ line: from.line, column: startColumn }), 'vim')
  }

  function paste(count: number, before: boolean): void {
    const register = getVimRegister()
    if (register === null) return
    const model = editor.getModel()
    if (!model) return
    const from = primaryPosition()
    const lineCount = model.getLineCount()
    const repeated = Array.from({ length: Math.max(1, count) }, () => register.text).join('')

    if (register.linewise) {
      const insertLine = before ? from.line : from.line + 1
      const text = repeated.endsWith('\n') ? repeated : `${repeated}\n`
      editor.pushUndoStop()
      if (insertLine > lineCount) {
        const lastLength = model.getLineContent(lineCount).length
        editor.executeEdits('vim', [
          {
            range: {
              startLineNumber: lineCount,
              startColumn: lastLength + 1,
              endLineNumber: lineCount,
              endColumn: lastLength + 1,
            },
            text: `\n${text.slice(0, -1)}`,
          },
        ])
        editor.pushUndoStop()
        setPosition({ line: lineCount + 1, column: 1 })
        return
      }
      editor.executeEdits('vim', [
        {
          range: {
            startLineNumber: insertLine,
            startColumn: 1,
            endLineNumber: insertLine,
            endColumn: 1,
          },
          text,
        },
      ])
      editor.pushUndoStop()
      setPosition({ line: insertLine, column: 1 })
      return
    }

    const lineLength = model.getLineContent(from.line).length
    const column = before ? from.column : Math.min(lineLength + 1, from.column + 1)
    editor.pushUndoStop()
    editor.executeEdits('vim', [
      {
        range: {
          startLineNumber: from.line,
          startColumn: column,
          endLineNumber: from.line,
          endColumn: column,
        },
        text: repeated,
      },
    ])
    editor.pushUndoStop()
    const firstLine = repeated.split('\n')
    const targetLine = from.line + firstLine.length - 1
    const targetColumn =
      firstLine.length === 1
        ? column + repeated.length
        : (firstLine[firstLine.length - 1]?.length ?? 0) + 1
    setPosition({ line: targetLine, column: targetColumn })
  }

  function primaryPosition(): VimPosition {
    const selection = (editor.getSelections() ?? [])[0]
    if (selection === undefined) return { line: 1, column: 1 }
    return { line: selection.startLineNumber, column: selection.startColumn }
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!enabled || !textFocused) return false
    if (event.isComposing || event.keyCode === 229) return false
    const result = reduceVimKey(state, {
      key: event.key,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      repeat: event.repeat,
    })
    if (!result.handled) return false
    state = result.state
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (result.command !== null) executeCommand(result.command)
    syncContextKeys()
    return true
  }

  const focusSubscription = editor.onDidFocusEditorText(() => {
    textFocused = true
    syncContextKeys()
  })
  const blurSubscription = editor.onDidBlurEditorText(() => {
    textFocused = false
    // Keep the mode so returning focus resumes it; only the in-flight count /
    // operator prefix belongs to the focus that was lost.
    state = {
      ...state,
      count: 0,
      pendingOperator: null,
      pendingG: false,
      pendingBracket: null,
      pendingIndent: null,
      countAfterOperator: false,
    }
    syncContextKeys()
  })
  const modelSubscription = editor.onDidChangeModel(() => {
    currentSurfaceKey = resolveSurfaceKey()
    state = { ...INITIAL_VIM_STATE, mode: readStoredMode() }
    cancelSearchRefreshTimer()
    cancelPreviewHighlightTimer()
    closeSearch(false, false)
    syncContextKeys()
    if (highlightSearch && !searchHighlightSuppressed) refreshSearchHighlights()
  })
  const contentSubscription = editor.onDidChangeModelContent(() => {
    scheduleSearchHighlightRefresh()
  })
  disposables.push(focusSubscription, blurSubscription, modelSubscription, contentSubscription)

  const configSubscription = configService.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('vim.enabled')) {
      enabled = configService.get<boolean>('vim.enabled') === true
      if (!enabled) {
        state = INITIAL_VIM_STATE
        cancelSearchRefreshTimer()
        cancelPreviewHighlightTimer()
        closeSearch(false, false)
        clearSearchHighlight()
      }
      syncContextKeys()
      return
    }
    if (event.affectsConfiguration('vim.autoSwitchInputMethod')) {
      autoSwitchInputMethod = configService.get<boolean>('vim.autoSwitchInputMethod') !== false
      syncInputMethod()
    }
    if (event.affectsConfiguration('vim.searchCaseSensitivity')) {
      searchCaseMode = readSearchCaseMode()
      if (searchOrigin !== null) previewSearch()
    }
    if (event.affectsConfiguration('vim.highlightSearch')) {
      highlightSearch = readHighlightSearch()
      cancelSearchRefreshTimer()
      searchHighlightSuppressed = false
      if (!highlightSearch) {
        cancelPreviewHighlightTimer()
        clearSearchHighlight()
        return
      }
      if (searchOrigin !== null) previewSearch()
      else refreshSearchHighlights()
    }
  })
  disposables.push(configSubscription)

  syncContextKeys()

  return {
    editor,
    isEnabled: () => enabled,
    hasTextFocus: () => textFocused,
    handleKeyDown,
    dispose: () => {
      for (const disposable of disposables) disposable.dispose()
      disposables.length = 0
      disposeSearch()
      // Only the controller holding text focus may leave English: main's saved
      // input method is shared, so a background group's disposal must not yank
      // Chinese back under the focused group.
      if (textFocused && inputMethodState === 'english') {
        inputMethodState = 'native'
        inputMethodChain = inputMethodChain
          .then(() => inputMethodService.restore())
          .catch(() => undefined)
      }
    },
  }
}
