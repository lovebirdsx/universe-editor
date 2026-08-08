/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  keybindingsSearchModel — query parsing + row filtering for the Keyboard
 *  Shortcuts editor search box, mirroring VSCode's KeybindingsEditorModel.fetch
 *  / KeybindingItemMatches semantics
 *  (src/vs/workbench/services/preferences/browser/keybindingsEditorModel.ts).
 *  Pure functions over IKeybindingsEditorModel; matching runs in the registry
 *  key space (`row.keybinding`, e.g. 'ctrl+k ctrl+s').
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import {
  filterAndSortMatches,
  matchesCamelCase,
  matchesContiguousSubString,
  matchesWords,
  orMatch,
  type IMatch,
} from '@universe-editor/workbench-ui'
import {
  normalizeKeybindingKey,
  type IKeybindingRow,
  type IKeybindingsEditorModel,
} from './keybindingsEditorModel.js'

export interface ParsedKeybindingsQuery {
  readonly commandId: string | undefined
  readonly when: string | undefined
  readonly source: 'user' | 'system' | 'extension' | undefined
  readonly extensionQuery: string | undefined
  readonly text: string
  readonly completeMatch: boolean
}

export interface IKeybindingPartMatch {
  readonly ctrlKey?: boolean
  readonly shiftKey?: boolean
  readonly altKey?: boolean
  readonly metaKey?: boolean
  readonly keyCode?: boolean
}

export interface IKeybindingMatches {
  readonly firstPart: IKeybindingPartMatch
  readonly chordPart: IKeybindingPartMatch
}

export interface IKeybindingRowMatches {
  readonly commandId?: readonly IMatch[]
  readonly commandLabel?: readonly IMatch[]
  readonly commandDefaultLabel?: readonly IMatch[]
  readonly when?: readonly IMatch[]
  readonly source?: readonly IMatch[]
  readonly extensionLabel?: readonly IMatch[]
  readonly keybinding?: IKeybindingMatches
}

export interface IKeybindingRowMatch {
  readonly row: IKeybindingRow
  readonly matches: IKeybindingRowMatches
}

const COMMAND_REGEX = /@command:\s*([^+]+)/i
const WHEN_REGEX = /\+when:\s*(.+)/i
const SOURCE_REGEX = /@source:\s*(user|default|system|extension)/i
const EXTENSION_REGEX = /@ext:\s*((".+")|([^\s]+))/i
const KEYBINDING_REGEX = /@keybinding:\s*((".+")|(\S+))/i

export function parseKeybindingsQuery(raw: string): ParsedKeybindingsQuery {
  const commandMatch = COMMAND_REGEX.exec(raw)
  if (commandMatch?.[1]) {
    const whenMatch = WHEN_REGEX.exec(raw)
    return {
      commandId: commandMatch[1].trim(),
      when: whenMatch?.[1]?.trim(),
      source: undefined,
      extensionQuery: undefined,
      text: '',
      completeMatch: false,
    }
  }

  let text = raw
  let source: ParsedKeybindingsQuery['source']
  let extensionQuery: string | undefined

  const sourceMatch = SOURCE_REGEX.exec(raw)
  if (sourceMatch?.[1]) {
    const value = sourceMatch[1].toLowerCase()
    source = value === 'user' ? 'user' : value === 'extension' ? 'extension' : 'system'
    text = raw.replace(SOURCE_REGEX, '')
  } else {
    const extensionMatch = EXTENSION_REGEX.exec(raw)
    if (extensionMatch && (extensionMatch[2] || extensionMatch[3])) {
      extensionQuery = extensionMatch[2]
        ? extensionMatch[2].substring(1, extensionMatch[2].length - 1)
        : extensionMatch[3]
      text = raw.replace(EXTENSION_REGEX, '')
    } else {
      const keybindingMatch = KEYBINDING_REGEX.exec(raw)
      if (keybindingMatch && (keybindingMatch[2] || keybindingMatch[3])) {
        text = keybindingMatch[2] ?? `"${keybindingMatch[3]}"`
      }
    }
  }

  text = text.trim()
  const quoteAtFirstChar = text.charAt(0) === '"'
  const quoteAtLastChar = text.charAt(text.length - 1) === '"'
  const completeMatch = quoteAtFirstChar && quoteAtLastChar
  if (quoteAtFirstChar) {
    text = text.substring(1)
  }
  if (quoteAtLastChar) {
    text = text.substring(0, text.length - 1)
  }
  text = text.trim()

  return { commandId: undefined, when: undefined, source, extensionQuery, text, completeMatch }
}

