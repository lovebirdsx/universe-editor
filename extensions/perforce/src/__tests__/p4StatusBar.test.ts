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

const { P4StatusBarController } = await import('../p4StatusBar.js')
const { localize } = await import('../nls.js')

function makeClient(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: {
      clientName: 'client-1',
      connection: 'connected',
      openedCount: 2,
      reconcileCount: 0,
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
