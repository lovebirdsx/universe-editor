/*---------------------------------------------------------------------------------------------
 *  Elicitation form normalization + validation — pure functions that fold the
 *  wire `ElicitationSchema` (a constrained JSON Schema) into the flat field
 *  model the ElicitationCard renders, and validate user input against it
 *  before submit. Unrecognizable properties are skipped with a warn (never
 *  throw), matching the normalizeMcpServers "bad entries skipped" policy.
 *
 *  The AskUserQuestion bridge shape needs no special-casing: the claude fork's
 *  `question_<n>` (enum / enum-multi) + `question_<n>_custom` (string) and the
 *  codex fork's `<id>` (enum) + `<id>__other` (string) fields fall into the
 *  generic model directly; ElicitationCard pairs the free-text suffix fields
 *  with their enum for side-by-side rendering.
 *--------------------------------------------------------------------------------------------*/

import type {
  BooleanPropertySchema,
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
  EnumOption,
  MultiSelectItems,
  MultiSelectPropertySchema,
  NumberPropertySchema,
  StringPropertySchema,
} from '@agentclientprotocol/sdk'
import { localize } from '@universe-editor/platform'

export interface ElicitationEnumOption {
  readonly value: string
  readonly title: string
  readonly description?: string
  /**
   * Long-form preview (mockups, code snippets) shown on focus. Travels in the
   * enum option's `_meta['_claude/askUserQuestionOption'].preview` — the one
   * AskUserQuestion option field with no first-class ACP slot.
   */
  readonly preview?: string
}

interface ElicitationFieldBase {
  /** Property key in the schema's `properties` bag — the answer map key. */
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly required: boolean
}

export interface ElicitationStringField extends ElicitationFieldBase {
  readonly kind: 'string'
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly format?: string
  readonly default?: string
}

export interface ElicitationNumberField extends ElicitationFieldBase {
  readonly kind: 'number'
  /** True for `"type": "integer"` — input is rounded on submit. */
  readonly integer: boolean
  readonly minimum?: number
  readonly maximum?: number
  readonly default?: number
}

export interface ElicitationBooleanField extends ElicitationFieldBase {
  readonly kind: 'boolean'
  readonly default?: boolean
}

export interface ElicitationEnumField extends ElicitationFieldBase {
  readonly kind: 'enum'
  readonly options: readonly ElicitationEnumOption[]
  readonly default?: string
}

export interface ElicitationEnumMultiField extends ElicitationFieldBase {
  readonly kind: 'enum-multi'
  readonly options: readonly ElicitationEnumOption[]
  readonly minItems?: number
  readonly maxItems?: number
  readonly default?: readonly string[]
}

export type ElicitationFormField =
  | ElicitationStringField
  | ElicitationNumberField
  | ElicitationBooleanField
  | ElicitationEnumField
  | ElicitationEnumMultiField

export type ElicitationFormValues = Record<string, ElicitationContentValue | undefined>

const OPTION_META_KEY = '_claude/askUserQuestionOption'

type WarnFn = (message: string) => void

function enumOptionFromWire(option: EnumOption): ElicitationEnumOption {
  const preview = (option._meta as Record<string, { preview?: unknown }> | null | undefined)?.[
    OPTION_META_KEY
  ]?.preview
  return {
    value: option.const,
    title: option.title,
    ...(option.description != null ? { description: option.description } : {}),
    ...(typeof preview === 'string' ? { preview } : {}),
  }
}

function base(
  name: string,
  prop: { title?: string | null; description?: string | null },
  required: ReadonlySet<string>,
): ElicitationFieldBase {
  return {
    name,
    ...(prop.title != null ? { title: prop.title } : {}),
    ...(prop.description != null ? { description: prop.description } : {}),
    required: required.has(name),
  }
}

function normalizeProperty(
  name: string,
  prop: ElicitationPropertySchema,
  required: ReadonlySet<string>,
  onWarn: WarnFn,
): ElicitationFormField | undefined {
  // The union's custom-mode variant (`type: string; [key: string]: unknown`)
  // defeats literal narrowing on `type`, so cast per branch — unknown-variant
  // fields then read as undefined and degrade gracefully.
  switch (prop.type) {
    case 'string': {
      const p = prop as StringPropertySchema
      if (p.oneOf != null && p.oneOf.length > 0) {
        return {
          ...base(name, p, required),
          kind: 'enum',
          options: p.oneOf.map(enumOptionFromWire),
          ...(p.default != null ? { default: p.default } : {}),
        }
      }
      if (p.enum != null && p.enum.length > 0) {
        return {
          ...base(name, p, required),
          kind: 'enum',
          options: p.enum.map((value) => ({ value, title: value })),
          ...(p.default != null ? { default: p.default } : {}),
        }
      }
      return {
        ...base(name, p, required),
        kind: 'string',
        ...(p.minLength != null ? { minLength: p.minLength } : {}),
        ...(p.maxLength != null ? { maxLength: p.maxLength } : {}),
        ...(p.pattern != null ? { pattern: p.pattern } : {}),
        ...(p.format != null ? { format: p.format } : {}),
        ...(p.default != null ? { default: p.default } : {}),
      }
    }
    case 'number':
    case 'integer': {
      const p = prop as NumberPropertySchema
      return {
        ...base(name, p, required),
        kind: 'number',
        integer: prop.type === 'integer',
        ...(p.minimum != null ? { minimum: p.minimum } : {}),
        ...(p.maximum != null ? { maximum: p.maximum } : {}),
        ...(p.default != null ? { default: p.default } : {}),
      }
    }
    case 'boolean': {
      const p = prop as BooleanPropertySchema
      return {
        ...base(name, p, required),
        kind: 'boolean',
        ...(p.default != null ? { default: p.default } : {}),
      }
    }
    case 'array': {
      const p = prop as MultiSelectPropertySchema
      const items = p.items as MultiSelectItems | undefined
      let options: readonly ElicitationEnumOption[]
      if (items && 'anyOf' in items && Array.isArray(items.anyOf)) {
        options = (items.anyOf as EnumOption[]).map(enumOptionFromWire)
      } else if (items && 'enum' in items && Array.isArray(items.enum)) {
        options = (items.enum as string[]).map((value) => ({ value, title: value }))
      } else {
        onWarn(`elicitation schema: array property "${name}" has no enum/anyOf items — skipped`)
        return undefined
      }
      return {
        ...base(name, p, required),
        kind: 'enum-multi',
        options,
        ...(p.minItems != null ? { minItems: p.minItems } : {}),
        ...(p.maxItems != null ? { maxItems: p.maxItems } : {}),
        ...(p.default != null ? { default: p.default } : {}),
      }
    }
    default:
      onWarn(
        `elicitation schema: property "${name}" has unsupported type "${String(prop.type)}" — skipped`,
      )
      return undefined
  }
}

