/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  openEditorSearch — in-memory text search over open editor models, merged
 *  with the ripgrep disk results by TextSearchService. Mirrors VSCode's
 *  SearchService.getOpenEditorResults: untitled buffers have no disk
 *  counterpart so their matches are appended; dirty file buffers override the
 *  stale on-disk result for the same resource. Without this layer a workspace
 *  search silently misses everything that only exists in memory.
 *--------------------------------------------------------------------------------------------*/

import {
  URI,
  type IEditorGroupsService,
  type IFileMatch,
  type ITextSearchQuery,
  type IUriIdentityService,
} from '@universe-editor/platform'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { UntitledEditorInput } from '../editor/UntitledEditorInput.js'
import { compileQuery, scanText } from './scanText.js'

const DEFAULT_MAX_MATCHES_PER_FILE = 1000

/** Resources whose in-memory content should be searched: untitled + dirty files. */
function searchableResources(groups: IEditorGroupsService): URI[] {
  const seen = new Set<string>()
  const out: URI[] = []
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      const include =
        editor instanceof UntitledEditorInput ||
        (editor instanceof FileEditorInput && editor.isDirty)
      if (!include) continue
      const key = editor.resource.toString()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(editor.resource)
    }
  }
  return out
}

export function searchOpenEditorModels(
  groups: IEditorGroupsService,
  query: ITextSearchQuery,
): IFileMatch[] {
  const re = compileQuery(query)
  const capPerFile = query.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE
  const out: IFileMatch[] = []
  for (const resource of searchableResources(groups)) {
    const model = MonacoModelRegistry.peek(resource)
    if (!model || model.isDisposed()) continue
    const { matches } = scanText(model.getValue(), re, capPerFile)
    if (matches.length > 0) out.push({ resource, matches })
  }
  return out
}

/**
 * Fold in-memory results into the disk result set: same-resource entries are
 * replaced (the buffer is newer than the file), new resources are appended.
 * Disk results arrive over IPC, so their `resource` is revived before compare.
 */
export function mergeOpenEditorResults(
  diskResults: readonly IFileMatch[],
  editorResults: readonly IFileMatch[],
  uriIdentity: IUriIdentityService,
): IFileMatch[] {
  const merged = [...diskResults]
  for (const editorMatch of editorResults) {
    const idx = merged.findIndex((fm) =>
      uriIdentity.isEqual(URI.revive(fm.resource) as URI, editorMatch.resource),
    )
    if (idx === -1) merged.push(editorMatch)
    else merged[idx] = editorMatch
  }
  return merged
}
