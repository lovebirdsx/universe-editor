/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  JSONC document surgery for `.universe-editor/triggers.json`: locate a trigger
 *  in the syntax tree, compute targeted edits (comments outside touched fields
 *  survive), append a new trigger, and map offsets to 1-based lines.
 *  Pure functions only — the renderer config form and the create wizard share
 *  them so both write the same minimal diff.
 *--------------------------------------------------------------------------------------------*/

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type FormattingOptions,
  type JSONPath,
  type Node,
} from 'jsonc-parser'
import { parseTriggersConfigText, type ParsedTriggerConfigText } from './configParse.js'
import type { TriggerConfig } from './types.js'

const BOM = '﻿'

export interface TriggerConfigLocation {
  readonly index: number
  /** JSON path of the trigger object, e.g. `['triggers', 0]`. */
  readonly path: JSONPath
}

export interface TriggerConfigEdit {
  readonly path: JSONPath
  /** `undefined` removes the property. */
  readonly value: unknown
}

export type TriggerConfigSection = 'trigger' | 'source' | 'session' | 'budget'

function splitBom(text: string): { readonly bom: string; readonly body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text }
}

function parseBody(body: string): Node | undefined {
  return parseTree(body)
}

/** Indentation / EOL of the existing file, so inserted JSON matches its style. */
export function detectFormattingOptions(text: string): FormattingOptions {
  const { body } = splitBom(text)
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const indented = body.split(/\r?\n/).find((line) => /^[ \t]+\S/.test(line))
  let insertSpaces = true
  let tabSize = 2
  if (indented !== undefined) {
    if (indented.startsWith('\t')) {
      insertSpaces = false
      tabSize = 1
    } else {
      tabSize = Math.min(8, Math.max(1, indented.length - indented.trimStart().length))
    }
  }
  return { insertSpaces, tabSize, eol, insertFinalNewline: body.endsWith('\n') }
}

function triggerArrayNode(root: Node): Node | undefined {
  const node = findNodeAtLocation(root, ['triggers'])
  return node?.type === 'array' ? node : undefined
}

function idOf(node: Node): string | undefined {
  const id = findNodeAtLocation(node, ['id'])
  return typeof id?.value === 'string' ? id.value : undefined
}

/**
 * Index and JSON path of the trigger object whose `id` matches. Returns
 * `undefined` for a missing / non-array `triggers`, a non-object root, or no
 * match; callers treat all of them as "the trigger is not in the document".
 */
export function locateTrigger(text: string, triggerId: string): TriggerConfigLocation | undefined {
  const { body } = splitBom(text)
  if (body.trim().length === 0) return undefined
  const root = parseBody(body)
  if (root?.type !== 'object') return undefined
  const triggers = triggerArrayNode(root)
  if (triggers?.children === undefined) return undefined
  for (let index = 0; index < triggers.children.length; index++) {
    const child = triggers.children[index]
    if (child !== undefined && child.type === 'object' && idOf(child) === triggerId) {
      return { index, path: ['triggers', index] }
    }
  }
  return undefined
}

/**
 * Apply edits one after another (each edit's offsets are relative to the text it
 * targets). All edits must stay inside the located trigger; array insertion is
 * not used here — that is what {@link appendTrigger} is for.
 */
export function applyTriggerEdits(text: string, edits: readonly TriggerConfigEdit[]): string {
  const { bom, body } = splitBom(text)
  let current = body
  for (const edit of edits) {
    const formattingOptions = detectFormattingOptions(current)
    const change = modify(current, edit.path, edit.value, { formattingOptions })
    current = applyEdits(current, change)
  }
  return bom + current
}

/**
 * Append one trigger to the `triggers` array, creating the array when absent.
 * An empty file is written as a fresh `{ version, triggers }` document. A root
 * that parses to something other than an object is rejected rather than
 * overwritten — the caller must surface the parse error to the user first.
 */
export function appendTrigger(text: string, trigger: TriggerConfig): string {
  const { bom, body } = splitBom(text)
  if (body.trim().length === 0) {
    return bom + `${JSON.stringify({ version: 1, triggers: [trigger] }, null, 2)}\n`
  }
  const root = parseBody(body)
  if (root?.type !== 'object') {
    throw new Error('triggers.json must contain a JSON object')
  }
  let current = body
  if (triggerArrayNode(root) === undefined) {
    current = applyEdits(
      current,
      modify(current, ['triggers'], [], {
        formattingOptions: detectFormattingOptions(current),
      }),
    )
  }
  const reparsed = parseBody(current)
  const triggers = reparsed === undefined ? undefined : triggerArrayNode(reparsed)
  if (triggers === undefined) throw new Error('"triggers" must be an array')
  const index = triggers.children?.length ?? 0
  const change = modify(current, ['triggers', index], trigger, {
    isArrayInsertion: true,
    formattingOptions: detectFormattingOptions(current),
  })
  return bom + applyEdits(current, change)
}

/** 1-based line number of a character offset (offsets past the end clamp). */
export function offsetToLine(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length))
  let line = 1
  for (let index = 0; index < limit; index++) {
    if (text.charCodeAt(index) === 10) line++
  }
  return line
}

/**
 * 1-based line of a trigger's section, for "Edit in JSON" jumps. `trigger` is the
 * trigger object itself; a missing section (e.g. no `session.budget`) yields
 * `undefined` and the caller opens the file without a reveal.
 */
export function triggerSectionLine(
  text: string,
  triggerId: string,
  section: TriggerConfigSection,
): number | undefined {
  const location = locateTrigger(text, triggerId)
  if (location === undefined) return undefined
  const { body } = splitBom(text)
  const root = parseBody(body)
  if (root === undefined) return undefined
  const triggerNode = findNodeAtLocation(root, location.path)
  if (triggerNode === undefined) return undefined
  if (section === 'trigger') return offsetToLine(body, triggerNode.offset)
  const sectionPath =
    section === 'budget' ? [...location.path, 'session', 'budget'] : [...location.path, section]
  const node = findNodeAtLocation(root, sectionPath)
  return node === undefined ? undefined : offsetToLine(body, node.offset)
}

/**
 * Same parse + validation the main process applies, so the form never shows a
 * draft the scheduler would reject. `invalid` also covers a non-object root and
 * a non-array `triggers`.
 */
export function parseTriggerDocument(text: string): ParsedTriggerConfigText {
  return parseTriggersConfigText(text)
}
