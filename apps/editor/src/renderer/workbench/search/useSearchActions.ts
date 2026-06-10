/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useSearchActions — handlers invoked from the results tree:
 *    • onActivateMatch  — open the file in the editor + reveal the range.
 *    • onReplaceFile    — replace every match in one file, then drop it from results.
 *    • onReplaceMatch   — replace one range, then drop it from results.
 *    • replaceAll       — replace every match across every file (with confirmation
 *                         when the change-count exceeds a threshold).
 *
 *  The replace path goes through Monaco when the file already has a live model
 *  (so the user gets undo) and through IFileService otherwise.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import {
  IDialogService,
  IEditorService,
  IFileService,
  IInstantiationService,
  URI,
  isEqualResource,
  type IFileMatch,
  type ITextSearchMatch,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MonacoModelRegistry } from '../editor/monaco/MonacoModelRegistry.js'
import { applyReplacements, type IReplaceEdit } from '../../services/search/replace.js'

const REPLACE_CONFIRM_THRESHOLD = 20

export interface ISearchActions {
  readonly onActivateMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  readonly onReplaceFile: (resource: URI) => void
  readonly onReplaceMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  readonly replaceAll: () => Promise<void>
}

export function useSearchActions(
  results: readonly IFileMatch[],
  setResults: React.Dispatch<React.SetStateAction<readonly IFileMatch[]>>,
  replacePattern: string,
): ISearchActions {
  const editorService = useService(IEditorService)
  const instantiation = useService(IInstantiationService)
  const fileService = useService(IFileService)
  const dialogService = useService(IDialogService)

  const onActivateMatch = useCallback(
    (resource: URI, match: ITextSearchMatch, rangeIndex: number) => {
      const input = instantiation.createInstance(FileEditorInput, resource)
      editorService.openEditor(input, { pinned: false })
      // Reveal against the *active* editor input, not the one we just created:
      // openEditor dedupes by resource and discards our fresh input when the file
      // is already open, so FileEditorRegistry only knows the original instance.
      const reveal = (): boolean => {
        const active = editorService.activeEditor.get()
        if (!(active instanceof FileEditorInput)) return false
        const editor = FileEditorRegistry.get(active)
        const range = match.ranges[rangeIndex]
        if (!editor || !range) return false
        editor.setSelection({
          startLineNumber: match.lineNumber,
          startColumn: range.startColumn,
          endLineNumber: match.lineNumber,
          endColumn: range.endColumn,
        })
        editor.revealLineInCenter(match.lineNumber)
        return true
      }
      // Monaco may not be mounted yet on first open; retry after a frame.
      if (reveal()) return
      setTimeout(reveal, 50)
    },
    [editorService, instantiation],
  )

  const replaceFile = useCallback(
    async (resource: URI, edits: readonly IReplaceEdit[]) => {
      if (edits.length === 0) return
      const model = MonacoModelRegistry.peek(resource)
      if (model) {
        // Already-open file: route through Monaco so the user can undo / save.
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
    [fileService],
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
      const resource = URI.revive(fileMatch.resource) as URI
      void replaceFile(resource, edits)
      setResults((prev) => prev.filter((fm) => fm !== fileMatch))
    },
    [replaceFile, replacePattern, setResults],
  )

  const onReplaceFile = useCallback(
    (resource: URI) => {
      const fm = results.find((r) => isEqualResource(URI.revive(r.resource) as URI, resource))
      if (fm) replaceFileMatch(fm)
    },
    [results, replaceFileMatch],
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
            if ((URI.revive(fm.resource) as URI).toString() !== resource.toString()) return fm
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
    if (totalChanges > REPLACE_CONFIRM_THRESHOLD) {
      const ok = await dialogService.confirm({
        message: `在 ${results.length} 个文件中替换 ${totalChanges} 处。继续?`,
        type: 'warning',
        primaryButton: '替换',
        cancelButton: '取消',
      })
      if (!ok.confirmed) return
    }
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
      await replaceFile(URI.revive(fm.resource) as URI, edits)
    }
    setResults([])
  }, [results, replaceFile, replacePattern, dialogService, setResults])

  return { onActivateMatch, onReplaceFile, onReplaceMatch, replaceAll }
}
