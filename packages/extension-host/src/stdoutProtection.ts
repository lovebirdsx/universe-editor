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
 *
 * The host's stderr is mirrored verbatim into `extensionHost.log`, which can end
 * up in a user diagnostics bundle that leaves the machine — so every console
 * message is additionally capped in size here, before it reaches the stream.
 */
import { Console } from 'node:console'
import { Writable } from 'node:stream'

export interface StdoutProtectionTarget {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>
  readonly stderr: NodeJS.WriteStream
  console: Console
}

export type FrameWriter = (frame: string) => boolean

type ConsoleMethod = (...args: never[]) => void

// Upper bound for a single console message written to stderr. Host stderr is
// mirrored verbatim into extensionHost.log (and can leave the machine in a
// diagnostics bundle), so a stray `console.log` that dumps a whole document must
// not carry the full text out of the process.
export const MAX_LOG_MESSAGE_LENGTH = 8 * 1024

// Per-argument cap applied during inspect, so a single oversized string nested
// inside an object (e.g. a document's `_content`) is truncated before its full
// text is even serialized into the message buffer.
const MAX_LOG_ARGUMENT_STRING_LENGTH = 1024

function truncateMessage(text: string): string {
  if (text.length <= MAX_LOG_MESSAGE_LENGTH) return text
  const removed = text.length - MAX_LOG_MESSAGE_LENGTH
  return `${text.slice(0, MAX_LOG_MESSAGE_LENGTH)}[... ${removed} chars truncated ...]`
}

/**
 * A stderr stand-in that caps each write at {@link MAX_LOG_MESSAGE_LENGTH} and
 * forwards to the real stream. Console issues one `write` per log call, so capping
 * here bounds a whole message without touching Console's formatting.
 */
function createTruncatingStream(real: NodeJS.WriteStream): NodeJS.WriteStream {
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      real.write(truncateMessage(String(chunk)))
      callback()
    },
  })
  return sink as unknown as NodeJS.WriteStream
}

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
 * that sends all output to `target.stderr`, prefixed with a level tag and capped
 * in size. Returns the bound frame writer.
 */
export function protectStdout(target: StdoutProtectionTarget): FrameWriter {
  const writeFrame = target.stdout.write.bind(target.stdout) as FrameWriter
  const cappedStderr = createTruncatingStream(target.stderr)
  const redirected = new Console({
    stdout: cappedStderr,
    stderr: cappedStderr,
    inspectOptions: { maxStringLength: MAX_LOG_ARGUMENT_STRING_LENGTH },
  })
  tagMethod(redirected, 'log', '[info]')
  tagMethod(redirected, 'info', '[info]')
  tagMethod(redirected, 'debug', '[debug]')
  tagMethod(redirected, 'warn', '[warn]')
  tagMethod(redirected, 'error', '[error]')
  target.console = redirected
  return writeFrame
}
