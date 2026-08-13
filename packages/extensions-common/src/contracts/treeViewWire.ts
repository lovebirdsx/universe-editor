/**
 * Tree-view wire contract shared by the three processes (mirrors VSCode's
 * MainThreadTreeViews/ExtHostTreeViews, trimmed to the first-cut surface).
 *
 * The extension host owns the `TreeDataProvider`s (registered via
 * `window.registerTreeDataProvider` / `window.createTreeView`); it announces a
 * provider over `mainThreadTreeViews`, and the renderer pulls children back
 * over `extHostTreeViews` — lazily, only for nodes the user actually expands.
 *
 * Elements are keyed by host-allocated numeric handles, valid for the lifetime
 * of one renderer-side tree model generation: a `$refresh` (fired on
 * `onDidChangeTreeData`) invalidates the whole generation and the renderer
 * re-pulls from the roots, so handles never need to survive a refresh.
 */

import type { UriComponents } from '@universe-editor/platform'
import type { ICommandDto } from './scmWire.js'

export interface ITreeItemDto {
  /** Host-allocated element handle (see file header). */
  handle: number
  label: string
  /** 0 = None, 1 = Collapsed, 2 = Expanded (extension-api TreeItemCollapsibleState). */
  collapsibleState: 0 | 1 | 2
  description?: string
  tooltip?: string
  contextValue?: string
  /** Codicon id (e.g. `git-commit`). */
  iconId?: string
  resourceUri?: UriComponents
  /**
   * Command executed when the row is clicked. Only its display surface rides
   * the wire (id + title + tooltip + disabled) — execution resolves back to
   * the provider's original `TreeItem.command` on the host through
   * `$executeTreeItemCommand`, so `arguments` are deliberately NOT serialized
   * here (live objects like Uri must never flatten to JSON).
   */
  command?: ICommandDto
}

/**
 * Renderer ← host: provider registrations and invalidations. The host's
 * ChannelClient calls these on the renderer's ChannelServer.
 */
export interface IMainThreadTreeViews {
  $registerTreeDataProvider(viewId: string): Promise<void>
  $unregisterTreeDataProvider(viewId: string): Promise<void>
  /**
   * The provider's data changed. `parentHandles` narrows the invalidation to a
   * subtree; `undefined` invalidates the whole view (the only mode the first
   * cut produces — the host clears its handle table and the renderer re-pulls
   * every expanded node from the roots).
   */
  $refresh(viewId: string, parentHandles?: number[]): Promise<void>
}

/**
 * Host ← renderer: data pulls and interaction callbacks from the tree view.
 * The renderer's ChannelClient calls these on the host's ChannelServer.
 */
export interface IExtHostTreeViews {
  /** Children of `parentHandle`, or the roots when omitted. */
  $getChildren(viewId: string, parentHandle?: number): Promise<ITreeItemDto[]>
  $acceptTreeViewVisibility(viewId: string, visible: boolean): Promise<void>
  $acceptSelection(viewId: string, handles: number[]): Promise<void>
  $acceptExpansionState(viewId: string, handle: number, expanded: boolean): Promise<void>
  /**
   * Run a command in the host so the extension handler receives the original
   * values instead of wire-flattened copies. Two entry points share this call:
   *
   * - `commandId` present (a `view/item/context` menu pick): run it with the
   *   tree element as single argument — the vscode contract.
   * - `commandId` omitted (row click): run the element's `TreeItem.command`;
   *   when that command declares no `arguments`, the element is passed
   *   instead. Keeps live objects (Uri instances, custom payloads) intact by
   *   never serializing them onto the wire.
   *
   * The caller omits the optional argument entirely when clicking: the wire
   * turns `undefined` into `null`, so the host treats `null`/`undefined`
   * alike. A stale handle (from before a `$refresh`) is a silent no-op.
   */
  $executeTreeItemCommand(viewId: string, handle: number, commandId?: string): Promise<void>
}
