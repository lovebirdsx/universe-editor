/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  modelSwitchContextGuard tests — reproduces the side-task incident: a session
 *  forked at 172224 tokens on "claude-fable-5[1m]" (300k effective window) was
 *  switched to the bare "sonnet" row (200k window) and instantly auto-compacted
 *  on the next prompt. The guard must flag exactly that switch, and stay quiet
 *  for lane-preserving or small-usage switches.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { IDialogService } from '@universe-editor/platform'
import type { AcpUsage } from '../acpSessionModel.js'
import {
  confirmModelSwitchContextShrink,
  estimateClaudeModelContextWindow,
  evaluateModelSwitchContextShrink,
} from '../modelSwitchContextGuard.js'

/** The real usage snapshot of the incident session at fork time. */
const INCIDENT_USAGE: AcpUsage = { used: 172_224, size: 300_000 }

describe('estimateClaudeModelContextWindow', () => {
  it('reads the bracket lane spelling', () => {
    expect(estimateClaudeModelContextWindow('sonnet[1m]')).toBe(1_000_000)
    expect(estimateClaudeModelContextWindow('claude-fable-5[1m]')).toBe(1_000_000)
    expect(estimateClaudeModelContextWindow('OPUS[1M]')).toBe(1_000_000)
  })

  it('reads the id-suffix lane spelling', () => {
    expect(estimateClaudeModelContextWindow('claude-opus-4-6-1m')).toBe(1_000_000)
  })

  it('treats a bare id as a 200k window', () => {
    expect(estimateClaudeModelContextWindow('sonnet')).toBe(200_000)
    expect(estimateClaudeModelContextWindow('claude-sonnet-5')).toBe(200_000)
    expect(estimateClaudeModelContextWindow('haiku')).toBe(200_000)
    expect(estimateClaudeModelContextWindow('default')).toBe(200_000)
  })
})

describe('evaluateModelSwitchContextShrink', () => {
  it('flags the incident switch: 172k used on a 300k window → bare "sonnet"', () => {
    const shrink = evaluateModelSwitchContextShrink('claude-code', INCIDENT_USAGE, 'sonnet')
    expect(shrink).toEqual({ usedTokens: 172_224, estimatedTargetWindow: 200_000 })
  })

  it('stays quiet when the lane is preserved ("sonnet[1m]")', () => {
    expect(
      evaluateModelSwitchContextShrink('claude-code', INCIDENT_USAGE, 'sonnet[1m]'),
    ).toBeUndefined()
    expect(
      evaluateModelSwitchContextShrink('claude-code', INCIDENT_USAGE, 'opus[1m]'),
    ).toBeUndefined()
  })

  it('stays quiet when usage is far below the target window', () => {
    expect(
      evaluateModelSwitchContextShrink('claude-code', { used: 100_000, size: 300_000 }, 'sonnet'),
    ).toBeUndefined()
  })

  it('flags usage close to (but below) the target window — compact is still imminent', () => {
    expect(
      evaluateModelSwitchContextShrink('claude-code', { used: 165_000, size: 300_000 }, 'sonnet'),
    ).toEqual({ usedTokens: 165_000, estimatedTargetWindow: 200_000 })
  })

  it('stays quiet when the target window is not smaller than the current one', () => {
    // haiku → sonnet: both bare 200k rows, no shrink even at high usage.
    expect(
      evaluateModelSwitchContextShrink('claude-code', { used: 180_000, size: 200_000 }, 'sonnet'),
    ).toBeUndefined()
  })

  it('stays quiet without a usage snapshot (fresh session)', () => {
    expect(evaluateModelSwitchContextShrink('claude-code', undefined, 'sonnet')).toBeUndefined()
  })

  it('only applies to claude-code sessions', () => {
    expect(evaluateModelSwitchContextShrink('codex', INCIDENT_USAGE, 'gpt-5')).toBeUndefined()
  })
})

describe('confirmModelSwitchContextShrink', () => {
  function makeDialogService(confirmed: boolean) {
    const confirm = vi
      .fn()
      .mockResolvedValue({ confirmed, choice: confirmed ? 'primary' : 'cancel' })
    return { dialog: { confirm } as unknown as IDialogService, confirm }
  }

  it('resolves true when the user confirms, passing a warning dialog', async () => {
    const { dialog, confirm } = makeDialogService(true)
    const ok = await confirmModelSwitchContextShrink(
      dialog,
      { usedTokens: 172_224, estimatedTargetWindow: 200_000 },
      'Sonnet',
    )
    expect(ok).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    const opts = confirm.mock.calls[0]![0]
    expect(opts.type).toBe('warning')
    expect(opts.message).toContain('Sonnet')
    expect(opts.detail).toContain('172k')
    expect(opts.detail).toContain('200k')
  })

  it('resolves false when the user cancels', async () => {
    const { dialog } = makeDialogService(false)
    const ok = await confirmModelSwitchContextShrink(
      dialog,
      { usedTokens: 172_224, estimatedTargetWindow: 200_000 },
      'Sonnet',
    )
    expect(ok).toBe(false)
  })
})
