export const EDITOR_MCP_PROTOCOL_VERSION = 2 as const

export type EditorMcpClientKind = 'mcp-tool' | 'universe-host-control'
export type EditorMcpMethod = 'CallTool' | 'ListTools'
export type EditorMcpNotificationEvent =
  | 'ActiveContextChanged'
  | 'AgentFixRequested'
  | 'ValidationSnapshotChanged'

export type EditorMcpProtocolErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'HANDSHAKE_REQUIRED'
  | 'INTERNAL_ERROR'
  | 'INVALID_ENVELOPE'
  | 'INVALID_PAYLOAD'
  | 'PROTOCOL_UPGRADE_REQUIRED'
  | 'UNAUTHORIZED'
  | 'UNKNOWN_METHOD'
  | 'UNSUPPORTED_PROTOCOL_VERSION'

export interface EditorMcpProtocolError {
  readonly Code: EditorMcpProtocolErrorCode
  readonly Message: string
  readonly Data?: unknown
}

export interface EditorMcpHandshakeRequest {
  readonly Type: 'Handshake'
  readonly RequestId: string
  readonly ProtocolVersion: typeof EDITOR_MCP_PROTOCOL_VERSION
  readonly ClientKind: EditorMcpClientKind
  readonly ClientName: string
  readonly Capabilities: readonly string[]
  readonly AuthToken?: string
}

export interface EditorMcpRequestEnvelope {
  readonly Type: 'Request'
  readonly RequestId: string
  readonly Method: EditorMcpMethod
  readonly Params?: Record<string, unknown>
}

export interface EditorMcpResponseEnvelope {
  readonly Type: 'Response'
  readonly RequestId: string
  readonly Success: boolean
  readonly Result?: unknown
  readonly Error?: EditorMcpProtocolError
}

export interface EditorMcpNotificationEnvelope {
  readonly Type: 'Notification'
  readonly Event: EditorMcpNotificationEvent
  readonly Sequence: number
  readonly Payload: unknown
}

export type EditorMcpEnvelope =
  | EditorMcpHandshakeRequest
  | EditorMcpNotificationEnvelope
  | EditorMcpRequestEnvelope
  | EditorMcpResponseEnvelope

export type EditorMcpParseResult =
  | { readonly ok: true; readonly value: EditorMcpEnvelope }
  | { readonly ok: false; readonly error: EditorMcpProtocolError }

const clientKinds: ReadonlySet<string> = new Set<EditorMcpClientKind>([
  'mcp-tool',
  'universe-host-control',
])
const methods: ReadonlySet<string> = new Set<EditorMcpMethod>(['CallTool', 'ListTools'])
const notificationEvents: ReadonlySet<string> = new Set<EditorMcpNotificationEvent>([
  'ActiveContextChanged',
  'AgentFixRequested',
  'ValidationSnapshotChanged',
])
const errorCodes: ReadonlySet<string> = new Set<EditorMcpProtocolErrorCode>([
  'FRAME_TOO_LARGE',
  'HANDSHAKE_REQUIRED',
  'INTERNAL_ERROR',
  'INVALID_ENVELOPE',
  'INVALID_PAYLOAD',
  'PROTOCOL_UPGRADE_REQUIRED',
  'UNAUTHORIZED',
  'UNKNOWN_METHOD',
  'UNSUPPORTED_PROTOCOL_VERSION',
])

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
      new Set([
        'Type',
        'RequestId',
        'ProtocolVersion',
        'ClientKind',
        'ClientName',
        'Capabilities',
        'AuthToken',
      ]),
    )
  ) {
    return failure('INVALID_ENVELOPE', 'Handshake contains unknown fields')
  }
  if (!isNonEmptyString(value.RequestId) || !isNonEmptyString(value.ClientName)) {
    return failure('INVALID_PAYLOAD', 'Handshake requires RequestId and ClientName')
  }
  if (value.ProtocolVersion !== EDITOR_MCP_PROTOCOL_VERSION) {
    return failure('UNSUPPORTED_PROTOCOL_VERSION', 'Unsupported Editor MCP protocol version')
  }
  if (typeof value.ClientKind !== 'string' || !clientKinds.has(value.ClientKind)) {
    return failure('INVALID_PAYLOAD', 'Invalid Handshake ClientKind')
  }
  if (
    !Array.isArray(value.Capabilities) ||
    !value.Capabilities.every((item) => typeof item === 'string')
  ) {
    return failure('INVALID_PAYLOAD', 'Handshake Capabilities must be a string array')
  }
  if (value.AuthToken !== undefined && typeof value.AuthToken !== 'string') {
    return failure('INVALID_PAYLOAD', 'Handshake AuthToken must be a string')
  }
  return { ok: true, value: value as unknown as EditorMcpHandshakeRequest }
}

