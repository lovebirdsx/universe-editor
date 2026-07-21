/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Two-way scroll sync between a markdown source editor (Monaco) and its
 *  rendered preview. Maps source line numbers (carried as `data-line` on the
 *  preview's block elements) to/from pixel positions, interpolating between the
 *  nearest mapped blocks. A short suppression window after each programmatic
 *  scroll breaks the feedback loop. Only active while the source editor is
 *  mounted alongside the preview (preview-to-the-side); plain preview and the
 *  in-place toggle (Ctrl+Shift+V, where the source tab is detached) fall back to
 *  no sync — see the `enabled` gate below.
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
import {
  collectEntries,
  editorScrollTopForLine,
  interpolate,
  type Point,
} from './previewScrollMap.js'
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

  // probeLine is a 1-based source line; clamp so the preview scrolled to its
  // bottom lands the last source line flush at the editor's bottom instead of
  // yanking it up to the viewport top.
  const probeLine = interpolate(reversePoints, root.scrollTop)
  const contentBottom = editor.getBottomForLineNumber(Math.max(1, totalLines))
  const viewportHeight = editor.getLayoutInfo().height
  return editorScrollTopForLine({
    probeLine,
    topForLine: (line) => editor.getTopForLineNumber(line),
    contentBottom,
    viewportHeight,
  })
}

const SUPPRESS_MS = 100

export function useMarkdownSyncScroll(
  previewRootRef: RefObject<HTMLElement | null>,
  sourceUri: URI,
  enabled = true,
): void {
  const groupsService = useService(IEditorGroupsService)
  const uriIdentity = useService(IUriIdentityService)

  useEffect(() => {
    // In-place toggle mode (Ctrl+Shift+V) detaches the source tab, so there is no
    // co-mounted source editor to pair with. Without this gate, findEditor() would
    // latch onto an *unrelated* split of the same file living in another group and
    // drive its scroll from the preview's — visibly yanking that other editor.
    if (!enabled) return
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
  }, [groupsService, sourceUri, previewRootRef, uriIdentity, enabled])
}
