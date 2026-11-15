import { describe, expect, it } from 'vitest'
import { parseTriggersConfig, TRIGGERS_SCHEMA } from '../configParse.js'
import type { TriggerConfigError } from '../types.js'

/**
 * Both `TRIGGERS_SCHEMA` (Monaco validation) and `parseTriggersConfig` (the hard
 * gate) must reach the same verdict for the same definition. This file runs the
 * same fixtures through a minimal draft-7 validator and the parser.
 *
 * Deliberate differences, asserted at the bottom:
 * - unknown fields: schema reports a warning (typo detection), parser ignores them
 *   (forward compatibility);
 * - rules draft-7 cannot express: cron semantics, cwd path safety, poll
 *   `timeoutSec < intervalSec`, duplicate ids across entries.
 */

interface JsonSchemaNode {
  readonly type?: string | readonly string[]
  readonly required?: readonly string[]
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>
  readonly additionalProperties?: boolean
  readonly items?: JsonSchemaNode
  readonly enum?: readonly unknown[]
  readonly minimum?: number
  readonly maximum?: number
  readonly exclusiveMinimum?: number
  readonly minLength?: number
  readonly pattern?: string
  readonly oneOf?: readonly JsonSchemaNode[]
  readonly anyOf?: readonly JsonSchemaNode[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      throw new Error(`unsupported schema type: ${type}`)
  }
}

interface ValidationOutput {
  readonly errors: string[]
  readonly warnings: string[]
}

/**
 * `additionalProperties: false` is recorded as a warning, not an error: Monaco's
 * JSON service is configured with `schemaValidation: 'warning'`, and the parser
 * accepts unknown fields. Everything else follows draft-7 semantics for the
 * subset used by `TRIGGERS_SCHEMA`.
 */