function parseRequest(value: Record<string, unknown>): EditorMcpParseResult {
  if (!hasOnlyKeys(value, new Set(['Type', 'RequestId', 'Method', 'Params']))) {
    return failure('INVALID_ENVELOPE', 'Request contains unknown fields')
  }
  if (!isNonEmptyString(value.RequestId)) {
    return failure('INVALID_PAYLOAD', 'Request requires RequestId')
  }
  if (typeof value.Method !== 'string' || !methods.has(value.Method)) {
    return failure('UNKNOWN_METHOD', 'Invalid Request Method')
  }
  if (value.Params !== undefined && !isRecord(value.Params)) {
    return failure('INVALID_PAYLOAD', 'Request Params must be an object')
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
    return failure('INVALID_ENVELOPE', 'Response contains unknown fields')
  }
  if (!isNonEmptyString(value.RequestId) || typeof value.Success !== 'boolean') {
    return failure('INVALID_PAYLOAD', 'Response requires RequestId and Success')
  }
  if (value.Success) {
    if ('Error' in value)
      return failure('INVALID_PAYLOAD', 'Successful Response cannot contain Error')
  } else if (!isProtocolError(value.Error) || 'Result' in value) {
    return failure('INVALID_PAYLOAD', 'Failed Response must contain only a valid Error')
  }
  return { ok: true, value: value as unknown as EditorMcpResponseEnvelope }
}

function parseNotification(value: Record<string, unknown>): EditorMcpParseResult {
  if (!hasOnlyKeys(value, new Set(['Type', 'Event', 'Sequence', 'Payload']))) {
    return failure('INVALID_ENVELOPE', 'Notification contains unknown fields')
  }
  if (typeof value.Event !== 'string' || !notificationEvents.has(value.Event)) {
    return failure('INVALID_PAYLOAD', 'Invalid Notification Event')
  }
  if (
    !Number.isSafeInteger(value.Sequence) ||
    (value.Sequence as number) < 0 ||
    !('Payload' in value)
  ) {
    return failure('INVALID_PAYLOAD', 'Notification requires Sequence and Payload')
  }
  return { ok: true, value: value as unknown as EditorMcpNotificationEnvelope }
}

export function parseEditorMcpEnvelope(text: string): EditorMcpParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return failure('INVALID_ENVELOPE', 'Editor MCP envelope is not valid JSON')
  }
  if (!isRecord(value) || typeof value.Type !== 'string') {
    return failure('INVALID_ENVELOPE', 'Editor MCP envelope must be an object with Type')
  }

  switch (value.Type) {
    case 'Handshake':
      return parseHandshake(value)
    case 'Notification':
      return parseNotification(value)
    case 'Request':
      return parseRequest(value)
    case 'Response':
      return parseResponse(value)
    default:
      return failure('INVALID_ENVELOPE', 'Unknown Editor MCP envelope Type')
  }
}

export function serializeEditorMcpEnvelope(envelope: EditorMcpEnvelope): string {
  return JSON.stringify(envelope)
}
