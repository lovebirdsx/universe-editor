import type { MobileAvailableCommand } from '@universe-editor/mobile-protocol'
import { readStoredString, writeStoredString } from '../preferences.js'
import { normalizeCommandName } from './slashCommands.js'

export const SLASH_USAGE_STORAGE_KEY = 'universe.mobile.slashUsage'
export const MAX_SLASH_USAGE_ENTRIES = 50

function usageKey(name: string): string {
  return normalizeCommandName(name).toLowerCase()
}

/** Stored as most-recent-first: the array order is the recency rank. */
export function parseSlashUsage(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const names: string[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    const name = normalizeCommandName(entry)
    const key = name.toLowerCase()
    if (name.length === 0 || seen.has(key)) continue
    seen.add(key)
    names.push(name)
    if (names.length >= MAX_SLASH_USAGE_ENTRIES) break
  }
  return names
}

export function readSlashUsage(): readonly string[] {
  return parseSlashUsage(readStoredString(SLASH_USAGE_STORAGE_KEY))
}

export function writeSlashUsage(usage: readonly string[]): void {
  writeStoredString(
    SLASH_USAGE_STORAGE_KEY,
    JSON.stringify(usage.slice(0, MAX_SLASH_USAGE_ENTRIES)),
  )
}

/** Moves the just-sent command to the front, deduping case-insensitively. */
export function recordSlashUsage(usage: readonly string[], name: string): readonly string[] {
  const normalized = normalizeCommandName(name)
  if (normalized.length === 0) return usage
  const key = normalized.toLowerCase()
  const rest = usage.filter((entry) => usageKey(entry) !== key)
  return [normalized, ...rest].slice(0, MAX_SLASH_USAGE_ENTRIES)
}

/**
 * Recently sent commands first; untouched commands keep the agent order. A
 * finite rank for unused entries keeps the comparator free of `Infinity - Infinity`.
 */
export function orderSlashCommandsByUsage(
  commands: readonly MobileAvailableCommand[],
  usage: readonly string[],
): readonly MobileAvailableCommand[] {
  if (usage.length === 0 || commands.length < 2) return commands
  const rank = new Map<string, number>()
  for (const name of usage) {
    const key = usageKey(name)
    if (key.length > 0 && !rank.has(key)) rank.set(key, rank.size)
  }
  if (rank.size === 0) return commands
  const unusedRank = rank.size
  const entries = commands.map((command, index) => ({
    command,
    index,
    rank: rank.get(usageKey(command.name)) ?? unusedRank,
  }))
  if (entries.every((entry) => entry.rank === unusedRank)) return commands
  entries.sort((left, right) => left.rank - right.rank || left.index - right.index)
  return entries.map((entry) => entry.command)
}
