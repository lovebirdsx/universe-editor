/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent Client Protocol (ACP) wire types and constants.
 *
 *  ACP is a JSON-RPC 2.0 protocol with newline-delimited framing: each message
 *  is a JSON object on its own line, terminated by `\n`. The transport is
 *  symmetric — both endpoints may issue requests, send responses, and emit
 *  notifications. We model only the subset the editor needs today.
 *--------------------------------------------------------------------------------------------*/

/** JSON-RPC 2.0 envelope. */
export type JsonRpcId = number | string | null

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly result?: unknown
  readonly error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

// ---------------------------------------------------------------------------
// ACP method names
// ---------------------------------------------------------------------------

export const AcpMethods = {
  /** Client → Agent: handshake. */
  Initialize: 'initialize',
  /** Client → Agent: create a new session. */
  NewSession: 'session/new',
  /** Client → Agent: load an existing session by id (replays history). */
  LoadSession: 'session/load',
  /** Client → Agent: send a user prompt for the active session. */
  SessionPrompt: 'session/prompt',
  /** Client → Agent: cancel the current turn. */
  SessionCancel: 'session/cancel',
  /** Client → Agent: switch session mode (legacy; prefer SetConfigOption). */
  SetSessionMode: 'session/set_mode',
  /** Client → Agent: set a session-level config option (model/mode/thought_level). */
  SetConfigOption: 'session/set_config_option',
  /** Agent → Client (notification): streaming update for the active turn. */
  SessionUpdate: 'session/update',
  /** Agent → Client: request the user's permission for a tool call. */
  RequestPermission: 'session/request_permission',
  /** Agent → Client: read a UTF-8 text file. */
  ReadTextFile: 'fs/read_text_file',
  /** Agent → Client: write a UTF-8 text file. */
  WriteTextFile: 'fs/write_text_file',
  /** Agent → Client: create a managed terminal process. */
  TerminalCreate: 'terminal/create',
  /** Agent → Client: pull buffered output (and optional exit status). */
  TerminalOutput: 'terminal/output',
  /** Agent → Client: block until the terminal process exits. */
  TerminalWaitForExit: 'terminal/wait_for_exit',
  /** Agent → Client: kill the terminal process. */
  TerminalKill: 'terminal/kill',
  /** Agent → Client: release the terminal (drop its buffer / state). */
  TerminalRelease: 'terminal/release',
} as const

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface AcpClientCapabilities {
  readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean }
  /** Terminal/* peer methods are answered. */
  readonly terminal?: boolean
}

export interface AcpAgentCapabilities {
  readonly promptCapabilities?: Readonly<Record<string, unknown>>
  /** Agent honours `session/load` for replay. */
  readonly loadSession?: boolean
}

export interface AcpInitializeParams {
  readonly protocolVersion: number
  readonly clientCapabilities: AcpClientCapabilities
}

export interface AcpInitializeResult {
  readonly protocolVersion: number
  readonly agentCapabilities?: AcpAgentCapabilities
}

// ---------------------------------------------------------------------------
// Session setup
// ---------------------------------------------------------------------------

export interface AcpNewSessionParams {
  /** Workspace cwd communicated to the agent. */
  readonly cwd: string
  readonly mcpServers?: readonly unknown[]
}

export interface AcpLoadSessionParams {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers?: readonly unknown[]
}

export interface AcpNewSessionResult {
  readonly sessionId: string
  /** Legacy modes mechanism — present until the agent migrates to configOptions. */
  readonly modes?: AcpSessionModeState
  /** Preferred mechanism for exposing session-level switches. */
  readonly configOptions?: readonly AcpSessionConfigOption[]
}

/**
 * `session/load` returns the same shape as `session/new` minus the sessionId
 * (the caller already knows it). Agents may also return `null` — in that case
 * the client keeps whatever modes/configOptions it had cached locally.
 */
export interface AcpLoadSessionResult {
  readonly modes?: AcpSessionModeState
  readonly configOptions?: readonly AcpSessionConfigOption[]
}

// ---------------------------------------------------------------------------
// Content blocks (multimodal payloads)
// ---------------------------------------------------------------------------

