/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared ripgrep helpers for the node search services (text search and
 *  file-name search). Keep this module dependency-light: path/glob/thread policy
 *  only, no spawning.
 *--------------------------------------------------------------------------------------------*/

import os from 'node:os'
import { rgPath } from '@vscode/ripgrep'

export function resolveRipgrepDiskPath(ripgrepPath: string = rgPath): string {
  return ripgrepPath.replace(/\.asar([\\/])/g, '.asar.unpacked$1')
}

// Explicit `search.threads` wins; otherwise leave headroom for the app itself
// instead of letting ripgrep saturate every core.
export function resolveSearchThreads(requested: number | undefined): number {
  if (requested !== undefined && requested >= 1) return Math.floor(requested)
  return Math.max(1, os.cpus().length - 2)
}

export const rgDiskPath = resolveRipgrepDiskPath()

export function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeGlob(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

export function expandExcludeGlob(value: string): string[] {
  const normalized = normalizeGlob(value)
  if (!normalized) return []
  if (normalized.endsWith('/**')) return [normalized]
  return [normalized, `${normalized}/**`]
}

// VSCode queryBuilder.expandGlobalGlob: every search-viewlet include segment
// matches at any depth and, if it names a directory, everything beneath it.
function expandGlobalGlob(pattern: string): string[] {
  return [`**/${pattern}/**`, `**/${pattern}`].map((p) => p.replace(/\*\*\/\*\*/g, '**'))
}

// VSCode parseSearchPaths semantics for the "files to include" box:
//   d.地图/110   → **/d.地图/110/** + **/d.地图/110（任意深度的该路径及其内容）
//   ./foo/bar    → foo/bar/** + foo/bar（锚定工作区根，不加 **/ 前缀）
//   .json        → *.json 简写
// 多个 -g 之间是「或」关系，扩展出的变体直接平铺即可。
export function expandIncludeGlob(value: string): string[] {
  let normalized = normalizeGlob(value)
  if (!normalized) return []

  if (normalized.startsWith('./')) {
    const rooted = normalizeGlob(normalized.slice(2))
    if (!rooted) return []
    if (rooted.endsWith('/**')) return [rooted]
    return [`${rooted}/**`, rooted]
  }

  if (normalized.startsWith('.')) normalized = `*${normalized}`
  return expandGlobalGlob(normalized)
}
