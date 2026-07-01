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
  type IMainThreadAi,
  type IMainThreadCommands,
  type IMainThreadEditor,
  type IMainThreadFs,
  type IMainThreadLanguages,
  type IMainThreadOutput,
  type IMainThreadScm,
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

// Register channels synchronously so a renderer call that races the async scan
// queues on `serviceReady` instead of hitting a "channel not found" error.
let resolveService!: (service: ExtensionService) => void
const serviceReady = new Promise<ExtensionService>((resolve) => {
  resolveService = resolve
})

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

server.registerChannel(ExtHostChannels.extHostCommands, ProxyChannel.fromService(extHostCommands))
server.registerChannel(
  ExtHostChannels.extHostExtensions,
  ProxyChannel.fromService(extHostExtensions),
)
server.registerChannel(ExtHostChannels.extHostScm, ProxyChannel.fromService(extHostScm))
server.registerChannel(ExtHostChannels.extHostLanguages, ProxyChannel.fromService(extHostLanguages))
server.registerChannel(ExtHostChannels.extHostDocuments, ProxyChannel.fromService(extHostDocuments))
server.registerChannel(ExtHostChannels.extHostEditor, ProxyChannel.fromService(extHostEditor))

async function main(): Promise<void> {
  const kind = process.env.UNIVERSE_EXT_HOST_KIND === 'restricted' ? 'restricted' : 'trusted'
  const locale = process.env.UNIVERSE_DISPLAY_LOCALE || undefined
  const dir =
    kind === 'restricted'
      ? process.env.UNIVERSE_USER_EXTENSIONS_DIR
      : process.env.UNIVERSE_BUILTIN_EXTENSIONS_DIR
  const extensions = dir ? await scanExtensions(dir, HOST_API_VERSION, locale) : []
  if (!dir) {
    console.error(`[ext-host] no extensions directory configured for ${kind} host`)
  } else {
    console.error(`[ext-host] (${kind}) scanned ${extensions.length} extension(s) from ${dir}`)
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
      extensions,
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
