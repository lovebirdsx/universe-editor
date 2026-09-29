import { inputRequired, inputResponse, McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import { readConfig } from './config.js'
import { EditorCommandBridge } from './editorBridge.js'
import { discoverEditors, type EditorCandidate } from './editorDiscovery.js'
import { EditorMcpMethod } from './protocol.js'

interface UniverseEditorMcpResponsePayload {
  readonly IsError?: boolean
  readonly StructuredContent: unknown
}

interface BridgeState {
  /** 当前已选定且可能仍在线的 UE 连接。 */
  bridge?: EditorCommandBridge
  /** 连接候选实例时共享的任务，防止重复建立连接。 */
  connecting?: Promise<EditorCommandBridge>
  /** 枚举及探测可用 UE 实例时共享的任务。 */
  discovering?: Promise<readonly EditorCandidate[]>
  /** 等待用户确认的实例选择及其并发调用门闩。 */
  selection?: {
    /** 发起选择的 MCP 请求 ID，续传时据此匹配。 */
    requestId: string | number
    /** 防止同一选择响应被并行处理两次。 */
    processing?: boolean
    /** 弹窗展示时已探测到的实例。 */
    candidates: readonly EditorCandidate[]
    /** 其他并发工具调用等待选定连接的任务。 */
    promise: Promise<EditorCommandBridge>
    /** 选择成功后放行等待中的调用。 */
    resolve: (bridge: EditorCommandBridge) => void
    /** 取消或连接失败后拒绝等待中的调用。 */
    reject: (reason: Error) => void
    /** 选择超时后释放门闩。 */
    timer: NodeJS.Timeout
  }
  /** 旧连接失效后，即使只剩一个候选也必须重新确认。 */
  needsConfirmation: boolean
}

const askUserInputSchema = z.object({
  Message: z.string().min(1),
  Title: z.string().min(1).optional(),
  Options: z
    .array(
      z.object({
        Label: z.string().min(1),
        Description: z.string().optional(),
      }),
    )
    .min(1),
  Input: z
    .object({
      Label: z.string().min(1),
      Placeholder: z.string().optional(),
    })
    .optional(),
})

function createTextContent(
  payload: UniverseEditorMcpResponsePayload,
): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(payload.StructuredContent ?? {}) }]
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

