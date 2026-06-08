import { useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { Allotment, type AllotmentHandle } from 'allotment'
import 'allotment/dist/style.css'
import type { IViewDescriptor } from '@universe-editor/platform'
import { ViewPane } from './ViewPane.js'
import '../layout/allotment-theme.css'
import styles from '../paneComposite/PaneComposite.module.css'

const HEADER_H = 28
const MIN_BODY = 60
const OPEN_MIN = HEADER_H + MIN_BODY

interface Props {
  views: readonly IViewDescriptor[]
  resolve: (componentKey: string) => ComponentType | undefined
  toolbarMap?: ReadonlyMap<string, ComponentType>
  emptyMessage?: string
}

/**
 * Stacks a container's views as collapsible, resizable panes (VSCode PaneView):
 * collapsed panes shrink to their 28-px header and yield space to the open ones;
 * adjacent open panes are resizable via the sashes between them.
 */
export function ViewPaneContainer({
  views,
  resolve,
  toolbarMap,
  emptyMessage = 'No views registered.',
}: Props) {
  const allotmentRef = useRef<AllotmentHandle>(null)
  const sizesRef = useRef<number[]>([])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // After a collapse/expand toggle, hand collapsed panes their header height and
  // split the rest equally among the open panes — Allotment alone would leave the
  // freed space on the just-collapsed pane. Container switches and the initial
  // layout are handled by Allotment via each pane's min/max, so we only react to
  // `collapsed`; the length guard skips runs where Allotment hasn't yet committed
  // its view items for the current `views` (else resize() indexes undefined).
  useLayoutEffect(() => {
    const handle = allotmentRef.current
    if (!handle) return
    const sizes = sizesRef.current
    if (sizes.length !== views.length) return
    const total = sizes.reduce((sum, n) => sum + n, 0)
    if (total <= 0) return
    const openCount = views.reduce((n, v) => (collapsed.has(v.id) ? n : n + 1), 0)
    if (openCount === 0) return
    const each = (total - HEADER_H * (views.length - openCount)) / openCount
    handle.resize(views.map((v) => (collapsed.has(v.id) ? HEADER_H : each)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed])

  if (views.length === 0) {
    return <p className={styles['empty']}>{emptyMessage}</p>
  }

  if (views.length === 1) {
    const v = views[0]!
    const Component = resolve(v.componentKey)
    return (
      <div data-view-id={v.id} className={styles['viewBody']} style={{ flex: 1, minHeight: 0 }}>
        {Component ? <Component /> : <span className={styles['empty']}>{v.name}</span>}
      </div>
    )
  }

  return (
    <Allotment
      ref={allotmentRef}
      vertical
      onChange={(s) => {
        sizesRef.current = s
      }}
    >
      {views.map((v) => {
        const isCollapsed = collapsed.has(v.id)
        const Component = resolve(v.componentKey)
        return (
          <Allotment.Pane
            key={v.id}
            minSize={isCollapsed ? HEADER_H : OPEN_MIN}
            maxSize={isCollapsed ? HEADER_H : Infinity}
          >
            <ViewPane
              viewId={v.id}
              title={v.name}
              open={!isCollapsed}
              onToggle={() => toggle(v.id)}
              toolbar={toolbarMap?.get(v.id)}
            >
              <div data-view-id={v.id} className={styles['viewBody']}>
                {Component ? <Component /> : <span className={styles['empty']}>{v.name}</span>}
              </div>
            </ViewPane>
          </Allotment.Pane>
        )
      })}
    </Allotment>
  )
}
