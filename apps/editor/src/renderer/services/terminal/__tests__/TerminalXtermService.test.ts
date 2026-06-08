/*---------------------------------------------------------------------------------------------
 *  Tests for TerminalXtermService — the persistent xterm holder. Mocks the
 *  @xterm trio (no real terminal/canvas) and a partial ITerminalManagerService.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, type IConfigurationService } from '@universe-editor/platform'
import { ITerminalManagerService } from '../TerminalManagerService.js'

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    buffer = { active: { viewportY: 0 } }
    resizeCalls: Array<[number, number]> = []
    refreshCalls: Array<[number, number]> = []
    scrollToLineCalls: number[] = []
    disposed = false
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts }
    }
    loadAddon(): void {}
    open(): void {}
    registerLinkProvider() {
      return { dispose() {} }
    }
    onData() {
      return { dispose() {} }
    }
    onSelectionChange() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler(): void {}
    write(): void {}
    focus(): void {}
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    paste(): void {}
    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
      this.resizeCalls.push([cols, rows])
    }
    refresh(start: number, end: number): void {
      this.refreshCalls.push([start, end])
    }
    scrollToLine(line: number): void {
      this.scrollToLineCalls.push(line)
    }
    dispose(): void {
      this.disposed = true
    }
  }
  return { Terminal }
})

let proposed: { cols: number; rows: number } | undefined = { cols: 100, rows: 30 }

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions() {
      return proposed
    }
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

interface Harness {
  attachDisposed: boolean
  resizes: Array<{ id: string; cols: number; rows: number }>
  onDidRemoveTerminal: Emitter<{ id: string }>
}

function makeManager(h: Harness): ITerminalManagerService {
  return {
    _serviceBrand: undefined,
    attach: () => ({
      dispose() {
        h.attachDisposed = true
      },
    }),
    input: () => {},
    resize: (id: string, cols: number, rows: number) => h.resizes.push({ id, cols, rows }),
    onDidRemoveTerminal: h.onDidRemoveTerminal.event,
  } as unknown as ITerminalManagerService
}

function makeConfig(): IConfigurationService {
  return {
    _serviceBrand: undefined,
    get: () => 5000,
    onDidChangeConfiguration: new Emitter<never>().event,
  } as unknown as IConfigurationService
}

function sizeWrapper(wrapper: HTMLElement, w: number, hgt: number): void {
  Object.defineProperty(wrapper, 'clientWidth', { value: w, configurable: true })
  Object.defineProperty(wrapper, 'clientHeight', { value: hgt, configurable: true })
}

async function makeService(h: Harness) {
  const { TerminalXtermService } = await import('../TerminalXtermService.js')
  return new TerminalXtermService(makeManager(h), makeConfig())
}

function makeHarness(): Harness {
  return { attachDisposed: false, resizes: [], onDidRemoveTerminal: new Emitter() }
}

describe('TerminalXtermService', () => {
  beforeEach(() => {
    proposed = { cols: 100, rows: 30 }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('acquire is idempotent per id and distinct across ids', async () => {
    const svc = await makeService(makeHarness())
    expect(svc.acquire('a')).toBe(svc.acquire('a'))
    expect(svc.acquire('a')).not.toBe(svc.acquire('b'))
  })

  it('fit resizes once and forwards to the PTY, skipping no-op resizes', async () => {
    const h = makeHarness()
    const svc = await makeService(h)
    const holder = svc.acquire('t1')
    sizeWrapper(holder.wrapper, 200, 200)

    holder.fit()
    holder.fit()

    expect(h.resizes).toEqual([{ id: 't1', cols: 100, rows: 30 }])
  })

  it('fit early-returns on a zero-sized wrapper', async () => {
    const h = makeHarness()
    const svc = await makeService(h)
    const holder = svc.acquire('t1')
    sizeWrapper(holder.wrapper, 0, 0)

    holder.fit()

    expect(h.resizes).toEqual([])
  })

  it('reattachTo mounts the wrapper, repaints and restores scroll', async () => {
    const svc = await makeService(makeHarness())
    const holder = svc.acquire('t1')
    const term = holder.term as unknown as {
      refreshCalls: Array<[number, number]>
      scrollToLineCalls: number[]
      buffer: { active: { viewportY: number } }
    }
    term.buffer.active.viewportY = 12
    holder.saveScroll()

    const host = document.createElement('div')
    holder.reattachTo(host)

    expect(host.contains(holder.wrapper)).toBe(true)
    expect(term.refreshCalls.length).toBe(1)
    expect(term.scrollToLineCalls).toContain(12)
  })

  it('release disposes the holder (term + manager.attach) and onDidRemoveTerminal triggers it', async () => {
    const h = makeHarness()
    const svc = await makeService(h)
    const holder = svc.acquire('t1')
    const term = holder.term as unknown as { disposed: boolean }

    h.onDidRemoveTerminal.fire({ id: 't1' })

    expect(term.disposed).toBe(true)
    expect(h.attachDisposed).toBe(true)
    expect(svc.get('t1')).toBeUndefined()
  })

  it('dispose() cascades to all acquired holders (registered on the service store)', async () => {
    const svc = await makeService(makeHarness())
    const a = svc.acquire('a').term as unknown as { disposed: boolean }
    const b = svc.acquire('b').term as unknown as { disposed: boolean }

    svc.dispose()

    expect(a.disposed).toBe(true)
    expect(b.disposed).toBe(true)
  })
})
