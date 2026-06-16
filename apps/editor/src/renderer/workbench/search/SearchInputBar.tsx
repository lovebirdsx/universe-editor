/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchInputBar — query / replace inputs plus toggle options.
 *--------------------------------------------------------------------------------------------*/

import { forwardRef, useRef, type RefObject } from 'react'
import { ChevronDown, ChevronRight, FileX2, SlidersHorizontal } from 'lucide-react'
import styles from './SearchView.module.css'

export interface SearchInputBarProps {
  pattern: string
  replacePattern: string
  includes: string
  excludes: string
  isRegex: boolean
  matchCase: boolean
  matchWholeWord: boolean
  replaceVisible: boolean
  filtersVisible: boolean
  useExcludeSettings: boolean
  /** Most-recent-first ring of accepted queries, for ↑/↓ navigation. */
  history: readonly string[]
  onPattern: (v: string) => void
  onReplace: (v: string) => void
  onIncludes: (v: string) => void
  onExcludes: (v: string) => void
  onToggleRegex: () => void
  onToggleCase: () => void
  onToggleWord: () => void
  onToggleReplace: () => void
  onToggleFilters: () => void
  onToggleUseExclude: () => void
  /** Enter in the query input — record the current query in history. */
  onSubmit?: () => void
  /** Tab from the main query input moves focus into the results list. */
  onTabToResults?: () => void
}

interface ToggleProps {
  label: string
  title: string
  active: boolean
  onClick: () => void
}

function Toggle({ label, title, active, onClick }: ToggleProps) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      className={`${styles['toggle']} ${active ? styles['toggleActive'] : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

export const SearchInputBar = forwardRef<HTMLInputElement, SearchInputBarProps>(
  function SearchInputBar(props, ref) {
    // History navigation state. -1 means "editing a fresh draft" (not in history);
    // draftRef holds that draft so ArrowDown past the newest entry restores it.
    const historyIndexRef = useRef(-1)
    const draftRef = useRef('')

    const onQueryKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Tab' && !e.shiftKey && props.onTabToResults) {
        e.preventDefault()
        props.onTabToResults()
        return
      }
      if (e.key === 'Enter') {
        historyIndexRef.current = -1
        props.onSubmit?.()
        return
      }
      const history = props.history
      if (e.key === 'ArrowUp') {
        if (history.length === 0) return
        e.preventDefault()
        if (historyIndexRef.current === -1) draftRef.current = props.pattern
        const next = Math.min(historyIndexRef.current + 1, history.length - 1)
        historyIndexRef.current = next
        props.onPattern(history[next] ?? '')
        return
      }
      if (e.key === 'ArrowDown') {
        if (historyIndexRef.current === -1) return
        e.preventDefault()
        const next = historyIndexRef.current - 1
        historyIndexRef.current = next
        props.onPattern(next === -1 ? draftRef.current : (history[next] ?? ''))
        return
      }
    }

    return (
      <div className={styles['inputBar']}>
        <div className={styles['inputRow']}>
          <button
            type="button"
            className={styles['expand']}
            aria-label="Toggle Replace"
            aria-pressed={props.replaceVisible}
            onClick={props.onToggleReplace}
          >
            {props.replaceVisible ? (
              <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
          <div className={styles['inputBox']}>
            <input
              ref={ref as RefObject<HTMLInputElement>}
              className={styles['input']}
              type="text"
              placeholder="Search"
              aria-label="Search"
              value={props.pattern}
              onChange={(e) => {
                historyIndexRef.current = -1
                props.onPattern(e.target.value)
              }}
              onKeyDown={onQueryKeyDown}
            />
            <div className={styles['toggles']}>
              <Toggle
                label="Aa"
                title="Match Case"
                active={props.matchCase}
                onClick={props.onToggleCase}
              />
              <Toggle
                label="ab|"
                title="Match Whole Word"
                active={props.matchWholeWord}
                onClick={props.onToggleWord}
              />
              <Toggle
                label=".*"
                title="Use Regular Expression"
                active={props.isRegex}
                onClick={props.onToggleRegex}
              />
            </div>
          </div>
          <button
            type="button"
            title="Toggle Search Details"
            aria-label="Toggle Search Details"
            aria-pressed={props.filtersVisible}
            className={`${styles['filterToggle']} ${props.filtersVisible ? styles['filterToggleActive'] : ''}`}
            onClick={props.onToggleFilters}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        {props.replaceVisible && (
          <div className={styles['inputRow']}>
            <span className={styles['expand']} />
            <div className={styles['inputBox']}>
              <input
                className={styles['input']}
                type="text"
                placeholder="Replace"
                aria-label="Replace"
                value={props.replacePattern}
                onChange={(e) => props.onReplace(e.target.value)}
              />
            </div>
          </div>
        )}
        {props.filtersVisible && (
          <div className={styles['filters']}>
            <label className={styles['filterLabel']}>
              <span>files to include</span>
              <input
                className={styles['input']}
                type="text"
                placeholder="e.g. **/*.ts"
                value={props.includes}
                onChange={(e) => props.onIncludes(e.target.value)}
              />
            </label>
            <label className={styles['filterLabel']}>
              <span className={styles['filterLabelRow']}>
                files to exclude
                <button
                  type="button"
                  title="Use Exclude Settings and Ignore Files"
                  aria-label="Use Exclude Settings and Ignore Files"
                  aria-pressed={props.useExcludeSettings}
                  className={`${styles['excludeToggle']} ${props.useExcludeSettings ? styles['excludeToggleActive'] : ''}`}
                  onClick={props.onToggleUseExclude}
                >
                  <FileX2 size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
              <input
                className={styles['input']}
                type="text"
                placeholder="e.g. **/__tests__/**"
                value={props.excludes}
                onChange={(e) => props.onExcludes(e.target.value)}
              />
            </label>
          </div>
        )}
      </div>
    )
  },
)
