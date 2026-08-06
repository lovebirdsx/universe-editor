/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Generic perf-phase instrumentation. Reactions known to run on a latency-
 *  sensitive path record themselves as named phases via `recordPerfPhase`;
 *  watchdogs (tab-switch, interaction responsiveness) correlate those phases
 *  with long-task / long-animation-frame entries inside an observation window
 *  and log a warning when the main thread was blocked past the threshold — so
 *  a slow interaction in the wild leaves an attributable trace in the window
 *  log instead of an unexplained freeze.
 *--------------------------------------------------------------------------------------------*/

export interface PerfSample {
  readonly name: string
  /** performance.now() timebase. */
  readonly startTime: number
  readonly duration: number
}

const MAX_PHASE_SAMPLES = 256
const phaseSamples: PerfSample[] = []

/** Record a pre-measured sample. For high-frequency paths (e.g. per-IPC-message
 *  decode) that must only report slow occurrences, so the ring buffer isn't
 *  flooded with healthy sub-millisecond samples evicting useful phases. */
export function pushPerfPhaseSample(name: string, startTime: number, duration: number): void {
  phaseSamples.push({ name, startTime, duration })
  if (phaseSamples.length > MAX_PHASE_SAMPLES) {
    phaseSamples.splice(0, phaseSamples.length - MAX_PHASE_SAMPLES)
  }
}

/** Run `fn`, recording its wall time under `name` for perf reports. */
export function recordPerfPhase<T>(name: string, fn: () => T): T {
  const startTime = performance.now()
  try {
    return fn()
  } finally {
    pushPerfPhaseSample(name, startTime, performance.now() - startTime)
  }
}

/** Async twin of {@link recordPerfPhase}: the sample spans the whole promise,
 *  not just the synchronous head up to the first await. */
export async function recordPerfPhaseAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const startTime = performance.now()
  try {
    return await fn()
  } finally {
    pushPerfPhaseSample(name, startTime, performance.now() - startTime)
  }
}

/** Instrument for ChannelPair/IpcService message decoding: records a perf phase
 *  only when a single frame's decode blocked the main thread noticeably, so a
 *  slow tab switch caused by a multi-MB RPC payload shows up attributed in the
 *  tab-switch / interaction reports instead of as an anonymous long task. */
export function slowDecodePhaseInstrument(name: string, minMs = 5): <T>(run: () => T) => T {
  return (run) => {
    const startTime = performance.now()
    try {
      return run()
    } finally {
      const duration = performance.now() - startTime
      if (duration >= minMs) pushPerfPhaseSample(name, startTime, duration)
    }
  }
}

export function getRecordedPhases(): readonly PerfSample[] {
  return phaseSamples
}

export function _resetPerfPhasesForTests(): void {
  phaseSamples.length = 0
}

/** Samples overlapping [startTime, endTime]. A long task that started before the
 *  window counts too — the interaction runs inside the task that handled it. */
export function samplesInWindow<
  T extends { readonly startTime: number; readonly duration: number },
>(samples: readonly T[], startTime: number, endTime: number): T[] {
  return samples.filter((s) => s.startTime + s.duration >= startTime && s.startTime <= endTime)
}
