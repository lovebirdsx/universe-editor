/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchInputBar — query / replace inputs plus toggle options.
 *--------------------------------------------------------------------------------------------*/

import { forwardRef, type RefObject } from 'react'
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
  onPattern: (v: string) => void
  onReplace: (v: string) => void
  onIncludes: (v: string) => void
  onExcludes: (v: string) => void
  onToggleRegex: () => void
  onToggleCase: () => void
  onToggleWord: () => void
  onToggleReplace: () => void
  onToggleFilters: () => void
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
            {props.replaceVisible ? '▾' : '▸'}
          </button>
          <div className={styles['inputBox']}>
            <input
              ref={ref as RefObject<HTMLInputElement>}
              className={styles['input']}
              type="text"
              placeholder="Search"
              aria-label="Search"
              value={props.pattern}
              onChange={(e) => props.onPattern(e.target.value)}
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
        <button
          type="button"
          className={styles['filtersBtn']}
          aria-pressed={props.filtersVisible}
          onClick={props.onToggleFilters}
        >
          {props.filtersVisible ? '隐藏 files to include/exclude' : '显示 files to include/exclude'}
        </button>
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
              <span>files to exclude</span>
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
