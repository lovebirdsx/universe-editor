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
  isEqualResource,
  markAsSingleton,
  type IDisposable,
  type URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import type { monaco } from './monaco/MonacoLoader.js'
import { useService } from '../useService.js'

interface Point {
  readonly key: number
  readonly value: number
}

/**
 * Piecewise-linear map: given (key→value) control points, return the value at
 * `probe`, clamping to the endpoints outside the mapped range.
 */
export function interpolate(points: readonly Point[], probe: number): number {
  if (points.length === 0) return 0
  const sorted = [...points].sort((a, b) => a.key - b.key)
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  if (probe <= first.key) return first.value
  if (probe >= last.key) return last.value
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (probe >= a.key && probe <= b.key) {
      const span = b.key - a.key
      const frac = span > 0 ? (probe - a.key) / span : 0
      return a.value + frac * (b.value - a.value)
    }
  }
  return last.value
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

interface LineEntry {
  line: number
  top: number
}

function collectEntries(root: HTMLElement): LineEntry[] {
  const rootRect = root.getBoundingClientRect()
  const out: LineEntry[] = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(el.dataset['line'])
    if (Number.isNaN(line)) continue
    out.push({ line, top: el.getBoundingClientRect().top - rootRect.top + root.scrollTop })
  }
  return out
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
  const probe = startLine - 1 + frac
  return interpolate(
    entries.map((e) => ({ key: e.line, value: e.top })),
    probe,
  )
}

function editorTopForPreview(
  editor: monaco.editor.IStandaloneCodeEditor,
  root: HTMLElement,
): number | undefined {
  const entries = collectEntries(root)
  if (entries.length === 0) return undefined
  const probeLine = interpolate(
    entries.map((e) => ({ key: e.top, value: e.line })),
    root.scrollTop,
  )
  const floor = Math.max(0, Math.floor(probeLine))
  const lineTop = editor.getTopForLineNumber(floor + 1)
  const nextTop = editor.getTopForLineNumber(floor + 2)
  return lineTop + (probeLine - floor) * (nextTop - lineTop)
}

const SUPPRESS_MS = 100

export function useMarkdownSyncScroll(
  previewRootRef: RefObject<HTMLElement | null>,
  sourceUri: URI,
): void {
  const groupsService = useService(IEditorGroupsService)

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
          if (editor instanceof FileEditorInput && isEqualResource(editor.resource, sourceUri)) {
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
  }, [groupsService, sourceUri, previewRootRef])
}
