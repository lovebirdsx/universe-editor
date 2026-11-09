import type { MobilePendingPermission } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import {
  FEEDBACK_MAX_HEIGHT_PX,
  PermissionSheet,
  type PermissionCommandClient,
} from '../PermissionSheet.js'

function createClient() {
  return {
    resolvePermission: vi.fn(
      async (_requestId: string, _optionId: string, _feedback?: string): Promise<void> => undefined,
    ),
    cancelPermission: vi.fn(async () => undefined),
    pauseAutoResolve: vi.fn(async () => undefined),
    resumeAutoResolve: vi.fn(async () => undefined),
    refreshSession: vi.fn(),
    serverNow: vi.fn(() => 1_000),
  } satisfies PermissionCommandClient
}

function permission(overrides: Partial<MobilePendingPermission> = {}): MobilePendingPermission {
  return {
    requestId: 'req-1',
    toolCallId: 't1',
    title: 'Run the command',
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once', allowedOnMobile: true },
      {
        optionId: 'allow-with-updates',
        name: 'Yes, and allow access',
        kind: 'allow_always',
        allowedOnMobile: false,
      },
      { optionId: 'reject', name: 'No', kind: 'reject_once', allowedOnMobile: true },
    ],
    ...overrides,
  }
}

describe('PermissionSheet', () => {
  it('hides mobile-forbidden options and explains why', () => {
    render(
      <PermissionSheet
        client={createClient()}
        permission={permission()}
        online
        onNotice={vi.fn()}
      />,
    )

    expect(screen.getAllByTestId('permission-option')).toHaveLength(2)
    expect(screen.queryByText('Yes, and allow access')).toBeNull()
    expect(screen.getByText(strings.pendingHiddenOptions)).toBeTruthy()
  })

  it('shows a loading state and submits the tapped option', async () => {
    const client = createClient()
    client.resolvePermission.mockImplementation(() => new Promise<void>(() => undefined))
    render(<PermissionSheet client={client} permission={permission()} online onNotice={vi.fn()} />)

    const allow = screen.getAllByTestId('permission-option')[0]!
    fireEvent.click(allow)
    expect(client.resolvePermission).toHaveBeenCalledWith('req-1', 'allow-once')
    // The sheet keeps waiting for `permission_cleared` (or the 3s fallback).
    await waitFor(() => expect(screen.getByText(strings.pendingSubmitting)).toBeTruthy())
  })

  it('renders the countdown ring and pauses / resumes auto-execution', async () => {
    const client = createClient()
    const pending = permission({
      autoResolve: { optionId: 'reject', deadlineAt: 11_000, paused: false },
    })
    const view = render(
      <PermissionSheet client={client} permission={pending} online onNotice={vi.fn()} />,
    )

    expect(screen.getByTestId('auto-resolve')).toBeTruthy()
    expect(screen.getByText(strings.pendingAutoExecuting(10))).toBeTruthy()

    fireEvent.click(screen.getByTestId('auto-resolve-toggle'))
    await waitFor(() => expect(client.pauseAutoResolve).toHaveBeenCalledWith('req-1'))

    view.rerender(
      <PermissionSheet
        client={client}
        permission={permission({
          autoResolve: { optionId: 'reject', deadlineAt: 11_000, paused: true },
        })}
        online
        onNotice={vi.fn()}
      />,
    )
    expect(screen.getByText(strings.pendingAutoPaused)).toBeTruthy()
    fireEvent.click(screen.getByTestId('auto-resolve-toggle'))
    await waitFor(() => expect(client.resumeAutoResolve).toHaveBeenCalledWith('req-1'))
  })

  it('offers a feedback box for Claude-style plan review and sends it with the rejection', async () => {
    const client = createClient()
    render(
      <PermissionSheet
        client={client}
        permission={permission({ kind: 'switch_mode' })}
        online
        onNotice={vi.fn()}
      />,
    )

    const input = screen.getByTestId('permission-feedback')
    fireEvent.change(input, { target: { value: '先补测试' } })
    fireEvent.click(screen.getByTestId('permission-feedback-submit'))

    await waitFor(() =>
      expect(client.resolvePermission).toHaveBeenCalledWith('req-1', 'reject', '先补测试'),
    )
  })

  it('grows the feedback box with the content and stops at six lines', () => {
    render(
      <PermissionSheet
        client={createClient()}
        permission={permission({ kind: 'switch_mode' })}
        online
        onNotice={vi.fn()}
      />,
    )

    const input = screen.getByTestId('permission-feedback') as HTMLTextAreaElement
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 400 })
    fireEvent.change(input, { target: { value: 'one\ntwo\nthree\nfour' } })
    expect(input.style.height).toBe(`${FEEDBACK_MAX_HEIGHT_PX}px`)
  })

  it('does not render feedback for codex plan review (implement_plan contract)', () => {
    render(
      <PermissionSheet
        client={createClient()}
        permission={permission({
          kind: 'switch_mode',
          options: [
            {
              optionId: 'implement_plan',
              name: 'Implement',
              kind: 'allow_once',
              allowedOnMobile: true,
            },
            { optionId: 'reject', name: 'No', kind: 'reject_once', allowedOnMobile: true },
          ],
        })}
        online
        onNotice={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('permission-feedback')).toBeNull()
  })

  it('disables actions while offline', () => {
    render(
      <PermissionSheet
        client={createClient()}
        permission={permission()}
        online={false}
        onNotice={vi.fn()}
      />,
    )

    expect(screen.getByText(strings.pendingOffline)).toBeTruthy()
    for (const button of screen.getAllByTestId('permission-option')) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
