/*---------------------------------------------------------------------------------------------
 *  Tests for the shared text-clipboard helper: injected host wins, fallbacks only
 *  when no host is installed, failures propagate, and `copyText` never leaks an
 *  unhandled rejection.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  copyText,
  readClipboardText,
  setClipboardHost,
  writeClipboardText,
  type ClipboardHost,
} from '../dom/clipboard.js'

function fakeHost(): ClipboardHost & {
  write: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
} {
  const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  const read = vi.fn<() => Promise<string>>().mockResolvedValue('from-host')
  return { writeClipboardText: write, readClipboardText: read, write, read }
}

function stubNavigatorClipboard(clipboard: Record<string, unknown>): void {
  vi.stubGlobal('navigator', { ...navigator, clipboard })
}

beforeEach(() => {
  setClipboardHost(undefined)
})

afterEach(() => {
  setClipboardHost(undefined)
  vi.unstubAllGlobals()
})

describe('writeClipboardText', () => {
  it('uses the injected host instead of the navigator', async () => {
    const host = fakeHost()
    const navigatorWrite = vi.fn().mockResolvedValue(undefined)
    stubNavigatorClipboard({ writeText: navigatorWrite })
    setClipboardHost(host)

    await writeClipboardText('hello')

    expect(host.write).toHaveBeenCalledWith('hello')
    expect(navigatorWrite).not.toHaveBeenCalled()
  })

  it('falls back to the global navigator when no host is installed', async () => {
    const navigatorWrite = vi.fn().mockResolvedValue(undefined)
    stubNavigatorClipboard({ writeText: navigatorWrite })

    await writeClipboardText('fallback')

    expect(navigatorWrite).toHaveBeenCalledWith('fallback')
  })

  it("prefers an explicit document's navigator over the global one", async () => {
    const docWrite = vi.fn().mockResolvedValue(undefined)
    const globalWrite = vi.fn().mockResolvedValue(undefined)
    stubNavigatorClipboard({ writeText: globalWrite })
    const doc = {
      defaultView: { navigator: { clipboard: { writeText: docWrite } } },
    } as unknown as Document

    await writeClipboardText('aux', doc)

    expect(docWrite).toHaveBeenCalledWith('aux')
    expect(globalWrite).not.toHaveBeenCalled()
  })

  it('propagates a host failure so callers can surface it', async () => {
    const host = fakeHost()
    host.write.mockRejectedValue(new Error('denied'))
    setClipboardHost(host)

    await expect(writeClipboardText('x')).rejects.toThrow('denied')
  })

  it('throws when neither a host nor a clipboard implementation exists', async () => {
    stubNavigatorClipboard({})

    await expect(writeClipboardText('x')).rejects.toThrow('clipboard.writeText is unavailable')
  })
})

describe('readClipboardText', () => {
  it('uses the injected host', async () => {
    const host = fakeHost()
    setClipboardHost(host)

    await expect(readClipboardText()).resolves.toBe('from-host')
    expect(host.read).toHaveBeenCalledTimes(1)
  })

  it('falls back to the navigator readText', async () => {
    stubNavigatorClipboard({ readText: vi.fn().mockResolvedValue('from-navigator') })

    await expect(readClipboardText()).resolves.toBe('from-navigator')
  })

  it("prefers an explicit document's navigator over the global one", async () => {
    const docRead = vi.fn().mockResolvedValue('from-doc')
    const globalRead = vi.fn().mockResolvedValue('from-global')
    stubNavigatorClipboard({ readText: globalRead })
    const doc = {
      defaultView: { navigator: { clipboard: { readText: docRead } } },
    } as unknown as Document

    await expect(readClipboardText(doc)).resolves.toBe('from-doc')
    expect(globalRead).not.toHaveBeenCalled()
  })
})

describe('copyText', () => {
  it('swallows a failed write instead of leaving an unhandled rejection', async () => {
    const host = fakeHost()
    host.write.mockRejectedValue(new Error('denied'))
    setClipboardHost(host)

    expect(() => copyText('x')).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.write).toHaveBeenCalledWith('x')
  })
})
