import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ConnectivityDot } from '../ConnectivityDot.js'

describe('ConnectivityDot', () => {
  it('turns green when the probe reports the gateway reachable', async () => {
    const probe = vi.fn(async () => true)
    const { findByRole } = render(<ConnectivityDot baseUrl="http://gw:9080" probe={probe} />)

    await findByRole('img', { name: 'Gateway reachable' })
    expect(probe).toHaveBeenCalledWith('http://gw:9080')
  })

  it('stays gray when the probe reports the gateway unreachable', async () => {
    const probe = vi.fn(async () => false)
    const { findByRole } = render(<ConnectivityDot baseUrl="http://gw:9080" probe={probe} />)

    await findByRole('img', { name: 'Gateway unreachable' })
  })

  it('stays gray when the probe rejects', async () => {
    const probe = vi.fn(async () => {
      throw new Error('ipc down')
    })
    const { findByRole } = render(<ConnectivityDot baseUrl="http://gw:9080" probe={probe} />)

    await findByRole('img', { name: 'Gateway unreachable' })
  })

  it('re-probes when the base URL changes', async () => {
    const probe = vi.fn(async (url: string) => url.endsWith(':1'))
    const { rerender, findByRole } = render(<ConnectivityDot baseUrl="http://gw:1" probe={probe} />)
    await findByRole('img', { name: 'Gateway reachable' })

    rerender(<ConnectivityDot baseUrl="http://gw:2" probe={probe} />)
    await findByRole('img', { name: 'Gateway unreachable' })
  })

  it('renders an inert placeholder for non-gateway credentials and never probes', async () => {
    const probe = vi.fn(async () => true)
    const { container } = render(<ConnectivityDot baseUrl={undefined} probe={probe} />)

    await waitFor(() => expect(probe).not.toHaveBeenCalled())
    expect(container.querySelector('[role="img"]')).toBeNull()
  })
})
