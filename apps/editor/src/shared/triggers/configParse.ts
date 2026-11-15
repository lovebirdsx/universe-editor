/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parser / validator for a workspace's `.universe-editor/triggers.json`.
 *  A known field that is present but invalid rejects only that trigger (listed under
 *  `invalid`); unknown fields are ignored. The workspace is implied by the file's
 *  location, so there is no `workspace` field and ids are unique per file only.
 *
 *  This file is the single source of truth for validation: the JSON schema in
 *  `TRIGGERS_SCHEMA` (registered by TriggersConfigurationContribution) is built
 *  from the same patterns / limits, and a parity test runs one fixture set through
 *  both. Unknown fields are the one deliberate difference: the parser ignores
 *  them for forward compatibility (a field added by a newer editor must not make
 *  an older client reject a whole trigger), while the schema reports them as
 *  warnings so typos surface in the editor.
 *--------------------------------------------------------------------------------------------*/

import {
  REMOTE_SCHEME,
  URI,
  remoteAuthorityLabel,
  type IJSONSchema,
} from '@universe-editor/platform'
import { parse, type ParseError } from 'jsonc-parser'
import { parseCron } from './cron.js'
import {
  ELEVATED_MODE_IDS,
  TRIGGER_DEFAULTS,
  TRIGGER_EVENT_NAMES,
  TRIGGERS_WORKSPACE_CONFIG_FILE,
  type InvalidTriggerConfig,
  type TriggerBudget,
  type TriggerConfig,
  type TriggerConfigError,
  type TriggerConfigErrorCode,
  type TriggerConfigErrorParams,
  type TriggerEventName,
  type TriggerOnMissed,
  type TriggerOverflow,
  type TriggerSessionConfig,
  type TriggerSourceConfig,
  type TriggersConfig,
} from './types.js'
import { isSafeRelativePath } from './verdict.js'

export type ParseTriggersConfigResult =
  | { readonly ok: true; readonly config: TriggersConfig }
  | { readonly ok: false; readonly error: string; readonly issue: TriggerConfigError }

/** Patterns / limits shared by the parser and the JSON schema. */
export const TRIGGER_ID_PATTERN_SOURCE = '^[a-z0-9][a-z0-9-]{0,63}$'
export const TRIGGER_SKILL_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9:_-]*$'

export const TRIGGER_LIMITS = {
  concurrencyMin: 1,
  concurrencyMax: 10,
  everyMinMin: 1,
  pollIntervalSecMin: 30,
  pollTimeoutSecMin: 1,
  pollTimeoutSecMax: 600,
} as const

const TRIGGER_ID_PATTERN = new RegExp(TRIGGER_ID_PATTERN_SOURCE)
const SKILL_PATTERN = new RegExp(TRIGGER_SKILL_PATTERN_SOURCE)

/** Same rule the parser applies, exposed so the create wizard can validate as the user types. */
export function isValidTriggerId(value: string): boolean {
  return TRIGGER_ID_PATTERN.test(value)
}

function pathText(path: readonly (string | number)[]): string {
  return path.length === 0 ? 'trigger' : path.join('.')
}

/** Structured error with a readable fallback message for main-side consumers. */
export function triggerConfigError(
  path: readonly (string | number)[],
  code: TriggerConfigErrorCode,
  message: string,
  params: TriggerConfigErrorParams = {},
): TriggerConfigError {
  return { path, code, params, message }
}

function fieldErrorMessage(path: readonly (string | number)[], suffix: string): string {
  return `"${pathText(path)}" ${suffix}`
}

function nonEmptyStringError(path: readonly (string | number)[]): TriggerConfigError {
  return triggerConfigError(
    path,
    'request.field.nonEmptyString',
    fieldErrorMessage(path, 'must be a non-empty string'),
    { field: pathText(path) },
  )
}

function booleanError(path: readonly (string | number)[]): TriggerConfigError {
  return triggerConfigError(
    path,
    'request.field.boolean',
    fieldErrorMessage(path, 'must be a boolean'),
    {
      field: pathText(path),
    },
  )
}

function stringError(path: readonly (string | number)[]): TriggerConfigError {
  return triggerConfigError(
    path,
    'request.field.string',
    fieldErrorMessage(path, 'must be a string'),
    {
      field: pathText(path),
    },
  )
}

function integerRangeError(
  path: readonly (string | number)[],
  min: number,
  max: number,
): TriggerConfigError {
  return triggerConfigError(
    path,
    'request.field.integerRange',
    fieldErrorMessage(path, `must be an integer between ${min} and ${max}`),
    { field: pathText(path), min, max },
  )
}

