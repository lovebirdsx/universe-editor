import { toBlob } from 'html-to-image'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MessageImageTooLargeError,
  MessageImageUnavailableError,
  planMessageCapture,
  renderMessageImage,
} from '../messageImage.js'

vi.mock('html-to-image', () => ({ toBlob: vi.fn() }))

const toBlobMock = vi.mocked(toBlob)

function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  }
}

function makeElement(
  width: number,
  height: number,
  options: { readonly actionHeight?: number; readonly background?: string } = {},
): HTMLDivElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => rect(width, height)
  if (options.background !== undefined) element.style.backgroundColor = options.background
  if (options.actionHeight !== undefined) {
    const action = document.createElement('button')
    action.className = 'message__actions'
    action.getBoundingClientRect = () => rect(24, options.actionHeight ?? 0)
    element.appendChild(action)
  }
  document.body.appendChild(element)
  return element
}

beforeEach(() => {
  document.body.style.backgroundColor = ''
  toBlobMock.mockReset()
  toBlobMock.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('planMessageCapture', () => {
  it('uses 2x for a normal message', () => {
    expect(planMessageCapture(300, 200)).toEqual({ width: 300, height: 200, scale: 2 })
  })

  it('rounds up fractional CSS sizes', () => {
    expect(planMessageCapture(300.2, 199.1)).toEqual({ width: 301, height: 200, scale: 2 })
  })

  it('falls back to 1x when the 2x canvas would exceed the limits', () => {
    expect(planMessageCapture(300, 3_000)).toEqual({ width: 300, height: 3_000, scale: 1 })
  })

  it('rejects messages that are too large even at 1x', () => {
    expect(() => planMessageCapture(300, 5_000)).toThrow(MessageImageTooLargeError)
  })

  it('rejects invalid sizes', () => {
    expect(() => planMessageCapture(0, 100)).toThrow(MessageImageTooLargeError)
    expect(() => planMessageCapture(100, Number.NaN)).toThrow(MessageImageTooLargeError)
    expect(() => planMessageCapture(Number.POSITIVE_INFINITY, 100)).toThrow(
      MessageImageTooLargeError,
    )
  })
})

describe('renderMessageImage', () => {
  it('captures the live node without the action button', async () => {
    const element = makeElement(300, 200, { actionHeight: 44 })

    const blob = await renderMessageImage(element)

    expect(blob.size).toBeGreaterThan(0)
    expect(toBlobMock).toHaveBeenCalledTimes(1)
    const [, options] = toBlobMock.mock.calls[0]!
    expect(options).toMatchObject({
      width: 300,
      height: 156,
      pixelRatio: 2,
      type: 'image/png',
      skipFonts: true,
      imagePlaceholder: expect.stringMatching(/^data:image\/png;base64,/),
      style: { maxWidth: 'none' },
    })
    const filter = options?.filter as (node: Node) => boolean
    expect(filter(element.querySelector<HTMLElement>('.message__actions')!)).toBe(false)
    expect(filter(element)).toBe(true)
    expect(filter(document.createTextNode('text'))).toBe(true)
  })

  it('does not subtract height when the action button is absent', async () => {
    await renderMessageImage(makeElement(300, 200))
    expect(toBlobMock.mock.calls[0]?.[1]).toMatchObject({ height: 200 })
  })

  it('leaves an opaque message background alone', async () => {
    const element = makeElement(300, 200, { background: 'rgb(59, 130, 246)' })
    await renderMessageImage(element)
    expect(toBlobMock.mock.calls[0]?.[1]?.backgroundColor).toBeUndefined()
  })

  it('uses the page background for a transparent message', async () => {
    document.body.style.backgroundColor = 'rgb(18, 18, 18)'
    await renderMessageImage(makeElement(300, 200))
    expect(toBlobMock.mock.calls[0]?.[1]?.backgroundColor).toBe('rgb(18, 18, 18)')
  })

  it('falls back to white when the page background is transparent too', async () => {
    await renderMessageImage(makeElement(300, 200))
    expect(toBlobMock.mock.calls[0]?.[1]?.backgroundColor).toBe('#ffffff')
  })

  it('rejects an empty capture and retries once at 1x', async () => {
    toBlobMock
      .mockResolvedValueOnce(new Blob([]))
      .mockResolvedValueOnce(new Blob(['retry'], { type: 'image/png' }))

    const blob = await renderMessageImage(makeElement(300, 200))

    expect(blob.size).toBeGreaterThan(0)
    expect(toBlobMock).toHaveBeenCalledTimes(2)
    expect(toBlobMock.mock.calls[1]?.[1]).toMatchObject({ pixelRatio: 1 })
  })

  it('retries at 1x after the 2x capture throws', async () => {
    toBlobMock
      .mockRejectedValueOnce(new Error('canvas too large'))
      .mockResolvedValueOnce(new Blob(['retry'], { type: 'image/png' }))

    await expect(renderMessageImage(makeElement(300, 200))).resolves.toBeInstanceOf(Blob)
    expect(toBlobMock.mock.calls[1]?.[1]).toMatchObject({ pixelRatio: 1 })
  })

  it('propagates the failure when both attempts fail', async () => {
    toBlobMock.mockResolvedValue(new Blob([]))
    await expect(renderMessageImage(makeElement(300, 200))).rejects.toThrow()
    expect(toBlobMock).toHaveBeenCalledTimes(2)
  })

  it('rejects an oversized message before importing the capture library', async () => {
    await expect(renderMessageImage(makeElement(300, 5_000))).rejects.toBeInstanceOf(
      MessageImageTooLargeError,
    )
    expect(toBlobMock).not.toHaveBeenCalled()
  })

  it('rejects a detached or zero-sized node', async () => {
    const detached = document.createElement('div')
    detached.getBoundingClientRect = () => rect(300, 200)
    await expect(renderMessageImage(detached)).rejects.toBeInstanceOf(MessageImageUnavailableError)

    await expect(renderMessageImage(makeElement(0, 200))).rejects.toBeInstanceOf(
      MessageImageUnavailableError,
    )
  })
})
