/**
 * Dirty-diff wire contract, shared by the renderer (which renders the gutter /
 * overview-ruler decorations) and the `git` extension (which reads the HEAD
 * revision). The renderer calls
 * `commands.executeCommand(DirtyDiffCommands.getHeadContent, fsPath)` and the
 * handler returns the file's content at HEAD as a string, or null when the file
 * has no HEAD revision (untracked / new file) or lives outside any repo.
 */

export const DirtyDiffCommands = {
  getHeadContent: 'git.getHeadContent',
} as const
