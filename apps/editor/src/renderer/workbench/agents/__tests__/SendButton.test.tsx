import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import type { ISettableObservable } from '@universe-editor/platform'
import type { AcpUsage, IAcpSession } from '../../../services/acp/acpSessionService.js'
import { SendButton } from '../SendButton.js'

afterEach(() => cleanup())

function makeSession(usage?: AcpUsage): {
  session: IAcpSession
  usageObs: ISettableObservable<AcpUsage | undefined>
} {
  const usageObs = observableValue<AcpUsage | undefined>('test.usage', usage)
  const session = { id: 's1', usage: usageObs } as unknown as IAcpSession
  return { session, usageObs }
}

describe('SendButton', () => {
  it('renders the send affordance when idle and triggers onSend', () => {
    const { session } = makeSession()
    const onSend = vi.fn()
    const onCancel = vi.fn()
    render(
      <SendButton
        session={session}
        running={false}
        disabled={false}
        onSend={onSend}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('acp-prompt-send'))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('is disabled and inert when idle with empty input', () => {
    const { session } = makeSession()
    const onSend = vi.fn()
    render(
      <SendButton session={session} running={false} disabled onSend={onSend} onCancel={vi.fn()} />,
    )
    const btn = screen.getByTestId('acp-prompt-send') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the stop affordance while running and triggers onCancel', () => {
    const { session } = makeSession()
    const onCancel = vi.fn()
    render(<SendButton session={session} running disabled onSend={vi.fn()} onCancel={onCancel} />)
    expect(screen.queryByTestId('acp-prompt-send')).toBeNull()
    const stop = screen.getByTestId('acp-prompt-cancel') as HTMLButtonElement
    expect(stop.disabled).toBe(false)
    fireEvent.click(stop)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders a usage progress arc and details when usage is reported', () => {
    const { session } = makeSession({ used: 50000, size: 100000 })
    render(
      <SendButton
        session={session}
        running={false}
        disabled={false}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId('acp-usage-progress')).toBeTruthy()
    expect(screen.getByTestId('acp-prompt-send').getAttribute('title')).toContain('50%')
  })

  it('omits the progress arc when no usage is reported', () => {
    const { session } = makeSession()
    render(
      <SendButton
        session={session}
        running={false}
        disabled={false}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('acp-usage-progress')).toBeNull()
  })

  it('reacts to usage updates after mount', () => {
    const { session, usageObs } = makeSession()
    render(
      <SendButton
        session={session}
        running={false}
        disabled={false}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('acp-usage-progress')).toBeNull()
    act(() => {
      usageObs.set({ used: 10, size: 100 }, undefined)
    })
    expect(screen.getByTestId('acp-usage-progress')).toBeTruthy()
  })
})
