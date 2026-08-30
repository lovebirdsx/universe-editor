/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  focusScopeUtils — pure helpers behind the "focus folders" workspace scope.
 *
 *  Focus folders are a *path* whitelist, not a glob one. That distinction is the
 *  whole point: a path can be handed straight to ripgrep as a positional
 *  argument and to @parcel/watcher as a subscribe directory, so one setting
 *  narrows both what the user sees and what the editor scans. A glob could only
 *  ever filter after a full traversal, which is exactly the cost we are trying
 *  to avoid on a repository the size of a game project.
 *
 *  Path identity goes through IUriIdentityService rather than raw string
 *  comparison: focus folders are typed by a human, so their case will not match
 *  the disk on win32/darwin, and a case-sensitive prefix test would silently
 *  fail to match (showing nothing, or scanning everything).
 *--------------------------------------------------------------------------------------------*/

import type { IUriIdentityService } from '@universe-editor/platform'

/**
 * How a workspace-relative path relates to the focus set.
 *
 * - `inScope`   — inside a focus folder (or is one). Fully visible.
 * - `skeleton`  — an ancestor directory of a focus folder. Shown so the focus
 *                 folder is reachable in the tree, but its own direct files are
 *                 not (they are noise from the user's point of view).
 * - `out`       — outside the focus set entirely.
 */
export type FocusClassification = 'inScope' | 'skeleton' | 'out'

/**
 * Root-level directories focus never hides, whatever the focus set says.
 *
 * These hold the editor's own configuration — `.universe-editor/settings.json`
 * is where the focus settings themselves are written. Hiding them locks the
 * user's settings file behind the very filter they would edit it to change,
 * which is a self-consistency defect rather than a preference, so it is not a
 * setting. Applies at depth 0 only: a nested `Client/.vscode` is ordinary
 * content, and exempting it at any depth would be a wildcard hole in the filter.
 *
 * Visibility only — deliberately *not* added to `scanRoots`. The tree lists
 * these directories through IFileService on demand, and configuration
 * hot-reload has its own `fs.watch` in userDataMainService, so widening the
 * watcher and ripgrep subscriptions would buy nothing. The cost is that a
 * change made to them from outside the editor is not pushed into an already
 * expanded tree node, and that they stay out of search and Ctrl+P — both
 * acceptable for two directories the user opens to edit a settings file.
 */
const ALWAYS_VISIBLE_ROOT_DIRS = ['.universe-editor', '.vscode'] as const

/**
 * Normalize the raw `workspace.focusFolders` setting into a canonical list of
 * workspace-relative, forward-slash paths with no leading/trailing separator.
 *
 * Mirrors the `files.exclude` convention: only keys whose value is exactly
 * `true` participate, so a higher configuration layer can cancel a lower one's
 * entry with `false` (a user un-focusing a folder the project settings focus).
 *
 * Nested entries are collapsed to their shallowest ancestor — focusing both `A`
 * and `A/B` must yield just `A`, otherwise the watcher would open two
 * overlapping recursive subscriptions and report every event twice.
 */
export function normalizeFocusFolders(
  raw: Readonly<Record<string, unknown>>,
  uriIdentity: Pick<IUriIdentityService, 'getPathComparisonKey'>,
): string[] {
  const cleaned: string[] = []
  const seen = new Set<string>()

  for (const key of Object.keys(raw)) {
    if (raw[key] !== true) continue
    const rel = canonicalizeRelativePath(key)
    // A focus entry must name a subdirectory. An empty result means the user
    // wrote '.', '/' or '' — all of which mean "the whole workspace", which is
    // what focus mode is turning off. Treating it as a focus folder would be a
    // no-op wearing the costume of a filter.
    if (rel === undefined) continue
    const identity = folderKey(rel, uriIdentity)
    if (seen.has(identity)) continue
    seen.add(identity)
    cleaned.push(rel)
  }

  return collapseNested(cleaned, uriIdentity)
}

/**
 * Classify a workspace-relative path against the focus set.
 *
 * `showRootFiles` only affects files sitting directly in the workspace root:
 * build scripts, README, `*.uproject`, `.p4config` — the handful everyone
 * touches regardless of which subtree they are working in. Files inside a
 * *skeleton* directory are always hidden; that directory exists in the tree
 * purely as a path to reach a focus folder.
 */