function enumError(
  path: readonly (string | number)[],
  allowed: readonly string[],
): TriggerConfigError {
  const quoted = allowed.map((value) => `"${value}"`).join(' | ')
  return triggerConfigError(
    path,
    'request.field.enum',
    fieldErrorMessage(path, `must be one of ${quoted}`),
    { field: pathText(path), allowed: allowed.join(' | ') },
  )
}

function stringArrayError(path: readonly (string | number)[]): TriggerConfigError {
  return triggerConfigError(
    path,
    'request.field.stringArray',
    fieldErrorMessage(path, 'must be an array of non-empty strings'),
    { field: pathText(path) },
  )
}

function positiveNumberError(path: readonly (string | number)[]): TriggerConfigError {
  return triggerConfigError(
    path,
    'request.field.positiveNumber',
    fieldErrorMessage(path, 'must be a positive number'),
    { field: pathText(path) },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Windows drive or POSIX root; UNC shares and URI forms are rejected. */
function isAbsoluteLocalPath(path: string): boolean {
  const value = path.trim()
  if (value.length === 0) return false
  if (value.includes('://')) return false
  if (value.startsWith('\\\\') || value.startsWith('//')) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return value.startsWith('/')
}

/**
 * A workspace folder identity is a URI string: `file:` without an authority (a
 * bare path from an older caller is accepted for the composite-key rebuild) or
 * `remote-ssh:` with an authority and an absolute path. Anything else — relative
 * paths, UNC file URIs, unsupported schemes — is not a scheduler workspace.
 */
export function parseWorkspaceUri(value: unknown): URI | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (!trimmed.includes('://')) {
    return isAbsoluteLocalPath(trimmed) ? URI.file(trimmed) : undefined
  }
  const uri = URI.parse(trimmed)
  if (uri.scheme === 'file') {
    if (uri.authority.length > 0) return undefined
    return isAbsoluteLocalPath(uri.fsPath) ? uri : undefined
  }
  if (uri.scheme === REMOTE_SCHEME) {
    if (uri.authority.length === 0) return undefined
    return uri.path.startsWith('/') ? uri : undefined
  }
  return undefined
}

/**
 * Human-facing path for a workspace URI string; never render the raw URI in UI.
 * Remote workspaces keep the authority in parentheses: several hosts can mount
 * the same path, and the path alone would make them indistinguishable.
 */
export function workspaceDisplayPath(workspace: string): string {
  const uri = parseWorkspaceUri(workspace)
  if (uri === undefined) return workspace
  if (uri.scheme === REMOTE_SCHEME) {
    return `${uri.fsPath} (${remoteAuthorityLabel(uri.authority)})`
  }
  return uri.fsPath
}

interface ParseErrors {
  readonly ok: false
  readonly errors: readonly TriggerConfigError[]
}

type SourceParseResult = { readonly ok: true; readonly source: TriggerSourceConfig } | ParseErrors

function parseScheduleSource(raw: Record<string, unknown>): SourceParseResult {
  const errors: TriggerConfigError[] = []
  const hasCron = hasOwn(raw, 'cron')
  const hasEveryMin = hasOwn(raw, 'everyMin')
  if (hasCron === hasEveryMin) {
    errors.push(
      triggerConfigError(
        ['source', 'cron'],
        'source.schedule.mode',
        '"source" must set exactly one of "cron" / "everyMin"',
      ),
    )
  }

  let cron: string | undefined
  if (hasCron) {
    const value = raw['cron']
    if (typeof value !== 'string') {
      errors.push(stringError(['source', 'cron']))
    } else {
      const parsed = parseCron(value)
      if (parsed.ok) cron = value
      else {
        errors.push(
          triggerConfigError(
            ['source', 'cron'],
            'source.cron.invalid',
            `"source.cron" is invalid: ${parsed.error}`,
            { reason: parsed.error },
          ),
        )
      }
    }
  }

  let everyMin: number | undefined
  if (hasEveryMin) {
    const value = raw['everyMin']
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= TRIGGER_LIMITS.everyMinMin
    ) {
      everyMin = value
    } else {
      errors.push(
        triggerConfigError(
          ['source', 'everyMin'],
          'request.field.integerRange',
          `"source.everyMin" must be an integer >= ${TRIGGER_LIMITS.everyMinMin}`,
          {
            field: 'source.everyMin',
            min: TRIGGER_LIMITS.everyMinMin,
            max: Number.MAX_SAFE_INTEGER,
          },
        ),
      )
    }
  }

  let onMissed: TriggerOnMissed = 'skip'
  if (hasOwn(raw, 'onMissed')) {
    const value = raw['onMissed']
    if (value === 'skip' || value === 'catch-up-once') onMissed = value
    else errors.push(enumError(['source', 'onMissed'], ['skip', 'catch-up-once']))
  }

  if (errors.length > 0) return { ok: false, errors }
  if (cron !== undefined) return { ok: true, source: { type: 'schedule', cron, onMissed } }
  if (everyMin !== undefined) return { ok: true, source: { type: 'schedule', everyMin, onMissed } }
  return {
    ok: false,
    errors: [
      triggerConfigError(
        ['source', 'cron'],
        'source.schedule.mode',
        '"source" must set exactly one of "cron" / "everyMin"',
      ),
    ],
  }
}

