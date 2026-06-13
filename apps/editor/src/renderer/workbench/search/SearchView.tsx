/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchView — workspace-wide find / replace panel hosted in the Search container.
 *
 *  Composes:
 *    • useSearchEngine  — search lifecycle (debounce / abort / stale / status bar)
 *    • useSearchActions — open match / replace operations
 *    • SearchInputBar   — query + options + filter form
 *    • SearchResultsTree — virtualised file/match tree
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IEditorService, IWorkspaceService, URI, isEqualResource } from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { SearchInputBar } from './SearchInputBar.js'
import { SearchResultsTree, type SearchResultsTreeHandle } from './SearchResultsTree.js'
import { useSearchEngine, type ISearchQuery } from './useSearchEngine.js'
import { useSearchActions } from './useSearchActions.js'
import { searchViewState } from './searchViewState.js'
import { searchSession } from './searchSession.js'
import { useViewFocusable } from '../useViewFocusable.js'
import { useObservable, useService } from '../useService.js'
import styles from './SearchView.module.css'

function splitGlobs(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function SearchView() {
  const [pattern, setPattern] = useState(searchSession.pattern)
  const [replacePattern, setReplacePattern] = useState(searchSession.replacePattern)
  const [includesText, setIncludesText] = useState(searchSession.includesText)
  const [excludesText, setExcludesText] = useState(searchSession.excludesText)
  const [isRegex, setIsRegex] = useState(searchSession.isRegex)
  const [matchCase, setMatchCase] = useState(searchSession.matchCase)
  const [matchWholeWord, setMatchWholeWord] = useState(searchSession.matchWholeWord)
  const [replaceVisible, setReplaceVisible] = useState(searchSession.replaceVisible)
  const [filtersVisible, setFiltersVisible] = useState(searchSession.filtersVisible)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const treeRef = useRef<SearchResultsTreeHandle>(null)

  const useExcludeSettings = useObservable(searchViewState.useExcludeSettings)
  const history = useObservable(searchViewState.history)

  const query = useMemo<ISearchQuery>(
    () => ({
      pattern,
      isRegex,
      matchCase,
      matchWholeWord,
      includes: splitGlobs(includesText),
      excludes: splitGlobs(excludesText),
      useExcludeSettings,
    }),
    [pattern, isRegex, matchCase, matchWholeWord, includesText, excludesText, useExcludeSettings],
  )

  const { results, setResults, progress, isSearching, regexError, isStale, rerun } =
    useSearchEngine(query, searchSession.results)
  const { onActivateMatch, onReplaceFile, onReplaceMatch, replaceAll, dismissMatch, dismissFile } =
    useSearchActions(results, setResults, replacePattern)

  const workspaceService = useService(IWorkspaceService)
  const rootUri = workspaceService.current?.folder ?? null

  const editorService = useService(IEditorService)
  // Read latest results from a ref so the focusable getter can stay stable.
  const resultsRef = useRef(results)
  resultsRef.current = results

  // Focus target for FindInFilesAction: when the active editor's file is in the
  // results, focus the tree at that file (or the match last opened from it);
  // otherwise focus the query input.
  useViewFocusable(
    'workbench.view.search.results',
    useCallback(() => {
      const active = editorService.activeEditor.get()
      const resource = active instanceof FileEditorInput ? active.resource : null
      const current = resultsRef.current
      if (current.length > 0 && resource && treeRef.current) {
        const inResults = current.some((fm) =>
          isEqualResource(URI.revive(fm.resource) as URI, resource),
        )
        if (inResults) {
          const preferId =
            searchSession.lastActivatedResource === resource.toString()
              ? (searchSession.lastActivatedFocusId ?? null)
              : null
          if (treeRef.current.focusResource(resource, preferId)) return null
        }
      }
      return inputRef.current
    }, [editorService]),
  )

  // Persist transient state so switching sidebars away and back restores it.
  useEffect(() => {
    searchSession.pattern = pattern
    searchSession.replacePattern = replacePattern
    searchSession.includesText = includesText
    searchSession.excludesText = excludesText
    searchSession.isRegex = isRegex
    searchSession.matchCase = matchCase
    searchSession.matchWholeWord = matchWholeWord
    searchSession.replaceVisible = replaceVisible
    searchSession.filtersVisible = filtersVisible
  }, [
    pattern,
    replacePattern,
    includesText,
    excludesText,
    isRegex,
    matchCase,
    matchWholeWord,
    replaceVisible,
    filtersVisible,
  ])
  useEffect(() => {
    searchSession.results = results
  }, [results])

  // Mirror result presence to the title toolbar; reset on unmount.
  useEffect(() => {
    searchViewState.setHasResults(results.length > 0)
  }, [results])
  useEffect(() => () => searchViewState.setHasResults(false), [])

  // Toolbar "Clear Search Results": empty the query and drop results immediately.
  const clearSignal = useObservable(searchViewState.clearSignal)
  const seenClear = useRef(clearSignal)
  useEffect(() => {
    if (clearSignal === seenClear.current) return
    seenClear.current = clearSignal
    setPattern('')
    setReplacePattern('')
    setIncludesText('')
    setExcludesText('')
    setResults([])
  }, [clearSignal, setResults])

  // Toolbar "Refresh": re-run the current query.
  const refreshSignal = useObservable(searchViewState.refreshSignal)
  const seenRefresh = useRef(refreshSignal)
  useEffect(() => {
    if (refreshSignal === seenRefresh.current) return
    seenRefresh.current = refreshSignal
    rerun()
  }, [refreshSignal, rerun])

  // Seed from the active editor selection (set by FindInFilesAction). Consume on
  // mount and on every seed signal, since the view stays mounted across invocations.
  const seedSignal = useObservable(searchViewState.seedSignal)
  const consumeSeed = useCallback(() => {
    const seed = searchSession.seedPattern
    if (seed === undefined) return
    delete searchSession.seedPattern
    setPattern(seed)
    searchViewState.addHistory(seed)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  useEffect(() => {
    consumeSeed()
  }, [seedSignal, consumeSeed])

  const rerunSearch = useCallback(() => {
    rerun()
  }, [rerun])

  const totals = results.reduce(
    (acc, fm) => ({
      files: acc.files + 1,
      matches: acc.matches + fm.matches.reduce((n, m) => n + m.ranges.length, 0),
    }),
    { files: 0, matches: 0 },
  )

  return (
    <div className={styles['search']} data-testid="search-view">
      <SearchInputBar
        ref={inputRef}
        pattern={pattern}
        replacePattern={replacePattern}
        includes={includesText}
        excludes={excludesText}
        isRegex={isRegex}
        matchCase={matchCase}
        matchWholeWord={matchWholeWord}
        replaceVisible={replaceVisible}
        filtersVisible={filtersVisible}
        useExcludeSettings={useExcludeSettings}
        history={history}
        onPattern={setPattern}
        onReplace={setReplacePattern}
        onIncludes={setIncludesText}
        onExcludes={setExcludesText}
        onToggleRegex={() => setIsRegex((v) => !v)}
        onToggleCase={() => setMatchCase((v) => !v)}
        onToggleWord={() => setMatchWholeWord((v) => !v)}
        onToggleReplace={() => setReplaceVisible((v) => !v)}
        onToggleFilters={() => setFiltersVisible((v) => !v)}
        onToggleUseExclude={() => searchViewState.setUseExcludeSettings(!useExcludeSettings)}
        onSubmit={() => searchViewState.addHistory(pattern)}
        onTabToResults={() => treeRef.current?.focusFirst()}
      />
      {regexError && <p className={styles['error']}>{regexError}</p>}
      {isStale && results.length > 0 && (
        <div className={styles['staleBanner']} data-testid="search-stale">
          <span>结果可能已过期</span>
          <button
            type="button"
            className={styles['rerunBtn']}
            onClick={rerunSearch}
            data-testid="search-rerun"
          >
            重新搜索
          </button>
        </div>
      )}
      {pattern.length > 0 && (
        <div className={styles['summaryRow']}>
          <p className={styles['summary']} data-testid="search-summary">
            {isSearching
              ? `搜索中… ${progress ? `${progress.filesMatched}/${progress.filesScanned} 文件` : ''}`
              : results.length === 0
                ? '未找到结果'
                : `${totals.matches} 个匹配，分布在 ${totals.files} 个文件`}
          </p>
          {replaceVisible && results.length > 0 && (
            <button
              type="button"
              className={styles['replaceAllBtn']}
              onClick={() => void replaceAll()}
            >
              全部替换
            </button>
          )}
        </div>
      )}
      <SearchResultsTree
        ref={treeRef}
        results={results}
        rootUri={rootUri}
        onActivateMatch={onActivateMatch}
        onReplaceFile={onReplaceFile}
        onReplaceMatch={onReplaceMatch}
        onDismissMatch={dismissMatch}
        onDismissFile={dismissFile}
        replaceVisible={replaceVisible}
        replacePattern={replacePattern}
        onShiftTab={() => inputRef.current?.focus()}
      />
    </div>
  )
}
