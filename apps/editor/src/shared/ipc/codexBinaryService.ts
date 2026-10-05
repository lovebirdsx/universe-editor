/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for resolving the native `codex` binary the built-in Codex
 *  agent drives. The bundled codex-acp adapter (JS) spawns it directly via the
 *  `CODEX_PATH` env. The binary ships as the platform version of `@openai/codex`
 *  (e.g. `@openai/codex@<ver>-win32-x64`) and is deliberately NOT packaged (~300MB):
 *  it is downloaded on demand into userData, reused from a system install, or
 *  pointed at a custom path. The resolved absolute path is injected as `CODEX_PATH`.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { AgentBinaryVersionPolicy, Event } from '@universe-editor/platform'

export type CodexBinarySource = 'download' | 'system' | 'custom'

export interface ICodexBinaryResolveOptions {
  /** How to obtain the binary. Defaults to 'download' when omitted by callers. */
  readonly source: CodexBinarySource
  /**
   * Which version a managed download runs: `'pinned'` (the default the editor
   * ships with) always runs the pinned codex version, ignoring any version a user
   * picked; `'manual'` honours the user's pick. Required so a new caller cannot
   * silently opt out of the lock — pass `binaryVersionPolicy(config)` from the
   * renderer. Ignored by the system/custom sources, which never touch the managed
   * tree.
   */
  readonly policy: AgentBinaryVersionPolicy
  /** Absolute path to a user-provided binary; required when source is 'custom'. */
  readonly customPath?: string
  /**
   * When `source` is 'download' and the binary isn't cached on disk yet, controls
   * whether a real network download may be triggered. Defaults to true. Set to
   * false for background/speculative callers (e.g. ACP session hydrate) that must
   * never cause a multi-hundred-MB download as a side effect of a passive probe —
   * a cache miss then fails fast instead of downloading.
   */
  readonly allowDownload?: boolean
  /**
   * Remote workspace authority. When set, the binary is resolved/downloaded on
   * that remote host (download semantics only; source/customPath are ignored).
   */
  readonly authority?: string
}

export interface ICodexBinaryDownload {
  /** Version being downloaded. */
  readonly version: string
  /** Bytes downloaded so far. */
  readonly received: number
  /** Total bytes per Content-Length, or 0 when the server didn't report it. */
  readonly total: number
  /** True when the idle prefetch started this download rather than a user action. */
  readonly background: boolean
}

export interface ICodexBinaryDownloadEvent {
  /** Downloads in flight; empty means the store went idle. */
  readonly downloads: readonly ICodexBinaryDownload[]
  /** Remote workspace authority (remote downloads only; absent for local events). */
  readonly authority?: string
}

export interface ICodexBinaryResult {
  /** Absolute path to a ready-to-spawn codex binary. */
  readonly path: string
}

export interface ICodexBinaryVersionInfo {
  /**
   * codex version pinned in flavors.ts (CODEX_VERSION), kept in sync with the
   * codex-acp fork's lockfile and bumped by hand when following upstream. Used as
   * both the default download target and the cache directory.
   */
  readonly bundledVersion: string
  /**
   * Actually-installed binary version on disk — the version `resolve` would hand
   * out: the pin under the locked policy, otherwise the one named by the `.active`
   * pointer file (each version lives in its own dir named after it). null means no
   * binary has been downloaded yet.
   */
  readonly installedVersion: string | null
  /**
   * Latest version available on the npm registry for @openai/codex.
   * null when the network query failed.
   */
  readonly latestVersion: string | null
  /**
   * Versions whose binary is fully extracted on disk (`installedVersion` included).
   * Switching to one of these — reverting to the pinned version or going back to
   * the latest — needs no network at all.
   */
  readonly downloadedVersions: readonly string[]
  /** Downloads in flight right now — empty when idle. */
  readonly downloads: readonly ICodexBinaryDownload[]
}

/**
 * Resolves the native codex binary, downloading it on first use when needed.
 * `resolve` is idempotent and de-dupes concurrent calls for the same options;
 * a cached binary returns immediately without re-downloading.
 */
export interface ICodexBinaryService {
  readonly _serviceBrand: undefined

  /**
   * Fires whenever the set of in-flight downloads changes — including the final
   * empty set. Long-lived (not scoped to one download), so a panel that mounts
   * mid-download can pick up the state it missed.
   */
  readonly onDidChangeDownload: Event<ICodexBinaryDownloadEvent>

  resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult>

  /**
   * Returns version metadata for the download-mode binary, as the given policy
   * would resolve it: under `'pinned'` the effective version is always the pin,
   * so a version a user picked earlier reports as not installed. When `authority`
   * is set, the metadata is read from that remote host's binary store instead of
   * the local one.
   */
  getVersionInfo(
    policy: AgentBinaryVersionPolicy,
    authority?: string,
  ): Promise<ICodexBinaryVersionInfo>

  /**
   * Best-effort background download of the most desirable version into its own
   * dir, so a later forceDownload() needs no network: the registry's latest under
   * `'manual'`, the pinned version under `'pinned'`. No-op when the desired
   * version is already installed. Never throws — network failures are swallowed
   * so idle prefetch never disrupts the user.
   *
   * When `authority` is set, the prefetch runs on that remote host's managed
   * store (download semantics only — `acp.codex.source` is a local setting and
   * is not consulted across the tunnel).
   */
  prefetch(policy: AgentBinaryVersionPolicy, authority?: string): Promise<void>

  /**
   * Switches to `version` by flipping the `.active` pointer to its own per-version
   * tree, downloading it only when it isn't on disk yet. Because each version has
   * its own tree, activation never overwrites the running binary's locked files
   * (the EPERM trap on Windows), and a version already on disk — the pinned one,
   * or the latest after a previous download — is re-activated with zero network.
   * The previous version's tree is left in place. When `authority` is set, the
   * download/activation happens on that remote host.
   */
  forceDownload(version: string, authority?: string): Promise<ICodexBinaryResult>

  /**
   * Removes version trees the user can no longer switch to offline (anything
   * outside active / pinned / last-seen latest). Safe to call only at
   * startup/idle — mid-session the predecessor binary is still locked by the
   * running agent. Best-effort; never throws. When `authority` is set, the sweep
   * runs on that remote host's store instead of the local one.
   */
  cleanupStaleVersions(authority?: string): Promise<void>

  /**
   * Aligns the managed-download tree with the pinned codex version after the
   * editor's pin changed (an upgrade), so the user stops running the previous
   * pin without touching anything. Runs at idle; a version the user picked by
   * hand is preserved until the pin itself changes again (under the locked policy
   * there is no pick to preserve — `resolve` never reads `.active`). Returns the version it
   * switched to, or null when there was nothing to do — the pin never changed,
   * no managed binary was ever downloaded, or the alignment failed (it is
   * retried next session). Against the local store it is best-effort and never
   * throws, so a caller only uses the return value to decide whether to notify;
   * with `authority` a tunnel failure still rejects (callers there must catch). When `authority` is set, the
   * alignment happens on that remote host's store.
   */
  syncBundled(authority?: string): Promise<string | null>
}

export const ICodexBinaryService = createDecorator<ICodexBinaryService>('codexBinaryService')
