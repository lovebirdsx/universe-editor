import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../UpdateBanner.js'
import { Store } from '../../state/store.js'
import type { WebBuildMismatch } from '../../webBuildId.js'

function createStore(): Store<WebBuildMismatch | undefined> {
  return new Store<WebBuildMismatch | undefined>(undefined)
}

describe('UpdateBanner', () => {
  it('stays hidden until the PC build differs from the loaded entry script', () => {
    const store = createStore()
    render(<UpdateBanner mismatchStore={store} onReload={vi.fn()} />)
    expect(screen.queryByTestId('update-banner')).toBeNull()

    act(() => {
      store.setState({ serverBuildId: 'index-new.js', clientBuildId: 'index-old.js' })
    })
    expect(screen.getByTestId('update-banner').textContent).toContain('PC 端已更新')
  })

  it('reloads on demand and remembers a dismissal per server build', () => {
    const store = createStore()
    const reload = vi.fn()
    render(<UpdateBanner mismatchStore={store} onReload={reload} />)

    act(() => {
      store.setState({ serverBuildId: 'index-new.js', clientBuildId: 'index-old.js' })
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(reload).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(screen.queryByTestId('update-banner')).toBeNull()

    act(() => {
      store.setState({ serverBuildId: 'index-newer.js', clientBuildId: 'index-old.js' })
    })
    expect(screen.getByTestId('update-banner')).toBeTruthy()
  })
})