function parsePollSource(raw: Record<string, unknown>): SourceParseResult {
  const errors: TriggerConfigError[] = []

  let intervalSec = 0
  let intervalValid = false
  const intervalRaw = raw['intervalSec']
  if (
    typeof intervalRaw === 'number' &&
    Number.isInteger(intervalRaw) &&
    intervalRaw >= TRIGGER_LIMITS.pollIntervalSecMin
  ) {
    intervalSec = intervalRaw
    intervalValid = true
  } else {
    errors.push(
      triggerConfigError(
        ['source', 'intervalSec'],
        'request.field.integerRange',
        `"source.intervalSec" must be an integer >= ${TRIGGER_LIMITS.pollIntervalSecMin}`,
        {
          field: 'source.intervalSec',
          min: TRIGGER_LIMITS.pollIntervalSecMin,
          max: Number.MAX_SAFE_INTEGER,
        },
      ),
    )
  }

  let keyField = ''
  const keyFieldRaw = raw['keyField']
  if (isNonEmptyString(keyFieldRaw)) keyField = keyFieldRaw.trim()
  else errors.push(nonEmptyStringError(['source', 'keyField']))

  let command = ''
  let timeoutSec: number = TRIGGER_DEFAULTS.pollTimeoutSec
  const fetchRaw = raw['fetch']
  if (!isRecord(fetchRaw)) {
    errors.push(
      triggerConfigError(
        ['source', 'fetch'],
        'source.notObject',
        '"source.fetch" must be an object',
        {
          field: 'source.fetch',
        },
      ),
    )
  } else {
    if (fetchRaw['type'] !== 'command') {
      errors.push(enumError(['source', 'fetch', 'type'], ['command']))
    }
    const commandRaw = fetchRaw['command']
    if (isNonEmptyString(commandRaw)) command = commandRaw.trim()
    else errors.push(nonEmptyStringError(['source', 'fetch', 'command']))
    if (hasOwn(fetchRaw, 'timeoutSec')) {
      const value = fetchRaw['timeoutSec']
      if (
        isIntegerInRange(value, TRIGGER_LIMITS.pollTimeoutSecMin, TRIGGER_LIMITS.pollTimeoutSecMax)
      ) {
        timeoutSec = value
      } else {
        errors.push(
          integerRangeError(
            ['source', 'fetch', 'timeoutSec'],
            TRIGGER_LIMITS.pollTimeoutSecMin,
            TRIGGER_LIMITS.pollTimeoutSecMax,
          ),
        )
      }
    }
  }

  // A command that may run longer than the interval would overlap the next poll.
  if (intervalValid && timeoutSec >= intervalSec) {
    errors.push(
      triggerConfigError(
        ['source', 'fetch', 'timeoutSec'],
        'source.poll.timeoutNotLessThanInterval',
        `"source.fetch.timeoutSec" (${timeoutSec}) must be less than "source.intervalSec" (${intervalSec})`,
        { timeoutSec, intervalSec },
      ),
    )
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    source: {
      type: 'poll',
      intervalSec,
      fetch: { type: 'command', command, timeoutSec },
      keyField,
    },
  }
}

function parseEventSource(raw: Record<string, unknown>): SourceParseResult {
  const event = raw['event']
  if (typeof event !== 'string' || !(TRIGGER_EVENT_NAMES as readonly string[]).includes(event)) {
    return {
      ok: false,
      errors: [
        triggerConfigError(
          ['source', 'event'],
          'request.field.enum',
          `"source.event" must be one of ${TRIGGER_EVENT_NAMES.map((name) => `"${name}"`).join(' | ')}`,
          { field: 'source.event', allowed: TRIGGER_EVENT_NAMES.join(' | ') },
        ),
      ],
    }
  }
  return { ok: true, source: { type: 'event', event: event as TriggerEventName } }
}