function check(
  value: unknown,
  schema: JsonSchemaNode,
  path: string,
  output: ValidationOutput,
): boolean {
  let valid = true
  const fail = (message: string): void => {
    output.errors.push(`${path === '' ? '<root>' : path}: ${message}`)
    valid = false
  }

  if (schema.type !== undefined) {
    const types = typeof schema.type === 'string' ? [schema.type] : schema.type
    if (!types.some((type) => matchesType(value, type))) {
      fail(`expected ${types.join(' | ')}, got ${JSON.stringify(value)}`)
      return valid
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((entry) => Object.is(entry, value))) {
    fail(`expected one of ${JSON.stringify(schema.enum)}`)
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(`length ${value.length} < ${schema.minLength}`)
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      fail(`does not match ${schema.pattern}`)
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`${value} < ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(`${value} > ${schema.maximum}`)
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      fail(`${value} <= ${schema.exclusiveMinimum}`)
    }
  }

  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`missing required property "${key}"`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && !check(value[key], child, `${path}.${key}`, output)) {
        valid = false
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          output.warnings.push(`${path}: unknown property "${key}"`)
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => {
      if (!check(entry, schema.items as JsonSchemaNode, `${path}[${index}]`, output)) {
        valid = false
      }
    })
  }

  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => isValid(value, branch))
    if (matches.length !== 1) fail(`oneOf matched ${matches.length} branches`)
  }
  if (schema.anyOf !== undefined) {
    const matches = schema.anyOf.filter((branch) => isValid(value, branch))
    if (matches.length === 0) fail('anyOf matched no branch')
  }

  return valid
}

function isValid(value: unknown, schema: JsonSchemaNode): boolean {
  return check(value, schema, '', { errors: [], warnings: [] })
}

const rootSchema = TRIGGERS_SCHEMA as unknown as JsonSchemaNode
const triggerSchema = rootSchema.properties?.['triggers']?.items
if (triggerSchema === undefined) throw new Error('TRIGGERS_SCHEMA must define triggers.items')

function validateTrigger(raw: unknown): ValidationOutput {
  const output: ValidationOutput = { errors: [], warnings: [] }
  check(raw, triggerSchema as JsonSchemaNode, 'triggers[0]', output)
  return output
}

function validateDocument(raw: unknown): ValidationOutput {
  const output: ValidationOutput = { errors: [], warnings: [] }
  check(raw, rootSchema, '', output)
  return output
}

function parserIssues(raw: unknown): readonly TriggerConfigError[] {
  const result = parseTriggersConfig({ version: 1, triggers: [raw] })
  if (!result.ok) {
    return [result.issue]
  }
  return result.config.invalid[0]?.issues ?? []
}

function parserAccepts(raw: unknown): boolean {
  const result = parseTriggersConfig({ version: 1, triggers: [raw] })
  return result.ok && result.config.triggers.length === 1 && result.config.invalid.length === 0
}

const baseTrigger = (): Record<string, unknown> => ({
  id: 't1',
  source: { type: 'manual' },
  session: { prompt: 'go' },
})

const trigger = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...baseTrigger(),
  ...overrides,
})

const validTriggers: readonly { readonly name: string; readonly raw: unknown }[] = [
  { name: 'minimal manual trigger', raw: baseTrigger() },
  {
    name: 'every optional field',
    raw: trigger({
      name: 'Nightly',
      enabled: true,
      showSession: true,
      concurrency: 10,
      overflow: 'drop',
      session: {
        agent: 'claude-code',
        mode: 'default',
        model: 'sonnet',
        skill: 'team:weekly-1',
        prompt: 'hello',
        mcpServers: ['swarm'],
        budget: { maxCostUsd: 1.5, timeoutMin: 30, approvalTimeoutMin: 1440 },
      },
    }),
  },
  {
    name: 'schedule with cron',
    raw: trigger({ source: { type: 'schedule', cron: '0 9 * * 1', onMissed: 'catch-up-once' } }),
  },
  { name: 'schedule with everyMin', raw: trigger({ source: { type: 'schedule', everyMin: 15 } }) },
  {
    name: 'poll whose timeout is shorter than the interval',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 60 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll at the 30s floor with a 29s timeout',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 30,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 29 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'event source',
    raw: trigger({ source: { type: 'event', event: 'swarm.reviewNeedsAction' } }),
  },
  { name: 'skill without prompt', raw: trigger({ session: { skill: 'triage' } }) },
  {
    name: 'skill with an empty prompt',
    raw: trigger({ session: { skill: 'triage', prompt: '' } }),
  },
  { name: 'whitespace around the prompt', raw: trigger({ session: { prompt: ' go ' } }) },
  { name: 'whitespace around the name', raw: trigger({ name: ' Nightly ' }) },
  {
    name: 'unlimited max cost',
    raw: trigger({ session: { prompt: 'go', budget: { maxCostUsd: null } } }),
  },
  {
    name: 'whitespace around mcp server names',
    raw: trigger({ session: { prompt: 'go', mcpServers: [' swarm '] } }),
  },
]

const invalidTriggers: readonly { readonly name: string; readonly raw: unknown }[] = [
  { name: 'non-object trigger (number)', raw: 42 },
  { name: 'non-object trigger (null)', raw: null },
  { name: 'non-object trigger (array)', raw: [] },
  { name: 'missing id', raw: { source: { type: 'manual' }, session: { prompt: 'go' } } },
  { name: 'uppercase id', raw: trigger({ id: 'Bad' }) },
  { name: 'leading-hyphen id', raw: trigger({ id: '-bad' }) },
  { name: 'too-long id', raw: trigger({ id: 'a'.repeat(65) }) },
  { name: 'numeric id', raw: trigger({ id: 42 }) },
  { name: 'numeric name', raw: trigger({ name: 1 }) },
  { name: 'empty name', raw: trigger({ name: '' }) },
  { name: 'whitespace-only name', raw: trigger({ name: '   ' }) },
  { name: 'non-boolean enabled', raw: trigger({ enabled: 'yes' }) },
  { name: 'numeric showSession', raw: trigger({ showSession: 1 }) },
  { name: 'concurrency below the minimum', raw: trigger({ concurrency: 0 }) },
  { name: 'concurrency above the maximum', raw: trigger({ concurrency: 11 }) },
  { name: 'fractional concurrency', raw: trigger({ concurrency: 1.5 }) },
  { name: 'unknown overflow', raw: trigger({ overflow: 'drop-oldest' }) },
  { name: 'missing source', raw: { id: 't1', session: { prompt: 'go' } } },
  { name: 'string source', raw: trigger({ source: 'manual' }) },
  { name: 'unknown source type', raw: trigger({ source: { type: 'webhook' } }) },
  { name: 'numeric source type', raw: trigger({ source: { type: 42 } }) },
  { name: 'schedule without cron or everyMin', raw: trigger({ source: { type: 'schedule' } }) },
  {
    name: 'schedule with both cron and everyMin',
    raw: trigger({ source: { type: 'schedule', cron: '0 9 * * *', everyMin: 60 } }),
  },
  { name: 'everyMin zero', raw: trigger({ source: { type: 'schedule', everyMin: 0 } }) },
  { name: 'fractional everyMin', raw: trigger({ source: { type: 'schedule', everyMin: 2.5 } }) },
  {
    name: 'string everyMin',
    raw: trigger({ source: { type: 'schedule', everyMin: '15' } }),
  },
  {
    name: 'unknown onMissed',
    raw: trigger({ source: { type: 'schedule', cron: '0 9 * * *', onMissed: 'later' } }),
  },
  {
    name: 'empty cron',
    raw: trigger({ source: { type: 'schedule', cron: '' } }),
  },
  {
    name: 'whitespace-only cron',
    raw: trigger({ source: { type: 'schedule', cron: '   ' } }),
  },
  {
    name: 'numeric cron',
    raw: trigger({ source: { type: 'schedule', cron: 42 } }),
  },
  { name: 'event without event name', raw: trigger({ source: { type: 'event' } }) },
  {
    name: 'unknown event name',
    raw: trigger({ source: { type: 'event', event: 'swarm.reviewDeleted' } }),
  },
  { name: 'numeric event name', raw: trigger({ source: { type: 'event', event: 42 } }) },
  {
    name: 'poll without fetch',
    raw: trigger({ source: { type: 'poll', intervalSec: 600, keyField: 'id' } }),
  },
  {
    name: 'poll below the interval floor',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 29,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 1 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll with a fractional interval',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600.5,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 1 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll with an empty fetch object',
    raw: trigger({
      source: { type: 'poll', intervalSec: 600, fetch: {}, keyField: 'id' },
    }),
  },
  {
    name: 'poll with an unknown fetch type',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'http', command: 'x' },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll with an empty command',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: '', timeoutSec: 1 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll with a whitespace-only command',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: '   ', timeoutSec: 1 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll timeout zero',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 0 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll timeout above the maximum',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 601 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll with a fractional timeout',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 1.5 },
        keyField: 'id',
      },
    }),
  },
  {
    name: 'poll without keyField',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 1 },
      },
    }),
  },
  {
    name: 'poll with an empty keyField',
    raw: trigger({
      source: {
        type: 'poll',
        intervalSec: 600,
        fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 1 },
        keyField: '',
      },
    }),
  },
  { name: 'missing session', raw: { id: 't1', source: { type: 'manual' } } },
  { name: 'null session', raw: trigger({ session: null }) },
  { name: 'string session', raw: trigger({ session: 'prompt' }) },
  { name: 'empty session', raw: trigger({ session: {} }) },
  { name: 'empty prompt without skill', raw: trigger({ session: { prompt: '' } }) },
  { name: 'whitespace-only prompt without skill', raw: trigger({ session: { prompt: '   ' } }) },
  { name: 'numeric prompt', raw: trigger({ session: { prompt: 42 } }) },
  { name: 'leading-hyphen skill', raw: trigger({ session: { skill: '-bad' } }) },
  { name: 'skill with a space', raw: trigger({ session: { skill: 'has space' } }) },
  { name: 'numeric skill', raw: trigger({ session: { skill: 42 } }) },
  { name: 'empty agent', raw: trigger({ session: { prompt: 'go', agent: '' } }) },
  { name: 'numeric agent', raw: trigger({ session: { prompt: 'go', agent: 1 } }) },
  { name: 'empty cwd', raw: trigger({ session: { prompt: 'go', cwd: '' } }) },
  { name: 'numeric cwd', raw: trigger({ session: { prompt: 'go', cwd: 5 } }) },
  { name: 'numeric mode', raw: trigger({ session: { prompt: 'go', mode: 1 } }) },
  { name: 'numeric model', raw: trigger({ session: { prompt: 'go', model: 1 } }) },
  { name: 'string mcpServers', raw: trigger({ session: { prompt: 'go', mcpServers: 'swarm' } }) },
  {
    name: 'non-string mcpServers entry',
    raw: trigger({ session: { prompt: 'go', mcpServers: ['swarm', 1] } }),
  },
  {
    name: 'empty mcpServers entry',
    raw: trigger({ session: { prompt: 'go', mcpServers: [''] } }),
  },
  {
    name: 'whitespace-only mcpServers entry',
    raw: trigger({ session: { prompt: 'go', mcpServers: ['  '] } }),
  },
  { name: 'null budget', raw: trigger({ session: { prompt: 'go', budget: null } }) },
  {
    name: 'zero max cost',
    raw: trigger({ session: { prompt: 'go', budget: { maxCostUsd: 0 } } }),
  },
  {
    name: 'negative max cost',
    raw: trigger({ session: { prompt: 'go', budget: { maxCostUsd: -1 } } }),
  },
  {
    name: 'zero timeoutMin',
    raw: trigger({ session: { prompt: 'go', budget: { timeoutMin: 0 } } }),
  },
  {
    name: 'negative approvalTimeoutMin',
    raw: trigger({ session: { prompt: 'go', budget: { approvalTimeoutMin: -1 } } }),
  },
  {
    name: 'string timeoutMin',
    raw: trigger({ session: { prompt: 'go', budget: { timeoutMin: '30' } } }),
  },
]

describe('TRIGGERS_SCHEMA / parseTriggersConfig parity (valid fixtures)', () => {
  it.each(validTriggers)('$name', ({ raw }) => {
    expect(validateTrigger(raw).errors).toEqual([])
    expect(parserAccepts(raw)).toBe(true)
  })
})

describe('TRIGGERS_SCHEMA / parseTriggersConfig parity (invalid fixtures)', () => {
  it.each(invalidTriggers)('$name', ({ raw }) => {
    expect(validateTrigger(raw).errors.length).toBeGreaterThan(0)
    expect(parserIssues(raw).length).toBeGreaterThan(0)
  })
})

describe('TRIGGERS_SCHEMA / parseTriggersConfig parity (document shape)', () => {
  const invalidDocuments: readonly unknown[] = [
    null,
    [],
    'x',
    42,
    { version: 2, triggers: [] },
    { version: '1', triggers: [] },
    { version: null, triggers: [] },
    { triggers: {} },
    { triggers: 'x' },
  ]

  it.each(invalidDocuments.map((raw) => ({ raw, name: JSON.stringify(raw) })))(
    'rejects $name',
    ({ raw }) => {
      expect(validateDocument(raw).errors.length).toBeGreaterThan(0)
      expect(parseTriggersConfig(raw).ok).toBe(false)
    },
  )

  it('accepts an empty document and a valid document', () => {
    for (const raw of [{}, { triggers: [] }, { version: 1, triggers: [baseTrigger()] }]) {
      expect(validateDocument(raw).errors).toEqual([])
      expect(parseTriggersConfig(raw).ok).toBe(true)
    }
  })
})

describe('documented differences between schema and parser', () => {
  it('treats unknown fields as a schema warning and lets the parser ignore them', () => {
    const raw = trigger({ unknownField: true, session: { prompt: 'go', extra: 1 } })
    const result = validateTrigger(raw)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'triggers[0]: unknown property "unknownField"',
        'triggers[0].session: unknown property "extra"',
      ]),
    )
    expect(parserAccepts(raw)).toBe(true)
  })

  it('documents parser-only rules a draft-7 schema cannot express', () => {
    const cases: readonly {
      readonly name: string
      readonly raw: unknown
      readonly code: string
    }[] = [
      {
        name: 'cron field range',
        raw: trigger({ source: { type: 'schedule', cron: '0 25 * * *' } }),
        code: 'source.cron.invalid',
      },
      {
        name: 'poll default timeout exceeds a 30s interval',
        raw: trigger({
          source: {
            type: 'poll',
            intervalSec: 30,
            fetch: { type: 'command', command: 'node fetch.js' },
            keyField: 'id',
          },
        }),
        code: 'source.poll.timeoutNotLessThanInterval',
      },
      {
        name: 'poll timeout equal to the interval',
        raw: trigger({
          source: {
            type: 'poll',
            intervalSec: 60,
            fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 60 },
            keyField: 'id',
          },
        }),
        code: 'source.poll.timeoutNotLessThanInterval',
      },
      {
        name: 'cwd escaping the workspace',
        raw: trigger({ session: { prompt: 'go', cwd: '../escape' } }),
        code: 'session.cwd.invalid',
      },
      {
        name: 'absolute cwd',
        raw: trigger({ session: { prompt: 'go', cwd: '/abs' } }),
        code: 'session.cwd.invalid',
      },
      {
        name: 'drive-letter cwd',
        raw: trigger({ session: { prompt: 'go', cwd: 'C:/abs' } }),
        code: 'session.cwd.invalid',
      },
      {
        name: 'UNC cwd',
        raw: trigger({ session: { prompt: 'go', cwd: '\\\\server\\share' } }),
        code: 'session.cwd.invalid',
      },
    ]
    for (const { name, raw, code } of cases) {
      expect(validateTrigger(raw).errors, name).toEqual([])
      expect(
        parserIssues(raw).map((issue) => issue.code),
        name,
      ).toContain(code)
    }
  })

  it('rejects duplicate ids in the parser only (cross-entry rule)', () => {
    const raw = { version: 1, triggers: [baseTrigger(), baseTrigger()] }
    expect(validateDocument(raw).errors).toEqual([])
    const parsed = parseTriggersConfig(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.config.invalid).toHaveLength(2)
    expect(parsed.config.invalid[0]?.issues.map((issue) => issue.code)).toContain(
      'trigger.id.duplicate',
    )
  })
})
