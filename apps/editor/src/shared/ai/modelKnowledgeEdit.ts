/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure editing helpers for the top-level `models` knowledge base in aiSettings.json:
 *  the capabilities quad, reasoning-effort levels, the `parameters` config schema,
 *  and knowledge-key naming. Kept in shared so the settings panel stays a thin
 *  orchestrator and every rule here stays unit-testable.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelCapabilities, AiModelConfigSchema } from '@universe-editor/platform'

import { AI_CAPABILITY_KEYS, type AiCapabilityKey } from './protocolMapEdit.js'

/**
 * Returns a COMPLETE capabilities object every time.
 * `capabilities` absent means the registry falls back to `{ streaming: true }`, and
 * mergeModelKnowledge replaces nested objects wholesale — so a partial write would
 * silently drop the built-in entry's vision/promptCaching flags.
 */
export function toggledCapabilities(
  effective: AiModelCapabilities | undefined,
  key: AiCapabilityKey,
  checked: boolean,
): AiModelCapabilities {
  const base = effective ?? { streaming: true }
  const next: Partial<Record<AiCapabilityKey, boolean>> = { streaming: base.streaming }
  for (const cap of AI_CAPABILITY_KEYS) {
    if (cap !== 'streaming') next[cap] = base[cap] ?? false
  }
  next[key] = checked
  return next as AiModelCapabilities
}

/** 'low, high, low' → ['low','high'] — trimmed, blanks dropped, order-preserving dedupe. */
export function parseReasoningEffort(text: string): readonly string[] {
  const seen = new Set<string>()
  const levels: string[] = []
  for (const part of text.split(',')) {
    const level = part.trim()
    if (level === '' || seen.has(level)) continue
    seen.add(level)
    levels.push(level)
  }
  return levels
}

/** join(', '); undefined → '' */
export function formatReasoningEffort(levels: readonly string[] | undefined): string {
  return levels === undefined ? '' : levels.join(', ')
}

export type ParametersValidation =
  | { readonly ok: true; readonly schema: AiModelConfigSchema }
  | { readonly ok: false; readonly error: string }

/**
 * Validate the raw JSON a user typed for `parameters`. The JSON schema declares
 * additionalProperties: true, so unknown keys inside a property pass — only the
 * shape of the keys we understand is checked.
 */
export function validateParametersSchema(text: string): ParametersValidation {
  if (text.trim() === '') return { ok: true, schema: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Invalid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Top level must be an object' }
  }
  const obj = parsed as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    const problem = validateParameterProperty(key, value)
    if (problem !== undefined) return { ok: false, error: problem }
  }
  return { ok: true, schema: obj as AiModelConfigSchema }
}

function validateParameterProperty(key: string, value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `"${key}": value must be an object`
  }
  const property = value as Record<string, unknown>
  const type = property['type']
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'enum') {
    return `"${key}": type must be one of string, number, boolean, enum`
  }
  if (type === 'enum' && property['enum'] !== undefined) {
    const allowed = property['enum']
    if (
      !Array.isArray(allowed) ||
      allowed.length === 0 ||
      !allowed.every((item) => typeof item === 'string')
    ) {
      return `"${key}": enum must be a non-empty array of strings`
    }
  }
  const defaultValue = property['default']
  const expected = type === 'enum' ? 'string' : type
  if (defaultValue !== undefined && typeof defaultValue !== expected) {
    return `"${key}": default must be a ${expected}`
  }
  return undefined
}

/** Non-empty, no '/', no leading/trailing whitespace (trim equals itself). */
export function isValidKnowledgeKey(key: string): boolean {
  return key !== '' && !key.includes('/') && key === key.trim()
}

/** 'kimi-k3' → 'kimi-k3-copy' → 'kimi-k3-copy-2' … (mirrors duplicateProvider). */
export function nextCopyKey(base: string, taken: ReadonlySet<string>): string {
  let key = `${base}-copy`
  for (let n = 2; taken.has(key); n++) key = `${base}-copy-${n}`
  return key
}
