/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useSearchEngine — owns the search lifecycle: query → debounced execute → abort,
 *  the file-watcher "stale" marker, the workspace-switch reset, and the status
 *  bar entry that follows isSearching + progress.
 *
 *  Returned `setResults` lets callers optimistically drop entries after a replace
 *  without round-tripping a fresh search.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IFileWatcherService,
  IStatusBarService,
  ITextSearchService,
  IWorkspaceService,
  StatusBarAlignment,
  URI,
  markAsSingleton,
  type IFileMatch,
  type IStatusBarEntryAccessor,
  type ITextSearchProgress,
} from '@universe-editor/platform'
import { useService } from '../useService.js'

const DEBOUNCE_MS = 250

export interface ISearchQuery {
  readonly pattern: string
  readonly isRegex: boolean
  readonly matchCase: boolean
  readonly matchWholeWord: boolean
  readonly includes: readonly string[]
  readonly excludes: readonly string[]
  readonly useExcludeSettings: boolean
}

export interface ISearchEngine {
  readonly results: readonly IFileMatch[]
  readonly setResults: React.Dispatch<React.SetStateAction<readonly IFileMatch[]>>
  readonly progress: ITextSearchProgress | null
  readonly isSearching: boolean
  readonly regexError: string | null
  readonly isStale: boolean
  readonly rerun: () => void
}

export function useSearchEngine(
  query: ISearchQuery,
  initialResults: readonly IFileMatch[] = [],
): ISearchEngine {
  const searchService = useService(ITextSearchService)
  const statusBarService = useService(IStatusBarService)
  const fileWatcherService = useService(IFileWatcherService)
  const workspaceService = useService(IWorkspaceService)

  const [results, setResults] = useState<readonly IFileMatch[]>(initialResults)
  const [progress, setProgress] = useState<ITextSearchProgress | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [regexError, setRegexError] = useState<string | null>(null)
  const [isStale, setIsStale] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusEntryRef = useRef<IStatusBarEntryAccessor | null>(null)
  // On a remount with cached results for the same query, skip the first debounced
  // run so switching sidebars back doesn't re-search (and flash the status bar).
  const skipFirstRef = useRef(initialResults.length > 0 && query.pattern.length > 0)

  const { pattern, isRegex, matchCase, matchWholeWord, includes, excludes, useExcludeSettings } =
    query

  const runSearch = useCallback(
    (q: string) => {
      abortRef.current?.abort()
      if (q.length === 0) {
        setResults([])
        setProgress(null)
        setIsSearching(false)
        setRegexError(null)
        setIsStale(false)
        return
      }
      const ac = new AbortController()
      abortRef.current = ac
      setIsSearching(true)
      setRegexError(null)
      setIsStale(false)
      void searchService
        .search(
          {
            pattern: q,
            isRegex,
            matchCase,
            matchWholeWord,
            includes: [...includes],
            excludes: [...excludes],
          },
          {
            signal: ac.signal,
            useExcludeSettings,
            onProgress: (p) => {
              if (!ac.signal.aborted) setProgress(p)
            },
          },
        )
        .then((res) => {
          if (ac.signal.aborted) return
          setResults(res)
          setIsSearching(false)
        })
        .catch(() => {
          if (ac.signal.aborted) return
          setRegexError('搜索失败')
          setIsSearching(false)
        })
    },
    [searchService, isRegex, matchCase, matchWholeWord, includes, excludes, useExcludeSettings],
  )

  useEffect(() => {
    if (skipFirstRef.current) {
      skipFirstRef.current = false
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(pattern), DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [pattern, runSearch])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      statusEntryRef.current?.dispose()
      statusEntryRef.current = null
    }
  }, [])

  useEffect(() => {
    if (results.length === 0) return
    const known = new Set(results.map((fm) => (URI.revive(fm.resource) as URI).toString()))
    const disposable = markAsSingleton(
      fileWatcherService.onDidChangeFiles((events) => {
        for (const ev of events) {
          const key = (URI.revive(ev.resource) as URI).toString()
          if (known.has(key)) {
            setIsStale(true)
            return
          }
        }
      }),
    )
    return () => disposable.dispose()
  }, [results, fileWatcherService])

  useEffect(() => {
    const disposable = markAsSingleton(
      workspaceService.onDidChangeWorkspace(() => {
        abortRef.current?.abort()
        setResults([])
        setProgress(null)
        setIsSearching(false)
        setRegexError(null)
        setIsStale(false)
      }),
    )
    return () => disposable.dispose()
  }, [workspaceService])

  useEffect(() => {
    if (isSearching && !statusEntryRef.current) {
      statusEntryRef.current = statusBarService.addEntry({
        text: '$(search) 搜索中…',
        alignment: StatusBarAlignment.Right,
        priority: 500,
      })
    }
    if (!isSearching && statusEntryRef.current) {
      statusEntryRef.current.dispose()
      statusEntryRef.current = null
    }
    return () => {
      if (statusEntryRef.current && !isSearching) {
        statusEntryRef.current.dispose()
        statusEntryRef.current = null
      }
    }
  }, [isSearching, statusBarService])

  useEffect(() => {
    if (!isSearching) return
    if (!statusEntryRef.current) return
    const text = progress
      ? `$(search) 搜索中… ${progress.filesMatched}/${progress.filesScanned} 文件，${progress.totalMatches} 匹配`
      : '$(search) 搜索中…'
    statusEntryRef.current.update({
      text,
      alignment: StatusBarAlignment.Right,
      priority: 500,
    })
  }, [progress, isSearching])

  const rerun = useCallback(() => {
    runSearch(pattern)
  }, [runSearch, pattern])

  return { results, setResults, progress, isSearching, regexError, isStale, rerun }
}
