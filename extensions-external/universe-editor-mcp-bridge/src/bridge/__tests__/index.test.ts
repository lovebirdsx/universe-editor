import { describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown, context: unknown) => Promise<unknown>>(),
  candidates: [
    { identity: { EditorPid: 501, InstanceId: 'first', ProjectPath: 'X:/workspace' } },
    { identity: { EditorPid: 502, InstanceId: 'second', ProjectPath: 'X:/workspace' } },
  ],
  connections: [] as number[],
  requests: [] as { pid: number; method: string; params: unknown }[],
}))

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(
      name: string,
      _schema: unknown,
      handler: (input: unknown, context: unknown) => Promise<unknown>,
    ) {
      testState.handlers.set(name, handler)
    }

    async connect() {}

    async sendLoggingMessage() {}
  },
  inputResponse: (responses: Record<string, unknown> | undefined, key: string) =>
    responses?.[key] ?? { kind: 'missing' },
  inputRequired: Object.assign(
    (requests: unknown) => ({ resultType: 'input-required', ...(requests as object) }),
    { elicit: (request: unknown) => request },
  ),
}))

vi.mock('@modelcontextprotocol/server/stdio', () => ({ StdioServerTransport: class {} }))
vi.mock('../editorDiscovery.js', () => ({ discoverEditors: async () => testState.candidates }))
vi.mock('../editorBridge.js', () => ({
  EditorCommandBridge: class {
    private readonly pid: number
    isConnected = false

    constructor(options: { editorPid: number }) {
      this.pid = options.editorPid
      testState.connections.push(this.pid)
    }

    async start() {
      this.isConnected = true
    }

    async sendRequest(method: string, params: unknown) {
      testState.requests.push({ pid: this.pid, method, params })
      return { Success: true, Result: { StructuredContent: { pid: this.pid } } }
    }

    async stop() {
      this.isConnected = false
    }
  },
}))

describe('MCP 入口多实例路由', () => {
  it('一个 bridge 的两个并发工具调用等待选择并只发往选中的 UE', async () => {
    await import('../index.js')
    const callTool = testState.handlers.get('ue_call_tool')!
    const controller = new AbortController()
    const request = (id: number, inputResponses?: Record<string, unknown>) => ({
      mcpReq: { id, inputResponses, signal: controller.signal },
    })
    const first = (await callTool({ ToolName: 'search_object' }, request(1))) as {
      resultType: string
      inputRequests: {
        editorSelection: {
          requestedSchema: { properties: { option: { oneOf: { const: string }[] } } }
        }
      }
    }
    expect(first.resultType).toBe('input-required')
    expect(
      first.inputRequests.editorSelection.requestedSchema.properties.option.oneOf.map(
        (option) => option.const,
      ),
    ).toEqual(['501:first', '502:second'])

    const waiting = callTool({ ToolName: 'search_object' }, request(2))
    const selected = await callTool(
      { ToolName: 'search_object' },
      request(1, {
        editorSelection: { kind: 'elicit', action: 'accept', content: { option: '502:second' } },
      }),
    )
    await waiting
    expect(selected, JSON.stringify(selected)).toMatchObject({ isError: false })
    expect(testState.connections).toEqual([502])
    expect(testState.requests).toEqual([
      { pid: 502, method: 'CallTool', params: { ToolName: 'search_object', Parameters: {} } },
      { pid: 502, method: 'CallTool', params: { ToolName: 'search_object', Parameters: {} } },
    ])
  })
})
