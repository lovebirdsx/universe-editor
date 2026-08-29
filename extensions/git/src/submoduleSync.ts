/**
 * Submodule updating, shared by every caller that moves HEAD. `Repository` (SCM
 * side, with progress + refresh plumbing), `RepositoryWorktrees` and the Git
 * Graph actions all need the same two steps — "does this tree have submodules"
 * and "bring them to the commit HEAD now points at" — so they live here rather
 * than being spelled out at each call site.
 *
 * Deliberately free of `@universe-editor/extension-api` so the bundled Git Graph
 * sources, which avoid platform deps, can import it too.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { gitExec, type GitExecResult } from './gitService.js'

type Log = ((msg: string) => void) | undefined

export const SUBMODULE_UPDATE_ARGS: readonly string[] = [
  'submodule',
  'update',
  '--init',
  '--recursive',
]

/** True when `root` declares submodules — the cheap gate before shelling out. */
export async function hasSubmodules(root: string): Promise<boolean> {
  try {
    await stat(join(root, '.gitmodules'))
    return true
  } catch {
    return false
  }
}

export function updateSubmodules(root: string, log?: Log): Promise<GitExecResult> {
  return gitExec(SUBMODULE_UPDATE_ARGS, root, log)
}

/** Distinguishes "no submodules, nothing to do" from "ran, here's the result". */
export type SubmoduleUpdateOutcome =
  | { readonly ran: false }
  | { readonly ran: true; readonly result: GitExecResult }

export async function updateSubmodulesIfPresent(
  root: string,
  log?: Log,
): Promise<SubmoduleUpdateOutcome> {
  if (!(await hasSubmodules(root))) {
    log?.(`[git] submodule update skipped: no .gitmodules in ${root}`)
    return { ran: false }
  }
  return { ran: true, result: await updateSubmodules(root, log) }
}
