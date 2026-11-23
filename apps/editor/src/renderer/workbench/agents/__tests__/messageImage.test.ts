/*---------------------------------------------------------------------------------------------
 *  Message-image capture: canvas planning, option construction and the 2x→1x
 *  retry. html-to-image is mocked because happy-dom has no real renderer.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { toBlob } from 'html-to-image'
import {
  MessageImageTooLargeError,
  MessageImageUnavailableError,
  planMessageCapture,
  renderMessageImage,
} from '../messageImage.js'

vi.mock('html-to-image', () => ({ toBlob: vi.fn() }))

const toBlobMock = vi.mocked(toBlob)

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  toBlobMock.mockReset()
})

function pngBlob(): Blob {
  return new Blob(['x'], { type: 'image/png' })
}

function mockRect(element: Element, width: number, height: number): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

function appendBody(width = 200, height = 100): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-testid', 'acp-collapsible-body')
  document.body.append(element)
  mockRect(element, width, height)
  return element
}

describe('planMessageCapture', () => {
  it('prefers 2x when the canvas fits', () => {
    expect(planMessageCapture(100, 50)).toEqual({ width: 100, height: 50, scale: 2 })
  })

  it('falls back to 1x when 2x exceeds a side limit', () => {
    expect(planMessageCapture(3000, 3000)).toEqual({ width: 3000, height: 3000, scale: 1 })
  })

  it('throws when even 1x is too large', () => {
    expect(() => planMessageCapture(5000, 10)).toThrow(MessageImageTooLargeError)
  })

  it('throws for non-finite or non-positive sizes', () => {
    expect(() => planMessageCapture(0, 100)).toThrow(MessageImageTooLargeError)
    expect(() => planMessageCapture(Number.NaN, 100)).toThrow(MessageImageTooLargeError)
  })
})

describe('renderMessageImage', () => {
  it('renders at 2x with a padded canvas and the capture options', async () => {
    const element = appendBody(200, 100)
    toBlobMock.mockResolvedValue(pngBlob())

    const blob = await renderMessageImage(element)

    expect(blob.size).toBeGreaterThan(0)
    expect(toBlobMock).toHaveBeenCalledTimes(1)
    const [target, options] = toBlobMock.mock.calls[0]!
    expect(target).toBe(element)
    expect(options).toMatchObject({
      width: 232,
      height: 132,
      pixelRatio: 2,
      type: 'image/png',
      skipFonts: true,
    })
    expect(options?.style).toMatchObject({ boxSizing: 'border-box', maxWidth: 'none' })
  })

  it('retries at 1x when the 2x attempt fails', async () => {
    const element = appendBody(200, 100)
    toBlobMock.mockRejectedValueOnce(new Error('canvas too large')).mockResolvedValueOnce(pngBlob())

    await expect(renderMessageImage(element)).resolves.toBeInstanceOf(Blob)

    expect(toBlobMock).toHaveBeenCalledTimes(2)
    expect(toBlobMock.mock.calls[1]?.[1]).toMatchObject({ pixelRatio: 1 })
  })

  it('does not retry when the 1x attempt fails', async () => {
    const element = appendBody(3000, 3000)
    toBlobMock.mockRejectedValue(new Error('boom'))

    await expect(renderMessageImage(element)).rejects.toThrow('boom')
    expect(toBlobMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a disconnected element', async () => {
    const element = document.createElement('div')
    mockRect(element, 100, 100)

    await expect(renderMessageImage(element)).rejects.toThrow(MessageImageUnavailableError)
  })

  it('rejects an empty element box', async () => {
    const element = appendBody(0, 0)

    await expect(renderMessageImage(element)).rejects.toThrow(MessageImageUnavailableError)
  })

  it('rejects when html-to-image returns no data', async () => {
    const element = appendBody()
    toBlobMock.mockResolvedValue(null as unknown as Blob)

    await expect(renderMessageImage(element)).rejects.toThrow(MessageImageUnavailableError)
  })

  it('filters editor chrome out of the clone', async () => {
    const element = appendBody()
    toBlobMock.mockResolvedValue(pngBlob())

    await renderMessageImage(element)
    const filter = toBlobMock.mock.calls[0]?.[1]?.filter
    expect(filter).toBeTypeOf('function')
    const excluded = document.createElement('button')
    excluded.setAttribute('data-testid', 'code-block-copy')
    expect(filter?.(excluded)).toBe(false)
    expect(filter?.(document.createElement('div'))).toBe(true)
    const text = document.createTextNode('hello')
    expect(filter?.(text as unknown as HTMLElement)).toBe(true)
  })
})
