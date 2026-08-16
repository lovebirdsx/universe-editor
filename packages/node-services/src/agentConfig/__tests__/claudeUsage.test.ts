import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchClaudeUsage, toSnapshot, usageCredentialsFrom } from '../claudeUsage.js'

describe('toSnapshot', () => {
  it('maps provider fields to camelCase snapshot', () => {
    const snapshot = toSnapshot({
      date: '20260811',
      requests: 3,
      raw_tokens: 1200,
      period_bucket: 'week:2026W33',
      period_limit_cny: 30000000,
      period_used_cny: 12345,
      period_remaining_cny: 29987655,
      models: [{ model: 'claude-opus', requests: 3, raw_tokens: 1200, cost_cny: 12345 }],
    })
    expect(snapshot).toEqual({
      date: '20260811',
      requests: 3,
      rawTokens: 1200,
      periodBucket: 'week:2026W33',
      periodLimitCny: 30000000,
      periodUsedCny: 12345,
      periodRemainingCny: 29987655,
      models: [{ model: 'claude-opus', requests: 3, rawTokens: 1200, costCny: 12345 }],
    })
  })

  it('coerces missing/null numeric fields to 0 instead of NaN', () => {
    const snapshot = toSnapshot({
      date: '20260811',
      period_bucket: 'week:2026W33',
      // 未产生消费时接口可能省略数值字段或返回 null
      requests: undefined as unknown as number,
      raw_tokens: null as unknown as number,
      period_limit_cny: 30000000,
      period_used_cny: undefined as unknown as number,
      period_remaining_cny: null as unknown as number,
      models: [
        {
          model: 'claude-opus',
          requests: undefined as unknown as number,
          raw_tokens: '0' as unknown as number,
          cost_cny: null as unknown as number,
        },
      ],
    })
    expect(snapshot.periodUsedCny).toBe(0)
    expect(snapshot.periodRemainingCny).toBe(0)
    expect(snapshot.requests).toBe(0)
    expect(snapshot.rawTokens).toBe(0)
    expect(snapshot.models[0]).toEqual({
      model: 'claude-opus',
      requests: 0,
      rawTokens: 0,
      costCny: 0,
    })
  })

  it('coerces NaN to 0', () => {
    const snapshot = toSnapshot({
      date: '20260811',
      requests: Number.NaN,
      raw_tokens: Number.NaN,
      period_bucket: 'week:2026W33',
      period_limit_cny: Number.NaN,
      period_used_cny: Number.NaN,
      period_remaining_cny: Number.NaN,
      models: [],
    })
    expect(snapshot.periodUsedCny).toBe(0)
    expect(snapshot.periodLimitCny).toBe(0)
  })
})

describe('usageCredentialsFrom', () => {
  it('returns both credentials when configured', () => {
    expect(
      usageCredentialsFrom({
        env: { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api' },
      }),
    ).toEqual({ apiKey: 'tok', baseUrl: 'https://api' })
  })

  it('returns undefined without an env block', () => {
    expect(usageCredentialsFrom({})).toBeUndefined()
  })

  it('returns undefined when the token is missing', () => {
    expect(usageCredentialsFrom({ env: { ANTHROPIC_BASE_URL: 'https://api' } })).toBeUndefined()
  })

  it('returns undefined when the base URL is missing', () => {
    expect(usageCredentialsFrom({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } })).toBeUndefined()
  })
})

describe('fetchClaudeUsage credential resolution', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

  async function settingsDir(): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'claude-usage-'))
    dirs.push(dir)
    return dir
  }

  it('resolves disabled when the settings file is missing', async () => {
    const dir = await settingsDir()
    await expect(fetchClaudeUsage(join(dir, 'settings.json'))).resolves.toMatchObject({
      kind: 'disabled',
    })
  })

  it('resolves disabled when the settings file is malformed JSON', async () => {
    const dir = await settingsDir()
    const path = join(dir, 'settings.json')
    await fs.writeFile(path, '{ not json', 'utf8')
    await expect(fetchClaudeUsage(path)).resolves.toMatchObject({ kind: 'disabled' })
  })

  it('resolves disabled when credentials are missing', async () => {
    const dir = await settingsDir()
    const path = join(dir, 'settings.json')
    await fs.writeFile(path, JSON.stringify({ env: { OTHER: '1' } }), 'utf8')
    await expect(fetchClaudeUsage(path)).resolves.toMatchObject({ kind: 'disabled' })
  })
})
