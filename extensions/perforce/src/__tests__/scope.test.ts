/**
 * 本地范围计算的**安全断言**：路径身份、入口覆盖、排除优先、洞的判定、两种「按目标取范围」
 * 形态与 spec 反解。
 *
 * 这些用例是从被删除的 `p4deltaScope.test.ts` / `scopeSnapshot.test.ts` 里**逐条迁移**过来
 * 的：它们守护的不是快照去掉了没有，而是「排除项不能被悄悄越过」这类判据，所以文件删掉、
 * 判据留下。
 *
 * 共享契约向量（`scope-contract.test.ts`）覆盖的是与 δ 对拍的那一层；这里覆盖的是编辑器
 * 自己的调用形态。
 */
import { describe, expect, it } from 'vitest'

import {
  canonicalLocalPath,
  entryCovers,
  isAbsoluteLocalPath,
  localPathKey,
  resolveScope,
  scopeCoversPath,
  scopeCoversTarget,
  scopeHasExcludeHoles,
  scopeIdentity,
  scopePartsWithin,
  scopeTargets,
  scopeTargetsWithin,
  targetsFromSpecs,
  type PathStyle,
  type ScopeView,
} from '../scope.js'
import { parseScopeConfig } from '../scopeConfig.js'

const SEP = process.platform === 'win32' ? '\\' : '/'
/** A windows-shaped path literal for the cases below: this suite runs on every
 *  platform, and the identity rule is platform-shaped (a drive letter on win32). */
const WINDOWS = process.platform === 'win32'
const ROOT = WINDOWS ? 'X:\\workspace' : '/workspace'
const SRC = `${ROOT}${SEP}src`
const GEN = `${SRC}${SEP}gen`
const CONFIG = `${ROOT}${SEP}.p4delta-scope`
/** The same path as {@link canonicalLocalPath} spells it — the form a resolved
 *  scope carries, which is what the assertions on a `ScopeView` compare against. */
const CONFIG_FWD = `${ROOT.replace(/\\/g, '/')}/.p4delta-scope`

const STYLE: PathStyle = WINDOWS
  ? { separator: '\\', foldCase: true }
  : { separator: '/', foldCase: false }

/** A resolved scope built the way `resolveScope` builds one: entries already
 *  canonical, the platform style attached. */
function view(overrides: Partial<ScopeView> = {}): ScopeView {
  return {
    includes: [{ path: SRC, kind: 'directory' }],
    excludes: [{ path: GEN, kind: 'directory' }],
    implicitExclude: null,
    clientRoot: ROOT,
    style: STYLE,
    ...overrides,
  }
}

describe('isAbsoluteLocalPath', () => {
  it('accepts local absolutes and refuses depot / relative spellings', () => {
    expect(isAbsoluteLocalPath(ROOT, STYLE)).toBe(true)
    expect(isAbsoluteLocalPath('//depot/branch_x/src', STYLE)).toBe(false)
    expect(isAbsoluteLocalPath('src/gen', STYLE)).toBe(false)
    expect(isAbsoluteLocalPath('', STYLE)).toBe(false)
  })
})

describe('entryCovers', () => {
  it('covers subtrees for directories and exact paths for files', () => {
    expect(entryCovers({ path: SRC, kind: 'directory' }, `${SRC}${SEP}a.txt`, STYLE)).toBe(true)
    expect(entryCovers({ path: SRC, kind: 'directory' }, SRC, STYLE)).toBe(true)
    // Directory-boundary aware: `src-other` is not under `src`.
    expect(entryCovers({ path: SRC, kind: 'directory' }, `${SRC}-other`, STYLE)).toBe(false)
    expect(
      entryCovers({ path: `${SRC}${SEP}a.txt`, kind: 'file' }, `${SRC}${SEP}a.txt`, STYLE),
    ).toBe(true)
    expect(
      entryCovers({ path: `${SRC}${SEP}a.txt`, kind: 'file' }, `${SRC}${SEP}b.txt`, STYLE),
    ).toBe(false)
  })
})

