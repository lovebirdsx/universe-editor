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
 *  It also owns the `typescript.prewarm.projects` setting. tsserver's navto only
 *  searches the project owning an open file, and a monorepo has many tsconfigs;
 *  the TS plugin reads this list to decide which projects to warm. We register it
 *  with an `enum` of the workspace's real tsconfig paths (re-scanned when the
 *  workspace changes) so settings.json gives completion + typo warnings for it.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  IFileSearchService,
  IWorkbenchContribution,
  IWorkspaceService,
  localize,
  MutableDisposable,
  runWhenIdle,
} from '@universe-editor/platform'
import { languageActivationEvent } from '@universe-editor/extensions-common'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'

const DEFAULT_PREWARM_LANGUAGES = ['typescript', 'markdown']

/** Directories never worth walking when enumerating tsconfigs for the enum. */
const TSCONFIG_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', '.next']
/** Cap the enum so a pathological tree can't produce an unwieldy schema. */
const MAX_TSCONFIGS = 200

export class LanguageServicePrewarmContribution
  extends Disposable
  implements IWorkbenchContribution
{
  /** The re-registerable `typescript.prewarm.projects` node (its enum tracks the
   *  workspace's tsconfigs), kept separate from the static `languageServices` node.
   *  A MutableDisposable so each re-register parents the fresh registration under a
   *  singleton root — a plain field would be flagged as a leak by the disposable
   *  tracker (it roots to nothing) even while the contribution is alive. */
  private readonly _tsProjectsConfig = this._register(new MutableDisposable())

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
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

    // Owned here alongside the other typescript.* setting; the TS plugin reads it
    // on every tsserver (re)start, so raising it applies on the next crash-restart.
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'typescript.tsserver',
        title: localize('settings.typescript', 'TypeScript'),
        properties: {
          'typescript.tsserver.maxTsServerMemory': {
            type: 'number',
            default: 3072,
            minimum: 128,
            description: localize(
              'settings.typescript.tsserver.maxTsServerMemory',
              'The maximum amount of memory (in MB) the TypeScript server may use. Raise this if the TypeScript language server crashes with out-of-memory on large projects (a crash notification will point here). Applies when the server (re)starts.',
            ),
          },
        },
      }),
    )

    void this._refreshTsProjectsSchema()
    this._register(this._workspace.onDidChangeWorkspace(() => void this._refreshTsProjectsSchema()))

    this._register(runWhenIdle(globalThis, () => void this._prewarm()))
    // A workspace swap / crash relaunches the host, which only re-fires the
    // startup events — the language plugins (onLanguage:*) would stay dormant.
    // onDidChangeContributions fires once the relaunched host's contracts are
    // ready, so re-prewarm then.
    this._register(this._client.onDidChangeContributions(() => void this._prewarm()))
  }

  /**
   * (Re)register `typescript.prewarm.projects` with an `enum` of the workspace's
   * real tsconfig paths, so settings.json offers completion and flags typos.
   * Re-registering fires `onDidRegisterConfiguration`, which rebuilds the Monaco
   * settings schema (see JsonSchemaBridgeContribution) — the completion refreshes
   * whenever the workspace (and hence its tsconfig set) changes.
   */
  private async _refreshTsProjectsSchema(): Promise<void> {
    await this._workspace.whenReady
    const tsconfigs = await this._scanTsconfigs()
    // Disposed while we awaited the workspace / file search — don't leak a fresh
    // registration the dispose already ran past.
    if (this._store.isDisposed) return

    this._tsProjectsConfig.value = ConfigurationRegistry.registerConfiguration({
      id: 'typescript.prewarm',
      title: localize('settings.typescript', 'TypeScript'),
      properties: {
        'typescript.prewarm.projects': {
          type: 'array',
          items: tsconfigs.length > 0 ? { type: 'string', enum: tsconfigs } : { type: 'string' },
          default: [],
          description: localize(
            'settings.typescript.prewarm.projects',
            'Workspace-relative tsconfig paths whose TypeScript project is prewarmed so its symbols are searchable before you open a file. A single-tsconfig project is warmed automatically; in a multi-tsconfig workspace nothing is warmed unless listed here.',
          ),
        },
      },
    })
  }

  /** Enumerate `tsconfig*.json` in the workspace as workspace-relative paths. */
  private async _scanTsconfigs(): Promise<string[]> {
    const root = this._workspace.current?.folder
    if (!root) return []
    try {
      const complete = await this._fileSearch.search({
        root,
        pattern: '',
        matchAll: true,
        ignore: TSCONFIG_IGNORE_DIRS,
        maxResults: 5000,
      })
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