export type AcpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'audio'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource'; readonly uri: string }
  | {
      readonly type: 'resource_link'
      readonly uri: string
      readonly name?: string
      readonly mimeType?: string
      readonly description?: string
    }

// ---------------------------------------------------------------------------
// Prompt / cancel
// ---------------------------------------------------------------------------

export interface AcpSessionPromptParams {
  readonly sessionId: string
  readonly prompt: readonly AcpContentBlock[]
}

export interface AcpSessionPromptResult {
  /** 'end_turn' | 'max_tokens' | 'cancelled' | etc. */
  readonly stopReason: string
}

export interface AcpSessionCancelParams {
  readonly sessionId: string
}

// ---------------------------------------------------------------------------
// Modes (legacy)
// ---------------------------------------------------------------------------

export interface AcpSessionMode {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AcpSessionModeState {
  readonly currentModeId: string
  readonly availableModes: readonly AcpSessionMode[]
}

export interface AcpSetSessionModeParams {
  readonly sessionId: string
  readonly modeId: string
}

// ---------------------------------------------------------------------------
// Session config options (preferred; replaces modes)
// ---------------------------------------------------------------------------

export type AcpConfigOptionType = 'select'

/** Reserved categories per spec; custom categories must use `_`-prefix. */
export type AcpConfigOptionCategory = 'mode' | 'model' | 'thought_level' | (string & {})

export interface AcpConfigOptionValue {
  readonly value: string
  readonly name: string
  readonly description?: string
}

export interface AcpSessionConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly category?: AcpConfigOptionCategory
  readonly type: AcpConfigOptionType
  readonly currentValue: string
  readonly options: readonly AcpConfigOptionValue[]
}

export interface AcpSetConfigOptionParams {
  readonly sessionId: string
  readonly configId: string
  readonly value: string
}

export interface AcpSetConfigOptionResult {
  /** Agent MUST return the full option set so the client can reflect cross-option deps. */
  readonly configOptions: readonly AcpSessionConfigOption[]
}

// ---------------------------------------------------------------------------
// Available (slash) commands
// ---------------------------------------------------------------------------

export interface AcpAvailableCommandInput {
  readonly hint: string
}

export interface AcpAvailableCommand {
  readonly name: string
  readonly description: string
  readonly input?: AcpAvailableCommandInput
}

// ---------------------------------------------------------------------------
// session/update notification variants
// ---------------------------------------------------------------------------

export type AcpSessionUpdate =
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: AcpContentBlock }
  | { readonly sessionUpdate: 'user_message_chunk'; readonly content: AcpContentBlock }
  | { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: AcpContentBlock }
  | {
      readonly sessionUpdate: 'tool_call'
      readonly toolCallId: string
      readonly title?: string
      readonly kind?: string
      readonly status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      readonly content?: readonly AcpContentBlock[]
    }
  | {
      readonly sessionUpdate: 'tool_call_update'
      readonly toolCallId: string
      readonly status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      readonly content?: readonly AcpContentBlock[]
    }
  | {
      readonly sessionUpdate: 'plan'
      readonly entries: readonly { readonly content: string; readonly priority?: string }[]
    }
  | {
      readonly sessionUpdate: 'available_commands_update'
      readonly availableCommands: readonly AcpAvailableCommand[]
    }
  | {
      readonly sessionUpdate: 'current_mode_update'
      readonly currentModeId: string
    }
  | {
      readonly sessionUpdate: 'config_option_update'
      readonly configOptions: readonly AcpSessionConfigOption[]
    }

export interface AcpSessionUpdateParams {
  readonly sessionId: string
  readonly update: AcpSessionUpdate
}

// ---------------------------------------------------------------------------
// Permission request
// ---------------------------------------------------------------------------

export interface AcpRequestPermissionParams {
  readonly sessionId: string
  readonly toolCall: {
    readonly toolCallId: string
    readonly title?: string
    readonly kind?: string
  }
  readonly options: readonly {
    readonly optionId: string
    readonly name: string
    readonly kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  }[]
}

export interface AcpRequestPermissionResult {
  readonly outcome:
    | { readonly outcome: 'selected'; readonly optionId: string }
    | { readonly outcome: 'cancelled' }
}

// ---------------------------------------------------------------------------
// File system
// ---------------------------------------------------------------------------

