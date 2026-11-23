/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  `vim.keymap` handling, kept pure so the rules are unit-testable: parse and
 *  validate the user's JSON, then merge it over the built-in tables for one
 *  surface kind.
 *
 *  Three forms of entry:
 *  - new entry: `{ id?, keys, command, args?, when?, surfaces? }`
 *  - override of an existing `id`: any subset of the fields; the rest is
 *    inherited from the built-in entry (a bare `{ "id": "list.focusDown",
 *    "keys": ["n"] }` keeps its `surfaces` / `when`)
 *  - unbind, written like a keybindings.json `-command` entry: the `command`
 *    starts with `-`, and either `id` or `keys` says what to remove:
 *      `{ "id": "list.delete", "command": "-" }`
 *      `{ "keys": ["d", "d"], "command": "-list.delete" }`  (`-` alone = any command)
 *
 *  A new entry without `surfaces` applies to every non-editor surface, plus the
 *  editor when it starts with `<leader>` (the only keys the editor routes here).
 *--------------------------------------------------------------------------------------------*/

import {
  VIM_SURFACE_KINDS,
  describeInvalidVimToken,
  type IVimKeymapEntry,
  type VimSurfaceKind,
} from '@universe-editor/workbench-ui'

export const LEADER_TOKEN = '<leader>'

export interface IVimUserKeymapItem {
  /** Present for every non-unbind item; anonymous entries get `user.<index>`. */
  readonly id?: string
  readonly keys?: readonly string[]
  /** For an unbind: the command to remove, `''` meaning any. */
  readonly command?: string
  readonly unbind: boolean
  readonly args?: unknown
  readonly when?: string
  readonly surfaces?: readonly VimSurfaceKind[]
}

export interface IParsedUserKeymap {
  readonly items: readonly IVimUserKeymapItem[]
  /** Human-readable problems; the offending entries were dropped or trimmed. */
  readonly issues: readonly string[]
}

const SURFACE_KIND_SET: ReadonlySet<string> = new Set(VIM_SURFACE_KINDS)