function parseSource(raw: unknown): SourceParseResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [
        triggerConfigError(['source'], 'source.notObject', '"source" must be an object', {
          field: 'source',
        }),
      ],
    }
  }
  switch (raw['type']) {
    case 'manual':
      return { ok: true, source: { type: 'manual' } }
    case 'event':
      return parseEventSource(raw)
    case 'schedule':
      return parseScheduleSource(raw)
    case 'poll':
      return parsePollSource(raw)
    default:
      return {
        ok: false,
        errors: [
          triggerConfigError(
            ['source', 'type'],
            'source.type.invalid',
            '"source.type" must be one of "manual" | "schedule" | "poll" | "event"',
            { field: 'source.type', allowed: 'manual | schedule | poll | event' },
          ),
        ],
      }
  }
}

function parseBudget(raw: unknown, errors: TriggerConfigError[]): TriggerBudget {
  const values: { maxCostUsd: number | null; timeoutMin: number; approvalTimeoutMin: number } = {
    ...TRIGGER_DEFAULTS.budget,
  }
  if (!isRecord(raw)) {
    errors.push(
      triggerConfigError(
        ['session', 'budget'],
        'session.budget.notObject',
        '"session.budget" must be an object',
        { field: 'session.budget' },
      ),
    )
    return values
  }
  const fields = ['maxCostUsd', 'timeoutMin', 'approvalTimeoutMin'] as const
  for (const field of fields) {
    if (!hasOwn(raw, field)) continue
    const value = raw[field]
    if (field === 'maxCostUsd' && value === null) {
      values.maxCostUsd = null
      continue
    }
    if (isPositiveNumber(value)) values[field] = value
    else errors.push(positiveNumberError(['session', 'budget', field]))
  }
  return values
}

function parseSession(
  raw: unknown,
): { readonly ok: true; readonly session: TriggerSessionConfig } | ParseErrors {
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [
        triggerConfigError(['session'], 'session.notObject', '"session" must be an object', {
          field: 'session',
        }),
      ],
    }
  }
  const errors: TriggerConfigError[] = []

  const optionalString = (key: 'agent' | 'mode' | 'model'): string | undefined => {
    if (!hasOwn(raw, key)) return undefined
    const value = raw[key]
    if (isNonEmptyString(value)) return value.trim()
    errors.push(nonEmptyStringError(['session', key]))
    return undefined
  }

  const agent = optionalString('agent')
  const mode = optionalString('mode')
  const model = optionalString('model')

  let cwd: string | undefined
  if (hasOwn(raw, 'cwd')) {
    const value = raw['cwd']
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(nonEmptyStringError(['session', 'cwd']))
    } else if (!isSafeRelativePath(value)) {
      errors.push(
        triggerConfigError(
          ['session', 'cwd'],
          'session.cwd.invalid',
          '"session.cwd" must be a relative path inside the workspace (no "..")',
        ),
      )
    } else {
      cwd = value.trim()
    }
  }

  let skill: string | undefined
  if (hasOwn(raw, 'skill')) {
    const value = raw['skill']
    if (typeof value === 'string' && SKILL_PATTERN.test(value)) skill = value
    else {
      errors.push(
        triggerConfigError(
          ['session', 'skill'],
          'session.skill.invalid',
          `"session.skill" must match ${TRIGGER_SKILL_PATTERN_SOURCE}`,
          { pattern: TRIGGER_SKILL_PATTERN_SOURCE },
        ),
      )
    }
  }

  let prompt = ''
  if (hasOwn(raw, 'prompt')) {
    const value = raw['prompt']
    if (typeof value === 'string') prompt = value
    else errors.push(stringError(['session', 'prompt']))
  }
  if (skill === undefined && prompt.trim().length === 0) {
    errors.push(
      triggerConfigError(
        ['session', 'prompt'],
        'session.promptOrSkill.required',
        '"session" must set "skill" or a non-empty "prompt"',
      ),
    )
  }

  let mcpServers: string[] | undefined
  if (hasOwn(raw, 'mcpServers')) {
    const value = raw['mcpServers']
    if (!Array.isArray(value)) {
      errors.push(stringArrayError(['session', 'mcpServers']))
    } else {
      mcpServers = []
      for (const entry of value) {
        if (isNonEmptyString(entry)) mcpServers.push(entry.trim())
        else errors.push(stringArrayError(['session', 'mcpServers']))
      }
    }
  }

  let budget: TriggerBudget = { ...TRIGGER_DEFAULTS.budget }
  if (hasOwn(raw, 'budget')) budget = parseBudget(raw['budget'], errors)

  if (errors.length > 0) return { ok: false, errors }
  const session: TriggerSessionConfig = {
    ...(agent === undefined ? {} : { agent }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(mode === undefined ? {} : { mode }),
    ...(model === undefined ? {} : { model }),
    ...(skill === undefined ? {} : { skill }),
    prompt,
    ...(mcpServers === undefined ? {} : { mcpServers }),
    budget,
  }
  return { ok: true, session }
}

