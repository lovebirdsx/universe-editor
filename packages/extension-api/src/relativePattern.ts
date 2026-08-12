/**
 * `RelativePattern` — a glob pattern matched against paths relative to a base
 * folder (the `vscode.d.ts` counterpart). Used by `workspace.findFiles` and
 * `workspace.createFileSystemWatcher` to scope a search or watch to a
 * subdirectory instead of the whole workspace.
 */

import { Uri } from './uri.js'

/** Anything {@link RelativePattern} accepts as its base folder. */
export type RelativePatternBase = Uri | { readonly uri: Uri } | string

/**
 * A glob pattern rooted at a base folder: `pattern` is matched against paths
 * relative to `base` (a pattern without a slash matches the basename at any
 * depth below it). `base` accepts a `Uri` (only `file:` is meaningful today),
 * a `WorkspaceFolder`-shaped object (its `uri` is taken), or a filesystem
 * path string.
 */
export class RelativePattern {
  /** The base folder's filesystem path. */
  readonly base: string
  readonly pattern: string

  constructor(base: RelativePatternBase, pattern: string) {
    this.base =
      typeof base === 'string' ? base : base instanceof Uri ? base.fsPath : base.uri.fsPath
    this.pattern = pattern
  }
}

/** What `workspace.findFiles` / `workspace.createFileSystemWatcher` accept. */
export type GlobPattern = string | RelativePattern