export function replaceLeader(keys: readonly string[], leader: string): readonly string[] {
  return keys.map((key) => (key === LEADER_TOKEN ? leader : key))
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

function describe(index: number, id: string | undefined): string {
  return id === undefined ? `vim.keymap[${index}]` : `vim.keymap[${index}] (${id})`
}

function parseKeys(raw: unknown, label: string, issues: string[]): readonly string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${label}: "keys" must be a non-empty array of Vim tokens`)
    return null
  }
  for (const token of raw) {
    if (typeof token !== 'string' || token.length === 0) {
      issues.push(`${label}: key tokens must be non-empty strings`)
      return null
    }
    const problem = describeInvalidVimToken(token)
    if (problem !== undefined) {
      issues.push(`${label}: invalid key token '${token}' — ${problem}`)
      return null
    }
  }
  return raw as string[]
}

function parseSurfaces(
  raw: unknown,
  label: string,
  issues: string[],
): readonly VimSurfaceKind[] | null {
  if (!Array.isArray(raw)) {
    issues.push(`${label}: "surfaces" must be an array of surface kinds`)
    return null
  }
  const kinds: VimSurfaceKind[] = []
  for (const kind of raw) {
    if (typeof kind === 'string' && SURFACE_KIND_SET.has(kind)) {
      kinds.push(kind as VimSurfaceKind)
    } else {
      issues.push(
        `${label}: unknown surface ${JSON.stringify(kind)} (expected one of ${VIM_SURFACE_KINDS.join(', ')})`,
      )
    }
  }
  // Dropping every kind would silently widen the entry to all surfaces.
  return kinds.length > 0 ? kinds : null
}

/**
 * `known` is the built-in catalog (default + app + surface-declared entries) so
 * the parser can tell an override of a real id from a typo, and flag an unbind
 * that can never match.
 */
export function parseUserKeymap(
  value: unknown,
  known: readonly IVimKeymapEntry[],
  leader: string,
): IParsedUserKeymap {
  const issues: string[] = []
  if (value === undefined || value === null) return { items: [], issues }
  if (!Array.isArray(value)) {
    issues.push('vim.keymap must be an array of mappings')
    return { items: [], issues }
  }
  const knownIds = new Set(known.map((entry) => entry.id))
  const items: IVimUserKeymapItem[] = []
  value.forEach((raw: unknown, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push(`${describe(index, undefined)}: expected an object`)
      return
    }
    const source = raw as Record<string, unknown>
    const rawId = source['id']
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined
    const label = describe(index, id)
    if (rawId !== undefined && id === undefined) {
      issues.push(`${label}: "id" must be a non-empty string`)
    }

    const rawCommand = source['command']
    if (rawCommand !== undefined && typeof rawCommand !== 'string') {
      issues.push(`${label}: "command" must be a string`)
      return
    }
    const unbind = typeof rawCommand === 'string' && rawCommand.startsWith('-')

    let keys: readonly string[] | undefined
    if (source['keys'] !== undefined) {
      const parsed = parseKeys(source['keys'], label, issues)
      if (parsed === null) return
      keys = parsed
    }

    let surfaces: readonly VimSurfaceKind[] | undefined
    if (source['surfaces'] !== undefined) {
      const parsed = parseSurfaces(source['surfaces'], label, issues)
      if (parsed === null) return
      surfaces = parsed
    }

    let when: string | undefined
    if (source['when'] !== undefined) {
      if (typeof source['when'] === 'string') {
        when = source['when']
      } else {
        issues.push(`${label}: "when" must be a string (ignored)`)
      }
    }

    if (unbind) {
      if (id === undefined && keys === undefined) {
        issues.push(`${label}: an unbind ("command": "-…") needs an "id" or "keys"`)
        return
      }
      items.push({
        unbind: true,
        command: (rawCommand as string).slice(1),
        ...(id !== undefined ? { id } : {}),
        ...(keys !== undefined ? { keys } : {}),
        ...(surfaces !== undefined ? { surfaces } : {}),
      })
      return
    }

    const resolvedId = id ?? `user.${index}`
    const overridesKnown = knownIds.has(resolvedId)
    if (!overridesKnown && (keys === undefined || rawCommand === undefined)) {
      issues.push(
        `${label}: not a built-in id, so the entry needs both "keys" and "command" (ignored)`,
      )
      return
    }
    items.push({
      unbind: false,
      id: resolvedId,
      ...(keys !== undefined ? { keys } : {}),
      ...(typeof rawCommand === 'string' ? { command: rawCommand } : {}),
      ...(source['args'] !== undefined ? { args: source['args'] } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(surfaces !== undefined ? { surfaces } : {}),
    })
  })

  // Unbinds can also target entries the user adds, so judge them last.
  const catalog = [
    ...known.map((entry) => ({ id: entry.id, keys: entry.keys, command: entry.command })),
    ...items
      .filter((item) => !item.unbind && item.keys !== undefined && item.command !== undefined)
      .map((item) => ({ id: item.id!, keys: item.keys!, command: item.command! })),
  ]
  const kept: IVimUserKeymapItem[] = []
  items.forEach((item) => {
    if (!item.unbind) {
      kept.push(item)
      return
    }
    const matches =
      item.id !== undefined
        ? catalog.some((entry) => entry.id === item.id)
        : catalog.some(
            (entry) =>
              sameKeys(replaceLeader(entry.keys, leader), replaceLeader(item.keys!, leader)) &&
              (item.command === '' || entry.command === item.command),
          )
    if (!matches) {
      issues.push(
        `unbind ${JSON.stringify(item.id ?? item.keys)}${item.command ? ` ("-${item.command}")` : ''} matches no built-in mapping`,
      )
    }
    kept.push(item)
  })
  return { items: kept, issues }
}

/** Whether `entry` is visible on a surface of `kind` (before leader replacement). */
export function entryAppliesTo(
  entry: IVimKeymapEntry,
  kind: VimSurfaceKind,
  leader: string,
): boolean {
  if (entry.scope === 'surface') return true
  if (entry.surfaces !== undefined) return entry.surfaces.includes(kind)
  if (kind !== 'editor') return true
  const first = entry.keys[0]
  return first === LEADER_TOKEN || first === leader
}

function inherit(entry: IVimKeymapEntry, item: IVimUserKeymapItem): IVimKeymapEntry {
  return {
    ...entry,
    ...(item.keys !== undefined ? { keys: item.keys } : {}),
    ...(item.command !== undefined ? { command: item.command } : {}),
    ...(item.args !== undefined ? { args: item.args } : {}),
    ...(item.when !== undefined ? { when: item.when } : {}),
    ...(item.surfaces !== undefined ? { surfaces: item.surfaces } : {}),
  }
}

/**
 * Effective keymap for one surface kind. `surfaceEntries` are the keys the
 * active surface declared itself: they ignore `surfaces`, are tagged
 * `scope: 'surface'` and listed first so they win a tie with the kind-wide table.
 */
export function mergeVimKeymap(
  kind: VimSurfaceKind,
  base: readonly IVimKeymapEntry[],
  surfaceEntries: readonly IVimKeymapEntry[],
  items: readonly IVimUserKeymapItem[],
  leader: string,
  /**
   * Every entry any surface declares (active or not). A user override of one of
   * these ids applies only while that surface is active; without the catalog a
   * fully-specified override would be mistaken for a new, surface-less entry.
   */
  surfaceCatalog: readonly IVimKeymapEntry[] = [],
): readonly IVimKeymapEntry[] {
  const overrides = new Map<string, IVimUserKeymapItem>()
  const unbinds: IVimUserKeymapItem[] = []
  for (const item of items) {
    if (item.unbind) unbinds.push(item)
    else if (item.id !== undefined) overrides.set(item.id, item)
  }

  const merged: IVimKeymapEntry[] = []
  const seen = new Set<string>(surfaceCatalog.map((entry) => entry.id))
  const consider = (entry: IVimKeymapEntry): void => {
    seen.add(entry.id)
    const override = overrides.get(entry.id)
    const chosen = override === undefined ? entry : inherit(entry, override)
    if (entryAppliesTo(chosen, kind, leader)) merged.push(chosen)
  }
  for (const entry of surfaceEntries) {
    const { surfaces: _ignored, ...rest } = entry
    consider({ ...rest, scope: 'surface' })
  }
  for (const entry of base) consider(entry)
  for (const item of overrides.values()) {
    if (seen.has(item.id!) || item.keys === undefined || item.command === undefined) continue
    const created = inherit({ id: item.id!, keys: item.keys, command: item.command }, item)
    if (entryAppliesTo(created, kind, leader)) merged.push(created)
  }

  const resolved = merged.map((entry) => ({ ...entry, keys: replaceLeader(entry.keys, leader) }))
  if (unbinds.length === 0) return resolved
  return resolved.filter(
    (entry) =>
      !unbinds.some((unbind) => {
        if (unbind.surfaces !== undefined && !unbind.surfaces.includes(kind)) return false
        if (unbind.id !== undefined) return unbind.id === entry.id
        return (
          sameKeys(entry.keys, replaceLeader(unbind.keys!, leader)) &&
          (unbind.command === '' || unbind.command === entry.command)
        )
      }),
  )
}
