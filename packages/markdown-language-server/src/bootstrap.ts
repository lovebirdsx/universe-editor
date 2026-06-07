/**
 * Markdown Language Server bootstrap — runs in a separate Node process spawned by
 * the main process through Electron's own runtime (ELECTRON_RUN_AS_NODE). The
 * main process is the RPC peer (LSP client host): it calls this server's
 * MdServer channel for language features + document sync, and answers the
 * server's MdClient channel for filesystem access.
 *
 * IMPORTANT: stdout carries the RPC wire — nothing else may be written there.
 * All diagnostics go to stderr (console.error), which main forwards to its log.
 */
import { ChannelClient, ChannelServer, Emitter, ProxyChannel } from '@universe-editor/platform'
import { StdioFramingProtocol, type StdioTransport } from '@universe-editor/extensions-common'
import { URI } from 'vscode-uri'
import { MdServerChannels, type IMdClient } from './protocol.js'
import { createMdServer } from './mdServer.js'

// #region RPC wiring (full-duplex stdio)

const onData = new Emitter<string>()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => onData.fire(chunk))

const transport: StdioTransport = {
  write: (frame) => {
    process.stdout.write(frame)
  },
  onData: onData.event,
}

const protocol = new StdioFramingProtocol(transport)
const server = new ChannelServer(protocol)
const client = new ChannelClient(protocol)
const mdClient = ProxyChannel.toService<IMdClient>(client.getChannel(MdServerChannels.client))

// #endregion

const workspaceRoot = process.env.UNIVERSE_MD_WORKSPACE_ROOT || undefined
const root = workspaceRoot ? URI.file(workspaceRoot) : undefined

const { server: mdServer } = createMdServer(mdClient, root)
server.registerChannel(MdServerChannels.server, ProxyChannel.fromService(mdServer))

console.error(`[md-ls] ready (workspace: ${workspaceRoot ?? '(none)'})`)
