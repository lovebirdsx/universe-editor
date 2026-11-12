import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { strings } from '../../strings.js'
import { SubagentModelSheet } from '../SubagentModelSheet.js'

const settings = {
  supported: true,
  current: 'sonnet',
  candidates: ['sonnet', 'opus'],
}

function valueButtons(): HTMLElement[] {
  return screen.getAllByTestId('subagent-value')
}

describe('SubagentModelSheet', () => {
  it('lists inherit plus the candidates and marks the current value', () => {
    render(
      <SubagentModelSheet
        client={{ setSubagentModel: vi.fn(), restartAgentProcess: vi.fn() }}
        settings={settings}
        running={false}
        online
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    const values = valueButtons()
    expect(values.map((value) => value.getAttribute('data-value'))).toEqual([
      'inherit',
      'sonnet',
      'opus',
    ])
    expect(values[1]?.getAttribute('data-current')).toBe('true')
    expect(values[0]?.textContent).toContain(strings.subagentInherit)
  })

  it('closes without writing when the current value is picked', () => {
    const setSubagentModel = vi.fn(async () => undefined)
    const onClose = vi.fn()
    render(
      <SubagentModelSheet
        client={{ setSubagentModel, restartAgentProcess: vi.fn() }}
        settings={settings}
        running={false}
        online
        onChanged={vi.fn()}
        onClose={onClose}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(valueButtons()[1]!)
    expect(onClose).toHaveBeenCalled()
    expect(setSubagentModel).not.toHaveBeenCalled()
  })

  it('saves a new model and offers an immediate restart', async () => {
    const setSubagentModel = vi.fn(async () => undefined)
    const onChanged = vi.fn()
    render(
      <SubagentModelSheet
        client={{ setSubagentModel, restartAgentProcess: vi.fn() }}
        settings={settings}
        running={false}
        online
        onChanged={onChanged}
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('subagent-restart')).toBeNull()
    fireEvent.click(valueButtons()[2]!)
    await waitFor(() => expect(setSubagentModel).toHaveBeenCalledWith('opus'))
    expect(onChanged).toHaveBeenCalledWith('opus')
    expect(await screen.findByTestId('subagent-restart')).toBeTruthy()
  })

  it('saves the inherit sentinel', async () => {
    const setSubagentModel = vi.fn(async () => undefined)
    const onChanged = vi.fn()
    render(
      <SubagentModelSheet
        client={{ setSubagentModel, restartAgentProcess: vi.fn() }}
        settings={settings}
        running={false}
        online
        onChanged={onChanged}
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(valueButtons()[0]!)
    await waitFor(() => expect(setSubagentModel).toHaveBeenCalledWith(null))
    expect(onChanged).toHaveBeenCalledWith(null)
  })

  it('restarts directly when the session is idle', async () => {
    const restartAgentProcess = vi.fn(async () => undefined)
    const onNotice = vi.fn()
    const onClose = vi.fn()
    render(
      <SubagentModelSheet
        client={{ setSubagentModel: vi.fn(async () => undefined), restartAgentProcess }}
        settings={settings}
        running={false}
        online
        onChanged={vi.fn()}
        onClose={onClose}
        onNotice={onNotice}
      />,
    )

    fireEvent.click(valueButtons()[2]!)
    fireEvent.click(await screen.findByTestId('subagent-restart'))
    await waitFor(() => expect(restartAgentProcess).toHaveBeenCalledTimes(1))
    expect(onNotice).toHaveBeenCalledWith(strings.subagentRestarting)
    expect(onClose).toHaveBeenCalled()
  })

  it('confirms before restarting a running session', async () => {
    const restartAgentProcess = vi.fn(async () => undefined)
    render(
      <SubagentModelSheet
        client={{ setSubagentModel: vi.fn(async () => undefined), restartAgentProcess }}
        settings={settings}
        running
        online
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(valueButtons()[2]!)
    fireEvent.click(await screen.findByTestId('subagent-restart'))
    expect(restartAgentProcess).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId('subagent-restart-confirm-confirm'))
    await waitFor(() => expect(restartAgentProcess).toHaveBeenCalledTimes(1))
  })

  it('reports a failed write without showing the restart hint', async () => {
    const onNotice = vi.fn()
    render(
      <SubagentModelSheet
        client={{
          setSubagentModel: vi.fn(async () => {
            throw Object.assign(new Error('nope'), { code: 'forbidden_operation' })
          }),
          restartAgentProcess: vi.fn(),
        }}
        settings={settings}
        running={false}
        online
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onNotice={onNotice}
      />,
    )

    fireEvent.click(valueButtons()[2]!)
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('不允许')))
    expect(screen.queryByTestId('subagent-restart')).toBeNull()
  })

  it('disables every value while offline', () => {
    render(
      <SubagentModelSheet
        client={{ setSubagentModel: vi.fn(), restartAgentProcess: vi.fn() }}
        settings={settings}
        running={false}
        online={false}
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    for (const value of valueButtons()) {
      expect((value as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText(strings.pendingOffline)).toBeTruthy()
  })
})