describe('scopeCoversPath', () => {
  it('answers containment exclusion-first', () => {
    const scope = view()
    expect(scopeCoversPath(scope, `${SRC}${SEP}a.txt`)).toBe(true)
    expect(scopeCoversPath(scope, `${GEN}${SEP}out.txt`)).toBe(false)
    expect(scopeCoversPath(scope, `${ROOT}${SEP}README`)).toBe(false)
  })

  it('honours the config file’s own implicit exclusion', () => {
    const scope = view({ implicitExclude: CONFIG })
    expect(scopeCoversPath(scope, CONFIG)).toBe(false)
    // It shields nothing else.
    expect(scopeCoversPath(scope, `${ROOT}${SEP}other`)).toBe(false)
    expect(scopeCoversPath(scope, `${SRC}${SEP}a.txt`)).toBe(true)
  })
})

describe('scopeCoversTarget', () => {
  it('needs the target WHOLE — a nested exclusion is not covered', () => {
    expect(scopeCoversTarget(view(), { path: SRC, isDirectory: true })).toBe(false)
    const clean = view({ excludes: [{ path: `${ROOT}${SEP}other`, kind: 'directory' }] })
    expect(scopeCoversTarget(clean, { path: SRC, isDirectory: true })).toBe(true)
    expect(scopeCoversTarget(clean, { path: `${SRC}${SEP}a.txt`, isDirectory: false })).toBe(true)
    // Outside the includes.
    expect(scopeCoversTarget(clean, { path: `${ROOT}${SEP}other`, isDirectory: true })).toBe(false)
  })

  it('refuses a target the scope excludes outright', () => {
    expect(scopeCoversTarget(view(), { path: GEN, isDirectory: true })).toBe(false)
    const fileExcluded = view({
      excludes: [{ path: `${SRC}${SEP}a.txt`, kind: 'file' }],
    })
    expect(scopeCoversTarget(fileExcluded, { path: `${SRC}${SEP}a.txt`, isDirectory: false })).toBe(
      false,
    )
  })
})

/** The rule the native fallback lives or dies by: a `<dir>/...` spec and a local
 *  directory walk both reach INTO an excluded subtree, so a scope with a hole may
 *  not be handed to either. */
describe('scopeHasExcludeHoles', () => {
  it('detects an exclude hole inside an include', () => {
    expect(scopeHasExcludeHoles(view())).toBe(true)
    // An exclude outside every include shields nothing and is not a hole.
    expect(
      scopeHasExcludeHoles(view({ excludes: [{ path: `${ROOT}${SEP}other`, kind: 'directory' }] })),
    ).toBe(false)
    // A single FILE exclusion inside the include is a hole too: `<src>/...`
    // reaches it, and under a clean that deletes the config file.
    expect(
      scopeHasExcludeHoles(
        view({ excludes: [{ path: `${SRC}${SEP}.p4delta-scope`, kind: 'file' }] }),
      ),
    ).toBe(true)
    // A file exclusion elsewhere on the disk shields nothing and is not a hole.
    expect(
      scopeHasExcludeHoles(
        view({ excludes: [{ path: `${ROOT}${SEP}.p4delta-scope`, kind: 'file' }] }),
      ),
    ).toBe(false)
    // A file include has no subtree to reach into.
    expect(scopeHasExcludeHoles(view({ includes: [{ path: SRC, kind: 'file' }] }))).toBe(false)
  })
})

describe('scopeTargets', () => {
  it('exposes the includes as host targets, keeping the kind', () => {
    expect(scopeTargets(view({ includes: [{ path: SRC, kind: 'file' }] }))).toEqual([
      { path: SRC, isDirectory: false },
    ])
  })
})

