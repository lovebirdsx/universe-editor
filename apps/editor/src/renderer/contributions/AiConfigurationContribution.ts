/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the JSON schema for aiSettings.json (the AI configuration file:
 *  model knowledge base / provider entries / per-model settings / active model
 *  selections / agent settings), so editing it gets completion + validation in
 *  Monaco. The `activeModels.{chat,inlineCompletion,commit,sessionTitle}` enums
 *  are rebuilt from the currently-available editor-selectable models whenever
 *  that set changes. API keys ARE part of this file as plaintext (user decision:
 *  cross-machine sync) — they must never be logged.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IAiModelService,
  isEditorSelectable,
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
  description: 'Wire protocol a model is reached through.',
}

const CAPABILITIES_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    streaming: { type: 'boolean' },
    vision: { type: 'boolean' },
    toolCalling: { type: 'boolean' },
    promptCaching: { type: 'boolean' },
  },
}

const REMOTE_SOURCE_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      description: 'Registered remote source id, e.g. "http-json" or "catalog".',
    },
    options: {
      type: 'object',
      description:
        'Source-specific configuration. "catalog" requires { "vendor": "..." } naming the official price list; without it no rate resolves.',
      additionalProperties: true,
    },
  },
}

/** `models` knowledge-base entry: intrinsic metadata, deliberately pricing-free. */
const MODEL_KNOWLEDGE_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Display name.' },
    family: { type: 'string', description: 'Model family, e.g. "gpt-4o".' },
    vendor: { type: 'string', description: "Real vendor, e.g. 'anthropic'." },
    nativeProtocol: {
      ...PROTOCOL_SCHEMA,
      description: "Protocol this model speaks on its own vendor's endpoint.",
    },
    maxInputTokens: { type: 'number', description: 'Maximum input context size, in tokens.' },
    maxOutputTokens: { type: 'number', description: 'Maximum number of tokens to generate.' },
    capabilities: CAPABILITIES_SCHEMA,
    supportsReasoningEffort: {
      type: 'array',
      items: { type: 'string' },
      description: 'Reasoning-effort levels this model accepts (drives a reasoningEffort setting).',
    },
    parameters: {
      type: 'object',
      description: 'Per-model configurable parameters surfaced in the picker / management UI.',
      additionalProperties: true,
    },
  },
}

/** A `protocolMap` element: bare wire name, or an override (rename / capability shrink). */
const PROTOCOL_MODEL_REF_SCHEMA: IJSONSchema = {
  anyOf: [
    { type: 'string', description: 'Bare wire name; defaults to the knowledge-base key.' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Wire name this channel expects. Defaults to `ref`.' },
        ref: { type: 'string', description: 'Knowledge-base key. Defaults to `id`.' },
        name: { type: 'string' },
        family: { type: 'string' },
        vendor: { type: 'string' },
        nativeProtocol: PROTOCOL_SCHEMA,
        maxInputTokens: { type: 'number' },
        maxOutputTokens: { type: 'number' },
        capabilities: CAPABILITIES_SCHEMA,
        supportsReasoningEffort: { type: 'array', items: { type: 'string' } },
        parameters: { type: 'object', additionalProperties: true },
      },
    },
  ],
}

const PROTOCOL_MAP_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Which models each wire protocol exposes. An empty array means "discover from the endpoint".',
  properties: {
    'openai-chat': { type: 'array', items: PROTOCOL_MODEL_REF_SCHEMA },
    'openai-responses': { type: 'array', items: PROTOCOL_MODEL_REF_SCHEMA },
    'anthropic-messages': { type: 'array', items: PROTOCOL_MODEL_REF_SCHEMA },
    ollama: { type: 'array', items: PROTOCOL_MODEL_REF_SCHEMA },
  },
}

const PROVIDER_ENTRY_SCHEMA: IJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      description: "Unique id; also the first segment of every model id. Must not contain '/'.",
    },
    extends: {
      type: 'string',
      description: 'Inherit from another entry (alternate access point of the same gateway).',
    },
    baseUrl: { type: 'string', description: 'Gateway endpoint.' },
    apiKey: {
      type: 'string',
      description:
        'Plaintext API key, stored in this file by explicit user decision (cross-machine sync). Never logged.',
    },
    defaultProtocol: {
      ...PROTOCOL_SCHEMA,
      description: 'Protocol the editor uses when the caller does not pick one.',
    },
    protocolMap: PROTOCOL_MAP_SCHEMA,
    pricingSource: REMOTE_SOURCE_SCHEMA,
    usageSource: REMOTE_SOURCE_SCHEMA,
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
      models: {
        type: 'object',
        description:
          'Model knowledge base, keyed by logical model id. Merged over the built-in one.',
        additionalProperties: MODEL_KNOWLEDGE_SCHEMA,
      },
      providers: {
        type: 'array',
        description: 'Provider entries (gateway endpoints) backing the available models.',
        items: PROVIDER_ENTRY_SCHEMA,
      },
      modelSettings: {
        type: 'object',
        description:
          'Per-model configuration, keyed by full model id (providerId/protocol/channelModel).',
        additionalProperties: { type: 'object' },
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
        description:
          'Editor-managed settings for ACP agents (authentication choice, model overrides).',
        additionalProperties: {
          type: 'object',
          additionalProperties: true,
          properties: {
            authentication: {
              type: 'string',
              description:
                'Provider id whose credential this agent uses, or the special value "@subscription".',
            },
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
    const fileMatch = schemaFileMatchForUri(components)
    const ids = (await this._aiModel.getModels()).filter(isEditorSelectable).map((m) => m.id)
    this._schema.value = JSONContributionRegistry.registerSchema({
      uri: AI_SETTINGS_SCHEMA_URI,
      fileMatch: [fileMatch],
      schema: buildSchema(ids),
    })
  }
}
