/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mid-turn session cost: the claude fork stamps a per-model token breakdown onto
 *  every mid-turn `usage_update` (no costUSD — only the turn-final `result` knows
 *  the CLI figure), so the wallet readout has to advance during a running turn by
 *  pricing those rows locally. These tests drive `applyUpdate` directly and assert
 *  `session.usage.get()` across the four cases that matter: mid-turn with a rate,
 *  mid-turn without one (must not flicker the amount off), and the two turn-final
 *  shapes whose semantics must stay exactly as they were.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { Event, NoopTelemetryService } from '@universe-editor/platform'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpSession } from '../acpSession.js'
import type {
  IAcpSessionProviderContext,
  SessionProviderContext,
} from '../acpSessionProviderContext.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'

function providerContext(ctx: SessionProviderContext | undefined): IAcpSessionProviderContext {
  return {
    _serviceBrand: undefined,
    onDidChangeContext: Event.None,
    getProviderContext: () => ctx,
    refresh: async () => {},
  }
}

/** An official Anthropic subscription session: no pricing source at all. */
const SUBSCRIPTION_CTX = undefined

/** A reselling gateway publishing CNY rates for the bare model name. */
const GATEWAY_CTX: SessionProviderContext = {
  providerId: 'acme',
  protocol: 'anthropic-messages',
  pricingSource: { id: 'http-json', options: {} },
  gatewayRates: {
    'deepseek-v4-pro': { currency: 'CNY', input: 9, output: 27, cacheRead: 0.2997 },
  },
  cnyPerUsd: 6.74,
}

/** An official-endpoint provider whose rates come from the built-in catalog. */
const CATALOG_CTX: SessionProviderContext = {
  providerId: 'anthropic',
  protocol: 'anthropic-messages',
  pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
}

function createSession(ctx: SessionProviderContext | undefined): AcpSession {
  return new AcpSession(
    's1',
    'claude-code',
    't',
    new NoopTelemetryService(),
    undefined,
    'default',
    undefined,
    undefined,
    new StubSessionChangeTracker(),
    undefined,
    false,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    providerContext(ctx),
  )
}

interface BreakdownRow {
  readonly model: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheCreateTokens?: number
  readonly costUSD?: number
}

/** A mid-turn usage_update: token rows, no `cost` and no per-row `costUSD`. */
function midturnUpdate(rows: readonly BreakdownRow[], used = 1000): SessionUpdate {
  return {
    sessionUpdate: 'usage_update',
    used,
    size: 200_000,
    _meta: { '_universe/modelBreakdown': rows },
  } as SessionUpdate
}

/** A turn-final usage_update: the CLI's own total plus per-row costUSD. */
function turnFinalUpdate(rows: readonly BreakdownRow[], amount: number): SessionUpdate {
  return {
    sessionUpdate: 'usage_update',
    used: 2000,
    size: 200_000,
    cost: { amount, currency: 'USD' },
    _meta: { '_universe/modelBreakdown': rows },
  } as SessionUpdate
}

