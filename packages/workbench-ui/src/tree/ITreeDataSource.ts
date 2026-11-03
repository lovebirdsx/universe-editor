/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ITreeDataSource — pluggable data access for the generic TreeModel.
 *
 *  The model never assumes nodes are files or URIs: identity, children and the
 *  optional parent link all come through this interface. `getChildren` is the
 *  single source of truth for child elements — the model caches expansion /
 *  selection state but never the children themselves.
 *--------------------------------------------------------------------------------------------*/

export interface ITreeDataSource<T> {
  /**
   * Stable string identity for an element (used as map key / selection key and
   * as the row's React key). Must be unique among ALL rows visible in the same
   * tree: the same entity rendered under two parents needs a parent-scoped id —
   * duplicate ids make React orphan one copy's DOM row when it is removed.
   */
  getId(element: T): string

  /** Whether the element can have children (drives the twistie). */
  hasChildren(element: T): boolean

  /**
   * Direct children of `element`. Return `null` to signal "not loaded yet" — the
   * model will await `loadChildren` (if provided) on expand and read again.
   * Eager sources return an array (possibly empty) and never `null`.
   */
  getChildren(element: T): readonly T[] | null

  /** Lazy sources only: populate children so a subsequent `getChildren` is non-null. */
  loadChildren?(element: T): Promise<void>

  /**
   * 可选：子项拉取后代表 `element` 的那一行。会把单目录链折成一行的懒加载源
   * （compact 文件夹）返回链尾，让展开态/选择/焦点/Shift 锚点在同一个事务里
   * 迁到真正渲染的行上；不压缩的源省略即可。
   */
  resolveExpandedElement?(element: T): T

  /** Top-level elements (the virtual root's direct children). */
  getRoots(): readonly T[]

  /** Optional parent link — enables ArrowLeft "go to parent" and reveal's ancestor walk. */
  getParent?(element: T): T | null
}
