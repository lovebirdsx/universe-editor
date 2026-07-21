/**
 * Extension Host bootstrap — runs in a separate Node process spawned by the
 * main process through Electron's own runtime (ELECTRON_RUN_AS_NODE). The
 * renderer is the RPC peer; the main process is only a byte pipe over stdio.
 *
 * Wiring: a ChannelServer exposes the ExtHost* channels the renderer calls, and
 * a ChannelClient opens the MainThread* channels the host calls back on (over
 * the same full-duplex protocol). The ExtensionService scans the built-in
 * extensions directory and drives lazy activation.
 *
 * IMPORTANT: stdout carries the RPC wire — nothing else may be written there.
 * All diagnostics go to stderr (console.error), which main forwards as onStderr.
 * To keep that invariant against stray library logging (e.g. a debug
 * `console.log` inside a language-service dependency), we capture the real
 * stdout for framing and then point every stdout-bound `console.*` at stderr.
 */
import { ChannelClient, ChannelServer, Emitter, ProxyChannel } from '@universe-editor/platform'
import {
  ExtHostChannels,
  StdioFramingProtocol,
  type IExtHostCommands,
  type IExtHostDocuments,
  type IExtHostEditor,
  type IExtHostExtensions,
  type IExtHostLanguages,
  type IExtHostScm,
  type IExtHostWebviews,
  type IMainThreadAi,
  type IMainThreadCommands,
  type IMainThreadEditor,
  type IMainThreadFs,
  type IMainThreadLanguages,
  type IMainThreadOutput,
  type IMainThreadScm,
  type IMainThreadWebviews,
  type IMainThreadWindow,
  type IMainThreadStorage,
  type IMainThreadExtensions,
  type StdioTransport,
} from '@universe-editor/extensions-common'
import { scanExtensions } from './extensionScanner.js'
import { computeActiveExtensions, parseIdSet } from './extensionActivationFilter.js'
import { ExtensionService } from './extensionService.js'
import { protectStdout } from './stdoutProtection.js'
import { version as HOST_API_VERSION } from '@universe-editor/extension-api'

// stdout IS the RPC wire — protect it before any extension (and its bundled
// dependencies) can run a stray `console.log` that would corrupt a frame. This
// binds the real stdout writer for framing and routes all console.* to stderr.
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

process.on('unhandledRejection', (reason: unknown) => {
  console.error(`[ext-host] unhandled rejection: ${formatUnknownError(reason)}`)
})

