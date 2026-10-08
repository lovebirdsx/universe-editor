/**
 * The reconcile NOISE layer: the folders `perforce.reconcile.excludeFolders`
 * hides from reconcile work. Noise is not a range source — the workspace scope
 * (`.p4delta-scope`) stays the only one — it is what the daily machinery skips
 * while it walks and queries: automatic discovery, the uncollected-change hint,
 * narrow queries, and the unopened half of a collect / clean.
 *
 * Three rules hold the layer together, and the first two are about what noise
 * must NOT do:
 *
 * 1. **Noise never narrows or widens the scope.** A get (and its preview) runs
 *    over the daily scope with noise applied by nobody, and an existing
 *    changelist operation (revert/reopen/shelve/submit/opened) keeps its full
 *    semantics — the setting is about files nobody has collected yet.
 * 2. **Noise is pruned BEFORE the walk, never filtered after it.** Hiding a
 *    result still pays for the traversal (and, for `p4 clean`, still DELETES in
 *    the subtree before the filter ever sees the answer), so every entry point
 *    hands the exclusion list to the engine or the carve.
 * 3. **A confirmation is per TARGET, never per rule.** A user who explicitly
 *    names a folder the noise covers gets asked, and their "run as chosen" lifts
 *    only the rules covering the targets they named — the rest of the batch, and
 *    any nested rule they did not name, still apply. Dropping the ancestor rule
 *    for the whole call is how a parent directory in the same selection silently
 *    starts walking the subtree the user shielded.
 *
 * Rule 3 is why an operation is a LIST of one-target-group plans
 * ({@link planReconcileNoiseOperations}) instead of a targets list plus a few
 * booleans: each group states exactly which targets were authorized, and the
 * rules that apply to them are read at the write from the setting in force, so
 * the engine fork, the carve and the write cannot disagree about which
 * exclusions this call carries.
 */
import type { SyncScopeTarget } from './p4Filespec.js'
import { collapseScopeDirs, isUnderAny, scopeKey } from './pathUtil.js'

/** The resolved noise: absolute local paths, split by kind. The split is not
 *  cosmetic — δ's typed request carries a `kind`, and a directory sent as a
 *  `file` would only ever hide the directory itself. A path nobody could stat
 *  is a DIRECTORY: the setting names folders, and a folder that does not exist
 *  yet (or a probe that failed) is one whose subtree this rule must still
 *  cover the moment it appears — see {@link resolveReconcileExcludes}. */
export interface ReconcileNoiseConfig {
  readonly dirs: readonly string[]
  readonly files: readonly string[]
}

export const EMPTY_RECONCILE_NOISE: ReconcileNoiseConfig = { dirs: [], files: [] }

/**
 * Whether `value` is an absolute path in its own right: a Windows drive form
 * (`X:/…`, `X:\…`, `X:…`), a UNC share, or a POSIX root. Anything else is a
 * workspace-relative entry.
 */
function isAbsolutePath(value: string): boolean {
  if (/^[a-zA-Z]:/.test(value)) return true
  if (value.startsWith('\\\\') || value.startsWith('//')) return true
  return value.startsWith('/') || value.startsWith('\\')
}

/**
 * Canonical absolute spelling: forward slashes, no trailing separator, no `.`
 * or `..` segments. Returns undefined when the entry escapes its root — a typo
 * must not become an exclusion over a sibling tree.
 */
function canonicalAbsolute(value: string): string | undefined {
  const withDrive = value.replace(/\\/g, '/')
  // The drive separator is optional in the input (`X:ws` is drive-relative but
  // names the same tree as `X:/ws`), so the head keeps one unconditionally —
  // slicing the match off and re-adding a bare `x:` would produce `x:ws/vendor`.
  const drive = /^([a-zA-Z]):[/]?/.exec(withDrive)
  const unc = withDrive.startsWith('//')
  const head = drive !== null ? `${drive[1]!.toLowerCase()}:/` : unc ? '//' : '/'
  const rest = withDrive.slice(drive !== null ? drive[0].length : head.length)
  const out: string[] = []
  for (const segment of rest.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(segment)
  }
  if (out.length === 0) return undefined
  return `${head}${out.join('/')}`
}

/**
 * A workspace-relative entry as an absolute path, or undefined when it
 * addresses the workspace root itself or escapes it via `..`. Mirrors
 * `focusScope.canonicalRelative` — same syntax, opposite direction of travel
 * (this one excludes, focus includes).
 */
function canonicalRelative(value: string): string | undefined {
  const out: string[] = []
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length === 0 ? undefined : out.join('/')
}

/** Stat shape the split needs, injected so the function stays pure over I/O. */
export interface ReconcileExcludeStat {
  readonly isDirectory: boolean
}

