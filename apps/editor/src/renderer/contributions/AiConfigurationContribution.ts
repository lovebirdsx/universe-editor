/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for aiSettings.json (the AI configuration file:
 *  provider groups + active model selections), so editing it gets completion +
 *  validation in Monaco. The `activeModels.{chat,inlineCompletion}` enums are
 *  rebuilt from the currently-available models whenever that set changes. API
 *  keys are NEVER part of this file — they live in encrypted secret storage.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IAiModelService,
  type IDisposable,
  IUserDataFilesService,
  IWorkbenchContribution,
  JSONContributionRegistry,
  MutableDisposable,
  URI,
  UserDataFile,
  type IJSONSchema,
} from '@universe-editor/platform'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'
import { schemaFileMatchForUri } from '../services/preferences/schemaFileMatch.js'

const AI_SETTINGS_SCHEMA_URI = 'universe-editor://schemas/ai/settings'

const MODEL_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', description: 'Bare model id the endpoint expects, e.g. "qwen3-coder".' },
    name: { type: 'string', description: 'Display name.' },
    family: { type: 'string', description: 'Model family, e.g. "gpt-4o".' },
    maxInputTokens: { type: 'number', description: 'Maximum input context size, in tokens.' },
    maxOutputTokens: { type: 'number', description: 'Maximum number of tokens to generate.' },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        streaming: { type: 'boolean' },
        vision: { type: 'boolean' },
        toolCalling: { type: 'boolean' },
      },
    },
    supportsReasoningEffort: {
      type: 'array',
      items: { type: 'string' },
      description: 'Reasoning-effort levels this model accepts (drives a reasoningEffort setting).',
    },
  },
}

const GROUP_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'vendor'],
  properties: {
    name: {
      type: 'string',
      description: "Group name, unique within a vendor (must not contain '/').",
    },
    vendor: {
      type: 'string',
      description: 'Vendor this group binds to, e.g. "openai" or "ollama".',
    },
    baseUrl: {
      type: 'string',
      description: "Endpoint override; falls back to the provider's default.",
    },
    models: {
      type: 'array',
      description: 'Hand-declared models, merged with whatever the endpoint enumerates.',
      items: MODEL_SCHEMA,
    },
    settings: {
      type: 'object',
      description: 'Per-model configuration, keyed by full model id (vendor/group/model).',
      additionalProperties: { type: 'object' },
    },
  },
}

function buildSchema(modelIds: readonly string[]): IJSONSchema {
  // Omit the enum when there are no models — an empty enum would mark every
  // value invalid. With ids present, suggest them while still allowing a
  // hand-typed id (Monaco treats enum as suggestions + a warning, not a hard
  // error, for string types).
  const modelRef: IJSONSchema = {
    type: 'string',
    ...(modelIds.length > 0 ? { enum: [...modelIds] } : {}),
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      groups: {
        type: 'array',
        description: 'Provider groups (vendor + named group) backing the available models.',
        items: GROUP_SCHEMA,
      },
      activeModels: {
        type: 'object',
        additionalProperties: false,
        description: 'The active model selection for each feature.',
        properties: {
          chat: { ...modelRef, description: 'Active model id for chat.' },
          inlineCompletion: {
            ...modelRef,
            description: 'Active model id for inline (ghost-text) completions.',
          },
          commit: {
            ...modelRef,
            description: 'Active model id for commit message generation.',
          },
        },
      },
    },
  }
}

export class AiConfigurationContribution extends Disposable implements IWorkbenchContribution {
  private readonly _schema = this._register(new MutableDisposable<IDisposable>())

  constructor(
    @IAiModelService private readonly _aiModel: IAiModelService,
    @IUserDataFilesService private readonly _userDataFiles: IUserDataFilesService,
    @IConfigLocationService private readonly _configLocation: IConfigLocationService,
  ) {
    super()
    void this._refresh()
    this._register(this._aiModel.onDidChangeModels(() => void this._refresh()))
    // aiSettings.json lives in the active config dir, so retarget the exact
    // fileMatch when that dir moves.
    this._register(this._configLocation.onDidChangeConfigDir(() => void this._refresh()))
  }

  private async _refresh(): Promise<void> {
    const components = await this._userDataFiles.getFileUri(UserDataFile.AiSettings)
    if (!components) {
      this._schema.clear()
      return
    }
    const fileMatch = schemaFileMatchForUri(URI.revive(components) as URI)
    const ids = (await this._aiModel.getModels()).map((m) => m.id)
    this._schema.value = JSONContributionRegistry.registerSchema({
      uri: AI_SETTINGS_SCHEMA_URI,
      fileMatch: [fileMatch],
      schema: buildSchema(ids),
    })
  }
}
