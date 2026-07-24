import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import { readConfig } from './config.js'
import { EditorCommandBridge } from './editorBridge.js'
import { resolveEditorPid } from './editorDiscovery.js'

interface UniverseEditorMcpResponsePayload {
  readonly IsError?: boolean
  readonly StructuredContent: unknown
}

function createTextContent(
  payload: UniverseEditorMcpResponsePayload,
): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(payload.StructuredContent ?? {}) }]
}

async function main(): Promise<void> {
  const config = readConfig()
  const server = new McpServer({
    name: 'universe-editor-mcp-bridge',
    version: '0.1.0',
  })

  const log = (message: string): void => {
    console.error(`[universe-editor-mcp] ${message}`)
    void server.sendLoggingMessage({ level: 'info', data: `[universe-editor-mcp] ${message}` })
  }

  const state: { bridge?: EditorCommandBridge; connecting?: Promise<EditorCommandBridge> } = {}
  const requireBridge = async (): Promise<EditorCommandBridge> => {
    if (state.bridge) return state.bridge
    if (state.connecting) return state.connecting

    state.connecting = (async () => {
      const editorPid = await resolveEditorPid({
        ...(config.editorPid !== undefined ? { explicitPid: config.editorPid } : {}),
        onLog: log,
      })
      const bridge = new EditorCommandBridge({
        editorPid,
        timeoutMs: config.timeoutMs,
        connectTimeoutMs: config.connectTimeoutMs,
        onLog: log,
      })
      log(`resolved editor pid=${editorPid}`)
      await bridge.start()
      state.bridge = bridge
      delete state.connecting
      return bridge
    })()

    try {
      return await state.connecting
    } catch (error) {
      delete state.connecting
      throw error
    }
  }

  server.registerTool(
    'ue_list_tools',
    {
      description:
        'List all UniverseEditor tools with full input schema. Pure pass-through: returns the editor side response verbatim. ' +
        'Typical workflow: ue_list_tools -> search_object (semantic keyword) or search_field (numeric ID / value match) -> read_object (candidate uid) -> optionally search_reference for reference graph. ' +
        'Call this first to discover available tools.',
      inputSchema: z.object({}),
    },
    async () => {
      const bridge = await requireBridge()
      const response = await bridge.sendRequest('ListTools')
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.Result ?? {}) }],
        isError: !response.Success,
      }
    },
  )

  server.registerTool(
    'ue_call_tool',
    {
      description:
        'Call a UniverseEditor tool through the v2 editor connection. Use ue_list_tools to discover available tools and their full input schema.',
      inputSchema: z.object({
        ToolName: z.string().min(1).describe('UniverseEditor tool name'),
        Parameters: z.record(z.string(), z.unknown()).optional().describe('Tool input parameters'),
      }),
    },
    async ({ Parameters, ToolName }) => {
      const bridge = await requireBridge()
      const response = await bridge.sendRequest('CallTool', {
        ToolName,
        Parameters: Parameters ?? {},
      })
      const payload = response.Result as UniverseEditorMcpResponsePayload
      return {
        content: createTextContent(payload),
        isError: payload.IsError ?? !response.Success,
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const shutdown = async (): Promise<void> => {
    await state.bridge?.stop()
    await server.close()
  }

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0))
  })
}

main().catch((error: unknown) => {
  console.error('Universe Editor MCP bridge failed to start:', error)
  process.exit(1)
})
