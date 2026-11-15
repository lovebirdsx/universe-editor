/**
 * Host-free half of the git error helpers. `gitError.ts` re-exports this so the
 * extension UI keeps its single import site, while headless consumers (the
 * delivery pipeline and its CLI) can render git failures without pulling in the
 * extension API.
 */
import type { GitExecResult } from './gitService.js'

/** The raw reason a git command failed: stderr first, stdout as fallback,
 *  exit-code as a last resort so the output never ends in a bare "failed:". */
export function gitErrorText(res: GitExecResult): string {
  return res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.exitCode}`
}
