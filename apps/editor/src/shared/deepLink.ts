/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Deep-link parsing for the OS-level `universe-editor://` protocol. Pure and
 *  shared: the main process uses it to route a link to the right window, the
 *  renderer uses it to turn the link into an IOpenerService target.
 *
 *  Three shapes, mirroring VSCode's `vscode://file/…` / `vscode://command/…`:
 *    universe-editor://file/<abs-path>[:line[:col]]   open a file, optional position
 *    universe-editor://command/<commandId>[?<args>]   run a whitelisted command
 *    universe-editor://agent/new?prompt=<text>[&cwd=<dir>]  create an agent session
 *    universe-editor://swarm/review/<id>              open a Swarm review tab
 *
 *  Agent links always carry an explicit working directory for the session:
 *  `cwd` absent/blank means the user's home directory (see
 *  {@link resolveAgentDeepLinkCwd}). The main process routes the link to the
 *  window whose workspace IS that directory, opening it as a new workspace
 *  window first when no window matches.
 *
 *  Command deep-links are the highest-risk surface — anyone can craft one and
 *  hand it to the OS. Only ids in {@link DEEP_LINK_ALLOWED_COMMANDS} may run;
 *  the list is deliberately limited to safe entry points. The `swarm` shape is a
 *  convenience alias that resolves to the `swarm.openReview` command (allowlisted).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'

export const DEEP_LINK_PROTOCOL = 'universe-editor'

/**
 * Command ids a `universe-editor://command/…` link may invoke. Keep this to
 * side-effect-free "open this surface" commands — never anything that mutates
 * files, runs agents, or executes shell.
 */
export const DEEP_LINK_ALLOWED_COMMANDS: readonly string[] = [
  'workbench.action.openSettings',
  'workbench.action.openSettingsJson',
  'workbench.action.openGlobalKeybindings',
  'workbench.action.openKeybindingsJson',
  'workbench.action.openWorkspaceSettings',
  'workbench.action.selectTheme',
  'workbench.action.configureDisplayLanguage',
  // Opens a read-only Swarm review tab by id — no file mutation.
  'swarm.openReview',
]

export type DeepLinkTarget =
  | { readonly kind: 'file'; readonly path: string; readonly line?: number; readonly col?: number }
  | { readonly kind: 'command'; readonly id: string; readonly query: string }
  | DeepLinkAgentPromptTarget

export interface DeepLinkAgentPromptTarget {
  readonly kind: 'agentPrompt'
  /** 提示词 */
  readonly prompt: string
  /** 是否自动提交 */
  readonly autoSubmit: boolean
  /** 指定的 agent id，若未指定则使用默认 agent */
  readonly agent?: string
  /** 会话的工作目录；缺省时语义为用户目录（见 resolveAgentDeepLinkCwd） */
  readonly cwd?: string
  /** 拉起本次会话的进程 PID */
  readonly pid?: number
}

/** True when {@link url} uses the app's deep-link protocol. */
export function isDeepLink(url: string): boolean {
  return url.toLowerCase().startsWith(`${DEEP_LINK_PROTOCOL}:`)
}

/**
 * Parse a `universe-editor://` URL into a structured target. Returns `undefined`
 * for anything that isn't a well-formed file/command deep-link.
 */
export function parseDeepLink(url: string): DeepLinkTarget | undefined {
  if (!isDeepLink(url)) return undefined
  let uri: URI
  try {
    uri = URI.parse(url)
  } catch {
    return undefined
  }

  if (uri.authority === 'command') {
    const id = trimLeadingSlash(uri.path)
    if (!id) return undefined
    return { kind: 'command', id, query: uri.query }
  }

  // universe-editor://agent/new?prompt=<text>
  if (uri.authority === 'agent') {
    const action = trimLeadingSlash(uri.path)
    if (action !== 'new') {
      return undefined
    }

    const params = new URLSearchParams(uri.query)
    const prompt = params.get('prompt')
    if (!prompt || prompt.trim().length === 0) {
      return undefined
    }

    const agent = params.get('agent') ?? undefined
    const cwd = params.get('cwd')?.trim() || undefined
    const pid = parsePidParam(params.get('pid'))
    if (params.has('pid') && pid === undefined) return undefined
    return {
      kind: 'agentPrompt',
      prompt,
      autoSubmit: parseAgentAutoSubmit(params),
      ...(agent ? { agent } : {}),
      ...(cwd ? { cwd } : {}),
      ...(pid !== undefined ? { pid } : {}),
    }
  }

  // universe-editor://swarm/review/<id> → swarm.openReview command with the id.
  if (uri.authority === 'swarm') {
    const segments = trimLeadingSlash(uri.path).split('/')
    if (segments[0] === 'review' && segments[1]) {
      return {
        kind: 'command',
        id: 'swarm.openReview',
        query: encodeURIComponent(JSON.stringify(segments[1])),
      }
    }
    return undefined
  }

  if (uri.authority === 'file') {
    const raw = normalizeFilePath(uri.path)
    if (!raw) return undefined
    const { path, line, col } = splitLocation(raw)
    return {
      kind: 'file',
      path,
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {}),
    }
  }

  return undefined
}

