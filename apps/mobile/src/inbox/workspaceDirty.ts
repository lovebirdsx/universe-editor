import type { MobileWorkspaceCandidate } from '@universe-editor/mobile-protocol'

/** Window ids whose current workspace has uncommitted changes. */
export function collectDirtyWindowIds(
  workspaces: readonly MobileWorkspaceCandidate[],
): ReadonlySet<number> {
  const ids = new Set<number>()
  for (const workspace of workspaces) {
    if (workspace.gitDirty === true && workspace.windowId !== undefined) {
      ids.add(workspace.windowId)
    }
  }
  return ids
}
