/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchView — workspace-wide find / replace panel hosted in the Search container.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IDialogService,
  IEditorService,
  IFileService,
  IFileWatcherService,
  IInstantiationService,
  IStatusBarService,
  ITextSearchService,
  IWorkspaceService,
  StatusBarAlignment,
  URI,
  type IFileMatch,
  type IStatusBarEntryAccessor,
  type ITextSearchMatch,
  type ITextSearchProgress,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../editor/FileEditorRegistry.js'
import { MonacoModelRegistry } from '../editor/monaco/MonacoModelRegistry.js'
import { SearchInputBar } from './SearchInputBar.js'
import { SearchResultsTree } from './SearchResultsTree.js'
import { applyReplacements, type IReplaceEdit } from './replace.js'
import { SEARCH_FOCUS_INPUT_EVENT } from '../../actions/searchActions.js'
import styles from './SearchView.module.css'

const DEBOUNCE_MS = 250

function splitGlobs(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function SearchView() {
  const searchService = useService(ITextSearchService)
  const editorService = useService(IEditorService)
  const instantiation = useService(IInstantiationService)
  const statusBarService = useService(IStatusBarService)
  const fileService = useService(IFileService)
  const dialogService = useService(IDialogService)
  const fileWatcherService = useService(IFileWatcherService)
  const workspaceService = useService(IWorkspaceService)

  const [pattern, setPattern] = useState('')
  const [replacePattern, setReplacePattern] = useState('')
  const [includes, setIncludes] = useState('')
  const [excludes, setExcludes] = useState('')
  const [isRegex, setIsRegex] = useState(false)
  const [matchCase, setMatchCase] = useState(false)
  const [matchWholeWord, setMatchWholeWord] = useState(false)
  const [replaceVisible, setReplaceVisible] = useState(false)
  const [filtersVisible, setFiltersVisible] = useState(false)
  const [results, setResults] = useState<readonly IFileMatch[]>([])
  const [progress, setProgress] = useState<ITextSearchProgress | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [regexError, setRegexError] = useState<string | null>(null)
  const [isStale, setIsStale] = useState(false)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusEntryRef = useRef<IStatusBarEntryAccessor | null>(null)

  // Focus event from FindInFilesAction.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent<string | null>).detail
      if (typeof detail === 'string' && detail.length > 0) setPattern(detail)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    document.addEventListener(SEARCH_FOCUS_INPUT_EVENT, onFocus)
    return () => document.removeEventListener(SEARCH_FOCUS_INPUT_EVENT, onFocus)
  }, [])

  // Status bar entry follows isSearching.
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
    const p = progress
    const text = p
      ? `$(search) 搜索中… ${p.filesMatched}/${p.filesScanned} 文件，${p.totalMatches} 匹配`
      : '$(search) 搜索中…'
    statusEntryRef.current.update({
      text,
      alignment: StatusBarAlignment.Right,
      priority: 500,
    })
  }, [progress, isSearching])

  const runSearch = useCallback(
    (q: string) => {
      // Cancel any in-flight search.
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
            includes: splitGlobs(includes),
            excludes: splitGlobs(excludes),
          },
          {
            signal: ac.signal,
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
    [searchService, isRegex, matchCase, matchWholeWord, includes, excludes],
  )

  // Debounced trigger on any input/options change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(pattern), DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [pattern, runSearch])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      statusEntryRef.current?.dispose()
      statusEntryRef.current = null
    }
  }, [])

  // Watcher: mark results stale when a result file changes on disk.
  useEffect(() => {
    if (results.length === 0) return
    const known = new Set(results.map((fm) => (URI.revive(fm.resource) as URI).toString()))
    const disposable = fileWatcherService.onDidChangeFiles((events) => {
      for (const ev of events) {
        const key = (URI.revive(ev.resource) as URI).toString()
        if (known.has(key)) {
          setIsStale(true)
          return
        }
      }
    })
    return () => disposable.dispose()
  }, [results, fileWatcherService])

  // Workspace switch: clear results and abort any in-flight search.
  useEffect(() => {
    const disposable = workspaceService.onDidChangeWorkspace(() => {
      abortRef.current?.abort()
      setResults([])
      setProgress(null)
      setIsSearching(false)
      setRegexError(null)
      setIsStale(false)
    })
    return () => disposable.dispose()
  }, [workspaceService])

  const rerunSearch = useCallback(() => {
    runSearch(pattern)
  }, [runSearch, pattern])

  const onActivateMatch = useCallback(
    (resource: URI, match: ITextSearchMatch, rangeIndex: number) => {
      const input = instantiation.createInstance(FileEditorInput, resource)
      editorService.openEditor(input, { pinned: false })
      // After opening, schedule a microtask to reveal the line / select range.
      setTimeout(() => {
        const editor = FileEditorRegistry.get(input)
        const range = match.ranges[rangeIndex]
        if (editor && range) {
          editor.setSelection({
            startLineNumber: match.lineNumber,
            startColumn: range.startColumn,
            endLineNumber: match.lineNumber,
            endColumn: range.endColumn,
          })
          editor.revealLineInCenter(match.lineNumber)
        }
      }, 50)
    },
    [editorService, instantiation],
  )

  const replaceFile = useCallback(
    async (resource: URI, edits: readonly IReplaceEdit[]) => {
      if (edits.length === 0) return
      const model = MonacoModelRegistry.peek(resource)
      if (model) {
        // Already-open file: route through Monaco so the user can undo / save.
        const monacoEdits = edits.map((e) => ({
          range: {
            startLineNumber: e.line,
            startColumn: e.startColumn,
            endLineNumber: e.line,
            endColumn: e.endColumn,
          },
          text: e.replaceText,
        }))
        model.pushEditOperations([], monacoEdits, () => null)
      } else {
        // Read-modify-write the file directly.
        let text: string
        try {
          text = await fileService.readFileText(resource)
        } catch {
          return
        }
        const next = applyReplacements(text, edits)
        if (next !== text) {
          await fileService.writeFile(resource, next)
        }
      }
    },
    [fileService],
  )

  const replaceFileMatch = useCallback(
    (fileMatch: IFileMatch) => {
      const edits: IReplaceEdit[] = []
      for (const m of fileMatch.matches) {
        for (const r of m.ranges) {
          edits.push({
            line: m.lineNumber,
            startColumn: r.startColumn,
            endColumn: r.endColumn,
            replaceText: replacePattern,
          })
        }
      }
      const resource = URI.revive(fileMatch.resource) as URI
      void replaceFile(resource, edits)
      // Optimistically drop the file from results.
      setResults((prev) => prev.filter((fm) => fm !== fileMatch))
    },
    [replaceFile, replacePattern],
  )

  const onReplaceFile = useCallback(
    (resource: URI) => {
      const fm = results.find(
        (r) => (URI.revive(r.resource) as URI).toString() === resource.toString(),
      )
      if (fm) replaceFileMatch(fm)
    },
    [results, replaceFileMatch],
  )

  const onReplaceMatch = useCallback(
    (resource: URI, match: ITextSearchMatch, rangeIndex: number) => {
      const range = match.ranges[rangeIndex]
      if (!range) return
      void replaceFile(resource, [
        {
          line: match.lineNumber,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
          replaceText: replacePattern,
        },
      ])
      // Remove that single range from results without refetching.
      setResults((prev) =>
        prev
          .map((fm) => {
            if ((URI.revive(fm.resource) as URI).toString() !== resource.toString()) return fm
            const matches = fm.matches
              .map((m) => {
                if (m !== match) return m
                const ranges = m.ranges.filter((_, i) => i !== rangeIndex)
                return ranges.length === 0 ? null : { ...m, ranges }
              })
              .filter((m): m is ITextSearchMatch => m !== null)
            return matches.length === 0 ? null : { ...fm, matches }
          })
          .filter((fm): fm is IFileMatch => fm !== null),
      )
    },
    [replaceFile, replacePattern],
  )

  const replaceAll = useCallback(async () => {
    const totalChanges = results.reduce(
      (n, fm) => n + fm.matches.reduce((m, mm) => m + mm.ranges.length, 0),
      0,
    )
    if (totalChanges === 0) return
    if (totalChanges > 20) {
      const ok = await dialogService.confirm({
        message: `在 ${results.length} 个文件中替换 ${totalChanges} 处。继续?`,
        type: 'warning',
        primaryButton: '替换',
        cancelButton: '取消',
      })
      if (!ok.confirmed) return
    }
    for (const fm of results) {
      const edits: IReplaceEdit[] = []
      for (const m of fm.matches) {
        for (const r of m.ranges) {
          edits.push({
            line: m.lineNumber,
            startColumn: r.startColumn,
            endColumn: r.endColumn,
            replaceText: replacePattern,
          })
        }
      }
      await replaceFile(URI.revive(fm.resource) as URI, edits)
    }
    setResults([])
  }, [results, replaceFile, replacePattern, dialogService])

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
        includes={includes}
        excludes={excludes}
        isRegex={isRegex}
        matchCase={matchCase}
        matchWholeWord={matchWholeWord}
        replaceVisible={replaceVisible}
        filtersVisible={filtersVisible}
        onPattern={setPattern}
        onReplace={setReplacePattern}
        onIncludes={setIncludes}
        onExcludes={setExcludes}
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
