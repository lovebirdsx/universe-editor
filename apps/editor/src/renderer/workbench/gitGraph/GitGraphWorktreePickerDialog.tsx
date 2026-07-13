/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphWorktreePickerDialog — a self-contained modal that lets the user pick
 *  which worktrees to sync onto a target branch. Mirrors GitGraphContextMenu's
 *  portal-based, dependency-free style; selection is local and reported via
 *  onConfirm with the chosen worktree paths.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { localize } from '@universe-editor/platform'
import type { GitGraphWorktreeDto } from '@universe-editor/extensions-common'
import styles from './GitGraphEditor.module.css'

export interface GitGraphWorktreePickerState {
  /** Branch the selected worktrees will be reset to. */
  readonly targetBranch: string
  /** Force reset committed work not yet merged into the target branch. */
  readonly force: boolean
  /** Candidate worktrees (target excluded by the caller). */
  readonly candidates: readonly GitGraphWorktreeDto[]
}

export function GitGraphWorktreePickerDialog({
  state,
  onConfirm,
  onClose,
}: {
  state: GitGraphWorktreePickerState
  onConfirm: (selectedPaths: string[]) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(state.candidates.map((c) => c.path)),
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const allChecked = selected.size === state.candidates.length
  const toggleAll = (): void => {
    setSelected(allChecked ? new Set() : new Set(state.candidates.map((c) => c.path)))
  }

  return createPortal(
    <>
      <div className={styles['pickerBackdrop']} onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" className={styles['pickerDialog']}>
        <div className={styles['pickerTitle']}>
          {state.force
            ? localize('gitGraph.worktree.forceSync.title', 'Force sync worktrees to {branch}', {
                branch: state.targetBranch,
              })
            : localize('gitGraph.worktree.sync.title', 'Sync worktrees to {branch}', {
                branch: state.targetBranch,
              })}
        </div>
        <label className={styles['pickerSelectAll']}>
          <input type="checkbox" checked={allChecked} onChange={toggleAll} />
          <span>{localize('gitGraph.worktree.sync.selectAll', 'Select all')}</span>
        </label>
        <div className={styles['pickerList']}>
          {state.candidates.map((wt) => (
            <label key={wt.path} className={styles['pickerRow']}>
              <input
                type="checkbox"
                checked={selected.has(wt.path)}
                onChange={() => toggle(wt.path)}
              />
              <span className={styles['pickerRowName']}>{wt.name}</span>
              <span className={styles['pickerRowDesc']}>{wt.branch ?? wt.path}</span>
            </label>
          ))}
        </div>
        <div className={styles['pickerButtons']}>
          <button type="button" className={styles['pickerBtn']} onClick={onClose}>
            {localize('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={`${styles['pickerBtn']} ${styles['pickerBtnPrimary']}`}
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
          >
            {state.force
              ? localize('gitGraph.worktree.forceSync.confirm', 'Force sync ({count})', {
                  count: selected.size,
                })
              : localize('gitGraph.worktree.sync.confirm', 'Sync ({count})', {
                  count: selected.size,
                })}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
