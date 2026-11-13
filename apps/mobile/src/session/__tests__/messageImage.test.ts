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
  it('captures the live node without the action button and adds a frame', async () => {
    const element = makeElement(300, 200, { actionHeight: 44 })

    const blob = await renderMessageImage(element)

    expect(blob.size).toBeGreaterThan(0)
    expect(toBlobMock).toHaveBeenCalledTimes(1)
    const [, options] = toBlobMock.mock.calls[0]!
    expect(options).toMatchObject({
      width: 332,
      height: 188,
      pixelRatio: 2,
      type: 'image/png',
      backgroundColor: '#ffffff',
      skipFonts: true,
      imagePlaceholder: expect.stringMatching(/^data:image\/png;base64,/),
      style: {
        maxWidth: 'none',
        boxSizing: 'border-box',
        border: '16px solid transparent',
        borderBlock: '16px solid transparent',
        borderInline: '16px solid transparent',
        backgroundClip: 'padding-box',
        backgroundColor: 'transparent',
        borderTopLeftRadius: '16px',
        borderTopRightRadius: '16px',
        borderBottomRightRadius: '16px',
        borderBottomLeftRadius: '16px',
        borderStartStartRadius: '16px',
        borderStartEndRadius: '16px',
        borderEndEndRadius: '16px',
        borderEndStartRadius: '16px',
      },
    })
    const filter = options?.filter as (node: Node) => boolean
    expect(filter(element.querySelector<HTMLElement>('.message__actions')!)).toBe(false)
    expect(filter(element)).toBe(true)
    expect(filter(document.createTextNode('text'))).toBe(true)
  })

  it('does not subtract height when the action button is absent', async () => {
    await renderMessageImage(makeElement(300, 200))
    expect(toBlobMock.mock.calls[0]?.[1]).toMatchObject({ height: 232 })
  })

  it('keeps an opaque message background inside the frame', async () => {
    const element = makeElement(300, 200, { background: 'rgb(59, 130, 246)' })
    await renderMessageImage(element)
    const options = toBlobMock.mock.calls[0]?.[1]
    expect(options?.backgroundColor).toBe('#ffffff')
    expect(options?.style).toMatchObject({ backgroundColor: 'rgb(59, 130, 246)' })
  })

  it('uses the page background for the frame', async () => {
    document.body.style.backgroundColor = 'rgb(18, 18, 18)'
    await renderMessageImage(makeElement(300, 200))
    const options = toBlobMock.mock.calls[0]?.[1]
    expect(options?.backgroundColor).toBe('rgb(18, 18, 18)')
    expect(options?.style).toMatchObject({ backgroundColor: 'transparent' })
  })

  it('falls back to white when the page background is transparent too', async () => {
    await renderMessageImage(makeElement(300, 200))
    expect(toBlobMock.mock.calls[0]?.[1]?.backgroundColor).toBe('#ffffff')
  })

  it('adds the frame width to every corner radius', async () => {
    const element = makeElement(300, 200)
    element.style.borderTopLeftRadius = '16px'
    element.style.borderTopRightRadius = '16px'
    element.style.borderBottomRightRadius = '4px'
    element.style.borderBottomLeftRadius = '16px'

    await renderMessageImage(element)

    expect(toBlobMock.mock.calls[0]?.[1]?.style).toMatchObject({
      borderTopLeftRadius: '32px',
      borderTopRightRadius: '32px',
      borderBottomRightRadius: '20px',
      borderBottomLeftRadius: '32px',
    })
  })

  it('counts the frame when choosing the pixel ratio', async () => {
    // 2040 * 2 fits the side limit, but (2040 + 32) * 2 does not.
    await renderMessageImage(makeElement(300, 2_040))
    expect(toBlobMock.mock.calls[0]?.[1]).toMatchObject({
      width: 332,
      height: 2_072,
      pixelRatio: 1,
    })
  })

  it('rejects a message that only fits without the frame', async () => {
    await expect(renderMessageImage(makeElement(300, 4_080))).rejects.toBeInstanceOf(
      MessageImageTooLargeError,
    )
    expect(toBlobMock).not.toHaveBeenCalled()
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
