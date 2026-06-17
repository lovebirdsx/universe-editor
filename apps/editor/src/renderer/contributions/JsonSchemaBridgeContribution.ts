/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Bridges the platform JSONContributionRegistry into Monaco's JSON language
 *  service. Derives schemas for settings.json / keybindings.json from the live
 *  ConfigurationRegistry / CommandsRegistry, re-deriving whenever those
 *  registries change so dynamically-added settings or commands surface in
 *  completion right away.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  JSONContributionRegistry,
  type IJSONSchema,
  type ISchemaContribution,
} from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { buildSettingsJsonSchema } from '../services/preferences/buildSettingsJsonSchema.js'
import { buildKeybindingsJsonSchema } from '../services/keybindings/buildKeybindingsJsonSchema.js'

const SETTINGS_USER_URI = 'universe-editor://schemas/settings/user'
const SETTINGS_PROJECT_URI = 'universe-editor://schemas/settings/project'
const SETTINGS_VSCODE_URI = 'universe-editor://schemas/settings/vscode'
const KEYBINDINGS_URI = 'universe-editor://schemas/keybindings'

export class JsonSchemaBridgeContribution extends Disposable implements IWorkbenchContribution {
  private _settingsDisposables: {
    user?: ReturnType<typeof JSONContributionRegistry.registerSchema>
    project?: ReturnType<typeof JSONContributionRegistry.registerSchema>
    vscode?: ReturnType<typeof JSONContributionRegistry.registerSchema>
  } = {}
  private _keybindingsDisposable:
    | ReturnType<typeof JSONContributionRegistry.registerSchema>
    | undefined
  private _settingsPending = false
  private _keybindingsPending = false

  constructor() {
    super()

    this._refreshSettingsSchema()
    this._refreshKeybindingsSchema()

    this._register(
      ConfigurationRegistry.onDidRegisterConfiguration(() => this._scheduleSettingsRefresh()),
    )
    this._register(CommandsRegistry.onDidChangeCommands(() => this._scheduleKeybindingsRefresh()))

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
      this._refreshSettingsSchema()
    })
  }

  private _scheduleKeybindingsRefresh(): void {
    if (this._keybindingsPending) return
    this._keybindingsPending = true
    queueMicrotask(() => {
      this._keybindingsPending = false
      this._refreshKeybindingsSchema()
    })
  }

  private _refreshSettingsSchema(): void {
    // All layers use strict mode so unsupported keys surface as warnings in
    // Monaco, mirroring how unknown command ids are flagged in keybindings.json.
    // Dynamic contributions trigger onDidRegisterConfiguration → _scheduleSettingsRefresh(),
    // so the schema rebuilds before any warning persists.
    const strictSchema: IJSONSchema = buildSettingsJsonSchema({ strict: true })

    this._settingsDisposables.user?.dispose()
    this._settingsDisposables.project?.dispose()
    this._settingsDisposables.vscode?.dispose()

    this._settingsDisposables.user = this._register(
      JSONContributionRegistry.registerSchema({
        uri: SETTINGS_USER_URI,
        fileMatch: ['**/settings.json'],
        schema: strictSchema,
      }),
    )
    this._settingsDisposables.project = this._register(
      JSONContributionRegistry.registerSchema({
        uri: SETTINGS_PROJECT_URI,
        fileMatch: ['**/.universe-editor/settings.json'],
        schema: strictSchema,
      }),
    )
    this._settingsDisposables.vscode = this._register(
      JSONContributionRegistry.registerSchema({
        uri: SETTINGS_VSCODE_URI,
        fileMatch: ['**/Code/User/settings.json', '**/.vscode/settings.json'],
        schema: strictSchema,
      }),
    )
  }

  private _refreshKeybindingsSchema(): void {
    const schema = buildKeybindingsJsonSchema()
    this._keybindingsDisposable?.dispose()
    this._keybindingsDisposable = this._register(
      JSONContributionRegistry.registerSchema({
        uri: KEYBINDINGS_URI,
        fileMatch: ['**/keybindings.json'],
        schema,
      }),
    )
  }

  private _pushSchemasToMonaco(): void {
    try {
      MonacoLoader.get()
    } catch {
      return // Monaco not ready yet; ensureInitialized() will trigger a push.
    }
    const contributions = JSONContributionRegistry.getContributions()
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
