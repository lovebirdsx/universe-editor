/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  E2E-only observation seam for MemoryReminderContribution. The reminder only fires after
 *  ten minutes above the elevated line, and a spec cannot spend ten minutes building a real
 *  2GB heap — nor can it fake one, because the watermark reads `performance.memory` from a
 *  live renderer and has no setter. So the contribution exposes the decision itself here:
 *  a spec replays a sample series through the *real* policy and the *real* notification
 *  path, and only the readings are synthetic. Populated only under UNIVERSE_E2E=1.
 *--------------------------------------------------------------------------------------------*/

import type { MemoryPressureLevel } from './memoryPressureLevels.js'
import type { MemoryReminderDecision, MemoryReminderState } from './memoryReminderPolicy.js'

/** One replayed reading, positioned relative to the start of the replay. */
export interface MemoryReminderE2ESample {
  readonly afterMs: number
  readonly level: MemoryPressureLevel
  readonly usedBytes: number
}

export interface MemoryReminderE2E {
  /** Every decision the replayed series produced, in order. */
  readonly decisions: MemoryReminderDecision[]
  /**
   * Replay a series through the real policy. Contract: the state is reset first (so the
   * spec starts from a window that has never been reminded), and live samples are dropped
   * for the rest of this renderer's life — otherwise a real `normal` reading would land
   * between two synthetic ones and reset the stretch the spec is building.
   */
  drive?: (samples: readonly MemoryReminderE2ESample[]) => void
  readState?: () => MemoryReminderState
}

export const memoryReminderE2E: MemoryReminderE2E = { decisions: [] }
