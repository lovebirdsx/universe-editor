/**
 * The revision chip (`#have / #head`) tracks the active editor: non-file
 * schemes, files outside every client root, and the NOT_CONTROLLED fstat
 * sentinel all hide it; `haveRev: 'none'` (open-for-add) renders the "new"
 * form; a lower have than head renders the behind form and wires
 * `perforce.syncLatest`.
 *
 * `setVisible(false)` is the mixed-workspace gate (selection moved to another
 * provider): both items hide and stay hidden across refresh, tab switches and
 * in-flight fstat completions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const makeItem = () => ({
    text: '',
    tooltip: '',
    command: '',
    showProgress: undefined as string | undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })
  return {
    item: makeItem(),
    revItem: makeItem(),
    activeEditor: undefined as { document: { uri: unknown } } | undefined,
    editorListener: undefined as ((e: unknown) => void) | undefined,
  }
})

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: vi.fn((_alignment: unknown, priority: number) =>
      priority === 100 ? mocks.item : mocks.revItem,
    ),
    onDidChangeActiveTextEditor: vi.fn((listener: (e: unknown) => void) => {
      mocks.editorListener = listener
      return { dispose: vi.fn() }
    }),
    getActiveTextEditor: vi.fn(() => Promise.resolve(mocks.activeEditor)),
  },
}))

const { P4StatusBarController, truncateClientName, formatScanElapsed, syncTargetLabel } =
  await import('../p4StatusBar.js')

function makeClient(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: {
      clientName: 'client-1',
      connection: 'connected',
      openedCount: 2,
      busy: undefined,
      busyCancellable: false,
      ...overrides,
    },
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    fstat: vi.fn(async () => undefined),
    updateBehindFromFstat: vi.fn(),
  }
}

/** A manager fake with the routing surface the controller touches. */
function makeManager(overrides: Record<string, unknown> = {}): unknown {
  return {
    active: makeClient(),
    resolveContaining: vi.fn(() => undefined),
    ...overrides,
  }
}

/** A fake client carrying a mockable `fstat`, for the revision-chip tests. */
type ClientFake = { fstat: ReturnType<typeof vi.fn> }

function revClient(): ClientFake {
  return makeClient() as unknown as ClientFake
}

function fileEditor(path: string): { document: { uri: unknown } } {
  return { document: { uri: { scheme: 'file', path } } }
}

