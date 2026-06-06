/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Build a collapsible directory tree from a flat list of changed files, the way
 *  git-graph (and VSCode's explorer) presents commit changes. Single-child
 *  directory chains are compacted (`a/b/c`) for a denser tree.
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphFileChangeDto } from '@universe-editor/extensions-common'

export interface FileTreeFile {
  readonly kind: 'file'
  /** Leaf label (basename). */
  readonly name: string
  readonly file: GitGraphFileChangeDto
}

export interface FileTreeDir {
  readonly kind: 'dir'
  /** Display label (may span several path segments when compacted). */
  readonly name: string
  /** Full path from the root, used as a stable id for collapse state. */
  readonly path: string
  readonly children: FileTreeNode[]
}

export type FileTreeNode = FileTreeDir | FileTreeFile

interface MutableDir {
  readonly dirs: Map<string, MutableDir>
  readonly files: FileTreeFile[]
}

function emptyDir(): MutableDir {
  return { dirs: new Map(), files: [] }
}

/** Build a compacted directory tree, directories first then files, each alphabetical. */
export function buildFileTree(files: readonly GitGraphFileChangeDto[]): FileTreeNode[] {
  const root = emptyDir()
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    const name = segments.pop() ?? file.path
    let dir = root
    for (const segment of segments) {
      let child = dir.dirs.get(segment)
      if (!child) {
        child = emptyDir()
        dir.dirs.set(segment, child)
      }
      dir = child
    }
    dir.files.push({ kind: 'file', name, file })
  }
  return toNodes(root, '')
}

function toNodes(dir: MutableDir, prefix: string): FileTreeNode[] {
  const dirNodes: FileTreeDir[] = []
  for (const [name, child] of dir.dirs) {
    let label = name
    let cur = child
    let path = prefix ? `${prefix}/${name}` : name
    // Compact single-child directory chains: a → a/b → a/b/c.
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [childName, grandChild] = [...cur.dirs.entries()][0]!
      label = `${label}/${childName}`
      path = `${path}/${childName}`
      cur = grandChild
    }
    dirNodes.push({ kind: 'dir', name: label, path, children: toNodes(cur, path) })
  }
  dirNodes.sort((a, b) => a.name.localeCompare(b.name))
  const fileNodes = [...dir.files].sort((a, b) => a.name.localeCompare(b.name))
  return [...dirNodes, ...fileNodes]
}
