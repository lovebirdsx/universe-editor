/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PerforceGraphSyncDialog — a self-contained modal that lets the user pick which
 *  top-level directories of the graph client to sync onto a submitted changelist
 *  (P4V-style "Get Revision as of a CL"). Mirrors GitGraphWorktreePickerDialog's
 *  portal-based, dependency-free style; selection is local and reported via
 *  onConfirm with the chosen directory paths. Focus is trapped inside the dialog
 *  (FocusScopeOverlay) and the whole list is keyboard-driven: arrows/Home/End
 *  move across "Select all" + rows, Space toggles, Enter confirms, Esc cancels.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { localize } from '@universe-editor/platform'
import { FocusScopeOverlay } from '@universe-editor/workbench-ui'
import type { P4GraphSyncScopeDto } from '@universe-editor/extensions-common'
import styles from '../gitGraph/GitGraphEditor.module.css'

export interface PerforceGraphSyncDialogState {
  /** Changelist number the workspace is being synced to. */
  readonly change: string
  /** The change is the newest loaded for the graph — skips the time-travel warning. */
  readonly isLatest: boolean
  /** Candidate directories (client root's top level). */
  readonly candidates: readonly P4GraphSyncScopeDto[]
}

export function PerforceGraphSyncDialog({
  state,
  onConfirm,
  onCancel,
}: {
  state: PerforceGraphSyncDialogState
  onConfirm: (selectedPaths: string[]) => void
  onCancel: () => void
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
          const candidate = state.candidates[idx - 1]
          if (candidate) toggle(candidate.path)
        }
      }
      return
    }
    // Enter confirms from anywhere except the buttons (those activate natively).
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) confirm()
  }

  return createPortal(
    <FocusScopeOverlay visible onEscape={onCancel}>
      <div className={styles['pickerBackdrop']} onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        className={styles['pickerDialog']}
        data-testid="perforceGraph-syncDialog"
        onKeyDown={onDialogKeyDown}
      >
        <div className={styles['pickerTitle']}>
          {localize('perforceGraph.sync.title', 'Get Revision @{change}', {
            change: state.change,
          })}
        </div>
        <div className={styles['pickerRowDesc']}>
          {localize(
            'perforceGraph.sync.description',
            'Choose the folders to sync to the state of this changelist.',
          )}
        </div>
        {state.candidates.length > 0 ? (
          <label className={styles['pickerSelectAll']}>
            <input
              ref={(el) => {
                itemRefs.current[0] = el
              }}
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
            />
            <span>{localize('perforceGraph.sync.selectAll', 'Select all')}</span>
          </label>
        ) : (
          <div className={styles['pickerRowDesc']}>
            {localize(
              'perforceGraph.sync.noFolders',
              'Could not list the workspace folders. Use "Get This Revision" to sync the whole displayed range instead.',
            )}
          </div>
        )}
        <div className={styles['pickerList']}>
          {state.candidates.map((c, i) => (
            <label key={c.path} className={styles['pickerRow']}>
              <input
                ref={(el) => {
                  itemRefs.current[i + 1] = el
                }}
                type="checkbox"
                checked={selected.has(c.path)}
                onChange={() => toggle(c.path)}
              />
              <span className={styles['pickerRowName']}>{c.name}</span>
              <span className={styles['pickerRowDesc']}>{c.path}</span>
            </label>
          ))}
        </div>
        <div className={styles['pickerButtons']}>
          <button type="button" className={styles['pickerBtn']} onClick={onCancel}>
            {localize('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={`${styles['pickerBtn']} ${styles['pickerBtnPrimary']}`}
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
          >
            {localize('perforceGraph.sync.confirm', 'Get Revision ({count})', {
              count: selected.size,
            })}
          </button>
        </div>
      </div>
    </FocusScopeOverlay>,
    document.body,
  )
}
