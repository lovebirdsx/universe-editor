/*---------------------------------------------------------------------------------------------
 *  `ue-file:` protocol: a missing backing file must answer 404 instead of
 *  letting `net.fetch` reject (Electron logs net::ERR_FILE_NOT_FOUND at ERROR
 *  level, which points users at an app failure for an expected user state).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
}))

const { net, protocol } = await import('electron')
const { installImageProtocol } = await import('../imageProtocol.js')
const { IMAGE_PROTOCOL_SCHEME } = await import('../../../shared/imageResource.js')

type ProtocolHandler = (request: { url: string }) => Promise<Response>

function installedHandler(): ProtocolHandler {
  const call = vi.mocked(protocol.handle).mock.calls.at(-1)
  if (!call) throw new Error('protocol handler was not installed')
  return call[1] as unknown as ProtocolHandler
}

describe('ue-file protocol', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('streams the mapped file URL through net.fetch', async () => {
    const response = new Response('image-bytes', { status: 200 })
    vi.mocked(net.fetch).mockResolvedValue(response)

    installImageProtocol()

    expect(protocol.handle).toHaveBeenCalledWith(IMAGE_PROTOCOL_SCHEME, expect.any(Function))
    const result = await installedHandler()({ url: 'ue-file://local/C:/pics/cat.png' })

    expect(net.fetch).toHaveBeenCalledWith('file:///C:/pics/cat.png')
    expect(result).toBe(response)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('answers 404 and warns when the backing file cannot be read', async () => {
    vi.mocked(net.fetch).mockRejectedValue(new Error('net::ERR_FILE_NOT_FOUND'))

    installImageProtocol()
    const result = await installedHandler()({ url: 'ue-file://local/C:/gone.png' })

    expect(result.status).toBe(404)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('file:///C:/gone.png'))
  })
})
