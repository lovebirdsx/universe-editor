/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure breadcrumb path model: file/directory segments derived from the editor
 *  URI plus the workspace folder, and symbol segments derived from the outline
 *  ancestry. No React/DI, so every path rule is unit-testable.
 *--------------------------------------------------------------------------------------------*/

import { URI, type IUriIdentityService, type IWorkspace } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import type { OutlineModel } from '../languageFeatures/editorOutlineTracker.js'
import { symbolAncestryPath } from '../languageFeatures/symbolTree.js'
import { displaySymbolName } from '../../workbench/outline/outlineTree.js'
import type { BreadcrumbsPathMode } from './breadcrumbsConfig.js'

export interface FileBreadcrumbSegment {
  readonly kind: 'root' | 'folder' | 'file'
  readonly uri: URI
  readonly label: string
}

export interface SymbolBreadcrumbSegment {
  readonly kind: 'symbol'
  readonly symbol: monaco.languages.DocumentSymbol
  readonly label: string
}

export type BreadcrumbEntry =
  | { readonly kind: 'file'; readonly index: number; readonly segment: FileBreadcrumbSegment }
  | { readonly kind: 'symbol'; readonly index: number; readonly segment: SymbolBreadcrumbSegment }

function applyMode(
  segments: readonly FileBreadcrumbSegment[],
  mode: BreadcrumbsPathMode,
): readonly FileBreadcrumbSegment[] {
  if (mode === 'off') return []
  if (mode === 'last') {
    const last = segments[segments.length - 1]
    return last ? [last] : []
  }
  return segments
}

function buildRelativeSegments(
  resource: URI,
  workspace: IWorkspace,
  uriIdentity: IUriIdentityService,
): readonly FileBreadcrumbSegment[] {
  const rel = uriIdentity.relativePath(workspace.folder, resource)
  if (rel === null) return []
  const names = rel.split('/').filter(Boolean)
  if (names.length === 0) return []

  const segments: FileBreadcrumbSegment[] = []
  let current = workspace.folder
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!
    current = URI.joinPath(current, name)
    segments.push({
      kind: i === names.length - 1 ? 'file' : 'folder',
      uri: current,
      label: name,
    })
  }
  return segments
}

function buildAbsoluteSegments(resource: URI): readonly FileBreadcrumbSegment[] {
  const path = resource.path
  const drive = /^\/([A-Za-z]):(?:\/|$)/.exec(path)
  let rootPath: string
  let rootLabel: string
  let rest: string
  if (drive) {
    const letter = drive[1]!
    rootPath = `/${letter}:/`
    rootLabel = `${letter.toUpperCase()}:\\`
    rest = path.slice(rootPath.length)
  } else {
    rootPath = '/'
    rootLabel = '/'
    rest = path.startsWith('/') ? path.slice(1) : path
  }

  const names = rest.split('/').filter(Boolean)
  // Keep the scheme/authority (remote-ssh and friends) while replacing the path;
  // `.fsPath` would silently drop it.
  const rootUri = resource.with({ path: rootPath })
  const segments: FileBreadcrumbSegment[] = [{ kind: 'root', uri: rootUri, label: rootLabel }]
  let current = rootUri
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!
    current = URI.joinPath(current, name)
    segments.push({
      kind: i === names.length - 1 ? 'file' : 'folder',
      uri: current,
      label: name,
    })
  }
  return segments
}

export function buildFileBreadcrumbSegments(
  resource: URI,
  workspace: IWorkspace | null,
  uriIdentity: IUriIdentityService,
  mode: BreadcrumbsPathMode,
): readonly FileBreadcrumbSegment[] {
  if (mode === 'off') return []
  const relative = workspace ? buildRelativeSegments(resource, workspace, uriIdentity) : []
  if (relative.length > 0) return applyMode(relative, mode)
  if (workspace && uriIdentity.relativePath(workspace.folder, resource) !== null) {
    // The resource IS the workspace folder; VSCode shows no path for it.
    return []
  }
  return applyMode(buildAbsoluteSegments(resource), mode)
}

export function buildSymbolBreadcrumbSegments(
  outline: OutlineModel | undefined,
  activeSymbol: monaco.languages.DocumentSymbol | undefined,
  mode: BreadcrumbsPathMode,
): readonly SymbolBreadcrumbSegment[] {
  if (mode === 'off' || !outline || !activeSymbol) return []
  const path = symbolAncestryPath(outline.roots, activeSymbol)
  if (path.length === 0) return []
  const selected = mode === 'last' ? path.slice(-1) : path
  return selected.map((symbol) => ({
    kind: 'symbol' as const,
    symbol,
    label: displaySymbolName(symbol.name, outline.languageId),
  }))
}

export function buildBreadcrumbEntries(
  fileSegments: readonly FileBreadcrumbSegment[],
  symbolSegments: readonly SymbolBreadcrumbSegment[],
): readonly BreadcrumbEntry[] {
  return [
    ...fileSegments.map((segment, index) => ({ kind: 'file' as const, index, segment })),
    ...symbolSegments.map((segment, index) => ({
      kind: 'symbol' as const,
      index: fileSegments.length + index,
      segment,
    })),
  ]
}