describe('P4StatusBarController revision chip', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.command = ''
    mocks.item.showProgress = undefined
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.revItem.text = ''
    mocks.revItem.tooltip = ''
    mocks.revItem.command = ''
    mocks.revItem.show.mockClear()
    mocks.revItem.hide.mockClear()
    mocks.activeEditor = undefined
    mocks.editorListener = undefined
  })

  it('hides the chip when no editor is active', async () => {
    const controller = new P4StatusBarController(makeManager() as never)
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.hide).toHaveBeenCalled())
    expect(mocks.revItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('shows #have / #head for a controlled file', async () => {
    const client = revClient()
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/a.txt')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue({
      depotFile: '//depot/branch_x/src/a.txt',
      haveRev: '5',
      headRev: '5',
      action: undefined,
    })
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.text).toBe('#5 / #5'))
    expect(mocks.revItem.show).toHaveBeenCalled()
    controller.dispose()
  })

  it('renders the behind form (↓) and wires syncLatest when head is ahead', async () => {
    const client = revClient()
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/a.txt')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue({
      depotFile: '//depot/branch_x/src/a.txt',
      haveRev: '3',
      headRev: '5',
      action: undefined,
    })
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.text).toBe('#3 / ↓#5'))
    // The chip describes ONE file, so it stays file-scoped.
    expect(mocks.revItem.command).toBe('perforce.syncLatest')
    expect(mocks.revItem.tooltip).toContain('this file')
    controller.dispose()
  })

  it('feeds the chip fstat result into the behind funnel (zero extra fstat)', async () => {
    // Design invariant: the revision chip's single fstat is reused to populate
    // the Explorer ↓ marker via `updateBehindFromFstat` — the status bar and the
    // visible-row probe share one funnel and never run a second server query for
    // the same file.
    const client = revClient() as ClientFake & {
      updateBehindFromFstat: ReturnType<typeof vi.fn>
    }
    const fsPath = 'D:/p4ws/main/src/a.txt'
    mocks.activeEditor = fileEditor(`/${fsPath}`)
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    const info = {
      depotFile: '//depot/branch_x/src/a.txt',
      haveRev: '3',
      headRev: '5',
      action: undefined,
    }
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue(info)
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.text).toBe('#3 / ↓#5'))
    expect(client.fstat).toHaveBeenCalledTimes(1)
    expect(client.updateBehindFromFstat).toHaveBeenCalledTimes(1)
    expect(client.updateBehindFromFstat).toHaveBeenCalledWith(fsPath, info)
    controller.dispose()
  })

  it('does not wire the sync command when have equals head', async () => {
    const client = revClient()
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/a.txt')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue({
      depotFile: '//depot/branch_x/src/a.txt',
      haveRev: '5',
      headRev: '5',
      action: undefined,
    })
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.text).toBe('#5 / #5'))
    expect(mocks.revItem.command).toBeUndefined()
    controller.dispose()
  })

  it('renders the "new" form for an open-for-add file (haveRev "none")', async () => {
    const client = revClient()
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/NewFile.bin')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue({
      depotFile: '//depot/branch_x/src/NewFile.bin',
      haveRev: 'none',
      headRev: '5',
      action: 'add',
    })
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.text).toContain('new'))
    expect(mocks.revItem.command).toBeUndefined()
    controller.dispose()
  })

  it('renders the "new" form when fstat omits haveRev entirely but reports action add', async () => {
    // The real-server shape (P4D 2024.2, PROBE-FINDINGS §10): fstat leaves
    // `haveRev` OUT for an open-for-add file rather than reporting the string
    // 'none' — that string only appears in `opened` records. A re-add even
    // carries the deleted file's `headRev`, so keying on haveRev alone would
    // paint a confident "#4" for a file that has no have revision at all.
    const client = revClient()
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/Readded.bin')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue({
      depotFile: '//depot/branch_x/src/Readded.bin',
      haveRev: undefined,
      headRev: '4',
      action: 'add',
    })
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.text).toContain('new'))
    expect(mocks.revItem.text).not.toContain('4')
    expect(mocks.revItem.command).toBeUndefined()
    controller.dispose()
  })

  it('shows head-only when no have revision is reported at all', async () => {
    const client = revClient()
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/a.txt')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue({
      depotFile: '//depot/branch_x/src/a.txt',
      haveRev: undefined,
      headRev: '5',
      action: undefined,
    })
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.text).toBe('#5'))
    controller.dispose()
  })

  it('hides the chip for a non-file scheme editor (untitled)', async () => {
    mocks.activeEditor = { document: { uri: { scheme: 'untitled', path: '/Untitled-1' } } }
    const controller = new P4StatusBarController(makeManager() as never)
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.hide).toHaveBeenCalled())
    expect(mocks.revItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('hides the chip when the fstat reports NOT_CONTROLLED (undefined info)', async () => {
    const client = revClient()
    mocks.activeEditor = fileEditor('/D:/p4ws/main/not-in-depot.txt')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    // The default fstat mock resolves undefined — the NOT_CONTROLLED sentinel path.
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.hide).toHaveBeenCalled())
    expect(mocks.revItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('degrades to hide when fstat rejects (p4 spawn failure)', async () => {
    const client = revClient()
    client.fstat.mockRejectedValue(new Error('spawn p4 ENOENT'))
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/a.txt')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.hide).toHaveBeenCalled())
    expect(mocks.revItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('hides the chip when no client contains the file (no active fallback)', async () => {
    mocks.activeEditor = fileEditor('/D:/elsewhere/a.txt')
    const controller = new P4StatusBarController(makeManager() as never)
    controller.refresh()

    await vi.waitFor(() => expect(mocks.revItem.hide).toHaveBeenCalled())
    expect(mocks.revItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('re-renders on onDidChangeActiveTextEditor', async () => {
    const client = revClient()
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    ;(client.fstat as ReturnType<typeof vi.fn>).mockResolvedValue({
      depotFile: '//depot/branch_x/src/a.txt',
      haveRev: '3',
      headRev: '5',
      action: undefined,
    })

    expect(mocks.editorListener).toBeDefined()
    mocks.editorListener?.(fileEditor('/D:/p4ws/main/src/a.txt'))
    await vi.waitFor(() => expect(mocks.revItem.text).toBe('#3 / ↓#5'))

    mocks.editorListener?.(undefined)
    await vi.waitFor(() => expect(mocks.revItem.hide).toHaveBeenCalled())
    controller.dispose()
  })

  it('disposes the editor subscription and the chip', () => {
    const controller = new P4StatusBarController(makeManager() as never)
    controller.dispose()
    expect(mocks.revItem.dispose).toHaveBeenCalled()
  })
})

describe('P4StatusBarController setVisible', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.command = ''
    mocks.item.showProgress = undefined
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.revItem.text = ''
    mocks.revItem.tooltip = ''
    mocks.revItem.command = ''
    mocks.revItem.show.mockClear()
    mocks.revItem.hide.mockClear()
    mocks.activeEditor = undefined
    mocks.editorListener = undefined
  })

  it('hides both items when the selection moves to another provider', () => {
    const controller = new P4StatusBarController(makeManager() as never)
    controller.setVisible(false)

    expect(mocks.item.hide).toHaveBeenCalled()
    expect(mocks.revItem.hide).toHaveBeenCalled()
    controller.dispose()
  })

  it('refresh and tab switches do not re-show the items while hidden', () => {
    const controller = new P4StatusBarController(makeManager() as never)
    controller.setVisible(false)
    mocks.item.show.mockClear()

    controller.refresh()
    mocks.editorListener?.(fileEditor('/D:/p4ws/main/src/a.txt'))
    expect(mocks.item.show).not.toHaveBeenCalled()
    expect(mocks.revItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('an in-flight fstat finishing after hide does not re-show the chip', async () => {
    let resolveFstat: (v: unknown) => void = () => {}
    const client = revClient()
    ;(client.fstat as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((res) => {
        resolveFstat = res
      }),
    )
    mocks.activeEditor = fileEditor('/D:/p4ws/main/src/a.txt')
    const controller = new P4StatusBarController(
      makeManager({ resolveContaining: () => client }) as never,
    )
    controller.refresh()
    controller.setVisible(false)
    mocks.revItem.show.mockClear()

    resolveFstat({
      depotFile: '//depot/branch_x/src/a.txt',
      haveRev: '3',
      headRev: '5',
      action: undefined,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.revItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('setVisible(true) restores and re-renders the items', () => {
    const controller = new P4StatusBarController(makeManager() as never)
    controller.setVisible(false)
    mocks.item.show.mockClear()

    controller.setVisible(true)
    expect(mocks.item.show).toHaveBeenCalled()
    controller.dispose()
  })
})

describe('P4StatusBarController sync progress', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.command = ''
    mocks.item.showProgress = undefined
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.revItem.text = ''
    mocks.revItem.tooltip = ''
    mocks.revItem.command = ''
    mocks.revItem.show.mockClear()
    mocks.revItem.hide.mockClear()
    mocks.activeEditor = undefined
    mocks.editorListener = undefined
  })

  it('renders the running count, current file and elapsed with the busy label', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'testuser_dev_branch_xyz',
        busy: 'Syncing',
        busyCancellable: true,
        syncProgress: {
          done: 421,
          currentFile: 'a.cpp',
          startedAt: Date.now() - 73_000,
        },
      }),
    } as never)
    controller.refresh()

    // No total is ever shown: the pre-flight count that would produce one costs
    // a full server-side walk on a wide scope, so the sync starts downloading
    // immediately — a rising count + clock is the "it's alive" signal instead.
    expect(mocks.item.text).toBe('$(server) …branch_xyz: Syncing 421 · 1m 13s $(sync~spin)')
    expect(mocks.item.text.endsWith('$(sync~spin)')).toBe(true)
    expect(mocks.item.tooltip).toContain('Syncing testuser_dev_branch_xyz')
    expect(mocks.item.tooltip).toContain('Synced 421 files')
    expect(mocks.item.tooltip).toContain('Current: a.cpp')
    expect(mocks.item.tooltip).toContain('1m 13s elapsed')
    expect(mocks.item.tooltip).toContain('\n\nClick to cancel')
    expect(mocks.item.command).toBe('perforce.cancelBusy')
    controller.dispose()
  })

  it('renders a bare done count plus elapsed', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'client-1',
        busy: 'Syncing',
        busyCancellable: false,
        syncProgress: { done: 421, startedAt: Date.now() - 5_000 },
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 5s $(sync~spin)')
    expect(mocks.item.tooltip).toContain('Synced 421 files')
    expect(mocks.item.tooltip).not.toContain('Current:')
    expect(mocks.item.tooltip).not.toContain('Click to cancel')
    expect(mocks.item.command).toBe('perforce-graph.view')
    controller.dispose()
  })

  it('pairs the count with the watcher disk writes when present', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'client-1',
        busy: 'Syncing',
        busyCancellable: false,
        syncProgress: { done: 421, diskWrites: 567, startedAt: Date.now() - 5_000 },
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · disk +567 · 5s $(sync~spin)')
    expect(mocks.item.tooltip).toContain('Synced 421 files')
    expect(mocks.item.tooltip).toContain('Disk writes seen by the file watcher: 567')
    controller.dispose()
  })

  it('keeps the disk segment across heartbeat re-renders', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const controller = new P4StatusBarController({
        active: makeClient({
          clientName: 'client-1',
          busy: 'Syncing',
          busyCancellable: false,
          syncProgress: { done: 421, diskWrites: 567, startedAt: Date.now() - 5_000 },
        }),
      } as never)
      controller.refresh()
      vi.advanceTimersByTime(3_000)

      // A pure repaint: p4 printed nothing, the data is unchanged, the disk
      // segment survives the tick alongside the advanced clock.
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · disk +567 · 8s $(sync~spin)')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // The read rate: the p4 process's own I/O counters, sampled while the sync
  // runs. It replaces the watcher count in the body — the count only moves once
  // files land, and the whole point of the body is to move earlier than that.
  /** A client whose change listener the test can fire, plus a mutable status so
   *  a series of renders can be driven with a moving byte count. */
  function rateClient(startedAt: number): {
    client: unknown
    fire: () => void
    progress: Record<string, unknown>
  } {
    let listener: (() => void) | undefined
    const progress: Record<string, unknown> = {
      done: 421,
      startedAt,
      ioReadBytes: 0,
      ioWriteBytes: 0,
    }
    const client = {
      ...(makeClient({
        clientName: 'client-1',
        busy: 'Syncing',
        busyCancellable: false,
      }) as object),
      status: {
        clientName: 'client-1',
        connection: 'connected',
        openedCount: 2,
        busy: 'Syncing',
        busyCancellable: false,
        syncProgress: progress,
      },
      onDidChange: vi.fn((fn: () => void) => {
        listener = fn
        return { dispose: vi.fn() }
      }),
    }
    return { client, fire: () => listener?.(), progress }
  }

  it('shows the p4 read rate in place of the watcher count', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { client, fire, progress } = rateClient(Date.now() - 5_000)
      const controller = new P4StatusBarController({ active: client } as never)
      controller.refresh()

      // Attached but nothing measured yet: a real zero, and the token is already
      // full width so the body doesn't change shape when the first byte lands.
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 000KB/s · 5s $(sync~spin)')

      progress['ioReadBytes'] = 0
      progress['ioWriteBytes'] = 0
      vi.advanceTimersByTime(1000)
      progress['ioReadBytes'] = 42 * 1024 ** 2
      progress['ioWriteBytes'] = 4096
      fire()
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 042MB/s · 6s $(sync~spin)')
      expect(mocks.item.tooltip).toContain('p4 process I/O: read 42MB, wrote 4KB')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds one token width while the rate changes, and never shows the disk count twice', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { client, progress } = rateClient(Date.now())
      const controller = new P4StatusBarController({ active: client } as never)
      controller.refresh()

      // A rate that crosses a tier boundary is the case a growing string would
      // make visible: the segment must keep its 7 characters throughout, so the
      // entries beside it never move.
      const bodies = [mocks.item.text.split(' · ')[1]!]
      for (const read of [900 * 1024, 42 * 1024 ** 2, 300 * 1024 ** 2, 900 * 1024 ** 2]) {
        progress['ioReadBytes'] = read
        vi.advanceTimersByTime(1000)
        bodies.push(mocks.item.text.split(' · ')[1]!)
        expect(mocks.item.text).not.toContain('disk +')
      }
      expect(bodies.map((body) => body.length)).toEqual([7, 7, 7, 7, 7])
      // …and the segments were genuinely different rates, not one frozen token.
      expect(new Set(bodies).size).toBeGreaterThan(1)
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('decays the rate to zero on the heartbeat once the transfer stops', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { client, progress } = rateClient(Date.now())
      const controller = new P4StatusBarController({ active: client } as never)
      controller.refresh()

      progress['ioReadBytes'] = 8 * 1024 ** 2
      vi.advanceTimersByTime(1000)
      expect(mocks.item.text).toContain('MB/s')
      // p4 goes quiet but the sync is still running: the window slides off the
      // stalled count with no new event from p4 at all — the heartbeat's repaint
      // is what moves it, exactly like the elapsed clock.
      vi.advanceTimersByTime(7000)
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 000KB/s · 8s $(sync~spin)')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the watcher count in the tooltip once the rate takes the body', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { client, fire, progress } = rateClient(Date.now())
      progress['diskWrites'] = 567
      const controller = new P4StatusBarController({ active: client } as never)
      controller.refresh()

      expect(mocks.item.text).toContain('000KB/s')
      expect(mocks.item.text).not.toContain('disk +567')
      expect(mocks.item.tooltip).toContain('Disk writes seen by the file watcher: 567')
      fire()
      expect(mocks.item.tooltip).toContain('Synced 421 files')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not difference a new run against the previous run’s totals', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { client, fire, progress } = rateClient(Date.now())
      const controller = new P4StatusBarController({ active: client } as never)
      controller.refresh()
      progress['ioReadBytes'] = 100 * 1024 ** 2
      fire()
      vi.advanceTimersByTime(1000)
      expect(mocks.item.text).toContain('MB/s')

      // A second sync of the same client: fresh (small) totals under a new
      // startedAt. The window has to be re-anchored on the new run — keeping the
      // old anchor would credit the new run with bytes the previous one moved.
      progress['ioReadBytes'] = 0
      progress['startedAt'] = Date.now()
      fire()
      progress['ioReadBytes'] = 50 * 1024 ** 2
      vi.advanceTimersByTime(1000)

      // 50MB over the new run's own 1s of window. Differenced against the old
      // run's 100MB sample 2s back it would read 025MB/s instead — the bogus
      // first-window figure this guard exists to prevent.
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 050MB/s · 1s $(sync~spin)')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // Which revision the run is pulling. The notification spells it out once and
  // is gone (or missed); the tooltip is where the question is asked afterwards,
  // so the target leads the readout — directly under the title line.
  it('names the sync target on the line under the title', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'client-1',
        busy: 'Syncing',
        busyCancellable: false,
        lastSyncSpec: '@4521',
        syncProgress: { done: 421, startedAt: Date.now() - 5_000 },
      }),
    } as never)
    controller.refresh()

    // Position, not just presence: it has to be the SECOND line, above the counts.
    expect(mocks.item.tooltip.split('\n')[1]).toBe('Target: changelist 4521')
    controller.dispose()
  })

  it('labels each spec form, keeping the ones that name themselves verbatim', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['#head', 'Target: the latest revision'],
      // The per-file force get: a real spec that is also the empty string, so a
      // truthiness test in the DTO or the label would drop the most common get.
      ['', 'Target: the selected files'],
      ['@4521', 'Target: changelist 4521'],
      ['#4', 'Target: #4'],
      ['@2026/08/01', 'Target: @2026/08/01'],
    ]
    for (const [spec, expected] of cases) {
      const controller = new P4StatusBarController({
        active: makeClient({
          clientName: 'client-1',
          busy: 'Syncing',
          busyCancellable: false,
          lastSyncSpec: spec,
          syncProgress: { done: 421, startedAt: Date.now() - 5_000 },
        }),
      } as never)
      controller.refresh()

      expect(mocks.item.tooltip.split('\n')[1]).toBe(expected)
      controller.dispose()
    }
  })

  it('shows no target line before the client has ever synced', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'client-1',
        busy: 'Syncing',
        busyCancellable: false,
        syncProgress: { done: 421, startedAt: Date.now() - 5_000 },
      }),
    } as never)
    controller.refresh()

    // Nothing claims a target that never happened — the counts keep the slot.
    expect(mocks.item.tooltip).not.toContain('Target:')
    expect(mocks.item.tooltip.split('\n')[1]).toBe('Synced 421 files')
    controller.dispose()
  })

  it('measures the write side too, so the rate survives the landing phase', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { client, fire, progress } = rateClient(Date.now() - 5_000)
      const controller = new P4StatusBarController({ active: client } as never)
      controller.refresh()
      expect(mocks.item.text).toContain('000KB/s')

      // The second half of a sync: p4 has stopped pulling from the server and is
      // writing what it staged into the workspace. A read-only rate reads
      // `000KB/s` here — "stalled" at the exact moment the disk is busiest, the
      // false signal this readout exists to remove.
      vi.advanceTimersByTime(1000)
      progress['ioWriteBytes'] = 8 * 1024 ** 2
      fire()

      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 008MB/s · 6s $(sync~spin)')
      // The two sides are still reported apart: the body's sum is not a claim
      // about which counter moved.
      expect(mocks.item.tooltip).toContain('p4 process I/O: read 0B, wrote 8MB')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the rate up while only the write side climbs, and decays once both stop', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { client, progress } = rateClient(Date.now())
      const controller = new P4StatusBarController({ active: client } as never)
      controller.refresh()

      // Read phase: 8MB pulled from the server, then the read counter freezes
      // there for the rest of the run.
      progress['ioReadBytes'] = 8 * 1024 ** 2
      vi.advanceTimersByTime(1000)
      expect(mocks.item.text).toContain('MB/s')

      // Landing phase: only the write side moves. Read-only, the window would
      // have slid off the frozen read count and reached `000KB/s` right here.
      for (let tick = 1; tick <= 7; tick++) {
        progress['ioWriteBytes'] = tick * 4 * 1024 ** 2
        vi.advanceTimersByTime(1000)
      }
      // 8MB read + 28MB written = 36MB cumulative; the window still holds the
      // 12MB sample from 6s back, so 24MB / 6s.
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 004MB/s · 8s $(sync~spin)')

      // Both counters flat now — the sync is genuinely quiet, so the token goes
      // to zero on the heartbeat alone, exactly like the read-only case.
      vi.advanceTimersByTime(7000)
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 000KB/s · 15s $(sync~spin)')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('wins over scanProgress when both are in flight', () => {
    // A sync triggers a refresh, which can overlap the reconcile scan; the sync
    // count is the more actionable number, so it takes the slot.
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'client-1',
        busy: 'Syncing',
        busyCancellable: false,
        scanProgress: { done: 3, pending: 9, driftFound: 1, startedAt: Date.now() },
        syncProgress: { done: 7, startedAt: Date.now() },
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.text).toBe('$(server) client-1: Syncing 7 · 0s $(sync~spin)')
    controller.dispose()
  })

  it('advances the elapsed clock on a 1s heartbeat while the sync is quiet, and stops it when the sync ends', () => {
    // p4 --parallel can hold stdout for a minute or more between bursts; the
    // elapsed clock is computed at render time, so without a heartbeat both the
    // count and the clock would freeze for the whole gap. The heartbeat
    // re-renders every second so the clock keeps moving (the count only moves
    // when p4 actually prints a line).
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const status = {
        clientName: 'client-1',
        busy: 'Syncing',
        busyCancellable: false,
        syncProgress: { done: 421, startedAt: Date.now() - 5_000 },
      }
      const controller = new P4StatusBarController({
        active: { status, onDidChange: vi.fn(() => ({ dispose: vi.fn() })) },
      } as never)
      controller.refresh()
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 5s $(sync~spin)')

      // No new line from p4 (the count stays at 421), but the heartbeat ticks —
      // the clock must advance on its own. advanceTimersByTime moves both the
      // interval timer and the fake Date clock.
      vi.advanceTimersByTime(3_000)
      expect(mocks.item.text).toBe('$(server) client-1: Syncing 421 · 8s $(sync~spin)')

      // Sync ends (syncProgress cleared): the next tick stops the heartbeat, so
      // no further renders happen on the timer.
      delete (status as Record<string, unknown>).syncProgress
      vi.advanceTimersByTime(1_000)
      const textAfterClear = mocks.item.text
      vi.advanceTimersByTime(6_000)
      expect(mocks.item.text).toBe(textAfterClear)
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('truncateClientName', () => {
  it('returns short names unchanged', () => {
    expect(truncateClientName('ws_xyz')).toBe('ws_xyz')
  })

  it('returns exactly-10-char names unchanged', () => {
    expect(truncateClientName('abcdefghij')).toBe('abcdefghij')
  })

  it('keeps a tail that already lands on a word boundary', () => {
    expect(truncateClientName('testuser_dev_branch_xyz')).toBe('…branch_xyz')
  })

  it('extends forward to the next underscore when cut mid-word', () => {
    expect(truncateClientName('main_ws_testuser')).toBe('…testuser')
  })

  it('falls back to the hard cut when the extended tail is too short', () => {
    expect(truncateClientName('abcdefgh_ab')).toBe('…bcdefgh_ab')
  })

  it('hard-cuts a name with no underscore', () => {
    expect(truncateClientName('abcdefghijklmnop')).toBe('…ghijklmnop')
  })

  it('strips a leading underscore from the tail', () => {
    expect(truncateClientName('123456789_testuserX')).toBe('…testuserX')
  })
})

describe('formatScanElapsed', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatScanElapsed(0)).toBe('0s')
    expect(formatScanElapsed(59_000)).toBe('59s')
  })

  it('formats minute-plus durations as `m s`', () => {
    expect(formatScanElapsed(60_000)).toBe('1m 0s')
    expect(formatScanElapsed(61_000)).toBe('1m 1s')
    expect(formatScanElapsed(3_661_000)).toBe('61m 1s')
  })
})

