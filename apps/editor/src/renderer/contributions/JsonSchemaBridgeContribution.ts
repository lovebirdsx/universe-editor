/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Bridges the platform JSONContributionRegistry into Monaco's JSON language
 *  service. Derives schemas for settings.json / keybindings.json from the live
 *  ConfigurationRegistry / CommandsRegistry, re-deriving whenever those
 *  registries change so dynamically-added settings or commands surface in
 *  completion right away.
 *
 *  Our strict schemas (additionalProperties: false) only target our *own* files,
 *  matched by their exact on-disk path (which follows the active config dir /
 *  workspace). A blanket `**​/settings.json` glob would also flag unrelated
 *  same-named files the user opens (e.g. ~/.claude/settings.json). The VSCode
 *  compatibility layer keeps its broad glob on purpose — inheriting VSCode
 *  settings is intended.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  ConfigurationRegistry,
  Disposable,
  ILoggerService,
  IUserDataFilesService,
  IWorkspaceService,
  IWorkbenchContribution,
  JSONContributionRegistry,
  NullLogger,
  UserDataFile,
  type IJSONSchema,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type ISchemaContribution,
} from '@universe-editor/platform'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'
import { MonacoLoader, setMonacoLoaderLogger } from '../workbench/editor/monaco/MonacoLoader.js'
import { buildSettingsJsonSchema } from '../services/preferences/buildSettingsJsonSchema.js'
import { buildKeybindingsJsonSchema } from '../services/keybindings/buildKeybindingsJsonSchema.js'
import { schemaFileMatchForUri } from '../services/preferences/schemaFileMatch.js'

const SETTINGS_USER_URI = 'universe-editor://schemas/settings/user'
const SETTINGS_PROJECT_URI = 'universe-editor://schemas/settings/project'
const SETTINGS_VSCODE_URI = 'universe-editor://schemas/settings/vscode'
const KEYBINDINGS_URI = 'universe-editor://schemas/keybindings'

type SchemaDisposable = ReturnType<typeof JSONContributionRegistry.registerSchema>

export class JsonSchemaBridgeContribution extends Disposable implements IWorkbenchContribution {
  private _settingsDisposables: {
    user?: SchemaDisposable
    project?: SchemaDisposable
    vscode?: SchemaDisposable
  } = {}
  private _keybindingsDisposable: SchemaDisposable | undefined
  private _settingsPending = false
  private _keybindingsPending = false
  private readonly _logger: ILogger

  constructor(
    @IUserDataFilesService private readonly _userDataFiles: IUserDataFilesService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IConfigLocationService private readonly _configLocation: IConfigLocationService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()

    this._logger =
      loggerService?.createLogger({ id: 'jsonSchemas', name: 'JSON Schemas' }) ?? new NullLogger()
    // Route Monaco's schema-push logging through the same channel.
    setMonacoLoaderLogger(this._logger)

    void this._refreshSettingsSchema()
    void this._refreshKeybindingsSchema()

    this._register(
      ConfigurationRegistry.onDidRegisterConfiguration(() => this._scheduleSettingsRefresh()),
    )
    this._register(CommandsRegistry.onDidChangeCommands(() => this._scheduleKeybindingsRefresh()))

    // Our files' paths follow the active config dir (user layer) and the open
    // workspace (project layer), so rebuild the exact fileMatch when either moves.
    this._register(
      this._configLocation.onDidChangeConfigDir(() => {
        this._scheduleSettingsRefresh()
        this._scheduleKeybindingsRefresh()
      }),
    )
    this._register(this._workspace.onDidChangeWorkspace(() => this._scheduleSettingsRefresh()))

    this._register(
      JSONContributionRegistry.onDidChangeContributions(() => this._pushSchemasToMonaco()),
    )

    // Kick Monaco loading; pushSchemasToMonaco is a no-op until it resolves.
    void MonacoLoader.ensureInitialized().then(() => this._pushSchemasToMonaco())
  }

