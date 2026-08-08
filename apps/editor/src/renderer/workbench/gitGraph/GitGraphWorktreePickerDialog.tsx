/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphWorktreePickerDialog — a self-contained modal that lets the user pick
 *  which worktrees to sync onto a target branch. Mirrors GitGraphContextMenu's
 *  portal-based, dependency-free style; selection is local and reported via
 *  onConfirm with the chosen worktree paths. Focus is trapped inside the dialog
 *  (FocusScopeOverlay) and the whole list is keyboard-driven: arrows/Home/End
 *  move across "Select all" + rows, Space toggles, Enter confirms, Esc cancels.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { localize } from '@universe-editor/platform'
import { FocusScopeOverlay } from '@universe-editor/workbench-ui'
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
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(state.candidates.map((c) => c.path)),
  )
  // Focus slots for roving-focus navigation: 0 = "Select all", 1..N = rows.
  const itemRefs = useRef<(HTMLInputElement | null)[]>([])

  // Explicit on-mount focus: FocusScope's own autoFocus defers to a rAF, which
  // would leave the underlying graph handling keys for a frame.
  useLayoutEffect(() => {
    itemRefs.current[0]?.focus()
  }, [])

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

  const confirm = (): void => {
    if (selected.size > 0) onConfirm([...selected])
  }

  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const items = itemRefs.current
      const current = items.findIndex((el) => el !== null && el === e.target)
      const last = state.candidates.length
      let next: number
      if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = last
      else if (e.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(current + 1, last)
      else next = current < 0 ? last : Math.max(current - 1, 0)
      items[next]?.focus()
      return
    }
    // Toggle explicitly on keydown (preventDefault suppresses the native
    // keyup activation) so the behavior is identical across browsers/tests.
    if (e.key === ' ') {
      const target = e.target
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        e.preventDefault()
        const idx = itemRefs.current.findIndex((el) => el === target)
        if (idx === 0) toggleAll()
        else {
          const wt = state.candidates[idx - 1]
          if (wt) toggle(wt.path)
        }
      }
      return
    }
    // Enter confirms from anywhere except the buttons (those activate natively).
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) confirm()
  }

  return createPortal(
    <FocusScopeOverlay visible onEscape={onClose}>
      <div className={styles['pickerBackdrop']} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={styles['pickerDialog']}
        onKeyDown={onDialogKeyDown}
      >
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
          <input
            ref={(el) => {
              itemRefs.current[0] = el
            }}
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
          />
          <span>{localize('gitGraph.worktree.sync.selectAll', 'Select all')}</span>
        </label>
        <div className={styles['pickerList']}>
          {state.candidates.map((wt, i) => (
            <label key={wt.path} className={styles['pickerRow']}>
              <input
                ref={(el) => {
                  itemRefs.current[i + 1] = el
                }}
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
    </FocusScopeOverlay>,
    document.body,
  )
}
