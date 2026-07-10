/**
 * Provides the "have" revision content of a file for diffs. The SCM baseline in
 * Perforce is the depot revision you last synced (`#have`), whose content lives
 * on the server — fetched with `p4 print -q <file>#have`. Results are cached by
 * `depotPath#rev` so an unchanged revision isn't re-fetched (network savings).
 *
 * Unlike git's local HEAD blob, every baseline read is a server round-trip, so
 * caching matters. The cache is keyed on the resolved revision (from fstat), not
 * just the path, so a new sync invalidates naturally.
 */
import type { P4Service } from './p4Service.js'
import { parseFstat } from './fstatParser.js'

export class BaselineProvider {
  private readonly _cache = new Map<string, string>()

  constructor(private readonly _p4: P4Service) {}

  /**
   * Content of `localPath` at its have revision, or undefined when the file has
   * no have revision (e.g. an open-for-add file that isn't in the depot yet).
   */
  async getHaveContent(localPath: string): Promise<string | undefined> {
    const fstat = await this._p4.execRecords(['fstat', localPath])
    if (fstat.result.exitCode !== 0) return undefined
    const info = parseFstat(fstat.records)[0]
    if (!info || !info.haveRev) return undefined

    const cacheKey = `${info.depotFile}#${info.haveRev}`
    const cached = this._cache.get(cacheKey)
    if (cached !== undefined) return cached

    const print = await this._p4.exec(['print', '-q', `${info.depotFile}#${info.haveRev}`])
    if (print.exitCode !== 0) return undefined
    this._cache.set(cacheKey, print.stdout)
    return print.stdout
  }

  clear(): void {
    this._cache.clear()
  }
}
