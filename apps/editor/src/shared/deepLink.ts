/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Deep-link parsing for the OS-level `universe-editor://` protocol. Pure and
 *  shared: the main process uses it to route a link to the right window, the
 *  renderer uses it to turn the link into an IOpenerService target.
 *
 *  Two shapes, mirroring VSCode's `vscode://file/…` / `vscode://command/…`:
 *    universe-editor://file/<abs-path>[:line[:col]]   open a file, optional position
 *    universe-editor://command/<commandId>[?<args>]   run a whitelisted command
 *
 *  Command deep-links are the highest-risk surface — anyone can craft one and
 *  hand it to the OS. Only ids in {@link DEEP_LINK_ALLOWED_COMMANDS} may run;
 *  the list is deliberately limited to safe "configuration" entry points.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'

export const DEEP_LINK_PROTOCOL = 'universe-editor'

/**
 * Command ids a `universe-editor://command/…` link may invoke. Keep this to
 * side-effect-free "open this configuration surface" commands — never anything
 * that mutates files, runs agents, or executes shell.
 */
export const DEEP_LINK_ALLOWED_COMMANDS: readonly string[] = [
  'workbench.action.openSettings',
  'workbench.action.openSettingsJson',
  'workbench.action.openGlobalKeybindings',
  'workbench.action.openKeybindingsJson',
  'workbench.action.openWorkspaceSettings',
  'workbench.action.selectTheme',
  'workbench.action.configureDisplayLanguage',
]

export type DeepLinkTarget =
  | { readonly kind: 'file'; readonly path: string; readonly line?: number; readonly col?: number }
  | { readonly kind: 'command'; readonly id: string; readonly query: string }

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
  const loc =
    target.line !== undefined
      ? `:${target.line}${target.col !== undefined ? `:${target.col}` : ''}`
      : ''
  return `${target.path}${loc}`
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
