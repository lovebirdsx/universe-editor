/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  SwarmInlineCommentController — GitHub-PR-style inline comments on a Swarm diff.
 *  Mirrors InlineDirtyDiffController's rendering contract: for each anchored line
 *  an EMPTY view zone reserves the vertical band (never paints over code) while a
 *  React-rendered thread panel is an OVERLAY widget the zone repositions via
 *  onDomNodeTop / onComputedHeight.
 *
 *  Two kinds of zone:
 *   - existing threads: one zone per (side, line) holding the comment list + reply.
 *   - a transient compose zone: opened when the user clicks the `+` glyph on a
 *     gutter line, closed on submit/cancel.
 *
 *  Comment coordinates map to Swarm's context: the modified side → rightLine, the
 *  original side → leftLine, plus the version and the anchored line's content and
 *  4 preceding lines (Swarm re-anchors on drift — API requirement).
 *--------------------------------------------------------------------------------------------*/

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Disposable } from '@universe-editor/platform'
import type { SwarmCommentDto } from '@universe-editor/extensions-common'
import { MonacoLoader, type monaco } from '../editor/monaco/MonacoLoader.js'
import { SwarmInlineThread } from './SwarmInlineThread.js'

export type DiffSide = 'left' | 'right'

export interface SwarmInlineSubmit {
  readonly side: DiffSide
  readonly line: number
  readonly body: string
  readonly asTask: boolean
  /** The anchored line plus up to 4 preceding lines (Swarm drift re-anchoring). */
  readonly content: string[]
}

export interface SwarmInlineCallbacks {
  /** Post a new inline comment; resolves once the server accepted it. */
  readonly onSubmit: (submit: SwarmInlineSubmit) => Promise<void>
  /** Change a comment's task state (open / addressed / verified / comment). */
  readonly onSetTaskState: (commentId: string, taskState: string) => Promise<void>
  /** Reply to an existing thread (same anchor as the thread's first comment). */
  readonly onReply: (submit: SwarmInlineSubmit) => Promise<void>
}

interface Zone {
  side: DiffSide
  line: number
  zoneId: string
  node: HTMLElement
  root: Root
  height: number
  overlay: monaco.editor.IOverlayWidget
}

/** Group key for a thread anchor. */
function anchorKey(side: DiffSide, line: number): string {
  return `${side}:${line}`
}

export class SwarmInlineCommentController extends Disposable {
  private readonly _zones = new Map<string, Zone>()
  private _composeKey: string | undefined
  private _comments: readonly SwarmCommentDto[] = []
  private readonly _glyphDecos = { left: [] as string[], right: [] as string[] }

  constructor(
    private readonly _diffEditor: monaco.editor.IStandaloneDiffEditor,
    private readonly _callbacks: SwarmInlineCallbacks,
  ) {
    super()
    this._register({ dispose: () => this._teardownAll() })
    this._wireGutterAffordance('left', this._diffEditor.getOriginalEditor())
    this._wireGutterAffordance('right', this._diffEditor.getModifiedEditor())
  }

  /** Re-render all threads from the given comment set (call after load / post). */
  setComments(comments: readonly SwarmCommentDto[]): void {
    this._comments = comments
    this._renderThreads()
  }

  /** Open a compose box under (side, line); closes any prior compose box. */
  openCompose(side: DiffSide, line: number): void {
    if (this._composeKey) {
      const prev = this._zones.get(this._composeKey)
      if (prev && !this._hasThread(prev.side, prev.line)) this._removeZone(this._composeKey)
    }
    const key = anchorKey(side, line)
    this._composeKey = key
    this._renderZone(side, line)
    this._focusZone(key)
  }

  private _hasThread(side: DiffSide, line: number): boolean {
    return this._threadFor(side, line).length > 0
  }

  private _threadFor(side: DiffSide, line: number): SwarmCommentDto[] {
    return this._comments.filter((c) => {
      const ctx = c.context
      if (!ctx) return false
      if (side === 'right') return ctx.rightLine === line
      return ctx.leftLine === line
    })
  }

