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
  URI,
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
import type { IAcpPathPolicy } from '../acp/acpPathPolicy.js'

/** Upper bound for the `rg --files` enumeration behind `workspace.findFiles`;
 *  the include-glob filter and the caller's `maxResults` apply on top. */
const FIND_FILES_ENUMERATION_CAP = 100_000

export class MainThreadFs implements IMainThreadFs {
  /** Lazily resolved, symlink-followed form of `_cwd` (see `_getCanonicalCwd`). */
  private _canonicalCwd: Promise<string | undefined> | undefined

  constructor(
    /** Workspace root used as the policy's containment boundary. */
    private readonly _cwd: string | undefined,
    private readonly _policy: IAcpPathPolicy,
    private readonly _files: IFileService,
    private readonly _fileSearch: IFileSearchService,
    /** The configured default search excludes (files.exclude ∪ search.exclude). */
    private readonly _defaultExcludes: () => readonly string[],
    private readonly _logger: ILogger,
    private readonly _platform: HostPlatform,
  ) {}

  private async _guard(path: string): Promise<URI> {
    if (this._cwd === undefined) {
      throw new Error('workspace.fs requires an open workspace folder')
    }
    const decision = this._policy.check(this._cwd, path)
    if (!decision.ok) {
      throw new Error(`workspace.fs denied: ${decision.reason}`)
    }
    const uri = URI.file(decision.normalized)
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
    const decision = this._policy.check(canonicalCwd ?? (this._cwd as string), real.fsPath)
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
      if (this._cwd === undefined || !this._files.realpath) return this._cwd
      try {
        return (await this._files.realpath(URI.file(this._cwd))).fsPath
      } catch {
        return this._cwd
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
    let includeBase: URI | undefined
    if (typeof include !== 'string') {
      try {
        includeBase = await this._resolveRelativePatternBase(include.base)
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
            typeof entry === 'string' ? [entry] : this._foldExcludeForEngine(entry, includeBase),
          )
    const complete = await this._fileSearch.search(
      {
        root: includeBase ?? URI.file(this._cwd),
        pattern: '',
        matchAll: true,
        excludes: engineExcludes,
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
   */
  private async _resolveRelativePatternBase(baseDto: IRelativePatternDto['base']): Promise<URI> {
    const uri = URI.revive(baseDto)
    if (!uri) {
      throw new Error('workspace.findFiles: RelativePattern base is not a valid URI')
    }
    if (uri.scheme !== 'file') {
      throw new Error(
        `workspace.findFiles: RelativePattern base must be a file: URI (got ${uri.scheme})`,
      )
    }
    await this._guard(uri.fsPath)
    const root = this._files.realpath ? await this._files.realpath(uri) : uri
    const canonicalCwd = await this._getCanonicalCwd()
    if (
      relativePathUnder(canonicalCwd ?? (this._cwd as string), root.fsPath, this._platform) === null
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
  ): string[] {
    const baseUri = URI.revive(entry.base)
    if (!baseUri) return []
    const root = (includeBase ?? URI.file(this._cwd as string)).fsPath
    const prefix = relativePathUnder(root, baseUri.fsPath, this._platform)
    if (prefix === null) return []
    const pattern = normalizeExtensionGlobPattern(entry.pattern)
    if (pattern === '') return []
    return [prefix === '' ? pattern : `${prefix}/${pattern}`]
  }
}
