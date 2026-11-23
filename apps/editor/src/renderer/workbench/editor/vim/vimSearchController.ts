/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Search for the editor controller: the `/` `?` box with live preview, `n` / `N`,
 *  `*` / `#` and the `hlsearch` highlight lifecycle. Owns the widget, its IME
 *  composition guards and the decoration collection; the controller only forwards
 *  commands, model/content/config events and disposal.
 *--------------------------------------------------------------------------------------------*/

import { localize, type IContextKeyService, type IDisposable } from '@universe-editor/platform'
import {
  findAllVimMatches,
  findVimMatch,
  getLastVimSearch,
  isVimKeywordChar,
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
import type { VimEditor, VimPosition, VimSearchDirection, VimTextModel } from './vimTypes.js'

const SEARCH_HIGHLIGHT_REFRESH_MS = 150
const PREVIEW_HIGHLIGHT_REFRESH_MS = 120
/** Below this size a preview keystroke can afford a synchronous full-file scan. */
const SEARCH_SYNC_HIGHLIGHT_MAX_LINES = 5000

interface ISearchConfiguration {
  get<T>(key: string): T | undefined
}

export interface VimSearchControllerOptions {
  readonly editor: VimEditor
  readonly configService: ISearchConfiguration
  readonly contextKeyService: IContextKeyService
  readonly isEnabled: () => boolean
  readonly getCursor: () => VimPosition
  /** Move the cursor and scroll it into view when it left the viewport. */
  readonly moveCursor: (position: VimPosition) => void
}

export interface VimSearchController extends IDisposable {
  open(direction: VimSearchDirection, count: number): void
  repeat(reverse: boolean, count: number): void
  searchWord(direction: VimSearchDirection, count: number): void
  /**
   * Normal-mode Escape (`:nohlsearch`): drop persistent highlights until the next
   * search command. Returns whether any were showing, so the caller can tell a
   * productive Escape from a bare one.
   */
  clearHighlights(): boolean
  /** The Monaco model changed: abandon any open box and repaint for the new buffer. */
  onModelChange(): void
  onContentChange(): void
  /** React to `vim.searchCaseSensitivity` / `vim.highlightSearch` changes. */
  onConfigChange(event: { affectsConfiguration(key: string): boolean }): void
  /** `vim.enabled` turned off: close the box and drop every highlight. */
  onDisabled(): void
}

export function createVimSearchController(
  options: VimSearchControllerOptions,
): VimSearchController {
  const { editor, configService, contextKeyService, isEnabled, getCursor, moveCursor } = options
  let searchCaseMode: VimSearchCaseMode = readSearchCaseMode()
  let searchCaseOverride: VimSearchCaseOverride = null
  let highlightSearch = readHighlightSearch()
  let searchHighlightSuppressed = false
  let highlightsShown = false
  let searchComposing = false
  let compositionJustEnded = false
  let searchRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let previewHighlightTimer: ReturnType<typeof setTimeout> | null = null
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

  function primaryPosition(): VimPosition {
    return getCursor()
  }

  function setPosition(position: VimPosition): void {
    moveCursor(position)
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
            wholeWord: false,
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
      wholeWord: false,
    })
    searchHighlightSuppressed = false
    setPosition({ line: match.line, column: match.column })
    closeSearch(false, false)
    if (highlightSearch) refreshSearchHighlights()
    else clearSearchHighlight()
  }

  function clearSearchHighlight(): void {
    highlightsShown = false
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
    highlightsShown = true
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
  function matchAtCursor(
    query: string,
    caseSensitive: boolean,
    wholeWord: boolean,
  ): VimSearchSpan | null {
    const model = editor.getModel()
    if (model === null || query.length === 0) return null
    const cursor = primaryPosition()
    const line = model.getLineContent(cursor.line)
    const start = cursor.column - 1
    if (start + query.length > line.length) return null
    const slice = line.slice(start, start + query.length)
    const equal = caseSensitive ? slice === query : slice.toLowerCase() === query.toLowerCase()
    if (!equal) return null
    const leftBoundary = isVimKeywordChar(line[start - 1])
    const rightBoundary = isVimKeywordChar(line[start + query.length])
    return wholeWord && (leftBoundary || rightBoundary)
      ? null
      : { line: cursor.line, column: cursor.column, length: query.length }
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
    wholeWord: boolean,
    forcedCurrent: VimSearchSpan | null = null,
  ): void {
    const model = editor.getModel()
    if (model === null || query.length === 0) {
      clearSearchHighlight()
      return
    }
    const { matches } = findAllVimMatches(model, query, {
      caseSensitive,
      wholeWord,
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
      matchAtCursor(query, caseSensitive, wholeWord)
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
    renderAllMatchesFor(last.text, last.caseSensitive, last.wholeWord)
  }

  function refreshSearchHighlights(): void {
    if (!isEnabled()) return
    if (!highlightSearch || searchHighlightSuppressed || searchOrigin !== null) return
    renderStoredHighlights()
  }

  function scheduleSearchHighlightRefresh(): void {
    if (!isEnabled()) return
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
    if (!isEnabled()) return
    if (!highlightSearch || searchHighlightSuppressed) return
    cancelPreviewHighlightTimer()
    previewHighlightTimer = setTimeout(() => {
      previewHighlightTimer = null
      if (searchOrigin === null) return
      const widget = searchWidget
      if (widget === null) return
      const pattern = resolveCurrentSearch(widget.input.value)
      if (pattern.text.length === 0) return
      renderAllMatchesFor(
        pattern.text,
        pattern.caseSensitive,
        false,
        previewCurrentSpan(pattern.text),
      )
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
      wholeWord: false,
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
        renderAllMatchesFor(pattern.text, pattern.caseSensitive, false, current)
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
    let wholeWord: boolean
    if (raw.length === 0) {
      if (last === null) {
        widget.showHint(localize('vim.search.noPrevious', 'No previous search'))
        return
      }
      const caseSensitive =
        searchCaseOverride === null ? last.caseSensitive : searchCaseOverride === 'sensitive'
      wholeWord = last.wholeWord
      pattern = {
        text: last.text,
        caseSensitive,
        caseMode: searchCaseMode,
        caseSource: searchCaseOverride === null ? 'default' : 'user',
        marker: null,
      }
    } else {
      wholeWord = false
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
      wholeWord,
    })
    searchHighlightSuppressed = false

    const match = findVimMatch(model, origin, pattern.text, {
      direction: searchDirection,
      count: searchOpenCount,
      caseSensitive: pattern.caseSensitive,
      wholeWord,
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
      wholeWord: last.wholeWord,
    })
    if (match === null) return
    searchHighlightSuppressed = false
    setPosition({ line: match.line, column: match.column })
    if (highlightSearch) refreshSearchHighlights()
    else clearSearchHighlight()
  }

  /**
   * `*` / `#`: search for the keyword under the cursor with Vim's `\<...\>`
   * whole-word boundaries, so `foo` never matches inside `fooBar`. The stored
   * `wholeWord` flag keeps `n` / `N` on the same semantics.
   */
  function searchWord(direction: VimSearchDirection, count: number): void {
    const model = editor.getModel()
    if (model === null) return
    const from = primaryPosition()
    const line = model.getLineContent(from.line)

    let start = from.column - 1
    if (!isVimKeywordChar(line[start])) {
      while (start < line.length && !isVimKeywordChar(line[start])) start++
      if (start >= line.length) return
    }
    let end = start
    while (end < line.length && isVimKeywordChar(line[end])) end++
    const word = line.slice(start, end)
    if (word.length === 0) return

    searchCaseOverride = null
    const pattern = resolveCurrentSearch(word)
    setLastVimSearch({
      text: pattern.text,
      direction,
      caseSensitive: pattern.caseSensitive,
      wholeWord: true,
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
      wholeWord: true,
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
  return {
    open: openSearch,
    repeat: repeatSearch,
    searchWord,
    clearHighlights() {
      const wasShowing = highlightsShown
      searchHighlightSuppressed = true
      cancelSearchRefreshTimer()
      cancelPreviewHighlightTimer()
      clearSearchHighlight()
      return wasShowing
    },
    onModelChange() {
      cancelSearchRefreshTimer()
      cancelPreviewHighlightTimer()
      closeSearch(false, false)
      if (highlightSearch && !searchHighlightSuppressed) refreshSearchHighlights()
    },
    onContentChange: scheduleSearchHighlightRefresh,
    onConfigChange(event) {
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
    },
    onDisabled() {
      cancelSearchRefreshTimer()
      cancelPreviewHighlightTimer()
      closeSearch(false, false)
      clearSearchHighlight()
    },
    dispose: disposeSearch,
  }
}
