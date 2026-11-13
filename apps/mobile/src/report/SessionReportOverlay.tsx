import type {
  MobileSessionRef,
  MobileTriggerAutomationSummary,
} from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Spinner } from '../components/Spinner.js'
import { useDocumentScrollLock } from '../components/useDocumentScrollLock.js'
import { errorCode } from '../errors.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import type { MobileClient } from '../state/mobileClient.js'
import { strings } from '../strings.js'

type ReportState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly text: string }
  | { readonly status: 'empty' }
  | { readonly status: 'running' }
  | { readonly status: 'missing' }
  | { readonly status: 'too-large' }
  | { readonly status: 'error' }

export interface SessionReportOverlayProps {
  readonly client: Pick<MobileClient, 'fetchSessionReport'>
  readonly sessionRef: MobileSessionRef
  readonly automation: MobileTriggerAutomationSummary
  readonly onClose: () => void
}

/**
 * Full-screen reader for a trigger run's report.md. The content is untrusted:
 * MarkdownView renders an AST and never emits raw HTML or executes scripts.
 */
export function SessionReportOverlay({
  client,
  sessionRef,
  automation,
  onClose,
}: SessionReportOverlayProps) {
  useDocumentScrollLock(true)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ReportState>({ status: 'loading' })
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const previousFocus = useRef<Element | null>(null)
  const { windowId, localId, durableId } = sessionRef

  useEffect(() => {
    previousFocus.current = document.activeElement
    closeButton.current?.focus()
    return () => {
      const target = previousFocus.current
      if (target instanceof HTMLElement) target.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void client
      .fetchSessionReport({
        windowId,
        localId,
        ...(durableId !== undefined ? { durableId } : {}),
      })
      .then((text) => {
        if (cancelled) return
        setState(text.trim() === '' ? { status: 'empty' } : { status: 'ready', text })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const code = errorCode(err)
        if (code === 'attachment_not_found') {
          setState(automation.outcome === undefined ? { status: 'running' } : { status: 'missing' })
          return
        }
        setState(code === 'bad_request' ? { status: 'too-large' } : { status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [attempt, automation.outcome, client, durableId, localId, windowId])

  const canRefresh =
    state.status === 'running' || state.status === 'missing' || state.status === 'error'

  return createPortal(
    <div
      className="report-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={strings.sessionReportTitle}
      data-testid="session-report-overlay"
    >
      <header className="report-overlay__header">
        <div className="report-overlay__heading">
          <h1 className="report-overlay__title">{strings.sessionReportTitle}</h1>
          <p className="report-overlay__trigger">{`⚡ ${automation.triggerName}`}</p>
        </div>
        <div className="report-overlay__actions">
          {canRefresh && (
            <button
              type="button"
              className="text-button"
              data-testid="session-report-retry"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {strings.sessionReportRefresh}
            </button>
          )}
          <button
            ref={closeButton}
            type="button"
            className="report-overlay__close"
            aria-label={strings.sessionReportClose}
            data-testid="session-report-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>
      <div className="report-overlay__body">{renderState(state)}</div>
    </div>,
    document.body,
  )
}

function renderState(state: ReportState) {
  switch (state.status) {
    case 'loading':
      return (
        <div className="state-card state-card--row" data-testid="session-report-loading">
          <Spinner />
          <p>{strings.sessionReportLoading}</p>
        </div>
      )
    case 'ready':
      return <MarkdownView text={state.text} testId="session-report-markdown" />
    case 'empty':
      return (
        <div className="state-card" data-testid="session-report-empty">
          <p>{strings.sessionReportEmpty}</p>
        </div>
      )
    case 'running':
      return (
        <div className="state-card" data-testid="session-report-running">
          <p>{strings.sessionReportRunning}</p>
        </div>
      )
    case 'missing':
      return (
        <div className="state-card" data-testid="session-report-missing">
          <p>{strings.sessionReportUnavailable}</p>
        </div>
      )
    case 'too-large':
      return (
        <div className="state-card" data-testid="session-report-too-large">
          <p>{strings.sessionReportTooLarge}</p>
        </div>
      )
    case 'error':
      return (
        <div className="state-card" data-testid="session-report-error">
          <p>{strings.sessionReportFailed}</p>
        </div>
      )
  }
}
