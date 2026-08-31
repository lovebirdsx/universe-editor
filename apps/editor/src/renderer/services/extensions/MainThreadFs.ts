/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadFs — the renderer end of `workspace.fs`. The extension host calls
 *  these `$`-methods; each one passes through the same path policy that guards
 *  ACP agents (denies `.ssh`/`.aws`/`.env`…, forbids escaping the workspace
 *  root) before delegating to IFileService. File contents cross the wire as
 *  base64 strings.
 *
 *  Defense in depth: the policy is text-level (it can't see symlinks). After it
 *  passes, we resolve the real, symlink-followed path via IFileService.realpath
 *  and re-run the policy on it — so a workspace-internal symlink pointing at
 *  `~/.ssh` (or anywhere outside the root) is still rejected. Falls back to the
 *  text-only decision if the file service has no realpath.
 *--------------------------------------------------------------------------------------------*/

import {
  REMOTE_SCHEME,
  URI,
  fsPathToWorkspaceUri,
  normalizePlatform,
  relativePathUnder,
  type CancellationToken,
  type HostPlatform,
  type IFileSearchService,
  type IFileService,
  type ILogger,
} from '@universe-editor/platform'
import {
  base64ToBytes,
  bytesToBase64,
  compileGlobMatcher,
  normalizeExtensionGlobPattern,
  type ExtHostFileType,
  type IExtHostFileStatDto,
  type IMainThreadFs,
  type IRelativePatternDto,
} from '@universe-editor/extensions-common'
import type { IRemoteStatusService } from '../../../shared/ipc/remoteStatusService.js'
import type { AcpPathPolicyEnv, IAcpPathPolicy } from '../acp/acpPathPolicy.js'

/** Upper bound for the `rg --files` enumeration behind `workspace.findFiles`;
 *  the include-glob filter and the caller's `maxResults` apply on top. */
const FIND_FILES_ENUMERATION_CAP = 100_000

/** Path-policy facts for a remote host we couldn't interrogate. Supported remote
 *  targets are POSIX, and a `/` home makes the sensitive-prefix probes fall away
 *  rather than deny real paths (SimpleFileDialog degrades the same way). */
const FALLBACK_REMOTE_ENV: AcpPathPolicyEnv = { platform: 'linux', home: '/' }

export class MainThreadFs implements IMainThreadFs {
  // `workspace.fs` spans two URI spaces: a local workspace resolves paths to
  // `file:`, a remote one to `remote-ssh://<authority>`. The wire carries *bare
  // path strings*, which the host↔renderer codec never transforms (it only
  // translates $mid-stamped UriComponents) — so a remote host's paths arrive as
  // that host's own native paths and must be re-attached to `_authority` here.
  // Resolving them with `URI.file` would send every read to the client's disk.
  /** Lazily resolved, symlink-followed form of `_cwd` (see `_getCanonicalCwd`). */
  private _canonicalCwd: Promise<string | undefined> | undefined
  /** Memoized remote path-policy env; see `_getRemoteEnv`. */
  private _remoteEnv: Promise<AcpPathPolicyEnv | undefined> | undefined
  /** Whether the last env lookup degraded — keeps the retry loop's warn to one. */
  private _remoteEnvDegraded = false
  /**
   * The containment base handed to the policy, in the host's *native* path form.
   * On a Windows remote `_cwd` is the URI's leading-slash drive form (`/C:/x`)
   * while the host reports native `C:\x` — and `relativePathUnder` compares drive
   * letters with an anchored regex that never matches `/C:`, so the two forms
   * would deny every gated read. `.fsPath` folds both to `C:/x`; identity for
   * local workspaces and POSIX remotes.
   */
  private readonly _policyCwd: string | undefined

  constructor(
    /** Workspace root used as the policy's containment boundary. */
    private readonly _cwd: string | undefined,
    /** Remote authority this host is pinned to; undefined for a local workspace. */
    private readonly _authority: string | undefined,
    private readonly _policy: IAcpPathPolicy,
    private readonly _files: IFileService,
    private readonly _fileSearch: IFileSearchService,
    /** The configured default search excludes (files.exclude ∪ search.exclude). */
    private readonly _defaultExcludes: () => readonly string[],
    /** Whether searches honour .gitignore / .ignore (`search.useIgnoreFiles`). */
    private readonly _useIgnoreFiles: () => boolean,
    private readonly _logger: ILogger,
    private readonly _platform: HostPlatform,
    private readonly _remoteStatus: IRemoteStatusService,
  ) {
    this._policyCwd =
      _cwd !== undefined && _authority !== undefined
        ? fsPathToWorkspaceUri(_cwd, _authority).fsPath
        : _cwd
  }

  /**
   * The containment base, or a thrown error when no folder is open. Every gated
   * entry point needs both the base and that check, so they share one accessor.
   */
  private _requirePolicyCwd(operation: string): string {
    if (this._policyCwd === undefined) {
      throw new Error(`${operation} requires an open workspace folder`)
    }
    return this._policyCwd
  }

  /** The workspace root as a resource: `file:` locally, `remote-ssh:` remotely. */
  private _rootUri(): URI {
    return fsPathToWorkspaceUri(this._requirePolicyCwd('workspace.fs'), this._authority)
  }

  /**
   * The remote host's path-policy environment (platform + home), so the
   * sensitive-prefix and case-sensitivity checks apply to the *remote*
   * filesystem. Without it a remote `~/.ssh/id_rsa` sails past a probe built
   * from the client's home. Undefined for a local workspace — the policy then
   * uses its own local env.
   *
   * Only a *successful* lookup is memoized. An authority mid-reconnect reports
   * no environment, and the host survives transparent reconnects — caching that
   * answer would leave the remote sensitive-prefix probes blind for the rest of
   * the connection's life.
   */
  private _getRemoteEnv(): Promise<AcpPathPolicyEnv | undefined> {
    if (this._authority === undefined) return Promise.resolve(undefined)
    if (!this._remoteEnv) {
      const pending: Promise<AcpPathPolicyEnv> = this._remoteStatus
        .getEnvironment(this._authority)
        .then((env) =>
          env ? { platform: normalizePlatform(env.os), home: env.homeDir } : undefined,
        )
        .catch(() => undefined)
        .then((env) => {
          if (env) {
            this._remoteEnvDegraded = false
            return env
          }
          if (this._remoteEnv === pending) this._remoteEnv = undefined
          if (!this._remoteEnvDegraded) {
            this._remoteEnvDegraded = true
            this._logger.warn(
              `workspace.fs: remote environment for ${this._authority} unavailable, ` +
                `path policy degrading to POSIX facts (will retry)`,
            )
          }
          return FALLBACK_REMOTE_ENV
        })
      this._remoteEnv = pending
    }
    return this._remoteEnv
  }

  private async _guard(path: string): Promise<URI> {
    const decision = this._policy.check(
      this._requirePolicyCwd('workspace.fs'),
      path,
      await this._getRemoteEnv(),
    )
    if (!decision.ok) {
      throw new Error(`workspace.fs denied: ${decision.reason}`)
    }
    const uri = fsPathToWorkspaceUri(decision.normalized, this._authority)
    await this._guardRealpath(uri)
    return uri
  }

  /**
   * Second line of defense: re-run the policy against the symlink-resolved real
   * path. The text policy already vetted the literal path; this catches a
   * symlink whose real target escapes the workspace or lands on a sensitive
   * prefix. No-op when the file service can't resolve real paths.
   */
  private async _guardRealpath(uri: URI): Promise<void> {
    if (!this._files.realpath) return
    let real: URI
    try {
      real = await this._files.realpath(uri)
    } catch {
      // realpath shouldn't normally fail (it tolerates missing tails), but if it
      // does we keep the text-level guarantee rather than failing the operation.
      return
    }
    // Compare the canonical target against the *canonical* cwd. `_cwd` may carry
    // a non-canonical form of the same directory — symlinked, or (on Windows CI,
    // whose temp dir lives under an 8.3 short name like `RUNNER~1`) the short
    // name — while realpath always returns the long/real form. Comparing the
    // real target to a non-canonical cwd would spuriously read as "escapes
    // workspace root" and deny every gated read of an unopened file.
    const canonicalCwd = await this._getCanonicalCwd()
    const decision = this._policy.check(
      canonicalCwd ?? this._requirePolicyCwd('workspace.fs'),
      real.fsPath,
      await this._getRemoteEnv(),
    )
    if (!decision.ok) {
      throw new Error(`workspace.fs denied (real path): ${decision.reason}`)
    }
  }

  /**
   * Canonicalize `_cwd` the same way realpath canonicalizes targets, so the
   * containment check in `_guardRealpath` compares like with like. Resolved
   * once and cached; falls back to the literal cwd if realpath is unavailable
   * or throws.
   */
  private _getCanonicalCwd(): Promise<string | undefined> {
    if (this._canonicalCwd) return this._canonicalCwd
    this._canonicalCwd = (async () => {
      if (this._cwd === undefined || !this._files.realpath) return this._policyCwd
      try {
        return (await this._files.realpath(this._rootUri())).fsPath
      } catch {
        return this._policyCwd
      }
    })()
    return this._canonicalCwd
  }

  async $readFile(path: string): Promise<string> {
    const bytes = await this._files.readFile(await this._guard(path))
    return bytesToBase64(bytes)
  }

  async $writeFile(path: string, base64: string): Promise<void> {
    return this._files.writeFile(await this._guard(path), base64ToBytes(base64))
  }

  async $stat(path: string): Promise<IExtHostFileStatDto> {
    const stat = await this._files.stat(await this._guard(path))
    return { type: stat.isDirectory ? 'dir' : 'file', size: stat.size, mtime: stat.mtime }
  }

  async $readDirectory(path: string): Promise<Array<[string, ExtHostFileType]>> {
    const entries = await this._files.list(await this._guard(path))
    return entries.map((e) => [e.name, e.isDirectory ? 'dir' : 'file'])
  }

  async $createDirectory(path: string): Promise<void> {
    return this._files.createDirectory(await this._guard(path))
  }

  async $delete(path: string, recursive: boolean): Promise<void> {
    return this._files.delete(await this._guard(path), { recursive })
  }

  async $rename(source: string, target: string, overwrite: boolean): Promise<void> {
    const [from, to] = await Promise.all([this._guard(source), this._guard(target)])
    return this._files.rename(from, to, { overwrite })
  }

  async $copy(source: string, target: string, overwrite: boolean): Promise<void> {
    const [from, to] = await Promise.all([this._guard(source), this._guard(target)])
    return this._files.copy(from, to, { overwrite })
  }

  /**
   * `workspace.findFiles`: enumerate the workspace live (matchAll walks with rg,
   * never the stale listing cache), then apply the include glob to each match's
   * relative path. A RelativePattern include roots the walk at its base folder
   * (resolved through the path policy, symlink check included) and matches
   * against base-relative paths. Excludes are folded into the engine query —
   * string entries as-is, RelativePattern entries rebased against the
   * enumeration root — so the engine prunes them during the walk and they never
   * consume the enumeration cap. The token comes from the RPC cancel path and
   * is handed to the enumeration itself, so a cancelled request kills the
   * underlying `rg` walk instead of discarding a late result.
   */
  async $findFiles(
    include: string | IRelativePatternDto,
    exclude: readonly (string | IRelativePatternDto)[] | null,
    maxResults: number | null,
    token?: CancellationToken,
  ): Promise<string[]> {
    if (this._cwd === undefined) {
      throw new Error('workspace.findFiles requires an open workspace folder')
    }
    // Containment comparisons below must use the *host's* case-sensitivity, not
    // the client's: a POSIX remote browsed from Windows would otherwise fold
    // `/home/Dev/evil` into `/home/dev/repo` and let it through.
    const platform = (await this._getRemoteEnv())?.platform ?? this._platform
    let includeBase: URI | undefined
    if (typeof include !== 'string') {
      try {
        includeBase = await this._resolveRelativePatternBase(include.base, platform)
      } catch (err) {
        // VSCode resolves an unusable RelativePattern to an empty result list
        // rather than surfacing an RPC error to the extension; the policy guard
        // still holds — nothing outside the workspace is ever enumerated.
        this._logger.warn(`findFiles: ${(err as Error).message}; returning no results`)
        return []
      }
    }
    const engineExcludes =
      exclude === null
        ? [...this._defaultExcludes()]
        : exclude.flatMap((entry) =>
            typeof entry === 'string'
              ? [entry]
              : this._foldExcludeForEngine(entry, includeBase, platform),
          )
    const complete = await this._fileSearch.search(
      {
        root: includeBase ?? this._rootUri(),
        pattern: '',
        matchAll: true,
        excludes: engineExcludes,
        useIgnoreFiles: this._useIgnoreFiles(),
        maxResults: FIND_FILES_ENUMERATION_CAP,
      },
      token,
    )
    if (complete.limitHit) {
      this._logger.warn(
        `findFiles enumeration truncated at the ${FIND_FILES_ENUMERATION_CAP}-entry cap ` +
          `(${complete.results.length} results walked, stopReason: ${complete.stopReason ?? 'maxResults'}); ` +
          'results beyond the cap were dropped',
      )
    }
    const matches = compileGlobMatcher(typeof include === 'string' ? include : include.pattern)
    const out: string[] = []
    for (const match of complete.results) {
      if (!matches(match.relativePath)) continue
      out.push(match.fsPath)
      if (maxResults !== null && out.length >= maxResults) break
    }
    return out
  }

  /**
   * Resolve a RelativePattern's base URI to an enumeration root. The literal
   * path goes through the same text policy as every other gated call; the
   * symlink-followed real path is then re-checked for containment and becomes
   * the search root — so a base whose real target escapes the workspace is
   * rejected rather than silently walked.
   *
   * A remote host sends `file:` bases, but the codec translates them to
   * `remote-ssh:` before they reach us — so both schemes are legitimate here,
   * and `_guard` re-attaches the current authority either way.
   */
  private async _resolveRelativePatternBase(
    baseDto: IRelativePatternDto['base'],
    platform: HostPlatform,
  ): Promise<URI> {
    const uri = URI.revive(baseDto)
    if (!uri) {
      throw new Error('workspace.findFiles: RelativePattern base is not a valid URI')
    }
    if (uri.scheme !== 'file' && uri.scheme !== REMOTE_SCHEME) {
      throw new Error(
        `workspace.findFiles: RelativePattern base must be a file: or ${REMOTE_SCHEME}: URI (got ${uri.scheme})`,
      )
    }
    const guarded = await this._guard(uri.fsPath)
    const root = this._files.realpath ? await this._files.realpath(guarded) : guarded
    const canonicalCwd = await this._getCanonicalCwd()
    if (
      relativePathUnder(
        canonicalCwd ?? this._requirePolicyCwd('workspace.findFiles'),
        root.fsPath,
        platform,
      ) === null
    ) {
      throw new Error('workspace.findFiles: RelativePattern base escapes the workspace folder')
    }
    return root
  }

  /**
   * Fold a RelativePattern exclude into one enumeration-root-relative glob the
   * engine can prune during its walk: the base's prefix beneath the root is
   * prepended to the pattern. A base outside the root (or an invalid base URI)
   * can never match anything in this enumeration and folds to nothing.
   */
  private _foldExcludeForEngine(
    entry: IRelativePatternDto,
    includeBase: URI | undefined,
    platform: HostPlatform,
  ): string[] {
    const baseUri = URI.revive(entry.base)
    if (!baseUri) return []
    const root = (includeBase ?? this._rootUri()).fsPath
    const prefix = relativePathUnder(root, baseUri.fsPath, platform)
    if (prefix === null) return []
    const pattern = normalizeExtensionGlobPattern(entry.pattern)
    if (pattern === '') return []
    return [prefix === '' ? pattern : `${prefix}/${pattern}`]
  }
}
