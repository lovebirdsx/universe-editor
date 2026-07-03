/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionOutlineRegistry — tracks the live ChatBody backing each open
 *  AcpSessionEditorInput, addressed by session id (the id AcpSessionEditorInput
 *  carries). A full-screen agent session is not a Monaco editor, so OutlineService
 *  can't reach it through FileEditorRegistry; this registry is the equivalent
 *  handle, mirroring MarkdownPreviewRegistry.
 *
 *  A controller lets the Outline view scroll the timeline to a slot key and read
 *  the slot the session currently treats as active — the keyboard-selected item
 *  (Alt+Up/Down/Home/End), falling back to the slot at the top of the viewport.
 *  That way the outline's highlight tracks the same item the session's keyboard
 *  navigation does. The timeline data itself is read straight off the IAcpSession
 *  observable by OutlineService; the controller only bridges the DOM-side
 *  scroll/focus.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type IObservable } from '@universe-editor/platform'
import type { TimelineItem } from './acpSessionModel.js'

export interface IAcpSessionOutlineController {
  /** The session's timeline — OutlineService reads it to build the symbol tree,
   *  so it never has to inject IAcpSessionService (which registers after it). */
  readonly timeline: IObservable<readonly TimelineItem[]>
  /** Select the card with this slot key (as if the user navigated to it) and
   *  scroll it into view — so clicking an outline row moves the session's
   *  selection to match, not just the scroll position. */
  scrollToKey(key: string): void
  /** The slot the session currently treats as active: the keyboard-selected item,
   *  or the slot at the top of the viewport when nothing is selected. */
  getActiveKey(): string | undefined
  /** Move keyboard focus into the chat (so it can be scrolled / navigated). */
  focus(): void
  /** Fires when the active slot may have changed — the user scrolled the timeline
   *  or moved the keyboard selection. */
  readonly onDidChangeActive: Emitter<void>['event']
}

class AcpSessionOutlineRegistryImpl {
  private readonly _map = new Map<string, IAcpSessionOutlineController[]>()
  private readonly _onDidChange = new Emitter<string>()
  readonly onDidChange = this._onDidChange.event

  register(sessionId: string, controller: IAcpSessionOutlineController): void {
    const list = this._map.get(sessionId) ?? []
    list.push(controller)
    this._map.set(sessionId, list)
    this._onDidChange.fire(sessionId)
  }

  unregister(sessionId: string, controller: IAcpSessionOutlineController): void {
    const list = this._map.get(sessionId)
    if (!list) return
    const index = list.indexOf(controller)
    if (index === -1) return
    list.splice(index, 1)
    if (list.length === 0) this._map.delete(sessionId)
    this._onDidChange.fire(sessionId)
  }

  get(sessionId: string): IAcpSessionOutlineController | undefined {
    const list = this._map.get(sessionId)
    if (!list || list.length === 0) return undefined
    return list[list.length - 1]
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpSessionOutlineRegistry = new AcpSessionOutlineRegistryImpl()
