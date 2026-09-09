/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  codeActionsOnSaveSettings — pure setting-resolution for
 *  `editor.codeActionsOnSave`, the counterpart of VSCode's
 *  `CodeActionOnSaveParticipant` filtering/sorting. Kept monaco-free so it can
 *  run in the node test environment.
 *--------------------------------------------------------------------------------------------*/

import type { SaveReason } from '../extensions/SaveParticipant.js'

/** `editor.codeActionsOnSave` value shape: `{ [kind: string]: 'always' | 'explicit' | 'never' | boolean }`. */
export type CodeActionsOnSaveSetting = Record<string, string | boolean>

export interface ResolvedCodeActionsOnSave {
  /** Kinds to request, ordered so fixAll kinds run before other source actions. */
  readonly include: readonly string[]
  /** Kinds explicitly disabled ('never'), passed to the action query as excludes. */
  readonly excludes: readonly string[]
}

/** Kind-prefix test ('source' contains 'source.organizeImports'). Mirrors
 *  monaco's `HierarchicalKind.contains`, reimplemented to keep this module
 *  free of monaco imports. */
export function kindContains(parent: string, child: string): boolean {
  return parent === child || parent === '' || child.startsWith(parent + '.')
}

function isFixAll(kind: string): boolean {
  return kindContains('source.fixAll', kind)
}

/**
 * Resolve the raw setting to the ordered include/exclude kind lists for a save.
 *
 * - `'always'` kinds run on every save reason.
 * - `'explicit'` / `true` kinds run only on explicit saves (reason 1).
 * - `'never'` / `false` kinds are excluded.
 * - A kind already contained in another configured kind is dropped (requesting
 *   `source` already covers `source.organizeImports`).
 * - fixAll kinds sort first: they may fix diagnostics the later actions re-read.
 */
export function resolveCodeActionsOnSave(
  setting: CodeActionsOnSaveSetting | undefined,
  reason: SaveReason,
): ResolvedCodeActionsOnSave {
  if (!setting) return { include: [], excludes: [] }

  const explicit = reason === 1
  const wanted = Object.keys(setting).filter((key) => {
    const value = setting[key]
    return value === 'always' || ((value === 'explicit' || value === true) && explicit)
  })
  const excludes = Object.keys(setting).filter((key) => {
    const value = setting[key]
    return value === 'never' || value === false
  })

  // Drop kinds subsumed by another wanted kind, then fixAll before the rest.
  const include = wanted
    .filter((kind) => wanted.every((other) => other === kind || !kindContains(other, kind)))
    .sort((a, b) => Number(isFixAll(b)) - Number(isFixAll(a)))

  return { include, excludes }
}
