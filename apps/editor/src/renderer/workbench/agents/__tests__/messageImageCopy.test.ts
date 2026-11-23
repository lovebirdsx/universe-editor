/*---------------------------------------------------------------------------------------------
 *  Orchestration: expand → wait → clamp release → capture → clipboard, with
 *  restoration guaranteed on every exit path.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MessageImageTooLargeError,
  MessageImageUnavailableError,
  renderMessageImage,
} from '../messageImage.js'
import { expandCollapsedUserBodies, waitForSlotBody } from '../slotCaptureTarget.js'
import { copyMessageAsImage } from '../messageImageCopy.js'

vi.mock('../messageImage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../messageImage.js')>()
  return { ...actual, renderMessageImage: vi.fn() }
})

vi.mock('../slotCaptureTarget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slotCaptureTarget.js')>()
  return {
    ...actual,
    waitForSlotBody: vi.fn(),
    expandCollapsedUserBodies: vi.fn(),
  }
})

vi.mock('../../../services/acp/promptImage.js', () => ({
  blobToBase64: vi.fn(async () => 'BASE64'),
}))

const renderMock = vi.mocked(renderMessageImage)
const waitMock = vi.mocked(waitForSlotBody)
const clampMock = vi.mocked(expandCollapsedUserBodies)

afterEach(() => {
  vi.clearAllMocks()
})

function setup(options: { body?: HTMLElement | undefined } = {}) {
  const body = options.body ?? document.createElement('div')
  waitMock.mockResolvedValue(body)
  clampMock.mockReturnValue(vi.fn())
  renderMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
  const restoreCollapse = vi.fn()
  const writeImage = vi.fn(async () => {})
  const expandSlotTemporarily = vi.fn(() => restoreCollapse)
  return { body, restoreCollapse, writeImage, expandSlotTemporarily }
}

describe('copyMessageAsImage', () => {
  it('writes the captured PNG and restores both expand states', async () => {
    const { body, restoreCollapse, writeImage, expandSlotTemporarily } = setup()
    const restoreClamp = vi.fn()
    clampMock.mockReturnValue(restoreClamp)

    const result = await copyMessageAsImage({
      container: document.createElement('div'),
      slotKey: 'm:a',
      expandSlotTemporarily,
      writeImage,
    })

    expect(result).toEqual({ kind: 'ok' })
    expect(expandSlotTemporarily).toHaveBeenCalledWith('m:a')
    expect(clampMock).toHaveBeenCalledWith(body)
    expect(writeImage).toHaveBeenCalledWith('BASE64')
    expect(restoreClamp).toHaveBeenCalledTimes(1)
    expect(restoreCollapse).toHaveBeenCalledTimes(1)
  })

  it('reports an unmounted message without capturing', async () => {
    const { restoreCollapse, writeImage, expandSlotTemporarily } = setup()
    waitMock.mockResolvedValue(undefined)

    const result = await copyMessageAsImage({
      container: document.createElement('div'),
      slotKey: 'm:a',
      expandSlotTemporarily,
      writeImage,
    })

    expect(result).toEqual({ kind: 'unavailable' })
    expect(renderMock).not.toHaveBeenCalled()
    expect(writeImage).not.toHaveBeenCalled()
    expect(restoreCollapse).toHaveBeenCalledTimes(1)
  })

  it('maps a too-large message', async () => {
    const { writeImage, expandSlotTemporarily } = setup()
    renderMock.mockRejectedValue(new MessageImageTooLargeError())

    const result = await copyMessageAsImage({
      container: document.createElement('div'),
      slotKey: 'm:a',
      expandSlotTemporarily,
      writeImage,
    })

    expect(result).toEqual({ kind: 'too-large' })
    expect(writeImage).not.toHaveBeenCalled()
  })

  it('maps a vanished element', async () => {
    const { writeImage, expandSlotTemporarily } = setup()
    renderMock.mockRejectedValue(new MessageImageUnavailableError())

    const result = await copyMessageAsImage({
      container: document.createElement('div'),
      slotKey: 'm:a',
      expandSlotTemporarily,
      writeImage,
    })

    expect(result).toEqual({ kind: 'unavailable' })
  })

  it('restores the clamp and reports a capture failure', async () => {
    const { restoreCollapse, writeImage, expandSlotTemporarily } = setup()
    const restoreClamp = vi.fn()
    clampMock.mockReturnValue(restoreClamp)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderMock.mockRejectedValue(new Error('boom'))

    const result = await copyMessageAsImage({
      container: document.createElement('div'),
      slotKey: 'm:a',
      expandSlotTemporarily,
      writeImage,
    })

    expect(result.kind).toBe('failed')
    expect(restoreClamp).toHaveBeenCalledTimes(1)
    expect(restoreCollapse).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('maps a clipboard write failure', async () => {
    const { restoreCollapse, writeImage, expandSlotTemporarily } = setup()
    writeImage.mockRejectedValue(new Error('clipboard busy'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await copyMessageAsImage({
      container: document.createElement('div'),
      slotKey: 'm:a',
      expandSlotTemporarily,
      writeImage,
    })

    expect(result.kind).toBe('failed')
    expect(restoreCollapse).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