describe('scopePartsWithin — the walking form', () => {
  it('keeps a covered directory whose subtree holds an exclusion', () => {
    // The hole is the caller's business (the scan carves it, δ intersects on its
    // own side); refusing here is what used to stop a whole round.
    expect(scopePartsWithin(view(), [{ path: SRC, isDirectory: true }])).toEqual([
      { path: SRC, isDirectory: true },
    ])
  })

  it('drops a target the scope excludes outright, and one outside the includes', () => {
    expect(scopePartsWithin(view(), [{ path: GEN, isDirectory: true }])).toEqual([])
    expect(scopePartsWithin(view(), [{ path: `${ROOT}${SEP}other`, isDirectory: true }])).toEqual(
      [],
    )
  })

  it('narrows a straddling target to the include, and an inner target to itself', () => {
    expect(scopePartsWithin(view(), [{ path: ROOT, isDirectory: true }])).toEqual([
      { path: SRC, isDirectory: true },
    ])
    expect(scopePartsWithin(view(), [{ path: `${SRC}${SEP}a.txt`, isDirectory: false }])).toEqual([
      { path: `${SRC}${SEP}a.txt`, isDirectory: false },
    ])
  })
})

describe('scopeTargetsWithin — the claiming form', () => {
  it('refuses a range that still contains an excluded subtree', () => {
    expect(scopeTargetsWithin(view(), [{ path: SRC, isDirectory: true }])).toBeUndefined()
  })

  it('answers the same intersection where there is no hole', () => {
    const clean = view({ excludes: [{ path: `${ROOT}${SEP}other`, kind: 'directory' }] })
    expect(scopeTargetsWithin(clean, [{ path: ROOT, isDirectory: true }])).toEqual([
      { path: SRC, isDirectory: true },
    ])
  })

  it('never claims an excluded target, and answers undefined when that was all of it', () => {
    expect(scopeTargetsWithin(view(), [{ path: GEN, isDirectory: true }])).toBeUndefined()
    expect(
      scopeTargetsWithin(view({ excludes: [{ path: `${SRC}${SEP}a.txt`, kind: 'file' }] }), [
        { path: `${SRC}${SEP}a.txt`, isDirectory: false },
      ]),
    ).toBeUndefined()
  })
})

describe('targetsFromSpecs', () => {
  it('reads the editor’s own two spec forms back into typed targets', () => {
    expect(targetsFromSpecs([`${SRC}/...`, `${SRC}${SEP}a.txt`], STYLE)).toEqual([
      { path: SRC, isDirectory: true },
      { path: `${SRC}${SEP}a.txt`, isDirectory: false },
    ])
  })

  /** The `//...` case is the one a suffix strip would otherwise turn into `/`,
   *  an "absolute local path" by every test — i.e. the whole client handed to δ
   *  as a host path. An escaped name is refused too: it is not the raw path. */
  it('refuses depot spellings, escaped names and relative paths', () => {
    expect(targetsFromSpecs(['//...'], STYLE)).toBeUndefined()
    expect(targetsFromSpecs(['//depot/branch_x/...'], STYLE)).toBeUndefined()
    expect(targetsFromSpecs([`${SRC}/con%40tent/...`], STYLE)).toBeUndefined()
    expect(targetsFromSpecs([`${SRC}/con@tent/...`], STYLE)).toBeUndefined()
    expect(targetsFromSpecs(['src/...'], STYLE)).toBeUndefined()
    expect(targetsFromSpecs([''], STYLE)).toBeUndefined()
    expect(targetsFromSpecs([], STYLE)).toEqual([])
  })
})

