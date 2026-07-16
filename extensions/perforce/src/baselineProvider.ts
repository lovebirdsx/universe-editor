/**
 * Provides the "have" revision content of a file for diffs. The SCM baseline in
 * Perforce is the depot revision you last synced (`#have`), whose content lives
 * on the server — fetched with `p4 print -q <file>#have`.
 *
 * Every baseline read is a server round-trip (unlike git's local HEAD blob), so
 * results are cached through the shared {@link P4Cache}'s immutable `print`
 * namespace, keyed on the resolved `depotFile#rev`. A new sync changes the have
 * revision, so the key changes and the old content is never mis-served; the
 * content itself is immutable, so it can even persist across sessions.
 */
import type { P4Service } from './p4Service.js'
import { parseFstat } from './fstatParser.js'
import { P4Cache, P4CacheNs } from './p4Cache.js'

export class BaselineProvider {
  constructor(
    private readonly _p4: P4Service,
    private readonly _cache: P4Cache,
  ) {}

  /**
   * Content of `localPath` at its have revision, or undefined when the file has
   * no have revision (e.g. an open-for-add file that isn't in the depot yet).
   */
  async getHaveContent(localPath: string): Promise<string | undefined> {
    const fstat = await this._p4.execRecords(['fstat', localPath])
    if (fstat.result.exitCode !== 0) return undefined
    const info = parseFstat(fstat.records)[0]
    if (!info || !info.haveRev) return undefined

    const spec = `${info.depotFile}#${info.haveRev}`
    return this._cache.wrap(P4CacheNs.print, spec, async () => {
      const print = await this._p4.exec(['print', '-q', spec])
      return print.exitCode === 0 ? print.stdout : undefined
    })
  }

  /**
   * Have-revision content of `localPath` as raw bytes, for binary files (e.g.
   * xlsx) that a UTF-8 string baseline would corrupt. Not cached (binary blobs
   * bypass the string `print` cache); returns undefined when there is no have rev.
   */
  async getHaveContentBytes(localPath: string): Promise<Buffer | undefined> {
    const fstat = await this._p4.execRecords(['fstat', localPath])
    if (fstat.result.exitCode !== 0) return undefined
    const info = parseFstat(fstat.records)[0]
    if (!info || !info.haveRev) return undefined
    const spec = `${info.depotFile}#${info.haveRev}`
    const print = await this._p4.execBinary(['print', '-q', spec])
    return print.exitCode === 0 ? print.stdout : undefined
  }
}
