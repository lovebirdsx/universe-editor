/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  keybindingsEditorModel — one-shot O(n) resolution of every keybinding row
 *  shown by the Keyboard Shortcuts editor, mirroring VSCode's
 *  KeybindingsEditorModel.resolve / compareKeybindingData semantics
 *  (src/vs/workbench/services/preferences/browser/keybindingsEditorModel.ts).
 *
 *  Pure function: `resolveKeybindingEntries` takes an `IKeybindingModelDeps`
 *  snapshot (plain data + two lookup functions) and returns the row model;
 *  `collectKeybindingModelDeps` builds that snapshot from the live registries.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  KeybindingsRegistry,
  KeybindingWeight,
  localize,
  normalizeKeybindingString,
  type ContextKeyExpression,
  type ICommandMetadata,
  type IKeybindingItem,
} from '@universe-editor/platform'
import { getAllMonacoDefaultKeybindings } from '../../workbench/editor/monaco/monacoActionsBridge.js'
import type { DecodedKeybinding } from '../../workbench/editor/monaco/monacoKeybindingDecoder.js'
import { formatKey } from '../../workbench/titlebar/keybindingFormat.js'
import { getCommandSourceExtensionId } from '../extensions/contributedCommandSources.js'
import type { IUserKeybindingEntry, IUserKeybindingsService } from './UserKeybindingsService.js'

export type KeybindingSource =
  | { readonly kind: 'user' }
  | { readonly kind: 'system' }
  | {
      readonly kind: 'extension'
      readonly extensionId: string | undefined
      readonly extensionLabel: string
    }

export interface IKeybindingRow {
  /** Stable identity: command|key|when|sourceKind. */
  readonly id: string
  readonly command: string
  /** 'category: title' from command metadata; falls back to the command id. */
  readonly commandLabel: string
  /** English label assembled from originalCategory/originalDescription. */
  readonly commandDefaultLabel: string | undefined
  /** Registry key space, e.g. 'ctrl+k ctrl+s'; undefined for unbound rows. */
  readonly keybinding: string | undefined
  /** UI label segments per stroke (formatKey decomposition), for KeybindingLabel. */
  readonly chords: readonly (readonly string[])[]
  readonly when: string | undefined
  readonly source: KeybindingSource
  /** True for non-user rows. */
  readonly isDefault: boolean
  /** Index in precedence order; smaller wins. */
  readonly precedence: number
}

export interface IKeybindingsEditorModel {
  readonly alphabetical: readonly IKeybindingRow[]
  readonly byPrecedence: readonly IKeybindingRow[]
  /** Normalized key → rows sharing it (conflict detection). */
  readonly byKey: ReadonlyMap<string, readonly IKeybindingRow[]>
}

export interface IKeybindingModelDeps {
  /** Every registered command id → its metadata (undefined when registered without any). */
  readonly commands: ReadonlyMap<string, ICommandMetadata | undefined>
  /** KeybindingsRegistry.getAllKeybindings() snapshot (ascending weight, registration order). */
  readonly registryEntries: readonly IKeybindingItem[]
  /** Monaco side-table of default keys for commands without a registry entry. */
  readonly monacoDefaults: ReadonlyMap<string, DecodedKeybinding>
  /** User-layer entries from keybindings.json (positive + removal). */
  readonly userEntries: readonly IUserKeybindingEntry[]
  readonly extensionIdOf: (commandId: string) => string | undefined
  readonly extensionLabelOf: (extensionId: string) => string | undefined
}

function strokesOfKey(key: string): string[] {
  return key
    .trim()
    .split(/\s+/)
    .filter((s) => s !== '')
}

function registryKeyOf(strokes: readonly string[]): string {
  return strokes.map(normalizeKeybindingString).join(' ')
}

/** Normalize a raw key/chord string into the registry key space used by `byKey`. */
export function normalizeKeybindingKey(key: string): string {
  return registryKeyOf(strokesOfKey(key))
}

function itemStrokes(item: IKeybindingItem): string[] {
  if (item.chords) return [item.chords[0], item.chords[1]]
  if (item.key !== undefined) return [item.key]
  return []
}

function serializeWhen(when: IKeybindingItem['when']): string | undefined {
  if (when === undefined) return undefined
  if (typeof when === 'string') return when
  return (when as ContextKeyExpression).serialize()
}

function chordLabelsOf(keybinding: string): readonly string[][] {
  return strokesOfKey(keybinding).map((stroke) => stroke.split('+').map((part) => formatKey(part)))
}

function commandLabelOf(
  command: string,
  metadata: ICommandMetadata | undefined,
): { label: string; defaultLabel: string | undefined } {
  if (!metadata?.description) {
    return { label: command, defaultLabel: undefined }
  }
  const label = metadata.category
    ? `${metadata.category}: ${metadata.description}`
    : metadata.description
  if (!metadata.originalDescription) {
    return { label, defaultLabel: undefined }
  }
  const defaultLabel = metadata.originalCategory
    ? `${metadata.originalCategory}: ${metadata.originalDescription}`
    : metadata.originalDescription
  return { label, defaultLabel: defaultLabel !== label ? defaultLabel : undefined }
}

function compareKeybindingRows(a: IKeybindingRow, b: IKeybindingRow): number {
  if (a.keybinding !== undefined && b.keybinding === undefined) return -1
  if (b.keybinding !== undefined && a.keybinding === undefined) return 1
  if (a.commandLabel !== b.commandLabel) {
    return a.commandLabel.localeCompare(b.commandLabel)
  }
  if (a.command === b.command) {
    // Same command: the user row (isDefault false) sorts first.
    return a.isDefault ? 1 : -1
  }
  return a.command.localeCompare(b.command)
}

