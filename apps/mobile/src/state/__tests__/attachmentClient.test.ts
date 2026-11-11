import {
  MOBILE_ATTACHMENT_KIND_HEADER,
  MOBILE_ATTACHMENT_NAME_HEADER,
} from '@universe-editor/mobile-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  ATTACHMENT_UPLOAD_TIMEOUT_MS,
  AttachmentClient,
  httpOriginForSocketUrl,
} from '../attachmentClient.js'

afterEach(() => {
  vi.useRealTimers()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const uploadResult = {
  id: 'att-1',
  kind: 'image',
  name: '截图 1.png',
  mimeType: 'image/png',
  size: 3,
  createdAt: 1,
}

describe('httpOriginForSocketUrl', () => {
  it('maps websocket schemes onto http origins', () => {
    expect(httpOriginForSocketUrl('ws://pc.example.com:4310/ws')).toBe('http://pc.example.com:4310')
    expect(httpOriginForSocketUrl('wss://pc.example.com/ws')).toBe('https://pc.example.com')
  })
})

describe('AttachmentClient upload', () => {
  it('posts the raw file with auth, kind and encoded name headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(uploadResult))
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl,
    })
    const file = new File([new Uint8Array([1, 2, 3])], '截图 1.png', { type: 'image/png' })

    await expect(client.upload(file, 'image')).resolves.toEqual(uploadResult)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://pc.example.com/api/attachments',
      expect.objectContaining({
        method: 'POST',
        body: file,
        headers: {
          Authorization: 'Bearer tok-1',
          'Content-Type': 'image/png',
          [MOBILE_ATTACHMENT_KIND_HEADER]: 'image',
          [MOBILE_ATTACHMENT_NAME_HEADER]: encodeURIComponent('截图 1.png'),
        },
      }),
    )
  })

  it('falls back to octet-stream and a placeholder name', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse({ ...uploadResult, kind: 'file' }),
    )
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl,
    })
    await client.upload(new File([new Uint8Array(1)], '  ', { type: '' }), 'file')
    const init = fetchImpl.mock.calls[0]?.[1] as unknown as {
      headers: Record<string, string>
    }
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(init.headers[MOBILE_ATTACHMENT_NAME_HEADER]).toBe('attachment')
  })

  it('maps 401 to unauthorized and notifies the credential owner', async () => {
    const onUnauthorized = vi.fn()
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl: async () => jsonResponse({ code: 'unauthorized' }, 401),
      onUnauthorized,
    })
    await expect(
      client.upload(new File([new Uint8Array(1)], 'a.png'), 'image'),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('maps error bodies and bare HTTP statuses', async () => {
    const notFound = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl: async () => jsonResponse({ code: 'attachment_not_found' }, 404),
    })
    await expect(notFound.fetchBlob({ id: 'gone' })).rejects.toMatchObject({
      code: 'attachment_not_found',
    })

    const tooLarge = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl: async () => new Response('nope', { status: 413 }),
    })
    await expect(
      tooLarge.upload(new File([new Uint8Array(1)], 'big.bin'), 'file'),
    ).rejects.toMatchObject({ code: 'bad_request' })

    const internal = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl: async () => new Response('nope', { status: 500 }),
    })
    await expect(internal.fetchBlob({ id: 'x' })).rejects.toMatchObject({ code: 'internal' })
  })

  it('rejects malformed upload responses', async () => {
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl: async () => jsonResponse({ id: '' }),
    })
    await expect(
      client.upload(new File([new Uint8Array(1)], 'a.png'), 'image'),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('times out uploads and downloads through their abort controllers', async () => {
    vi.useFakeTimers()
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl: hangingFetch,
    })
    const upload = client
      .upload(new File([new Uint8Array(1)], 'a.png'), 'image')
      .catch((err) => err)
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_TIMEOUT_MS)
    await expect(upload).resolves.toMatchObject({ code: 'timeout' })

    const download = client.fetchBlob({ id: 'a1' }).catch((err) => err)
    await vi.advanceTimersByTimeAsync(ATTACHMENT_DOWNLOAD_TIMEOUT_MS)
    await expect(download).resolves.toMatchObject({ code: 'timeout' })
  })
})

describe('AttachmentClient download', () => {
  it('fetches a blob by encoded id and returns the response body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl,
    })
    const blob = await client.fetchBlob({ id: 'a b/1' })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://pc.example.com/api/attachments/${encodeURIComponent('a b/1')}`,
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok-1' },
      }),
    )
  })

  it('fetches session image bytes with the ref, message and index', async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(new Uint8Array([4, 5]), { headers: { 'content-type': 'image/png' } }),
    )
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl,
    })

    const blob = await client.fetchSessionImage(
      { windowId: 2, localId: 'local-1', durableId: 'durable-1' },
      'm1',
      3,
    )
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([4, 5]))
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    expect(url.pathname).toBe('/api/sessions/image')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      windowId: '2',
      localId: 'local-1',
      durableId: 'durable-1',
      message: 'm1',
      index: '3',
    })
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer tok-1' },
    })
  })

  it('fetches workspace image bytes without ever putting the token in the URL', async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(new Uint8Array([6]), { headers: { 'content-type': 'image/jpeg' } }),
    )
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl,
    })

    const blob = await client.fetchWorkspaceImage(
      { windowId: 1, localId: 'local-1' },
      'img/我的 图.jpg',
    )
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([6]))
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    expect(url.pathname).toBe('/api/sessions/file')
    expect(url.searchParams.get('path')).toBe('img/我的 图.jpg')
    expect(url.searchParams.get('localId')).toBe('local-1')
    expect(url.toString()).not.toContain('tok-1')
  })

  it('maps a missing session image to attachment_not_found', async () => {
    const client = new AttachmentClient({
      origin: 'http://pc.example.com',
      token: 'tok-1',
      fetchImpl: async () => new Response('', { status: 404 }),
    })
    await expect(
      client.fetchSessionImage({ windowId: 1, localId: 's1' }, 'm1', 0),
    ).rejects.toMatchObject({ code: 'attachment_not_found' })
  })
})
