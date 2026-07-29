/** 协议版本号 */
export const EDITOR_MCP_PROTOCOL_VERSION = 3 as const

/** 协议信封类型 */
export const EditorMcpEnvelopeType = {
  /** 握手 */
  Handshake: 'Handshake',
  /** 请求 */
  Request: 'Request',
  /** 响应 */
  Response: 'Response',
} as const

/** 客户端类型 */
export const EditorMcpClientKind = {
  /** MCP 工具 */
  McpTool: 'mcp-tool',
} as const

/** 方法 */
export const EditorMcpMethod = {
  /** 调用工具 */
  CallTool: 'CallTool',
  /** 列出工具 */
  ListTools: 'ListTools',
} as const

/** 协议错误码 */
export const EditorMcpProtocolErrorCode = {
  /** 需要握手 */
  HandshakeRequired: 'HANDSHAKE_REQUIRED',
  /** 内部错误 */
  InternalError: 'INTERNAL_ERROR',
  /** 无效的 envelope */
  InvalidEnvelope: 'INVALID_ENVELOPE',
  /** 无效的 payload */
  InvalidPayload: 'INVALID_PAYLOAD',
  /** 未知的方法 */
  UnknownMethod: 'UNKNOWN_METHOD',
  /** 不支持的协议版本 */
  UnsupportedProtocolVersion: 'UNSUPPORTED_PROTOCOL_VERSION',
} as const

type TValue<T> = T[keyof T]

export type EditorMcpClientKind = TValue<typeof EditorMcpClientKind>
export type EditorMcpMethod = TValue<typeof EditorMcpMethod>
export type EditorMcpProtocolErrorCode = TValue<typeof EditorMcpProtocolErrorCode>

export interface EditorMcpProtocolError {
  readonly Code: EditorMcpProtocolErrorCode
  readonly Message: string
  readonly Data?: unknown
}

export interface EditorMcpHandshakeRequest {
  readonly Type: typeof EditorMcpEnvelopeType.Handshake
  readonly RequestId: string
  readonly ProtocolVersion: typeof EDITOR_MCP_PROTOCOL_VERSION
  readonly ClientKind: EditorMcpClientKind
  readonly ClientName: string
}

export interface EditorMcpRequestEnvelope {
  readonly Type: typeof EditorMcpEnvelopeType.Request
  readonly RequestId: string
  readonly Method: EditorMcpMethod
  readonly Params?: Record<string, unknown>
}

export interface EditorMcpResponseEnvelope {
  readonly Type: typeof EditorMcpEnvelopeType.Response
  readonly RequestId: string
  readonly Success: boolean
  readonly Result?: unknown
  readonly Error?: EditorMcpProtocolError
}

export type EditorMcpEnvelope =
  | EditorMcpHandshakeRequest
  | EditorMcpRequestEnvelope
  | EditorMcpResponseEnvelope

export type EditorMcpParseResult =
  | { readonly ok: true; readonly value: EditorMcpEnvelope }
  | { readonly ok: false; readonly error: EditorMcpProtocolError }

const clientKinds: ReadonlySet<string> = new Set(Object.values(EditorMcpClientKind))
const methods: ReadonlySet<string> = new Set(Object.values(EditorMcpMethod))
const errorCodes: ReadonlySet<string> = new Set(Object.values(EditorMcpProtocolErrorCode))

