/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useSearchActions — handlers invoked from the results tree:
 *    • onActivateMatch  — open the file in the editor + reveal the range.
 *    • onReplaceFile    — replace every match in one file, then drop it from results.
 *    • onReplaceMatch   — replace one range, then drop it from results.
 *    • replaceAll       — replace every match across every file (always with confirmation).
 *
 *  The replace path goes through Monaco when the file already has a live model
 *  (so the user gets undo) and through IFileService otherwise.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import {
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IFileService,
  IInstantiationService,
  IUriIdentityService,
  URI,
  type IFileMatch,
  type ITextSearchMatch,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { waitForFileEditor } from '../../services/editor/revealEditorPosition.js'
import { MonacoModelRegistry } from '../editor/monaco/MonacoModelRegistry.js'
import { applyReplacements, type IReplaceEdit } from '../../services/search/replace.js'
import { saveReplacedFile } from '../../services/search/saveReplacedFile.js'

export interface ISearchActions {
  readonly onActivateMatch: (
    resource: URI,
    match: ITextSearchMatch,
    rangeIndex: number,
    preview?: boolean,
  ) => void
  readonly onReplaceFile: (resource: URI) => void
  readonly onReplaceMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  readonly replaceAll: () => Promise<void>
  /** Drop one match range from the results without touching the file on disk. */
  readonly dismissMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  /** Drop an entire file's matches from the results without touching disk. */
  readonly dismissFile: (resource: URI) => void
}

export function useSearchActions(
  results: readonly IFileMatch[],
  setResults: React.Dispatch<React.SetStateAction<readonly IFileMatch[]>>,
  replacePattern: string,
): ISearchActions {
  const editorGroupsService = useService(IEditorGroupsService)
  const editorService = useService(IEditorService)
  const instantiation = useService(IInstantiationService)
  const fileService = useService(IFileService)
  const dialogService = useService(IDialogService)
  const uriIdentity = useService(IUriIdentityService)

  const onActivateMatch = useCallback(
    (resource: URI, match: ITextSearchMatch, rangeIndex: number, preview = true) => {
      const input = instantiation.createInstance(FileEditorInput, resource)
      editorService.openEditor(input, { pinned: !preview })
      // openEditor dedupes by resource and can discard the fresh input, so reveal
      // against the active instance that actually owns the mounted Monaco editor.
      const active = editorService.activeEditor.get()
      if (!(active instanceof FileEditorInput)) return
      void (async () => {
        const editor = await waitForFileEditor(active)
        const range = match.ranges[rangeIndex]
        if (!editor || !range) return
        editor.setSelection({
          startLineNumber: match.lineNumber,
          startColumn: range.startColumn,
          endLineNumber: match.lineNumber,
          endColumn: range.endColumn,
        })
        editor.revealLineInCenter(match.lineNumber)
        if (!preview) editor.focus()
      })()
    },
    [editorService, instantiation],
  )

  const replaceFile = useCallback(
    async (resource: URI, edits: readonly IReplaceEdit[]) => {
      if (edits.length === 0) return
      const model = MonacoModelRegistry.peek(resource)
      if (model) {
        // Already-open file: route through Monaco so the user can undo.
        const monacoEdits = edits.map((e) => ({
          range: {
            startLineNumber: e.line,
            startColumn: e.startColumn,
            endLineNumber: e.line,
            endColumn: e.endColumn,
          },
          text: e.replaceText,
        }))
        model.pushEditOperations([], monacoEdits, () => null)
        // Auto-save across all groups with URI-case-normalised lookup.
        await saveReplacedFile(resource, editorGroupsService, uriIdentity)
      } else {
        let text: string
        try {
          text = await fileService.readFileText(resource)
        } catch {
          return
        }
        const next = applyReplacements(text, edits)
        if (next !== text) {
          await fileService.writeFile(resource, next)
        }
      }
    },
    [fileService, editorGroupsService, uriIdentity],
  )

  const replaceFileMatch = useCallback(
    (fileMatch: IFileMatch) => {
      const edits: IReplaceEdit[] = []
      for (const m of fileMatch.matches) {
        for (const r of m.ranges) {
          edits.push({
            line: m.lineNumber,
            startColumn: r.startColumn,
            endColumn: r.endColumn,
            replaceText: replacePattern,
          })
        }
      }
      const resource = fileMatch.resource
      void replaceFile(resource, edits)
      setResults((prev) => prev.filter((fm) => fm !== fileMatch))
    },
    [replaceFile, replacePattern, setResults],
  )

  const onReplaceFile = useCallback(
    (resource: URI) => {
      const fm = results.find((r) => uriIdentity.isEqual(r.resource, resource))
      if (fm) replaceFileMatch(fm)
    },
    [results, replaceFileMatch, uriIdentity],
  )

  const onReplaceMatch = useCallback(
    (resource: URI, match: ITextSearchMatch, rangeIndex: number) => {
      const range = match.ranges[rangeIndex]
      if (!range) return
      void replaceFile(resource, [
        {
          line: match.lineNumber,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
          replaceText: replacePattern,
        },
      ])
      setResults((prev) =>
        prev
          .map((fm) => {
            if (fm.resource.toString() !== resource.toString()) return fm
            const matches = fm.matches
              .map((m) => {
                if (m !== match) return m
                const ranges = m.ranges.filter((_, i) => i !== rangeIndex)
                return ranges.length === 0 ? null : { ...m, ranges }
              })
              .filter((m): m is ITextSearchMatch => m !== null)
            return matches.length === 0 ? null : { ...fm, matches }
          })
          .filter((fm): fm is IFileMatch => fm !== null),
      )
    },
    [replaceFile, replacePattern, setResults],
  )

  const replaceAll = useCallback(async () => {
    const totalChanges = results.reduce(
      (n, fm) => n + fm.matches.reduce((m, mm) => m + mm.ranges.length, 0),
      0,
    )
    if (totalChanges === 0) return
    const ok = await dialogService.confirm({
      message: `在 ${results.length} 个文件中替换 ${totalChanges} 处。继续?`,
      type: 'warning',
      primaryButton: '替换',
      cancelButton: '取消',
    })
    if (!ok.confirmed) return
    for (const fm of results) {
      const edits: IReplaceEdit[] = []
      for (const m of fm.matches) {
        for (const r of m.ranges) {
          edits.push({
            line: m.lineNumber,
            startColumn: r.startColumn,
            endColumn: r.endColumn,
            replaceText: replacePattern,
          })
        }
      }
      await replaceFile(fm.resource, edits)
    }
    setResults([])
  }, [results, replaceFile, replacePattern, dialogService, setResults])

  const dismissMatch = useCallback(
    (resource: URI, match: ITextSearchMatch, rangeIndex: number) => {
      setResults((prev) =>
        prev
          .map((fm) => {
            if (fm.resource.toString() !== resource.toString()) return fm
            const matches = fm.matches
              .map((m) => {
                if (m !== match) return m
                const ranges = m.ranges.filter((_, i) => i !== rangeIndex)
                return ranges.length === 0 ? null : { ...m, ranges }
              })
              .filter((m): m is ITextSearchMatch => m !== null)
            return matches.length === 0 ? null : { ...fm, matches }
          })
          .filter((fm): fm is IFileMatch => fm !== null),
      )
    },
    [setResults],
  )

  const dismissFile = useCallback(
    (resource: URI) => {
      setResults((prev) => prev.filter((fm) => fm.resource.toString() !== resource.toString()))
    },
    [setResults],
  )

  return {
    onActivateMatch,
    onReplaceFile,
    onReplaceMatch,
    replaceAll,
    dismissMatch,
    dismissFile,
  }
}
