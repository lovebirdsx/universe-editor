/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Idle-time prewarm of language services so opening the first file of a given
 *  language doesn't pay the cold start. Firing `onLanguage:<id>` activates the
 *  owning built-in plugin ahead of time; the TypeScript plugin further eager-
 *  spawns its tsserver and pins the workspace project on activation, so by the
 *  time a .ts file opens the server is warm and symbols are already searchable.
 *  Runs in the Eventually phase behind `runWhenIdle` (off the first-paint path),
 *  and re-runs whenever the extension host relaunches — a workspace swap or crash
 *  restart re-fires only the startup events, not `onLanguage:*`, so without this
 *  the new host never re-activates the language plugins.
 *
 *  It also owns the `js/ts.prewarm.projects` setting. tsserver's navto only
 *  searches the project owning an open file, and a monorepo has many tsconfigs;
 *  the TS plugin reads this list to decide which projects to warm. We register it
 *  with an `enum` of the workspace's real tsconfig paths (re-scanned when the
 *  workspace changes) so settings.json gives completion + typo warnings for it.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  IFileSearchService,
  IWorkbenchContribution,
  IWorkspaceService,
  localize,
  MutableDisposable,
  runWhenIdle,
  toDisposable,
  type CancellationToken,
} from '@universe-editor/platform'
import { languageActivationEvent } from '@universe-editor/extensions-common'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { IFocusScopeService } from '../services/focus/FocusScopeService.js'

const DEFAULT_PREWARM_LANGUAGES = ['typescript', 'markdown']

/** Directories never worth walking when enumerating tsconfigs for the enum. */
const TSCONFIG_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', '.next']
/** Cap the enum so a pathological tree can't produce an unwieldy schema. */
const MAX_TSCONFIGS = 200

