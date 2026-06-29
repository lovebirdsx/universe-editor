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
 */
import { Console } from 'node:console'

export interface StdoutProtectionTarget {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>
  readonly stderr: NodeJS.WriteStream
  console: Console
}

export type FrameWriter = (frame: string) => boolean

/**
 * Bind `target.stdout.write` for framing, then replace `target.console` with one
 * that sends all output to `target.stderr`. Returns the bound frame writer.
 */
export function protectStdout(target: StdoutProtectionTarget): FrameWriter {
  const writeFrame = target.stdout.write.bind(target.stdout) as FrameWriter
  target.console = new Console({ stdout: target.stderr, stderr: target.stderr })
  return writeFrame
}