interface ParsedTrigger {
  readonly id: string
  readonly index: number
  readonly errors: readonly TriggerConfigError[]
  readonly config?: TriggerConfig
}

function parseTrigger(raw: unknown, index: number): ParsedTrigger {
  if (!isRecord(raw)) {
    return {
      id: '',
      index,
      errors: [triggerConfigError([], 'trigger.notObject', 'trigger must be an object')],
    }
  }
  const errors: TriggerConfigError[] = []
  const rawId = raw['id']
  const id = typeof rawId === 'string' ? rawId : ''
  if (typeof rawId !== 'string' || !TRIGGER_ID_PATTERN.test(rawId)) {
    errors.push(
      triggerConfigError(
        ['id'],
        'trigger.id.invalid',
        `"id" must match ${TRIGGER_ID_PATTERN_SOURCE}`,
        { pattern: TRIGGER_ID_PATTERN_SOURCE },
      ),
    )
  }

  let name = id
  if (hasOwn(raw, 'name')) {
    const value = raw['name']
    if (isNonEmptyString(value)) name = value.trim()
    else errors.push(nonEmptyStringError(['name']))
  }

  let enabled = false
  if (hasOwn(raw, 'enabled')) {
    const value = raw['enabled']
    if (typeof value === 'boolean') enabled = value
    else errors.push(booleanError(['enabled']))
  }

  let showSession = false
  if (hasOwn(raw, 'showSession')) {
    const value = raw['showSession']
    if (typeof value === 'boolean') showSession = value
    else errors.push(booleanError(['showSession']))
  }

  const sourceResult = parseSource(raw['source'])
  if (!sourceResult.ok) errors.push(...sourceResult.errors)

  const sessionResult = parseSession(hasOwn(raw, 'session') ? raw['session'] : {})
  if (!sessionResult.ok) errors.push(...sessionResult.errors)

  let concurrency: number = TRIGGER_DEFAULTS.concurrency
  if (hasOwn(raw, 'concurrency')) {
    const value = raw['concurrency']
    if (isIntegerInRange(value, TRIGGER_LIMITS.concurrencyMin, TRIGGER_LIMITS.concurrencyMax)) {
      concurrency = value
    } else {
      errors.push(
        integerRangeError(
          ['concurrency'],
          TRIGGER_LIMITS.concurrencyMin,
          TRIGGER_LIMITS.concurrencyMax,
        ),
      )
    }
  }

  let overflow: TriggerOverflow = TRIGGER_DEFAULTS.overflow
  if (hasOwn(raw, 'overflow')) {
    const value = raw['overflow']
    if (value === 'queue' || value === 'drop') overflow = value
    else errors.push(enumError(['overflow'], ['queue', 'drop']))
  }

  if (errors.length > 0 || !sourceResult.ok || !sessionResult.ok) {
    return { id, index, errors }
  }
  return {
    id,
    index,
    errors,
    config: {
      id,
      name,
      enabled,
      showSession,
      source: sourceResult.source,
      session: sessionResult.session,
      concurrency,
      overflow,
    },
  }
}

export function parseTriggersConfig(raw: unknown): ParseTriggersConfigResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: 'triggers.json must contain a JSON object',
      issue: triggerConfigError(
        [],
        'document.notObject',
        'triggers.json must contain a JSON object',
      ),
    }
  }

  if (hasOwn(raw, 'version') && raw['version'] !== 1) {
    return {
      ok: false,
      error: '"version" must be 1',
      issue: triggerConfigError(['version'], 'document.version', '"version" must be 1', {
        expected: 1,
      }),
    }
  }

  const triggersRaw = hasOwn(raw, 'triggers') ? raw['triggers'] : []
  if (!Array.isArray(triggersRaw)) {
    return {
      ok: false,
      error: '"triggers" must be an array',
      issue: triggerConfigError(
        ['triggers'],
        'document.triggersNotArray',
        '"triggers" must be an array',
      ),
    }
  }

  const parsed = triggersRaw.map((entry, index) => parseTrigger(entry, index))
  const counts = new Map<string, number>()
  for (const entry of parsed) {
    if (entry.id.length === 0) continue
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }

  const triggers: TriggerConfig[] = []
  const invalid: InvalidTriggerConfig[] = []
  for (const entry of parsed) {
    const issues = [...entry.errors]
    if (entry.id.length > 0 && (counts.get(entry.id) ?? 0) > 1) {
      issues.push(
        triggerConfigError(['id'], 'trigger.id.duplicate', `duplicate trigger id "${entry.id}"`, {
          id: entry.id,
        }),
      )
    }
    const displayId = entry.id.length > 0 ? entry.id : `#${entry.index}`
    if (issues.length === 0 && entry.config !== undefined) triggers.push(entry.config)
    else invalid.push({ id: displayId, errors: issues.map((issue) => issue.message), issues })
  }

  return { ok: true, config: { version: 1, triggers, invalid } }
}