export class LanguageServicePrewarmContribution
  extends Disposable
  implements IWorkbenchContribution
{
  /** The re-registerable `js/ts.prewarm.projects` node (its enum tracks the
   *  workspace's tsconfigs), kept separate from the static `languageServices` node.
   *  A MutableDisposable so each re-register parents the fresh registration under a
   *  singleton root — a plain field would be flagged as a leak by the disposable
   *  tracker (it roots to nothing) even while the contribution is alive. */
  private readonly _tsProjectsConfig = this._register(new MutableDisposable())

  /** Cancels the previous tsconfig walk when a workspace swap starts a new one
   *  (and on dispose) — on a huge tree the walk is expensive main-process I/O
   *  that must not outlive the refresh that wanted it. */
  private readonly _tsconfigScan = this._register(new MutableDisposable())

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
    @IFocusScopeService private readonly _focus: IFocusScopeService,
  ) {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'languageServices',
        title: localize('settings.languageServices', 'Language Services'),
        properties: {
          'languageServices.prewarm': {
            type: 'array',
            items: { type: 'string' },
            default: DEFAULT_PREWARM_LANGUAGES,
            description: localize(
              'settings.languageServices.prewarm',
              'Language ids whose language service is prewarmed once the workspace is idle, so opening the first file of that language has no startup delay. Set to [] to disable.',
            ),
          },
        },
      }),
    )

    // Owned here alongside the other js/ts.* settings; the TS plugin reads them
    // on every server (re)start, so raising them applies on the next
    // crash-restart.
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'js/ts.tsserver',
        title: localize('settings.typescript', 'TypeScript'),
        properties: {
          'js/ts.tsserver.maxMemory': {
            type: 'number',
            default: 3072,
            minimum: 128,
            description: localize(
              'settings.js/ts.tsserver.maxMemory',
              'The maximum amount of memory (in MB) the TypeScript server may use. Raise this if the TypeScript language server crashes with out-of-memory on large projects (a crash notification will point here). Applies when the server (re)starts.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'js/ts.experimental',
        title: localize('settings.typescript', 'TypeScript'),
        properties: {
          'js/ts.experimental.useTsgo': {
            type: 'boolean',
            // Shared with the main process's settings.json fallback — changing
            // only this schema default does NOT reach main.
            default: false,
            description: localize(
              'settings.js/ts.experimental.useTsgo',
              'Use the experimental Go native TypeScript language server (tsgo) instead of the vendored typescript-language-server. Read by the main process when the extension host spawns, so changing it needs a window restart to take effect.',
            ),
          },
        },
      }),
    )

    void this._refreshTsProjectsSchema()
    this._register(this._workspace.onDidChangeWorkspace(() => void this._refreshTsProjectsSchema()))
    // 聚焦范围变化时 tsconfig 枚举集合随之变化，schema enum 也要重扫。
    this._register(this._focus.onDidChange(() => void this._refreshTsProjectsSchema()))

    this._register(runWhenIdle(globalThis, () => void this._prewarm()))
    // A workspace swap / crash relaunches the host, which only re-fires the
    // startup events — the language plugins (onLanguage:*) would stay dormant.
    // onDidChangeContributions fires once the relaunched host's contracts are
    // ready, so re-prewarm then.
    this._register(this._client.onDidChangeContributions(() => void this._prewarm()))
  }

  /**
   * (Re)register `js/ts.prewarm.projects` with an `enum` of the workspace's
   * real tsconfig paths, so settings.json offers completion and flags typos.
   * Re-registering fires `onDidRegisterConfiguration`, which rebuilds the Monaco
   * settings schema (see JsonSchemaBridgeContribution) — the completion refreshes
   * whenever the workspace (and hence its tsconfig set) changes.
   */
  private async _refreshTsProjectsSchema(): Promise<void> {
    const cts = new CancellationTokenSource()
    this._tsconfigScan.value = toDisposable(() => cts.dispose(true))
    await this._workspace.whenReady
    const tsconfigs = await this._scanTsconfigs(cts.token)
    // Disposed or superseded by a newer refresh while we awaited — registering
    // now would clobber the newer scan's schema with stale (or empty) paths.
    if (this._store.isDisposed || cts.token.isCancellationRequested) return

    this._tsProjectsConfig.value = ConfigurationRegistry.registerConfiguration({
      id: 'js/ts.prewarm',
      title: localize('settings.typescript', 'TypeScript'),
      properties: {
        'js/ts.prewarm.projects': {
          type: 'array',
          items: tsconfigs.length > 0 ? { type: 'string', enum: tsconfigs } : { type: 'string' },
          default: [],
          description: localize(
            'settings.js/ts.prewarm.projects',
            'Workspace-relative tsconfig paths whose TypeScript project is prewarmed so its symbols are searchable before you open a file. A single-tsconfig project is warmed automatically; in a multi-tsconfig workspace nothing is warmed unless listed here.',
          ),
        },
      },
    })
  }

  /** Enumerate `tsconfig*.json` in the workspace as workspace-relative paths. */
  private async _scanTsconfigs(token: CancellationToken): Promise<string[]> {
    const root = this._workspace.current?.folder
    if (!root) return []
    try {
      const complete = await this._fileSearch.search(
        {
          root,
          pattern: '',
          matchAll: true,
          ignore: TSCONFIG_IGNORE_DIRS,
          maxResults: 5000,
          ...(this._focus.active ? { scanPaths: [...this._focus.folders] } : {}),
          rootFilesInScope: this._focus.rootFilesInScope,
        },
        token,
      )
      const paths = complete.results
        .filter((m) => /^tsconfig(\..+)?\.json$/i.test(m.basename))
        .map((m) => m.relativePath.replace(/\\/g, '/'))
        .sort()
      return paths.slice(0, MAX_TSCONFIGS)
    } catch {
      return []
    }
  }

  private async _prewarm(): Promise<void> {
    const languages = this._config.get<string[]>(
      'languageServices.prewarm',
      DEFAULT_PREWARM_LANGUAGES,
    )
    if (!languages || languages.length === 0) return

    await this._workspace.whenReady
    await Promise.all(
      languages.map((lang) =>
        this._client.activateByEvent(languageActivationEvent(lang)).catch(() => undefined),
      ),
    )
  }
}