export interface AcpReadTextFileParams {
  readonly sessionId: string
  readonly path: string
  readonly line?: number
  readonly limit?: number
}

export interface AcpReadTextFileResult {
  readonly content: string
}

export interface AcpWriteTextFileParams {
  readonly sessionId: string
  readonly path: string
  readonly content: string
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface AcpTerminalEnvVar {
  readonly name: string
  readonly value: string
}

export interface AcpTerminalCreateParams {
  readonly sessionId: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: readonly AcpTerminalEnvVar[]
  readonly cwd?: string
  readonly outputByteLimit?: number
}

export interface AcpTerminalCreateResult {
  readonly terminalId: string
}

export interface AcpTerminalOutputParams {
  readonly sessionId: string
  readonly terminalId: string
}

export interface AcpTerminalExitStatus {
  readonly exitCode?: number
  readonly signal?: string
}

export interface AcpTerminalOutputResult {
  readonly output: string
  readonly truncated: boolean
  readonly exitStatus?: AcpTerminalExitStatus
}

export interface AcpTerminalWaitForExitParams {
  readonly sessionId: string
  readonly terminalId: string
}

export type AcpTerminalWaitForExitResult = AcpTerminalExitStatus

export interface AcpTerminalKillParams {
  readonly sessionId: string
  readonly terminalId: string
}

export interface AcpTerminalReleaseParams {
  readonly sessionId: string
  readonly terminalId: string
}

/** Current ACP protocol version that we advertise. */
export const ACP_PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Runtime guards
//
// Peer-initiated traffic comes from a third-party agent process, so we never
// trust the wire payload to match our TypeScript types. These narrow guards
// fail closed and let the caller emit `-32602 Invalid params` instead of
// letting a missing field crash a deeper layer with `-32603 Internal error`.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isContentBlock(v: unknown): v is AcpContentBlock {
  if (!isObject(v)) return false
  switch (v['type']) {
    case 'text':
      return typeof v['text'] === 'string'
    case 'image':
    case 'audio':
      return typeof v['mimeType'] === 'string' && typeof v['data'] === 'string'
    case 'resource':
      return typeof v['uri'] === 'string'
    case 'resource_link':
      return (
        typeof v['uri'] === 'string' &&
        (v['name'] === undefined || typeof v['name'] === 'string') &&
        (v['mimeType'] === undefined || typeof v['mimeType'] === 'string') &&
        (v['description'] === undefined || typeof v['description'] === 'string')
      )
    default:
      return false
  }
}

function isContentBlockArray(v: unknown): v is readonly AcpContentBlock[] {
  return Array.isArray(v) && v.every(isContentBlock)
}

export function parseReadTextFileParams(v: unknown): AcpReadTextFileParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  if (typeof v['path'] !== 'string') return null
  if (v['line'] !== undefined && typeof v['line'] !== 'number') return null
  if (v['limit'] !== undefined && typeof v['limit'] !== 'number') return null
  const out: AcpReadTextFileParams = {
    sessionId: v['sessionId'],
    path: v['path'],
    ...(typeof v['line'] === 'number' ? { line: v['line'] } : {}),
    ...(typeof v['limit'] === 'number' ? { limit: v['limit'] } : {}),
  }
  return out
}

export function parseWriteTextFileParams(v: unknown): AcpWriteTextFileParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  if (typeof v['path'] !== 'string') return null
  if (typeof v['content'] !== 'string') return null
  return {
    sessionId: v['sessionId'],
    path: v['path'],
    content: v['content'],
  }
}

export function parseRequestPermissionParams(v: unknown): AcpRequestPermissionParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  const tc = v['toolCall']
  if (!isObject(tc) || typeof tc['toolCallId'] !== 'string') return null
  if (tc['title'] !== undefined && typeof tc['title'] !== 'string') return null
  if (tc['kind'] !== undefined && typeof tc['kind'] !== 'string') return null
  const optsRaw = v['options']
  if (!Array.isArray(optsRaw)) return null
  const options: AcpRequestPermissionParams['options'][number][] = []
  for (const opt of optsRaw) {
    if (!isObject(opt)) return null
    if (typeof opt['optionId'] !== 'string') return null
    if (typeof opt['name'] !== 'string') return null
    const kind = opt['kind']
    if (
      kind !== undefined &&
      kind !== 'allow_once' &&
      kind !== 'allow_always' &&
      kind !== 'reject_once' &&
      kind !== 'reject_always'
    ) {
      return null
    }
    options.push({
      optionId: opt['optionId'],
      name: opt['name'],
      ...(kind
        ? { kind: kind as 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }
        : {}),
    })
  }
  return {
    sessionId: v['sessionId'],
    toolCall: {
      toolCallId: tc['toolCallId'],
      ...(typeof tc['title'] === 'string' ? { title: tc['title'] } : {}),
      ...(typeof tc['kind'] === 'string' ? { kind: tc['kind'] } : {}),
    },
    options,
  }
}

