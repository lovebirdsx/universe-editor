import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import {
  GraphSyncLedger,
  lookupSyncPoint,
  NO_REGRESSION,
  scopeCovers,
  scopeIdentity,
  type SyncLedgerRecord,
} from '../graphSyncLedger.js'

const ROOT = 'X:/p4ws/main'
const CLIENT_ROOT = { path: ROOT, isDirectory: true }
const SRC = { path: `${ROOT}/src`, isDirectory: true }
const SRC_A = { path: `${ROOT}/src/a.txt`, isDirectory: false }
const SRC_B = { path: `${ROOT}/src/b.txt`, isDirectory: false }
const OTHER = { path: `${ROOT}/other`, isDirectory: true }

function record(
  paths: SyncLedgerRecord['paths'],
  change: string,
  at: number,
  extra: Partial<SyncLedgerRecord> = {},
): SyncLedgerRecord {
  return { clientRoot: ROOT, paths, change, source: 'sync', at, complete: true, ...extra }
}

let dir: string

beforeEach(() => {
  dir = mkTempDir('p4-ledger-')
})

describe('scopeCovers', () => {
  it('covers a path inside a selected directory, at any depth', () => {
    expect(scopeCovers([SRC], [SRC_A])).toBe(true)
    expect(scopeCovers([SRC], [{ path: `${ROOT}/src/deep/x.ts`, isDirectory: false }])).toBe(true)
  })

  it('is boundary aware — a sibling prefix is not covered', () => {
    expect(scopeCovers([SRC], [{ path: `${ROOT}/src2/a.txt`, isDirectory: false }])).toBe(false)
  })

  it('does not treat a wider directory as covered by a narrower one', () => {
    expect(scopeCovers([SRC], [CLIENT_ROOT])).toBe(false)
  })

  it('covers only the identical file for a file scope', () => {
    expect(scopeCovers([SRC_A], [SRC_A])).toBe(true)
    expect(scopeCovers([SRC_A], [SRC_B])).toBe(false)
    expect(scopeCovers([SRC_A], [SRC])).toBe(false)
  })

  it('requires every path of the inner scope to be covered, not just one', () => {
    expect(scopeCovers([SRC], [SRC_A, OTHER])).toBe(false)
    expect(scopeCovers([SRC, OTHER], [SRC_A, OTHER])).toBe(true)
  })
})

describe('lookupSyncPoint', () => {
  it('answers with a record for the very same scope', () => {
    const answer = lookupSyncPoint([record([SRC], '4521', 100)], ROOT, [SRC])
    expect(answer?.record.change).toBe('4521')
    expect(answer?.widerScope).toBe(false)
  })

  it('falls back to a wider scope and labels the answer', () => {
    const answer = lookupSyncPoint([record([CLIENT_ROOT], '4521', 100)], ROOT, [SRC])
    expect(answer?.record.change).toBe('4521')
    expect(answer?.widerScope).toBe(true)
  })

  it('never answers from a NARROWER record', () => {
    expect(lookupSyncPoint([record([SRC_A], '4521', 100)], ROOT, [SRC])).toBeUndefined()
  })

  it('takes the newest record by timestamp, not the most specific scope', () => {
    // `sync src@4560` ran AFTER the wider `sync root@4520` — the answer for
    // src/a.txt is 4560, and a "most specific wins" rule would report 4520.
    const answer = lookupSyncPoint(
      [record([SRC], '4560', 200), record([CLIENT_ROOT], '4520', 100)],
      ROOT,
      [SRC_A],
    )
    expect(answer?.record.change).toBe('4560')
  })

  it('lets the newest wider record beat an older narrower one', () => {
    const answer = lookupSyncPoint(
      [record([SRC_A], '4520', 100), record([SRC], '4560', 200)],
      ROOT,
      [SRC_A],
    )
    expect(answer?.record.change).toBe('4560')
    expect(answer?.widerScope).toBe(true)
  })

  it("does not call a nested selection's exact answer an upper bound", () => {
    // The get covered `src`; the tab asks about `src` PLUS a file inside it, so
    // every path the record was built from is covered by the question and the
    // changelist is exact — reporting it as an upper bound would be a false
    // caveat on a precise answer.
    const answer = lookupSyncPoint([record([SRC], '4521', 100)], ROOT, [SRC, SRC_A])
    expect(answer?.record.change).toBe('4521')
    expect(answer?.widerScope).toBe(false)
  })

  it('ignores records belonging to another client', () => {
    const foreign: SyncLedgerRecord = {
      ...record([CLIENT_ROOT], '4521', 100),
      clientRoot: 'X:/p4ws/other',
    }
    expect(lookupSyncPoint([foreign], ROOT, [SRC])).toBeUndefined()
  })

  it('folds the drive-letter case, matching the shared scope key', () => {
    // `norm` folds the separators and the drive letter on every host; the REST of
    // the path folds only where the filesystem is case-insensitive (`scopeKey`),
    // so `x:/P4WS/MAIN/src` and `X:/p4ws/main/src` name one directory there and
    // two on linux. Asserting the win32/macOS answer unconditionally is what let
    // this pass locally and fail on CI.
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    const answer = lookupSyncPoint(
      [record([{ path: 'x:/P4WS/MAIN/src', isDirectory: true }], '4521', 100)],
      ROOT,
      [SRC],
    )
    if (insensitive) {
      expect(answer?.record.change).toBe('4521')
    } else {
      expect(answer).toBeUndefined()
    }
  })

  it('folds the drive letter and the separators on every host', () => {
    // The half of the key that does NOT follow the host, so it holds on the linux
    // CI too: a backslashed spelling with a lower-cased drive letter names the
    // same scope as the canonical one. Both branches of the containment check go
    // through the folded form — equality here, the `dir/` boundary below.
    const same = lookupSyncPoint(
      [record([{ path: 'x:\\p4ws\\main\\src', isDirectory: true }], '4521', 100)],
      ROOT,
      [SRC],
    )
    expect(same?.record.change).toBe('4521')
    expect(same?.widerScope).toBe(false)

    const wider = lookupSyncPoint(
      [record([{ path: 'x:\\p4ws\\main', isDirectory: true }], '4522', 100)],
      ROOT,
      [SRC],
    )
    expect(wider?.record.change).toBe('4522')
    expect(wider?.widerScope).toBe(true)
  })
})