  /** Distinct anchors that currently have comments. */
  private _threadAnchors(): Array<{ side: DiffSide; line: number }> {
    const seen = new Set<string>()
    const out: Array<{ side: DiffSide; line: number }> = []
    for (const c of this._comments) {
      const ctx = c.context
      if (!ctx) continue
      if (typeof ctx.rightLine === 'number') {
        const k = anchorKey('right', ctx.rightLine)
        if (!seen.has(k)) {
          seen.add(k)
          out.push({ side: 'right', line: ctx.rightLine })
        }
      } else if (typeof ctx.leftLine === 'number') {
        const k = anchorKey('left', ctx.leftLine)
        if (!seen.has(k)) {
          seen.add(k)
          out.push({ side: 'left', line: ctx.leftLine })
        }
      }
    }
    return out
  }

  private _renderThreads(): void {
    const wanted = new Set(this._threadAnchors().map((a) => anchorKey(a.side, a.line)))
    if (this._composeKey) wanted.add(this._composeKey)
    // Remove zones no longer wanted.
    for (const key of [...this._zones.keys()]) {
      if (!wanted.has(key)) this._removeZone(key)
    }
    // (Re)render wanted zones.
    for (const { side, line } of this._threadAnchors()) this._renderZone(side, line)
    if (this._composeKey) {
      const [side, lineStr] = this._composeKey.split(':') as [DiffSide, string]
      this._renderZone(side, Number(lineStr))
    }
  }

  private _editorForSide(side: DiffSide): monaco.editor.IStandaloneCodeEditor {
    return side === 'right'
      ? this._diffEditor.getModifiedEditor()
      : this._diffEditor.getOriginalEditor()
  }

  private _lineContent(side: DiffSide, line: number): string[] {
    const model = this._editorForSide(side).getModel()
    if (!model) return []
    const out: string[] = []
    const start = Math.max(1, line - 4)
    for (let l = start; l <= line && l <= model.getLineCount(); l++) {
      out.push(model.getLineContent(l))
    }
    return out
  }

  private _renderZone(side: DiffSide, line: number): void {
    const key = anchorKey(side, line)
    const editor = this._editorForSide(side)
    const existing = this._zones.get(key)
    const thread = this._threadFor(side, line)
    const composing = this._composeKey === key

    let node: HTMLElement
    let root: Root
    if (existing) {
      node = existing.node
      root = existing.root
    } else {
      node = document.createElement('div')
      node.className = 'swarm-inline-thread'
      node.style.top = '-1000px'
      node.style.position = 'absolute'
      node.style.zIndex = '10'
      root = createRoot(node)
    }

    const submit = async (body: string, asTask: boolean, isReply: boolean): Promise<void> => {
      const payload: SwarmInlineSubmit = {
        side,
        line,
        body,
        asTask,
        content: this._lineContent(side, line),
      }
      if (isReply) await this._callbacks.onReply(payload)
      else await this._callbacks.onSubmit(payload)
      if (composing && !isReply) {
        this._composeKey = undefined
      }
    }

    root.render(
      createElement(SwarmInlineThread, {
        comments: thread,
        composing: composing || thread.length === 0,
        onSubmit: submit,
        onSetTaskState: this._callbacks.onSetTaskState,
        onCancel: () => {
          if (composing) {
            this._composeKey = undefined
            if (thread.length === 0) this._removeZone(key)
          }
        },
        onHeight: (h) => this._resizeZone(key, h),
      }),
    )

    if (!existing) {
      const overlay: monaco.editor.IOverlayWidget = {
        getId: () => `swarm-inline-${key}`,
        getDomNode: () => node,
        getPosition: () => null,
      }
      editor.addOverlayWidget(overlay)
      const zone: Zone = { side, line, zoneId: '', node, root, height: 120, overlay }
      this._zones.set(key, zone)
      this._addViewZone(editor, zone)
      this._layoutNode(side, node)
    }
  }

