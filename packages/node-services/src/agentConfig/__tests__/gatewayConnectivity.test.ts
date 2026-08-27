import { describe, expect, it, vi } from 'vitest'
import { probeGatewayConnectivity } from '../gatewayConnectivity.js'

function fakeResponse() {
  return { body: { cancel: vi.fn(async () => undefined) } }
}

describe('probeGatewayConnectivity', () => {
  it('resolves true when the server answers with any HTTP status', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse())
    await expect(probeGatewayConnectivity('http://192.0.2.30:9080', fetchImpl)).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('resolves false on network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    await expect(probeGatewayConnectivity('http://192.0.2.30:9080', fetchImpl)).resolves.toBe(false)
  })

  it('resolves false when the probe times out', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    })
    await expect(probeGatewayConnectivity('http://192.0.2.30:9080', fetchImpl)).resolves.toBe(false)
  })

  it('tolerates a null body', async () => {
    const fetchImpl = vi.fn(async () => ({ body: null }))
    await expect(probeGatewayConnectivity('http://192.0.2.30:9080', fetchImpl)).resolves.toBe(true)
  })
})
