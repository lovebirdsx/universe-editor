import type { MobileSideTaskSummary } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { commandErrorText, strings } from '../../strings.js'
import { SideTasksSheet } from '../SideTasksSheet.js'

const sideTaskRef = { windowId: 1, localId: 's2', durableId: 'durable-side-1' }

function row(overrides: Partial<MobileSideTaskSummary> = {}): MobileSideTaskSummary {
  return {
    id: 'durable-side-1',
    title: 'Side chat',
    lastUsedAt: Date.now(),
    live: true,
    ...overrides,
  }
}

function createClient(rows: readonly MobileSideTaskSummary[], nextRows = rows) {
  const listSideTasks = vi.fn().mockResolvedValueOnce(rows).mockResolvedValue(nextRows)
  const openSideTask = vi.fn(async () => ({ ref: sideTaskRef }))
  const deleteSideTask = vi.fn(async () => undefined)
  return { listSideTasks, openSideTask, deleteSideTask }
}

function renderSheet(client: ReturnType<typeof createClient>) {
  const onClose = vi.fn()
  const onOpen = vi.fn()
  const onNotice = vi.fn()
  render(
    <SideTasksSheet client={client} online onClose={onClose} onOpen={onOpen} onNotice={onNotice} />,
  )
  return { onClose, onOpen, onNotice }
}

describe('SideTasksSheet', () => {
  it('lists side tasks with the live badge and opens one', async () => {
    const client = createClient([row()])
    const { onOpen } = renderSheet(client)

    const item = await screen.findByTestId('side-task-row')
    expect(within(item).getByText('Side chat')).toBeTruthy()
    expect(screen.getByTestId('side-task-live')).toBeTruthy()

    fireEvent.click(screen.getByTestId('side-task-open'))
    await waitFor(() => expect(client.openSideTask).toHaveBeenCalledWith('durable-side-1'))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(sideTaskRef))
  })

  it('falls back to the untitled placeholder for a legacy row', async () => {
    renderSheet(createClient([row({ title: '' })]))

    const item = await screen.findByTestId('side-task-row')
    expect(within(item).getByText(strings.sideTaskUntitled)).toBeTruthy()
  })

  it('requires an inline confirmation before deleting, then reloads the list', async () => {
    const client = createClient([row()], [])
    renderSheet(client)

    await screen.findByTestId('side-task-row')
    fireEvent.click(screen.getByTestId('side-task-delete'))
    expect(client.deleteSideTask).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('side-task-delete-confirm'))
    await waitFor(() => expect(client.deleteSideTask).toHaveBeenCalledWith('durable-side-1'))
    await waitFor(() => expect(screen.getByTestId('side-task-empty')).toBeTruthy())
    expect(client.listSideTasks).toHaveBeenCalledTimes(2)
  })

  it('cancels an inline delete without calling the gateway', async () => {
    const client = createClient([row()])
    renderSheet(client)

    await screen.findByTestId('side-task-row')
    fireEvent.click(screen.getByTestId('side-task-delete'))
    fireEvent.click(screen.getByTestId('side-task-delete-cancel'))

    expect(screen.queryByTestId('side-task-delete-confirm')).toBeNull()
    expect(screen.getByTestId('side-task-delete')).toBeTruthy()
    expect(client.deleteSideTask).not.toHaveBeenCalled()
  })

  it('shows the empty state', async () => {
    const client = createClient([])
    renderSheet(client)
    await waitFor(() =>
      expect(screen.getByTestId('side-task-empty').textContent).toBe(strings.sideTasksEmpty),
    )
  })

  it('surfaces list failures', async () => {
    const client = createClient([])
    client.listSideTasks.mockReset()
    client.listSideTasks.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'unsupported_by_agent' }),
    )
    renderSheet(client)
    await waitFor(() =>
      expect(screen.getByTestId('side-tasks-error').textContent).toBe(
        commandErrorText('unsupported_by_agent'),
      ),
    )
  })

  it('reports open failures without leaving the sheet', async () => {
    const client = createClient([row()])
    client.openSideTask.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'session_not_found' }),
    )
    const { onNotice } = renderSheet(client)

    await screen.findByTestId('side-task-row')
    fireEvent.click(screen.getByTestId('side-task-open'))
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(commandErrorText('session_not_found')),
    )
  })
})
