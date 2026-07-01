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
  /** Scroll to a rendered markdown heading fragment (`#hello` or `hello`). */
  scrollToAnchor(anchor: string): void
  /** Source line (1-based) currently at the top of the preview viewport, if measurable. */
  getTopVisibleLine(): number | undefined
  /** Move keyboard focus to the preview container (so it can be scrolled/navigated). */
  focus(): void
  /** Fires (debounced by the component) when the user scrolls the preview. */
  readonly onDidScroll: Emitter<void>['event']
  /** Open the in-preview find widget (focuses its input). */
  openFind(): void
  /** Close the in-preview find widget and clear highlights. */
  closeFind(): void
  /** Move to the next find match. */
  findNext(): void
  /** Move to the previous find match. */
  findPrev(): void
  /**
   * Show vimium-style link hints over every visible link. `inNewTab` follows the
   * chosen link to the side (mirrors Ctrl/Cmd+click); otherwise opens in place.
   */
  showLinkHints(inNewTab: boolean): void
  /** Dismiss link hints without following any link. */
  hideLinkHints(): void
  /** Toggle the keyboard-shortcut help overlay. */
  toggleHelp(): void
}

class MarkdownPreviewRegistryImpl {
  private readonly _map = new Map<string, IMarkdownPreviewController[]>()
  private readonly _pendingAnchors = new Map<string, string>()
  private readonly _onDidChange = new Emitter<URI>()
  readonly onDidChange = this._onDidChange.event

  // The preview that currently holds keyboard focus, so find commands (Ctrl+F /
  // F3 / Escape) target the one the user is looking at rather than broadcasting.
  private _activeController: IMarkdownPreviewController | undefined

  register(sourceUri: URI, controller: IMarkdownPreviewController): void {
    const key = sourceUri.toString()
    const list = this._map.get(key) ?? []
    list.push(controller)
    this._map.set(key, list)
    this._onDidChange.fire(sourceUri)
    const pendingAnchor = this._pendingAnchors.get(key)
    if (pendingAnchor !== undefined) {
      this._pendingAnchors.delete(key)
      controller.scrollToAnchor(pendingAnchor)
    }
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

  revealAnchor(sourceUri: URI, anchor: string): void {
    if (!anchor) return
    const controller = this.get(sourceUri)
    if (controller) {
      controller.scrollToAnchor(anchor)
      return
    }
    this._pendingAnchors.set(sourceUri.toString(), anchor)
  }

  setActive(controller: IMarkdownPreviewController): void {
    this._activeController = controller
  }

  clearActive(controller: IMarkdownPreviewController): void {
    if (this._activeController === controller) this._activeController = undefined
  }

  getActive(): IMarkdownPreviewController | undefined {
    return this._activeController
  }

  _resetForTests(): void {
    this._map.clear()
    this._pendingAnchors.clear()
    this._activeController = undefined
  }
}

export const MarkdownPreviewRegistry = new MarkdownPreviewRegistryImpl()
