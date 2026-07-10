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
  type StdioTransport,
} from '@universe-editor/extensions-common'
import { scanExtensions } from './extensionScanner.js'
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
}
const extHostEditor: IExtHostEditor = {
  $acceptActiveEditorChange: async (editor) => {
    ;(await serviceReady).acceptActiveEditorChange(editor)
  },
}
const extHostWebviews: IExtHostWebviews = {
  $resolveCustomEditor: async (providerHandle, panelHandle, viewType, uri) => {
    await (await serviceReady).resolveCustomEditor(providerHandle, panelHandle, viewType, uri)
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
  const kind = process.env.UNIVERSE_EXT_HOST_KIND === 'restricted' ? 'restricted' : 'trusted'
  const locale = process.env.UNIVERSE_DISPLAY_LOCALE || undefined
  const dir =
    kind === 'restricted'
      ? process.env.UNIVERSE_USER_EXTENSIONS_DIR
      : process.env.UNIVERSE_BUILTIN_EXTENSIONS_DIR
  const extensions = dir ? await scanExtensions(dir, HOST_API_VERSION, locale) : []
  const disabled = new Set(
    (process.env.UNIVERSE_DISABLED_EXTENSIONS ?? '').split(',').filter(Boolean),
  )
  const activeExtensions =
    disabled.size > 0 ? extensions.filter((e) => !disabled.has(e.id)) : extensions
  if (!dir) {
    console.error(`[ext-host] no extensions directory configured for ${kind} host`)
  } else {
    console.error(
      `[ext-host] (${kind}) scanned ${extensions.length} extension(s) from ${dir}` +
        (disabled.size > 0 ? `, ${extensions.length - activeExtensions.length} disabled` : ''),
    )
  }

  const workspaceRoot = process.env.UNIVERSE_WORKSPACE_ROOT || undefined
  console.error(`[ext-host] workspace root: ${workspaceRoot ?? '(none)'}`)

  // AI is a trusted-only capability; the renderer registers mainThreadAi only on
  // the trusted connection, so don't even open the proxy in a restricted host.
  const mainThreadAi =
    kind === 'trusted'
      ? ProxyChannel.toService<IMainThreadAi>(client.getChannel(ExtHostChannels.mainThreadAi))
      : undefined

  resolveService(
    new ExtensionService(
      activeExtensions,
      mainThreadCommands,
      mainThreadWindow,
      mainThreadScm,
      workspaceRoot,
      mainThreadFs,
      kind,
      mainThreadOutput,
      mainThreadLanguages,
      mainThreadEditor,
      mainThreadAi,
      mainThreadStorage,
      mainThreadWebviews,
    ),
  )
  console.error(`[ext-host] ready (${kind})`)
}

void main().catch((err: unknown) => {
  console.error(`[ext-host] fatal: ${(err as Error).stack ?? String(err)}`)
  process.exit(1)
})

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
