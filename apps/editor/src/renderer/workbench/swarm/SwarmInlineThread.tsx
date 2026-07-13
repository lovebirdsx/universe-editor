/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmInlineThread — the React panel rendered inside a Monaco overlay for one
 *  inline-comment anchor: the existing comment list (each with its task-state
 *  control) plus a reply / compose box. Reports its measured height back to the
 *  controller so the reserving view zone can match it.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { localize } from '@universe-editor/platform'
import { Button } from '@universe-editor/workbench-ui'
import type { SwarmCommentDto, SwarmTaskState } from '@universe-editor/extensions-common'
import styles from './SwarmInlineThread.module.css'

/** Legal next task states from the current one (Swarm can't jump open→verified). */
function nextTaskStates(current: SwarmTaskState): SwarmTaskState[] {
  switch (current) {
    case 'comment':
      return ['open']
    case 'open':
      return ['addressed']
    case 'addressed':
      return ['verified', 'open']
    case 'verified':
      return ['addressed']
  }
}

const TASK_LABEL: Record<SwarmTaskState, string> = {
  comment: 'Comment',
  open: 'Open Task',
  addressed: 'Addressed',
  verified: 'Verified',
}

export interface SwarmInlineThreadProps {
  readonly comments: readonly SwarmCommentDto[]
  readonly composing: boolean
  readonly onSubmit: (body: string, asTask: boolean, isReply: boolean) => Promise<void>
  readonly onSetTaskState: (commentId: string, taskState: string) => Promise<void>
  readonly onCancel: () => void
  readonly onHeight: (height: number) => void
}

export function SwarmInlineThread({
  comments,
  composing,
  onSubmit,
  onSetTaskState,
  onCancel,
  onHeight,
}: SwarmInlineThreadProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  const [asTask, setAsTask] = useState(false)
  const [busy, setBusy] = useState(false)

  // Report height so the reserving view zone matches the panel.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const report = () => onHeight(el.offsetHeight + 8)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [onHeight, comments.length, composing])

  useEffect(() => {
    if (!composing) setDraft('')
  }, [composing])

  const hasThread = comments.length > 0
  const isReply = hasThread

  const submit = () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    void onSubmit(body, asTask, isReply)
      .then(() => {
        setDraft('')
        setAsTask(false)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div ref={rootRef} className={styles['thread']}>
      {comments.map((c) => (
        <div key={c.id} className={styles['comment']}>
          <div className={styles['meta']}>
            <span className={styles['author']}>{c.author}</span>
            {c.taskState !== 'comment' && (
              <span className={styles['taskBadge']} data-state={c.taskState}>
                {TASK_LABEL[c.taskState]}
              </span>
            )}
            <span className={styles['spacer']} />
            {nextTaskStates(c.taskState).map((s) => (
              <button
                key={s}
                type="button"
                className={styles['taskAction']}
                onClick={() => void onSetTaskState(c.id, s)}
              >
                {TASK_LABEL[s]}
              </button>
            ))}
          </div>
          <div className={styles['body']}>{c.body}</div>
        </div>
      ))}
      {(composing || !hasThread) && (
        <div className={styles['compose']}>
          <textarea
            className={styles['input']}
            value={draft}
            placeholder={
              isReply
                ? localize('swarm.inline.reply', 'Reply…')
                : localize('swarm.inline.comment', 'Add a comment on this line…')
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              }
            }}
          />
          <div className={styles['composeActions']}>
            <label className={styles['taskToggle']}>
              <input
                type="checkbox"
                checked={asTask}
                onChange={(e) => setAsTask(e.target.checked)}
              />
              {localize('swarm.inline.asTask', 'Mark as task')}
            </label>
            <span className={styles['spacer']} />
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {localize('swarm.inline.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              disabled={!draft.trim()}
              onClick={submit}
            >
              {isReply
                ? localize('swarm.inline.replyBtn', 'Reply')
                : localize('swarm.inline.commentBtn', 'Comment')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