const TOOL_CALL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])

function parseConfigOptionValue(v: unknown): AcpConfigOptionValue | null {
  if (!isObject(v)) return null
  if (typeof v['value'] !== 'string') return null
  if (typeof v['name'] !== 'string') return null
  if (v['description'] !== undefined && typeof v['description'] !== 'string') return null
  return {
    value: v['value'],
    name: v['name'],
    ...(typeof v['description'] === 'string' ? { description: v['description'] } : {}),
  }
}

function parseSessionConfigOption(v: unknown): AcpSessionConfigOption | null {
  if (!isObject(v)) return null
  if (typeof v['id'] !== 'string') return null
  if (typeof v['name'] !== 'string') return null
  if (v['description'] !== undefined && typeof v['description'] !== 'string') return null
  if (v['category'] !== undefined && typeof v['category'] !== 'string') return null
  if (v['type'] !== 'select') return null
  if (typeof v['currentValue'] !== 'string') return null
  const optsRaw = v['options']
  if (!Array.isArray(optsRaw)) return null
  const options: AcpConfigOptionValue[] = []
  for (const o of optsRaw) {
    const parsed = parseConfigOptionValue(o)
    if (!parsed) return null
    options.push(parsed)
  }
  return {
    id: v['id'],
    name: v['name'],
    ...(typeof v['description'] === 'string' ? { description: v['description'] } : {}),
    ...(typeof v['category'] === 'string'
      ? { category: v['category'] as AcpConfigOptionCategory }
      : {}),
    type: 'select',
    currentValue: v['currentValue'],
    options,
  }
}

function parseConfigOptionsArray(v: unknown): readonly AcpSessionConfigOption[] | null {
  if (!Array.isArray(v)) return null
  const out: AcpSessionConfigOption[] = []
  for (const item of v) {
    const parsed = parseSessionConfigOption(item)
    if (!parsed) return null
    out.push(parsed)
  }
  return out
}

function parseSessionMode(v: unknown): AcpSessionMode | null {
  if (!isObject(v)) return null
  if (typeof v['id'] !== 'string') return null
  if (typeof v['name'] !== 'string') return null
  if (v['description'] !== undefined && typeof v['description'] !== 'string') return null
  return {
    id: v['id'],
    name: v['name'],
    ...(typeof v['description'] === 'string' ? { description: v['description'] } : {}),
  }
}

export function parseSessionModeState(v: unknown): AcpSessionModeState | null {
  if (!isObject(v)) return null
  if (typeof v['currentModeId'] !== 'string') return null
  const arr = v['availableModes']
  if (!Array.isArray(arr)) return null
  const modes: AcpSessionMode[] = []
  for (const m of arr) {
    const parsed = parseSessionMode(m)
    if (!parsed) return null
    modes.push(parsed)
  }
  return { currentModeId: v['currentModeId'], availableModes: modes }
}

export function parseNewSessionResult(v: unknown): AcpNewSessionResult | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  const out: {
    sessionId: string
    modes?: AcpSessionModeState
    configOptions?: readonly AcpSessionConfigOption[]
  } = { sessionId: v['sessionId'] }
  if (v['modes'] !== undefined) {
    const modes = parseSessionModeState(v['modes'])
    if (modes) out.modes = modes
  }
  if (v['configOptions'] !== undefined) {
    const cfg = parseConfigOptionsArray(v['configOptions'])
    if (cfg) out.configOptions = cfg
  }
  return out
}

