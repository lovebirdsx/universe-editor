/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session bookmark commands: Delphi-style numbered bookmarks (0-9) for the ACP
 *  session editor timeline — the session-editor counterpart of the numbered-bookmarks
 *  extension. Toggle pins the currently active timeline slot to a numbered slot;
 *  jump reveals it (opening the session tab first if needed). All gate on
 *  ACP_NAV_WHEN so the digit keybindings only bind while a session editor is
 *  focused, leaving the global Ctrl+0 (Reset Zoom) untouched elsewhere.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IQuickInputService,
  KeybindingWeight,
  localize,
  localize2,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  ISessionBookmarkService,
  type SessionBookmarkListItem,
} from '../services/acp/sessionBookmarkService.js'
import { SLOT_COUNT } from '../services/acp/sessionBookmarks.js'
import { CATEGORY, ACP_NAV_WHEN } from './_agentShared.js'

const DIGITS = Array.from({ length: SLOT_COUNT }, (_, n) => n)

// Outrank the numbered-bookmarks extension's ctrl+<digit> bindings (weight
// ExternalExtension). Both are gated by when-clauses that never overlap
// (ACP_NAV_WHEN vs editorTextFocus), but resolve() walks bindings highest-weight
// first — so without this the extension's binding is always evaluated before
// ours, and we only win because its `editorTextFocus` happens to be false in a
// session. Registering one tier higher makes the session binding authoritative
// whenever ACP_NAV_WHEN holds, independent of the extension's when result.
const BOOKMARK_KEY_WEIGHT = KeybindingWeight.ExternalExtension + 1

/** One no-arg Action2 subclass per digit: toggles session bookmark `slot`. The
 *  slot is captured in the closure (not a class field) so the generated class has
 *  no private members leaking into its exported type. */
function makeToggleAction(slot: number): new () => Action2 {
  return class extends Action2 {
    constructor() {
      super({
        id: `workbench.action.agent.toggleBookmark${slot}`,
        title: localize2('action.agent.toggleBookmark' + slot, `Toggle Session Bookmark ${slot}`),
        category: CATEGORY,
        keybinding: {
          primary: `ctrl+shift+${slot}`,
          when: ACP_NAV_WHEN,
          weight: BOOKMARK_KEY_WEIGHT,
        },
        f1: true,
      })
    }
    override run(accessor: ServicesAccessor): void {
      accessor.get(ISessionBookmarkService).toggle(slot)
    }
  }
}

/** One no-arg Action2 subclass per digit: reveals session bookmark `slot`. */
function makeJumpAction(slot: number): new () => Action2 {
  return class extends Action2 {
    constructor() {
      super({
        id: `workbench.action.agent.jumpToBookmark${slot}`,
        title: localize2('action.agent.jumpToBookmark' + slot, `Jump to Session Bookmark ${slot}`),
        category: CATEGORY,
        keybinding: { primary: `ctrl+${slot}`, when: ACP_NAV_WHEN, weight: BOOKMARK_KEY_WEIGHT },
        f1: true,
      })
    }
    override run(accessor: ServicesAccessor): void {
      accessor.get(ISessionBookmarkService).jump(slot)
    }
  }
}

export class ListSessionBookmarksAction extends Action2 {
  static readonly ID = 'workbench.action.agent.listBookmarks'
  constructor() {
    super({
      id: ListSessionBookmarksAction.ID,
      title: localize2('action.agent.listBookmarks', 'List Session Bookmarks'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Snapshot every service before the first await: a ServicesAccessor is
    // invalidated the moment control yields.
    const bookmarks = accessor.get(ISessionBookmarkService)
    const quickInput = accessor.get(IQuickInputService)

    const all = bookmarks.list()
    if (all.length === 0) {
      return
    }
    const items: (IQuickPickItem & { readonly entry: SessionBookmarkListItem })[] = all.map(
      (entry) => ({
        id: String(entry.slot),
        label: `${entry.slot} - ${entry.preview ?? localize('agent.bookmark.gone', '(unavailable)')}`,
        entry,
      }),
    )
    const picked = await quickInput.pick(items, {
      placeholder: localize('agent.listBookmarks.placeholder', 'Jump to a session bookmark'),
    })
    if (!picked) return
    bookmarks.jump(picked.entry.slot)
  }
}

export class ClearSessionBookmarksAction extends Action2 {
  static readonly ID = 'workbench.action.agent.clearBookmarks'
  constructor() {
    super({
      id: ClearSessionBookmarksAction.ID,
      title: localize2('action.agent.clearBookmarks', 'Clear All Session Bookmarks'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(ISessionBookmarkService).clearActiveSession()
  }
}

/** Concrete per-digit action classes, built once so index.ts can register them. */
export const ToggleSessionBookmarkActions = DIGITS.map(makeToggleAction)

export const JumpToSessionBookmarkActions = DIGITS.map(makeJumpAction)