describe('AcpSession — mid-turn usage_update cost', () => {
  let session: AcpSession | undefined

  afterEach(() => {
    session?.dispose()
    session = undefined
  })

  it('prices a mid-turn gateway breakdown locally and flags it estimated', () => {
    session = createSession(GATEWAY_CTX)

    session.applyUpdate(
      midturnUpdate([{ model: 'deepseek-v4-pro[1m]', inputTokens: 1_000_000, outputTokens: 0 }]),
    )

    const usage = session.usage.get()
    // The gateway prices the bare name in CNY; both directions use the live rate.
    expect(usage?.cost?.amount).toBeCloseTo(9 / 6.74, 10)
    expect(usage?.cost?.currency).toBe('USD')
    expect(usage?.costEstimated).toBe(true)
    expect(usage?.models?.[0]?.costUSD).toBeCloseTo(9 / 6.74, 10)
    expect(usage?.used).toBe(1000)
  })

  it('grows the amount as the turn progresses (the whole point of the feature)', () => {
    session = createSession(GATEWAY_CTX)

    session.applyUpdate(midturnUpdate([{ model: 'deepseek-v4-pro', inputTokens: 500_000 }], 500))
    const first = session.usage.get()?.cost?.amount
    session.applyUpdate(midturnUpdate([{ model: 'deepseek-v4-pro', inputTokens: 1_000_000 }], 1000))
    const second = session.usage.get()?.cost?.amount

    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(first!)
  })

  it('carries the last authoritative cost forward when no row resolves a rate', () => {
    // An official subscription session has no rate table, so a mid-turn row can
    // only be honest by leaving the amount alone — replacing it with nothing
    // would blink the wallet off for the whole duration of every running turn.
    session = createSession(SUBSCRIPTION_CTX)

    session.applyUpdate(
      turnFinalUpdate([{ model: 'claude-opus-5', inputTokens: 1000, costUSD: 0.42 }], 0.42),
    )
    expect(session.usage.get()?.cost?.amount).toBe(0.42)
    expect(session.usage.get()?.costEstimated).toBeUndefined()

    session.applyUpdate(midturnUpdate([{ model: 'claude-opus-5', inputTokens: 5000 }], 5000))

    const usage = session.usage.get()
    expect(usage?.cost?.amount).toBe(0.42)
    // Token detail still advances even though the amount is frozen.
    expect(usage?.models?.[0]?.inputTokens).toBe(5000)
    expect(usage?.models?.[0]).not.toHaveProperty('costUSD')
    expect(usage?.used).toBe(5000)
  })

  it('keeps the CLI figure on a turn-final Anthropic row (catalog source)', () => {
    session = createSession(CATALOG_CTX)

    session.applyUpdate(
      turnFinalUpdate([{ model: 'claude-opus-5', inputTokens: 1_000_000, costUSD: 7.5 }], 7.5),
    )

    const usage = session.usage.get()
    expect(usage?.cost?.amount).toBe(7.5)
    expect(usage?.models?.[0]?.costUSD).toBe(7.5)
    // Authoritative, not estimated — the `≈` prefix must not appear.
    expect(usage?.costEstimated).toBeUndefined()
  })

  it('re-prices a turn-final gateway row over the CLI figure', () => {
    session = createSession(GATEWAY_CTX)

    // The CLI billed this gateway model at its Anthropic flagship fallback rate.
    session.applyUpdate(
      turnFinalUpdate(
        [{ model: 'deepseek-v4-pro[1m]', inputTokens: 1_000_000, costUSD: 9.99 }],
        9.99,
      ),
    )

    const usage = session.usage.get()
    expect(usage?.cost?.amount).toBeCloseTo(9 / 6.74, 10)
    expect(usage?.costEstimated).toBe(true)
  })

  it('leaves a mid-turn update with no breakdown completely alone', () => {
    session = createSession(GATEWAY_CTX)

    session.applyUpdate(
      turnFinalUpdate([{ model: 'deepseek-v4-pro', inputTokens: 1_000_000, costUSD: 9.99 }], 9.99),
    )
    const priced = session.usage.get()?.cost?.amount

    session.applyUpdate({
      sessionUpdate: 'usage_update',
      used: 3000,
      size: 200_000,
    } as SessionUpdate)

    const usage = session.usage.get()
    expect(usage?.cost?.amount).toBe(priced)
    expect(usage?.models?.[0]?.model).toBe('deepseek-v4-pro')
    expect(usage?.used).toBe(3000)
  })

  // The fork's ledger is a per-session consumer local, so after a reconnect or
  // an agent restart the first recovered turn's mid-turn rows carry only that
  // turn's own tokens. A mid-turn figure only ever grows, so one below the last
  // means the base is missing — freeze the amount rather than drop the wallet
  // from a real total to pennies until the turn ends.
  it('freezes the amount when a mid-turn figure regresses (lost fork ledger)', () => {
    session = createSession(GATEWAY_CTX)

    session.applyUpdate(
      turnFinalUpdate([{ model: 'deepseek-v4-pro', inputTokens: 10_000_000, costUSD: 99 }], 99),
    )
    const authoritative = session.usage.get()?.cost?.amount

    session.applyUpdate(midturnUpdate([{ model: 'deepseek-v4-pro', inputTokens: 1000 }], 1000))

    const usage = session.usage.get()
    expect(usage?.cost?.amount).toBe(authoritative)
    // Token detail still tracks the recovered turn — only the amount is held.
    expect(usage?.models?.[0]?.inputTokens).toBe(1000)
    expect(usage?.used).toBe(1000)
  })

  // A turn-final update carries `cost` and always replaces, so an authoritative
  // correction downward (a rewind truncating the transcript) still lands.
  it('still accepts a turn-final figure below the last one', () => {
    session = createSession(GATEWAY_CTX)

    session.applyUpdate(
      turnFinalUpdate([{ model: 'deepseek-v4-pro', inputTokens: 10_000_000, costUSD: 99 }], 99),
    )
    const before = session.usage.get()?.cost?.amount

    session.applyUpdate(
      turnFinalUpdate([{ model: 'deepseek-v4-pro', inputTokens: 1000, costUSD: 1 }], 1),
    )

    const after = session.usage.get()?.cost?.amount
    expect(after).toBeLessThan(before!)
  })
})
