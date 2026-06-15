/**
 * Pure helpers for assembling the context an AI model needs to write a commit
 * message. Kept side-effect free (no git, no fs) so the change-selection,
 * truncation, and untracked-patch logic can be unit-tested against fixtures;
 * `repository.ts` does the actual IO and calls into here.
 */
import type { GitFileStatus } from './statusParser.js'

/** Per-file diff cap, mirroring VSCode's commit-message generator. */
export const MAX_FILE_DIFF_CHARS = 100_000
/** Untracked files larger than this are summarized instead of read in full. */
export const MAX_UNTRACKED_READ_BYTES = 1_000_000

export type DiffSource = 'index' | 'worktree' | 'untracked'

export interface ChangeEntry {
  readonly path: string
  readonly source: DiffSource
}

export interface CommitGenContext {
  readonly repoName: string
  readonly branch: string | undefined
  readonly recentCommits: readonly string[]
  readonly userCommits: readonly string[]
  readonly files: readonly { readonly path: string; readonly diff: string }[]
}

/**
 * Choose which files feed the commit message, mirroring VSCode: if anything is
 * staged, use only the staged (index) changes; otherwise use working-tree
 * changes plus untracked files. Untracked entries carry an `untracked` source so
 * the caller reads the file rather than asking git for a diff it can't produce.
 */
export function selectChangedFiles(files: readonly GitFileStatus[]): ChangeEntry[] {
  const staged = files.filter((f) => f.kind === 'tracked' && f.index !== '.')
  if (staged.length > 0) {
    return staged.map((f) => ({ path: f.path, source: 'index' }))
  }
  const entries: ChangeEntry[] = []
  for (const f of files) {
    if (f.kind === 'untracked') entries.push({ path: f.path, source: 'untracked' })
    else if (f.workingTree !== '.') entries.push({ path: f.path, source: 'worktree' })
  }
  return entries
}

export function truncateFileDiff(diff: string, max = MAX_FILE_DIFF_CHARS): string {
  if (diff.length <= max) return diff
  const omitted = diff.length - max
  return `${diff.slice(0, max)}\n[diff truncated: ${omitted} more characters omitted]`
}

/** A synthetic "new file" unified-diff patch for an untracked file. */
export function buildUntrackedPatch(path: string, content: string): string {
  const lines = content.split('\n')
  const endsWithNewline = lines.at(-1) === ''
  if (endsWithNewline) lines.pop()
  const body = lines.map((l) => `+${l}`).join('\n')
  const noNewlineNote = endsWithNewline ? '' : '\n\\ No newline at end of file'
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body + noNewlineNote,
  ].join('\n')
}
