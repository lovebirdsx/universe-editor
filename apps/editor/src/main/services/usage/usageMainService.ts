/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads the API credentials from ~/.claude/settings.json and queries the
 *  provider's usage endpoint. Logic ported from scripts/usage.ts. Monetary values
 *  are kept at the provider's raw integer scale; the renderer formats them.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as https from 'node:https'
import * as http from 'node:http'
import {
  Disposable,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type { IUsageService, UsageResult, UsageSnapshot } from '../../../shared/ipc/services.js'

interface RawSettings {
  env?: Record<string, string>
}

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

export class UsageMainService extends Disposable implements IUsageService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    private readonly _settingsPath: string = join(homedir(), '.claude', 'settings.json'),
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'usage', name: 'Usage' })
  }

  async getUsage(): Promise<UsageResult> {
    const creds = await this._loadCredentials()
    if (creds.kind !== 'ok') return creds
    try {
      const base = creds.baseUrl.replace(/\/$/, '')
      const date = getDateStr()
      const url = `${base}/my-usage/api/detail?date=${date}&api_key=${creds.apiKey}`
      const raw = await fetchUrl(url)
      const data = JSON.parse(raw) as RawUsageData
      return { kind: 'ok', snapshot: toSnapshot(data) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._logger.warn(`usage fetch failed: ${message}`)
      return { kind: 'error', message }
    }
  }

  private async _loadCredentials(): Promise<
    { kind: 'ok'; apiKey: string; baseUrl: string } | { kind: 'disabled'; reason: string }
  > {
    let raw: string
    try {
      raw = await fs.readFile(this._settingsPath, 'utf8')
    } catch {
      return { kind: 'disabled', reason: `settings.json not found at ${this._settingsPath}` }
    }
    let env: Record<string, string>
    try {
      env = (JSON.parse(raw) as RawSettings).env ?? {}
    } catch {
      return { kind: 'disabled', reason: `settings.json is not valid JSON` }
    }
    const apiKey = env[AUTH_TOKEN_KEY]
    const baseUrl = env[BASE_URL_KEY]
    if (!apiKey || !baseUrl) {
      return {
        kind: 'disabled',
        reason: `${AUTH_TOKEN_KEY} / ${BASE_URL_KEY} not configured in settings.env`,
      }
    }
    return { kind: 'ok', apiKey, baseUrl }
  }
}

function toSnapshot(data: RawUsageData): UsageSnapshot {
  return {
    date: data.date,
    periodBucket: data.period_bucket,
    periodUsedCny: data.period_used_cny,
    periodLimitCny: data.period_limit_cny,
    periodRemainingCny: data.period_remaining_cny,
    requests: data.requests,
    rawTokens: data.raw_tokens,
    models: (data.models ?? []).map((m) => ({
      model: m.model,
      requests: m.requests,
      rawTokens: m.raw_tokens,
      costCny: m.cost_cny,
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
