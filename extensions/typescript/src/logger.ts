/**
 * Leveled logger over the plugin's dedicated "TypeScript" output channel,
 * mirroring VSCode's TS extension (a LogOutputChannel named 'TypeScript'
 * gated by `typescript.tsserver.log`). Routine diagnostics must go here —
 * not console.error, which lands in the shared 'Extension Host' channel and
 * drowns in unrelated host noise.
 */
import type { OutputChannel } from '@universe-editor/extension-api'

/** Mirrors the `typescript.tsserver.log` setting values (VSCode parity). */
export type TsLogLevel = 'off' | 'error' | 'info' | 'verbose'

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