/**
 * Parse `session/load` result. Agents may legitimately return `null` / `{}` —
 * in that case we still succeed with an empty bag so the caller can keep using
 * whatever modes/configOptions it had. Returning `null` means the WIRE shape
 * was invalid (e.g. a string), which the caller should treat as a protocol
 * error.
 */
export function parseLoadSessionResult(v: unknown): AcpLoadSessionResult | null {
  if (v === null || v === undefined) return {}
  if (!isObject(v)) return null
  const out: {
    modes?: AcpSessionModeState
    configOptions?: readonly AcpSessionConfigOption[]
  } = {}
  if (v['modes'] !== undefined) {
    const modes = parseSessionModeState(v['modes'])
    if (modes) out.modes = modes
  }
  if (v['configOptions'] !== undefined) {
    const cfg = parseConfigOptionsArray(v['configOptions'])
    if (cfg) out.configOptions = cfg
  }
  return out
}

function parseAgentCapabilities(v: unknown): AcpAgentCapabilities | null {
  if (!isObject(v)) return null
  const out: {
    promptCapabilities?: Readonly<Record<string, unknown>>
    loadSession?: boolean
  } = {}
  if (v['promptCapabilities'] !== undefined) {
    if (!isObject(v['promptCapabilities'])) return null
    out.promptCapabilities = v['promptCapabilities'] as Readonly<Record<string, unknown>>
  }
  if (v['loadSession'] !== undefined) {
    if (typeof v['loadSession'] !== 'boolean') return null
    out.loadSession = v['loadSession']
  }
  return out
}

export function parseInitializeResult(v: unknown): AcpInitializeResult | null {
  if (!isObject(v)) return null
  if (typeof v['protocolVersion'] !== 'number') return null
  const out: {
    protocolVersion: number
    agentCapabilities?: AcpAgentCapabilities
  } = { protocolVersion: v['protocolVersion'] }
  if (v['agentCapabilities'] !== undefined) {
    const caps = parseAgentCapabilities(v['agentCapabilities'])
    if (!caps) return null
    out.agentCapabilities = caps
  }
  return out
}

export function parseAvailableCommand(v: unknown): AcpAvailableCommand | null {
  if (!isObject(v)) return null
  if (typeof v['name'] !== 'string') return null
  if (typeof v['description'] !== 'string') return null
  let input: AcpAvailableCommandInput | undefined
  if (v['input'] !== undefined) {
    if (!isObject(v['input'])) return null
    if (typeof v['input']['hint'] !== 'string') return null
    input = { hint: v['input']['hint'] }
  }
  return {
    name: v['name'],
    description: v['description'],
    ...(input ? { input } : {}),
  }
}

function parseAvailableCommandsArray(v: unknown): readonly AcpAvailableCommand[] | null {
  if (!Array.isArray(v)) return null
  const out: AcpAvailableCommand[] = []
  for (const c of v) {
    const parsed = parseAvailableCommand(c)
    if (!parsed) return null
    out.push(parsed)
  }
  return out
}

