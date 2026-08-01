import { UexError } from './errors.js'

/** Success/progress lines go to stdout; diagnostics to stderr (CI-friendly). */
export function info(message: string): void {
  console.log(message)
}

export function warn(message: string): void {
  console.error(`warning: ${message}`)
}

/** Machine-readable detail lines (file lists etc.) go to stdout. */
export function out(line: string): void {
  console.log(line)
}

export function printUexError(err: unknown): void {
  if (err instanceof UexError) {
    console.error(`error: ${err.message}`)
    for (const hint of err.hints) {
      console.error('')
      console.error(`→ ${hint}`)
    }
    if (err.hints.length > 0) console.error('')
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  if (process.env.UEX_DEBUG === '1' && err instanceof Error && err.stack) {
    console.error(err.stack)
  } else {
    console.error('re-run with UEX_DEBUG=1 for the stack trace')
  }
}
