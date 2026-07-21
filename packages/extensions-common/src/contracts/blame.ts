/**
 * Git blame wire types, shared by the renderer (which renders the annotations)
 * and, structurally, by the `git` extension (which produces the data — it keeps
 * a local copy of these shapes to avoid bundling this package).
 *
 * Data crosses the contributed-command boundary as plain JSON: the renderer
 * calls `commands.executeCommand(BlameCommands.getBlame, fsPath)` and the `git`
 * extension's handler returns a {@link BlameResultDto}. Hashes are full 40-char
 * SHA-1; dates are Unix milliseconds (author date). Line numbers are 1-based.
 */

/** Blame for one commit, with the line ranges it last touched in the file. */
export interface BlameInfoDto {
  hash: string
  authorName: string
  authorEmail: string
  /** Author date, Unix milliseconds. */
  authorDate: number
  /** Commit subject (first line of the message). */
  summary: string
  /** 1-based, inclusive line ranges this commit owns in the current file. */
  ranges: { startLine: number; endLine: number }[]
}

/** Result of `git.getBlame` for a single file. */
export interface BlameResultDto {
  /** One entry per commit that owns at least one line; ranges are deduped per commit. */
  commits: BlameInfoDto[]
  /**
   * 1-based line numbers changed in the working tree but not yet committed. `git
   * blame` reports these with an all-zero hash; they render as "Not Committed Yet".
   */
  uncommittedLines: number[]
}

/**
 * Contributed-command suffix each SCM provider registers for blame, joined to
 * its provider id (`git.getBlame`, `perforce.getBlame`). The renderer resolves
 * the owning provider for a file and calls `<providerId>.getBlame`, so the host
 * holds no SCM-specific knowledge.
 *
 * The handler takes `(fsPath, ignoreWhitespace?)` and returns a
 * {@link BlameResultDto}, or null when the file is outside any repo / untracked.
 */
export const BlameCapabilities = {
  getBlame: 'getBlame',
} as const

/** Build a provider-scoped blame command id, e.g. `'git.getBlame'`. */
export function blameCommandId(
  providerId: string,
  capability: keyof typeof BlameCapabilities = 'getBlame',
): string {
  return `${providerId}.${BlameCapabilities[capability]}`
}
