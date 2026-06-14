/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewRegistry — tracks the live preview component backing each open
 *  MarkdownPreviewInput, addressed by source URI. The preview is a plain React
 *  div (no Monaco instance), so the Outline service can't reach it through
 *  FileEditorRegistry; this registry is the equivalent handle. A controller lets
 *  the Outline view scroll the preview to a source line and read the line
 *  currently at the top of the viewport (for active-symbol tracking).
 *
 *  Split views can mount two previews for the same source, so registrations are
 *  kept in order and `get` returns the most recent live one.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type URI } from '@universe-editor/platform'

export interface IMarkdownPreviewController {
  /** Scroll the preview so the block at `line` (1-based source line) is at the top. */
  scrollToLine(line: number): void
  /** Source line (1-based) currently at the top of the preview viewport, if measurable. */
  getTopVisibleLine(): number | undefined
  /** Move keyboard focus to the preview container (so it can be scrolled/navigated). */
  focus(): void
  /** Fires (debounced by the component) when the user scrolls the preview. */
  readonly onDidScroll: Emitter<void>['event']
}

class MarkdownPreviewRegistryImpl {
  private readonly _map = new Map<string, IMarkdownPreviewController[]>()
  private readonly _onDidChange = new Emitter<URI>()
  readonly onDidChange = this._onDidChange.event

  register(sourceUri: URI, controller: IMarkdownPreviewController): void {
    const key = sourceUri.toString()
    const list = this._map.get(key) ?? []
    list.push(controller)
    this._map.set(key, list)
    this._onDidChange.fire(sourceUri)
  }

  unregister(sourceUri: URI, controller: IMarkdownPreviewController): void {
    const key = sourceUri.toString()
    const list = this._map.get(key)
    if (!list) return
    const index = list.indexOf(controller)
    if (index === -1) return
    list.splice(index, 1)
    if (list.length === 0) this._map.delete(key)
    this._onDidChange.fire(sourceUri)
  }

  get(sourceUri: URI): IMarkdownPreviewController | undefined {
    const list = this._map.get(sourceUri.toString())
    if (!list || list.length === 0) return undefined
    return list[list.length - 1]
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const MarkdownPreviewRegistry = new MarkdownPreviewRegistryImpl()