const CTRL_WORDS = new Set(['ctrl', 'control'])
const ALT_WORDS = new Set(['alt', 'option'])
const SHIFT_WORDS = new Set(['shift'])
const META_WORDS = new Set(['meta', 'cmd', 'command', 'win'])

function isModifierWord(lowerWord: string): boolean {
  return (
    CTRL_WORDS.has(lowerWord) ||
    ALT_WORDS.has(lowerWord) ||
    SHIFT_WORDS.has(lowerWord) ||
    META_WORDS.has(lowerWord)
  )
}

interface IChordShape {
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly keyCode: string
}

function parseChord(stroke: string): IChordShape {
  let ctrlKey = false
  let shiftKey = false
  let altKey = false
  let metaKey = false
  let keyCode = ''
  for (const part of stroke.split('+')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    if (trimmed === 'ctrl') ctrlKey = true
    else if (trimmed === 'alt') altKey = true
    else if (trimmed === 'shift') shiftKey = true
    else if (trimmed === 'meta') metaKey = true
    else keyCode = trimmed
  }
  return { ctrlKey, shiftKey, altKey, metaKey, keyCode }
}

function parseKeybindingChords(
  keybinding: string,
): readonly [IChordShape | null, IChordShape | null] {
  const strokes = keybinding
    .trim()
    .split(/\s+/)
    .filter((s) => s !== '')
  const first = strokes[0]
  const chord = strokes[1]
  return [
    first !== undefined ? parseChord(first) : null,
    chord !== undefined ? parseChord(chord) : null,
  ]
}

interface IPartMatchBuilder {
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  keyCode?: boolean
}

function matchesKeyCode(chord: IChordShape | null, word: string, completeMatch: boolean): boolean {
  if (!chord || chord.keyCode === '') return false
  if (completeMatch || chord.keyCode.length === 1 || word.length === 1) {
    return chord.keyCode.toLowerCase() === word.toLowerCase()
  }
  return matchesContiguousSubString(word, chord.keyCode) !== null
}

function matchPart(
  chord: IChordShape | null,
  match: IPartMatchBuilder,
  word: string,
  completeMatch: boolean,
): boolean {
  let matched = false
  const lower = word.toLowerCase()
  if (chord?.metaKey === true && META_WORDS.has(lower)) {
    match.metaKey = true
    matched = true
  }
  if (chord?.ctrlKey === true && CTRL_WORDS.has(lower)) {
    match.ctrlKey = true
    matched = true
  }
  if (chord?.shiftKey === true && SHIFT_WORDS.has(lower)) {
    match.shiftKey = true
    matched = true
  }
  if (chord?.altKey === true && ALT_WORDS.has(lower)) {
    match.altKey = true
    matched = true
  }
  if (matchesKeyCode(chord, word, completeMatch)) {
    match.keyCode = true
    matched = true
  }
  return matched
}

function hasAnyPartMatch(match: IPartMatchBuilder): boolean {
  return (
    match.altKey === true ||
    match.ctrlKey === true ||
    match.metaKey === true ||
    match.shiftKey === true ||
    match.keyCode === true
  )
}

function isCompletePartMatch(chord: IChordShape | null, match: IPartMatchBuilder): boolean {
  if (!chord) return true
  if (match.keyCode !== true) return false
  if (chord.metaKey && match.metaKey !== true) return false
  if (chord.altKey && match.altKey !== true) return false
  if (chord.ctrlKey && match.ctrlKey !== true) return false
  if (chord.shiftKey && match.shiftKey !== true) return false
  return true
}

function createCompletePartMatch(chord: IChordShape | null): IPartMatchBuilder {
  const match: IPartMatchBuilder = {}
  if (chord) {
    match.keyCode = true
    if (chord.metaKey) match.metaKey = true
    if (chord.altKey) match.altKey = true
    if (chord.ctrlKey) match.ctrlKey = true
    if (chord.shiftKey) match.shiftKey = true
  }
  return match
}

