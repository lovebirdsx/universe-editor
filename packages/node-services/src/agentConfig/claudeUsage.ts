/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Claude API usage fetch core — reads the credentials from the shared Claude
 *  settings file (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`)
 *  and queries the provider's usage endpoint. Shared by the local editor main and
 *  the remote server daemon so a remote workspace reports usage for the remote
 *  host (remote settings + remote network). Monetary values are kept at the
 *  provider's raw integer scale; the renderer formats them.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import * as https from 'node:https'
import * as http from 'node:http'
import { createNamedLogger, type ILogChannel, type ILogger } from '@universe-editor/platform'
import { defaultClaudeSettingsPath } from './claudeConfigStore.js'
import type { ClaudeSettings, UsageResult, UsageSnapshot } from './types.js'

interface RawModelUsage {
  model: string
  requests: number
  raw_tokens: number
  cost_cny: number
}

interface RawUsageData {
  date: string
  requests: number
  raw_tokens: number
  models: RawModelUsage[]
  period_bucket: string
  period_limit_cny: number
  period_used_cny: number
  period_remaining_cny: number
}

const AUTH_TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL'
const REQUEST_TIMEOUT_MS = 10_000

export interface ClaudeUsageCredentials {
  readonly apiKey: string
  readonly baseUrl: string
}

/** Extract the two usage credentials from a parsed settings object; undefined when either is missing. */
export function usageCredentialsFrom(settings: ClaudeSettings): ClaudeUsageCredentials | undefined {
  const env = settings.env
  if (!env) return undefined
  const apiKey = env[AUTH_TOKEN_KEY]
  const baseUrl = env[BASE_URL_KEY]
  if (!apiKey || !baseUrl) return undefined
  return { apiKey, baseUrl }
}

/**
 * Fetch today's Claude API usage. Reads `settingsPath` (defaults to the shared
 * Claude settings file) for the credentials, then GETs the provider's usage
 * endpoint. Missing file / malformed JSON / missing credentials all resolve to
 * `{ kind: 'disabled' }`; a failed request resolves to `{ kind: 'error' }`.
 */
export async function fetchClaudeUsage(
  settingsPath: string = defaultClaudeSettingsPath(),
  logger?: { createLogger(channel: ILogChannel): ILogger },
): Promise<UsageResult> {
  const log = createNamedLogger(logger, { id: 'usage', name: 'Usage' })
  let raw: string
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch {
    return { kind: 'disabled', reason: `settings.json not found at ${settingsPath}` }
  }
  let settings: ClaudeSettings
  try {
    const parsed = JSON.parse(raw) as unknown
    settings = parsed && typeof parsed === 'object' ? (parsed as ClaudeSettings) : {}
  } catch {
    return { kind: 'disabled', reason: 'settings.json is not valid JSON' }
  }
  const creds = usageCredentialsFrom(settings)
  if (!creds) {
    return {
      kind: 'disabled',
      reason: `${AUTH_TOKEN_KEY} / ${BASE_URL_KEY} not configured in settings.env`,
    }
  }
  try {
    const base = creds.baseUrl.replace(/\/$/, '')
    const date = getDateStr()
    const url = `${base}/my-usage/api/detail?date=${date}&api_key=${creds.apiKey}`
    const body = await fetchUrl(url)
    const data = JSON.parse(body) as RawUsageData
    return { kind: 'ok', snapshot: toSnapshot(data) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`usage fetch failed: ${message}`)
    return { kind: 'error', message }
  }
}

// 用量接口在未产生消费时会省略字段或返回 null/字符串，数值一律收敛为有限数，避免渲染 NaN
function toFiniteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export function toSnapshot(data: RawUsageData): UsageSnapshot {
  return {
    date: data.date,
    periodBucket: data.period_bucket,
    periodUsedCny: toFiniteNumber(data.period_used_cny),
    periodLimitCny: toFiniteNumber(data.period_limit_cny),
    periodRemainingCny: toFiniteNumber(data.period_remaining_cny),
    requests: toFiniteNumber(data.requests),
    rawTokens: toFiniteNumber(data.raw_tokens),
    models: (data.models ?? []).map((m) => ({
      model: m.model,
      requests: toFiniteNumber(m.requests),
      rawTokens: toFiniteNumber(m.raw_tokens),
      costCny: toFiniteNumber(m.cost_cny),
    })),
  }
}

function getDateStr(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`))
        } else {
          resolve(data)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('request timed out')))
  })
}
