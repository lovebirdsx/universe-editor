/**
 * Scope fixtures for the client tests.
 *
 * The client tests are about the DECISIONS an operation makes given a scope —
 * which engine serves it, what range it is allowed to touch, what the ledger
 * records — not about resolution (that is `scope.test.ts` / `scopeConfig.test.ts`,
 * against the real parser and set algebra). Their client root is a fabricated
 * path (`X:/p4ws/main`) that exists on no filesystem, so they inject the
 * CONFIG READ the client would have done.
 *
 * Two shapes, because the two kinds of test client are built differently:
 * - {@link scopeFixture} returns a `readScope` function, for a REAL
 *   `PerforceClient` (whose option is `readScope`). It relativises the entries
 *   against whatever client root the client passes in, so a fixture says the
 *   same thing about any root.
 * - {@link scopeView} returns a literal `ScopeView`, for the hand-written FAKE
 *   clients (`reconcileExcludeCommands`) whose `dailyScope` getter is assigned
 *   directly.
 */
import type { SyncScopeTarget } from '../p4Filespec.js'
import { hostPathStyle, type ScopeEntry, type ScopeView } from '../scope.js'
import { SCOPE_FILE_NAME, type ScopeConfig, type ScopeConfigRead } from '../scopeConfig.js'

/** A path or an entry; a bare string means a directory, which is the common
 *  case in these fixtures. */
export type ScopeFixtureEntry = string | SyncScopeTarget

/** What `PerforceClientOptions.readScope` is: the config read the client does
 *  once per resolution. */
export type ScopeRead = (clientRoot: string) => ScopeConfigRead

/** No config file anywhere — the answer an ordinary folder resolves to. */
export const NO_SCOPE_CONFIG: ScopeConfigRead = { kind: 'absent' }

function kindOf(value: ScopeFixtureEntry): 'directory' | 'file' {
  return typeof value === 'string' || value.isDirectory ? 'directory' : 'file'
}

function pathOf(value: ScopeFixtureEntry): string {
  return typeof value === 'string' ? value : value.path
}

/** Segments as the platform compares them, with `/` as the only separator. */
function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function folds(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/** A client-root-relative POSIX config path, or undefined when the entry is not
 *  under the root — a config cannot name one (every entry is relative, and `..`
 *  is rejected), which is why such an entry is DROPPED rather than re-rooted. */
function relativize(entry: string, clientRoot: string): string | undefined {
  const target = norm(entry)
  const root = norm(clientRoot)
  const fold = (value: string): string => (folds() ? value.toLowerCase() : value)
  if (fold(target) === fold(root)) return '.'
  if (!fold(target).startsWith(`${fold(root)}/`)) return undefined
  return target.slice(root.length + 1)
}

function configOf(
  includes: readonly ScopeFixtureEntry[],
  excludes: readonly ScopeFixtureEntry[],
  clientRoot: string,
): ScopeConfig {
  const entries = (values: readonly ScopeFixtureEntry[]): ScopeEntry[] => {
    const out: ScopeEntry[] = []
    for (const value of values) {
      const relative = relativize(pathOf(value), clientRoot)
      if (relative === undefined) continue
      out.push({ path: relative, kind: kindOf(value) })
    }
    return out
  }
  return { include: entries(includes), exclude: entries(excludes) }
}

/**
 * The config a client reading `clientRoot` would find: the given includes and
 * excludes, relativised against that root.
 *
 * The config file's OWN path is implicit — `resolveScope` excludes it whenever a
 * config exists — so a fixture that wants to model that hole does not spell it
 * out. Entries outside the root are dropped (see {@link relativize}).
 */
export function scopeFixture(
  includes: readonly ScopeFixtureEntry[],
  excludes: readonly ScopeFixtureEntry[] = [],
): ScopeRead {
  return (clientRoot) => {
    const config = configOf(includes, excludes, clientRoot)
    return {
      kind: 'ok',
      path: `${clientRoot}${hostPathStyle().separator}${SCOPE_FILE_NAME}`,
      text: JSON.stringify(config),
      config,
    }
  }
}

/**
 * A literal `ScopeView` for a FAKE client, whose `dailyScope` getter is assigned
 * directly (there is no resolution behind it).
 *
 * Deliberately not run through `resolveScope`: a fake declares the ANSWER, and
 * the shapes it needs to declare include ones a resolution would collapse (a
 * scope whose includes are also excluded is a view no `p4 sync` would ever get,
 * but it is exactly the input `collectScope` has to survive).
 */
export function scopeView(
  includes: readonly ScopeFixtureEntry[] = [],
  excludes: readonly ScopeFixtureEntry[] = [],
  options: { readonly clientRoot?: string } = {},
): ScopeView {
  const style = hostPathStyle()
  const root = options.clientRoot ?? 'X:/p4ws/main'
  // The entries are kept VERBATIM: a fake declares the answer, and the tests
  // around it spell their expectations in the same shape they declared.
  const entryOf = (value: ScopeFixtureEntry): ScopeEntry => ({
    path: pathOf(value),
    kind: kindOf(value),
  })
  return {
    includes: includes.map(entryOf),
    excludes: excludes.map(entryOf),
    implicitExclude: `${root}${style.separator}${SCOPE_FILE_NAME}`,
    clientRoot: root,
    style,
  }
}
