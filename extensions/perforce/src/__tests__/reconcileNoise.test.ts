/**
 * The reconcile noise layer is the whole "what does `perforce.reconcile.
 * excludeFolders` hide" decision in one pure module: the resolution (relative /
 * absolute / gone / unreadable), the coverage question the command layer puts to
 * the user, and the per-TARGET lift a confirmation grants. All of it is
 * edge-case-heavy and none of it needs p4, so it is tested here rather than
 * through the command layer.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_RECONCILE_NOISE,
  noiseCoversTarget,
  noiseExcludeArgs,
  noiseFor,
  noiseReach,
  normalizeNoiseTargets,
  planReconcileNoiseOperations,
  resolveReconcileExcludes,
  type ReconcileNoiseConfig,
} from '../reconcileNoise.js'
import type { SyncScopeTarget } from '../p4Filespec.js'

const ROOT = 'X:/ws'
const SRC = `${ROOT}/src`
const GEN = `${SRC}/gen`
const NESTED = `${GEN}/inner`

function dir(path: string): SyncScopeTarget {
  return { path, isDirectory: true }
}
function file(path: string): SyncScopeTarget {
  return { path, isDirectory: false }
}

/** A `stat` over what a test declares to exist: the listed directories answer as
 *  directories, the listed files as real (non-directory) entries, and everything
 *  else as "nobody could stat it" (gone / unreadable) — the three answers
 *  `resolveReconcileExcludes` tells apart. */
function statOf(
  entries: { readonly dirs?: readonly string[]; readonly files?: readonly string[] } = {},
): (path: string) => Promise<{ isDirectory: boolean } | undefined> {
  const dirs = new Set((entries.dirs ?? []).map((d) => d.toLowerCase()))
  const files = new Set((entries.files ?? []).map((f) => f.toLowerCase()))
  return async (path) => {
    const key = path.toLowerCase()
    if (dirs.has(key)) return { isDirectory: true }
    if (files.has(key)) return { isDirectory: false }
    return undefined
  }
}

describe('resolveReconcileExcludes', () => {
  it('joins a relative entry onto the workspace root and canonicalizes an absolute one', async () => {
    const stat = statOf({ dirs: [GEN, `${ROOT}/vendor`] })
    // The absolute entry keeps its own separator after the drive, whose case
    // folds (`norm`'s convention); the relative one inherits the root's spelling.
    expect(await resolveReconcileExcludes(['src/gen', `${ROOT}/vendor`], ROOT, stat)).toEqual({
      dirs: [GEN, 'x:/ws/vendor'],
      files: [],
    })
  })

  it('keeps the separator after the drive of an absolute entry, whatever it used', async () => {
    // Regression: dropping the drive head without re-adding its separator turned
    // `X:/ws/vendor` into `x:ws/vendor` — a rule that quietly excluded nothing.
    const stat = vi.fn(statOf({ dirs: [`${ROOT}/vendor`] }))
    expect(await resolveReconcileExcludes(['X:\\ws\\vendor'], ROOT, stat)).toEqual({
      dirs: ['x:/ws/vendor'],
      files: [],
    })
    // The stat saw the same (canonical) path the rule is stored as.
    expect(stat).toHaveBeenCalledWith('x:/ws/vendor')
  })

  it('accepts backslashes and mixed separators', async () => {
    const stat = vi.fn(statOf({ dirs: [`${ROOT}/src/gen`] }))
    expect(await resolveReconcileExcludes(['src\\gen'], ROOT, stat)).toEqual({
      dirs: [`${ROOT}/src/gen`],
      files: [],
    })
  })

  it('treats an entry nobody could stat as a DIRECTORY — the setting names folders', async () => {
    // A folder that does not exist YET (or that a probe could not read) is a
    // folder rule. A file-kind rule over `src/gone` would hide that one name and
    // nothing else: the day the folder appears, the scan walks its subtree and a
    // `p4 clean` deletes inside it — the setting's promise is about folders.
    const noise = await resolveReconcileExcludes(['src/gone'], ROOT, statOf())
    expect(noise).toEqual({ dirs: [`${ROOT}/src/gone`], files: [] })
  })

  it('shields the subtree of a folder that was configured before it existed', async () => {
    // The order the setting is written in must not decide its width: resolved
    // while `src/gen` is still absent, the rule still covers what lands there.
    const noise = await resolveReconcileExcludes(['src/gen'], ROOT, statOf())
    expect(noise).toEqual({ dirs: [GEN], files: [] })
    expect(noiseCoversTarget(noise, dir(GEN))).toBe(true)
    expect(noiseCoversTarget(noise, file(`${GEN}/born-later.txt`))).toBe(true)
  })

  it('keeps a path that IS a file as a file rule', async () => {
    // The other direction stays as narrow as it was: a real file named in the
    // setting is one entry, not a tree, so nothing is promoted to a directory.
    const noise = await resolveReconcileExcludes(
      ['notes.txt'],
      ROOT,
      statOf({
        files: [`${ROOT}/notes.txt`],
      }),
    )
    expect(noise).toEqual({ dirs: [], files: [`${ROOT}/notes.txt`] })
    expect(noiseCoversTarget(noise, file(`${ROOT}/notes.txt`))).toBe(true)
    expect(noiseCoversTarget(noise, file(`${ROOT}/notes.txt/inner`))).toBe(false)
  })

  it('drops entries that would address the root itself or escape it', async () => {
    const stat = vi.fn(statOf())
    expect(
      await resolveReconcileExcludes(['', '   ', '.', '..', '../outside'], ROOT, stat),
    ).toEqual(EMPTY_RECONCILE_NOISE)
    expect(stat).not.toHaveBeenCalled()
  })

  it('collapses nested directories and drops files a directory rule already hides', async () => {
    const noise = await resolveReconcileExcludes(
      ['src/gen', 'src/gen/inner', 'src/gen/keep.txt', 'notes.txt'],
      ROOT,
      statOf({ dirs: [GEN, NESTED], files: [`${GEN}/keep.txt`, `${ROOT}/notes.txt`] }),
    )
    expect(noise.dirs).toEqual([GEN])
    expect(noise.files).toEqual([`${ROOT}/notes.txt`])
  })

  it('folds a relative and an absolute spelling of one file where the host folds case', async () => {
    const noise = await resolveReconcileExcludes(
      ['notes.txt', `${ROOT}/notes.txt`],
      ROOT,
      statOf({ files: [`${ROOT}/notes.txt`] }),
    )
    // The relative entry keeps the workspace root's spelling while the absolute
    // one gets its drive lower-cased; `scopeKey` folds the rest only on a
    // case-insensitive host (see pathUtil).
    const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
    expect(noise.files).toHaveLength(caseInsensitive ? 1 : 2)
    expect(noise.files[0]).toBe(`${ROOT}/notes.txt`)
  })
})

