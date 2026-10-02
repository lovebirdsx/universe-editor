/*---------------------------------------------------------------------------------------------
 *  Tests for the ACP transcript gate in MemoryPressureContribution. Field report
 *  2026-10-02: the heap sat at 2–2.5GB "used" (mostly collectable garbage) while the
 *  transcripts held 2–47MB, and the elevated release kept haircutting them every retry
 *  until the reply the user was reading was cut down to its first 200 characters.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Event } from '@universe-editor/platform'
import {
  ACP_ELEVATED_MIN_HEAP_SHARE,
  MemoryPressureContribution,
  shouldReleaseAcpTranscripts,
} from '../MemoryPressureContribution.js'
import { MemoryPressureLevel } from '../../services/memory/memoryPressureLevels.js'
import type {
  IMemoryPressureService,
  IMemoryReleaser,
} from '../../services/memory/memoryPressureService.js'
import { sharedResidentBudget } from '../../services/acp/session/acpResidentBudget.js'
import { StubLoggerService } from '../../__tests__/_helpers/stubLoggerService.js'

const MIB = 1024 * 1024

describe('shouldReleaseAcpTranscripts', () => {
  it('spares transcripts that are a sliver of an elevated heap', () => {
    // The field shape: 3MB of transcripts against a 2.5GB reading.
    expect(
      shouldReleaseAcpTranscripts(MemoryPressureLevel.Elevated, 3 * MIB, { used: 2500 * MIB }),
    ).toBe(false)
  })

  it('releases at elevated once transcripts are a real share of the heap', () => {
    const used = 2000 * MIB
    const share = Math.ceil(used * ACP_ELEVATED_MIN_HEAP_SHARE) + MIB
    expect(shouldReleaseAcpTranscripts(MemoryPressureLevel.Elevated, share, { used })).toBe(true)
  })

  it('always releases at critical', () => {
    expect(
      shouldReleaseAcpTranscripts(MemoryPressureLevel.Critical, 1 * MIB, { used: 3000 * MIB }),
    ).toBe(true)
  })

  it('releases when there is no reading to weigh against', () => {
    expect(shouldReleaseAcpTranscripts(MemoryPressureLevel.Elevated, 1 * MIB, { used: 0 })).toBe(
      true,
    )
  })
})

describe('MemoryPressureContribution — acp.residentBudget releaser', () => {
  const contributions: MemoryPressureContribution[] = []

  afterEach(() => {
    for (const c of contributions.splice(0)) c.dispose()
    vi.restoreAllMocks()
  })

  function acpReleaser(): IMemoryReleaser {
    const releasers: IMemoryReleaser[] = []
    const pressure = {
      registerReleaser: (r: IMemoryReleaser) => {
        releasers.push(r)
        return { dispose: () => {} }
      },
      onDidChangeLevel: Event.None,
      describe: () => '',
      start: () => {},
      stop: () => {},
    } as unknown as IMemoryPressureService
    contributions.push(new MemoryPressureContribution(pressure, new StubLoggerService()))
    const found = releasers.find((r) => r.id === 'acp.residentBudget')
    if (!found) throw new Error('acp.residentBudget releaser not registered')
    return found
  }

  it('does not touch the transcripts when they cannot matter to the heap', () => {
    vi.spyOn(sharedResidentBudget, 'totalBytes').mockReturnValue(3 * MIB)
    const releaseFraction = vi.spyOn(sharedResidentBudget, 'releaseFraction')

    const freed = acpReleaser().release(MemoryPressureLevel.Elevated, { used: 2500 * MIB })

    expect(freed).toBe(0)
    expect(releaseFraction).not.toHaveBeenCalled()
  })

  it('hands a qualifying release to the shared budget', () => {
    vi.spyOn(sharedResidentBudget, 'totalBytes').mockReturnValue(800 * MIB)
    const releaseFraction = vi.spyOn(sharedResidentBudget, 'releaseFraction').mockReturnValue(42)

    const releaser = acpReleaser()
    expect(releaser.release(MemoryPressureLevel.Elevated, { used: 2500 * MIB })).toBe(42)
    expect(releaseFraction).toHaveBeenLastCalledWith(0.75)
    expect(releaser.release(MemoryPressureLevel.Critical, { used: 3000 * MIB })).toBe(42)
    expect(releaseFraction).toHaveBeenLastCalledWith(0)
  })
})
