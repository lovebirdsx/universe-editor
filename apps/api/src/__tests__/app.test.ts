import { describe, it, expect } from 'vitest'
import { app } from '../app.js'

describe('GET /', () => {
  it('returns 200 with message and demo prices', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      message: string
      demo: { price_usd: string; price_eur: string }
      timestamp: string
    }
    expect(body.demo.price_usd).toBe('$49.99')
    expect(body.demo.price_eur).toBe('€129.00')
    expect(typeof body.timestamp).toBe('string')
  })
})

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })
})

describe('unknown routes', () => {
  it('returns 404 for unregistered paths', async () => {
    const res = await app.request('/not-found')
    expect(res.status).toBe(404)
  })
})