describe('coverage and the per-target lift', () => {
  const noise: ReconcileNoiseConfig = { dirs: [GEN], files: [`${ROOT}/notes.txt`] }

  it('covers a directory the rules name, anything under it, and an exact file', () => {
    expect(noiseCoversTarget(noise, dir(GEN))).toBe(true)
    expect(noiseCoversTarget(noise, file(NESTED))).toBe(true)
    expect(noiseCoversTarget(noise, file(`${ROOT}/notes.txt`))).toBe(true)
    // A rule over a FILE does not cover the directory holding it: the rule hides
    // one entry, not the tree, so there is nothing to put to the user.
    expect(noiseCoversTarget(noise, dir(ROOT))).toBe(false)
    expect(noiseCoversTarget(noise, file(`${SRC}/other.txt`))).toBe(false)
  })

  it('lifts only the rules covering the confirmed target', () => {
    const lifted = noiseFor(noise, [dir(GEN)])
    expect(lifted).toEqual({ dirs: [], files: [`${ROOT}/notes.txt`] })
    // A NESTED rule the user did not name survives: they named the parent, and
    // the parent is not what the inner rule is about.
    const nested: ReconcileNoiseConfig = { dirs: [GEN, NESTED], files: [] }
    expect(noiseFor(nested, [dir(GEN)])).toEqual({ dirs: [NESTED], files: [] })
    expect(noiseFor(noise, [])).toEqual(noise)
  })
})

describe('noiseReach', () => {
  const noise: ReconcileNoiseConfig = { dirs: [GEN], files: [`${ROOT}/notes.txt`] }

  it('answers for a target whose own range a rule sits in — either way round', () => {
    expect(noiseReach(noise, [dir(SRC)])).toEqual({ rule: GEN, target: SRC })
    // The target itself is the shielded path: a rule above it counts too.
    expect(noiseReach(noise, [dir(GEN)])).toEqual({ rule: GEN, target: GEN })
    expect(noiseReach(noise, [file(`${GEN}/inner/a.txt`)])).toEqual({
      rule: GEN,
      target: `${GEN}/inner/a.txt`,
    })
  })

  it('answers for an exact file target a file rule names, and not for its siblings', () => {
    expect(noiseReach(noise, [file(`${ROOT}/notes.txt`)])).toEqual({
      rule: `${ROOT}/notes.txt`,
      target: `${ROOT}/notes.txt`,
    })
    // A file rule hides one entry, so an unrelated file target is not covered by
    // it — the safety valve every exact-file write relies on.
    expect(noiseReach(noise, [file(`${SRC}/other.txt`)])).toBeUndefined()
    expect(noiseReach(EMPTY_RECONCILE_NOISE, [dir(SRC)])).toBeUndefined()
  })
})

