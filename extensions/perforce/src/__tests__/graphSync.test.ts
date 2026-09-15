import { describe, expect, it } from 'vitest'
import {
  clSpecOf,
  directSyncPoint,
  graphSyncConfirmKind,
  graphSyncNeedsConfirm,
  resolveCommonClient,
  syncFloorOf,
} from '../graphSync.js'
import { NO_REGRESSION, contradictedBy, type SyncLedgerRecord } from '../graphSyncLedger.js'

describe('clSpecOf', () => {
  it('builds an @-spec from a bare changelist number', () => {
    expect(clSpecOf('4521')).toBe('@4521')
  })

  it('tolerates a leading @ and surrounding whitespace', () => {
    expect(clSpecOf('@4521')).toBe('@4521')
    expect(clSpecOf(' 4521 ')).toBe('@4521')
  })

  it('rejects anything that is not a changelist number', () => {
    expect(clSpecOf('')).toBeUndefined()
    expect(clSpecOf('abc')).toBeUndefined()
    expect(clSpecOf('12a')).toBeUndefined()
    expect(clSpecOf('#5')).toBeUndefined()
    expect(clSpecOf('@2026/01/01')).toBeUndefined()
  })
})

describe('graphSyncNeedsConfirm', () => {
  const file = { path: 'X:/ws/a.txt', isDirectory: false }
  const dir = { path: 'X:/ws/src', isDirectory: true }

  it('never confirms a single-file scope', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [file] })).toBe(false)
    expect(graphSyncNeedsConfirm({ scopePaths: [file], isLatest: false })).toBe(false)
  })

  it('confirms a directory scope', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [dir] })).toBe(true)
  })

  it('confirms a multi-path scope even when all are files', () => {
    expect(
      graphSyncNeedsConfirm({ scopePaths: [file, { path: 'X:/ws/b.txt', isDirectory: false }] }),
    ).toBe(true)
  })

  it('confirms when no explicit scope is given (the whole displayed range)', () => {
    expect(graphSyncNeedsConfirm({})).toBe(true)
    expect(graphSyncNeedsConfirm({ scopePaths: [] })).toBe(true)
  })

  it('skips the confirmation for the latest row (a get-latest equivalent)', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [dir], isLatest: true })).toBe(false)
    expect(graphSyncNeedsConfirm({ isLatest: true })).toBe(false)
  })

  it('skips the confirmation when the dialog already confirmed', () => {
    expect(graphSyncNeedsConfirm({ scopePaths: [dir, dir], confirmed: true })).toBe(false)
  })
})

describe('graphSyncConfirmKind', () => {
  const file = { path: 'X:/ws/a.txt', isDirectory: false }
  const dir = { path: 'X:/ws/src', isDirectory: true }

  // A force-get destroys uncollected local work whether or not it also moves
  // files in time, so every time-travel waiver must be inert. These four are
  // the complete set of waivers `graphSyncNeedsConfirm` knows.
  it('forces the confirmation past every time-travel waiver', () => {
    expect(graphSyncConfirmKind({ force: true })).toBe('force')
    expect(graphSyncConfirmKind({ force: true, isLatest: true })).toBe('force')
    expect(graphSyncConfirmKind({ force: true, confirmed: true })).toBe('force')
    expect(graphSyncConfirmKind({ force: true, scopePaths: [file] })).toBe('force')
    expect(graphSyncConfirmKind({ force: true, scopePaths: [dir, dir] })).toBe('force')
  })

  it('delegates to graphSyncNeedsConfirm when force is absent', () => {
    expect(graphSyncConfirmKind({ scopePaths: [file] })).toBe('none')
    expect(graphSyncConfirmKind({ isLatest: true })).toBe('none')
    expect(graphSyncConfirmKind({ confirmed: true })).toBe('none')
    expect(graphSyncConfirmKind({ scopePaths: [dir] })).toBe('timeTravel')
    expect(graphSyncConfirmKind({})).toBe('timeTravel')
  })

  it('treats an explicit false as absent', () => {
    expect(graphSyncConfirmKind({ force: false, scopePaths: [file] })).toBe('none')
  })
})