function failure(code: EditorMcpProtocolErrorCode, message: string): EditorMcpParseResult {
  return { ok: false, error: { Code: code, Message: message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function parseHandshake(value: Record<string, unknown>): EditorMcpParseResult {
  if (
    !hasOnlyKeys(
      value,
      new Set(['Type', 'RequestId', 'ProtocolVersion', 'ClientKind', 'ClientName']),
    )
  ) {
    return failure(EditorMcpProtocolErrorCode.InvalidEnvelope, 'Handshake contains unknown fields')
  }
  if (!isNonEmptyString(value.RequestId) || !isNonEmptyString(value.ClientName)) {
    return failure(
      EditorMcpProtocolErrorCode.InvalidPayload,
      'Handshake requires RequestId and ClientName',
    )
  }
  if (value.ProtocolVersion !== EDITOR_MCP_PROTOCOL_VERSION) {
    return failure(
      EditorMcpProtocolErrorCode.UnsupportedProtocolVersion,
      'Unsupported Editor MCP protocol version',
    )
  }
  if (typeof value.ClientKind !== 'string' || !clientKinds.has(value.ClientKind)) {
    return failure(EditorMcpProtocolErrorCode.InvalidPayload, 'Invalid Handshake ClientKind')
  }
  return { ok: true, value: value as unknown as EditorMcpHandshakeRequest }
}

function parseRequest(value: Record<string, unknown>): EditorMcpParseResult {
  if (!hasOnlyKeys(value, new Set(['Type', 'RequestId', 'Method', 'Params']))) {
    return failure(EditorMcpProtocolErrorCode.InvalidEnvelope, 'Request contains unknown fields')
  }
  if (!isNonEmptyString(value.RequestId)) {
    return failure(EditorMcpProtocolErrorCode.InvalidPayload, 'Request requires RequestId')
  }
  if (typeof value.Method !== 'string' || !methods.has(value.Method)) {
    return failure(EditorMcpProtocolErrorCode.UnknownMethod, 'Invalid Request Method')
  }
  if (value.Params !== undefined && !isRecord(value.Params)) {
    return failure(EditorMcpProtocolErrorCode.InvalidPayload, 'Request Params must be an object')
  }
  return { ok: true, value: value as unknown as EditorMcpRequestEnvelope }
}

function isProtocolError(value: unknown): value is EditorMcpProtocolError {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['Code', 'Message', 'Data']))) return false
  return (
    typeof value.Code === 'string' && errorCodes.has(value.Code) && isNonEmptyString(value.Message)
  )
}

function parseResponse(value: Record<string, unknown>): EditorMcpParseResult {
  if (!hasOnlyKeys(value, new Set(['Type', 'RequestId', 'Success', 'Result', 'Error']))) {
    return failure(EditorMcpProtocolErrorCode.InvalidEnvelope, 'Response contains unknown fields')
  }
  if (!isNonEmptyString(value.RequestId) || typeof value.Success !== 'boolean') {
    return failure(
      EditorMcpProtocolErrorCode.InvalidPayload,
      'Response requires RequestId and Success',
    )
  }
  if (value.Success) {
    if ('Error' in value)
      return failure(
        EditorMcpProtocolErrorCode.InvalidPayload,
        'Successful Response cannot contain Error',
      )
  } else if (!isProtocolError(value.Error) || 'Result' in value) {
    return failure(
      EditorMcpProtocolErrorCode.InvalidPayload,
      'Failed Response must contain only a valid Error',
    )
  }
  return { ok: true, value: value as unknown as EditorMcpResponseEnvelope }
}

export function parseEditorMcpEnvelope(text: string): EditorMcpParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return failure(
      EditorMcpProtocolErrorCode.InvalidEnvelope,
      'Editor MCP envelope is not valid JSON',
    )
  }
  if (!isRecord(value) || typeof value.Type !== 'string') {
    return failure(
      EditorMcpProtocolErrorCode.InvalidEnvelope,
      'Editor MCP envelope must be an object with Type',
    )
  }

  switch (value.Type) {
    case EditorMcpEnvelopeType.Handshake:
      return parseHandshake(value)
    case EditorMcpEnvelopeType.Request:
      return parseRequest(value)
    case EditorMcpEnvelopeType.Response:
      return parseResponse(value)
    default:
      return failure(EditorMcpProtocolErrorCode.InvalidEnvelope, 'Unknown Editor MCP envelope Type')
  }
}

export function serializeEditorMcpEnvelope(envelope: EditorMcpEnvelope): string {
  return JSON.stringify(envelope)
}