/**
 * Fold a wire `ElicitationSchema` into the flat field list the card renders.
 * Field order follows `properties` insertion order (the agent's intended
 * question order). Malformed properties are skipped + warned, never thrown.
 */
export function normalizeElicitationForm(
  schema: ElicitationSchema,
  onWarn: WarnFn = () => {},
): ElicitationFormField[] {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const fields: ElicitationFormField[] = []
  for (const [name, prop] of Object.entries(properties)) {
    const field = normalizeProperty(name, prop, required, onWarn)
    if (field) fields.push(field)
  }
  return fields
}

/** Seed initial input state from field defaults (used when no draft exists). */
export function defaultElicitationValues(
  fields: readonly ElicitationFormField[],
): ElicitationFormValues {
  const values: ElicitationFormValues = {}
  for (const field of fields) {
    if (field.default === undefined) continue
    values[field.name] = (
      Array.isArray(field.default) ? [...field.default] : field.default
    ) as ElicitationContentValue
  }
  return values
}

function displayName(field: ElicitationFormField): string {
  return field.title ?? field.name
}

function isMissing(
  field: ElicitationFormField,
  value: ElicitationContentValue | undefined,
): boolean {
  if (value === undefined) return true
  if (field.kind === 'string' && value === '') return true
  if (field.kind === 'enum-multi' && Array.isArray(value) && value.length === 0) return true
  return false
}

/**
 * Validate user input against the normalized fields; returns the first error
 * message or null. Only present values are constraint-checked (required-ness
 * is the gate for absent ones).
 */
export function validateElicitationValues(
  fields: readonly ElicitationFormField[],
  values: ElicitationFormValues,
): string | null {
  for (const field of fields) {
    const value = values[field.name]
    if (isMissing(field, value)) {
      if (field.required) {
        return localize('acp.elicitation.required', '"{field}" is required', {
          field: displayName(field),
        })
      }
      continue
    }
    switch (field.kind) {
      case 'string': {
        if (typeof value !== 'string') break
        if (field.minLength != null && value.length < field.minLength) {
          return localize(
            'acp.elicitation.minLength',
            '"{field}" must be at least {limit} characters',
            { field: displayName(field), limit: field.minLength },
          )
        }
        if (field.maxLength != null && value.length > field.maxLength) {
          return localize(
            'acp.elicitation.maxLength',
            '"{field}" must be at most {limit} characters',
            { field: displayName(field), limit: field.maxLength },
          )
        }
        if (field.pattern != null) {
          try {
            if (!new RegExp(field.pattern).test(value)) {
              return localize(
                'acp.elicitation.pattern',
                '"{field}" does not match the required format',
                { field: displayName(field) },
              )
            }
          } catch {
            // A bad pattern is the agent's bug, not the user's — don't block submit.
          }
        }
        break
      }
      case 'number': {
        if (typeof value !== 'number') break
        if (field.minimum != null && value < field.minimum) {
          return localize('acp.elicitation.minimum', '"{field}" must be at least {limit}', {
            field: displayName(field),
            limit: field.minimum,
          })
        }
        if (field.maximum != null && value > field.maximum) {
          return localize('acp.elicitation.maximum', '"{field}" must be at most {limit}', {
            field: displayName(field),
            limit: field.maximum,
          })
        }
        break
      }
      case 'enum': {
        if (typeof value === 'string' && !field.options.some((o) => o.value === value)) {
          return localize(
            'acp.elicitation.enumMembership',
            '"{field}" is not one of the allowed options',
            { field: displayName(field) },
          )
        }
        break
      }
      case 'enum-multi': {
        if (!Array.isArray(value)) break
        if (value.some((v) => !field.options.some((o) => o.value === v))) {
          return localize(
            'acp.elicitation.enumMembership',
            '"{field}" is not one of the allowed options',
            { field: displayName(field) },
          )
        }
        if (field.minItems != null && value.length < field.minItems) {
          return localize('acp.elicitation.minItems', '"{field}" needs at least {limit} selected', {
            field: displayName(field),
            limit: field.minItems,
          })
        }
        if (field.maxItems != null && value.length > field.maxItems) {
          return localize('acp.elicitation.maxItems', '"{field}" allows at most {limit} selected', {
            field: displayName(field),
            limit: field.maxItems,
          })
        }
        break
      }
      case 'boolean':
        break
    }
  }
  return null
}