describe('resolveScope', () => {
  const request = {
    clientRoot: ROOT,
    scopeFilePath: CONFIG,
    style: STYLE,
  }

  it('intersects the config includes with the given targets', () => {
    const config = parseScopeConfig(JSON.stringify({ include: [{ dir: '.' }] }))
    const res = resolveScope({
      ...request,
      config,
      targets: [{ path: `${SRC}${SEP}a.txt`, kind: 'file' }],
      targetsDeclared: true,
      cliExcludes: [],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.reason)
    expect(scopeTargets(res.scope)).toEqual([{ path: `${SRC}${SEP}a.txt`, isDirectory: false }])
  })

  /** The exclusion of the config file itself is implicit: it is not a config
   *  entry, and it must survive an operation that passes no exclusions at all. */
  it('excludes the config file itself without an explicit entry', () => {
    const config = parseScopeConfig('{}')
    const res = resolveScope({
      ...request,
      config,
      targets: [{ path: ROOT, kind: 'directory' }],
      targetsDeclared: true,
      cliExcludes: [],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.reason)
    expect(res.scope.implicitExclude).toBe(CONFIG_FWD)
    expect(scopeCoversPath(res.scope, CONFIG)).toBe(false)
  })

  it('refuses a declared target set that located nothing', () => {
    const res = resolveScope({
      ...request,
      config: parseScopeConfig('{}'),
      targets: [],
      targetsDeclared: true,
      cliExcludes: [],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected a refusal')
    expect(res.reason).toContain('none of the given paths could be located')
  })

  it('refuses a scope whose intersection is empty, naming the config', () => {
    const config = parseScopeConfig(JSON.stringify({ include: [{ dir: 'src' }] }))
    const res = resolveScope({
      ...request,
      config,
      targets: [{ path: `${ROOT}${SEP}other`, kind: 'directory' }],
      targetsDeclared: true,
      cliExcludes: [],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected a refusal')
    expect(res.reason).toContain('do not overlap the configured scope')
    expect(res.reason).toContain('include dir "src"')
  })

  it('gives an explicit empty include set an empty (not absent) range', () => {
    const config = parseScopeConfig(JSON.stringify({ include: [] }))
    const res = resolveScope({
      ...request,
      config,
      targets: [{ path: ROOT, kind: 'directory' }],
      targetsDeclared: true,
      cliExcludes: [],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected a refusal')
    expect(res.reason).toContain('include <empty>')
  })
})

describe('scopeIdentity', () => {
  it('is a local digest of root, config file, entries and exclusions', () => {
    const base = view({ implicitExclude: CONFIG })
    expect(scopeIdentity(base)).toBe(scopeIdentity(view({ implicitExclude: CONFIG })))
    expect(scopeIdentity(base)).not.toBe(scopeIdentity(view({ implicitExclude: null })))
    expect(scopeIdentity(base)).not.toBe(
      scopeIdentity(view({ implicitExclude: CONFIG, excludes: [] })),
    )
    // Case folding follows the platform rule, so the same directory in the
    // other spelling is the same scope on Windows.
    const folded = scopeIdentity(
      view({ implicitExclude: CONFIG, includes: [{ path: SRC.toUpperCase(), kind: 'directory' }] }),
    )
    if (WINDOWS) expect(folded).toBe(scopeIdentity(base))
    else expect(folded).not.toBe(scopeIdentity(base))
  })
})

describe('canonicalLocalPath / localPathKey', () => {
  it('normalises separators to the editor’s own / convention, plus drive case and dots', () => {
    const raw = WINDOWS ? 'x:\\workspace\\src\\.\\sub\\..\\' : '/workspace/src/./sub/../'
    const expected = WINDOWS ? 'X:/workspace/src' : '/workspace/src'
    expect(canonicalLocalPath(raw, STYLE)).toBe(expected)
    // Both platform spellings of the same directory normalise alike.
    expect(canonicalLocalPath(WINDOWS ? 'X:\\workspace\\src' : '/workspace/src', STYLE)).toBe(
      expected,
    )
  })

  it('folds case for the COMPARISON key only, where the platform does', () => {
    expect(localPathKey(SRC, STYLE)).toBe(WINDOWS ? SRC.toLowerCase() : SRC)
  })
})