function matchesKeybinding(
  keybinding: string,
  searchValue: string,
  words: readonly string[],
  completeMatch: boolean,
): IKeybindingMatches | null {
  const [firstPart, chordPart] = parseKeybindingChords(keybinding)

  if (searchValue.toLowerCase() === keybinding.toLowerCase()) {
    return {
      firstPart: createCompletePartMatch(firstPart),
      chordPart: createCompletePartMatch(chordPart),
    }
  }

  const firstPartMatch: IPartMatchBuilder = {}
  let chordPartMatch: IPartMatchBuilder = {}

  const matchedWords: number[] = []
  const firstPartMatchedWords: number[] = []
  let chordPartMatchedWords: number[] = []
  let matchFirstPart = true
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    let firstPartMatched = false
    let chordPartMatched = false

    matchFirstPart = matchFirstPart && firstPartMatch.keyCode !== true
    let matchChordPart = chordPartMatch.keyCode !== true

    if (matchFirstPart) {
      firstPartMatched = matchPart(firstPart, firstPartMatch, word, completeMatch)
      if (firstPartMatch.keyCode === true) {
        for (const chordPartMatchedWordIndex of chordPartMatchedWords) {
          if (!firstPartMatchedWords.includes(chordPartMatchedWordIndex)) {
            matchedWords.splice(matchedWords.indexOf(chordPartMatchedWordIndex), 1)
          }
        }
        chordPartMatch = {}
        chordPartMatchedWords = []
        matchChordPart = false
      }
    }

    if (matchChordPart) {
      chordPartMatched = matchPart(chordPart, chordPartMatch, word, completeMatch)
    }

    if (firstPartMatched) {
      firstPartMatchedWords.push(index)
    }
    if (chordPartMatched) {
      chordPartMatchedWords.push(index)
    }
    if (firstPartMatched || chordPartMatched) {
      matchedWords.push(index)
    }

    matchFirstPart = matchFirstPart && isModifierWord(word.toLowerCase())
  }
  if (matchedWords.length !== words.length) {
    return null
  }
  if (completeMatch) {
    if (!isCompletePartMatch(firstPart, firstPartMatch)) {
      return null
    }
    if (hasAnyPartMatch(chordPartMatch) && !isCompletePartMatch(chordPart, chordPartMatch)) {
      return null
    }
  }
  return hasAnyPartMatch(firstPartMatch) || hasAnyPartMatch(chordPartMatch)
    ? { firstPart: firstPartMatch, chordPart: chordPartMatch }
    : null
}

type TextFieldKey =
  | 'commandId'
  | 'commandLabel'
  | 'commandDefaultLabel'
  | 'when'
  | 'source'
  | 'extensionLabel'

const textFieldFilter = orMatch(
  (word, target) => matchesWords(word, target, true),
  (word, target) => matchesCamelCase(word, target),
)

function sourceTextOf(row: IKeybindingRow): string | undefined {
  if (row.source.kind === 'user') return localize('keybindingsEditor.sourceUser', 'User')
  if (row.source.kind === 'system') return localize('keybindingsEditor.sourceSystem', 'System')
  return undefined
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== '')
}

function splitKeybindingWords(words: readonly string[]): string[] {
  const result: string[] = []
  for (const word of words) {
    for (const part of word.split('+')) {
      if (part !== '') result.push(part)
    }
  }
  return result
}

interface IRowMatchesBuilder {
  commandId?: readonly IMatch[]
  commandLabel?: readonly IMatch[]
  commandDefaultLabel?: readonly IMatch[]
  when?: readonly IMatch[]
  source?: readonly IMatch[]
  extensionLabel?: readonly IMatch[]
  keybinding?: IKeybindingMatches
}

