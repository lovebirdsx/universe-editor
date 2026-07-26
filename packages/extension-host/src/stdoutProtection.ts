/**
 * Extension Host stdout protection.
 *
 * The host's stdout IS the RPC wire — only framed IPC may be written there.
 * Extensions and their bundled dependencies run in-process and may carry stray
 * `console.log` calls (e.g. a debug statement left in a language-service
 * dependency). All `console.*` write methods except `error`/`warn`/`trace`
 * default to stdout, so a single stray `console.log` injects raw text into the
 * byte stream and corrupts a frame ("Unexpected token ... is not valid JSON").
 *
 * `protectStdout` captures the real stdout writer for the framing transport and
 * then repoints `globalThis.console` so every method writes to stderr instead.
 * It returns the bound writer; the caller wires it into the StdioTransport.
 *
 * Since the host's whole diagnostic surface shares the single stderr stream,
 * each console call is prefixed with a level tag (`[info]` / `[debug]` /
 * `[warn]` / `[error]`) so the main process can route lines to the matching log
 * level instead of treating every stderr line as a warning. Output written
 * directly to stderr (a hard crash's stack, a dependency's raw write) carries no
 * tag and keeps the default warning level.
 */
import { Console } from 'node:console'

export interface StdoutProtectionTarget {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>
  readonly stderr: NodeJS.WriteStream
  console: Console
}

export type FrameWriter = (frame: string) => boolean

type ConsoleMethod = (...args: never[]) => void

/** Shadow `base[method]` with a variant that prepends the level tag. */
function tagMethod(
  base: Console,
  method: 'log' | 'info' | 'debug' | 'warn' | 'error',
  tag: string,
) {
  const original = base[method].bind(base) as ConsoleMethod
  base[method] = ((...args: unknown[]) => original(tag as never, ...(args as never[]))) as never
}

/**
 * Bind `target.stdout.write` for framing, then replace `target.console` with one
 * that sends all output to `target.stderr`, prefixed with a level tag. Returns
 * the bound frame writer.
 */
export function protectStdout(target: StdoutProtectionTarget): FrameWriter {
  const writeFrame = target.stdout.write.bind(target.stdout) as FrameWriter
  const redirected = new Console({ stdout: target.stderr, stderr: target.stderr })
  tagMethod(redirected, 'log', '[info]')
  tagMethod(redirected, 'info', '[info]')
  tagMethod(redirected, 'debug', '[debug]')
  tagMethod(redirected, 'warn', '[warn]')
  tagMethod(redirected, 'error', '[error]')
  target.console = redirected
  return writeFrame
}