describe('resolveCommonClient', () => {
  const clientA = { root: 'X:/ws/a' }
  const clientB = { root: 'X:/ws/b' }
  // Longest-prefix style resolver: paths under clientA's or clientB's root
  // resolve to that client, anything else to nothing.
  const resolve = (p: string) =>
    p.startsWith('X:/ws/a') ? clientA : p.startsWith('X:/ws/b') ? clientB : undefined

  it('returns undefined for an empty path list', () => {
    expect(resolveCommonClient([], resolve)).toBeUndefined()
  })

  it('returns undefined when the first path resolves to nothing', () => {
    expect(resolveCommonClient(['Y:/else/f.txt', 'X:/ws/a/f.txt'], resolve)).toBeUndefined()
  })

  it('returns the owner when every path resolves to the same client', () => {
    expect(resolveCommonClient(['X:/ws/a/f.txt', 'X:/ws/a/src'], resolve)).toBe(clientA)
  })

  it('returns undefined when a later path resolves to a different client', () => {
    expect(resolveCommonClient(['X:/ws/a/f.txt', 'X:/ws/b/f.txt'], resolve)).toBeUndefined()
  })

  it('returns undefined when a later path resolves to nothing', () => {
    expect(resolveCommonClient(['X:/ws/a/f.txt', 'Y:/else/f.txt'], resolve)).toBeUndefined()
  })
})

