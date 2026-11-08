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
  localize,
  URI,
  type EditorInput,
  type IFileMatch,
  type ITextEditorSelection,
  type ITextSearchMatch,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import {
  findExistingFileEditor,
  openEditorAndReveal,
  revealSelectionInInput,
} from '../../services/editor/revealEditorPosition.js'
import type { OpenTarget } from '../../services/editor/openTarget.js'
import {
  openExistingInputWithTarget,
  openFreshInputWithTarget,
  type OpenTargetServices,
} from '../../services/editor/openWithTarget.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'
import { MonacoModelRegistry } from '../editor/monaco/MonacoModelRegistry.js'
import { applyReplacements, type IReplaceEdit } from '../../services/search/replace.js'
import { saveReplacedFile } from '../../services/search/saveReplacedFile.js'

export interface ISearchActivateMatchOptions {
  /** Defaults to true (light preview tab); false pins the tab. */
  readonly preview?: boolean
  /** Side / new-window target; defaults to 'default'. */
  readonly target?: OpenTarget
  /** Keep DOM focus where it is (Space preview from the results tree). */
  readonly preserveFocus?: boolean
}

export interface ISearchActions {
  readonly onActivateMatch: (
    resource: URI,
    match: ITextSearchMatch,
    rangeIndex: number,
    options?: ISearchActivateMatchOptions,
  ) => void
  readonly onReplaceFile: (resource: URI) => void
  readonly onReplaceMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  readonly replaceAll: () => Promise<void>
  /** Drop one match range from the results without touching the file on disk. */
  readonly dismissMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  /** Drop an entire file's matches from the results without touching disk. */
  readonly dismissFile: (resource: URI) => void
}

function selectionForMatch(
  match: ITextSearchMatch,
  rangeIndex: number,
): ITextEditorSelection | undefined {
  const range = match.ranges[rangeIndex]
  if (!range) return undefined
  return {
    startLineNumber: match.lineNumber,
    startColumn: range.startColumn,
    endLineNumber: match.lineNumber,
    endColumn: range.endColumn,
  }
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
  const auxiliaryWindows = useService(IAuxiliaryEditorWindowService)

  const openInTarget = useCallback(
    async (
      resource: URI,
      target: Exclude<OpenTarget, 'default'>,
    ): Promise<EditorInput | undefined> => {
      const services: OpenTargetServices = {
        groups: editorGroupsService,
        aux: auxiliaryWindows,
        inst: instantiation,
        uriIdentity,
      }
      const existing = findExistingFileEditor(editorGroupsService, uriIdentity, resource)
      if (existing) {
        const result = await openExistingInputWithTarget(
          services,
          existing.editor,
          existing.group,
          target,
          { pinned: true },
        )
        if (result.handled) return result.editor
        return undefined
      }
      const input = instantiation.createInstance(FileEditorInput, resource)
      const result = await openFreshInputWithTarget(services, input, target, { pinned: true })
      if (result.handled) return result.editor
      if (!input.isDisposed) input.dispose()
      return undefined
    },
    [editorGroupsService, auxiliaryWindows, instantiation, uriIdentity],
  )

  const onActivateMatch = useCallback(
    (
      resource: URI,
      match: ITextSearchMatch,
      rangeIndex: number,
      options: ISearchActivateMatchOptions = {},
    ) => {
      const preview = options.preview ?? true
      const target = options.target ?? 'default'
      const preserveFocus = options.preserveFocus === true
      const selection = selectionForMatch(match, rangeIndex)
      if (target !== 'default') {
        // Modified activations (Ctrl/Alt+Enter) always pin and hand over focus.
        void (async () => {
          const opened = await openInTarget(resource, target)
          if (opened) {
            if (selection) void revealSelectionInInput(opened, selection)
            return
          }
          // Fall back to the ordinary path when the target could not be honoured.
          const input = instantiation.createInstance(FileEditorInput, resource)
          if (selection) {
            openEditorAndReveal(editorService, input, selection, { pinned: !preview })
          } else {
            editorService.openEditor(input, { pinned: !preview })
          }
        })()
        return
      }
      const input = instantiation.createInstance(FileEditorInput, resource)
      // openEditor dedupes by resource and can discard the fresh input, so reveal
      // against the instance it returns (the real tab owner), never activeEditor:
      // the latter follows the focused part and may be in another window.
      if (selection) {
        openEditorAndReveal(editorService, input, selection, {
          pinned: !preview,
          ...(preserveFocus ? { preserveFocus: true } : {}),
          focus: !preserveFocus,
        })
      } else {
        editorService.openEditor(input, {
          pinned: !preview,
          ...(preserveFocus ? { preserveFocus: true } : {}),
        })
      }
    },
    [editorService, instantiation, openInTarget],
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
      message: localize(
        'search.replaceAll.confirm',
        'Replace {changes} occurrences across {files} files. Continue?',
        { changes: totalChanges, files: results.length },
      ),
      type: 'warning',
      primaryButton: localize('search.replaceAll.replace', 'Replace'),
      cancelButton: localize('common.cancel', 'Cancel'),
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