/**
 * Resolve `perforce.reconcile.excludeFolders` into absolute local paths: a
 * relative entry is joined onto the workspace root, an absolute one is
 * canonicalized in place, and only a path PROVEN to be an existing
 * non-directory becomes a file rule ({@link ReconcileNoiseConfig}).
 *
 * Everything else — an existing folder, and equally one that does not exist yet
 * or that could not be read — is a DIRECTORY rule, because the setting names
 * folders. The other default would freeze the answer to a question the user
 * never asked: resolved before `gen` exists, a file-kind rule over `gen` hides
 * that one name, and the day the folder appears δ stops excluding its subtree
 * (the scan publishes rows from it, a collect opens its files) and a native
 * `p4 clean -a` over the parent DELETES inside it. Hiding a folder that turns
 * out to be a typo only ever hides (reconcile work, never content), which is
 * the setting's own trade; the reverse is not recoverable.
 */
export async function resolveReconcileExcludes(
  values: readonly string[],
  workspaceRoot: string,
  stat: (absolutePath: string) => Promise<ReconcileExcludeStat | undefined>,
): Promise<ReconcileNoiseConfig> {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const resolved: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const absolute = isAbsolutePath(value)
      ? canonicalAbsolute(value)
      : ((): string | undefined => {
          const rel = canonicalRelative(value)
          return rel === undefined ? undefined : `${root}/${rel}`
        })()
    if (absolute !== undefined) resolved.push(absolute)
  }
  const stats = await Promise.all(resolved.map((path) => stat(path)))
  const dirs: string[] = []
  const files: string[] = []
  for (let i = 0; i < resolved.length; i++) {
    const path = resolved[i]!
    if (stats[i]?.isDirectory === false) files.push(path)
    else dirs.push(path)
  }
  const collapsed = collapseScopeDirs(dirs)
  return {
    dirs: collapsed,
    files: collapseScopeFiles(files.filter((file) => !isUnderAny(file, collapsed))),
  }
}

/** Dedupe exact-file entries by {@link scopeKey}; order is the caller's. */
function collapseScopeFiles(files: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const file of files) {
    const key = scopeKey(file)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(file)
  }
  return out
}

