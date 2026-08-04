/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PII / secret redaction for error text before it is persisted or reported.
 *  Simplified from VSCode's telemetryService.cleanData + anonymizeFilePaths:
 *  known environment paths and OS user directories are masked, node_modules /
 *  extension path tails are preserved for attribution, common credential
 *  shapes are scrubbed line-by-line, and the result is length-capped.
 *--------------------------------------------------------------------------------------------*/

export interface IRedactionOptions {
  /** Absolute paths that must never appear in output (userHome, userData, appRoot, tmpDir…). */
  readonly piiPaths?: readonly string[]
  /** Output cap in characters. Defaults to 8192 (VSCode's telemetry value limit). */
  readonly maxLength?: number
}

const DEFAULT_MAX_LENGTH = 8192

// Windows (C:\Users\x) / macOS (/Users/x) / Linux (/home/x) account directories.
const USER_DIR_RE = /(?:[A-Za-z]:[\\/]|^|[\s('"])\/(?:Users|home)[\\/][^\\/:'"\s)]+/g

// Long path-like token that contains node_modules or an extensions dir — keep
// the package tail for attribution, mask everything before it.
const ATTRIBUTABLE_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\/)[^\s()'"]*?[\\/]((?:node_modules|extensions|\.vscode[\\/]extensions)[\\/][^\s()'"]+)/g

// Generic absolute path (drive-letter or posix root) with at least 2 segments.
// The lookbehinds keep tails we deliberately preserved (`<path>/node_modules/…`,
// `<pii>/relative/…`) from being re-masked by this pass.
const GENERIC_PATH_RE =
  /(?:[A-Za-z]:[\\/]|(?<!<path>)(?<!<pii>)(?<!<user>)\/)(?:[^\\/:'"\s)]+[\\/]){1,}[^\\/:'"\s)]+/g

const SECRET_RES: readonly RegExp[] = [
  // JWT
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  // OpenAI / Anthropic style keys
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  // Authorization headers
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
]

// key=value / "key": "value" shapes for well-known credential keys.
const KEY_VALUE_SECRET_RE =
  /((?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|secret)["'\s]*[:=]["'\s]*)[A-Za-z0-9._~+/=-]{6,}/gi

function maskPiiPaths(text: string, piiPaths: readonly string[]): string {
  const sorted = [...new Set(piiPaths.filter((p) => p.length > 0))].sort(
    (a, b) => b.length - a.length,
  )
  let result = text
  for (const p of sorted) {
    const withForward = p.replace(/\\/g, '/')
    result = result.split(p).join('<pii>')
    if (withForward !== p) result = result.split(withForward).join('<pii>')
  }
  return result
}

function redactLine(line: string): string {
  let out = line
  for (const re of SECRET_RES) out = out.replace(re, '<secret>')
  out = out.replace(KEY_VALUE_SECRET_RE, '$1<secret>')
  return out
}

export function redactErrorText(text: string, options?: IRedactionOptions): string {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH
  let out = text.slice(0, maxLength * 2) // bound regex work before masking

  if (options?.piiPaths?.length) {
    out = maskPiiPaths(out, options.piiPaths)
  }
  out = out.replace(ATTRIBUTABLE_PATH_RE, '<path>/$1')
  out = out.replace(USER_DIR_RE, (m) => {
    const head = m.match(/^(?:[A-Za-z]:[\\/]|[\s('"]?\/)/)
    return `${head?.[0] ?? ''}<user>`
  })
  out = out.replace(GENERIC_PATH_RE, '<path>')
  // Secret scrubbing is line-by-line so one hit never eats a whole stack.
  out = out.split('\n').map(redactLine).join('\n')
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}
