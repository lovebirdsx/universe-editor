/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IJSONContributionRegistry
 *  (platform/jsonschemas/common/jsonContributionRegistry.ts).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { IDisposable, toDisposable } from '../base/lifecycle.js'

/**
 * Minimal JSON Schema subset used by registered contributions. Mirrors the
 * shape Monaco's JSON language service understands so we can pass nodes through
 * untouched.
 */
export interface IJSONSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  default?: unknown
  description?: string
  markdownDescription?: string
  enum?: unknown[]
  enumDescriptions?: string[]
  minimum?: number
  maximum?: number
  items?: IJSONSchema
  properties?: Record<string, IJSONSchema>
  patternProperties?: Record<string, IJSONSchema>
  required?: string[]
  additionalProperties?: boolean | IJSONSchema
  oneOf?: IJSONSchema[]
  anyOf?: IJSONSchema[]
  allOf?: IJSONSchema[]
  $ref?: string
  format?: string
  pattern?: string
}

export interface ISchemaContribution {
  /** Unique schema URI, e.g. 'universe-editor://schemas/settings/user'. */
  uri: string
  /** Glob patterns matched against model URIs (Monaco's `fileMatch`). */
  fileMatch: string[]
  schema: IJSONSchema
}

export interface IJSONContributionRegistry {
  readonly onDidChangeContributions: Event<void>
  /**
   * Register (or replace, if the same `uri` already exists) a schema
   * contribution. Disposing the returned handle removes it.
   */
  registerSchema(contribution: ISchemaContribution): IDisposable
  getContributions(): readonly ISchemaContribution[]
}

class JSONContributionRegistryImpl implements IJSONContributionRegistry {
  private readonly _contributions = new Map<string, ISchemaContribution>()
  private readonly _onDidChangeContributions = new Emitter<void>()
  readonly onDidChangeContributions = this._onDidChangeContributions.event

  registerSchema(contribution: ISchemaContribution): IDisposable {
    this._contributions.set(contribution.uri, contribution)
    this._onDidChangeContributions.fire()

    return toDisposable(() => {
      // Only remove if the current registration is still ours; later
      // re-registrations may have superseded it.
      if (this._contributions.get(contribution.uri) === contribution) {
        this._contributions.delete(contribution.uri)
        this._onDidChangeContributions.fire()
      }
    })
  }

  getContributions(): readonly ISchemaContribution[] {
    return [...this._contributions.values()]
  }
}

export const JSONContributionRegistry: IJSONContributionRegistry =
  new JSONContributionRegistryImpl()