  private _addViewZone(editor: monaco.editor.IStandaloneCodeEditor, zone: Zone): void {
    editor.changeViewZones((accessor) => {
      const dom = document.createElement('div')
      dom.style.overflow = 'hidden'
      zone.zoneId = accessor.addZone({
        afterLineNumber: zone.line,
        heightInPx: zone.height,
        domNode: dom,
        onDomNodeTop: (top) => {
          zone.node.style.top = `${top}px`
        },
      })
    })
  }

  private _resizeZone(key: string, height: number): void {
    const zone = this._zones.get(key)
    if (!zone || height <= 0 || Math.abs(height - zone.height) < 1) return
    zone.height = height
    const editor = this._editorForSide(zone.side)
    try {
      editor.changeViewZones((accessor) => {
        accessor.removeZone(zone.zoneId)
        const dom = document.createElement('div')
        dom.style.overflow = 'hidden'
        zone.zoneId = accessor.addZone({
          afterLineNumber: zone.line,
          heightInPx: height,
          domNode: dom,
          onDomNodeTop: (top) => {
            zone.node.style.top = `${top}px`
          },
        })
      })
    } catch {
      /* editor disposed */
    }
  }

  private _layoutNode(side: DiffSide, node: HTMLElement): void {
    const editor = this._editorForSide(side)
    const info = editor.getLayoutInfo()
    node.style.left = `${info.contentLeft}px`
    node.style.width = `${Math.max(0, info.width - info.contentLeft - info.verticalScrollbarWidth)}px`
  }

  private _focusZone(key: string): void {
    const zone = this._zones.get(key)
    if (!zone) return
    queueMicrotask(() => {
      const ta = zone.node.querySelector('textarea')
      if (ta instanceof HTMLTextAreaElement) ta.focus()
    })
  }

  private _removeZone(key: string): void {
    const zone = this._zones.get(key)
    if (!zone) return
    const editor = this._editorForSide(zone.side)
    try {
      editor.changeViewZones((accessor) => accessor.removeZone(zone.zoneId))
    } catch {
      /* editor disposed */
    }
    editor.removeOverlayWidget(zone.overlay)
    queueMicrotask(() => zone.root.unmount())
    this._zones.delete(key)
    if (this._composeKey === key) this._composeKey = undefined
  }

  // Add a `+` glyph in the gutter on hover so the user can start a thread on any
  // line (GitHub PR affordance). Clicking the glyph margin opens a compose box.
  private _wireGutterAffordance(side: DiffSide, editor: monaco.editor.IStandaloneCodeEditor): void {
    const m = MonacoLoader.get()
    this._register(
      editor.onMouseDown((e) => {
        if (e.target.type !== m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
        const line = e.target.position?.lineNumber
        if (typeof line === 'number') this.openCompose(side, line)
      }),
    )
    this._register(
      editor.onMouseMove((e) => {
        const line = e.target.position?.lineNumber
        this._updateGlyph(side, editor, typeof line === 'number' ? line : undefined)
      }),
    )
    this._register(editor.onMouseLeave(() => this._updateGlyph(side, editor, undefined)))
  }

  private _updateGlyph(
    side: DiffSide,
    editor: monaco.editor.IStandaloneCodeEditor,
    line: number | undefined,
  ): void {
    const prev = this._glyphDecos[side]
    if (line === undefined) {
      if (prev.length) this._glyphDecos[side] = editor.deltaDecorations(prev, [])
      return
    }
    const m = MonacoLoader.get()
    this._glyphDecos[side] = editor.deltaDecorations(prev, [
      {
        range: new m.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'swarm-inline-add-glyph codicon codicon-add',
          glyphMarginHoverMessage: { value: 'Add a comment' },
        },
      },
    ])
  }

  private _teardownAll(): void {
    for (const key of [...this._zones.keys()]) this._removeZone(key)
    this._zones.clear()
  }
}
