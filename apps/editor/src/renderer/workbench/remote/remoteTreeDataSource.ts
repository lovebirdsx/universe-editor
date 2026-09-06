/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  remoteTreeDataSource — adapts the pure `RemoteTree` snapshot to the shared
 *  `Tree` component's data source, so the Remote Explorer gets the same keyboard
 *  navigation (arrows / Home / End / Page / Enter / ContextMenu key) as Explorer,
 *  Search and SCM instead of a hand-rolled flat render.
 *
 *  The snapshot is rebuilt on every data change, so nodes have no stable object
 *  identity — the tree is keyed entirely by `getId`, and `getParent` walks an
 *  index rebuilt alongside each snapshot rather than holding node references.
 *  Component-free so it runs in the renderer-node test project.
 *--------------------------------------------------------------------------------------------*/

import type { ITreeDataSource } from '@universe-editor/workbench-ui'
import type {
  RemoteTree,
  RemoteTreeGroup,
  RemoteTreeRecent,
  RemoteTreeTarget,
} from './remoteTree.js'

export type RemoteGroupId = RemoteTreeGroup['id']

export type RemoteNode =
  | { readonly kind: 'group'; readonly group: RemoteTreeGroup }
  | { readonly kind: 'target'; readonly target: RemoteTreeTarget; readonly groupId: RemoteGroupId }
  | { readonly kind: 'recent'; readonly recent: RemoteTreeRecent; readonly authority: string }
  /** Non-interactive placeholder row (the "no SSH targets" hint). */
  | { readonly kind: 'empty'; readonly groupId: RemoteGroupId; readonly message: string }

export function remoteNodeId(node: RemoteNode): string {
  switch (node.kind) {
    case 'group':
      return `group:${node.group.id}`
    case 'target':
      return `target:${node.target.authority}`
    case 'recent':
      return `recent:${node.authority}:${node.recent.folder.toString()}`
    case 'empty':
      return `empty:${node.groupId}`
  }
}

export interface IRemoteTreeSnapshot {
  readonly roots: readonly RemoteNode[]
  readonly childrenById: ReadonlyMap<string, readonly RemoteNode[]>
  readonly parentById: ReadonlyMap<string, RemoteNode>
}

/**
 * Flatten a `RemoteTree` into the roots / children / parent index the data
 * source serves. The SSH group is always a root (it owns the empty-state hint);
 * WSL only appears once it has targets, matching the pre-tree rendering.
 */
export function buildRemoteTreeSnapshot(
  tree: RemoteTree,
  emptySshMessage: string,
): IRemoteTreeSnapshot {
  const roots: RemoteNode[] = []
  const childrenById = new Map<string, readonly RemoteNode[]>()
  const parentById = new Map<string, RemoteNode>()

  for (const group of tree.groups) {
    if (group.id !== 'ssh' && group.targets.length === 0) continue
    const groupNode: RemoteNode = { kind: 'group', group }
    roots.push(groupNode)

    const groupChildren: RemoteNode[] =
      group.targets.length === 0
        ? [{ kind: 'empty', groupId: group.id, message: emptySshMessage }]
        : group.targets.map((target) => ({ kind: 'target', target, groupId: group.id }))

    childrenById.set(remoteNodeId(groupNode), groupChildren)
    for (const child of groupChildren) {
      parentById.set(remoteNodeId(child), groupNode)
      if (child.kind !== 'target') continue
      const recents: RemoteNode[] = child.target.recents.map((recent) => ({
        kind: 'recent',
        recent,
        authority: child.target.authority,
      }))
      childrenById.set(remoteNodeId(child), recents)
      for (const recentNode of recents) parentById.set(remoteNodeId(recentNode), child)
    }
  }

  return { roots, childrenById, parentById }
}

/**
 * A data source reading the latest snapshot through `getSnapshot`, so the tree
 * model built once at mount keeps serving fresh data after every refresh.
 */
export function createRemoteTreeDataSource(
  getSnapshot: () => IRemoteTreeSnapshot,
): ITreeDataSource<RemoteNode> {
  return {
    getId: remoteNodeId,
    hasChildren: (node) => (getSnapshot().childrenById.get(remoteNodeId(node))?.length ?? 0) > 0,
    getChildren: (node) => getSnapshot().childrenById.get(remoteNodeId(node)) ?? [],
    getRoots: () => getSnapshot().roots,
    getParent: (node) => getSnapshot().parentById.get(remoteNodeId(node)) ?? null,
  }
}
