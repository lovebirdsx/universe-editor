/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Guards zh-CN coverage of every `localize` / `localize2` call in the product
 * source. A missing key is invisible at runtime — `localize` silently falls back
 * to the English default and nothing else checks for it — so new commands and
 * menus can ship untranslated without a single failure.
 *
 * Four things are asserted, roughly in decreasing order of how easily they break:
 *  1. every product package that calls `localize` is actually being scanned —
 *     otherwise the next package to start localizing slips through unnoticed;
 *  2. every literal key has a zh-CN entry;
 *  3. no translation invents a `{placeholder}` the call site does not supply:
 *     `localize` leaves unknown placeholders untouched, so a stray `{count}`
 *     renders verbatim in the UI;
 *  4. the dynamically-built key families (`color.<id>`, `action.agent.toggle-
 *     Bookmark<N>` / `jumpToBookmark<N>`) are covered entry by entry — asserting
 *     "something exists under the prefix" would not notice one missing colour.
 *
 * Extensions are deliberately out of scope: `extensions/*` localize through their
 * own `package.nls.<locale>.json` / `src/nls.ts`, never through this message table.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EDITOR_OPTIONS_ZH_CN_MESSAGES } from '../messages/editorOptions.zh-CN.generated.js'
import { ZH_CN_MESSAGES } from '../messages/zh-CN.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))

/** Product source roots that call `localize`. Kept in sync by the
 *  "every localizing package is scanned" case below — that case fails when a new
 *  package starts localizing, so this list can only go stale loudly. */
const SCAN_ROOTS = [
  'apps/editor/src',
  'packages/node-services/src',
  'packages/platform/src',
  'packages/workbench-ui/src',
]

const WORKSPACE_PARENTS = ['apps', 'packages']

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'out'])

const COLOR_DEFS_SRC = 'apps/editor/src/renderer/services/themes/universeColorIds.ts'
const SLOT_COUNT_SRC = 'apps/editor/src/renderer/services/acp/session/sessionBookmarks.ts'
const SLOT_KEY_FAMILIES = ['action.agent.toggleBookmark', 'action.agent.jumpToBookmark']

function toRepoRelative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(full, acc)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.|\.spec\./.test(entry.name)) continue
    acc.push(full)
  }
  return acc
}

/** `localize('key', ...)` / `localize2("key", ...)` with a literal, non-concatenated key.
 *  Template literals are excluded when they interpolate (`$`) — those are prefixes. */
const STATIC_KEY_RE =
  /localize2?\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`$\\\n]|\\.)*)`)\s*,\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`$\\\n]|\\.)*)`)?/g

/** Literal key glued to a runtime value: `localize('prefix' + slot, ...)`. */
const CONCAT_KEY_RE = /localize2?\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*\+/g

/** Template key with an interpolation: ``localize(`prefix.${id}`, ...)``. */
const TEMPLATE_KEY_RE = /localize2?\(\s*`([^`$\n]*)\$\{/g

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g

function placeholdersOf(message: string): Set<string> {
  return new Set([...message.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!))
}

interface ScanResult {
  /** Literal key -> English default message, as written at the call site. */
  readonly keys: ReadonlyMap<string, string>
  readonly prefixes: ReadonlySet<string>
  /** Call sites found per scan root, for the "did a root stop being scanned" case. */
  readonly callSitesPerRoot: ReadonlyMap<string, number>
}

function scanCallSites(): ScanResult {
  const keys = new Map<string, string>()
  const prefixes = new Set<string>()
  const callSitesPerRoot = new Map<string, number>()

  for (const root of SCAN_ROOTS) {
    let callSites = 0
    for (const file of collectSourceFiles(path.join(REPO_ROOT, root))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(STATIC_KEY_RE)) {
        const key = m[1] ?? m[2] ?? m[3]
        if (!key) continue
        callSites++
        const english = m[4] ?? m[5] ?? m[6]
        if (english !== undefined && !keys.has(key)) keys.set(key, english)
        else if (!keys.has(key)) keys.set(key, '')
      }
      for (const m of text.matchAll(CONCAT_KEY_RE)) {
        const prefix = m[1] ?? m[2]
        if (prefix) prefixes.add(prefix)
      }
      for (const m of text.matchAll(TEMPLATE_KEY_RE)) {
        const prefix = m[1]
        if (prefix) prefixes.add(prefix)
      }
    }
    callSitesPerRoot.set(root, callSites)
  }

  return { keys, prefixes, callSitesPerRoot }
}

/** Source trees of every workspace package (one level below `apps/` or `packages/`)
 *  that contain at least one `localize` call. */
