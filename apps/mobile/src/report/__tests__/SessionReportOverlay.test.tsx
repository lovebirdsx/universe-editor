import type { MobileTriggerAutomationSummary } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandError } from '../../state/commandClient.js'
import { SessionReportOverlay, type SessionReportOverlayProps } from '../SessionReportOverlay.js'

const automation: MobileTriggerAutomationSummary = { triggerName: 'Nightly review' }

function renderOverlay(overrides: Partial<SessionReportOverlayProps> = {}) {
  const fetchSessionReport = vi.fn(async () => '# 报告\n\n- one\n- two')
  const onClose = vi.fn()
  render(
    <SessionReportOverlay
      client={{ fetchSessionReport }}
      sessionRef={{ windowId: 7, localId: 'local-1', durableId: 'durable-1' }}
      automation={automation}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { fetchSessionReport, onClose }
}

describe('SessionReportOverlay', () => {
  it('shows a loading state, then renders the markdown report', async () => {
    let resolveText!: (text: string) => void
    const fetchSessionReport = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveText = resolve
        }),
    )
    renderOverlay({ client: { fetchSessionReport } })

    expect(screen.getByTestId('session-report-loading')).toBeTruthy()
    expect(fetchSessionReport).toHaveBeenCalledWith({
      windowId: 7,
      localId: 'local-1',
      durableId: 'durable-1',
    })

    resolveText('# 标题\n\n- 一项\n- 两项\n\n```ts\nconst a = 1\n```')
    const markdown = await screen.findByTestId('session-report-markdown')
    expect(within(markdown).getByRole('heading', { level: 1 }).textContent).toBe('标题')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '一项',
      '两项',
    ])
    expect(markdown.querySelector('pre code')?.textContent).toBe('const a = 1')
  })

  it('renders an empty state for a blank report', async () => {
    renderOverlay({ client: { fetchSessionReport: vi.fn(async () => '   \n') } })
    await waitFor(() => expect(screen.getByTestId('session-report-empty')).toBeTruthy())
  })

  it('treats a missing report without an outcome as still running', async () => {
    renderOverlay({
      client: {
        fetchSessionReport: vi.fn(async () => {
          throw new CommandError('attachment_not_found', 'report is not available')
        }),
      },
    })
    await waitFor(() => expect(screen.getByTestId('session-report-running')).toBeTruthy())
    expect(screen.getByTestId('session-report-retry')).toBeTruthy()
  })

  it('treats a missing report with an outcome as missing or cleaned up', async () => {
    renderOverlay({
      automation: { triggerName: 'Nightly review', outcome: 'completed' },
      client: {
        fetchSessionReport: vi.fn(async () => {
          throw new CommandError('attachment_not_found', 'report is not available')
        }),
      },
    })
    await waitFor(() => expect(screen.getByTestId('session-report-missing')).toBeTruthy())
  })

  it('renders a size-limit state when the gateway answers 413', async () => {
    renderOverlay({
      client: {
        fetchSessionReport: vi.fn(async () => {
          throw new CommandError('bad_request', 'report is too large')
        }),
      },
    })
    await waitFor(() => expect(screen.getByTestId('session-report-too-large')).toBeTruthy())
  })

  it('renders a failure state and refetches on retry', async () => {
    let calls = 0
    const fetchSessionReport = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new CommandError('network', 'offline')
      return '# 已恢复'
    })
    renderOverlay({ client: { fetchSessionReport } })

    await waitFor(() => expect(screen.getByTestId('session-report-error')).toBeTruthy())
    fireEvent.click(screen.getByTestId('session-report-retry'))
    await waitFor(() => expect(screen.getByTestId('session-report-markdown')).toBeTruthy())
    expect(
      within(screen.getByTestId('session-report-markdown')).getByRole('heading', { level: 1 })
        .textContent,
    ).toBe('已恢复')
    expect(fetchSessionReport).toHaveBeenCalledTimes(2)
  })

  it('never injects raw HTML or script links from the report', async () => {
    renderOverlay({
      client: {
        fetchSessionReport: vi.fn(
          async () =>
            '<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1))',
        ),
      },
    })
    const markdown = await screen.findByTestId('session-report-markdown')
    expect(markdown.querySelector('img')).toBeNull()
    expect(markdown.querySelector('script')).toBeNull()
    expect(markdown.querySelector('a')).toBeNull()
    expect(markdown.textContent).toContain('<script>alert(1)</script>')
    expect(markdown.textContent).toContain('[click](javascript:alert(1))')
  })

  it('closes on Escape and on the close button, restoring focus on unmount', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const fetchSessionReport = vi.fn(async () => '# 报告')
    const onClose = vi.fn()
    const { unmount } = render(
      <SessionReportOverlay
        client={{ fetchSessionReport }}
        sessionRef={{ windowId: 1, localId: 'local-1' }}
        automation={automation}
        onClose={onClose}
      />,
    )

    expect(document.activeElement).toBe(screen.getByTestId('session-report-close'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('session-report-close'))
    expect(onClose).toHaveBeenCalledTimes(2)

    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