describe('directSyncPoint', () => {
  const ROOT = 'X:/ws'
  const SRC = { path: 'X:/ws/src', isDirectory: true }
  const A_TXT = { path: 'X:/ws/src/a.txt', isDirectory: false }
  const OTHER = { path: 'X:/ws/other', isDirectory: true }
  const ROOT_DIR = { path: ROOT, isDirectory: true }

  /** The shape a row menu sends: the listing and the get are the same scope. */
  const sameScope = (scope: readonly { path: string; isDirectory: boolean }[]) =>
    directSyncPoint({
      change: '4522',
      getScope: scope,
      getClientRoot: ROOT,
      listed: { scope, clientRoot: ROOT },
      displayedClientRoot: ROOT,
    })

  it('answers the row changelist when the get covers the listing', () => {
    expect(sameScope([ROOT_DIR])).toEqual({ ok: true, change: '4522' })
    expect(sameScope([A_TXT])).toEqual({ ok: true, change: '4522' })
    // A get WIDER than the listing is the dialog case with every directory
    // picked: the row's changelist touched the listing, so it touched this too.
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [ROOT_DIR],
        getClientRoot: ROOT,
        listed: { scope: [SRC], clientRoot: ROOT },
        displayedClientRoot: ROOT,
      }),
    ).toEqual({ ok: true, change: '4522' })
  })

  it('refuses the dialog shape, where the picked directories are narrower', () => {
    // The listing covered the whole client; the user then picked one directory
    // from the dialog. That row may never have touched it, so its changelist is
    // not this scope's sync point — the one answer that must not be invented.
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [SRC],
        getClientRoot: ROOT,
        listed: { scope: [ROOT_DIR], clientRoot: ROOT },
        displayedClientRoot: ROOT,
      }),
    ).toEqual({ ok: false, reason: 'get scope does not cover the listing scope' })
  })

  it('is boundary aware — a sibling prefix is not covered', () => {
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [{ path: 'X:/ws/src2', isDirectory: true }],
        getClientRoot: ROOT,
        listed: { scope: [SRC], clientRoot: ROOT },
        displayedClientRoot: ROOT,
      }).ok,
    ).toBe(false)
  })

  it('does not let a directory get speak for a file it does not name, nor the reverse', () => {
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [OTHER],
        getClientRoot: ROOT,
        listed: { scope: [SRC], clientRoot: ROOT },
        displayedClientRoot: ROOT,
      }).ok,
    ).toBe(false)
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [A_TXT],
        getClientRoot: ROOT,
        listed: { scope: [SRC], clientRoot: ROOT },
        displayedClientRoot: ROOT,
      }).ok,
    ).toBe(false)
  })

  it('refuses an empty listing scope instead of reading it as "everything"', () => {
    // `scopeCovers(x, [])` is true and the graph resolves an empty `scopePaths`
    // as "no scope given" — both would turn a declaration of nothing into the
    // widest possible one.
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [ROOT_DIR],
        getClientRoot: ROOT,
        listed: { scope: [], clientRoot: ROOT },
        displayedClientRoot: ROOT,
      }),
    ).toEqual({ ok: false, reason: 'empty listing scope' })
  })

  it('refuses a whole-repo listing outright, however well it covers', () => {
    // `//...` is a depot-level query while every ledger coordinate is a host
    // path under the client root, so the containment check would compare the
    // client root with itself and pass without establishing anything: the row
    // may have touched a file only the client view's AltRoots map to. The get
    // here covers the claimed scope exactly, which is the shape that would
    // otherwise be accepted.
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [ROOT_DIR],
        getClientRoot: ROOT,
        listed: { scope: [ROOT_DIR], clientRoot: ROOT, wholeRepo: true },
        displayedClientRoot: ROOT,
      }),
    ).toEqual({ ok: false, reason: 'whole-repo listing' })
  })

  it('refuses without a listing scope at all', () => {
    expect(directSyncPoint({ change: '4522', getScope: [ROOT_DIR], getClientRoot: ROOT })).toEqual({
      ok: false,
      reason: 'no listing scope',
    })
  })

  it('refuses when the listing was of another client', () => {
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [ROOT_DIR],
        getClientRoot: ROOT,
        listed: { scope: [ROOT_DIR], clientRoot: 'X:/elsewhere' },
        displayedClientRoot: ROOT,
      }),
    ).toEqual({ ok: false, reason: 'listing from another client' })
  })

  it('refuses when the rows were not echoed as coming from this client', () => {
    // After a client switch the stale rows are still on screen, and both the
    // listing and the get resolve against the NEW graph client — so only this
    // echo can tell that the ids in hand belong to the old one.
    const base = {
      change: '4522',
      getScope: [ROOT_DIR],
      getClientRoot: ROOT,
      listed: { scope: [ROOT_DIR], clientRoot: ROOT },
    } as const
    expect(directSyncPoint(base)).toEqual({ ok: false, reason: 'no listing client echoed' })
    expect(directSyncPoint({ ...base, displayedClientRoot: 'X:/old' })).toEqual({
      ok: false,
      reason: 'rows not from this client',
    })
  })

  it('compares clients by slash-insensitive spelling on every platform', () => {
    // Both spellings name the same directory once normalized, and a workspace
    // that reports one form in its listing and another in its get still lands
    // on the same scope — the coverage check must not read that as "not
    // covered".
    expect(
      directSyncPoint({
        change: '4522',
        getScope: [{ path: 'X:\\WS', isDirectory: true }],
        getClientRoot: 'X:/ws',
        listed: { scope: [{ path: 'X:/WS/src', isDirectory: true }], clientRoot: 'X:/ws' },
        displayedClientRoot: 'X:/ws',
      }),
    ).toEqual({ ok: true, change: '4522' })
  })

  it('compares clients by the shared scope key, not by case', () => {
    // Case policy is per platform (see `scopeKey`), so this pair is ONE client
    // on win32/macOS and two on linux. Asserting a single branch is what lets a
    // test pass on the dev box and fail on CI — and the linux branch gets the
    // stricter assertion, since refusing is the safe direction here.
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    const decision = directSyncPoint({
      change: '4522',
      getScope: [{ path: 'X:/ws', isDirectory: true }],
      getClientRoot: 'X:/ws',
      listed: { scope: [{ path: 'X:/WS/src', isDirectory: true }], clientRoot: 'X:/WS' },
      displayedClientRoot: 'X:/ws',
    })
    expect(decision).toEqual(
      insensitive
        ? { ok: true, change: '4522' }
        : { ok: false, reason: 'listing from another client' },
    )
  })
})

