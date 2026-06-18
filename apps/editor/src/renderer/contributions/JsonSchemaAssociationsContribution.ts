/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Two of the three JSON-schema association sources (the third is extension
 *  `contributes.jsonValidation`, handled in ExtensionPointTranslator):
 *    - the built-in declaration table (`builtinJsonSchemas.ts`), and
 *    - the user `json.schemas` setting (VSCode parity), where each entry is
 *      `{ fileMatch, url? , schema? }` — an inline schema, a local file path, or
 *      an http(s) url.
 *
 *  All three sources funnel into JSONContributionRegistry; JsonSchemaBridge then
 *  pushes them to Monaco. Monaco can't fetch schemas itself, so a `url` is
 *  resolved to an inline object here (local read, or main-side download for
 *  http(s) — see schemaUrlResolver).
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  IFileService,
  ILoggerService,
  JSONContributionRegistry,
  NullLogger,
  type IDisposable,
  type IJSONSchema,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IRemoteSchemaService } from '../../shared/ipc/remoteSchemaService.js'
import { BUILTIN_JSON_SCHEMAS } from '../services/preferences/builtinJsonSchemas.js'
import {
  DEFAULT_TRUSTED_SCHEMA_DOMAINS,
  resolveSchemaFromUrl,
  SCHEMA_DOWNLOAD_ENABLE_KEY,
  SCHEMA_DOWNLOAD_TRUSTED_DOMAINS_KEY,
} from '../services/preferences/schemaUrlResolver.js'

const JSON_SCHEMAS_KEY = 'json.schemas'

interface IUserSchemaAssociation {
  fileMatch?: string[]
  url?: string
  schema?: IJSONSchema
}

export class JsonSchemaAssociationsContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _logger: ILogger
  /** Registry handles for the user `json.schemas` entries, cleared on each refresh. */
  private _userSchemas: IDisposable[] = []
  private _userPending = false

  constructor(
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IFileService private readonly _fileService: IFileService,
    @IRemoteSchemaService private readonly _remoteSchema: IRemoteSchemaService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'jsonSchemas', name: 'JSON Schemas' }) ?? new NullLogger()

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'json',
        title: 'JSON',
        properties: {
          [JSON_SCHEMAS_KEY]: {
            type: 'array',
            description:
              'Associate JSON schemas with files. Each entry matches files by glob and supplies either an inline schema, a local file path, or an http(s) url.',
            items: {
              type: 'object',
              properties: {
                fileMatch: {
                  type: 'array',
                  description: 'Glob patterns matched against file paths (e.g. **/*.entity.json).',
                  items: { type: 'string' },
                },
                url: {
                  type: 'string',
                  description: 'A local file path or http(s) url to a JSON schema.',
                },
                schema: {
                  type: 'object',
                  description: 'An inline JSON schema (alternative to url).',
                },
              },
            },
          },
          [SCHEMA_DOWNLOAD_ENABLE_KEY]: {
            type: 'boolean',
            default: true,
            description: 'When enabled, JSON schemas may be downloaded from http(s) urls.',
          },
          [SCHEMA_DOWNLOAD_TRUSTED_DOMAINS_KEY]: {
            type: 'object',
            default: { ...DEFAULT_TRUSTED_SCHEMA_DOMAINS },
            additionalProperties: { type: 'boolean' },
            description:
              'URL prefixes trusted for schema downloads. A schema url is only downloaded if it starts with a prefix mapped to true.',
          },
        },
      }),
    )

    this._registerBuiltinSchemas()
    void this._refreshUserSchemas()
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(JSON_SCHEMAS_KEY)) this._scheduleUserRefresh()
      }),
    )
  }

  override dispose(): void {
    this._clearUserSchemas()
    super.dispose()
  }

  private _registerBuiltinSchemas(): void {
    for (const entry of BUILTIN_JSON_SCHEMAS) {
      this._register(
        JSONContributionRegistry.registerSchema({
          uri: `builtin://schemas/${entry.key}`,
          fileMatch: [...entry.fileMatch],
          schema: entry.schema,
        }),
      )
    }
  }

  private _scheduleUserRefresh(): void {
    if (this._userPending) return
    this._userPending = true
    queueMicrotask(() => {
      this._userPending = false
      void this._refreshUserSchemas()
    })
  }

  private _clearUserSchemas(): void {
    for (const d of this._userSchemas) d.dispose()
    this._userSchemas = []
  }

  private async _refreshUserSchemas(): Promise<void> {
    this._clearUserSchemas()
    const entries = this._configuration.get<IUserSchemaAssociation[]>(JSON_SCHEMAS_KEY)
    if (!Array.isArray(entries)) return

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry) continue
      const fileMatch = entry.fileMatch
      if (!Array.isArray(fileMatch) || fileMatch.length === 0) continue

      const schema = await this._resolveSchema(entry, i)
      if (!schema) continue

      this._userSchemas.push(
        JSONContributionRegistry.registerSchema({
          uri: `user://schemas/${i}`,
          fileMatch: [...fileMatch],
          schema,
        }),
      )
    }
  }

  private async _resolveSchema(
    entry: IUserSchemaAssociation,
    index: number,
  ): Promise<IJSONSchema | undefined> {
    if (entry.schema && typeof entry.schema === 'object') return entry.schema
    const url = entry.url
    if (typeof url !== 'string' || url.length === 0) return undefined
    return resolveSchemaFromUrl(
      url,
      {
        configuration: this._configuration,
        fileService: this._fileService,
        remoteSchema: this._remoteSchema,
        logger: this._logger,
      },
      `json.schemas[${index}]`,
    )
  }
}
