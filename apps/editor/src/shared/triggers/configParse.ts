/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parser / validator for the user-edited `<userData>/triggers/triggers.json`.
 *  A known field that is present but invalid rejects only that trigger (listed under
 *  `invalid`); unknown fields are ignored.
 *--------------------------------------------------------------------------------------------*/

import { parseCron } from './cron.js'
import {
  ELEVATED_MODE_IDS,
  TRIGGER_ACTION_TYPES,
  TRIGGER_DEFAULTS,
  type InvalidTriggerConfig,
  type TriggerActionType,
  type TriggerBudget,
  type TriggerConfig,
  type TriggerOnMissed,
  type TriggerOverflow,
  type TriggerSessionConfig,
  type TriggerSourceConfig,
  type TriggersConfig,
} from './types.js'
import { isSafeRelativePath } from './verdict.js'

export type ParseTriggersConfigResult =
  | { readonly ok: true; readonly config: TriggersConfig }
  | { readonly ok: false; readonly error: string }

const TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/

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

interface ParseErrors {
  readonly ok: false
  readonly errors: readonly string[]
}

type SourceParseResult = { readonly ok: true; readonly source: TriggerSourceConfig } | ParseErrors

function parseScheduleSource(raw: Record<string, unknown>): SourceParseResult {
  const errors: string[] = []
  const hasCron = hasOwn(raw, 'cron')
  const hasEveryMin = hasOwn(raw, 'everyMin')
  if (hasCron === hasEveryMin) {
    errors.push('"source" must set exactly one of "cron" / "everyMin"')
  }

  let cron: string | undefined
  if (hasCron) {
    const value = raw['cron']
    if (typeof value !== 'string') {
      errors.push('"source.cron" must be a string')
    } else {
      const parsed = parseCron(value)
      if (parsed.ok) cron = value
      else errors.push(`"source.cron" is invalid: ${parsed.error}`)
    }
  }

  let everyMin: number | undefined
  if (hasEveryMin) {
    const value = raw['everyMin']
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) everyMin = value
    else errors.push('"source.everyMin" must be an integer >= 1')
  }

  let onMissed: TriggerOnMissed = 'skip'
  if (hasOwn(raw, 'onMissed')) {
    const value = raw['onMissed']
    if (value === 'skip' || value === 'catch-up-once') onMissed = value
    else errors.push('"source.onMissed" must be "skip" or "catch-up-once"')
  }

  if (errors.length > 0) return { ok: false, errors }
  if (cron !== undefined) return { ok: true, source: { type: 'schedule', cron, onMissed } }
  if (everyMin !== undefined) return { ok: true, source: { type: 'schedule', everyMin, onMissed } }
  return { ok: false, errors: ['"source" must set exactly one of "cron" / "everyMin"'] }
}