/**
 * The filesystem path a deep-link points at, ignoring any line/column, for the
 * main process to match against open workspaces. `undefined` for command links.
 */
export function deepLinkFilePath(target: DeepLinkTarget): string | undefined {
  return target.kind === 'file' ? target.path : undefined
}

/**
 * Convert a parsed target into a string the renderer can hand to
 * IOpenerService.open — a `path:line:col` for files, a `command:` URI otherwise.
 */
export function deepLinkToOpenerTarget(target: DeepLinkTarget): string {
  if (target.kind === 'command') {
    return target.query ? `command:${target.id}?${target.query}` : `command:${target.id}`
  }
  if (target.kind === 'agentPrompt') {
    const params = new URLSearchParams()
    params.set('prompt', target.prompt)
    if (!target.autoSubmit) params.set('autoSubmit', 'false')
    if (target.agent) params.set('agent', target.agent)
    if (target.cwd) params.set('cwd', target.cwd)
    if (target.pid !== undefined) params.set('pid', String(target.pid))
    return `agent:new?${params.toString()}`
  }
  const loc =
    target.line !== undefined
      ? `:${target.line}${target.col !== undefined ? `:${target.col}` : ''}`
      : ''
  return `${target.path}${loc}`
}

/** Parse the renderer-facing opener target produced for an agent deep-link. */
export function parseAgentPromptOpenerTarget(
  target: string,
): DeepLinkAgentPromptTarget | undefined {
  const prefix = 'agent:new?'
  if (!target.startsWith(prefix)) return undefined
  const params = new URLSearchParams(target.slice(prefix.length))
  const prompt = params.get('prompt')
  if (!prompt || prompt.trim().length === 0) return undefined
  const agent = params.get('agent') ?? undefined
  const cwd = params.get('cwd')?.trim() || undefined
  const pid = parsePidParam(params.get('pid'))
  if (params.has('pid') && pid === undefined) return undefined
  return {
    kind: 'agentPrompt',
    prompt,
    autoSubmit: parseAgentAutoSubmit(params),
    ...(agent ? { agent } : {}),
    ...(cwd ? { cwd } : {}),
    ...(pid !== undefined ? { pid } : {}),
  }
}

/**
 * Resolve the session working directory for an agent deep-link: absent/blank
 * `cwd` means the user's home directory. The main process passes `os.homedir()`
 * as `homeDir` so this stays pure and unit-testable.
 */
export function resolveAgentDeepLinkCwd(cwd: string | undefined, homeDir: string): string {
  const trimmed = cwd?.trim()
  return trimmed ? trimmed : homeDir
}

/** Strip the leading `/` that URI.parse leaves in front of a Windows drive path. */
function normalizeFilePath(path: string): string {
  const trimmed = trimLeadingSlash(path)
  // `/D:/foo` → `D:/foo`; `/home/x` stays absolute (re-add the slash).
  return /^[A-Za-z]:[/\\]/.test(trimmed) ? trimmed : path
}

function trimLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}

/** Split a trailing `:line[:col]` off a path (Windows drive colon stays put). */
function splitLocation(raw: string): { path: string; line?: number; col?: number } {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw)
  if (!m || !m[1]) return { path: raw }
  return {
    path: m[1],
    line: parseInt(m[2]!, 10),
    ...(m[3] ? { col: parseInt(m[3], 10) } : {}),
  }
}

function parseAgentAutoSubmit(params: URLSearchParams): boolean {
  const explicit = parseBooleanParam(params.get('autoSubmit'))
  return explicit ?? true
}

function parsePidParam(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const pid = Number(trimmed)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function parseBooleanParam(raw: string | null): boolean | undefined {
  if (raw === null) return undefined
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return undefined
  }
}
