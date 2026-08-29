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
 *
 *  Incremental rebuilds: while a search streams, the engine hands us a new array
 *  every ~80ms whose entries are mostly the *same* IFileMatch objects as last
 *  time — the main process batches whole-file snapshots, so a file that did not
 *  change keeps its object identity. Passing the previous build back in as
 *  `previous` lets us reuse those files' node subtrees wholesale, turning the
 *  per-flush cost from O(total matches) into O(changed matches + files).
 *  Reference equality is the only reuse predicate: two IFileMatch values for the
 *  same URI but different objects always rebuild, so a file's new match set can
 *  never be silently dropped.
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
      /** Workspace-relative directory of the file; '' when it sits at the root. */
      readonly dirPath: string
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
  /** id → node, for imperative focus targeting and incremental reuse lookups. */
  readonly nodeById: Map<string, SearchNode>
  /** The comparePaths-ordered file list, reused as the merge skeleton next round. */
  readonly orderedFiles: readonly IFileMatch[]
}

/**
 * The previous build, handed back to enable incremental reuse. `rootUri` / `mode`
 * are carried alongside so a change in either forces a full rebuild — `previous`
 * is only ever an accelerator, never a source of truth.
 */
export interface SearchBuildContext {
  readonly rootUri: URI | null
  readonly mode: SearchViewMode
  readonly snapshot: SearchSnapshot
}

export const EMPTY_SNAPSHOT: SearchSnapshot = {
  roots: [],
  childrenMap: new Map(),
  parentMap: new Map(),
  expandableIds: [],
  nodeById: new Map(),
  orderedFiles: [],
}

/** Split a resource into its workspace-relative directory segments + basename. */
function toSegments(rootUri: URI | null, resource: URI): { dirs: string[]; name: string } {
  // `uri.path` is already forward-slashed and scheme-agnostic — unlike `.fsPath`,
  // it stays correct for a future non-`file` provider.
  const full = resource.path
  let rel = full
  if (rootUri) {
    const root = rootUri.path.replace(/\/+$/, '')
    if (full === root) rel = ''
    else if (full.startsWith(`${root}/`)) rel = full.slice(root.length + 1)
  }
  const parts = rel.split('/').filter((p) => p.length > 0)
  const name = parts.pop() ?? resource.path
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

function fileNodeOf(rootUri: URI | null, fm: IFileMatch): Extract<SearchNode, { kind: 'file' }> {
  const resource = fm.resource
  const { dirs, name } = toSegments(rootUri, resource)
  return {
    kind: 'file',
    id: `file:${resource.toString()}`,
    resource,
    fileMatch: fm,
    name,
    relPath: dirs.length > 0 ? `${dirs.join('/')}/${name}` : name,
    dirPath: dirs.join('/'),
    matchCount: countMatches(fm),
  }
}

function sortFiles(files: readonly IFileMatch[]): IFileMatch[] {
  return [...files].sort((a, b) => comparePaths(a.resource.path, b.resource.path))
}

/**
 * Merge the changed files into the previous ordering instead of re-sorting the
 * whole set: O(n + k log k) for k changed files rather than O(n log n). The
 * resulting order is identical to a full sort — it is derived purely from
 * comparePaths, never from ripgrep's nondeterministic arrival order.
 */
function mergeOrderedFiles(
  previousOrder: readonly IFileMatch[],
  newByUri: Map<string, IFileMatch>,
  added: readonly IFileMatch[],
): IFileMatch[] {
  const sortedAdded = sortFiles(added)
  const out: IFileMatch[] = []
  let ai = 0
  for (const prevFm of previousOrder) {
    const current = newByUri.get(prevFm.resource.toString())
    if (!current) continue // removed
    while (ai < sortedAdded.length) {
      const candidate = sortedAdded[ai]!
      if (comparePaths(candidate.resource.path, prevFm.resource.path) >= 0) break
      out.push(candidate)
      ai++
    }
    out.push(current)
  }
  while (ai < sortedAdded.length) out.push(sortedAdded[ai++]!)
  return out
}

/**
 * Folder scaffolding for 'tree' mode. Folder nodes are always built fresh — they
 * are never reused across rebuilds, which is what makes the in-place renaming in
 * `compactChains` safe (it only ever mutates nodes created in this same call).
 * Reusing folder nodes across builds would corrupt them; don't.
 */
function buildFolderLayer(
  orderedFiles: readonly IFileMatch[],
  rootUri: URI | null,
  fileNodes: Map<string, SearchNode>,
  childrenMap: Map<string, SearchNode[]>,
  parentMap: Map<string, SearchNode>,
  expandableIds: string[],
): SearchNode[] {
  const roots: SearchNode[] = []

  // Pre-aggregate the match total under every folder so folder rows can show a
  // count badge like files do.
  const folderCount = new Map<string, number>()
  for (const fm of orderedFiles) {
    const { dirs } = toSegments(rootUri, fm.resource)
    const count = countMatches(fm)
    let acc = ''
    for (const seg of dirs) {
      acc = acc ? `${acc}/${seg}` : seg
      folderCount.set(acc, (folderCount.get(acc) ?? 0) + count)
    }
  }

  const childList = (id: string): SearchNode[] => {
    let list = childrenMap.get(id)
    if (!list) {
      list = []
      childrenMap.set(id, list)
    }
    return list
  }

  const folderNodes = new Map<string, SearchNode>()
  /** Folder nodes swallowed by chain compaction; excluded from the id index. */
  const absorbed = new Set<string>()
  const ensureFolderChain = (dirs: string[]): SearchNode | null => {
    if (dirs.length === 0) return null
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

  for (const fm of orderedFiles) {
    const { dirs } = toSegments(rootUri, fm.resource)
    const parentFolder = ensureFolderChain(dirs)
    const fileNode = fileNodes.get(`file:${fm.resource.toString()}`)!
    ;(parentFolder ? childList(parentFolder.id) : roots).push(fileNode)
    if (parentFolder) parentMap.set(fileNode.id, parentFolder)
    else parentMap.delete(fileNode.id)
  }

  // Collapse single-child folder chains (a → a/b → a/b/c) into one row. Mutates
  // the freshly-built folder nodes in place; see buildFolderLayer's contract.
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
        absorbed.add(child.id)
        for (const gc of grandchildren) parentMap.set(gc.id, node)
        parentMap.delete(child.id)
        current = grandchildren
      }
      childrenMap.set(node.id, current)
    }
  }
  compactChains(roots)

  // Absorbed nodes are dropped by id, not by relPath: compaction rewrites
  // `relPath` on the surviving node, so the folderNodes key a child was filed
  // under is no longer derivable from any node once the chain has collapsed.
  for (const node of folderNodes.values()) {
    if (!absorbed.has(node.id)) fileNodes.set(node.id, node)
  }
  return roots
}

