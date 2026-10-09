/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  explorerEntries — Explorer 行模型与单目录扫描：过滤 → 构造 URI → 排序。
 *
 *  从 ExplorerTreeService 拆出，让这条热路径能脱离树单测。
 *--------------------------------------------------------------------------------------------*/

import { URI, type IDirectoryEntry } from '@universe-editor/platform'
import { yieldToMain } from '../scheduling/yieldToMain.js'

export interface IExplorerEntry {
  readonly resource: URI
  readonly name: string
  readonly isDirectory: boolean
  readonly isSymbolicLink?: boolean
  readonly compactName?: string
  /** The topmost directory in the compact chain — used as drag source. */
  readonly compactRoot?: URI
}

/** 原始条数超过此值时线性段按 macrotask 分片，避免巨大目录长时间占住主线程；小目录不分片。 */
export const ENTRY_CHUNK_SIZE = 5000

/** 全 renderer 复用同一 collator：逐次 localeCompare 会为每次比较重建 Intl.Collator。 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** `parentRel` 目录下某直接子项的 workspace 相对路径（'' 代表 workspace 根）。 */
export function childRelativePath(parentRel: string, name: string): string {
  return parentRel === '' ? name : `${parentRel}/${name}`
}

/**
 * 单目录的过滤 + URI 构造，保持 listing 顺序。isVisible 跑在 joinPath 之前（被排除项不进排序）；
 * 相对路径由父相对路径 + 名字拼出，与 relativeTo(root, parent/name) 等价。
 */
export function selectDirectoryEntries(
  entries: readonly IDirectoryEntry[],
  parent: URI,
  parentRel: string,
  isVisible?: (relPath: string, isDirectory: boolean) => boolean,
): IExplorerEntry[] {
  const kept: IExplorerEntry[] = []
  for (const entry of entries) {
    if (isVisible && !isVisible(childRelativePath(parentRel, entry.name), entry.isDirectory)) {
      continue
    }
    kept.push({
      resource: URI.joinPath(parent, entry.name),
      name: entry.name,
      isDirectory: entry.isDirectory,
      ...(entry.isSymbolicLink ? { isSymbolicLink: true } : {}),
    })
  }
  return kept
}

/** 目录优先，再按自然 / 忽略大小写名序；sort 稳定，collator 分不开的大小写差异保持原序。 */
export function sortDirectoryEntries(entries: readonly IExplorerEntry[]): IExplorerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

/**
 * 单目录完整扫描：过滤、构造、排序；巨大目录才分片。
 * `onSort` 回传单次同步排序的真实起止，避免用含 yield 等待的墙钟推算。
 */
export async function processDirectoryEntries(
  entries: readonly IDirectoryEntry[],
  parent: URI,
  parentRel: string,
  isVisible?: (relPath: string, isDirectory: boolean) => boolean,
  onSort?: (durationMs: number, startTime: number) => void,
): Promise<IExplorerEntry[]> {
  let kept: IExplorerEntry[]
  if (entries.length <= ENTRY_CHUNK_SIZE) {
    kept = selectDirectoryEntries(entries, parent, parentRel, isVisible)
  } else {
    // 只有线性段分片；分片结果按 listing 顺序拼接，尾部单次排序与一次性扫描完全一致。
    kept = []
    for (let i = 0; i < entries.length; i += ENTRY_CHUNK_SIZE) {
      kept.push(
        ...selectDirectoryEntries(
          entries.slice(i, i + ENTRY_CHUNK_SIZE),
          parent,
          parentRel,
          isVisible,
        ),
      )
      if (i + ENTRY_CHUNK_SIZE < entries.length) await yieldToMain()
    }
  }
  const sortStart = performance.now()
  const sorted = sortDirectoryEntries(kept)
  onSort?.(performance.now() - sortStart, sortStart)
  return sorted
}
