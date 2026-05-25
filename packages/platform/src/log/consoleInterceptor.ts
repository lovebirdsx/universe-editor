/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Console interceptor: routes global `console.*` calls through an ILogger so
 *  ad-hoc console output, third-party library noise, and DevTools-issued calls
 *  all reach the file-based log system (and therefore the Output panel) without
 *  requiring DevTools to be open.
 *
 *  Recursion safety has two layers:
 *    1. The captured `ORIGINAL_CONSOLE` (in log.ts) is used by ConsoleLogger
 *       and any logger fallback code — so a logger failure path that hits
 *       console.error can't loop back through the interceptor.
 *    2. A module-level `reentrant` flag short-circuits any nested interception
 *       triggered while a logger call is on the stack (e.g. a logger that
 *       internally synchronously calls console.* via some untracked path).
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '../base/lifecycle.js'
import { type ILogger, LogLevel, getOriginalConsole } from './log.js'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'

const METHOD_TO_LEVEL: Record<ConsoleMethod, LogLevel> = {
  log: LogLevel.Info,
  info: LogLevel.Info,
  warn: LogLevel.Warning,
  error: LogLevel.Error,
  debug: LogLevel.Debug,
  trace: LogLevel.Trace,
}

let reentrant = false

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }
  return String(arg)
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(' ')
}

export interface ConsoleInterceptorOptions {
  /** Destination logger. Required. */
  readonly logger: ILogger
}

/**
 * Patches `console.{log,info,warn,error,debug,trace}` so each call both
 * preserves its original behavior (DevTools / stdout) and dispatches a
 * formatted entry to `logger`. Returns an IDisposable that restores the
 * pre-patch methods.
 *
 * Safe to call once per process. Calling twice without disposing the first
 * installer chains the patches — the outer install's `originalConsole` snapshot
 * still wins on dispose because the snapshot is module-level.
 */
export function installConsoleInterceptor(options: ConsoleInterceptorOptions): IDisposable {
  const { logger } = options
  const original = getOriginalConsole()
  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug', 'trace']

  const previous: Partial<Record<ConsoleMethod, Console[ConsoleMethod]>> = {}
  for (const m of methods) {
    previous[m] = console[m]
  }

  for (const m of methods) {
    const orig = original[m]
    const level = METHOD_TO_LEVEL[m]
    console[m] = ((...args: unknown[]) => {
      // Always preserve DevTools / stdout visibility first.
      orig(...args)
      if (reentrant) return
      reentrant = true
      try {
        const text = formatArgs(args)
        switch (level) {
          case LogLevel.Trace:
            logger.trace(text)
            break
          case LogLevel.Debug:
            logger.debug(text)
            break
          case LogLevel.Info:
            logger.info(text)
            break
          case LogLevel.Warning:
            logger.warn(text)
            break
          case LogLevel.Error:
            logger.error(text)
            break
          default:
            logger.info(text)
        }
      } catch {
        // Logger failures must never break the host program's console.
      } finally {
        reentrant = false
      }
    }) as Console[ConsoleMethod]
  }

  return toDisposable(() => {
    for (const m of methods) {
      const prev = previous[m]
      if (prev !== undefined) {
        console[m] = prev
      }
    }
  })
}