export function buildSearchSnapshot(
  results: readonly IFileMatch[],
  rootUri: URI | null,
  mode: SearchViewMode,
  previous?: SearchBuildContext,
): SearchSnapshot {
  const reusable =
    previous !== undefined && previous.mode === mode && previous.rootUri === rootUri
      ? previous.snapshot
      : null

  const newByUri = new Map<string, IFileMatch>()
  for (const fm of results) newByUri.set(fm.resource.toString(), fm)

  let orderedFiles: readonly IFileMatch[]
  let childrenMap: Map<string, SearchNode[]>
  let parentMap: Map<string, SearchNode>
  let nodeById: Map<string, SearchNode>

  if (reusable) {
    const prevByUri = new Map<string, IFileMatch>()
    for (const fm of reusable.orderedFiles) prevByUri.set(fm.resource.toString(), fm)

    const added: IFileMatch[] = []
    for (const [uri, fm] of newByUri) {
      if (!prevByUri.has(uri)) added.push(fm)
    }
    orderedFiles = mergeOrderedFiles(reusable.orderedFiles, newByUri, added)

    // Copy-on-write: unchanged files' entries are carried over untouched, so
    // their match arrays and node objects survive without being walked.
    childrenMap = new Map(reusable.childrenMap)
    parentMap = new Map(reusable.parentMap)
    nodeById = new Map(reusable.nodeById)

    // Folder nodes never survive a rebuild — drop the previous layer entirely so
    // stale folders can't leak into the new snapshot. Folder ids are read off
    // expandableIds (O(files + folders)) rather than by scanning nodeById, which
    // holds every match node and would make each flush O(total matches) again.
    for (const id of reusable.expandableIds) {
      if (!id.startsWith('folder:')) continue
      nodeById.delete(id)
      childrenMap.delete(id)
      parentMap.delete(id)
    }

    const dropFileEntries = (fileId: string): void => {
      for (const m of reusable.childrenMap.get(fileId) ?? []) {
        parentMap.delete(m.id)
        nodeById.delete(m.id)
      }
      childrenMap.delete(fileId)
      nodeById.delete(fileId)
      parentMap.delete(fileId)
    }

    for (const [uri, prevFm] of prevByUri) {
      if (!newByUri.has(uri)) dropFileEntries(`file:${prevFm.resource.toString()}`)
    }

    for (const fm of orderedFiles) {
      const fileId = `file:${fm.resource.toString()}`
      const prevFm = prevByUri.get(fm.resource.toString())
      // Reference equality is the reuse predicate: same object ⇒ same matches.
      if (prevFm === fm && nodeById.has(fileId)) continue
      if (prevFm !== undefined) dropFileEntries(fileId)
      const fileNode = fileNodeOf(rootUri, fm)
      const matches = matchNodes(fm.resource, fm)
      childrenMap.set(fileId, matches)
      nodeById.set(fileId, fileNode)
      for (const m of matches) {
        parentMap.set(m.id, fileNode)
        nodeById.set(m.id, m)
      }
    }
  } else {
    // Order files purely by their resource path — never by ripgrep's arrival
    // order, which is nondeterministic across runs (see searchCompare.ts).
    orderedFiles = sortFiles(results)
    childrenMap = new Map()
    parentMap = new Map()
    nodeById = new Map()

    for (const fm of orderedFiles) {
      const fileNode = fileNodeOf(rootUri, fm)
      const matches = matchNodes(fm.resource, fm)
      childrenMap.set(fileNode.id, matches)
      nodeById.set(fileNode.id, fileNode)
      for (const m of matches) {
        parentMap.set(m.id, fileNode)
        nodeById.set(m.id, m)
      }
    }
  }

  // The expandable list and the root ordering are rebuilt every round: both are
  // O(files), cheap next to the O(matches) work the reuse above skips.
  const expandableIds: string[] = []
  let roots: SearchNode[]

  if (mode === 'tree') {
    roots = buildFolderLayer(orderedFiles, rootUri, nodeById, childrenMap, parentMap, expandableIds)
    for (const fm of orderedFiles) expandableIds.push(`file:${fm.resource.toString()}`)
  } else {
    roots = []
    for (const fm of orderedFiles) {
      const fileId = `file:${fm.resource.toString()}`
      roots.push(nodeById.get(fileId)!)
      expandableIds.push(fileId)
    }
  }

  return { roots, childrenMap, parentMap, expandableIds, nodeById, orderedFiles }
}
