/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's ConfigurationRegistry (platform/configuration/common/configurationRegistry.ts).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { IDisposable, toDisposable } from '../base/lifecycle.js'

export type ConfigurationPropertyType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'

/**
 * Subset of JSON Schema used for configuration declarations.
 */
export interface IConfigurationPropertySchema {
  /** A single type, or a union of types (e.g. `['boolean', 'string']`). */
  type?: ConfigurationPropertyType | ConfigurationPropertyType[]
  default?: unknown
  description?: string
  enum?: unknown[]
  /** Per-enum-value documentation, index-aligned with `enum`. */
  enumDescriptions?: string[]
  enumItemLabels?: Readonly<Record<string, string>>
  minimum?: number
  maximum?: number
  items?: IConfigurationPropertySchema
  /** For object-typed settings: schema of explicitly named properties. */
  properties?: Record<string, IConfigurationPropertySchema>
  /** For object-typed settings (e.g. `files.exclude`): schema of free-form values. */
  additionalProperties?: boolean | IConfigurationPropertySchema
  /** Alternative schemas, any of which may match (e.g. boolean | string | object). */
  anyOf?: IConfigurationPropertySchema[]
}

export interface IConfigurationNode {
  /** Unique dotted-path prefix for all properties in this node. */
  id: string
  /** Human-readable title shown in the Settings UI. */
  title?: string
  /** Map from full dotted key to schema. */
  properties: Record<string, IConfigurationPropertySchema>
}

export interface IConfigurationRegistry {
  readonly onDidRegisterConfiguration: Event<void>
  registerConfiguration(node: IConfigurationNode): IDisposable
  getConfigurationNodes(): readonly IConfigurationNode[]
  /** Get the default value for a given key (overrides first, then schema). */
  getDefaultValue(key: string): unknown
  /**
   * Override the shipped defaults of already-declared (or not-yet-declared) keys.
   * Ranks above `schema.default` and below every writable configuration layer, so
   * a build-time injected value applies out of the box yet user settings still win.
   *
   * Registered here rather than pushed straight into ConfigurationService's Default
   * layer because extension `contributes.configuration` arrives asynchronously and
   * recomputes that layer wholesale — an override written directly into the layer
   * would be wiped by the next contribution.
   */
  registerDefaultOverrides(overrides: Readonly<Record<string, unknown>>): IDisposable
  /** Effective override map (later registrations win on conflicting keys). */
  getDefaultOverrides(): Readonly<Record<string, unknown>>
}

class ConfigurationRegistryImpl implements IConfigurationRegistry {
  private readonly _nodes: IConfigurationNode[] = []
  private readonly _defaultOverrides: Readonly<Record<string, unknown>>[] = []
  private readonly _onDidRegisterConfiguration = new Emitter<void>()
  readonly onDidRegisterConfiguration = this._onDidRegisterConfiguration.event

  registerConfiguration(node: IConfigurationNode): IDisposable {
    this._nodes.push(node)
    this._onDidRegisterConfiguration.fire()

    return toDisposable(() => {
      const idx = this._nodes.indexOf(node)
      if (idx !== -1) {
        this._nodes.splice(idx, 1)
        this._onDidRegisterConfiguration.fire()
      }
    })
  }

  getConfigurationNodes(): readonly IConfigurationNode[] {
    return this._nodes
  }

  registerDefaultOverrides(overrides: Readonly<Record<string, unknown>>): IDisposable {
    const entry = { ...overrides }
    this._defaultOverrides.push(entry)
    this._onDidRegisterConfiguration.fire()

    return toDisposable(() => {
      const idx = this._defaultOverrides.indexOf(entry)
      if (idx !== -1) {
        this._defaultOverrides.splice(idx, 1)
        this._onDidRegisterConfiguration.fire()
      }
    })
  }

  getDefaultOverrides(): Readonly<Record<string, unknown>> {
    const merged: Record<string, unknown> = {}
    for (const overrides of this._defaultOverrides) {
      Object.assign(merged, overrides)
    }
    return merged
  }

  getDefaultValue(key: string): unknown {
    for (let i = this._defaultOverrides.length - 1; i >= 0; i--) {
      const overrides = this._defaultOverrides[i]
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
        return overrides[key]
      }
    }
    for (const node of this._nodes) {
      if (Object.prototype.hasOwnProperty.call(node.properties, key)) {
        return node.properties[key]?.default
      }
    }
    return undefined
  }
}

export const ConfigurationRegistry: IConfigurationRegistry = new ConfigurationRegistryImpl()
