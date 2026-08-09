/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure snapshot builder shared by the changed-files views (Commit Changes,
 *  Session Changes). Tree mode groups items into a folder tree (single-child
 *  folder chains compacted, e.g. "a" → "a/b"), sorted folders-first then
 *  alphabetically — the same shape the SCM changes tree produces. List mode is
 *  a flat, alphabetically sorted file list whose rows carry the grey `dir`
 *  suffix (tree mode omits it — the folder rows already express the path).
 *  Path splitting is the caller's job (`dirSegments`), so workspace-relative
 *  and payload-relative sources both fit.
 *--------------------------------------------------------------------------------------------*/

export type ChangesTreeViewMode = 'tree' | 'list'

export interface ChangesTreeItem<TEntry> {
  /** Unique key (node id, sort key, findChangesTreeFileNode lookup). */
  readonly path: string
  /** Directory segments for tree-mode grouping (no file name). */
  readonly dirSegments: readonly string[]
  /** Grey directory suffix for list mode; '' hides it. */
  readonly dir: string
  readonly entry: TEntry
}

export type ChangesTreeNode<TEntry> =
  | { kind: 'folder'; id: string; path: string; name: string }
  | { kind: 'file'; id: string; item: ChangesTreeItem<TEntry>; dir?: string }

export interface ChangesTreeSnapshot<TEntry> {
  roots: ChangesTreeNode<TEntry>[]
  childrenMap: Map<string, ChangesTreeNode<TEntry>[]>
  parentMap: Map<string, ChangesTreeNode<TEntry>>
}

interface FolderNode<TEntry> {
  name: string
  path: string
  folders: Map<string, FolderNode<TEntry>>
  files: ChangesTreeItem<TEntry>[]
}

function buildFolderTree<TEntry>(items: readonly ChangesTreeItem<TEntry>[]): FolderNode<TEntry> {
  const rootNode: FolderNode<TEntry> = { name: '', path: '', folders: new Map(), files: [] }
  for (const item of items) {
    let node = rootNode
    let acc = ''
    for (const part of item.dirSegments) {
      acc = acc ? `${acc}/${part}` : part
      let child = node.folders.get(part)
      if (!child) {
        child = { name: part, path: acc, folders: new Map(), files: [] }
        node.folders.set(part, child)
      }
      node = child
    }
    node.files.push(item)
  }
  return rootNode
}

export function buildChangesTreeSnapshot<TEntry>(
  items: readonly ChangesTreeItem<TEntry>[],
  collapsed: ReadonlySet<string>,
  viewMode: ChangesTreeViewMode = 'tree',
): ChangesTreeSnapshot<TEntry> {
  const roots: ChangesTreeNode<TEntry>[] = []
  const childrenMap = new Map<string, ChangesTreeNode<TEntry>[]>()
  const parentMap = new Map<string, ChangesTreeNode<TEntry>>()

  if (viewMode === 'list') {
    for (const item of [...items].sort((a, b) => a.path.localeCompare(b.path))) {
      const id = `file:${item.path}`
      roots.push({ kind: 'file', id, item, ...(item.dir !== '' ? { dir: item.dir } : {}) })
    }
    return { roots, childrenMap, parentMap }
  }

  const addLevel = (
    node: FolderNode<TEntry>,
    parent: ChangesTreeNode<TEntry> | null,
    into: ChangesTreeNode<TEntry>[],
  ): void => {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const f of folders) {
      // Compact a single-subfolder chain ("a" → "a/b") into one node: walk down
      // while each folder holds exactly one subfolder and no files. The node
      // keeps the leaf path; its label shows the joined path.
      let leaf = f
      let displayName = f.name
      while (leaf.files.length === 0 && leaf.folders.size === 1) {
        const only = [...leaf.folders.values()][0]!
        displayName += `/${only.name}`
        leaf = only
      }
      const id = `folder:${leaf.path}`
      const folderNode: ChangesTreeNode<TEntry> = {
        kind: 'folder',
        id,
        path: leaf.path,
        name: displayName,
      }
      into.push(folderNode)
      if (parent) parentMap.set(id, parent)
      if (collapsed.has(leaf.path)) continue
      const children: ChangesTreeNode<TEntry>[] = []
      childrenMap.set(id, children)
      addLevel(leaf, folderNode, children)
    }
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path))
    for (const item of files) {
      const id = `file:${item.path}`
      const fileNode: ChangesTreeNode<TEntry> = { kind: 'file', id, item }
      into.push(fileNode)
      if (parent) parentMap.set(id, parent)
    }
  }

  addLevel(buildFolderTree(items), null, roots)
  return { roots, childrenMap, parentMap }
}

/** First file row whose item path matches `path`, or undefined. */
export function findChangesTreeFileNode<TEntry>(
  snapshot: ChangesTreeSnapshot<TEntry>,
  path: string,
): Extract<ChangesTreeNode<TEntry>, { kind: 'file' }> | undefined {
  const visit = (
    nodes: readonly ChangesTreeNode<TEntry>[],
  ): Extract<ChangesTreeNode<TEntry>, { kind: 'file' }> | undefined => {
    for (const node of nodes) {
      if (node.kind === 'file' && node.item.path === path) return node
      const hit = visit(snapshot.childrenMap.get(node.id) ?? [])
      if (hit) return hit
    }
    return undefined
  }
  return visit(snapshot.roots)
}
