/*---------------------------------------------------------------------------------------------
 *  TimelineViewToolbar — the Timeline view's title-bar actions, rendered in the
 *  Explorer container header via the view toolbar registry. Mirrors VSCode's
 *  timeline title actions: a pin/unpin toggle (pinned = stop following the
 *  active editor) and a `…` overflow with the Filter-by-Source check group.
 *  The filter state is shared with the view body through timelineViewState and
 *  persisted by TimelineViewStateContribution.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, MoreHorizontal, Pin, PinOff } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { ITimelineService } from '../../services/timeline/TimelineService.js'
import { timelineViewState } from './timelineViewState.js'
import styles from './TimelineViewToolbar.module.css'

export function TimelineViewToolbar() {
  const timelineService = useService(ITimelineService)
  const uri = useObservable(timelineService.uri)
  const pinnedUri = useObservable(timelineService.pinnedUri)
  const providers = useObservable(timelineService.providers)
  const excluded = useObservable(timelineViewState.excludedSources)
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null)

  const openOverflow = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverflow({ x: rect.right - 200, y: rect.bottom + 2 })
  }

  const pinned = pinnedUri !== undefined

  return (
    <>
      <button
        type="button"
        className={styles['toolbarBtn']}
        disabled={!pinned && uri === undefined}
        title={
          pinned
            ? localize('timeline.unpin', 'Unpin Timeline')
            : localize('timeline.pin', 'Pin Timeline')
        }
        onClick={() => {
          if (pinned) timelineService.unpin()
          else if (uri) timelineService.pinUri(uri)
        }}
      >
        {pinned ? (
          <PinOff size={14} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Pin size={14} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('timeline.moreActions', 'More Actions...')}
        onClick={openOverflow}
      >
        <MoreHorizontal size={16} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {overflow && (
        <TimelineOverflowMenu
          anchor={overflow}
          providers={providers.map((p) => ({ id: p.id, label: p.label }))}
          excluded={excluded}
          onClose={() => setOverflow(null)}
        />
      )}
    </>
  )
}

function TimelineOverflowMenu({
  anchor,
  providers,
  excluded,
  onClose,
}: {
  anchor: { x: number; y: number }
  providers: readonly { id: string; label: string }[]
  excluded: readonly string[]
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest('[data-overflow-menu]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <ul
      ref={ref}
      role="menu"
      data-overflow-menu=""
      className={styles['overflowMenu']}
      style={{ top: anchor.y, left: anchor.x }}
    >
      <li className={styles['overflowLabel']}>
        {localize('timeline.filterBySource', 'Filter by Source')}
      </li>
      {providers.map((p) => (
        <li
          key={p.id}
          role="menuitemcheckbox"
          aria-checked={!excluded.includes(p.id)}
          className={styles['overflowItem']}
          tabIndex={-1}
          onClick={() => timelineViewState.toggleSource(p.id)}
        >
          <span className={styles['overflowCheck']} aria-hidden="true">
            {!excluded.includes(p.id) ? <Check size={14} strokeWidth={2} /> : null}
          </span>
          <span className={styles['overflowItemLabel']}>{p.label}</span>
        </li>
      ))}
    </ul>,
    document.body,
  )
}
