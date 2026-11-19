/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewRegistry — tracks the live preview component backing each open
 *  MarkdownPreviewInput, addressed by source URI. The preview is a plain React
 *  div (no Monaco instance), so the Outline service can't reach it through
 *  FileEditorRegistry; this registry is the equivalent handle. A controller lets
 *  the Outline view scroll the preview to a source line and read the line
 *  currently at the top of the viewport (for active-symbol tracking).
 *
 *  Split views and auxiliary windows can mount two previews for the same source,
 *  so each registration records the group and document that mounted it. `get`
 *  prefers the requested group, then the controller in the active workbench
 *  document, and only then the most recent live one — never letting a preview
 *  remounted in another window redirect a focus request.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type URI } from '@universe-editor/platform'
import { currentWorkbenchDocumentOrUndefined } from '../windows/workbenchDocuments.js'
import { MarkdownPreviewViewStateCache } from './MarkdownPreviewViewStateCache.js'

export interface IMarkdownPreviewRegistrationOptions {
  /** Editor group that mounted this preview (unique across editor windows). */
  readonly groupId?: number | undefined
  /** Document the preview DOM lives in (main window or an auxiliary window). */
  readonly ownerDocument?: Document | undefined
}

export interface IMarkdownPreviewController {
  /** Scroll the preview so the block at `line` (1-based source line) is at the top. */
  scrollToLine(line: number): void
  /** Scroll to a rendered markdown heading fragment (`#hello` or `hello`). */
  scrollToAnchor(anchor: string): void
  /** Source line (1-based) currently at the top of the preview viewport, if measurable. */
  getTopVisibleLine(): number | undefined
  /**
   * Whether the preview is scrolled to (or within a hair of) the very bottom.
   * Lets a toggle-back land the source at its last line even though the preview
   * renders denser than the source (so the top-visible line alone would undershoot
   * the end).
   */
  isScrolledToBottom(): boolean
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

interface MarkdownPreviewRegistration {
  readonly controller: IMarkdownPreviewController
  readonly groupId: number | undefined
  readonly ownerDocument: Document | undefined
}

class MarkdownPreviewRegistryImpl {
  private readonly _map = new Map<string, MarkdownPreviewRegistration[]>()
  private readonly _onDidChange = new Emitter<URI>()
  readonly onDidChange = this._onDidChange.event

  // The preview that currently holds keyboard focus, so find commands (Ctrl+F /
  // F3 / Escape) target the one the user is looking at rather than broadcasting.
  private _activeController: IMarkdownPreviewController | undefined

  register(
    sourceUri: URI,
    controller: IMarkdownPreviewController,
    options?: IMarkdownPreviewRegistrationOptions,
  ): void {
    const key = sourceUri.toString()
    const list = this._map.get(key) ?? []
    list.push({
      controller,
      groupId: options?.groupId,
      ownerDocument: options?.ownerDocument,
    })
    this._map.set(key, list)
    this._onDidChange.fire(sourceUri)
  }

  unregister(sourceUri: URI, controller: IMarkdownPreviewController): void {
    const key = sourceUri.toString()
    const list = this._map.get(key)
    if (!list) return
    const index = list.findIndex((r) => r.controller === controller)
    if (index === -1) return
    list.splice(index, 1)
    if (list.length === 0) this._map.delete(key)
    this._onDidChange.fire(sourceUri)
  }

  /**
   * Resolve the controller for `sourceUri`. An explicit group wins; otherwise
   * (and when that group has not registered yet) prefer the controller in the
   * active workbench document, then fall back to the most recent mount. The
   * active-document step matters on open: the group may focus the input before
   * its preview component has registered, and the focused window is the one the
   * user is looking at.
   */
  get(sourceUri: URI, groupId?: number): IMarkdownPreviewController | undefined {
    const list = this._map.get(sourceUri.toString())
    if (!list || list.length === 0) return undefined
    if (groupId !== undefined) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.groupId === groupId) return list[i]?.controller
      }
    }
    const activeDocument = currentWorkbenchDocumentOrUndefined()
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.ownerDocument === activeDocument) return list[i]?.controller
    }
    return list[list.length - 1]?.controller
  }

  /**
   * Scroll the preview for `sourceUri` to a heading/anchor fragment. A live
   * (mounted) preview scrolls right away; otherwise the anchor is stashed as a
   * one-shot in MarkdownPreviewViewStateCache, where the scroll-restore effect
   * of the next mount applies it *instead of* the saved scrollTop — routing it
   * through the same owner as the reveal-line request keeps the two from
   * fighting over the landing position.
   */
  revealAnchor(sourceUri: URI, anchor: string, groupId?: number): void {
    if (!anchor) return
    const controller = this.get(sourceUri, groupId)
    if (controller) {
      controller.scrollToAnchor(anchor)
      return
    }
    MarkdownPreviewViewStateCache.saveRevealAnchor(sourceUri.toString(), anchor)
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
    this._activeController = undefined
  }
}

export const MarkdownPreviewRegistry = new MarkdownPreviewRegistryImpl()