/** Dedupe targets (kind-aware) and drop ones nested under a selected directory. */
export function normalizeNoiseTargets(targets: readonly SyncScopeTarget[]): SyncScopeTarget[] {
  const dirs = targets.filter((t) => t.isDirectory).map((t) => t.path)
  const seen = new Set<string>()
  const out: SyncScopeTarget[] = []
  for (const target of targets) {
    if (target.path === '') continue
    if (dirs.some((dir) => dir !== target.path && isUnderAny(target.path, [dir]))) continue
    const key = `${target.isDirectory ? 'd' : 'f'}:${scopeKey(target.path)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

/** Whether any of `noise`'s rules covers `target` — the question the command
 *  layer puts to the user before it runs over a path they named explicitly. */
export function noiseCoversTarget(noise: ReconcileNoiseConfig, target: SyncScopeTarget): boolean {
  if (isUnderAny(target.path, noise.dirs)) return true
  return noise.files.some((file) => scopeKey(file) === scopeKey(target.path))
}

/**
 * The first rule of `noise` whose own range a spec list that COVERS its targets
 * whole would reach, with the target it does so through — or undefined when no
 * rule touches them.
 *
 * This is the question an UNCUT native run has to answer before it starts: the
 * spec for a directory target is `<dir>/...`, so p4's traversal walks every rule
 * at or under it, and the spec for a file target carries whatever rule names
 * that path exactly. A rule ABOVE a target counts as well — the target itself is
 * the shielded path. {@link noiseCoversTarget} asks the same question of one
 * target before the dialog; this one is asked of a whole plan at the last
 * admission, where the answer has to be a refusal rather than a prompt.
 */
export function noiseReach(
  noise: ReconcileNoiseConfig,
  targets: readonly SyncScopeTarget[],
): { readonly rule: string; readonly target: string } | undefined {
  for (const target of targets) {
    if (target.path === '') continue
    const dir = noise.dirs.find(
      (rule) => isUnderAny(target.path, [rule]) || isUnderAny(rule, [target.path]),
    )
    if (dir !== undefined) return { rule: dir, target: target.path }
    const file = noise.files.find((rule) =>
      target.isDirectory
        ? isUnderAny(rule, [target.path])
        : scopeKey(rule) === scopeKey(target.path),
    )
    if (file !== undefined) return { rule: file, target: target.path }
  }
  return undefined
}

/** The rules of `noise` that do NOT cover any of `confirmed` — what an
 *  operation over exactly those targets still has to respect. A rule covering
 *  one of the confirmed targets is lifted; a NESTED rule the user did not name
 *  survives, which is the whole reason this is computed per target. */
export function noiseFor(
  noise: ReconcileNoiseConfig,
  confirmed: readonly SyncScopeTarget[],
): ReconcileNoiseConfig {
  if (confirmed.length === 0) return noise
  const dirs = noise.dirs.filter((dir) => !confirmed.some((t) => isUnderAny(t.path, [dir])))
  const files = noise.files.filter(
    (file) => !confirmed.some((t) => scopeKey(t.path) === scopeKey(file)),
  )
  return {
    dirs: collapseScopeDirs(dirs),
    files: collapseScopeFiles(files),
  }
}

/** One operation the command layer will run: a target group plus the exact
 *  targets the user authorized through the noise gate FOR THIS GROUP. Two groups
 *  share no authorization — a bypass granted for one never reaches the other,
 *  and neither carries a copy of the rules: those are read at the write, from
 *  the setting in force then, and only the rules covering the authorized targets
 *  are lifted (`noiseFor`). */
export interface ReconcileNoiseOperation {
  readonly targets: readonly SyncScopeTarget[]
  /** The targets the user named through the gate — the only ones whose rules are
   *  lifted, and only the rules that cover them. Empty for a group that simply
   *  runs as pruned. */
  readonly confirmedTargets: readonly SyncScopeTarget[]
}

/**
 * Split an operation's targets into the groups it must run as.
 *
 * A target the noise covers cannot ride along in the same call as one it does
 * not: the engine fork takes ONE exclusion list, so lifting the rule for the
 * confirmed target would lift it for the parent directory sharing the call
 * (which is the "a confirmation silently widened the batch" failure). One group
 * per policy, then — the un-covered targets with no authorization, the confirmed
 * ones carrying exactly the targets the user named.
 *
 * The groups carry TARGETS, not rules: the rules are read once more at the write
 * ({@link ReconcileNoiseOperation}), so a setting edited while the dialog was up
 * decides the run instead of being overridden by the reading the dialog showed.
 *
 * `undefined` when nothing is left to run (every target covered and none
 * confirmed) — an answer, never an empty call.
 */
export function planReconcileNoiseOperations(
  targets: readonly SyncScopeTarget[],
  noise: ReconcileNoiseConfig,
  confirmed: readonly SyncScopeTarget[] = [],
): ReconcileNoiseOperation[] | undefined {
  // The confirmed set is DEDUPED but not nested-collapsed: "the user named this
  // exact target" is the question, and a file under a confirmed directory is one
  // they named (the collapse happens per group below, where the directory's
  // bypass already carries it).
  const confirmedSet: SyncScopeTarget[] = []
  {
    const seen = new Set<string>()
    for (const target of confirmed) {
      if (target.path === '') continue
      const key = `${target.isDirectory ? 'd' : 'f'}:${scopeKey(target.path)}`
      if (seen.has(key)) continue
      seen.add(key)
      confirmedSet.push(target)
    }
  }
  const isConfirmed = (target: SyncScopeTarget): boolean =>
    confirmedSet.some(
      (c) => scopeKey(c.path) === scopeKey(target.path) && c.isDirectory === target.isDirectory,
    )
  // A target the user confirmed but the noise does NOT cover runs in the plain
  // group (there is nothing to lift for it), which keeps the call count at one
  // for the ordinary case.
  const plain: SyncScopeTarget[] = []
  const bypassed: SyncScopeTarget[] = []
  for (const target of targets) {
    if (isConfirmed(target) && noiseCoversTarget(noise, target)) bypassed.push(target)
    else plain.push(target)
  }
  // Each group is normalized on its own, AFTER the split: the confirmed target a
  // parent directory also covers must not be deduped away as "redundant", or the
  // dialog would offer a choice with no effect — a group's targets all run under
  // ONE policy, and the nested target is exactly the one carrying the bypass.
  const ops: ReconcileNoiseOperation[] = []
  const plainTargets = normalizeNoiseTargets(plain)
  if (plainTargets.length > 0) ops.push({ targets: plainTargets, confirmedTargets: [] })
  const bypassedTargets = normalizeNoiseTargets(bypassed)
  if (bypassedTargets.length > 0) {
    ops.push({ targets: bypassedTargets, confirmedTargets: bypassedTargets })
  }
  return ops.length === 0 ? undefined : ops
}

/**
 * The exclusions one operation hands to δ, as plain argv: the engine takes the
 * list itself rather than a frozen snapshot, and it unions them with whatever
 * the scope config already excludes.
 *
 * The kind is spelled by the FLAG, so a directory rule can never be read as a
 * file rule — the failure that hides one name while the subtree keeps walking.
 */
export function noiseExcludeArgs(noise: ReconcileNoiseConfig): string[] {
  return [
    ...noise.dirs.flatMap((dir) => ['--exclude-dir', dir]),
    ...noise.files.flatMap((file) => ['--exclude-file', file]),
  ]
}