function parsePollSource(raw: Record<string, unknown>): SourceParseResult {
  const errors: string[] = []

  let intervalSec = 0
  const intervalRaw = raw['intervalSec']
  if (typeof intervalRaw === 'number' && Number.isInteger(intervalRaw) && intervalRaw >= 30) {
    intervalSec = intervalRaw
  } else {
    errors.push('"source.intervalSec" must be an integer >= 30')
  }

  let keyField = ''
  const keyFieldRaw = raw['keyField']
  if (isNonEmptyString(keyFieldRaw)) keyField = keyFieldRaw.trim()
  else errors.push('"source.keyField" must be a non-empty string')

  let command = ''
  let timeoutSec: number = TRIGGER_DEFAULTS.pollTimeoutSec
  const fetchRaw = raw['fetch']
  if (!isRecord(fetchRaw)) {
    errors.push('"source.fetch" must be an object')
  } else {
    if (fetchRaw['type'] !== 'command') errors.push('"source.fetch.type" must be "command"')
    const commandRaw = fetchRaw['command']
    if (isNonEmptyString(commandRaw)) command = commandRaw.trim()
    else errors.push('"source.fetch.command" must be a non-empty string')
    if (hasOwn(fetchRaw, 'timeoutSec')) {
      const value = fetchRaw['timeoutSec']
      if (isIntegerInRange(value, 1, 600)) timeoutSec = value
      else errors.push('"source.fetch.timeoutSec" must be an integer between 1 and 600')
    }
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

function parseSource(raw: unknown): SourceParseResult {
  if (!isRecord(raw)) return { ok: false, errors: ['"source" must be an object'] }
  switch (raw['type']) {
    case 'manual':
      return { ok: true, source: { type: 'manual' } }
    case 'swarm-review':
      return { ok: true, source: { type: 'swarm-review' } }
    case 'schedule':
      return parseScheduleSource(raw)
    case 'poll':
      return parsePollSource(raw)
    default:
      return {
        ok: false,
        errors: ['"source.type" must be one of "manual" | "schedule" | "poll" | "swarm-review"'],
      }
  }
}

function parseBudget(raw: unknown, errors: string[]): TriggerBudget {
  const values: { maxCostUsd: number; timeoutMin: number; approvalTimeoutMin: number } = {
    ...TRIGGER_DEFAULTS.budget,
  }
  if (!isRecord(raw)) {
    errors.push('"session.budget" must be an object')
    return values
  }
  const fields = ['maxCostUsd', 'timeoutMin', 'approvalTimeoutMin'] as const
  for (const field of fields) {
    if (!hasOwn(raw, field)) continue
    const value = raw[field]
    if (isPositiveNumber(value)) values[field] = value
    else errors.push(`"session.budget.${field}" must be a positive number`)
  }
  return values
}

function parseSession(
  raw: unknown,
): { readonly ok: true; readonly session: TriggerSessionConfig } | ParseErrors {
  if (!isRecord(raw)) return { ok: false, errors: ['"session" must be an object'] }
  const errors: string[] = []

  const optionalString = (key: string): string | undefined => {
    if (!hasOwn(raw, key)) return undefined
    const value = raw[key]
    if (isNonEmptyString(value)) return value.trim()
    errors.push(`"session.${key}" must be a non-empty string`)
    return undefined
  }

  const agent = optionalString('agent')
  const mode = optionalString('mode')
  const model = optionalString('model')

  let cwd: string | undefined
  if (hasOwn(raw, 'cwd')) {
    const value = raw['cwd']
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push('"session.cwd" must be a non-empty string')
    } else if (!isSafeRelativePath(value)) {
      errors.push('"session.cwd" must be a relative path inside the workspace (no "..")')
    } else {
      cwd = value.trim()
    }
  }

  let skill: string | undefined
  if (hasOwn(raw, 'skill')) {
    const value = raw['skill']
    if (typeof value === 'string' && SKILL_PATTERN.test(value)) skill = value
    else errors.push('"session.skill" must match ^[A-Za-z0-9][A-Za-z0-9:_-]*$')
  }

  let prompt = ''
  if (hasOwn(raw, 'prompt')) {
    const value = raw['prompt']
    if (typeof value === 'string') prompt = value
    else errors.push('"session.prompt" must be a string')
  }
  if (skill === undefined && prompt.trim().length === 0) {
    errors.push('"session" must set "skill" or a non-empty "prompt"')
  }

  let mcpServers: string[] | undefined
  if (hasOwn(raw, 'mcpServers')) {
    const value = raw['mcpServers']
    if (!Array.isArray(value)) {
      errors.push('"session.mcpServers" must be an array of strings')
    } else {
      mcpServers = []
      for (const entry of value) {
        if (isNonEmptyString(entry)) mcpServers.push(entry.trim())
        else errors.push('"session.mcpServers" must be an array of strings')
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

function parseAllowedActions(raw: unknown, errors: string[]): TriggerActionType[] {
  if (!Array.isArray(raw)) {
    errors.push('"allowedActions" must be an array')
    return []
  }
  const actions: TriggerActionType[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !TRIGGER_ACTION_TYPES.includes(entry as TriggerActionType)) {
      errors.push(`"allowedActions" contains unknown action "${String(entry)}"`)
      continue
    }
    const action = entry as TriggerActionType
    if (!actions.includes(action)) actions.push(action)
  }
  return actions
}

interface ParsedTrigger {
  readonly id: string
  readonly index: number
  readonly errors: readonly string[]
  readonly config?: TriggerConfig
}

function parseTrigger(raw: unknown, index: number): ParsedTrigger {
  if (!isRecord(raw)) {
    return { id: '', index, errors: ['trigger must be an object'] }
  }
  const errors: string[] = []
  const rawId = raw['id']
  const id = typeof rawId === 'string' ? rawId : ''
  if (typeof rawId !== 'string' || !TRIGGER_ID_PATTERN.test(rawId)) {
    errors.push('"id" must match ^[a-z0-9][a-z0-9-]{0,63}$')
  }

  let name = id
  if (hasOwn(raw, 'name')) {
    const value = raw['name']
    if (isNonEmptyString(value)) name = value.trim()
    else errors.push('"name" must be a non-empty string')
  }

  let enabled = false
  if (hasOwn(raw, 'enabled')) {
    const value = raw['enabled']
    if (typeof value === 'boolean') enabled = value
    else errors.push('"enabled" must be a boolean')
  }

  let workspace = ''
  const workspaceRaw = raw['workspace']
  if (!isNonEmptyString(workspaceRaw)) {
    errors.push('"workspace" must be a non-empty string')
  } else if (!isAbsoluteLocalPath(workspaceRaw)) {
    errors.push('"workspace" must be an absolute local folder path')
  } else {
    workspace = workspaceRaw.trim()
  }

  const sourceResult = parseSource(raw['source'])
  if (!sourceResult.ok) errors.push(...sourceResult.errors)

  const sessionResult = parseSession(hasOwn(raw, 'session') ? raw['session'] : {})
  if (!sessionResult.ok) errors.push(...sessionResult.errors)

  let allowedActions: TriggerActionType[] = []
  if (hasOwn(raw, 'allowedActions')) {
    allowedActions = parseAllowedActions(raw['allowedActions'], errors)
  }

  let concurrency: number = TRIGGER_DEFAULTS.concurrency
  if (hasOwn(raw, 'concurrency')) {
    const value = raw['concurrency']
    if (isIntegerInRange(value, 1, 10)) concurrency = value
    else errors.push('"concurrency" must be an integer between 1 and 10')
  }

  let overflow: TriggerOverflow = TRIGGER_DEFAULTS.overflow
  if (hasOwn(raw, 'overflow')) {
    const value = raw['overflow']
    if (value === 'queue' || value === 'drop') overflow = value
    else errors.push('"overflow" must be "queue" or "drop"')
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
      workspace,
      source: sourceResult.source,
      session: sessionResult.session,
      allowedActions,
      concurrency,
      overflow,
    },
  }
}

export function parseTriggersConfig(raw: unknown): ParseTriggersConfigResult {
  if (!isRecord(raw)) return { ok: false, error: 'triggers.json must contain a JSON object' }

  if (hasOwn(raw, 'version') && raw['version'] !== 1) {
    return { ok: false, error: '"version" must be 1' }
  }

  let maxConcurrentRuns: number = TRIGGER_DEFAULTS.maxConcurrentRuns
  if (hasOwn(raw, 'maxConcurrentRuns')) {
    const value = raw['maxConcurrentRuns']
    if (isIntegerInRange(value, 1, 10)) maxConcurrentRuns = value
    else return { ok: false, error: '"maxConcurrentRuns" must be an integer between 1 and 10' }
  }

  const triggersRaw = hasOwn(raw, 'triggers') ? raw['triggers'] : []
  if (!Array.isArray(triggersRaw)) return { ok: false, error: '"triggers" must be an array' }

  const parsed = triggersRaw.map((entry, index) => parseTrigger(entry, index))
  const counts = new Map<string, number>()
  for (const entry of parsed) {
    if (entry.id.length === 0) continue
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }

  const triggers: TriggerConfig[] = []
  const invalid: InvalidTriggerConfig[] = []
  for (const entry of parsed) {
    const errors = [...entry.errors]
    if (entry.id.length > 0 && (counts.get(entry.id) ?? 0) > 1) {
      errors.push(`duplicate trigger id "${entry.id}"`)
    }
    const displayId = entry.id.length > 0 ? entry.id : `#${entry.index}`
    if (errors.length === 0 && entry.config !== undefined) triggers.push(entry.config)
    else invalid.push({ id: displayId, errors })
  }

  return { ok: true, config: { version: 1, maxConcurrentRuns, triggers, invalid } }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key])
    return sorted
  }
  return value
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Stable fingerprint of the canonical (key-order independent) trigger JSON. */
export function triggerFingerprint(trigger: TriggerConfig): string {
  return fnv1a32(JSON.stringify(canonicalize(trigger)))
}

export function isElevatedMode(mode?: string): boolean {
  return mode !== undefined && ELEVATED_MODE_IDS.includes(mode)
}

/** JSONC template written by "Triggers: 打开配置" when the file does not exist yet. */
export const TRIGGERS_CONFIG_EXAMPLE = `// Agent 触发器配置（保存后热加载）。
// workspace 必须是本机绝对路径；所有示例默认关闭（enabled: false）。
{
  "version": 1,
  "maxConcurrentRuns": 2,
  "triggers": [
    {
      // Swarm 审核分诊：每个待处理审核触发一次
      "id": "swarm-review",
      "name": "Swarm 审核分诊",
      "enabled": false,
      "workspace": "X:/workspace",
      "source": { "type": "swarm-review" },
      "session": {
        "agent": "claude-code",
        "skill": "swarm-triage",
        "prompt": "处理 Swarm 审核 #{{event.reviewId}}",
        "mcpServers": ["swarm"],
        "budget": { "maxCostUsd": 1, "timeoutMin": 30, "approvalTimeoutMin": 1440 }
      },
      "allowedActions": ["swarm.vote", "swarm.comment"],
      "concurrency": 1,
      "overflow": "queue"
    },
    {
      // 每周一 09:00 生成团队周报
      "id": "weekly-digest",
      "name": "团队周报",
      "enabled": false,
      "workspace": "X:/workspace",
      "source": { "type": "schedule", "cron": "0 9 * * 1", "onMissed": "skip" },
      "session": { "skill": "team-weekly-digest" }
    },
    {
      // 每 10 分钟轮询需求列表（命令需输出 JSON 数组）
      "id": "reqs-watch",
      "name": "需求轮询",
      "enabled": false,
      "workspace": "X:/workspace",
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
