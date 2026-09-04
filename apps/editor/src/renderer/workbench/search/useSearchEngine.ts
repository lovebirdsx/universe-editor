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
  IConfigurationService,
  IFileWatcherService,
  IStatusBarService,
  ITextSearchService,
  IWorkspaceService,
  localize,
  StatusBarAlignment,
  markAsSingleton,
  type IFileMatch,
  type IStatusBarEntryAccessor,
  type ITextSearchProgress,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { recordPerfPhase } from '../../services/performance/perfPhases.js'
import { searchSession } from './searchSession.js'
import { searchDebounceDelay } from './searchDebounce.js'

// Base keystroke debounce, matching VSCode's search.searchOnTypeDebouncePeriod.
// Loose regexes stretch it further — see searchDebounce.ts.
const DEFAULT_DEBOUNCE_MS = 300
// Coalesce incremental result batches into the tree on this cadence, so a large
// result set fills in progressively without re-rendering on every batch. Mirrors
// VSCode's ~80ms refresh scheduler.
const RESULTS_REFRESH_MS = 80

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
  /** Run the current query now, bypassing the debounce (Enter in the input). */
  readonly submit: () => void
}

export function useSearchEngine(
  query: ISearchQuery,
  initialResults: readonly IFileMatch[] = [],
): ISearchEngine {
  const searchService = useService(ITextSearchService)
  const statusBarService = useService(IStatusBarService)
  const fileWatcherService = useService(IFileWatcherService)
  const workspaceService = useService(IWorkspaceService)
  const configurationService = useService(IConfigurationService)

  const [results, setResults] = useState<readonly IFileMatch[]>(initialResults)
  const [progress, setProgress] = useState<ITextSearchProgress | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [regexError, setRegexError] = useState<string | null>(null)
  const [isStale, setIsStale] = useState(false)
  // Bumped on every workspace switch so the debounced-search effect re-runs the
  // current query against the new root even though `pattern` did not change.
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0)

  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusEntryRef = useRef<IStatusBarEntryAccessor | null>(null)
  // Incremental accumulation: batches arrive silently into this ordered map and
  // are coalesced into React state on a timer, so the tree grows progressively
  // (append-only, stable order) instead of appearing all at once at the end.
  const accumRef = useRef<Map<string, IFileMatch>>(new Map())
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Resources currently in the results, read by the file watcher without making
  // it re-subscribe on every streamed batch.
  const knownRef = useRef<Set<string>>(new Set(initialResults.map((fm) => fm.resource.toString())))
  // On a remount with cached results for the same query, skip the first debounced
  // run so switching sidebars back doesn't re-search (and flash the status bar).
  // Cached results from a different workspace are stale by definition, so only
  // results searched in the current workspace qualify for the skip.
  const skipFirstRef = useRef(
    initialResults.length > 0 &&
      query.pattern.length > 0 &&
      searchSession.resultsWorkspaceKey === (workspaceService.current?.folder.toString() ?? null),
  )

  const { pattern, isRegex, matchCase, matchWholeWord, includes, excludes, useExcludeSettings } =
    query

  const runSearch = useCallback(
    (q: string) => {
      abortRef.current?.abort()
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      accumRef.current = new Map()
      knownRef.current = new Set()
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

      const flush = (): void => {
        flushTimerRef.current = null
        if (ac.signal.aborted) return
        recordPerfPhase('search.flushResults', () => setResults([...accumRef.current.values()]))
      }
      const scheduleFlush = (): void => {
        if (flushTimerRef.current !== null) return
        flushTimerRef.current = setTimeout(flush, RESULTS_REFRESH_MS)
      }

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
            onResults: (batch) => {
              if (ac.signal.aborted) return
              for (const fm of batch) {
                accumRef.current.set(fm.resource.toString(), fm)
              }
              scheduleFlush()
            },
          },
        )
        .then((res) => {
          if (ac.signal.aborted) return
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current)
            flushTimerRef.current = null
          }
          // The promise result is authoritative — replace any accumulated batches.
          accumRef.current = new Map(res.map((fm) => [fm.resource.toString(), fm]))
          setResults(res)
          setIsSearching(false)
        })
        .catch(() => {
          if (ac.signal.aborted) return
          setRegexError(localize('search.failed', 'Search failed'))
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
    // Clearing the query always takes effect immediately — there is nothing to
    // debounce, and leaving stale results up while the input is empty is worse
    // than an extra render.
    if (pattern.length === 0) {
      runSearch('')
      return
    }
    if (!configurationService.get<boolean>('search.searchOnType', true)) return
    const baseMs =
      configurationService.get<number>('search.searchOnTypeDebouncePeriod', DEFAULT_DEBOUNCE_MS) ??
      DEFAULT_DEBOUNCE_MS
    debounceRef.current = setTimeout(
      () => runSearch(pattern),
      searchDebounceDelay(pattern, isRegex, baseMs),
    )
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [pattern, isRegex, runSearch, configurationService, workspaceEpoch])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      statusEntryRef.current?.dispose()
      statusEntryRef.current = null
    }
  }, [])

  // The watched set is kept in a ref and refreshed separately, so streaming
  // results don't tear down and re-create this subscription every batch.
  useEffect(() => {
    knownRef.current = new Set(results.map((fm) => fm.resource.toString()))
  }, [results])

  useEffect(() => {
    const disposable = markAsSingleton(
      fileWatcherService.onDidChangeFiles((events) => {
        if (knownRef.current.size === 0) return
        for (const ev of events) {
          if (knownRef.current.has(ev.resource.toString())) {
            setIsStale(true)
            return
          }
        }
      }),
    )
    return () => disposable.dispose()
  }, [fileWatcherService])

  useEffect(() => {
    const disposable = markAsSingleton(
      workspaceService.onDidChangeWorkspace(() => {
        abortRef.current?.abort()
        setResults([])
        setProgress(null)
        setIsSearching(false)
        setRegexError(null)
        setIsStale(false)
        // Results belonged to the old workspace: re-run the current query so the
        // view refreshes against the new root (debounced, honors searchOnType).
        setWorkspaceEpoch((e) => e + 1)
      }),
    )
    return () => disposable.dispose()
  }, [workspaceService])

  useEffect(() => {
    if (isSearching && !statusEntryRef.current) {
      statusEntryRef.current = statusBarService.addEntry({
        text: localize('search.statusSearching', '$(search) Searching…'),
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
      ? localize(
          'search.statusProgress',
          '$(search) Searching… {matched}/{scanned} files, {matches} matches',
          {
            matched: progress.filesMatched,
            scanned: progress.filesScanned,
            matches: progress.totalMatches,
          },
        )
      : localize('search.statusSearching', '$(search) Searching…')
    statusEntryRef.current.update({
      text,
      alignment: StatusBarAlignment.Right,
      priority: 500,
    })
  }, [progress, isSearching])

  const rerun = useCallback(() => {
    runSearch(pattern)
  }, [runSearch, pattern])

  // Enter in the query input: run now, cancelling any pending debounce. This is
  // the only way to search when search.searchOnType is off.
  const submit = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    runSearch(pattern)
  }, [runSearch, pattern])

  return { results, setResults, progress, isSearching, regexError, isStale, rerun, submit }
}
