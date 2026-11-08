import { useEffect, useRef, useState, type ReactNode } from 'react'
import { strings } from '../strings.js'

export interface BottomSheetProps {
  readonly title: string
  readonly icon?: string | undefined
  readonly testId: string
  readonly tone?: 'warning' | 'neutral' | undefined
  readonly defaultCollapsed?: boolean | undefined
  /** Changing this key re-expands the sheet (e.g. a new request or a focus navigation). */
  readonly expandKey?: string | number | undefined
  /** Render as a modal overlay instead of an inline footer sheet. */
  readonly overlay?: boolean | undefined
  readonly onDismiss?: (() => void) | undefined
  readonly children: ReactNode
  readonly footer?: ReactNode | undefined
}

const COLLAPSE_DRAG_PX = 36

/**
 * Footer sheet that never overlays the timeline (it is a flex sibling of the
 * scroll area). Dragging the handle down — or tapping it — collapses the sheet
 * into a one-line reminder while leaving the request pending.
 */
export function BottomSheet({
  title,
  icon,
  testId,
  tone = 'warning',
  defaultCollapsed = false,
  expandKey,
  overlay = false,
  onDismiss,
  children,
  footer,
}: BottomSheetProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const dragStart = useRef<number | undefined>(undefined)

  useEffect(() => {
    setCollapsed(false)
  }, [expandKey])

  useEffect(() => {
    if (!overlay || onDismiss === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [overlay, onDismiss])

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    dragStart.current = event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const start = dragStart.current
    if (start === undefined) return
    if (event.clientY - start >= COLLAPSE_DRAG_PX) {
      dragStart.current = undefined
      setCollapsed(true)
    }
  }

  const onPointerUp = (): void => {
    dragStart.current = undefined
  }

  return (
    <div
      className={overlay ? 'sheet-backdrop' : 'sheet-slot'}
      data-testid={overlay ? `${testId}-backdrop` : undefined}
      onClick={
        overlay
          ? (event) => {
              if (event.target === event.currentTarget) onDismiss?.()
            }
          : undefined
      }
    >
      <section
        className={`sheet sheet--${tone}${overlay ? ' sheet--overlay' : ''}${
          collapsed ? ' sheet--collapsed' : ''
        }`}
        data-testid={testId}
        aria-label={title}
        role={overlay ? 'dialog' : undefined}
        aria-modal={overlay ? true : undefined}
      >
        <button
          type="button"
          className="sheet__handle"
          aria-label={collapsed ? strings.sheetExpand : strings.sheetCollapse}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="sheet__grabber" aria-hidden="true" />
        </button>
        {collapsed ? (
          <button
            type="button"
            className="sheet__collapsed"
            onClick={() => setCollapsed(false)}
            data-testid={`${testId}-collapsed`}
          >
            {icon !== undefined && (
              <span className="sheet__icon" aria-hidden="true">
                {icon}
              </span>
            )}
            <span className="sheet__collapsed-title">{title}</span>
            <span className="sheet__chevron" aria-hidden="true">
              ⌃
            </span>
          </button>
        ) : (
          <div className="sheet__body">
            <header className="sheet__header">
              {icon !== undefined && (
                <span className="sheet__icon" aria-hidden="true">
                  {icon}
                </span>
              )}
              <h2 className="sheet__title">{title}</h2>
            </header>
            <div className="sheet__content">{children}</div>
            {footer !== undefined && <footer className="sheet__footer">{footer}</footer>}
          </div>
        )}
      </section>
    </div>
  )
}