export function resolveKeybindingEntries(deps: IKeybindingModelDeps): IKeybindingsEditorModel {
  const {
    commands,
    registryEntries,
    monacoDefaults,
    userEntries,
    extensionIdOf,
    extensionLabelOf,
  } = deps

  const systemSource: KeybindingSource = { kind: 'system' }
  const extensionSourceOf = (command: string): KeybindingSource => {
    const extensionId = extensionIdOf(command)
    const label =
      (extensionId !== undefined ? extensionLabelOf(extensionId) : undefined) ??
      extensionId ??
      localize('keybindingsEditor.extensionSource', 'Extension')
    return { kind: 'extension', extensionId, extensionLabel: label }
  }

  // Negations suppress the default binding sharing their (command, key),
  // regardless of the weight tier the negation was registered at.
  const negations = new Set<string>()
  for (const item of registryEntries) {
    if (!item.isNegated) continue
    negations.add(`${item.command}|${registryKeyOf(itemStrokes(item))}`)
  }

  const rows: IKeybindingRow[] = []
  const boundCommands = new Set<string>()
  let precedence = 0

  const pushRow = (row: Omit<IKeybindingRow, 'precedence'>): void => {
    rows.push({ ...row, precedence: precedence++ })
    boundCommands.add(row.command)
  }

  const makeRow = (
    command: string,
    keybinding: string | undefined,
    when: string | undefined,
    source: KeybindingSource,
  ): Omit<IKeybindingRow, 'precedence'> => {
    const { label, defaultLabel } = commandLabelOf(command, commands.get(command))
    const sourceKind =
      source.kind === 'extension' ? `extension:${source.extensionId ?? ''}` : source.kind
    return {
      id: `${command}|${keybinding ?? ''}|${when ?? ''}|${sourceKind}`,
      command,
      commandLabel: label,
      commandDefaultLabel: defaultLabel,
      keybinding,
      chords: keybinding !== undefined ? chordLabelsOf(keybinding) : [],
      when,
      source,
      isDefault: source.kind !== 'user',
    }
  }

  // Reverse iteration = precedence order: highest weight first, and within one
  // weight the most-recently-registered binding first.
  for (let i = registryEntries.length - 1; i >= 0; i--) {
    const item = registryEntries[i]!
    if (item.isNegated) continue
    // User-layer positive entries are re-registered into the registry at User
    // weight; their rows are generated from userEntries below, so skip them
    // here to avoid double counting.
    if ((item.weight ?? KeybindingWeight.WorkbenchContrib) >= KeybindingWeight.User) continue
    const strokes = itemStrokes(item)
    if (strokes.length === 0) continue
    const key = registryKeyOf(strokes)
    if (negations.has(`${item.command}|${key}`)) continue
    const source =
      item.weight === KeybindingWeight.ExternalExtension ||
      extensionIdOf(item.command) !== undefined
        ? extensionSourceOf(item.command)
        : systemSource
    pushRow(makeRow(item.command, key, serializeWhen(item.when), source))
  }

  // Monaco default keys whose command never made it into the registry.
  for (const [command, decoded] of monacoDefaults) {
    if (boundCommands.has(command)) continue
    const key = registryKeyOf(
      decoded.chords ? [decoded.chords[0], decoded.chords[1]] : [decoded.key!],
    )
    pushRow(makeRow(command, key, undefined, systemSource))
  }

  // User-layer rows come straight from keybindings.json. Positive entries
  // produce a binding row; removal entries never produce one — a pure disable
  // (key === null) leaves the command to the unbound pass below.
  for (const entry of userEntries) {
    if (entry.isRemoval || entry.key === null) continue
    const key = registryKeyOf(strokesOfKey(entry.key))
    if (key === '') continue
    pushRow(makeRow(entry.command, key, entry.when, { kind: 'user' }))
  }

  // Unbound commands: registered with metadata, no row produced, not a
  // `_`-prefixed internal command.
  for (const [command, metadata] of commands) {
    if (boundCommands.has(command) || command.startsWith('_')) continue
    if (metadata?.description === undefined) continue
    const source = extensionIdOf(command) !== undefined ? extensionSourceOf(command) : systemSource
    pushRow(makeRow(command, undefined, undefined, source))
  }

  const seen = new Set<string>()
  const byPrecedence = rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
  const alphabetical = [...byPrecedence].sort(compareKeybindingRows)

  const byKeyMutable = new Map<string, IKeybindingRow[]>()
  for (const row of byPrecedence) {
    if (row.keybinding === undefined) continue
    const list = byKeyMutable.get(row.keybinding)
    if (list) list.push(row)
    else byKeyMutable.set(row.keybinding, [row])
  }

  return { alphabetical, byPrecedence, byKey: byKeyMutable }
}

/** Snapshot the live registries into model deps. */
export function collectKeybindingModelDeps(
  userKeybindingsService: IUserKeybindingsService,
): IKeybindingModelDeps {
  const commands = new Map<string, ICommandMetadata | undefined>()
  for (const [id, command] of CommandsRegistry.getCommands()) {
    commands.set(id, command.metadata)
  }
  return {
    commands,
    registryEntries: [...KeybindingsRegistry.getAllKeybindings()],
    monacoDefaults: getAllMonacoDefaultKeybindings(),
    userEntries: [...userKeybindingsService.userEntries],
    extensionIdOf: getCommandSourceExtensionId,
    // Extension display names are not tracked renderer-side yet; the model
    // falls back to the extension id, then to a generic 'Extension' label.
    extensionLabelOf: () => undefined,
  }
}
