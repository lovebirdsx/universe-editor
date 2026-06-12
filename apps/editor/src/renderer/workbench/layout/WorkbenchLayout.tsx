import { useEffect, useRef, type ReactNode } from 'react'
import { Allotment, type AllotmentHandle } from 'allotment'
import 'allotment/dist/style.css'
import type { LayoutSizes } from '@universe-editor/platform'
import styles from './WorkbenchLayout.module.css'
import './allotment-theme.css'
import { computeResizeAfterSecondaryToggle } from '../../services/layout/resizeUtils.js'

interface WorkbenchLayoutProps {
  titlebar: ReactNode
  activitybar: ReactNode
  sidebar: ReactNode
  secondarySidebar: ReactNode
  editor: ReactNode
  panel: ReactNode
  statusbar: ReactNode
  sidebarVisible: boolean
  secondarySidebarVisible: boolean
  panelVisible: boolean
  panelMaximized: boolean
  activitybarVisible: boolean
  sizes: Readonly<LayoutSizes>
  onSidebarResize: (px: number) => void
  onSecondarySidebarResize: (px: number) => void
  onPanelResize: (px: number) => void
}

const SIDEBAR_MIN = 170
const SIDEBAR_MAX = 600
const PANEL_MIN = 100
const PANEL_MAX = 800

