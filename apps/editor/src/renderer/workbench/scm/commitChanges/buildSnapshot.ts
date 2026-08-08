/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure snapshot builder for the Commit Changes view: flattens the payload's
 *  file entries into a folder tree (single-child folder chains compacted, e.g.
 *  "a" → "a/b"), sorted folders-first then alphabetically — the same shape the
 *  SCM changes tree produces, but sourced from CommitChangesFileEntry instead
 *  of IScmGroupModel so the two views stay decoupled.
 *--------------------------------------------------------------------------------------------*/

import type { CommitChangesFileEntry } from '@universe-editor/extensions-common'

export type CommitChangesNode =
  | { kind: 'folder'; id: string; path: string; name: string }
  | { kind: 'file'; id: string; entry: CommitChangesFileEntry; dir?: string }

export interface CommitChangesSnapshot {
  roots: CommitChangesNode[]
  childrenMap: Map<string, CommitChangesNode[]>
  parentMap: Map<string, CommitChangesNode>
}

interface FolderNode {
  name: string
  path: string
  folders: Map<string, FolderNode>
  files: CommitChangesFileEntry[]
}

function splitPath(path: string): string[] {
  return path.split('/').filter((p) => p !== '')
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function buildFolderTree(files: readonly CommitChangesFileEntry[]): FolderNode {
  const rootNode: FolderNode = { name: '', path: '', folders: new Map(), files: [] }
  for (const entry of files) {
    const parts = splitPath(entry.path)
    parts.pop()
    let node = rootNode
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      let child = node.folders.get(part)
      if (!child) {
        child = { name: part, path: acc, folders: new Map(), files: [] }
        node.folders.set(part, child)
      }
      node = child
    }
    node.files.push(entry)
  }
  return rootNode
}

export function buildCommitChangesSnapshot(
  files: readonly CommitChangesFileEntry[],
  collapsed: ReadonlySet<string>,
): CommitChangesSnapshot {
  const roots: CommitChangesNode[] = []
  const childrenMap = new Map<string, CommitChangesNode[]>()
  const parentMap = new Map<string, CommitChangesNode>()

  const addLevel = (
    node: FolderNode,
    parent: CommitChangesNode | null,
    into: CommitChangesNode[],
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
      const folderNode: CommitChangesNode = {
        kind: 'folder',
        id,
        path: leaf.path,
        name: displayName,
      }
      into.push(folderNode)
      if (parent) parentMap.set(id, parent)
      if (collapsed.has(leaf.path)) continue
      const children: CommitChangesNode[] = []
      childrenMap.set(id, children)
      addLevel(leaf, folderNode, children)
    }
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path))
    for (const entry of files) {
      const id = `file:${entry.path}`
      const dir = dirname(entry.path)
      const fileNode: CommitChangesNode = {
        kind: 'file',
        id,
        entry,
        ...(dir !== '' ? { dir } : {}),
      }
      into.push(fileNode)
      if (parent) parentMap.set(id, parent)
    }
  }

  addLevel(buildFolderTree(files), null, roots)
  return { roots, childrenMap, parentMap }
}

/** First file row whose entry path matches `path`, or undefined. */
export function findFileNode(
  snapshot: CommitChangesSnapshot,
  path: string,
): Extract<CommitChangesNode, { kind: 'file' }> | undefined {
  const visit = (
    nodes: readonly CommitChangesNode[],
  ): Extract<CommitChangesNode, { kind: 'file' }> | undefined => {
    for (const node of nodes) {
      if (node.kind === 'file' && node.entry.path === path) return node
      const hit = visit(snapshot.childrenMap.get(node.id) ?? [])
      if (hit) return hit
    }
    return undefined
  }
  return visit(snapshot.roots)
}
