import { describe, it, expect, vi } from 'vitest'
import { createGalleryClient } from '../lib/httpClient.js'
import { UexError } from '../errors.js'

function mockFetch(status: number, body: unknown = '') {
  return vi.fn(async () => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, {
      status,
      headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    })
  }) as unknown as typeof fetch
}

const OPTS = { baseUrl: 'https://m.example.com', token: 'uet_x' }

describe('createGalleryClient.publish', () => {
  it('POSTs the raw VSIX with Bearer auth and octet-stream', async () => {
    const fetchImpl = mockFetch(201, { id: 'acme.demo', version: '1.0.0' })
    const vsix = Buffer.from('zip-bytes')
    const result = await createGalleryClient({ ...OPTS, fetchImpl }).publish(vsix)
    expect(result).toEqual({ id: 'acme.demo', version: '1.0.0' })

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toBe('https://m.example.com/gallery/api/publish')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer uet_x')
    expect(headers['Content-Type']).toBe('application/octet-stream')
    expect(headers['Content-Length']).toBe(String(vsix.byteLength))
  })

  it.each([
    [401, 'uex login'],
    [403, 'publisher'],
    [409, 'bump'],
    [413, 'whitelist'],
  ] as const)('maps %d to a UexError with an action hint', async (status, hintText) => {
    const fetchImpl = mockFetch(status, 'server says no')
    const err = await createGalleryClient({ ...OPTS, fetchImpl })
      .publish(Buffer.from('x'))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UexError)
    expect((err as UexError).hints.join(' ')).toContain(hintText)
  })

  it('points 401s at the self-serve register page', async () => {
    const fetchImpl = mockFetch(401)
    const err = await createGalleryClient({ ...OPTS, fetchImpl })
      .publish(Buffer.from('x'))
      .catch((e: unknown) => e)
    expect((err as UexError).hints.join(' ')).toContain('https://m.example.com/gallery/register')
  })

  it('maps a 403 pending-approval body to approval guidance (server message passes through)', async () => {
    const fetchImpl = mockFetch(
      403,
      'publisher "acme" is pending approval — publishing is enabled after an admin approves the registration',
    )
    const err = await createGalleryClient({ ...OPTS, fetchImpl })
      .publish(Buffer.from('x'))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UexError)
    expect((err as UexError).message).toContain('pending approval')
    expect((err as UexError).message).toContain('after an admin approves')
    expect((err as UexError).hints.join(' ')).toContain('uex whoami')
  })

  it('maps connection failures to a registry-config hint', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const err = await createGalleryClient({ ...OPTS, fetchImpl })
      .publish(Buffer.from('x'))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UexError)
    expect((err as UexError).message).toContain('could not reach')
  })
})

describe('createGalleryClient.unpublish', () => {
  it('POSTs {id, version} JSON', async () => {
    const fetchImpl = mockFetch(200, '{}')
    await createGalleryClient({ ...OPTS, fetchImpl }).unpublish('acme.demo', null)
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      id: 'acme.demo',
      version: null,
    })
  })
})

describe('createGalleryClient.whoami', () => {
  it('GETs the token’s publisher', async () => {
    const fetchImpl = mockFetch(200, { publisher: 'acme' })
    await expect(createGalleryClient({ ...OPTS, fetchImpl }).whoami()).resolves.toEqual({
      publisher: 'acme',
    })
  })

  it('passes the approval status through', async () => {
    const fetchImpl = mockFetch(200, { publisher: 'acme', status: 'pending' })
    await expect(createGalleryClient({ ...OPTS, fetchImpl }).whoami()).resolves.toEqual({
      publisher: 'acme',
      status: 'pending',
    })
  })
})