export function createEmptyTriggersConfig(): TriggersConfig {
  return { version: 1, triggers: [], invalid: [] }
}

/** Result of parsing trigger-file text; `missing` is never returned for text input. */
export type ParsedTriggerConfigText =
  | { readonly kind: 'ok'; readonly value: TriggersConfig }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'invalid'
      readonly error: string
      /** Structured issue when the document parsed but its shape / values are invalid. */
      readonly issue?: TriggerConfigError
      /** 1-based position of a JSON syntax error (absent for shape / value errors). */
      readonly line?: number
      readonly column?: number
    }

/** 1-based line / column of a character offset. */
export function offsetToPosition(
  text: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const limit = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let lineStart = 0
  for (let index = 0; index < limit; index++) {
    if (text.charCodeAt(index) === 10) {
      line++
      lineStart = index + 1
    }
  }
  return { line, column: limit - lineStart + 1 }
}

/**
 * JSONC parse + validation shared by main (local / remote config stores) and the
 * renderer config editor, so both surfaces accept exactly the same shape and
 * report the same errors. Lives here rather than next to the fs adapters because
 * it has no Node dependency.
 */
export function parseTriggersConfigText(text: string): ParsedTriggerConfigText {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body.trim() === '') return { kind: 'ok', value: createEmptyTriggersConfig() }

  const errors: ParseError[] = []
  const raw: unknown = parse(body, errors, { allowTrailingComma: true })
  const firstError = errors[0]
  if (firstError !== undefined) {
    const { line, column } = offsetToPosition(body, firstError.offset)
    return {
      kind: 'invalid',
      error: `${TRIGGERS_WORKSPACE_CONFIG_FILE} is not valid JSON (line ${line}, column ${column})`,
      line,
      column,
    }
  }

  const parsed = parseTriggersConfig(raw)
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error, issue: parsed.issue }
  return { kind: 'ok', value: parsed.config }
}

/**
 * Adds draft-7 `exclusiveMinimum` / `minLength`, which Monaco's JSON service
 * accepts and `IJSONSchema` does not model yet.
 */
type TriggerJSONSchema = Omit<IJSONSchema, 'properties' | 'items' | 'oneOf' | 'anyOf'> & {
  properties?: Record<string, TriggerJSONSchema>
  items?: TriggerJSONSchema
  oneOf?: TriggerJSONSchema[]
  anyOf?: TriggerJSONSchema[]
  exclusiveMinimum?: number
  minLength?: number
}

