/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MemoryPressureContribution — starts the renderer heap watermark and registers the
 *  process-wide caches as releasers.
 *
 *  Split of responsibility: this contribution owns the caches that are module-level
 *  singletons (the prompt caches, the mention file listing, the shared ACP resident
 *  budget), because nothing else can reach them. Caches owned by a DI-constructed
 *  class register their own releaser in its constructor — a contribution reaching into
 *  a service's private cache would be worse than the duplication it saves.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILoggerService,
  createNamedLogger,
  formatIpcFrames,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  IMemoryPressureService,
  type MemoryHeapReading,
} from '../services/memory/memoryPressureService.js'
import {
  MEMORY_PRESSURE_LEVEL_NAMES,
  MemoryPressureLevel,
} from '../services/memory/memoryPressureLevels.js'
import { AcpPromptDraftCache } from '../services/acp/session/acpPromptDraftCache.js'
import { AcpPromptCancelledDraftStash } from '../services/acp/session/acpPromptCancelledDraftStash.js'
import {
  mentionFileCacheStats,
  releaseMentionFileCache,
} from '../services/acp/mentionFileSearch.js'
import { sharedResidentBudget } from '../services/acp/session/acpResidentBudget.js'

/**
 * How much each cache keeps at each level. Elevated is a warning shot that drops only
 * what is clearly cold; critical is the last stop before the heap dies, where losing
 * detail is strictly better than losing the window.
 */
const ELEVATED_KEEP_FRACTION = 0.75
const CRITICAL_KEEP_FRACTION = 0

/**
 * Smallest share of the heap the ACP transcripts must hold before an *elevated* release
 * touches them. The heap reading includes garbage the next GC reclaims: the field report
 * behind this sat at 2–2.5GB "used" with transcripts holding 2–47MB, and every retry
 * shaved another quarter off them — down to the reply being read — while freeing
 * kilobytes from a heap that then fell back to ~350MB on its own. Content the user is
 * reading is only worth giving up when giving it up can matter. Critical is the last
 * stop before the cage and is never gated.
 */
export const ACP_ELEVATED_MIN_HEAP_SHARE = 0.2

/** Whether a release at `level` should trim ACP transcripts holding `acpBytes`. */
export function shouldReleaseAcpTranscripts(
  level: MemoryPressureLevel,
  acpBytes: number,
  heap: MemoryHeapReading,
): boolean {
  if (level === MemoryPressureLevel.Critical) return true
  // No reading yet (a forced release before the first sample): nothing to weigh against.
  if (heap.used <= 0) return true
  return acpBytes >= heap.used * ACP_ELEVATED_MIN_HEAP_SHARE
}

/** Trim a byte-budgeted cache to `fraction` of what it currently holds. */
function keepFraction(current: number, fraction: number): number {
  return Math.floor(current * fraction)
}

export class MemoryPressureContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IMemoryPressureService pressure: IMemoryPressureService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    const logger = createNamedLogger(loggerService, { id: 'memory', name: 'Memory' })

    let lastAcpReleaseDecision: boolean | undefined
    const toMB = (bytes: number): number => Math.round(bytes / (1024 * 1024))
    const cacheKeep = (level: MemoryPressureLevel): number =>
      level === MemoryPressureLevel.Critical ? CRITICAL_KEEP_FRACTION : ELEVATED_KEEP_FRACTION

    // One-shot stashes first: pressing cancel restores one of these, so losing it
    // costs the user their prompt text — but it is also the smallest thing here, so
    // it is the cheapest to give up.
    this._register(
      pressure.registerReleaser({
        id: 'acp.cancelledDrafts',
        priority: -10,
        release: () => AcpPromptCancelledDraftStash.release(),
      }),
    )
    this._register(
      pressure.registerReleaser({
        id: 'acp.promptDrafts',
        release: (level) =>
          AcpPromptDraftCache.releaseTo(
            keepFraction(AcpPromptDraftCache.stats().bytes, cacheKeep(level)),
          ),
      }),
    )
    this._register(
      pressure.registerReleaser({
        id: 'acp.mentionFileListing',
        release: (level) =>
          releaseMentionFileCache(keepFraction(mentionFileCacheStats().bytes, cacheKeep(level))),
      }),
    )
    this._register(
      pressure.registerReleaser({
        id: 'acp.residentBudget',
        release: (level, heap) => {
          const acpBytes = sharedResidentBudget.totalBytes()
          const release = shouldReleaseAcpTranscripts(level, acpBytes, heap)
          // Logged on change only: this runs every retry interval while the heap is
          // parked over a line, and the decision is what a diagnosis needs to read.
          if (release !== lastAcpReleaseDecision) {
            lastAcpReleaseDecision = release
            logger.info(
              `[memory] acp.residentBudget ${release ? 'releasing' : 'spared'} at ` +
                `${MEMORY_PRESSURE_LEVEL_NAMES[level]}: transcripts=${toMB(acpBytes)}MB ` +
                `heap=${toMB(heap.used)}MB`,
            )
          }
          return release ? sharedResidentBudget.releaseFraction(cacheKeep(level)) : 0
        },
      }),
    )

    // The frame ring is the other half of the story these levels tell: an oversized
    // payload and the heap it inflated are the same incident, and reading them from
    // one file is the difference between a diagnosis and a guess.
    this._register(
      pressure.onDidChangeLevel((level) => {
        if (level === MemoryPressureLevel.Normal) return
        logger.info(`[memory] ${pressure.describe()}\n${formatIpcFrames(12)}`)
      }),
    )

    pressure.start()
    this._register({ dispose: () => pressure.stop() })
  }
}
