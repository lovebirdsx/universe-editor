import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardImage, writeClipboardText } from '../clipboard.js'

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
let execCommandStubbed = false

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

function stubExecCommand(implementation: () => boolean): ReturnType<typeof vi.fn> {
  const stub = vi.fn(implementation)
  Object.defineProperty(document, 'execCommand', { configurable: true, value: stub })
  execCommandStubbed = true
  return stub
}

afterEach(() => {
  if (clipboardDescriptor === undefined) {
    delete (navigator as { clipboard?: unknown }).clipboard
  } else {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  }
  if (execCommandStubbed) {
    delete (document as { execCommand?: unknown }).execCommand
    execCommandStubbed = false
  }
  vi.unstubAllGlobals()
})

describe('writeClipboardText', () => {
  it('prefers the async clipboard API', async () => {
    const writeText = vi.fn(async () => undefined)
    setClipboard({ writeText })

    await expect(writeClipboardText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    setClipboard(undefined)
    const execCommand = stubExecCommand(() => true)

    await expect(writeClipboardText('legacy')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back when writeText rejects', async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('denied'))) })
    const execCommand = stubExecCommand(() => true)

    await expect(writeClipboardText('denied')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledTimes(1)
  })

  it('reports failure and still removes the temporary textarea', async () => {
    setClipboard(undefined)
    stubExecCommand(() => false)

    await expect(writeClipboardText('nope')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('writeClipboardImage', () => {
  it('calls clipboard.write synchronously with a pending promise value', async () => {
    let resolveCapture: ((blob: Blob) => void) | undefined
    const capture = new Promise<Blob>((resolve) => {
      resolveCapture = resolve
    })
    const write = vi.fn(async () => undefined)
    setClipboard({ write })
    const ClipboardItemMock = vi.fn(function (
      this: Record<string, unknown>,
      items: Record<string, unknown>,
    ) {
      Object.assign(this, items)
    })
    vi.stubGlobal('ClipboardItem', ClipboardItemMock)

    const result = writeClipboardImage(capture)

    // The write must happen before the capture resolves; that is what keeps the
    // user activation alive on WebKit.
    expect(write).toHaveBeenCalledTimes(1)
    const items = ClipboardItemMock.mock.calls[0]?.[0]
    expect(items?.['image/png']).toBeInstanceOf(Promise)

    resolveCapture?.(new Blob(['png'], { type: 'image/png' }))
    await expect(result).resolves.toBe(true)
  })

  it('returns false when ClipboardItem is missing', async () => {
    const write = vi.fn(async () => undefined)
    setClipboard({ write })
    vi.stubGlobal('ClipboardItem', undefined)

    await expect(writeClipboardImage(new Blob(['x']))).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('returns false when clipboard.write is missing', async () => {
    setClipboard({})
    vi.stubGlobal('ClipboardItem', function ClipboardItem() {})

    await expect(writeClipboardImage(new Blob(['x']))).resolves.toBe(false)
  })

  it('returns false when PNG is unsupported', async () => {
    const write = vi.fn(async () => undefined)
    setClipboard({ write })
    const ClipboardItem = Object.assign(function ClipboardItem() {}, {
      supports: vi.fn(() => false),
    })
    vi.stubGlobal('ClipboardItem', ClipboardItem)

    await expect(writeClipboardImage(new Blob(['x']))).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('returns false when clipboard.write rejects', async () => {
    setClipboard({ write: vi.fn(async () => Promise.reject(new Error('nope'))) })
    vi.stubGlobal('ClipboardItem', function ClipboardItem() {})

    await expect(writeClipboardImage(new Blob(['x']))).resolves.toBe(false)
  })

  it('returns false when constructing the clipboard item throws', async () => {
    setClipboard({ write: vi.fn(async () => undefined) })
    vi.stubGlobal('ClipboardItem', function ClipboardItem() {
      throw new Error('unsupported')
    })

    await expect(writeClipboardImage(new Blob(['x']))).resolves.toBe(false)
  })
})
