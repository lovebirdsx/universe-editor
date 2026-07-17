/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphBranchPickerDialog — a self-contained modal that lets the user pick a
 *  single target branch (e.g. the destination for "Cherry pick to branch…").
 *  Mirrors GitGraphWorktreePickerDialog's portal-based, dependency-free style; the
 *  chosen branch is reported via onConfirm. A filter input narrows long lists.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { localize } from '@universe-editor/platform'
import styles from './GitGraphEditor.module.css'

export interface GitGraphBranchPickerState {
  /** Dialog title, phrased for the pending operation. */
  readonly title: string
  /** Candidate local branch names. */
  readonly branches: readonly string[]
  /** Branch to exclude (e.g. the current branch), if any. */
  readonly exclude?: string
}

export function GitGraphBranchPickerDialog({
  state,
  onConfirm,
  onClose,
}: {
  state: GitGraphBranchPickerState
  onConfirm: (branch: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const candidates = useMemo(
    () => state.branches.filter((b) => b !== state.exclude),
    [state.branches, state.exclude],
  )
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? candidates.filter((b) => b.toLowerCase().includes(q)) : candidates
  }, [candidates, filter])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const confirm = (branch: string | null): void => {
    if (branch) onConfirm(branch)
  }

  return createPortal(
    <>
      <div className={styles['pickerBackdrop']} onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" className={styles['pickerDialog']}>
        <div className={styles['pickerTitle']}>{state.title}</div>
        <input
          ref={inputRef}
          className={styles['searchInput']}
          type="search"
          placeholder={localize('gitGraph.branchPicker.filter', 'Filter branches…')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={localize('gitGraph.branchPicker.filter', 'Filter branches…')}
        />
        <div className={styles['pickerList']}>
          {visible.length === 0 ? (
            <div className={styles['pickerRowDesc']} style={{ padding: '6px 10px' }}>
              {localize('gitGraph.branchPicker.empty', 'No branches match.')}
            </div>
          ) : (
            visible.map((branch) => (
              <button
                key={branch}
                type="button"
                className={`${styles['pickerRow']} ${branch === selected ? styles['rowSelected'] : ''}`}
                onClick={() => setSelected(branch)}
                onDoubleClick={() => confirm(branch)}
              >
                <span className={styles['pickerRowName']}>{branch}</span>
              </button>
            ))
          )}
        </div>
        <div className={styles['pickerButtons']}>
          <button type="button" className={styles['pickerBtn']} onClick={onClose}>
            {localize('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={`${styles['pickerBtn']} ${styles['pickerBtnPrimary']}`}
            disabled={!selected}
            onClick={() => confirm(selected)}
          >
            {localize('gitGraph.branchPicker.confirm', 'Cherry-pick')}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