const SOURCE_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  description: '触发源：四选一，由 type 区分。',
  required: ['type'],
  properties: {
    type: {
      type: 'string',
      enum: ['manual', 'schedule', 'poll', 'event'],
      description:
        'manual = 手动运行；schedule = 定时；poll = 周期性执行命令取数；event = 编辑器推送的事件。',
    },
  },
  oneOf: [
    {
      type: 'object',
      description: '手动触发：只有「Triggers: 立即运行」或其它命令会触发。',
      required: ['type'],
      properties: { type: { type: 'string', enum: ['manual'] } },
      additionalProperties: false,
    },
    {
      type: 'object',
      description: '定时触发：cron 与 everyMin 必须且只能设置一个。',
      required: ['type'],
      oneOf: [{ required: ['cron'] }, { required: ['everyMin'] }],
      properties: {
        type: { type: 'string', enum: ['schedule'] },
        cron: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: '5 字段 cron（分 时 日 月 周），如 "0 9 * * 1"；支持 * , - /。',
        },
        everyMin: {
          type: 'integer',
          minimum: TRIGGER_LIMITS.everyMinMin,
          description: '固定间隔（分钟，整数），与 cron 二选一。',
        },
        onMissed: {
          type: 'string',
          enum: ['skip', 'catch-up-once'],
          default: 'skip',
          description:
            '编辑器关闭期间错过的触发如何处理：skip = 丢弃；catch-up-once = 启动后补跑一次。',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description: '命令轮询：按间隔执行取数命令，用 keyField 去重后逐个触发。',
      required: ['type', 'intervalSec', 'fetch', 'keyField'],
      properties: {
        type: { type: 'string', enum: ['poll'] },
        intervalSec: {
          type: 'integer',
          minimum: TRIGGER_LIMITS.pollIntervalSecMin,
          description: '轮询间隔（秒，整数），至少 30。',
        },
        fetch: {
          type: 'object',
          description:
            '取数命令：在 main 进程执行；stdout 必须是 JSON 数组，或包含 items 数组的对象。',
          required: ['type', 'command'],
          properties: {
            type: { type: 'string', enum: ['command'] },
            command: {
              type: 'string',
              minLength: 1,
              pattern: '\\S',
              description: '要执行的命令行。',
            },
            timeoutSec: {
              type: 'integer',
              minimum: TRIGGER_LIMITS.pollTimeoutSecMin,
              maximum: TRIGGER_LIMITS.pollTimeoutSecMax,
              default: TRIGGER_DEFAULTS.pollTimeoutSec,
              description:
                '命令超时（秒，整数），默认 60；必须小于 intervalSec（运行时校验，避免轮询重叠）。',
            },
          },
          additionalProperties: false,
        },
        keyField: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: '数组元素中用作去重键的字段名，如 "id"。',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description: '编辑器事件源：事件到达时为每个事件触发一次（同一事件键只触发一次）。',
      required: ['type', 'event'],
      properties: {
        type: { type: 'string', enum: ['event'] },
        event: {
          type: 'string',
          enum: [...TRIGGER_EVENT_NAMES],
          description: '事件名。当前支持 swarm.reviewNeedsAction（Swarm 审核待处理）。',
        },
      },
      additionalProperties: false,
    },
  ],
}

const BUDGET_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  description: '单次运行预算：数值字段都必须大于 0；maxCostUsd 写 null 表示不限费用。',
  properties: {
    maxCostUsd: {
      type: ['number', 'null'],
      exclusiveMinimum: 0,
      default: TRIGGER_DEFAULTS.budget.maxCostUsd,
      description: '单次运行费用上限（美元），超出后取消该轮；null 表示不限。',
    },
    timeoutMin: {
      type: 'number',
      exclusiveMinimum: 0,
      default: TRIGGER_DEFAULTS.budget.timeoutMin,
      description: '会话活跃时间上限（分钟）；等待审批/提问的时间不计入。',
    },
    approvalTimeoutMin: {
      type: 'number',
      exclusiveMinimum: 0,
      default: TRIGGER_DEFAULTS.budget.approvalTimeoutMin,
      description: '审批卡等待上限（分钟），超时后取消该轮并记为 approval-timeout。',
    },
  },
  additionalProperties: false,
}

const SESSION_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  description: '会话配置：prompt 与 skill 至少设置一个；没有 skill 时 prompt 不能为空。',
  // Same rule as `parseSession`: a skill alone is enough; otherwise a prompt with
  // at least one non-whitespace character is required. An empty / whitespace prompt
  // next to a skill is accepted (the parser normalizes it to an empty string).
  anyOf: [
    { required: ['skill'] },
    {
      required: ['prompt'],
      properties: { prompt: { type: 'string', minLength: 1, pattern: '\\S' } },
    },
  ],
  properties: {
    agent: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: 'Agent id，缺省使用默认 agent。',
    },
    cwd: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: '相对 workspace 的工作目录，必须位于其下（不允许 ".." 或绝对路径）。',
    },
    mode: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: `显式 mode id；缺省使用该 agent 的保守档。高权限 mode（${ELEVATED_MODE_IDS.join(' / ')}）会在启用确认中单独警告：该模式下 agent 无需逐步批准。`,
    },
    model: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: '模型 id，缺省使用默认模型。',
    },
    skill: {
      type: 'string',
      pattern: TRIGGER_SKILL_PATTERN_SOURCE,
      description: '要调用的 skill 名，作为 prompt 首行的 /skill。',
    },
    prompt: {
      type: 'string',
      description: '提示词模板；可用 {{event.字段}} 引用事件负载中的标量值。',
    },
    mcpServers: {
      type: 'array',
      items: { type: 'string', minLength: 1, pattern: '\\S' },
      description: '创建会话时 pin 的 MCP 服务器名；之后不会随设置变化。',
    },
    budget: BUDGET_SCHEMA,
  },
  additionalProperties: false,
}

