/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared child-process environment assembly for the main process. Centralizes
 *  the env denylist + `ELECTRON_RUN_AS_NODE` handling that AcpHost, AcpTerminal,
 *  and ExtensionHost previously each re-implemented.
 *--------------------------------------------------------------------------------------------*/

/**
 * Variables stripped from every spawned child:
 *   - ELECTRON_* flags would make a Node-shaped child reinterpret its own
 *     entrypoint as an Electron helper.
 *   - NODE_OPTIONS could inject `--inspect` (debug port hijack) or
 *     `--require ./evil.js` (arbitrary code execution before the child's code).
 * Agent / extension-host children are untrusted; treat this like a sandbox
 * boundary even though PATH/HOME/USER/locale variables are still shared.
 */
export const CHILD_ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
]

export interface BuildChildEnvOptions {
  /** Extra variables merged on top of the sanitized base (also denylist-filtered). */
  readonly overrides?: Readonly<Record<string, string>>
  /**
   * Re-add `ELECTRON_RUN_AS_NODE=1` after sanitizing. Set for children launched
   * through Electron's own Node runtime (extension host, ACP `runAsNode`), which
   * re-spawn via `process.execPath` and must inherit the flag.
   */
  readonly runAsNode?: boolean
}

/** Build a child env: base minus the denylist, plus optional overrides. */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  options: BuildChildEnvOptions = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (CHILD_ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  if (options.overrides) {
    for (const [k, v] of Object.entries(options.overrides)) {
      if (CHILD_ENV_DENYLIST.includes(k)) continue
      out[k] = v
    }
  }
  if (options.runAsNode) {
    out.ELECTRON_RUN_AS_NODE = '1'
  }
  return out
}
