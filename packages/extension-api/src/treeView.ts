/**
 * Tree views — data providers backing the views an extension declares via
 * `contributes.views` / `contributes.viewsContainers` (the Universe equivalent
 * of VSCode's `window.registerTreeDataProvider` / `window.createTreeView`).
 *
 * The view itself is owned by the workbench; the extension only supplies data
 * through a {@link TreeDataProvider}. Children are pulled lazily — only when
 * the user expands a node — and a provider's `onDidChangeTreeData` invalidates
 * either the whole view (fired with no element) or just that element's subtree.
 * Rows keep their identity across a refresh, so the user's expansion and
 * selection survive one.
 *
 * First-cut differences from VSCode: no drag & drop, no checkboxes, no badges,
 * no `TreeView.reveal` (`getParent` is accepted but not consumed), no
 * `TreeView.title`/`description`/`message`, and `TreeItem.iconPath` is a plain
 * codicon id (no file-path or `{ light, dark }` theme icons).
 */
import type { Disposable, Event, ProviderResult } from './index.js'
import type { Command } from './scm.js'
import type { Uri } from './uri.js'

/** Whether a tree node renders a twistie, and its initial expansion. */
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

/**
 * Rich label form (highlights are not supported in the first cut — only the
 * plain text is rendered).
 */
export interface TreeItemLabel {
  label: string
}

/** One row of a tree view. */
export class TreeItem {
  /** Row text; a {@link TreeItemLabel} is normalized to its plain text. */
  label: string | TreeItemLabel
  collapsibleState?: TreeItemCollapsibleState
  /**
   * Provider-local stable id. Rows keep their identity across a refresh even
   * without one (the host falls back to the element object, then to the label
   * under the parent), but a provider that rebuilds its elements *and* changes
   * their labels needs this to keep the expansion state.
   */
  id?: string
  /** Secondary text rendered after the label. */
  description?: string
  tooltip?: string
  /**
   * Run when the row is clicked. The handler receives `command.arguments`
   * unchanged — live objects are fine (Uri, custom payloads): they never
   * leave the extension host process.
   */
  command?: Command
  /** Surfaced to `view/item/context` menu `when` clauses as `viewItem`. */
  contextValue?: string
  /** Codicon id rendered before the label (e.g. `git-commit`). */
  iconPath?: string
  resourceUri?: Uri

  constructor(label: string | TreeItemLabel, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label
    if (collapsibleState !== undefined) this.collapsibleState = collapsibleState
  }
}

/**
 * Data source for a tree view (mirrors VSCode's `TreeDataProvider`). `T` is
 * the extension's own element type; elements never cross the wire — the host
 * keys them by numeric handles.
 */
export interface TreeDataProvider<T> {
  /**
   * Fire when the tree's data changes. With no element (or `undefined` /
   * `null`) the whole view is re-pulled; with an element (or an array of them)
   * only that element's row is refreshed and its children re-pulled — sibling
   * and unrelated branches keep their cache, and expansion state is preserved
   * either way. A burst of fires inside one short window is merged into a
   * single refresh.
   */
  readonly onDidChangeTreeData?: Event<T | T[] | undefined | null | void>
  getTreeItem(element: T): TreeItem | Promise<TreeItem>
  /** Children of `element`, or the roots when omitted. */
  getChildren(element?: T): ProviderResult<T[]>
  /**
   * Accepted for VSCode signature parity but NOT consumed yet — `TreeView.reveal`
   * is unimplemented, so no ancestor walk is ever performed.
   */
  getParent?(element: T): ProviderResult<T | undefined>
}

export interface TreeViewVisibilityChangeEvent {
  readonly visible: boolean
}

export interface TreeViewSelectionChangeEvent<T> {
  readonly selection: readonly T[]
}

export interface TreeViewExpansionChangeEvent<T> {
  readonly element: T
}

/**
 * A handle on a contributed tree view, returned by `window.createTreeView`.
 * State (visibility / selection / expansion) is fed back by the workbench as
 * the user interacts with the view.
 */
export interface TreeView<T> extends Disposable {
  readonly visible: boolean
  readonly selection: readonly T[]
  readonly onDidChangeVisibility: Event<TreeViewVisibilityChangeEvent>
  readonly onDidChangeSelection: Event<TreeViewSelectionChangeEvent<T>>
  readonly onDidExpandElement: Event<TreeViewExpansionChangeEvent<T>>
  readonly onDidCollapseElement: Event<TreeViewExpansionChangeEvent<T>>
}

export interface TreeViewOptions<T> {
  treeDataProvider: TreeDataProvider<T>
}
