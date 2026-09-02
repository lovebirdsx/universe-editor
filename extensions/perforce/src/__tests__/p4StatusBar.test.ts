/**
 * The behind item must only appear once a behind-check has really run:
 * `undefined` ("never checked") and `0` ("checked, nothing to get") both hide
 * it, and disconnection hides it even if a stale count survives — the count is
 * a claim about the server, so it can't be rendered while offline.
 *
 * The revision chip (`#have / #head`) tracks the active editor: non-file
 * schemes, files outside every client root, and the NOT_CONTROLLED fstat
 * sentinel all hide it; `haveRev: 'none'` (open-for-add) renders the "new"
 * form; a lower have than head renders the behind form and wires
 * `perforce.syncLatest`.
 *
 * `setVisible(false)` is the mixed-workspace gate (selection moved to another
 * provider): all three items hide and stay hidden across refresh, tab switches
 * and in-flight fstat completions.
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
    behindItem: makeItem(),
    revItem: makeItem(),
    activeEditor: undefined as { document: { uri: unknown } } | undefined,
    editorListener: undefined as ((e: unknown) => void) | undefined,
  }
})

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: vi.fn((_alignment: unknown, priority: number) =>
      priority === 100 ? mocks.item : priority === 80 ? mocks.revItem : mocks.behindItem,
    ),
    onDidChangeActiveTextEditor: vi.fn((listener: (e: unknown) => void) => {
      mocks.editorListener = listener
      return { dispose: vi.fn() }
    }),
    getActiveTextEditor: vi.fn(() => Promise.resolve(mocks.activeEditor)),
  },
}))

const { P4StatusBarController, truncateClientName, formatScanElapsed } =
  await import('../p4StatusBar.js')
const { localize } = await import('../nls.js')

function makeClient(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: {
      clientName: 'client-1',
      connection: 'connected',
      openedCount: 2,
      syncBehindCount: undefined,
      busy: undefined,
      busyCancellable: false,
      ...overrides,
    },
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    fstat: vi.fn(async () => undefined),
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

describe('P4StatusBarController behind item', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.command = ''
    mocks.item.showProgress = undefined
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.behindItem.text = ''
    mocks.behindItem.tooltip = ''
    mocks.behindItem.command = ''
    mocks.behindItem.show.mockClear()
    mocks.behindItem.hide.mockClear()
    mocks.revItem.text = ''
    mocks.revItem.tooltip = ''
    mocks.revItem.command = ''
    mocks.revItem.show.mockClear()
    mocks.revItem.hide.mockClear()
    mocks.activeEditor = undefined
    mocks.editorListener = undefined
  })

  it('hides the behind item until the first behind-check completes', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ syncBehindCount: undefined }),
    } as never)
    controller.refresh()

    expect(mocks.behindItem.hide).toHaveBeenCalled()
    expect(mocks.behindItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('hides the behind item when the client is up to date', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ syncBehindCount: 0 }),
    } as never)
    controller.refresh()

    expect(mocks.behindItem.hide).toHaveBeenCalled()
    expect(mocks.behindItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('shows the count and wires the whole-scope sync command', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ syncBehindCount: 12 }),
    } as never)
    controller.refresh()

    expect(mocks.behindItem.show).toHaveBeenCalled()
    expect(mocks.behindItem.text).toContain('$(cloud-download)')
    expect(mocks.behindItem.text).toContain('12')
    // Scope-level, NOT perforce.syncLatest: that one falls back to the active
    // editor's file, so this item would fetch one file while promising 12.
    expect(mocks.behindItem.command).toBe('perforce.syncScope')
    controller.dispose()
  })

  it('marks a capped count as a floor, not a total', () => {
    // The count passed the decoration cap: the number is a floor, and the
    // status bar must say so — a bare "500" would claim an exactness the
    // scan never established.
    const controller = new P4StatusBarController({
      active: makeClient({ syncBehindCount: 500, syncBehindCapped: true }),
    } as never)
    controller.refresh()

    const cappedText = localize('perforce.status.behind.capped', 'more than {0} files behind', {
      0: 500,
    })
    expect(mocks.behindItem.show).toHaveBeenCalled()
    expect(mocks.behindItem.text).toContain('500')
    expect(mocks.behindItem.text).toContain(cappedText)
    controller.dispose()
  })

  it('renders an exact count without the capped wording', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ syncBehindCount: 12, syncBehindCapped: false }),
    } as never)
    controller.refresh()

    const exactText = localize('perforce.status.behind', '{0} files behind', { 0: 12 })
    expect(mocks.behindItem.show).toHaveBeenCalled()
    expect(mocks.behindItem.text).toContain(exactText)
    controller.dispose()
  })

  it('hides the behind item while disconnected even if a count survives', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ connection: 'offline', syncBehindCount: 12 }),
    } as never)
    controller.refresh()

    expect(mocks.behindItem.hide).toHaveBeenCalled()
    expect(mocks.behindItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps the behind item visible while the main item is busy', () => {
    const controller = new P4StatusBarController({
      active: makeClient({ busy: 'Syncing', syncBehindCount: 12 }),
    } as never)
    controller.refresh()

    // The main item took the busy early-return path…
    expect(mocks.item.text).toContain('Syncing')
    // …yet the behind item was already rendered before it.
    expect(mocks.behindItem.show).toHaveBeenCalled()
    expect(mocks.behindItem.text).toContain('12')
    controller.dispose()
  })

  it('hides both items without an active client', () => {
    const controller = new P4StatusBarController({ active: undefined } as never)
    controller.refresh()

    expect(mocks.item.hide).toHaveBeenCalled()
    expect(mocks.item.show).not.toHaveBeenCalled()
    expect(mocks.behindItem.hide).toHaveBeenCalled()
    expect(mocks.behindItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })
})

describe('P4StatusBarController revision chip', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.command = ''
    mocks.item.showProgress = undefined
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.behindItem.text = ''
    mocks.behindItem.tooltip = ''
    mocks.behindItem.command = ''
    mocks.behindItem.show.mockClear()
    mocks.behindItem.hide.mockClear()
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
    // The chip describes ONE file, so it stays file-scoped — and must say so:
    // promising the whole scope here is what made a one-file get look broken.
    expect(mocks.revItem.command).toBe('perforce.syncLatest')
    expect(mocks.revItem.tooltip).toContain('this file')
    expect(mocks.revItem.tooltip).not.toContain('whole scope')
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
    mocks.behindItem.text = ''
    mocks.behindItem.tooltip = ''
    mocks.behindItem.command = ''
    mocks.behindItem.show.mockClear()
    mocks.behindItem.hide.mockClear()
    mocks.revItem.text = ''
    mocks.revItem.tooltip = ''
    mocks.revItem.command = ''
    mocks.revItem.show.mockClear()
    mocks.revItem.hide.mockClear()
    mocks.activeEditor = undefined
    mocks.editorListener = undefined
  })

  it('hides all three items when the selection moves to another provider', () => {
    const controller = new P4StatusBarController(makeManager() as never)
    controller.setVisible(false)

    expect(mocks.item.hide).toHaveBeenCalled()
    expect(mocks.behindItem.hide).toHaveBeenCalled()
    expect(mocks.revItem.hide).toHaveBeenCalled()
    controller.dispose()
  })

  it('refresh and tab switches do not re-show the items while hidden', () => {
    const controller = new P4StatusBarController(
      makeManager({ active: makeClient({ syncBehindCount: 12 }) }) as never,
    )
    controller.setVisible(false)
    mocks.item.show.mockClear()

    controller.refresh()
    mocks.editorListener?.(fileEditor('/D:/p4ws/main/src/a.txt'))
    expect(mocks.item.show).not.toHaveBeenCalled()
    expect(mocks.behindItem.show).not.toHaveBeenCalled()
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
    const controller = new P4StatusBarController(
      makeManager({ active: makeClient({ syncBehindCount: 12 }) }) as never,
    )
    controller.setVisible(false)
    mocks.item.show.mockClear()
    mocks.behindItem.show.mockClear()

    controller.setVisible(true)
    expect(mocks.item.show).toHaveBeenCalled()
    expect(mocks.behindItem.show).toHaveBeenCalled()
    controller.dispose()
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

describe('P4StatusBarController scan progress', () => {
  beforeEach(() => {
    mocks.item.text = ''
    mocks.item.tooltip = ''
    mocks.item.command = ''
    mocks.item.showProgress = undefined
    mocks.item.show.mockClear()
    mocks.item.hide.mockClear()
    mocks.behindItem.text = ''
    mocks.behindItem.tooltip = ''
    mocks.behindItem.command = ''
    mocks.behindItem.show.mockClear()
    mocks.behindItem.hide.mockClear()
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