function discoverLocalizingRoots(): string[] {
  const roots: string[] = []
  for (const parent of WORKSPACE_PARENTS) {
    let entries
    try {
      entries = readdirSync(path.join(REPO_ROOT, parent), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const src = path.join(REPO_ROOT, parent, entry.name, 'src')
      if (!existsSync(src)) continue
      const localizes = collectSourceFiles(src).some((file) =>
        /localize2?\(/.test(readFileSync(file, 'utf8')),
      )
      if (localizes) roots.push(toRepoRelative(src))
    }
  }
  return roots.sort()
}

/** Ids passed as the first argument of `d(...)` in the colour registry — these are
 *  exactly the values interpolated into ``localize(`color.${id}`, …)``. */
function colorKeysFromSource(): string[] {
  const text = readFileSync(path.join(REPO_ROOT, COLOR_DEFS_SRC), 'utf8')
  return [...text.matchAll(/\bd\(\s*'([^']+)'/g)].map((m) => `color.${m[1]}`)
}

function slotKeysFromSource(): string[] {
  const text = readFileSync(path.join(REPO_ROOT, SLOT_COUNT_SRC), 'utf8')
  const count = Number(/\bSLOT_COUNT\s*=\s*(\d+)/.exec(text)?.[1] ?? Number.NaN)
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`cannot read SLOT_COUNT from ${SLOT_COUNT_SRC}`)
  }
  return SLOT_KEY_FAMILIES.flatMap((family) =>
    Array.from({ length: count }, (_, slot) => `${family}${slot}`),
  )
}

const ZH_CN_VALUES: ReadonlyMap<string, string> = new Map([
  ...Object.entries(ZH_CN_MESSAGES),
  ...Object.entries(EDITOR_OPTIONS_ZH_CN_MESSAGES),
])

describe('zh-CN localize coverage', () => {
  const { keys, prefixes, callSitesPerRoot } = scanCallSites()

  it('scans every product package that calls localize', () => {
    const discovered = discoverLocalizingRoots()
    expect(discovered.length).toBeGreaterThan(0)
    const unscanned = discovered.filter((root) => !SCAN_ROOTS.includes(root))
    expect(
      unscanned,
      `packages calling localize but not listed in SCAN_ROOTS:\n${unscanned.join('\n')}`,
    ).toEqual([])
  })

  it('resolves call sites in every scan root', () => {
    // Per-root rather than a global floor: a single root silently dropping out of
    // the scan (renamed import, wrapper helper) must fail on its own.
    const empty = SCAN_ROOTS.filter((root) => (callSitesPerRoot.get(root) ?? 0) === 0)
    expect(empty, `scan roots with no localize call sites:\n${empty.join('\n')}`).toEqual([])
    expect([...callSitesPerRoot.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(2000)
  })

  it('has a zh-CN entry for every literal localize key', () => {
    const missing = [...keys.keys()].filter((key) => !ZH_CN_VALUES.has(key)).sort()
    expect(missing, `untranslated keys:\n${missing.join('\n')}`).toEqual([])
  })

  it('never translates in a placeholder the call site does not supply', () => {
    // `zh` may drop a placeholder the English default carries, but a placeholder
    // that exists only in `zh` has nothing to substitute and shows up verbatim.
    const offenders: string[] = []
    for (const [key, english] of keys) {
      const zh = ZH_CN_VALUES.get(key)
      if (zh === undefined || english === '') continue
      const supplied = placeholdersOf(english)
      const stray = [...placeholdersOf(zh)].filter((name) => !supplied.has(name))
      if (stray.length > 0) offenders.push(`${key}: ${stray.map((s) => `{${s}}`).join(' ')}`)
    }
    expect(offenders, `placeholders with no call-site value:\n${offenders.join('\n')}`).toEqual([])
  })

  it('covers every dynamically built key', () => {
    const colors = colorKeysFromSource()
    expect(colors.length).toBeGreaterThan(0)
    const missing = [...colors, ...slotKeysFromSource()]
      .filter((key) => !ZH_CN_VALUES.has(key))
      .sort()
    expect(missing, `untranslated dynamic keys:\n${missing.join('\n')}`).toEqual([])
  })

  it('has zh-CN entries under every dynamic key prefix', () => {
    // Backstop for dynamic families this test does not yet enumerate: a fully
    // removed prefix still fails.
    const all = [...ZH_CN_VALUES.keys()]
    const empty = [...prefixes]
      .filter((prefix) => !all.some((key) => key.startsWith(prefix)))
      .sort()
    expect(empty, `dynamic key prefixes with no zh-CN entry:\n${empty.join('\n')}`).toEqual([])
  })
})
