/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Two-way scroll sync between a markdown source editor (Monaco) and its
 *  rendered preview. Maps source line numbers (carried as `data-line` on the
 *  preview's block elements) to/from pixel positions, interpolating between the
 *  nearest mapped blocks. A short suppression window after each programmatic
 *  scroll breaks the feedback loop. Only active while the source editor is
 *  mounted (preview-to-the-side); plain preview falls back to no sync.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, type RefObject } from 'react'
import {
  IEditorGroupsService,
  IUriIdentityService,
  markAsSingleton,
  type IDisposable,
  type URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { collectEntries, interpolate, type Point } from './previewScrollMap.js'
import { useService } from '../useService.js'

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function previewTopForEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  root: HTMLElement,
): number | undefined {
  const entries = collectEntries(root)
  if (entries.length === 0) return undefined
  const startLine = editor.getVisibleRanges()[0]?.startLineNumber ?? 1
  const lineTop = editor.getTopForLineNumber(startLine)
  const nextTop = editor.getTopForLineNumber(startLine + 1)
  const frac =
    nextTop > lineTop ? clamp01((editor.getScrollTop() - lineTop) / (nextTop - lineTop)) : 0
  // entries carry 1-based source lines, so probe in the same 1-based space.
  const probe = startLine + frac

  const totalLines = editor.getModel()?.getLineCount() ?? 0
  const maxPreviewScroll = Math.max(0, root.scrollHeight - root.clientHeight)
  const points: Point[] = entries.map((e) => ({ key: e.line, value: e.top }))
  if (totalLines > (entries[entries.length - 1]?.line ?? -1)) {
    points.push({ key: totalLines, value: maxPreviewScroll })
  }
  return interpolate(points, probe)
}

function editorTopForPreview(
  editor: monaco.editor.IStandaloneCodeEditor,
  root: HTMLElement,
): number | undefined {
  const entries = collectEntries(root)
  if (entries.length === 0) return undefined

  const totalLines = editor.getModel()?.getLineCount() ?? 0
  const maxPreviewScroll = Math.max(0, root.scrollHeight - root.clientHeight)
  const reversePoints: Point[] = entries.map((e) => ({ key: e.top, value: e.line }))
  if (totalLines > (entries[entries.length - 1]?.line ?? -1)) {
    reversePoints.push({ key: maxPreviewScroll, value: totalLines })
  }

  // probeLine is a 1-based source line; clamp to >= 1 before reading line tops.
  const probeLine = interpolate(reversePoints, root.scrollTop)
  const floor = Math.max(1, Math.floor(probeLine))
  const lineTop = editor.getTopForLineNumber(floor)
  const nextTop = editor.getTopForLineNumber(floor + 1)
  return lineTop + (probeLine - floor) * (nextTop - lineTop)
}

const SUPPRESS_MS = 100

export function useMarkdownSyncScroll(
  previewRootRef: RefObject<HTMLElement | null>,
  sourceUri: URI,
): void {
  const groupsService = useService(IEditorGroupsService)
  const uriIdentity = useService(IUriIdentityService)

  useEffect(() => {
    const root = previewRootRef.current
    if (!root) return

    let currentEditor: monaco.editor.IStandaloneCodeEditor | undefined
    let editorScrollSub: IDisposable | undefined
    let suppressPreviewUntil = 0
    let suppressEditorUntil = 0

    const findEditor = (): monaco.editor.IStandaloneCodeEditor | undefined => {
      for (const group of groupsService.groups) {
        for (const editor of group.editors) {
          if (
            editor instanceof FileEditorInput &&
            uriIdentity.isEqual(editor.resource, sourceUri)
          ) {
            const inst = FileEditorRegistry.get(editor)
            if (inst) return inst
          }
        }
      }
      return undefined
    }

    const onEditorScroll = () => {
      if (!currentEditor || performance.now() < suppressEditorUntil) return
      const target = previewTopForEditor(currentEditor, root)
      if (target === undefined) return
      suppressPreviewUntil = performance.now() + SUPPRESS_MS
      root.scrollTop = target
    }

    const onPreviewScroll = () => {
      if (!currentEditor || performance.now() < suppressPreviewUntil) return
      const target = editorTopForPreview(currentEditor, root)
      if (target === undefined) return
      suppressEditorUntil = performance.now() + SUPPRESS_MS
      currentEditor.setScrollTop(target)
    }

    const reattach = () => {
      const next = findEditor()
      if (next === currentEditor) return
      editorScrollSub?.dispose()
      editorScrollSub = undefined
      currentEditor = next
      if (next) editorScrollSub = next.onDidScrollChange(onEditorScroll)
    }

    root.addEventListener('scroll', onPreviewScroll, { passive: true })
    const regSub = markAsSingleton(FileEditorRegistry.onDidChange(reattach))
    reattach()

    return () => {
      root.removeEventListener('scroll', onPreviewScroll)
      editorScrollSub?.dispose()
      regSub.dispose()
    }
  }, [groupsService, sourceUri, previewRootRef, uriIdentity])
}
