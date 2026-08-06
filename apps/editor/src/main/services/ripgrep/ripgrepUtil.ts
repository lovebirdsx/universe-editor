/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared ripgrep helpers for the main-process search services (text search and
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
