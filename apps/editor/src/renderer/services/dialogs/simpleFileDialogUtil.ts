/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the SimpleFileDialog: directory listing preparation, prefix
 *  completion and path-segment parsing. Kept side-effect free so they can be unit
 *  tested without booting QuickInput / IFileService.
 *--------------------------------------------------------------------------------------------*/

import { extname } from '@universe-editor/platform'

export interface DialogEntry {
  readonly name: string
  readonly isDirectory: boolean
}

/** A file-type filter group (mirrors the platform `IFileDialogFilter` shape). */
export interface DialogFileFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

/** Lowercased extension of a file name ('' when none; leading-dot files have none). */
export function fileExtension(name: string): string {
  return extname(name).slice(1).toLowerCase()
}

/**
 * Union the extensions of every filter group, lowercased. The Electron/Win32
 * filter idioms are normalised: `*` and `*.*` mean "all files" and collapse the
 * result to undefined (= no filtering), as does an empty/absent filter list;
 * `*.ext`/`.ext` are reduced to the bare extension `ext`.
 */
export function collectFilterExtensions(
  filters: readonly DialogFileFilter[] | undefined,
): ReadonlySet<string> | undefined {
  if (!filters || filters.length === 0) return undefined
  const exts = new Set<string>()
  for (const group of filters) {
    for (const ext of group.extensions) {
      const trimmed = ext.trim().toLowerCase()
      if (trimmed === '*' || trimmed === '*.*') return undefined
      const normalized = trimmed.replace(/^\*/, '').replace(/^\./, '')
      if (normalized !== '') exts.add(normalized)
    }
  }
  return exts.size === 0 ? undefined : exts
}

function compareName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}

/**
 * Filter + order entries for display: directories first then files, each group
 * sorted by name. Drops files when `allowFiles` is false (folder-only picker),
 * dotfiles when `showDotFiles` is false, and files whose extension is not in
 * `fileExts` (folders always pass so navigation stays possible).
 */
export function prepareEntries(
  entries: readonly DialogEntry[],
  opts: { allowFiles: boolean; showDotFiles: boolean; fileExts?: ReadonlySet<string> | undefined },
): DialogEntry[] {
  const visible = entries.filter((e) => {
    if (!opts.showDotFiles && e.name.startsWith('.')) return false
    if (!opts.allowFiles && !e.isDirectory) return false
    if (!e.isDirectory && opts.fileExts && !opts.fileExts.has(fileExtension(e.name))) return false
    return true
  })
  const folders = visible.filter((e) => e.isDirectory).sort((a, b) => compareName(a.name, b.name))
  const files = visible.filter((e) => !e.isDirectory).sort((a, b) => compareName(a.name, b.name))
  return [...folders, ...files]
}

/** First entry whose name starts with `segment` (case-insensitive). */
export function findCompletion(
  entries: readonly DialogEntry[],
  segment: string,
): DialogEntry | undefined {
  if (segment === '') return undefined
  const lower = segment.toLowerCase()
  return entries.find((e) => e.name.toLowerCase().startsWith(lower))
}

/**
 * Split a typed path into its containing directory (with trailing separator) and
 * the trailing name segment. Recognises both `/` and `\` as separators regardless
 * of platform, so user input is tolerant.
 */
export function splitTrailingSegment(value: string): { dir: string; name: string } {
  let idx = -1
  for (let i = value.length - 1; i >= 0; i--) {
    const c = value[i]
    if (c === '/' || c === '\\') {
      idx = i
      break
    }
  }
  if (idx === -1) return { dir: '', name: value }
  return { dir: value.slice(0, idx + 1), name: value.slice(idx + 1) }
}

/** Whether the path ends with a separator (`/` or `\`). */
export function endsWithSeparator(value: string): boolean {
  const last = value[value.length - 1]
  return last === '/' || last === '\\'
}

/**
 * Expand a leading `~` to the user home directory (VSCode behaviour). `~` / `~/`
 * become `home` + separator (so the dialog navigates *into* home); `~/sub`
 * becomes `home/sub`. Returns undefined when the value is not tilde-prefixed.
 */
export function expandTilde(value: string, home: string, sep: string): string | undefined {
  if (value === '~' || value === '~/' || value === '~\\') return home + sep
  if (value.startsWith('~/') || value.startsWith('~\\')) return home + sep + value.slice(2)
  return undefined
}

/**
 * Whether `next` is a pure deletion of `prev` (a strictly shorter prefix). Used to
 * suppress autocompletion while the user is backspacing, so completion does not
 * fight the delete.
 */
export function isDeletion(prev: string, next: string): boolean {
  return next.length < prev.length && prev.startsWith(next)
}

/**
 * Decide whether a value change should count as a deletion (suppressing
 * autocomplete). `base` is the segment the user actually typed before the last
 * completion appended a selected tail. Typing a character forward over that
 * selection yields a value longer than `base` (e.g. base `/b/f`, completed
 * `/b/foo` with `oo` selected, typing `o` → `/b/fo`), which must NOT count as a
 * deletion — only shrinking back to `base` (the selected tail removed) is a real
 * delete. Falls back to the plain prefix-shrink check when there is no pending
 * completion or the edit is unrelated to it.
 */
export function isDeletionEdit(prev: string, next: string, base: string | undefined): boolean {
  if (
    base !== undefined &&
    prev.length > base.length &&
    prev.startsWith(base) &&
    next.startsWith(base)
  ) {
    return next.length <= base.length
  }
  return isDeletion(prev, next)
}

/**
 * Compute the autocompletion of a typed path against a matched entry name. Returns
 * the completed value and the `[start, end]` selection covering the appended
 * suffix, so the panel can highlight the part the user has not yet typed.
 */
export function completePath(
  dir: string,
  typedName: string,
  matchedName: string,
): { value: string; selection: [number, number] } {
  const value = dir + matchedName
  const start = dir.length + typedName.length
  return { value, selection: [start, value.length] }
}