function matchRow(
  row: IKeybindingRow,
  query: ParsedKeybindingsQuery,
): IKeybindingRowMatches | null {
  const words = splitWords(query.text)
  if (words.length === 0) return null

  const collected: Record<TextFieldKey, IMatch[]> = {
    commandId: [],
    commandLabel: [],
    commandDefaultLabel: [],
    when: [],
    source: [],
    extensionLabel: [],
  }

  // VSCode requires every word to hit the same field; here a word only needs to
  // hit at least one field, so words may distribute across fields.
  let allWordsCovered = false
  if (!query.completeMatch) {
    const fields: ReadonlyArray<readonly [TextFieldKey, string | undefined]> = [
      ['commandId', row.command],
      ['commandLabel', row.commandLabel],
      ['commandDefaultLabel', row.commandDefaultLabel],
      ['when', row.when],
      ['source', sourceTextOf(row)],
      ['extensionLabel', row.source.kind === 'extension' ? row.source.extensionLabel : undefined],
    ]
    allWordsCovered = true
    for (const word of words) {
      let covered = false
      for (const [key, value] of fields) {
        if (value === undefined) continue
        const wordMatches = textFieldFilter(word, value)
        if (wordMatches) {
          collected[key].push(...wordMatches)
          covered = true
        }
      }
      if (!covered) allWordsCovered = false
    }
  }

  let keybinding: IKeybindingMatches | undefined
  if (row.keybinding !== undefined) {
    const keybindingMatches = matchesKeybinding(
      row.keybinding,
      query.text,
      splitKeybindingWords(words),
      query.completeMatch,
    )
    if (keybindingMatches) {
      keybinding = keybindingMatches
      allWordsCovered = true
    }
  }

  if (!allWordsCovered) return null

  const matches: IRowMatchesBuilder = {}
  if (collected.commandId.length > 0) matches.commandId = filterAndSortMatches(collected.commandId)
  if (collected.commandLabel.length > 0)
    matches.commandLabel = filterAndSortMatches(collected.commandLabel)
  if (collected.commandDefaultLabel.length > 0)
    matches.commandDefaultLabel = filterAndSortMatches(collected.commandDefaultLabel)
  if (collected.when.length > 0) matches.when = filterAndSortMatches(collected.when)
  if (collected.source.length > 0) matches.source = filterAndSortMatches(collected.source)
  if (collected.extensionLabel.length > 0)
    matches.extensionLabel = filterAndSortMatches(collected.extensionLabel)
  if (keybinding) matches.keybinding = keybinding
  return matches
}

function filterByWhen(
  rows: readonly IKeybindingRow[],
  command: string,
  when: string,
): readonly IKeybindingRowMatch[] {
  const rowsWithWhen = rows.filter((row) => row.when?.trim() === when)
  if (rowsWithWhen.length > 0) {
    return rowsWithWhen.map((row) => ({ row, matches: {} }))
  }

  const template = rows[0]
  if (!template) return []
  const virtual: IKeybindingRow = {
    id: `virtual|${command}|${when}`,
    command,
    commandLabel: template.commandLabel,
    commandDefaultLabel: template.commandDefaultLabel,
    keybinding: undefined,
    chords: [],
    when,
    source: { kind: 'system' },
    isDefault: true,
    precedence: template.precedence,
  }
  return [{ row: virtual, matches: {} }]
}

export function fetchKeybindings(
  model: IKeybindingsEditorModel,
  query: ParsedKeybindingsQuery,
  sortByPrecedence: boolean,
): readonly IKeybindingRowMatch[] {
  let rows = sortByPrecedence ? model.byPrecedence : model.alphabetical

  if (query.commandId !== undefined) {
    const filtered = rows.filter((row) => row.command === query.commandId)
    if (filtered.length > 0 && query.when !== undefined) {
      return filterByWhen(filtered, query.commandId, query.when)
    }
    return filtered.map((row) => ({ row, matches: {} }))
  }

  if (query.source !== undefined) {
    const source = query.source
    rows = rows.filter((row) => row.source.kind === source)
  } else if (query.extensionQuery !== undefined) {
    const extension = query.extensionQuery.toLowerCase().trim()
    rows = rows.filter(
      (row) =>
        row.source.kind === 'extension' &&
        (row.source.extensionId?.toLowerCase() === extension ||
          row.source.extensionLabel.toLowerCase() === extension),
    )
  }

  if (query.text === '') {
    return rows.map((row) => ({ row, matches: {} }))
  }

  const result: IKeybindingRowMatch[] = []
  for (const row of rows) {
    const matches = matchRow(row, query)
    if (matches) result.push({ row, matches })
  }
  return result
}

export function countKeybindingConflicts(model: IKeybindingsEditorModel, key: string): number {
  return model.byKey.get(normalizeKeybindingKey(key))?.length ?? 0
}