function parseSessionUpdate(v: unknown): AcpSessionUpdate | null {
  if (!isObject(v)) return null
  const kind = v['sessionUpdate']
  switch (kind) {
    case 'agent_message_chunk':
    case 'user_message_chunk':
    case 'agent_thought_chunk': {
      if (!isContentBlock(v['content'])) return null
      return { sessionUpdate: kind, content: v['content'] } as AcpSessionUpdate
    }
    case 'tool_call': {
      if (typeof v['toolCallId'] !== 'string') return null
      if (v['title'] !== undefined && typeof v['title'] !== 'string') return null
      if (v['kind'] !== undefined && typeof v['kind'] !== 'string') return null
      if (v['status'] !== undefined && !TOOL_CALL_STATUSES.has(v['status'] as string)) return null
      if (v['content'] !== undefined && !isContentBlockArray(v['content'])) return null
      return {
        sessionUpdate: 'tool_call',
        toolCallId: v['toolCallId'],
        ...(typeof v['title'] === 'string' ? { title: v['title'] } : {}),
        ...(typeof v['kind'] === 'string' ? { kind: v['kind'] } : {}),
        ...(typeof v['status'] === 'string'
          ? { status: v['status'] as 'pending' | 'in_progress' | 'completed' | 'failed' }
          : {}),
        ...(v['content'] !== undefined
          ? { content: v['content'] as readonly AcpContentBlock[] }
          : {}),
      }
    }
    case 'tool_call_update': {
      if (typeof v['toolCallId'] !== 'string') return null
      if (v['status'] !== undefined && !TOOL_CALL_STATUSES.has(v['status'] as string)) return null
      if (v['content'] !== undefined && !isContentBlockArray(v['content'])) return null
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: v['toolCallId'],
        ...(typeof v['status'] === 'string'
          ? { status: v['status'] as 'pending' | 'in_progress' | 'completed' | 'failed' }
          : {}),
        ...(v['content'] !== undefined
          ? { content: v['content'] as readonly AcpContentBlock[] }
          : {}),
      }
    }
    case 'plan': {
      const entries = v['entries']
      if (!Array.isArray(entries)) return null
      const parsed: { content: string; priority?: string }[] = []
      for (const e of entries) {
        if (!isObject(e) || typeof e['content'] !== 'string') return null
        if (e['priority'] !== undefined && typeof e['priority'] !== 'string') return null
        parsed.push({
          content: e['content'],
          ...(typeof e['priority'] === 'string' ? { priority: e['priority'] } : {}),
        })
      }
      return { sessionUpdate: 'plan', entries: parsed }
    }
    case 'available_commands_update': {
      const cmds = parseAvailableCommandsArray(v['availableCommands'])
      if (!cmds) return null
      return { sessionUpdate: 'available_commands_update', availableCommands: cmds }
    }
    case 'current_mode_update': {
      if (typeof v['currentModeId'] !== 'string') return null
      return { sessionUpdate: 'current_mode_update', currentModeId: v['currentModeId'] }
    }
    case 'config_option_update': {
      const cfg = parseConfigOptionsArray(v['configOptions'])
      if (!cfg) return null
      return { sessionUpdate: 'config_option_update', configOptions: cfg }
    }
    default:
      return null
  }
}

export function parseSessionUpdateParams(v: unknown): AcpSessionUpdateParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  const update = parseSessionUpdate(v['update'])
  if (!update) return null
  return { sessionId: v['sessionId'], update }
}

export function parseSetConfigOptionResult(v: unknown): AcpSetConfigOptionResult | null {
  if (!isObject(v)) return null
  const cfg = parseConfigOptionsArray(v['configOptions'])
  if (!cfg) return null
  return { configOptions: cfg }
}

// ---------------------------------------------------------------------------
// Terminal parsing
// ---------------------------------------------------------------------------

function parseTerminalEnv(v: unknown): readonly AcpTerminalEnvVar[] | null {
  if (!Array.isArray(v)) return null
  const out: AcpTerminalEnvVar[] = []
  for (const e of v) {
    if (!isObject(e)) return null
    if (typeof e['name'] !== 'string') return null
    if (typeof e['value'] !== 'string') return null
    out.push({ name: e['name'], value: e['value'] })
  }
  return out
}

export function parseTerminalCreateParams(v: unknown): AcpTerminalCreateParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  if (typeof v['command'] !== 'string') return null
  let args: readonly string[] | undefined
  if (v['args'] !== undefined) {
    if (!Array.isArray(v['args'])) return null
    if (!v['args'].every((a) => typeof a === 'string')) return null
    args = v['args'] as readonly string[]
  }
  let env: readonly AcpTerminalEnvVar[] | undefined
  if (v['env'] !== undefined) {
    const parsed = parseTerminalEnv(v['env'])
    if (!parsed) return null
    env = parsed
  }
  if (v['cwd'] !== undefined && typeof v['cwd'] !== 'string') return null
  if (v['outputByteLimit'] !== undefined && typeof v['outputByteLimit'] !== 'number') return null
  return {
    sessionId: v['sessionId'],
    command: v['command'],
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(typeof v['cwd'] === 'string' ? { cwd: v['cwd'] } : {}),
    ...(typeof v['outputByteLimit'] === 'number' ? { outputByteLimit: v['outputByteLimit'] } : {}),
  }
}

export function parseTerminalIdRequest(
  v: unknown,
): { sessionId: string; terminalId: string } | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  if (typeof v['terminalId'] !== 'string') return null
  return { sessionId: v['sessionId'], terminalId: v['terminalId'] }
}
