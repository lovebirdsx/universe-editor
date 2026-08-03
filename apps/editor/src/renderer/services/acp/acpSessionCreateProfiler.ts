/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionCreateProfiler — per-attempt timing for the createSession handshake.
 *
 *  The startup PerfMarks pipeline is milestone-shaped (same-name marks collapse
 *  to the earliest one), which cannot attribute repeated session creations.
 *  This profiler instead records one profile per attempt: a monotonic step
 *  sequence (`will*`/`did*` pairs) from the click through attach, kept in a
 *  small ring buffer for the Output-channel summary line and the e2e probe.
 *--------------------------------------------------------------------------------------------*/

export interface SessionCreateStep {
  readonly name: string
  /** Epoch milliseconds. */
  readonly at: number
}

export interface SessionCreateProfile {
  readonly agentId: string
  readonly startedAt: number
  readonly steps: readonly SessionCreateStep[]
  readonly endedAt?: number
  readonly failed?: string
  /** True when the agent process + initialize handshake were reused from the pool. */
  readonly pooledConnection: boolean
}

export interface ISessionCreateProfileHandle {
  step(name: string): void
  markPooled(): void
  end(): SessionCreateProfile
  fail(message: string): SessionCreateProfile
}

const MAX_PROFILES = 5

export class AcpSessionCreateProfiler {
  private readonly _profiles: SessionCreateProfile[] = []

  begin(agentId: string): ISessionCreateProfileHandle {
    const startedAt = Date.now()
    const steps: SessionCreateStep[] = []
    let pooled = false
    let completed: SessionCreateProfile | undefined
    const complete = (failed?: string): SessionCreateProfile => {
      if (!completed) {
        completed = {
          agentId,
          startedAt,
          steps: [...steps],
          endedAt: Date.now(),
          pooledConnection: pooled,
          ...(failed !== undefined ? { failed } : {}),
        }
        this._profiles.push(completed)
        if (this._profiles.length > MAX_PROFILES) this._profiles.shift()
      }
      return completed
    }
    return {
      step: (name) => {
        if (!completed) steps.push({ name, at: Date.now() })
      },
      markPooled: () => {
        pooled = true
      },
      end: () => complete(),
      fail: (message) => complete(message),
    }
  }

  lastProfiles(): readonly SessionCreateProfile[] {
    return this._profiles
  }
}

/** Ordered will/did pairs rendered into the one-line summary. */
const SEGMENTS: ReadonlyArray<readonly [label: string, from: string, to: string]> = [
  ['mcp', 'willResolveMcp', 'didResolveMcp'],
  ['binary', 'willResolveBinary', 'didResolveBinary'],
  ['spawn', 'willSpawn', 'didSpawn'],
  ['init', 'willInitialize', 'didInitialize'],
  ['connect', 'willConnect', 'didConnect'],
  ['newSession', 'willNewSession', 'didNewSession'],
]

export function formatSessionCreateProfile(p: SessionCreateProfile): string {
  const at = (name: string): number | undefined => p.steps.find((s) => s.name === name)?.at
  const parts: string[] = [`agent=${p.agentId}`, `pooled=${p.pooledConnection}`]
  for (const [label, from, to] of SEGMENTS) {
    const a = at(from)
    const b = at(to)
    if (a !== undefined && b !== undefined) parts.push(`${label}=${b - a}ms`)
  }
  if (p.endedAt !== undefined) parts.push(`total=${p.endedAt - p.startedAt}ms`)
  if (p.failed !== undefined) parts.push(`failed=${p.failed}`)
  return `acp.session_create ${parts.join(' ')}`
}