describe('syncTargetLabel', () => {
  it('names the head and the per-file forms in words', () => {
    expect(syncTargetLabel('#head')).toBe('the latest revision')
    // What the revision prompt hands over is whatever was typed.
    expect(syncTargetLabel('#HEAD')).toBe('the latest revision')
    // The empty spec is the per-file force get — a real spec that happens to be
    // falsy, so the label must key off identity, not truthiness.
    expect(syncTargetLabel('')).toBe('the selected files')
  })

  it('labels a numeric changelist spec', () => {
    expect(syncTargetLabel('@4521')).toBe('changelist 4521')
  })

  it('passes through specs that already name themselves', () => {
    // A revision number and a date spec are their own clearest names; the label
    // must not invent a longer one. `@2026/08/01` is not a changelist.
    expect(syncTargetLabel('#4')).toBe('#4')
    expect(syncTargetLabel('@2026/08/01')).toBe('@2026/08/01')
  })
})

describe('P4StatusBarController scan progress', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.command = ''
    mocks.item.showProgress = undefined
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.revItem.text = ''
    mocks.revItem.tooltip = ''
    mocks.revItem.command = ''
    mocks.revItem.show.mockClear()
    mocks.revItem.hide.mockClear()
    mocks.activeEditor = undefined
    mocks.editorListener = undefined
  })

  it('renders the scan counts with the spinner at the end and a full tooltip', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'testuser_dev_branch_xyz',
        busy: 'Scanning workspace',
        busyCancellable: true,
        scanProgress: {
          done: 3,
          pending: 9,
          currentDir: 'Content/Characters/Hero',
          driftFound: 47,
          startedAt: Date.now() - 12_000,
        },
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.text).toBe('$(server) …branch_xyz: 3/12 $(sync~spin)')
    expect(mocks.item.text.endsWith('$(sync~spin)')).toBe(true)
    expect(mocks.item.showProgress).toBeUndefined()
    expect(mocks.item.tooltip).toContain('Scanning workspace testuser_dev_branch_xyz')
    expect(mocks.item.tooltip).toContain('Scanned 3 directories / 9 pending')
    expect(mocks.item.tooltip).toContain('Current: Content/Characters/Hero')
    expect(mocks.item.tooltip).toContain('Found 47 drift files · 12s elapsed')
    expect(mocks.item.tooltip).toContain('\n\nClick to cancel')
    expect(mocks.item.command).toBe('perforce.cancelBusy')
    controller.dispose()
  })

  it('keeps the graph command and omits the cancel line when not cancellable', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'testuser_dev_branch_xyz',
        busy: 'Scanning workspace',
        busyCancellable: false,
        scanProgress: { done: 3, pending: 9, driftFound: 0, startedAt: Date.now() },
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.command).toBe('perforce-graph.view')
    expect(mocks.item.tooltip).not.toContain('Click to cancel')
    controller.dispose()
  })

  it('renders the root label when currentDir is "."', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'client-1',
        busy: 'Scanning workspace',
        busyCancellable: false,
        scanProgress: {
          done: 1,
          pending: 2,
          currentDir: '.',
          driftFound: 0,
          startedAt: Date.now(),
        },
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.tooltip).toContain('Current: workspace root')
    controller.dispose()
  })

  it('omits the current line entirely when currentDir is absent', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'client-1',
        busy: 'Scanning workspace',
        busyCancellable: false,
        scanProgress: { done: 1, pending: 2, driftFound: 0, startedAt: Date.now() },
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.tooltip).not.toContain('Current:')
    controller.dispose()
  })

  it('non-scan busy falls back to the label with the spinner at the end', () => {
    const controller = new P4StatusBarController({
      active: makeClient({
        clientName: 'testuser_dev_branch_xyz',
        busy: 'Syncing',
        busyCancellable: false,
      }),
    } as never)
    controller.refresh()

    expect(mocks.item.text).toBe('$(server) …branch_xyz: Syncing… $(sync~spin)')
    expect(mocks.item.text.endsWith('$(sync~spin)')).toBe(true)
    expect(mocks.item.showProgress).toBeUndefined()
    expect(mocks.item.tooltip).toBe('Syncing')
    controller.dispose()
  })

  it('idle state truncates the client name and clears showProgress', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ clientName: 'testuser_dev_branch_xyz' }),
    } as never)
    controller.refresh()

    expect(mocks.item.text).toBe('$(server) …branch_xyz 2')
    expect(mocks.item.showProgress).toBeUndefined()
    controller.dispose()
  })

  it('idle tooltip keeps the full client name', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ clientName: 'testuser_dev_branch_xyz' }),
    } as never)
    controller.refresh()

    expect(mocks.item.tooltip).toContain('Perforce: testuser_dev_branch_xyz · 2 opened')
    expect(mocks.item.tooltip).not.toContain('…branch_xyz')
    controller.dispose()
  })

  it('idle tooltip still names the last pull, between the header and the action hint', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ clientName: 'client-1', lastSyncSpec: '@4521' }),
    } as never)
    controller.refresh()

    // The target deliberately outlives its run: the notification that announced
    // it is gone by the time the user asks "which changelist did I just get?".
    // The action hint stays last, as in the sync branch.
    expect(mocks.item.tooltip).toBe(
      'Perforce: client-1 · 2 opened\nLast pull: changelist 4521\nOpen Perforce Graph',
    )
    controller.dispose()
  })

  it('idle tooltip shows no last-pull line for a client that never synced', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ clientName: 'client-1' }),
    } as never)
    controller.refresh()

    expect(mocks.item.tooltip).not.toContain('Last pull:')
    expect(mocks.item.tooltip.split('\n')).toHaveLength(2)
    controller.dispose()
  })

  it('offline and not-logged-in states truncate the client name', () => {
    const offline = new P4StatusBarController({
      active: makeClient({ clientName: 'testuser_dev_branch_xyz', connection: 'offline' }),
    } as never)
    offline.refresh()
    expect(mocks.item.text).toBe('$(server) …branch_xyz (offline)')
    offline.dispose()

    const notLoggedIn = new P4StatusBarController({
      active: makeClient({ clientName: 'testuser_dev_branch_xyz', connection: 'not-logged-in' }),
    } as never)
    notLoggedIn.refresh()
    expect(mocks.item.text).toBe('$(server) …branch_xyz (not logged in)')
    notLoggedIn.dispose()
  })
})
