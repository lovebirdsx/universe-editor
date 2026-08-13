/**
 * Remote server bootstrap — a headless Node process the local editor spawns over
 * ssh (`ssh user@host universe-editor-server`) or, in e2e, directly via
 * `node dist/bootstrap.js`. stdout carries the RPC wire and nothing else; every
 * diagnostic goes to stderr. The server only ever sees `file:` URIs, so this is
 * a headless local file-service stack (filesystem, search, watcher).
 */
import {
  AbstractLogger,
  ChannelPair,
  Emitter,
  REMOTE_PROTOCOL_VERSION,
  type LogLevel,
} from '@universe-editor/platform'
import { StdioFramingProtocol, type StdioTransport } from '@universe-editor/extensions-common'
import { createRemoteServer } from './server.js'
import { protectStdout } from './stdoutProtection.js'

// stdout IS the RPC wire — protect it before any bundled dependency can run a
// stray console.log that would corrupt a frame. Binds the real stdout writer for
// framing and routes all console.* to stderr.
const writeFrame = protectStdout({
  stdout: process.stdout,
  stderr: process.stderr,
  set console(c) {
    globalThis.console = c
  },
  get console() {
    return globalThis.console
  },
})

/** Logger for the server's own diagnostics; writes raw lines to stderr. */
class StderrLogger extends AbstractLogger {
  protected override _log(_level: LogLevel, message: string): void {
    process.stderr.write(`${message}\n`)
  }
}

process.on('unhandledRejection', (reason: unknown) => {
  console.error(`[remote-server] unhandled rejection: ${formatUnknownError(reason)}`)
})

// An uncaught synchronous throw would otherwise exit with a bare stack that can
// be lost before the ssh client drains the pipe; log it explicitly, then exit(1)
// to keep Node's default crash semantics.
process.on('uncaughtException', (err: unknown) => {
  try {
    console.error(`[remote-server] uncaught exception: ${formatUnknownError(err)}`)
  } finally {
    process.exit(1)
  }
})

const onData = new Emitter<string>()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => onData.fire(chunk))

const transport: StdioTransport = {
  write: (frame) => {
    writeFrame(frame)
  },
  onData: onData.event,
}

const protocol = new StdioFramingProtocol(transport)
const { server } = new ChannelPair(protocol)

const log = new StderrLogger()
const serverDisposable = createRemoteServer(server, log)
log.info(`[remote-server] ready (protocol v${REMOTE_PROTOCOL_VERSION})`)

// Graceful shutdown: the ssh session ends (stdin EOF/close) or we are SIGTERMed.
// Runs at most once; dispose the services (notably the watcher, which must
// release native subscriptions) and exit 0.
let didShutdown = false
function shutdown(reason: string): void {
  if (didShutdown) return
  didShutdown = true
  log.info(`[remote-server] shutdown (${reason})`)
  try {
    serverDisposable.dispose()
  } catch (err) {
    log.error(`[remote-server] shutdown dispose failed: ${(err as Error).message}`)
  }
  process.exit(0)
}
process.stdin.on('end', () => shutdown('stdin end'))
process.stdin.on('close', () => shutdown('stdin close'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
