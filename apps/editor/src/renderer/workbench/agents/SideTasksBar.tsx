/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SideTasksBar — the parent chat's affordance for its side tasks (侧边任务):
 *  a small trigger ("Side Tasks (N)") pinned above the chat scroll that opens a
 *  popover listing every history row forked from this session
 *  (`sideTaskOf === this session`). Picking a row opens (or focuses) that side
 *  task in a right-split editor tab; a not-yet-live row auto-resumes through
 *  AcpSessionEditor's resumer. Renders nothing for side tasks themselves (the
 *  quote chip is SideTaskQuoteBar's job) or when there are no children.
 *
 *  SideTaskQuoteBar — the chip a side-task chat shows at its top, replaying the
 *  text selection it was created from (`sideTaskQuote` on its history row).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import {
  ConfigurationTarget,
  IConfigurationService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  localize,
} from '@universe-editor/platform'
import { GitBranch, TextQuote, Trash2 } from 'lucide-react'
import { useObservable, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import {
  collectSideTaskDescendants,
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../services/acp/session/acpSessionHistory.js'
import { openSessionInRightSplit } from '../../actions/agentSessionActions.js'
import { relativeTime } from '../../relativeTime.js'
import styles from './agents.module.css'

export function SideTasksBar({ session }: { session: IAcpSession }) {
  const history = useService(IAcpSessionHistoryService)
  const sessions = useService(IAcpSessionService)
  const groups = useService(IEditorGroupsService)
  const inst = useService(IInstantiationService)
  const dialogService = useService(IDialogService)
  const config = useService(IConfigurationService)
  const entries = useObservable(history.entries)
  const sid = useObservable(session.sessionIdOnAgent) ?? session.id
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const entry = history.get(sid)
  const sideTasks = entries
    .filter((e) => e.sideTaskOf !== undefined && e.sideTaskOf === sid)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)

  useEffect(() => {
    if (!open) return
    const handlePointer = (ev: MouseEvent) => {
      const el = popoverRef.current
      if (!el) return
      if (ev.target instanceof Node && el.contains(ev.target)) return
      setOpen(false)
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false)
    }
    // Defer one tick so the click that opened the popover doesn't immediately
    // close it (the open click bubbles into document before our handler attaches).
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  if (entry?.sideTaskOf !== undefined || sideTasks.length === 0) return null

  const openSideTask = (sessionId: string): void => {
    setOpen(false)
    const row = history.get(sessionId)
    if (!row) return
    // Live when resident; otherwise a stand-in — the editor tab's resumer picks
    // the id up from history and auto-resumes the side task.
    const live = sessions.getById(sessionId)
    const target = live ?? { id: sessionId, agentId: row.agentId }
    openSessionInRightSplit(groups, inst, target)
  }

  const removeSideTask = (task: AcpSessionHistoryEntry): void => {
    // Resolve the subtree synchronously — `entries` is a render-time value, and by
    // the time the confirm dialog resolves it may no longer describe the rows we
    // are about to delete.
    const ids = collectSideTaskDescendants(entries, task.id)
    void (async () => {
      if (config.get<boolean>('acp.sessions.confirmDelete') !== false) {
        const result = await dialogService.confirm({
          message: localize('acp.sideTask.removeConfirm', 'Delete this side task?'),
          detail:
            ids.length > 1
              ? localize(
                  'acp.sideTask.removeConfirmDetailNested',
                  'This also deletes its {count} nested side task(s).',
                  { count: ids.length - 1 },
                )
              : localize(
                  'acp.sideTask.removeConfirmDetail',
                  'This will delete the side task and its history.',
                ),
          primaryButton: localize('acp.sessions.removeConfirmOk', 'Delete'),
          cancelButton: localize('acp.sessions.removeConfirmCancel', 'Cancel'),
          neverAskAgainLabel: localize('acp.sessions.removeNeverAsk', "Don't ask again"),
        })
        if (!result.confirmed) return
        if (result.neverAskAgain) {
          config.update('acp.sessions.confirmDelete', false, ConfigurationTarget.User)
        }
      }
      for (const id of ids) {
        // Best-effort per row: a failing close/delete must not strand the rest of
        // the subtree, which is exactly the orphan state this cascade prevents.
        try {
          // closeSession fires onDidCloseSession, which closes the side task's
          // right-split tab through AgentsSessionEditorLifecycleContribution.
          const live = sessions.getById(id)
          if (live) await sessions.closeSession(live.id)
          await sessions.deleteOnAgent(id)
        } catch (err) {
          console.warn(`[side-task] delete failed for ${id}, dropping the local row anyway`, err)
        }
        // The local row goes regardless — an agent that can't delete server-side
        // must not leave the side task undeletable here (same call as the session
        // list's onRemove, which likewise ignores deleteOnAgent's outcome).
        history.remove(id)
      }
      // The button that was clicked has just been unmounted, dropping focus to
      // <body>. Hand it to the trigger so keyboard users stay in the popover's
      // orbit; when this was the last side task the whole bar unmounts and the
      // ref is already null, so there is nothing to restore.
      triggerRef.current?.focus()
    })()
  }

  return (
    <div className={styles['sideTasksBar']}>
      <button
        type="button"
        ref={triggerRef}
        className={styles['sideTasksTrigger']}
        data-testid="acp-side-tasks-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
        {localize('acp.sideTask.bar', 'Side Tasks')} ({sideTasks.length})
      </button>
      {open && (
        <div
          ref={popoverRef}
          className={styles['sideTasksPopover']}
          data-testid="acp-side-tasks-popover"
          role="menu"
          aria-label={localize('acp.sideTask.bar', 'Side Tasks')}
        >
          <ul className={styles['sideTasksList']}>
            {sideTasks.map((task) => (
              <li key={task.sessionIdOnAgent} className={styles['sideTasksItem']}>
                <button
                  type="button"
                  className={styles['sideTasksRow']}
                  data-testid="acp-side-task-row"
                  onClick={() => openSideTask(task.sessionIdOnAgent)}
                >
                  <span className={styles['sideTasksRowTitle']}>{task.title}</span>
                  <span className={styles['sideTasksRowMeta']}>
                    {relativeTime(task.lastUsedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles['sideTaskDelete']}
                  data-testid="acp-side-task-delete"
                  aria-label={localize('acp.sideTask.remove', 'Delete side task')}
                  onClick={() => removeSideTask(task)}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function SideTaskQuoteBar({ session }: { session: IAcpSession }) {
  const history = useService(IAcpSessionHistoryService)
  useObservable(history.entries)
  const sid = useObservable(session.sessionIdOnAgent) ?? session.id
  const entry = history.get(sid)
  if (entry?.sideTaskOf === undefined || entry.sideTaskQuote === undefined) return null
  return (
    <div className={styles['sideTaskQuoteBar']}>
      <span
        className={styles['sideTaskQuoteChip']}
        data-testid="acp-side-task-quote"
        data-tooltip={entry.sideTaskQuote}
      >
        <TextQuote size={12} strokeWidth={1.75} aria-hidden="true" />
        {localize('acp.sideTask.quoteChip', '{count} selected text fragment(s)', { count: 1 })}
      </span>
    </div>
  )
}
