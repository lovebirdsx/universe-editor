/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  extensionMcpServers — pure resolver for the declarative `contributes.mcpServers`
 *  extension point. Extension-contributed MCP servers are a RUNTIME source
 *  (mirroring VSCode's extension MCP collections): they are resolved from the
 *  scanned manifests on every change and fed into the merge pipeline as the
 *  lowest-priority layer — never written to settings.json, gone the moment the
 *  extension is uninstalled or disabled.
 *
 *  Invalid entries are skipped with a warning rather than thrown (same tolerance
 *  as `acpMcpServers.buildServer`): one broken manifest must not break session
 *  creation. v1 supports stdio only — entries carrying a `type` are skipped.
 *--------------------------------------------------------------------------------------------*/

import {
  getUntrustedWorkspaceSupportType,
  type IExtensionDescriptionDto,
  type IMcpServerContribution,
} from '@universe-editor/extensions-common'

type WarnFn = (msg: string) => void

/** Everything the resolver needs from the live workbench, injected for purity. */
export interface IExtensionMcpResolveContext {
  /** The editor's Electron executable (`${execPath}` substitution). */
  readonly execPath: string
  readonly isWorkspaceTrusted: boolean
  /** Reads the effective value of a `whenConfiguration` gate key. */
  readonly getConfiguration: (key: string) => unknown
}

/**
 * Substitute `${execPath}` / `${extensionPath}` in one string. Unknown
 * `${...}` variables are kept verbatim (with a warning) so a future variable
 * degrades visibly instead of silently producing an empty path segment.
 */
function substituteVariables(
  value: string,
  vars: Readonly<Record<string, string>>,
  onWarn: WarnFn | undefined,
  where: string,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    const replacement = vars[name]
    if (replacement === undefined) {
      onWarn?.(`${where}: unknown variable "\${${name}}", kept verbatim`)
      return match
    }
    return replacement
  })
}

function resolveEntry(
  entry: IMcpServerContribution,
  vars: Readonly<Record<string, string>>,
  onWarn: WarnFn | undefined,
  where: string,
): Record<string, unknown> | undefined {
  if (entry == null || typeof entry !== 'object') {
    onWarn?.(`${where}: entry must be an object, skipped`)
    return undefined
  }
  // stdio only in v1. The manifest schema is deliberately lenient, so a future
  // http/sse shape parses fine — gate it here instead of failing the manifest.
  if ('type' in entry) {
    onWarn?.(`${where}: non-stdio transports are not supported yet, skipped`)
    return undefined
  }
  if (typeof entry.command !== 'string' || !entry.command) {
    onWarn?.(`${where}: stdio entry requires "command", skipped`)
    return undefined
  }
  const command = substituteVariables(entry.command, vars, onWarn, where)
  const out: Record<string, unknown> = { command }
  if (Array.isArray(entry.args)) {
    out.args = entry.args
      .filter((a): a is string => typeof a === 'string')
      .map((a) => substituteVariables(a, vars, onWarn, where))
  }
  if (entry.env != null && typeof entry.env === 'object') {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value === 'string') env[key] = substituteVariables(value, vars, onWarn, where)
    }
    out.env = env
  }
  if (entry.disabled === true) out.disabled = true
  return out
}

/**
 * Resolve every scanned extension's `contributes.mcpServers` into one raw
 * Record shaped exactly like the `acp.mcpServers` setting, ready to prepend to
 * the settings-layer merge (lowest priority — a same-named user entry wins).
 *
 * Gates, per extension / entry:
 *  - Workspace Trust: in an untrusted workspace, non-builtin extensions whose
 *    untrusted-workspace support resolves to `false` contribute nothing
 *    (`'limited'` still injects, mirroring the activation gate).
 *  - `whenConfiguration`: the entry is skipped when the referenced setting
 *    resolves to `false` (undefined / truthy injects). The key is an
 *    editor-side annotation and is stripped from the output — it must never
 *    reach the wire.
 */
export function resolveExtensionMcpServerRecord(
  extensions: readonly IExtensionDescriptionDto[],
  ctx: IExtensionMcpResolveContext,
  onWarn?: WarnFn,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const ownerByName = new Map<string, string>()

  for (const ext of extensions) {
    const servers = ext.contributes.mcpServers
    if (!servers || typeof servers !== 'object') continue

    if (
      !ctx.isWorkspaceTrusted &&
      !ext.extensionIsBuiltin &&
      getUntrustedWorkspaceSupportType(ext) === false
    ) {
      continue
    }

    const extensionPath = ext.extensionLocation.replace(/\\/g, '/')
    const vars: Record<string, string> = { execPath: ctx.execPath, extensionPath }

    for (const [name, entry] of Object.entries(servers)) {
      const where = `extension ${ext.id} mcp server "${name}"`
      if (!name) {
        onWarn?.(`extension ${ext.id}: mcp server with empty name, skipped`)
        continue
      }
      if (
        typeof entry?.whenConfiguration === 'string' &&
        ctx.getConfiguration(entry.whenConfiguration) === false
      ) {
        continue
      }
      const resolved = resolveEntry(entry, vars, onWarn, where)
      if (!resolved) continue
      const previousOwner = ownerByName.get(name)
      if (previousOwner !== undefined) {
        onWarn?.(`${where}: name already contributed by ${previousOwner}, later entry wins`)
      }
      ownerByName.set(name, ext.id)
      out[name] = resolved
    }
  }
  return out
}
