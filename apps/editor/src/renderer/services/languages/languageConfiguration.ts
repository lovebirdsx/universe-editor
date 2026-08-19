/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parses a VSCode language-configuration.json (JSONC) into the subset of the
 *  monaco `LanguageConfiguration` shape the editor applies: comments / brackets /
 *  autoClosingPairs / surroundingPairs / wordPattern. Other VSCode fields
 *  (indentationRules, onEnterRules, folding, …) are intentionally not mapped yet.
 *--------------------------------------------------------------------------------------------*/

import { parse, type ParseError } from 'jsonc-parser'

export interface ILanguageConfigurationMapping {
  comments?: { lineComment?: string; blockComment?: [string, string] }
  brackets?: [string, string][]
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[]
  surroundingPairs?: { open: string; close: string }[]
  wordPattern?: RegExp
}

function isPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  )
}

function isAutoClosingPair(
  value: unknown,
): value is { open: string; close: string; notIn?: string[] } {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as { open?: unknown; close?: unknown; notIn?: unknown }
  if (typeof pair.open !== 'string' || typeof pair.close !== 'string') return false
  if (pair.notIn !== undefined && !Array.isArray(pair.notIn)) return false
  return true
}

/**
 * Parse a language-configuration.json body into the mapped monaco config.
 * Tolerates JSONC comments/trailing commas; returns `undefined` when the file
 * is not a JSON object (malformed / array / scalar), and silently drops fields
 * whose shape monaco would reject (including an uncompilable `wordPattern`).
 */
export function parseLanguageConfiguration(
  content: string,
): ILanguageConfigurationMapping | undefined {
  const errors: ParseError[] = []
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>

  const mapped: ILanguageConfigurationMapping = {}

  const comments = raw.comments
  if (typeof comments === 'object' && comments !== null && !Array.isArray(comments)) {
    const rule = comments as { lineComment?: unknown; blockComment?: unknown }
    const blockComment = rule.blockComment
    mapped.comments = {
      ...(typeof rule.lineComment === 'string' ? { lineComment: rule.lineComment } : {}),
      ...(isPair(blockComment) ? { blockComment } : {}),
    }
  }

  if (Array.isArray(raw.brackets)) {
    const brackets = raw.brackets.filter(isPair)
    if (brackets.length > 0) mapped.brackets = brackets
  }

  if (Array.isArray(raw.autoClosingPairs)) {
    const pairs = raw.autoClosingPairs.filter(isAutoClosingPair)
    if (pairs.length > 0) mapped.autoClosingPairs = pairs
  }

  if (Array.isArray(raw.surroundingPairs)) {
    const pairs = raw.surroundingPairs.filter(isPair).map(([open, close]) => ({ open, close }))
    if (pairs.length > 0) mapped.surroundingPairs = pairs
  }

  if (typeof raw.wordPattern === 'string') {
    try {
      mapped.wordPattern = new RegExp(raw.wordPattern)
    } catch {
      // Uncompilable word pattern: ignore (VSCode logs and continues too).
    }
  }

  return mapped
}
