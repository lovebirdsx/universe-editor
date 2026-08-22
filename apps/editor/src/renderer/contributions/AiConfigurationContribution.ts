/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for aiSettings.json (the AI configuration file:
 *  provider types / instances + active model selections), so editing it gets
 *  completion + validation in Monaco. The `activeModels.{chat,inlineCompletion}`
 *  enums are rebuilt from the currently-available models whenever that set
 *  changes. API keys ARE part of this file as plaintext (user decision:
 *  cross-machine sync) — they must never be logged.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IAiModelService,
  type IDisposable,
  IUserDataFilesService,
  IWorkbenchContribution,
  JSONContributionRegistry,
  MutableDisposable,
  UserDataFile,
  type IJSONSchema,
} from '@universe-editor/platform'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'
import { schemaFileMatchForUri } from '../services/preferences/schemaFileMatch.js'

const AI_SETTINGS_SCHEMA_URI = 'universe-editor://schemas/ai/settings'

const WIRE_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'ollama'] as const

const PROTOCOL_SCHEMA: IJSONSchema = {
  type: 'string',
  enum: [...WIRE_PROTOCOLS],
  description: 'Wire protocol this type (or model) speaks.',
}

const PRICING_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['input', 'output'],
  properties: {
    currency: {
      type: 'string',
      enum: ['USD', 'CNY'],
      description: 'Currency the rates are expressed in.',
    },
    input: { type: 'number', description: 'Input price per 1M tokens.' },
    output: { type: 'number', description: 'Output price per 1M tokens.' },
    cacheRead: { type: 'number', description: 'Cache-read price per 1M tokens.' },
    cacheWrite: { type: 'number', description: 'Cache-write price per 1M tokens.' },
  },
}

const REMOTE_SOURCE_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      description: 'Registered remote source id, e.g. "http-json".',
    },
    options: {
      type: 'object',
      description: 'Source-specific configuration.',
      additionalProperties: true,
    },
  },
}

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
    protocol: {
      ...PROTOCOL_SCHEMA,
      description: 'Overrides the type protocol for this single model.',
    },
    baseUrl: {
      type: 'string',
      description: "Overrides the instance's / type's baseUrl for this single model.",
    },
    pricing: PRICING_SCHEMA,
  },
}

const PROVIDER_TYPE_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['protocol'],
  properties: {
    label: { type: 'string', description: 'Display name.' },
    protocol: PROTOCOL_SCHEMA,
    defaultBaseUrl: {
      type: 'string',
      description: 'Default endpoint used when an instance declares no baseUrl.',
    },
    requiresApiKey: {
      type: 'boolean',
      description: 'Whether instances of this type require an API key.',
    },
    models: {
      type: 'array',
      description: 'Model catalog shared by every instance of this type.',
      items: MODEL_SCHEMA,
    },
    pricing: PRICING_SCHEMA,
    pricingSource: REMOTE_SOURCE_SCHEMA,
    usageSource: REMOTE_SOURCE_SCHEMA,
  },
}

const PROVIDER_INSTANCE_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: {
    name: {
      type: 'string',
      description: "Instance name, unique within a type (must not contain '/').",
    },
    type: {
      type: 'string',
      description: 'Provider type id this instance binds to, e.g. "anthropic".',
    },
    label: { type: 'string', description: 'Display name.' },
    baseUrl: {
      type: 'string',
      description: "Endpoint override; falls back to the type's default.",
    },
    apiKey: {
      type: 'string',
      description:
        'Plaintext API key, stored in this file by explicit user decision (cross-machine sync). Never logged.',
    },
    usageSource: REMOTE_SOURCE_SCHEMA,
    models: {
      type: 'array',
      description: 'Extra models only this instance offers; merged after the type catalog.',
      items: MODEL_SCHEMA,
    },
    settings: {
      type: 'object',
      description: 'Per-model configuration, keyed by full model id (type/instance/model).',
      additionalProperties: { type: 'object' },
    },
  },
}

export function buildSchema(modelIds: readonly string[]): IJSONSchema {
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
      providerTypes: {
        type: 'object',
        description: 'User-defined / overridden provider types, keyed by type id.',
        additionalProperties: PROVIDER_TYPE_SCHEMA,
      },
      providers: {
        type: 'array',
        description: 'Provider instances (connection + credential) backing the available models.',
        items: PROVIDER_INSTANCE_SCHEMA,
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
          sessionTitle: {
            ...modelRef,
            description: 'Active model id for AI session title generation.',
          },
        },
      },
      agentSettings: {
        type: 'object',
        description: 'Editor-managed settings for ACP agents, including saved credentials.',
        additionalProperties: true,
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
    const fileMatch = schemaFileMatchForUri(components)
    const ids = (await this._aiModel.getModels()).map((m) => m.id)
    this._schema.value = JSONContributionRegistry.registerSchema({
      uri: AI_SETTINGS_SCHEMA_URI,
      fileMatch: [fileMatch],
      schema: buildSchema(ids),
    })
  }
}
