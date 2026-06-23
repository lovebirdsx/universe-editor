/**
 * Persistence via the host storage service (`context.workspaceState`), NOT a
 * json file in the workspace. The whole ten-slot snapshot is stored under one
 * key as workspace-scoped state, so bookmarks survive restarts and travel with
 * the workspace without polluting the project tree. Paths are stored as absolute
 * document keys (see {@link uriToKey}).
 */

import type { Memento } from '@universe-editor/extension-api'
import type { BookmarkStore, Slots } from './bookmarks.js'

const KEY = 'numberedBookmarks.slots'

export function load(state: Memento, store: BookmarkStore): void {
  const data = state.get<Slots>(KEY)
  if (data === undefined) return
  store.load(data)
  console.error(`[numbered-bookmarks] loaded ${store.all().length} bookmark(s) from workspaceState`)
}

export async function save(state: Memento, store: BookmarkStore): Promise<void> {
  await state.update(KEY, store.serialize())
}
