/**
 * Leveled logger over the plugin's dedicated "TypeScript" output channel,
 * mirroring VSCode's TS extension (a LogOutputChannel named 'TypeScript'
 * gated by `js/ts.tsserver.log`). Routine diagnostics must go here —
 * not console.error, which lands in the shared 'Extension Host' channel and
 * drowns in unrelated host noise.
 */
import type { OutputChannel } from '@universe-editor/extension-api'

/** The plugin logger's internal gate level (off/error/info/verbose), fed by
 *  either the `UNIVERSE_TS_LOG_LEVEL` env override or the js/ts.tsserver.log
 *  setting via `loggerLevelForSetting`. */
export type TsLogLevel = 'off' | 'error' | 'info' | 'verbose'

/** The user-facing `js/ts.tsserver.log` values (VSCode parity). */
export type TsServerLogSetting = 'off' | 'terse' | 'normal' | 'verbose' | 'requestTime'

const LEVEL_PRIORITY: Record<TsLogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  verbose: 3,
}

/** Narrow an unknown config/env value to a level, or undefined when invalid. */
export function parseTsLogLevel(value: unknown): TsLogLevel | undefined {
  return value === 'off' || value === 'error' || value === 'info' || value === 'verbose'
    ? value
    : undefined
}

/** Narrow an unknown setting value to a `js/ts.tsserver.log` level, or undefined. */
export function parseTsServerLogSetting(value: unknown): TsServerLogSetting | undefined {
  return value === 'off' ||
    value === 'terse' ||
    value === 'normal' ||
    value === 'verbose' ||
    value === 'requestTime'
    ? value
    : undefined
}

/**
 * Map the `js/ts.tsserver.log` setting to the plugin logger's gate level.
 * VSCode semantics: the setting drives the TS SERVER's own file log, while the
 * plugin output channel defaults to info — so `off` (default) only turns off the
 * server file log and keeps the channel at info, leaving today's default logging
 * unchanged. `verbose` / `requestTime` additionally raise the channel to verbose.
 */
export function loggerLevelForSetting(setting: TsServerLogSetting): TsLogLevel {
  return setting === 'verbose' || setting === 'requestTime' ? 'verbose' : 'info'
}

/** Map the setting to tsserver's `logVerbosity`; `off` returns undefined so the
 *  plugin sends no file-log field (no per-server log file). */
export function logVerbosityForSetting(setting: TsServerLogSetting): string | undefined {
  return setting === 'off' ? undefined : setting
}

/** The logging surface the LSP client depends on (kept tiny for unit tests). */
export interface TsLogger {
  error(message: string): void
  info(message: string): void
  verbose(message: string): void
}

/**
 * Console fallback for contexts with no output channel (unit tests, probes).
 * Verbose is dropped — it exists for targeted debugging, not default noise.
 */
export const consoleTsLogger: TsLogger = {
  error: (message) => console.error(`[typescript] ${message}`),
  info: (message) => console.error(`[typescript] ${message}`),
  verbose: () => {},
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** `2026-07-26 10:00:00.000` — same shape VSCode's log channels use. */
function timestamp(): string {
  const now = new Date()
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  )
}

export class OutputChannelLogger implements TsLogger {
  private _level: TsLogLevel

  constructor(
    private readonly _channel: OutputChannel,
    level: TsLogLevel = 'info',
  ) {
    this._level = level
  }

  get level(): TsLogLevel {
    return this._level
  }

  setLevel(level: TsLogLevel): void {
    this._level = level
  }

  /** Reveal the channel (the typescript.openTsServerLog command handler). */
  show(): void {
    this._channel.show()
  }

  error(message: string): void {
    this._write('error', message)
  }

  info(message: string): void {
    this._write('info', message)
  }

  verbose(message: string): void {
    this._write('verbose', message)
  }

  private _write(level: Exclude<TsLogLevel, 'off'>, message: string): void {
    if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[this._level]) return
    this._channel.appendLine(`${timestamp()} [${level}] ${message}`)
  }
}
