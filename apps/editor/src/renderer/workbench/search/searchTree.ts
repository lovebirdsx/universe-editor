/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  searchTree — builds the visible-node snapshot consumed by the generic Tree.
 *
 *  Two shapes from the same flat IFileMatch[]:
 *    • 'list' — file nodes at the root, each match range a leaf below it.
 *    • 'tree' — workspace-relative folder hierarchy → file → match.
 *
 *  Pure and view-agnostic so it can be unit-tested without React. The snapshot
 *  carries the parent links + the expandable ids the model needs for reveal and
 *  collapse-all.
 *--------------------------------------------------------------------------------------------*/

import { URI, type IFileMatch, type ITextSearchMatch } from '@universe-editor/platform'
import { comparePaths } from './searchCompare.js'
import type { SearchViewMode } from './searchViewState.js'

export type SearchNode =
  | {
      readonly kind: 'folder'
      readonly id: string
      readonly name: string
      readonly relPath: string
      readonly matchCount: number
    }
  | {
      readonly kind: 'file'
      readonly id: string
      readonly resource: URI
      readonly fileMatch: IFileMatch
      readonly name: string
      readonly relPath: string
      readonly matchCount: number
    }
  | {
      readonly kind: 'match'
      readonly id: string
      readonly resource: URI
      readonly match: ITextSearchMatch
      readonly rangeIndex: number
    }

export interface SearchSnapshot {
  readonly roots: SearchNode[]
  readonly childrenMap: Map<string, SearchNode[]>
  readonly parentMap: Map<string, SearchNode>
  /** Folder + file ids — every node that can be expanded/collapsed. */
  readonly expandableIds: string[]
}

export const EMPTY_SNAPSHOT: SearchSnapshot = {
  roots: [],
  childrenMap: new Map(),
  parentMap: new Map(),
  expandableIds: [],
}

/** Split a resource into its workspace-relative directory segments + basename. */
function toSegments(rootUri: URI | null, resource: URI): { dirs: string[]; name: string } {
  const full = resource.fsPath.replace(/\\/g, '/')
  let rel = full
  if (rootUri) {
    const root = rootUri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (full === root) rel = ''
    else if (full.startsWith(`${root}/`)) rel = full.slice(root.length + 1)
  }
  const parts = rel.split('/').filter((p) => p.length > 0)
  const name = parts.pop() ?? resource.fsPath
  return { dirs: parts, name }
}

function matchNodes(resource: URI, fileMatch: IFileMatch): SearchNode[] {
  const out: SearchNode[] = []
  const key = resource.toString()
  let flat = 0
  for (const m of fileMatch.matches) {
    for (let ri = 0; ri < m.ranges.length; ri++) {
      out.push({ kind: 'match', id: `match:${key}:${flat}`, resource, match: m, rangeIndex: ri })
      flat++
    }
  }
  return out
}

function countMatches(fileMatch: IFileMatch): number {
  return fileMatch.matches.reduce((n, m) => n + m.ranges.length, 0)
}

export function buildSearchSnapshot(
  results: readonly IFileMatch[],
  rootUri: URI | null,
  mode: SearchViewMode,
): SearchSnapshot {
  const childrenMap = new Map<string, SearchNode[]>()
  const parentMap = new Map<string, SearchNode>()
  const expandableIds: string[] = []
  const roots: SearchNode[] = []

  // Order files purely by their resource path — never by ripgrep's arrival
  // order, which is nondeterministic across runs (see searchCompare.ts).
  const sorted = [...results].sort((a, b) =>
    comparePaths(a.resource.fsPath.replace(/\\/g, '/'), b.resource.fsPath.replace(/\\/g, '/')),
  )

  const childList = (id: string): SearchNode[] => {
    let list = childrenMap.get(id)
    if (!list) {
      list = []
      childrenMap.set(id, list)
    }
    return list
  }

  // Pre-aggregate the match total under every folder so folder rows can show a
  // count badge like files do.
  const folderCount = new Map<string, number>()
  if (mode === 'tree') {
    for (const fm of sorted) {
      const { dirs } = toSegments(rootUri, fm.resource)
      const count = countMatches(fm)
      let acc = ''
      for (const seg of dirs) {
        acc = acc ? `${acc}/${seg}` : seg
        folderCount.set(acc, (folderCount.get(acc) ?? 0) + count)
      }
    }
  }

  const folderNodes = new Map<string, SearchNode>()
  const ensureFolderChain = (dirs: string[]): SearchNode | null => {
    if (mode !== 'tree' || dirs.length === 0) return null
    let parent: SearchNode | null = null
    let acc = ''
    for (const seg of dirs) {
      acc = acc ? `${acc}/${seg}` : seg
      let node = folderNodes.get(acc)
      if (!node) {
        node = {
          kind: 'folder',
          id: `folder:${acc}`,
          name: seg,
          relPath: acc,
          matchCount: folderCount.get(acc) ?? 0,
        }
        folderNodes.set(acc, node)
        expandableIds.push(node.id)
        ;(parent ? childList(parent.id) : roots).push(node)
        if (parent) parentMap.set(node.id, parent)
      }
      parent = node
    }
    return parent
  }

  for (const fm of sorted) {
    const resource = fm.resource
    const { dirs, name } = toSegments(rootUri, resource)
    const parentFolder = ensureFolderChain(dirs)
    const relPath = dirs.length > 0 ? `${dirs.join('/')}/${name}` : name
    const fileNode: SearchNode = {
      kind: 'file',
      id: `file:${resource.toString()}`,
      resource,
      fileMatch: fm,
      name,
      relPath,
      matchCount: countMatches(fm),
    }
    expandableIds.push(fileNode.id)
    ;(parentFolder ? childList(parentFolder.id) : roots).push(fileNode)
    if (parentFolder) parentMap.set(fileNode.id, parentFolder)

    const matches = matchNodes(resource, fm)
    childrenMap.set(fileNode.id, matches)
    for (const mn of matches) parentMap.set(mn.id, fileNode)
  }

  if (mode === 'tree') {
    const compactChains = (nodes: SearchNode[]): void => {
      for (const node of nodes) {
        if (node.kind !== 'folder') continue
        compactChains(childrenMap.get(node.id) ?? [])
        let current = childrenMap.get(node.id) ?? []
        while (current.length === 1 && current[0]!.kind === 'folder') {
          const child = current[0] as Extract<SearchNode, { kind: 'folder' }>
          ;(node as Record<string, unknown>)['name'] = (node.name as string) + '/' + child.name
          ;(node as Record<string, unknown>)['relPath'] = child.relPath
          const grandchildren = childrenMap.get(child.id) ?? []
          childrenMap.delete(child.id)
          const idx = expandableIds.indexOf(child.id)
          if (idx >= 0) expandableIds.splice(idx, 1)
          for (const gc of grandchildren) parentMap.set(gc.id, node)
          parentMap.delete(child.id)
          current = grandchildren
        }
        childrenMap.set(node.id, current)
      }
    }
    compactChains(roots)
  }

  return { roots, childrenMap, parentMap, expandableIds }
}
