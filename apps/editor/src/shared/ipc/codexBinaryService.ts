/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for resolving the native codex-acp adapter binary the built-in
 *  Codex agent spawns. The adapter ships as a self-contained Rust binary inside
 *  the platform-specific optional dependency of `@zed-industries/codex-acp`
 *  (e.g. `@zed-industries/codex-acp-win32-x64`) and is deliberately NOT packaged:
 *  it is downloaded on demand into userData, reused from a system install, or
 *  pointed at a custom path. The resolved absolute path is used as the agent's
 *  spawn `command`.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export type CodexBinarySource = 'download' | 'system' | 'custom'

export interface ICodexBinaryResolveOptions {
  /** How to obtain the binary. Defaults to 'download' when omitted by callers. */
  readonly source: CodexBinarySource
  /** Absolute path to a user-provided binary; required when source is 'custom'. */
  readonly customPath?: string
}

export interface ICodexBinaryProgress {
  /** Bytes downloaded so far. */
  readonly received: number
  /** Total bytes per Content-Length, or 0 when the server didn't report it. */
  readonly total: number
}

export interface ICodexBinaryResult {
  /** Absolute path to a ready-to-spawn codex-acp binary. */
  readonly path: string
}

/**
 * Resolves the native codex-acp binary, downloading it on first use when needed.
 * `resolve` is idempotent and de-dupes concurrent calls for the same options;
 * a cached binary returns immediately without re-downloading.
 */
export interface ICodexBinaryService {
  readonly _serviceBrand: undefined

  /** Fires while a download is in flight so the UI can show progress. */
  readonly onDidChangeProgress: Event<ICodexBinaryProgress>

  resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult>
}

export const ICodexBinaryService = createDecorator<ICodexBinaryService>('codexBinaryService')
