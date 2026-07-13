/**
 * Structured logger for the Swarm subsystem. Wraps the raw `Swarm` output channel
 * sink (a plain `(msg) => void`) with a consistent line format so the panel is
 * actually analysable:
 *
 *   HH:mm:ss.SSS [level] [scope] message
 *
 * — level ∈ debug/info/warn/error, scope ∈ api/client/status/cmd/auth. `debug`
 * lines only emit when `perforce.swarm.trace` is on (read live, so toggling the
 * setting takes effect without a reload), keeping the default output quiet while
 * making a deep dive one setting away.
 *
 * RED LINE (inherited from swarmApi/swarmAuth): tickets / passwords / the
 * Authorization header NEVER reach this logger. Callers pass already-redacted
 * strings; the logger adds no headers of its own.
 */
import { workspace } from '@universe-editor/extension-api'

export type SwarmLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Fixed scopes so every line is greppable by subsystem. */
export type SwarmLogScope = 'api' | 'client' | 'status' | 'cmd' | 'auth'

export interface SwarmLogger {
  /** Verbose diagnostics (request bodies, retries, timings). Gated on `swarm.trace`. */
  debug(scope: SwarmLogScope, message: string): void
  info(scope: SwarmLogScope, message: string): void
  warn(scope: SwarmLogScope, message: string): void
  error(scope: SwarmLogScope, message: string): void
  /** Whether verbose (`debug`) logging is currently enabled. Lets hot paths skip
   *  building an expensive message when trace is off. */
  isTraceEnabled(): Promise<boolean>
}

/** Two-digit / three-digit zero pad for the timestamp (no locale, no deps). */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** `HH:mm:ss.SSS` in local time — enough to correlate with p4 CLI + user actions
 *  without the noise of a full date on every line. */
function stamp(now: Date): string {
  return (
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}`
  )
}

/**
 * Build a {@link SwarmLogger} over a raw sink. `sink` is the channel's
 * `appendLine`. Trace state is read from `perforce.swarm.trace` on every debug
 * call (cheap config read) so the switch is live.
 */
export function createSwarmLogger(sink: (line: string) => void): SwarmLogger {
  const traceEnabled = async (): Promise<boolean> =>
    (await workspace.getConfiguration('perforce').get('swarm.trace', false)) === true

  const emit = (level: SwarmLogLevel, scope: SwarmLogScope, message: string): void => {
    sink(`${stamp(new Date())} [${level}] [${scope}] ${message}`)
  }

  return {
    debug(scope, message) {
      void traceEnabled().then((on) => {
        if (on) emit('debug', scope, message)
      })
    },
    info(scope, message) {
      emit('info', scope, message)
    },
    warn(scope, message) {
      emit('warn', scope, message)
    },
    error(scope, message) {
      emit('error', scope, message)
    },
    isTraceEnabled: traceEnabled,
  }
}