// Without this, an uncaught synchronous throw exits with the stack on stderr but
// no marker — and on a fast exit that stderr can be lost before main drains the
// pipe. Log it explicitly (main persists host stderr to extensionHost.log) so a
// crash is always diagnosable, then exit(1) to keep Node's default crash
// semantics (which drives the renderer's crash-restart).
process.on('uncaughtException', (err: unknown) => {
  try {
    console.error(`[ext-host] uncaught exception: ${formatUnknownError(err)}`)
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
const server = new ChannelServer(protocol)
const client = new ChannelClient(protocol)

const mainThreadCommands = ProxyChannel.toService<IMainThreadCommands>(
  client.getChannel(ExtHostChannels.mainThreadCommands),
)
const mainThreadWindow = ProxyChannel.toService<IMainThreadWindow>(
  client.getChannel(ExtHostChannels.mainThreadWindow),
)
const mainThreadScm = ProxyChannel.toService<IMainThreadScm>(
  client.getChannel(ExtHostChannels.mainThreadScm),
)
const mainThreadFs = ProxyChannel.toService<IMainThreadFs>(
  client.getChannel(ExtHostChannels.mainThreadFs),
)
const mainThreadOutput = ProxyChannel.toService<IMainThreadOutput>(
  client.getChannel(ExtHostChannels.mainThreadOutput),
)
const mainThreadLanguages = ProxyChannel.toService<IMainThreadLanguages>(
  client.getChannel(ExtHostChannels.mainThreadLanguages),
)
const mainThreadEditor = ProxyChannel.toService<IMainThreadEditor>(
  client.getChannel(ExtHostChannels.mainThreadEditor),
)
const mainThreadStorage = ProxyChannel.toService<IMainThreadStorage>(
  client.getChannel(ExtHostChannels.mainThreadStorage),
)
const mainThreadWebviews = ProxyChannel.toService<IMainThreadWebviews>(
  client.getChannel(ExtHostChannels.mainThreadWebviews),
)
const mainThreadExtensions = ProxyChannel.toService<IMainThreadExtensions>(
  client.getChannel(ExtHostChannels.mainThreadExtensions),
)

// Register channels synchronously so a renderer call that races the async scan
// queues on `serviceReady` instead of hitting a "channel not found" error.
let resolveService!: (service: ExtensionService) => void
let liveService: ExtensionService | undefined
const serviceReady = new Promise<ExtensionService>((resolve) => {
  resolveService = (service) => {
    liveService = service
    resolve(service)
  }
})

// Graceful shutdown: when the parent (main process) goes away it closes our
// stdin pipe (`end`), and it may also SIGTERM us. Either way, tear down the
// activated extensions so they can kill child processes they spawned — most
// importantly the typescript plugin's tsserver, which otherwise re-parents to
// the OS and lingers (leaking electron.exe, blocking Playwright teardown on
// Windows where killing our PID does not cascade). Runs at most once; best-effort
// and fast (the parent is already leaving), then exit so the pipe EOFs.
let didShutdown = false
function shutdown(reason: string): void {
  if (didShutdown) return
  didShutdown = true
  console.error(`[ext-host] shutdown (${reason})`)
  try {
    // Dispose only if the service is already up; never block shutdown on an
    // in-flight scan (the parent is leaving now).
    liveService?.dispose()
  } catch (err) {
    console.error(`[ext-host] shutdown dispose failed: ${(err as Error).message}`)
  }
  process.exit(0)
}
process.stdin.on('end', () => shutdown('stdin end'))
process.stdin.on('close', () => shutdown('stdin close'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

const extHostCommands: IExtHostCommands = {
  $executeContributedCommand: async (id, args) =>
    (await serviceReady).executeContributedCommand(id, args),
}
const extHostExtensions: IExtHostExtensions = {
  $getContributions: async () => (await serviceReady).getContributions(),
  $activateByEvent: async (event) => {
    await (await serviceReady).activateByEvent(event)
  },
  $initializeWorkspaceTrust: async (trusted) => {
    ;(await serviceReady).initializeWorkspaceTrust(trusted)
  },
  $onDidGrantWorkspaceTrust: async () => {
    await (await serviceReady).grantWorkspaceTrust()
  },
}
const extHostScm: IExtHostScm = {
  $onInputBoxValueChange: async (handle, value) => {
    ;(await serviceReady).onInputBoxValueChange(handle, value)
  },
}
const extHostLanguages: IExtHostLanguages = {
  $provideDefinition: async (handle, uri, position) =>
    (await serviceReady).provideDefinition(handle, uri, position),
  $provideReferences: async (handle, uri, position, context) =>
    (await serviceReady).provideReferences(handle, uri, position, context),
  $provideImplementation: async (handle, uri, position) =>
    (await serviceReady).provideImplementation(handle, uri, position),
  $provideTypeDefinition: async (handle, uri, position) =>
    (await serviceReady).provideTypeDefinition(handle, uri, position),
  $provideHover: async (handle, uri, position) =>
    (await serviceReady).provideHover(handle, uri, position),
  $provideCompletion: async (handle, uri, position, context) =>
    (await serviceReady).provideCompletion(handle, uri, position, context),
  $resolveCompletionItem: async (handle, item) =>
    (await serviceReady).resolveCompletionItem(handle, item),
  $provideSignatureHelp: async (handle, uri, position, context) =>
    (await serviceReady).provideSignatureHelp(handle, uri, position, context),
  $provideDocumentSymbols: async (handle, uri) =>
    (await serviceReady).provideDocumentSymbols(handle, uri),
  $provideRenameEdits: async (handle, uri, position, newName) =>
    (await serviceReady).provideRenameEdits(handle, uri, position, newName),
  $provideWorkspaceSymbols: async (handle, query) =>
    (await serviceReady).provideWorkspaceSymbols(handle, query),
  $provideFoldingRanges: async (handle, uri) =>
    (await serviceReady).provideFoldingRanges(handle, uri),
  $provideDocumentLinks: async (handle, uri) =>
    (await serviceReady).provideDocumentLinks(handle, uri),
  $resolveDocumentLink: async (handle, link) =>
    (await serviceReady).resolveDocumentLink(handle, link),
  $provideDocumentHighlights: async (handle, uri, position) =>
    (await serviceReady).provideDocumentHighlights(handle, uri, position),
  $provideSelectionRanges: async (handle, uri, positions) =>
    (await serviceReady).provideSelectionRanges(handle, uri, positions),
  $provideCodeActions: async (handle, uri, range, context) =>
    (await serviceReady).provideCodeActions(handle, uri, range, context),
  $provideDocumentFormattingEdits: async (handle, uri, options) =>
    (await serviceReady).provideDocumentFormattingEdits(handle, uri, options),
  $provideDocumentSemanticTokens: async (handle, uri) =>
    (await serviceReady).provideDocumentSemanticTokens(handle, uri),
  $provideCodeLenses: async (handle, uri) => (await serviceReady).provideCodeLenses(handle, uri),
  $resolveCodeLens: async (handle, lens) => (await serviceReady).resolveCodeLens(handle, lens),
}
const extHostDocuments: IExtHostDocuments = {
  $acceptDocumentOpen: async (uri, languageId, version, text) => {
    ;(await serviceReady).acceptDocumentOpen(uri, languageId, version, text)
  },
  $acceptDocumentChange: async (uri, version, text) => {
    ;(await serviceReady).acceptDocumentChange(uri, version, text)
  },
  $acceptDocumentClose: async (uri) => {
    ;(await serviceReady).acceptDocumentClose(uri)
  },
  $provideWillSaveEdits: async (uri, reason) =>
    (await serviceReady).provideWillSaveEdits(uri, reason),
}
const extHostEditor: IExtHostEditor = {
  $acceptActiveEditorChange: async (editor) => {
    ;(await serviceReady).acceptActiveEditorChange(editor)
  },
}
const extHostWebviews: IExtHostWebviews = {
  $resolveCustomEditor: async (providerHandle, panelHandle, viewType, uri, diff) => {
    await (await serviceReady).resolveCustomEditor(providerHandle, panelHandle, viewType, uri, diff)
  },
  $onDidReceiveMessage: async (panelHandle, message) => {
    ;(await serviceReady).acceptWebviewMessage(panelHandle, message)
  },
  $disposeWebviewPanel: async (panelHandle) => {
    ;(await serviceReady).disposeWebviewPanel(panelHandle)
  },
}

server.registerChannel(ExtHostChannels.extHostCommands, ProxyChannel.fromService(extHostCommands))
server.registerChannel(
  ExtHostChannels.extHostExtensions,
  ProxyChannel.fromService(extHostExtensions),
)
server.registerChannel(ExtHostChannels.extHostScm, ProxyChannel.fromService(extHostScm))
server.registerChannel(ExtHostChannels.extHostLanguages, ProxyChannel.fromService(extHostLanguages))
server.registerChannel(ExtHostChannels.extHostDocuments, ProxyChannel.fromService(extHostDocuments))
server.registerChannel(ExtHostChannels.extHostEditor, ProxyChannel.fromService(extHostEditor))
server.registerChannel(ExtHostChannels.extHostWebviews, ProxyChannel.fromService(extHostWebviews))

async function main(): Promise<void> {
  const locale = process.env.UNIVERSE_DISPLAY_LOCALE || undefined
  // A single local host scans both the built-in dir and the user (external) dir;
  // trust is a runtime gate, not a process split. Built-in first so a built-in
  // extension wins an id collision with a user extension.
  const dirs = [
    { dir: process.env.UNIVERSE_BUILTIN_EXTENSIONS_DIR, builtin: true },
    { dir: process.env.UNIVERSE_USER_EXTENSIONS_DIR, builtin: false },
  ].filter((d): d is { dir: string; builtin: boolean } => !!d.dir)
  const scanned = (
    await Promise.all(dirs.map((d) => scanExtensions(d.dir, d.builtin, HOST_API_VERSION, locale)))
  ).flat()
  // De-dupe by id (built-in wins over user), then apply the disabled set and the
  // optional allowlist (e2e minimal-extension-set). See extensionActivationFilter.
  const disabled = parseIdSet(process.env.UNIVERSE_DISABLED_EXTENSIONS)
  const allowlist = parseIdSet(process.env.UNIVERSE_ENABLED_EXTENSIONS)
  const { deduped: extensions, active: activeExtensions } = computeActiveExtensions(scanned, {
    ...(disabled !== undefined ? { disabled } : {}),
    ...(allowlist !== undefined ? { allowlist } : {}),
  })
  if (dirs.length === 0) {
    console.error('[ext-host] no extensions directory configured')
  } else {
    console.error(
      `[ext-host] scanned ${extensions.length} extension(s) from [${dirs
        .map((d) => d.dir)
        .join(', ')}]` +
        (allowlist !== undefined
          ? `, allowlist active → ${activeExtensions.length} enabled [${activeExtensions
              .map((e) => e.id)
              .join(', ')}]`
          : disabled !== undefined && disabled.size > 0
            ? `, ${extensions.length - activeExtensions.length} disabled`
            : ''),
    )
  }

  const workspaceRoot = process.env.UNIVERSE_WORKSPACE_ROOT || undefined
  console.error(`[ext-host] workspace root: ${workspaceRoot ?? '(none)'}`)

  // Parent dir for per-extension persistent storage (`<home>/<extId>`).
  const globalStorageHome = process.env.UNIVERSE_GLOBAL_STORAGE_DIR || undefined

  const mainThreadAi = ProxyChannel.toService<IMainThreadAi>(
    client.getChannel(ExtHostChannels.mainThreadAi),
  )

  resolveService(
    new ExtensionService(
      activeExtensions,
      mainThreadCommands,
      mainThreadWindow,
      mainThreadScm,
      workspaceRoot,
      mainThreadFs,
      mainThreadOutput,
      mainThreadLanguages,
      mainThreadEditor,
      mainThreadAi,
      mainThreadStorage,
      mainThreadWebviews,
      globalStorageHome,
      mainThreadExtensions,
    ),
  )
  console.error('[ext-host] ready')
}

void main().catch((err: unknown) => {
  console.error(`[ext-host] fatal: ${(err as Error).stack ?? String(err)}`)
  process.exit(1)
})

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