  override dispose(): void {
    this._settingsDisposables.user?.dispose()
    this._settingsDisposables.project?.dispose()
    this._settingsDisposables.vscode?.dispose()
    this._keybindingsDisposable?.dispose()
    super.dispose()
  }

  private _scheduleSettingsRefresh(): void {
    if (this._settingsPending) return
    this._settingsPending = true
    queueMicrotask(() => {
      this._settingsPending = false
      void this._refreshSettingsSchema()
    })
  }

  private _scheduleKeybindingsRefresh(): void {
    if (this._keybindingsPending) return
    this._keybindingsPending = true
    queueMicrotask(() => {
      this._keybindingsPending = false
      void this._refreshKeybindingsSchema()
    })
  }

  private async _fileMatch(file: UserDataFile): Promise<string | null> {
    const components = await this._userDataFiles.getFileUri(file)
    if (!components) return null
    return schemaFileMatchForUri(components)
  }

  private async _refreshSettingsSchema(): Promise<void> {
    // All layers use strict mode so unsupported keys surface as warnings in
    // Monaco, mirroring how unknown command ids are flagged in keybindings.json.
    // Dynamic contributions trigger onDidRegisterConfiguration → _scheduleSettingsRefresh(),
    // so the schema rebuilds before any warning persists.
    const strictSchema: IJSONSchema = buildSettingsJsonSchema({ strict: true })

    const [userMatch, projectMatch] = await Promise.all([
      this._fileMatch(UserDataFile.Settings),
      this._fileMatch(UserDataFile.ProjectSettings),
    ])

    this._settingsDisposables.user?.dispose()
    this._settingsDisposables.project?.dispose()
    this._settingsDisposables.vscode?.dispose()
    this._settingsDisposables = {}

    if (userMatch) {
      this._settingsDisposables.user = this._register(
        JSONContributionRegistry.registerSchema({
          uri: SETTINGS_USER_URI,
          fileMatch: [userMatch],
          schema: strictSchema,
        }),
      )
    }
    // ProjectSettings has no path when no workspace is open — skip it then.
    if (projectMatch) {
      this._settingsDisposables.project = this._register(
        JSONContributionRegistry.registerSchema({
          uri: SETTINGS_PROJECT_URI,
          fileMatch: [projectMatch],
          schema: strictSchema,
        }),
      )
    }
    // VSCode compatibility layer: keep the broad glob — inheriting VSCode
    // settings is intended, so any of the user's VSCode settings.json files
    // should pick up our schema for completion.
    this._settingsDisposables.vscode = this._register(
      JSONContributionRegistry.registerSchema({
        uri: SETTINGS_VSCODE_URI,
        fileMatch: ['**/Code/User/settings.json', '**/.vscode/settings.json'],
        schema: strictSchema,
      }),
    )
  }

  private async _refreshKeybindingsSchema(): Promise<void> {
    const schema = buildKeybindingsJsonSchema()
    const match = await this._fileMatch(UserDataFile.Keybindings)

    this._keybindingsDisposable?.dispose()
    this._keybindingsDisposable = undefined
    if (!match) return

    this._keybindingsDisposable = this._register(
      JSONContributionRegistry.registerSchema({
        uri: KEYBINDINGS_URI,
        fileMatch: [match],
        schema,
      }),
    )
  }

  private _pushSchemasToMonaco(): void {
    try {
      MonacoLoader.get()
    } catch {
      this._logger.trace('Monaco not ready; deferring schema push')
      return // Monaco not ready yet; ensureInitialized() will trigger a push.
    }
    const contributions = JSONContributionRegistry.getContributions()
    this._logger.debug(
      `pushing ${contributions.length} schema(s) to Monaco: ${contributions
        .map((c) => `${c.uri} → [${c.fileMatch.join(', ')}]`)
        .join('; ')}`,
    )
    MonacoLoader.setJsonSchemas(contributions.map(toMonacoSchema))
  }
}

function toMonacoSchema(c: ISchemaContribution): {
  uri: string
  fileMatch: string[]
  schema: IJSONSchema
} {
  return { uri: c.uri, fileMatch: [...c.fileMatch], schema: c.schema }
}