describe('scopeIdentity', () => {
  it('ignores path order', () => {
    expect(scopeIdentity([SRC_A, OTHER])).toBe(scopeIdentity([OTHER, SRC_A]))
  })

  it('separates a directory scope from a file scope on the same path', () => {
    expect(scopeIdentity([SRC])).not.toBe(scopeIdentity([{ ...SRC, isDirectory: false }]))
  })
})

describe('GraphSyncLedger', () => {
  it('records one fact per scope, keeping the newest', () => {
    const ledger = GraphSyncLedger.open(join(dir, 'sub'))!
    ledger.record(record([SRC], '4520', 100))
    ledger.record(record([SRC], '4560', 200))
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('4560')
    const stored = JSON.parse(readFileSync(join(dir, 'sub', 'graphSyncLedger.json'), 'utf8')) as {
      records: unknown[]
    }
    expect(stored.records).toHaveLength(1)
  })

  it('survives a reopen, so a second window sees the first window gets', () => {
    GraphSyncLedger.open(dir)!.record(record([SRC], '4521', 100))
    const reopened = GraphSyncLedger.open(dir)!
    expect(reopened.lookup(ROOT, [SRC_A])?.record.change).toBe('4521')
  })

  it('merges records written by another window instead of dropping them', () => {
    const first = GraphSyncLedger.open(dir)!
    first.record(record([SRC], '4521', 100))
    const second = GraphSyncLedger.open(dir)!
    second.record(record([OTHER], '4560', 200))
    expect(first.lookup(ROOT, [SRC])?.record.change).toBe('4521')
    expect(second.lookup(ROOT, [SRC])?.record.change).toBe('4521')
    expect(second.lookup(ROOT, [OTHER])?.record.change).toBe('4560')
  })

  it('sees a record another window wrote after this one loaded', () => {
    // Two live windows: B loaded while the file was still empty and never writes,
    // so only a re-read can show it A's get. `lookup` is the read path the graph
    // actually uses, so that is where the sharing has to hold.
    const a = GraphSyncLedger.open(dir)!
    const b = GraphSyncLedger.open(dir)!
    expect(b.lookup(ROOT, [SRC])).toBeUndefined()
    a.record(record([SRC], '4521', 100))
    expect(b.lookup(ROOT, [SRC])?.record.change).toBe('4521')
  })

  it('lets a queried "nothing synced" outrank an older wider record', () => {
    // The wide record claims the whole client is at 4560 while a query answered
    // that `src` has nothing synced at all. Deleting just this scope's own record
    // would let the wide one put 4560 back on the badge on the next load — the
    // answer the user asked for, silently undone.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '4560', 100))
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('4560')

    ledger.recordEmpty(ROOT, [SRC], 200, 'query')
    expect(ledger.lookup(ROOT, [SRC])).toBeUndefined()
    // The wide record goes with it: it claimed `src` (along with everything else)
    // is at 4560, and the server just said `src` has nothing synced. Both cannot
    // be true, and the wide record is the one that would otherwise keep answering
    // — with an unqualified, "exact" 4560 — for the whole client.
    expect(ledger.lookup(ROOT, [CLIENT_ROOT])).toBeUndefined()
    expect(ledger.lookup(ROOT, [OTHER])).toBeUndefined()
  })

  it('retires a wider record a newer get reached into without re-covering it', () => {
    // The over-report this rule exists for: the whole client is recorded at 4522,
    // then one file inside it is got BACK to an older revision. The wide record's
    // claim is no longer true, and nothing here says where the client's other
    // files are, so the only honest answer for the client is "not known".
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '4522', 100))
    ledger.record(record([SRC_A], '4000', 200))
    expect(ledger.lookup(ROOT, [CLIENT_ROOT])).toBeUndefined()
    expect(ledger.lookup(ROOT, [SRC])).toBeUndefined()
    // The file itself is still answered, exactly.
    expect(ledger.lookup(ROOT, [SRC_A])?.record.change).toBe('4000')
  })

  it('keeps a wider record a newer get rolled forward past', () => {
    // The other direction, with the floor that makes it unambiguous: the get
    // targeted 4560, so nothing the client's 4522 talks about can have moved
    // backward. Keeping 4522 UNDER-reports (a file is newer than the badge says)
    // — the safe direction — while retiring it hands the whole client back to
    // "click to query" for a get that only ever moved one file up.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '4522', 100))
    ledger.record(record([SRC_A], '4560', 200, { floor: 4560 }))
    expect(ledger.lookup(ROOT, [CLIENT_ROOT])?.record.change).toBe('4522')
    expect(ledger.lookup(ROOT, [SRC_A])?.record.change).toBe('4560')
  })

  it('keeps a wider record a get to head reached into', () => {
    // A `#head` get only carries files forward — there is nothing newer to fetch
    // — so it can never be why a wider record went stale, whatever it read back.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '8793700', 100))
    ledger.record(record([SRC], '8793491', 200, { floor: NO_REGRESSION }))
    expect(ledger.lookup(ROOT, [CLIENT_ROOT])?.record.change).toBe('8793700')
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('8793491')
  })

  it('keeps a wider record a read-only query reached into', () => {
    // The shape a user hit against a real depot: the client is recorded at
    // 8793700, then the folder's own sync point is QUERIED and answers 8793491.
    // The lower number is not a contradiction — 8793700 never touched that
    // folder, and `#have` names the newest changelist that did — and a query
    // moves nothing, so it is no evidence that the client's claim went stale.
    // Retiring it here is what put `#? (click to query)` back on the client's
    // graph (and with it a fresh ~40s probe) after a query over a subfolder.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '8793700', 100))
    ledger.record(record([SRC], '8793491', 200, { source: 'query', floor: NO_REGRESSION }))

    expect(ledger.lookup(ROOT, [CLIENT_ROOT])?.record.change).toBe('8793700')
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('8793491')
  })

  it('keeps a wider record a get to its own changelist reached into', () => {
    // `@8793700` cannot leave the folder below 8793700, and reading back
    // 8793491 (the last change that touched it) is how a scope that the sync
    // point never touched always reads back. Not a regression.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '8793700', 100))
    ledger.record(record([SRC], '8793491', 200, { floor: 8793700 }))
    expect(ledger.lookup(ROOT, [CLIENT_ROOT])?.record.change).toBe('8793700')
  })

  it('retires a wider record a get behind its changelist reached into', () => {
    // A real regression: `@8793500` may leave the folder at 8793491, below what
    // the client's record claims, and nothing here says where the client's OTHER
    // files are now — so the client's answer is no longer known.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '8793700', 100))
    ledger.record(record([SRC], '8793491', 200, { floor: 8793500 }))
    expect(ledger.lookup(ROOT, [CLIENT_ROOT])).toBeUndefined()
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('8793491')
  })

  it('retires a partially overlapping record, not just a contained one', () => {
    const dirA = { path: `${ROOT}/a`, isDirectory: true }
    const dirB = { path: `${ROOT}/b`, isDirectory: true }
    const dirC = { path: `${ROOT}/c`, isDirectory: true }
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([dirA, dirB], '4522', 100))
    ledger.record(record([dirB, dirC], '4000', 200))
    expect(ledger.lookup(ROOT, [dirA, dirB])).toBeUndefined()
    expect(ledger.lookup(ROOT, [dirB, dirC])?.record.change).toBe('4000')
  })

  it('keeps a narrower record a newer wider get re-covered', () => {
    // The wide get moved everything the narrow record talked about, and wins the
    // lookup by being newer — so the narrow record can never be consulted again
    // and there is nothing to retire.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([SRC_A], '4522', 100))
    ledger.record(record([CLIENT_ROOT], '4500', 200))
    expect(ledger.lookup(ROOT, [SRC_A])?.record.change).toBe('4500')
    expect(ledger.lookup(ROOT, [SRC_A])?.widerScope).toBe(true)
  })

  it('leaves records for unrelated scopes alone', () => {
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([SRC], '4522', 100))
    ledger.record(record([OTHER], '4000', 200))
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('4522')
    expect(ledger.lookup(ROOT, [OTHER])?.record.change).toBe('4000')
  })

  it('does not let a record arriving late, but dated earlier, retire a newer one', () => {
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([SRC_A], '4522', 200))
    ledger.record(record([CLIENT_ROOT], '4000', 100))
    expect(ledger.lookup(ROOT, [SRC_A])?.record.change).toBe('4522')
  })

  it('lets a later get beat a queried "nothing synced"', () => {
    const ledger = GraphSyncLedger.open(dir)!
    ledger.recordEmpty(ROOT, [SRC], 100, 'query')
    ledger.record(record([SRC], '4521', 200))
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('4521')
  })

  it('answers nothing for an empty scope', () => {
    // An empty scope list is covered by every record (`scopeCovers`), so without
    // a guard an empty selection would answer with the client's newest record.
    const ledger = GraphSyncLedger.open(dir)!
    ledger.record(record([CLIENT_ROOT], '4522', 100))
    expect(ledger.lookup(ROOT, [])).toBeUndefined()
  })

  it('starts empty on a corrupt file instead of throwing', () => {
    writeFileSync(join(dir, 'graphSyncLedger.json'), '{ not json', 'utf8')
    const ledger = GraphSyncLedger.open(dir)!
    expect(ledger.lookup(ROOT, [SRC])).toBeUndefined()
    ledger.record(record([SRC], '4521', 100))
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('4521')
  })

  it('drops malformed records but keeps the well-formed ones', () => {
    writeFileSync(
      join(dir, 'graphSyncLedger.json'),
      JSON.stringify({
        version: 1,
        records: [
          { clientRoot: ROOT },
          // An empty path covers every absolute path there is once normalized
          // (`'' + '/'`), and an empty path LIST is covered-by-everything — one
          // hand-edited line would let any scope answer, so both are refused.
          { ...record([CLIENT_ROOT], '9999', 50), paths: [] },
          { ...record([CLIENT_ROOT], '9999', 50), paths: [{ path: '', isDirectory: true }] },
          record([SRC], '4521', 100),
        ],
      }),
      'utf8',
    )
    const ledger = GraphSyncLedger.open(dir)!
    expect(ledger.lookup(ROOT, [SRC])?.record.change).toBe('4521')
    expect(ledger.lookup(ROOT, [OTHER])).toBeUndefined()
  })

  it('is unbounded-proof: oldest records are evicted past the cap', () => {
    const ledger = GraphSyncLedger.open(dir)!
    for (let i = 0; i < 250; i++) {
      ledger.record(
        record([{ path: `${ROOT}/d${i}`, isDirectory: true }], String(4000 + i), 1000 + i),
      )
    }
    const stored = JSON.parse(readFileSync(join(dir, 'graphSyncLedger.json'), 'utf8')) as {
      records: unknown[]
    }
    expect(stored.records.length).toBe(200)
    expect(ledger.lookup(ROOT, [{ path: `${ROOT}/d0`, isDirectory: true }])).toBeUndefined()
    expect(ledger.lookup(ROOT, [{ path: `${ROOT}/d249`, isDirectory: true }])?.record.change).toBe(
      '4249',
    )
  })
})