export function WorkbenchLayout({
  titlebar,
  activitybar,
  sidebar,
  secondarySidebar,
  editor,
  panel,
  statusbar,
  sidebarVisible,
  secondarySidebarVisible,
  panelVisible,
  panelMaximized,
  activitybarVisible,
  sizes,
  onSidebarResize,
  onSecondarySidebarResize,
  onPanelResize,
}: WorkbenchLayoutProps) {
  const allotmentRef = useRef<AllotmentHandle>(null)
  // Maximizing the panel hides the editor pane so the panel fills the center
  // column (mirrors VSCode's "Maximize Panel Size"). Only meaningful while the
  // panel is actually visible.
  const editorPaneVisible = !(panelMaximized && panelVisible)
  // Allotment 1.20.5's distributeEmptySpace greedily fills the first visible
  // pane up to its maxSize on the initial layout pass — preferredSize is read
  // when views are added, but the container has size=0 at that point so the
  // pane reverts to maxSize when the ResizeObserver later calls layout(W).
  // We override that layout the moment we see the first onChange with a
  // non-zero total (= container is sized, initial distribution just happened).
  const isInitializedRef = useRef(false)
  const initialSizesRef = useRef(sizes)

  // Track live [sidebar, editor, secondary] sizes reported by Allotment.
  const currentSizesRef = useRef<[number, number, number]>([sizes.sidebar, 0, 0])

  // When secondarySidebarVisible changes, capture the pre-change sizes so
  // we can override Allotment's redistribution (which gives freed space to
  // the sidebar pane instead of the editor pane).
  const prevSecVisibleRef = useRef(secondarySidebarVisible)
  const sizeSnapshotRef = useRef<[number, number, number]>(currentSizesRef.current)
  // Live secondary size captured at hide-time from Allotment, not from the
  // service. Avoids using sizes.secondarySidebar which can be transiently
  // corrupted to 0 if Allotment fires onChange with a stale closure while
  // the pane is being hidden.
  const lastSecondarySizeRef = useRef(sizes.secondarySidebar)

  // Panel show-transition guard: when panelVisible flips false→true, Allotment's
  // internal ResizeObserver fires onChange synchronously, which would call
  // onPanelResize → update sizes.panel → re-render → new preferredSize →
  // another Allotment layout pass — triggering a "ResizeObserver loop" browser
  // warning. We defer only the *first* onChange after the panel appears.
  const prevPanelVisibleRef = useRef(panelVisible)
  const panelJustShownRef = useRef(false)
  const panelVisibleRef = useRef(panelVisible)
  const onPanelResizeRef = useRef(onPanelResize)
  // While maximized the panel's height is the whole column, not the user's
  // chosen size — never persist it, or restoring would lose the real size.
  const panelMaximizedRef = useRef(panelMaximized)
  panelVisibleRef.current = panelVisible
  onPanelResizeRef.current = onPanelResize
  panelMaximizedRef.current = panelMaximized

  if (prevPanelVisibleRef.current !== panelVisible) {
    if (!prevPanelVisibleRef.current && panelVisible) panelJustShownRef.current = true
    prevPanelVisibleRef.current = panelVisible
  }

  if (prevSecVisibleRef.current !== secondarySidebarVisible) {
    // Transitioning visible → hidden: capture the live Allotment size before
    // any effect or onChange callback can overwrite it with 0.
    if (prevSecVisibleRef.current && !secondarySidebarVisible) {
      const liveSize = currentSizesRef.current[2]
      if (liveSize > 0) lastSecondarySizeRef.current = liveSize
    }
    sizeSnapshotRef.current = currentSizesRef.current
    prevSecVisibleRef.current = secondarySidebarVisible
  }

  // After each secondarySidebarVisible flip, Allotment may distribute the
  // freed/needed space to the wrong pane. Correct it by explicitly resizing.
  useEffect(() => {
    if (!isInitializedRef.current) return
    const correction = computeResizeAfterSecondaryToggle(
      sizeSnapshotRef.current,
      secondarySidebarVisible,
      lastSecondarySizeRef.current,
    )
    if (correction) allotmentRef.current?.resize(correction)
  }, [secondarySidebarVisible])

  return (
    <div className={styles['workbench']}>
      <div className={styles['titlebar']}>{titlebar}</div>
      <div className={styles['top']}>
        <div
          className={styles['activitybar']}
          style={activitybarVisible ? undefined : { display: 'none' }}
        >
          {activitybar}
        </div>
        <div className={styles['main']}>
          <Allotment
            ref={allotmentRef}
            proportionalLayout={false}
            onChange={(s) => {
              if (s.length < 3) return
              const total = s[0]! + s[1]! + s[2]!
              if (!isInitializedRef.current) {
                if (total <= 0) return
                isInitializedRef.current = true
                const saved = initialSizesRef.current
                const sec = secondarySidebarVisible ? saved.secondarySidebar : 0
                const editorSize = total - saved.sidebar - sec
                if (editorSize <= 0) return
                queueMicrotask(() => {
                  allotmentRef.current?.resize([saved.sidebar, editorSize, sec])
                })
                return
              }
              currentSizesRef.current = [s[0]!, s[1]!, s[2]!]
              const sidebarSize = s[0]
              const secondarySize = s[2]
              if (typeof sidebarSize === 'number' && sidebarSize > 0 && sidebarVisible)
                onSidebarResize(sidebarSize)
              if (typeof secondarySize === 'number' && secondarySize > 0 && secondarySidebarVisible)
                onSecondarySidebarResize(secondarySize)
            }}
          >
            <Allotment.Pane
              minSize={SIDEBAR_MIN}
              maxSize={SIDEBAR_MAX}
              preferredSize={sizes.sidebar}
              visible={sidebarVisible}
            >
              <div className={styles['pane']}>{sidebar}</div>
            </Allotment.Pane>
            <Allotment.Pane>
              <Allotment
                vertical
                proportionalLayout={false}
                onChange={(s) => {
                  const second = s[1]
                  if (typeof second !== 'number' || !panelVisibleRef.current) return
                  // Don't persist the panel's height while maximized — it's the
                  // full column, not the user's preferred size.
                  if (panelMaximizedRef.current) return
                  if (panelJustShownRef.current) {
                    // Defer to break the ResizeObserver loop: Allotment fires this
                    // callback synchronously from its own ResizeObserver during the
                    // panel show transition. Calling onPanelResize here would update
                    // sizes.panel → re-render → new preferredSize → another Allotment
                    // layout pass, triggering the browser's "loop" warning.
                    panelJustShownRef.current = false
                    requestAnimationFrame(() => {
                      if (panelVisibleRef.current) onPanelResizeRef.current(second)
                    })
                    return
                  }
                  onPanelResizeRef.current(second)
                }}
              >
                <Allotment.Pane visible={editorPaneVisible}>
                  <div className={styles['pane']}>{editor}</div>
                </Allotment.Pane>
                <Allotment.Pane
                  minSize={PANEL_MIN}
                  {...(editorPaneVisible ? { maxSize: PANEL_MAX } : {})}
                  preferredSize={sizes.panel}
                  visible={panelVisible}
                >
                  <div className={styles['pane']}>{panel}</div>
                </Allotment.Pane>
              </Allotment>
            </Allotment.Pane>
            <Allotment.Pane
              minSize={SIDEBAR_MIN}
              maxSize={SIDEBAR_MAX}
              preferredSize={sizes.secondarySidebar}
              visible={secondarySidebarVisible}
            >
              <div className={styles['pane']}>{secondarySidebar}</div>
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
      <div className={styles['statusbar']}>{statusbar}</div>
    </div>
  )
}