async function main(): Promise<void> {
  const config = readConfig()
  const server = new McpServer({
    name: 'universe-editor-mcp-bridge',
    version: '0.1.1',
  })

  const log = (message: string): void => {
    console.error(`[universe-editor-mcp] ${message}`)
    void server.sendLoggingMessage({ level: 'info', data: `[universe-editor-mcp] ${message}` })
  }

  const state: BridgeState = { needsConfirmation: false }
  const currentBridge = (): EditorCommandBridge | undefined => state.bridge
  const currentSelection = (): typeof state.selection => state.selection

  const connectCandidate = async (candidate: EditorCandidate): Promise<EditorCommandBridge> => {
    if (state.connecting) return state.connecting
    state.connecting = (async () => {
      const { identity } = candidate
      const editorPid = identity.EditorPid
      const bridge = new EditorCommandBridge({
        editorPid,
        timeoutMs: config.timeoutMs,
        connectTimeoutMs: config.connectTimeoutMs,
        expectedIdentity: identity,
        onLog: log,
        onDisconnect: () => {
          if (state.bridge === bridge) {
            delete state.bridge
            state.needsConfirmation = true
            log(`UE pid=${editorPid} 连接已失效，需要重新确认目标`)
          }
        },
      })
      await bridge.start()
      if (state.bridge?.isConnected) {
        await bridge.stop()
        return state.bridge
      }
      state.bridge = bridge
      state.needsConfirmation = false
      log(`selected editor pid=${editorPid}`)
      return bridge
    })()
    try {
      return await state.connecting
    } finally {
      delete state.connecting
    }
  }

  const requireBridge = async (context: {
    mcpReq: { id: string | number; inputResponses?: Record<string, unknown>; signal: AbortSignal }
  }) => {
    const submittedSelection = inputResponse(context.mcpReq.inputResponses, 'editorSelection')
    if (state.bridge?.isConnected) {
      if (submittedSelection.kind !== 'missing')
        throw new Error('UE 实例选择已过期，请重新发起调用')
      return state.bridge
    }
    if (state.bridge) {
      delete state.bridge
      state.needsConfirmation = true
    }
    const pendingSelection = state.selection
    const response = submittedSelection
    if (pendingSelection && pendingSelection.requestId !== context.mcpReq.id)
      return pendingSelection.promise
    if (!pendingSelection && response.kind !== 'missing') {
      throw new Error('UE 实例选择已过期，请重新发起调用')
    }
    if (state.connecting) return state.connecting

    const finishSelection = async (selection: NonNullable<typeof state.selection>) => {
      if (selection.processing) return selection.promise
      selection.processing = true
      if (response.kind !== 'elicit' || response.action !== 'accept') {
        selection.reject(new Error('已取消 UE 实例选择'))
        clearTimeout(selection.timer)
        delete state.selection
        throw new Error('已取消 UE 实例选择')
      }
      const candidate = selection.candidates.find(
        (entry) =>
          `${entry.identity.EditorPid}:${entry.identity.InstanceId}` === response.content?.option,
      )
      if (!candidate) {
        selection.reject(new Error('UE 实例选择无效或已过期'))
        clearTimeout(selection.timer)
        delete state.selection
        throw new Error('UE 实例选择无效或已过期')
      }
      try {
        const bridge = await connectCandidate(candidate)
        selection.resolve(bridge)
        return bridge
      } catch (error) {
        selection.reject(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        clearTimeout(selection.timer)
        if (state.selection === selection) delete state.selection
      }
    }
    if (pendingSelection) return finishSelection(pendingSelection)

    if (!state.discovering) {
      state.discovering = discoverEditors({ connectTimeoutMs: config.connectTimeoutMs, onLog: log })
    }
    const discovering = state.discovering
    let candidates: readonly EditorCandidate[]
    try {
      candidates = await discovering
    } finally {
      if (state.discovering === discovering) delete state.discovering
    }
    const connected = currentBridge()
    if (connected?.isConnected) return connected
    const activeSelection = currentSelection()
    if (activeSelection) {
      if (activeSelection.requestId !== context.mcpReq.id) return activeSelection.promise
      return finishSelection(activeSelection)
    }
    if (state.connecting) return state.connecting
    if (candidates.length === 1 && !state.needsConfirmation) return connectCandidate(candidates[0]!)
    let resolveSelection!: (bridge: EditorCommandBridge) => void
    let rejectSelection!: (reason: Error) => void
    const promise = new Promise<EditorCommandBridge>((resolve, reject) => {
      resolveSelection = resolve
      rejectSelection = reject
    })
    void promise.catch(() => {})
    const selection = {
      requestId: context.mcpReq.id,
      candidates,
      promise,
      resolve: resolveSelection,
      reject: rejectSelection,
      timer: setTimeout(
        () => {
          if (state.selection !== selection) return
          delete state.selection
          rejectSelection(new Error('UE 实例选择超时，请重试'))
        },
        10 * 60 * 1000,
      ),
    }
    state.selection = selection
    context.mcpReq.signal.addEventListener(
      'abort',
      () => {
        if (state.selection !== selection) return
        delete state.selection
        clearTimeout(selection.timer)
        selection.reject(new Error('UE 实例选择已中断'))
      },
      { once: true },
    )
    return inputRequired({
      inputRequests: {
        editorSelection: inputRequired.elicit({
          message: state.needsConfirmation
            ? '原 UE 连接已失效，请确认要重新连接的实例'
            : '检测到多个 UE 实例，请选择本次连接的目标',
          requestedSchema: {
            type: 'object',
            properties: {
              option: {
                type: 'string',
                title: 'UE 实例',
                oneOf: candidates.map(({ identity, startTime }) => {
                  const startedAt =
                    startTime === undefined
                      ? '未知时间'
                      : new Date(startTime).toLocaleString('zh-CN', { hour12: false })
                  return {
                    const: `${identity.EditorPid}:${identity.InstanceId}`,
                    title: `PID ${identity.EditorPid} - 启动于 ${startedAt} - ${identity.ProjectPath}`,
                  }
                }),
              },
            },
            required: ['option'],
          },
        }),
      },
    })
  }

  server.registerTool(
    'ue_ask_user',
    {
      description:
        'Ask the user a question in the chat UI. Use this when a Universe Editor operation needs the user to choose among explicit options or provide optional free-form input.',
      inputSchema: askUserInputSchema,
    },
    async ({ Input, Message, Options, Title }: z.infer<typeof askUserInputSchema>, context) => {
      const response = inputResponse(context.mcpReq.inputResponses, 'userResponse')
      if (response.kind === 'missing') {
        return inputRequired({
          inputRequests: {
            userResponse: inputRequired.elicit({
              message: Message,
              requestedSchema: {
                type: 'object',
                properties: {
                  option: {
                    type: 'string',
                    title: Title ?? '选择',
                    oneOf: Options.map(
                      (option: { Label: string; Description?: string | undefined }) => ({
                        const: option.Label,
                        title: option.Description
                          ? `${option.Label} - ${option.Description}`
                          : option.Label,
                      }),
                    ),
                  },
                  ...(Input
                    ? {
                        input: {
                          type: 'string' as const,
                          title: Input.Label,
                          ...(Input.Placeholder ? { description: Input.Placeholder } : {}),
                        },
                      }
                    : {}),
                },
                required: ['option'],
              },
            }),
          },
        })
      }

      const result =
        response.kind === 'elicit'
          ? { action: response.action, ...(response.content ? { content: response.content } : {}) }
          : { action: 'cancel' }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      }
    },
  )

  server.registerTool(
    'ue_list_tools',
    {
      description:
        'List all UniverseEditor tools with full input schema. Pure pass-through: returns the editor side response verbatim. ' +
        'Typical workflow: ue_list_tools -> search_object (semantic keyword) or search_field (numeric ID / value match) -> read_object (candidate uid) -> optionally search_reference for reference graph. ' +
        'Call this first to discover available tools.',
      inputSchema: z.object({}),
    },
    async (_input, context) => {
      try {
        const bridge = await requireBridge(context)
        if ('resultType' in bridge) return bridge
        const response = await bridge.sendRequest(EditorMcpMethod.ListTools)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response.Result ?? {}) }],
          isError: !response.Success,
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
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
    async ({ Parameters, ToolName }, context) => {
      try {
        const bridge = await requireBridge(context)
        if ('resultType' in bridge) return bridge
        const response = await bridge.sendRequest(EditorMcpMethod.CallTool, {
          ToolName,
          Parameters: Parameters ?? {},
        })
        if (!response.Success) return toolError(response.Error?.Message ?? 'UE 工具调用失败')
        const payload = response.Result as UniverseEditorMcpResponsePayload
        return {
          content: createTextContent(payload),
          isError: payload.IsError ?? false,
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const shutdown = async (): Promise<void> => {
    if (state.selection) {
      clearTimeout(state.selection.timer)
      state.selection.reject(new Error('Bridge stopped'))
      delete state.selection
    }
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