describe('syncFloorOf', () => {
  it('bounds a get to head with NO_REGRESSION — nothing newer to fetch', () => {
    expect(syncFloorOf('#head', ['X:/ws/src/...'])).toBe(NO_REGRESSION)
    expect(syncFloorOf('#head', [])).toBe(NO_REGRESSION)
  })

  it('names its own changelist for an @CL get', () => {
    expect(syncFloorOf('@4521', ['X:/ws/src/...'])).toBe(4521)
  })

  it('reads the per-file revisions when the spec is empty, taking the oldest', () => {
    expect(syncFloorOf('', ['//depot/a.txt#3', '//depot/b.txt#7'])).toBe(3)
    expect(syncFloorOf('', ['//depot/a.txt#7', '//depot/b.txt#3'])).toBe(3)
  })

  it('answers NO_REGRESSION when an empty spec carries no revision at all', () => {
    // A bare path is a get-latest, and a get-latest cannot put a file back.
    expect(syncFloorOf('', ['//depot/a.txt#head'])).toBe(NO_REGRESSION)
    expect(syncFloorOf('', ['//depot/a.txt'])).toBe(NO_REGRESSION)
    expect(syncFloorOf('', ['//depot/a.txt#4', '//depot/b.txt#head'])).toBe(4)
  })

  it('stays conservative for a spec it cannot bound', () => {
    // A numbered `#4` in the spec itself, a date, anything else: the spec alone
    // does not say which old changelist that is, so the record claims the least.
    expect(syncFloorOf('#4', ['X:/ws/src/...'])).toBe(0)
    expect(syncFloorOf('@2026/08/01', ['X:/ws/src/...'])).toBe(0)
    expect(syncFloorOf('garbage', [])).toBe(0)
  })

  it('ignores a revision specifier in the middle of a filespec path', () => {
    // Escaped paths are the reason the sigil is matched at the END: `%23` is a
    // literal `#` in the file name and says nothing about revisions.
    expect(syncFloorOf('', ['//depot/a%23b.txt'])).toBe(NO_REGRESSION)
    expect(syncFloorOf('', ['//depot/a%23b.txt#3'])).toBe(3)
  })
})

describe('the floor keeps a wide record alive through a narrow get', () => {
  const wide = (): SyncLedgerRecord => ({
    clientRoot: 'X:/ws',
    paths: [{ path: 'X:/ws', isDirectory: true }],
    change: '8822042',
    source: 'sync',
    at: 1,
    complete: true,
    floor: NO_REGRESSION,
  })

  it('a plain get-latest of one subtree does not retire the workspace sync point', () => {
    // The whole-workspace get recorded `#8822042`; the user then gets a subtree.
    // `#head` moves files forward only, so it is evidence of nothing — retiring
    // the root record here is what left the graph at `#? (click to query)` for
    // good, since only the query button (tens of seconds over a wide scope) can
    // put the badge back.
    const floor = syncFloorOf('#head', ['X:/ws/Source/Client/...'])
    expect(floor).toBe(NO_REGRESSION)
    expect(
      contradictedBy(wide(), {
        paths: [{ path: 'X:/ws/Source/Client', isDirectory: true }],
        at: 2,
        floor,
      }),
    ).toBe(false)
  })

  it('a per-file get of its own revisions does not retire it either', () => {
    // The clobber remedy re-gets refused files with an empty spec, each filespec
    // carrying its own `#rev`. Those DO allow a step back, but only for the
    // bytes they name — and the old `0` here retired every wider record there is.
    const floor = syncFloorOf('', ['X:/ws/Source/Client/a.txt#3'])
    expect(floor).toBe(3)
    expect(
      contradictedBy(wide(), {
        paths: [{ path: 'X:/ws/Source/Client', isDirectory: true }],
        at: 2,
        floor,
      }),
    ).toBe(true)
  })

  it('still retires it when the get really can carry a file below the claim', () => {
    // A genuine time-travel get to `@8793700` over a subtree moves files that the
    // wide record says are at 8822042 — the honest answer is "not known".
    expect(
      contradictedBy(wide(), {
        paths: [{ path: 'X:/ws/Source/Client', isDirectory: true }],
        at: 2,
        floor: syncFloorOf('@8793700', ['X:/ws/Source/Client/...']),
      }),
    ).toBe(true)
  })
})