describe('normalizeNoiseTargets', () => {
  it('drops duplicates and entries nested under a selected directory', () => {
    expect(normalizeNoiseTargets([dir(SRC), file(`${SRC}/a.txt`), dir(SRC), file(NESTED)])).toEqual(
      [dir(SRC)],
    )
  })

  it('keeps a directory and the file of the same path (they are different questions)', () => {
    expect(normalizeNoiseTargets([dir(SRC), file(SRC)])).toEqual([dir(SRC), file(SRC)])
  })
})

describe('planReconcileNoiseOperations', () => {
  it('keeps the ordinary batch in ONE call, with nothing authorized', () => {
    const ops = planReconcileNoiseOperations([dir(SRC), file(`${ROOT}/keep.txt`)], {
      dirs: [GEN],
      files: [],
    })
    expect(ops).toEqual([
      {
        targets: [dir(SRC), file(`${ROOT}/keep.txt`)],
        confirmedTargets: [],
      },
    ])
  })

  it('splits the confirmed target out instead of widening its siblings', () => {
    // One call carries one exclusion list: running the parent and the confirmed
    // folder together would lift the rule for the parent too, which is the
    // "a confirmation silently widened the batch" failure.
    const ops = planReconcileNoiseOperations([dir(SRC), dir(GEN)], { dirs: [GEN], files: [] }, [
      dir(GEN),
    ])
    expect(ops).toEqual([
      { targets: [dir(SRC)], confirmedTargets: [] },
      { targets: [dir(GEN)], confirmedTargets: [dir(GEN)] },
    ])
  })

  it('keeps the confirmed target even when a selected parent covers it', () => {
    // The dialog offered a choice about the folder the user named; deduping it
    // away as "already inside the parent" would run the parent's rules over it
    // and silently ignore the answer.
    const ops = planReconcileNoiseOperations([dir(SRC), dir(GEN)], { dirs: [GEN], files: [] }, [
      dir(GEN),
    ])
    expect(ops?.flatMap((op) => op.targets)).toContainEqual(dir(GEN))
  })

  it('runs a confirmed target the rules do NOT cover in the plain group', () => {
    const ops = planReconcileNoiseOperations([dir(SRC)], { dirs: [GEN], files: [] }, [dir(SRC)])
    expect(ops).toEqual([{ targets: [dir(SRC)], confirmedTargets: [] }])
  })

  it('answers undefined only for an empty target list', () => {
    // The planner splits by POLICY; it does not drop a covered target — that is
    // the engine's or the carve's job (and the caller's gate is what asks the
    // user about a target the rules cover).
    expect(planReconcileNoiseOperations([], { dirs: [], files: [] })).toBeUndefined()
    expect(planReconcileNoiseOperations([file(NESTED)], { dirs: [GEN], files: [] })).toEqual([
      { targets: [file(NESTED)], confirmedTargets: [] },
    ])
  })

  it('drops a nested confirmed target from the bypass group as its own parent does', () => {
    const ops = planReconcileNoiseOperations([dir(GEN), file(NESTED)], { dirs: [GEN], files: [] }, [
      dir(GEN),
      file(NESTED),
    ])
    expect(ops).toEqual([{ targets: [dir(GEN)], confirmedTargets: [dir(GEN)] }])
  })
})

describe('noiseExcludeArgs', () => {
  /** The kind is carried by the FLAG, so a directory rule can never be read as a
   *  file rule — the failure that hides one name while the subtree keeps
   *  walking. The paths go over verbatim (no p4 escaping): the engine escapes at
   *  the boundary, so a name with `%` or `@` stays the name the user has. */
  it('spells each kind with its own flag, directories first, unescaped', () => {
    expect(noiseExcludeArgs({ dirs: [GEN], files: [`${ROOT}/notes.txt`] })).toEqual([
      '--exclude-dir',
      GEN,
      '--exclude-file',
      `${ROOT}/notes.txt`,
    ])
    expect(noiseExcludeArgs({ dirs: [`${ROOT}/a%b@c`], files: [] })).toEqual([
      '--exclude-dir',
      `${ROOT}/a%b@c`,
    ])
    expect(noiseExcludeArgs(EMPTY_RECONCILE_NOISE)).toEqual([])
  })
})