const TRIGGER_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  description:
    '单条触发器。未知字段会被运行时解析器忽略（向前兼容），但编辑器会以警告标出，便于发现拼写错误。',
  required: ['id', 'source', 'session'],
  properties: {
    id: {
      type: 'string',
      pattern: TRIGGER_ID_PATTERN_SOURCE,
      description: '唯一 id：小写字母、数字与连字符；在同一工作区的 triggers.json 内唯一。',
    },
    name: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: '显示名称；缺省使用 id。',
    },
    enabled: {
      type: 'boolean',
      default: false,
      description: '是否启用；缺省关闭。未在本机确认的触发器不会运行；修改定义后需要重新确认。',
    },
    showSession: {
      type: 'boolean',
      default: false,
      description:
        '启动会话后自动切到该会话。仅当窗口已可见时生效：后台打开的隐藏窗口、最小化/不可见窗口不会被唤醒或拉到前台。修改它会改变配置指纹，需要重新确认。',
    },
    source: SOURCE_SCHEMA,
    session: SESSION_SCHEMA,
    concurrency: {
      type: 'integer',
      minimum: TRIGGER_LIMITS.concurrencyMin,
      maximum: TRIGGER_LIMITS.concurrencyMax,
      default: TRIGGER_DEFAULTS.concurrency,
      description: '该触发器的并发上限（整数）；缺省 1。',
    },
    overflow: {
      type: 'string',
      enum: ['queue', 'drop'],
      default: TRIGGER_DEFAULTS.overflow,
      description: '并发已满时的处理：queue = 排队（上限 20）；drop = 丢弃该次触发。',
    },
  },
  additionalProperties: false,
}

/**
 * JSON schema for `<workspace>/.universe-editor/triggers.json`. Kept next to the
 * parser so both stay one contract; the manager's parity test runs the same
 * fixtures through this schema and `parseTriggersConfig`.
 */
export const TRIGGERS_SCHEMA: TriggerJSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: {
      type: 'number',
      enum: [1],
      default: 1,
      description: '配置格式版本，当前固定为 1。',
    },
    triggers: {
      type: 'array',
      items: TRIGGER_SCHEMA,
      description: '触发器列表；单个触发器配置非法只影响它自己。',
    },
  },
}

/** File header shared by the example template and the wizard's empty config. */
export const TRIGGERS_CONFIG_HEADER_COMMENT =
  '// Agent 触发器配置（保存在工作区 .universe-editor/ 下，可提交入库；保存后热加载）。'

/** JSONC template written by "Triggers: Open Configuration" when the file does not exist yet. */
export const TRIGGERS_CONFIG_EXAMPLE = `${TRIGGERS_CONFIG_HEADER_COMMENT}
// 触发器只对此工作区生效；所有示例默认关闭（enabled: false）。
{
  "version": 1,
  "triggers": [
    {
      // Swarm 审核分诊：编辑器推送待处理审核事件时触发
      "id": "swarm-triage",
      "name": "Swarm 审核分诊",
      "enabled": false,
      // 运行开始时切到会话（仅在窗口已可见时生效；后台/最小化窗口不会被唤醒）
      "showSession": false,
      "source": { "type": "event", "event": "swarm.reviewNeedsAction" },
      "session": {
        "agent": "claude-code",
        "skill": "swarm-triage",
        "prompt": "处理 Swarm 审核 #{{event.reviewId}}",
        "mcpServers": ["swarm"],
        "budget": { "maxCostUsd": 1, "timeoutMin": 30, "approvalTimeoutMin": 1440 }
      },
      "concurrency": 1,
      "overflow": "queue"
    },
    {
      // 每周一 09:00 生成团队周报
      "id": "weekly-digest",
      "name": "团队周报",
      "enabled": false,
      "source": { "type": "schedule", "cron": "0 9 * * 1", "onMissed": "skip" },
      "session": { "skill": "team-weekly-digest" }
    },
    {
      // 每 10 分钟轮询需求列表（命令需输出 JSON 数组）
      "id": "reqs-watch",
      "name": "需求轮询",
      "enabled": false,
      "source": {
        "type": "poll",
        "intervalSec": 600,
        "fetch": { "type": "command", "command": "node scripts/fetch-reqs.js", "timeoutSec": 60 },
        "keyField": "id"
      },
      "session": { "skill": "req-analyze" }
    }
  ]
}
`
