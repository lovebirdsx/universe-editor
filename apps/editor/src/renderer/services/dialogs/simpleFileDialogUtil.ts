/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the SimpleFileDialog: directory listing preparation, prefix
 *  completion and path-segment parsing. Kept side-effect free so they can be unit
 *  tested without booting QuickInput / IFileService.
 *--------------------------------------------------------------------------------------------*/

export interface DialogEntry {
  readonly name: string
  readonly isDirectory: boolean
}

function compareName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}

/**
 * Filter + order entries for display: directories first then files, each group
 * sorted by name. Drops files when `allowFiles` is false (folder-only picker) and
 * dotfiles when `showDotFiles` is false.
 */
export function prepareEntries(
  entries: readonly DialogEntry[],
  opts: { allowFiles: boolean; showDotFiles: boolean },
): DialogEntry[] {
  const visible = entries.filter((e) => {
    if (!opts.showDotFiles && e.name.startsWith('.')) return false
    if (!opts.allowFiles && !e.isDirectory) return false
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
