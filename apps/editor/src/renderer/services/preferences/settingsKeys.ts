/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Setting-key presentation helpers for the settings editor: scalar-schema
 *  gate, key splitting and VSCode-style `Category: Label` wordification.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationPropertySchema } from '@universe-editor/platform'

// The form only renders scalar settings (boolean / number / string / single
// enum). Object / array / union (type[]) / anyOf settings have no good form
// control — they remain fully editable in settings.json (which gets the
// complete schema for completion + validation).
export function isScalarSchema(schema: IConfigurationPropertySchema): boolean {
  if (schema.anyOf !== undefined) return false
  if (Array.isArray(schema.type)) return false
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return true
  const t = schema.type
  return t === 'boolean' || t === 'number' || t === 'integer' || t === 'string'
}

export interface SettingKeyParts {
  /** Dotted prefix before the last segment ('' when the key has no dot). */
  readonly category: string
  /** Last dotted segment. */
  readonly name: string
}

export function splitSettingKey(key: string): SettingKeyParts {
  const idx = key.lastIndexOf('.')
  if (idx < 0) return { category: '', name: key }
  return { category: key.slice(0, idx), name: key.slice(idx + 1) }
}

/**
 * Turn a key segment into a human label: separators (`.`, `-`, `_`) and
 * camelCase humps become word boundaries, each word capitalised.
 * `wordifySettingName('wordWrap')` → `'Word Wrap'`; `'editor.minimap'` → `'Editor Minimap'`.
 */
export function wordifySettingName(segment: string): string {
  const words: string[] = []
  let current = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (ch === '.' || ch === '-' || ch === '_') {
      if (current) words.push(current)
      current = ''
      continue
    }
    const prev = current[current.length - 1]
    if (
      current &&
      prev !== undefined &&
      prev === prev.toLowerCase() &&
      ch === ch.toUpperCase() &&
      ch !== ch.toLowerCase()
    ) {
      words.push(current)
      current = ch
      continue
    }
    current += ch
  }
  if (current) words.push(current)
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')
}

/**
 * VSCode-style row title: `Category: Label`. The category is the wordified
 * last segment of the key's dotted prefix; it is dropped when empty or when it
 * duplicates the group title (VSCode trims the category echoing its group).
 */
export function settingDisplayTitle(
  key: string,
  groupTitle: string,
): { category: string; label: string } {
  const { category, name } = splitSettingKey(key)
  const label = wordifySettingName(name)
  if (!category) return { category: '', label }
  const lastPrefixSegment = category.slice(category.lastIndexOf('.') + 1)
  const categoryLabel = wordifySettingName(lastPrefixSegment)
  if (categoryLabel.toLowerCase() === groupTitle.trim().toLowerCase()) {
    return { category: '', label }
  }
  return { category: categoryLabel, label }
}
