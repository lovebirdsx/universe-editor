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

import { useCallback, useMemo, useRef, useState } from 'react'
import { SearchInputBar } from './SearchInputBar.js'
import { SearchResultsTree } from './SearchResultsTree.js'
import { useSearchEngine, type ISearchQuery } from './useSearchEngine.js'
import { useSearchActions } from './useSearchActions.js'
import { useViewFocusable } from '../useViewFocusable.js'
import styles from './SearchView.module.css'

function splitGlobs(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function SearchView() {
  const [pattern, setPattern] = useState('')
  const [replacePattern, setReplacePattern] = useState('')
  const [includesText, setIncludesText] = useState('')
  const [excludesText, setExcludesText] = useState('')
  const [isRegex, setIsRegex] = useState(false)
  const [matchCase, setMatchCase] = useState(false)
  const [matchWholeWord, setMatchWholeWord] = useState(false)
  const [replaceVisible, setReplaceVisible] = useState(false)
  const [filtersVisible, setFiltersVisible] = useState(false)

  const inputRef = useRef<HTMLInputElement | null>(null)

  const query = useMemo<ISearchQuery>(
    () => ({
      pattern,
      isRegex,
      matchCase,
      matchWholeWord,
      includes: splitGlobs(includesText),
      excludes: splitGlobs(excludesText),
    }),
    [pattern, isRegex, matchCase, matchWholeWord, includesText, excludesText],
  )

  const { results, setResults, progress, isSearching, regexError, isStale, rerun } =
    useSearchEngine(query)
  const { onActivateMatch, onReplaceFile, onReplaceMatch, replaceAll } = useSearchActions(
    results,
    setResults,
    replacePattern,
  )

  // Focus event from FindInFilesAction.
  useViewFocusable(
    'workbench.view.search.results',
    useCallback(() => inputRef.current, []),
  )

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
        onPattern={setPattern}
        onReplace={setReplacePattern}
        onIncludes={setIncludesText}
        onExcludes={setExcludesText}
        onToggleRegex={() => setIsRegex((v) => !v)}
        onToggleCase={() => setMatchCase((v) => !v)}
        onToggleWord={() => setMatchWholeWord((v) => !v)}
        onToggleReplace={() => setReplaceVisible((v) => !v)}
        onToggleFilters={() => setFiltersVisible((v) => !v)}
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
        results={results}
        onActivateMatch={onActivateMatch}
        onReplaceFile={onReplaceFile}
        onReplaceMatch={onReplaceMatch}
        replaceVisible={replaceVisible}
      />
    </div>
  )
}
