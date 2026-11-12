import type { MobileConfigOption } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfigSheet } from '../ConfigSheet.js'

const modeOption: MobileConfigOption = {
  id: 'mode',
  name: 'Mode',
  type: 'select',
  currentValue: 'Default',
  options: [
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'bypassPermissions', label: 'Bypass permissions' },
  ],
}

describe('ConfigSheet', () => {
  it('offers every value including bypass', async () => {
    const setConfigOption = vi.fn(async () => undefined)
    render(
      <ConfigSheet
        client={{ setConfigOption }}
        option={modeOption}
        online
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    const values = screen.getAllByTestId('config-value')
    expect(values).toHaveLength(3)
    const bypass = values.find((value) => value.getAttribute('data-value') === 'bypassPermissions')!
    expect((bypass as HTMLButtonElement).disabled).toBe(false)
    expect(values[0]?.getAttribute('data-current')).toBe('true')

    fireEvent.click(bypass)
    await waitFor(() => expect(setConfigOption).toHaveBeenCalledWith('mode', 'bypassPermissions'))
  })

  it('submits the chosen value and closes', async () => {
    const setConfigOption = vi.fn(async () => undefined)
    const onClose = vi.fn()
    render(
      <ConfigSheet
        client={{ setConfigOption }}
        option={modeOption}
        online
        onClose={onClose}
        onNotice={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('Accept edits'))
    await waitFor(() => expect(setConfigOption).toHaveBeenCalledWith('mode', 'acceptEdits'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('reports failures without closing', async () => {
    const onClose = vi.fn()
    const onNotice = vi.fn()
    render(
      <ConfigSheet
        client={{
          setConfigOption: vi.fn(async () => {
            throw Object.assign(new Error('nope'), { code: 'forbidden_operation' })
          }),
        }}
        option={modeOption}
        online
        onClose={onClose}
        onNotice={onNotice}
      />,
    )

    fireEvent.click(screen.getByText('Accept edits'))
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('不允许')))
    expect(onClose).not.toHaveBeenCalled()
  })
})