export function classifyFocusPath(
  relPath: string,
  isDirectory: boolean,
  folders: readonly string[],
  showRootFiles: boolean,
  uriIdentity: Pick<IUriIdentityService, 'getPathComparisonKey'>,
): FocusClassification {
  if (folders.length === 0) return 'inScope'

  const rel = canonicalizeRelativePath(relPath)
  // The workspace root itself.
  if (rel === undefined) return 'inScope'

  // Configuration directories and everything under them stay reachable so the
  // focus settings never hide themselves. Checked before the focus set: the
  // point is that it holds regardless of what is focused.
  if (isUnderAlwaysVisibleRootDir(rel, isDirectory, uriIdentity)) return 'inScope'

  // Compared as identity keys, not raw strings: the folders were typed by a
  // human and the path comes from disk, so on win32/darwin their case will not
  // match. A case-sensitive test would classify the focus folder itself as
  // 'out' and render an empty tree.
  const key = folderKey(rel, uriIdentity)
  const folderKeys = folders.map((folder) => folderKey(folder, uriIdentity))

  for (const folder of folderKeys) {
    if (key === folder || isUnder(key, folder)) return 'inScope'
  }

  if (isDirectory) {
    for (const folder of folderKeys) {
      if (isUnder(folder, key)) return 'skeleton'
    }
    return 'out'
  }

  // A file. Only root-level files get the exemption; deeper ones sit inside a
  // skeleton directory and are noise.
  return !rel.includes('/') && showRootFiles ? 'inScope' : 'out'
}

/**
 * Whether a workspace-relative path is visible under the focus set. Thin
 * wrapper over {@link classifyFocusPath} for callers that only need a boolean —
 * skeleton directories count as visible because the tree must render them.
 */
export function isFocusVisible(
  relPath: string,
  isDirectory: boolean,
  folders: readonly string[],
  showRootFiles: boolean,
  uriIdentity: Pick<IUriIdentityService, 'getPathComparisonKey'>,
): boolean {
  return classifyFocusPath(relPath, isDirectory, folders, showRootFiles, uriIdentity) !== 'out'
}

/**
 * Whether a canonical relative path is one of {@link ALWAYS_VISIBLE_ROOT_DIRS}
 * or sits inside one. Compared as identity keys so the exemption holds on
 * case-insensitive filesystems, where `.VSCode` addresses the same directory.
 *
 * A root-level *file* carrying one of these names is not exempt: the exemption
 * exists for the configuration directories, and `showRootFiles` is what governs
 * root files.
 */
function isUnderAlwaysVisibleRootDir(
  rel: string,
  isDirectory: boolean,
  uriIdentity: Pick<IUriIdentityService, 'getPathComparisonKey'>,
): boolean {
  const slash = rel.indexOf('/')
  if (slash === -1 && !isDirectory) return false
  const top = slash === -1 ? rel : rel.slice(0, slash)
  const topKey = folderKey(top, uriIdentity)
  return ALWAYS_VISIBLE_ROOT_DIRS.some((dir) => folderKey(dir, uriIdentity) === topKey)
}

/**
 * Canonical relative path: forward slashes, no `.`/`..` segments, no leading or
 * trailing separator. Returns undefined when the input addresses the workspace
 * root itself, or escapes it via `..`.
 */
function canonicalizeRelativePath(value: string): string | undefined {
  const segments = value
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')

  const out: string[] = []
  for (const segment of segments) {
    if (segment === '..') {
      // Escaping the workspace root is never a valid focus folder. Drop the
      // whole entry rather than silently clamping it to the root, which would
      // turn a typo into "focus everything".
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(segment)
  }

  return out.length === 0 ? undefined : out.join('/')
}

/**
 * Identity key for a canonical relative path, under the platform's case policy.
 * Anchored at a synthetic absolute root so the comparison reuses the same
 * normalize + case-fold as every other path identity in the codebase.
 */
function folderKey(
  rel: string,
  uriIdentity: Pick<IUriIdentityService, 'getPathComparisonKey'>,
): string {
  return uriIdentity.getPathComparisonKey('/' + rel)
}

/** Whether canonical `child` is strictly nested under canonical `parent`. */
function isUnder(child: string, parent: string): boolean {
  return child.length > parent.length && child.startsWith(parent + '/')
}

/**
 * Drop any entry nested under another, preserving the caller's ordering in the
 * result (it is what the settings UI and status bar display).
 *
 * The containment scan walks shallowest-first so a parent is always seen before
 * its descendants and one pass suffices; the surviving entries are then mapped
 * back to their original positions.
 */
function collapseNested(
  folders: readonly string[],
  uriIdentity: Pick<IUriIdentityService, 'getPathComparisonKey'>,
): string[] {
  const keys = new Map<string, string>()
  for (const folder of folders) keys.set(folder, folderKey(folder, uriIdentity))

  const byDepth = [...folders].sort((a, b) => segmentCount(a) - segmentCount(b))
  const keptKeys: string[] = []
  const dropped = new Set<string>()

  for (const folder of byDepth) {
    const key = keys.get(folder)!
    if (keptKeys.some((ancestor) => isUnder(key, ancestor))) {
      dropped.add(folder)
      continue
    }
    keptKeys.push(key)
  }

  return folders.filter((folder) => !dropped.has(folder))
}

function segmentCount(rel: string): number {
  let count = 1
  for (let i = 0; i < rel.length; i++) {
    if (rel.charCodeAt(i) === 47 /* / */) count++
  }
  return count
}
