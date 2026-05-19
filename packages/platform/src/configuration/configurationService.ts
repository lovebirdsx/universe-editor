/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's ConfigurationService (platform/configuration/common/configurationModels.ts).
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../base/lifecycle.js'
import { Emitter, Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import { ConfigurationRegistry } from './configurationRegistry.js'

/**
 * Configuration target layers. Lower index = lower priority (overridden by higher).
 */
export const enum ConfigurationTarget {
  /** Built-in defaults declared via ConfigurationRegistry. */
  Default = 0,
  /** User-global settings (e.g. ~/.universe-editor/settings.json). */
  User = 1,
  /** Project-level settings (editor.config.json). */
  Project = 2,
  /** Runtime in-memory overrides (highest priority). */
  Memory = 3,
}

export interface IConfigurationChangeEvent {
  /** Returns true if the change affects the given configuration key. */
  affectsConfiguration(key: string): boolean
}

export interface IConfigurationService {
  readonly _serviceBrand: undefined

  /**
   * Read a configuration value. Layers are merged: Memory > Project > User > Default.
   * @param key Dotted key like 'level.gridSize'
   * @param defaultValue Fallback if the key is not found in any layer.
   */
  get<T>(key: string, defaultValue?: T): T | undefined

  /**
   * Write a configuration value to the specified target layer.
   */
  update(key: string, value: unknown, target?: ConfigurationTarget): void

  /**
   * Bulk-load an entire layer (e.g. reading user settings from disk).
   */
  loadLayer(target: ConfigurationTarget, data: Record<string, unknown>): void

  /**
   * Return a shallow snapshot of the given layer. Safe to mutate by callers.
   */
  getLayerSnapshot(target: ConfigurationTarget): Readonly<Record<string, unknown>>

  /**
   * Return the highest-priority layer that owns the given key.
   * Returns undefined if the key is not present in any layer.
   */
  getValueOrigin(key: string): ConfigurationTarget | undefined

  /** Fired whenever a configuration value changes. */
  readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent>
}

export const IConfigurationService = createDecorator<IConfigurationService>('configurationService')

type ConfigStore = Record<string, unknown>

export class ConfigurationService extends Disposable implements IConfigurationService {
  declare readonly _serviceBrand: undefined

  /** Layers in priority order (index = ConfigurationTarget value). */
  private readonly _layers: ConfigStore[] = [
    {}, // Default — populated lazily from ConfigurationRegistry
    {}, // User
    {}, // Project
    {}, // Memory
  ]

  private readonly _onDidChangeConfiguration = this._register(
    new Emitter<IConfigurationChangeEvent>(),
  )
  readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event

  constructor() {
    super()
    // Stay in sync with registry changes (new contributions may register defaults).
    this._register(
      ConfigurationRegistry.onDidRegisterConfiguration(() => {
        this._refreshDefaults()
      }),
    )
    this._refreshDefaults()
  }

  private _refreshDefaults(): void {
    const defaults: ConfigStore = {}
    for (const node of ConfigurationRegistry.getConfigurationNodes()) {
      for (const [key, schema] of Object.entries(node.properties)) {
        if ('default' in schema) {
          defaults[key] = schema.default
        }
      }
    }
    this._layers[ConfigurationTarget.Default] = defaults
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    // Walk layers from highest priority (Memory) to lowest (Default)
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const layer = this._layers[i]
      if (layer && Object.prototype.hasOwnProperty.call(layer, key)) {
        return layer[key] as T
      }
    }
    return defaultValue
  }

  update(
    key: string,
    value: unknown,
    target: ConfigurationTarget = ConfigurationTarget.Memory,
  ): void {
    const layer = this._layers[target]
    if (!layer) {
      throw new Error(`Unknown configuration target: ${target}`)
    }
    const oldValue = this.get(key)
    layer[key] = value

    // Only fire if the effective value changed
    if (oldValue !== value) {
      this._onDidChangeConfiguration.fire({
        affectsConfiguration: (k) => k === key,
      })
    }
  }

  /**
   * Bulk-load an entire layer (e.g. reading user settings from disk).
   * Compares effective values (post-layer-merge) before/after to fire only for
   * keys whose visible value actually changed.
   */
  loadLayer(target: ConfigurationTarget, data: Record<string, unknown>): void {
    if (!this._layers[target]) {
      throw new Error(`Unknown configuration target: ${target}`)
    }
    const oldKeys = Object.keys(this._layers[target] ?? {})
    const newKeys = Object.keys(data)
    const allKeys = new Set([...oldKeys, ...newKeys])

    const before = new Map<string, unknown>()
    for (const k of allKeys) before.set(k, this.get(k))

    this._layers[target] = { ...data }

    const changedKeys = new Set<string>()
    for (const k of allKeys) {
      if (this.get(k) !== before.get(k)) changedKeys.add(k)
    }

    if (changedKeys.size > 0) {
      this._onDidChangeConfiguration.fire({
        affectsConfiguration: (k) => changedKeys.has(k),
      })
    }
  }

  getLayerSnapshot(target: ConfigurationTarget): Readonly<Record<string, unknown>> {
    const layer = this._layers[target]
    if (!layer) {
      throw new Error(`Unknown configuration target: ${target}`)
    }
    return { ...layer }
  }

  getValueOrigin(key: string): ConfigurationTarget | undefined {
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const layer = this._layers[i]
      if (layer && Object.prototype.hasOwnProperty.call(layer, key)) {
        return i as ConfigurationTarget
      }
    }
    return undefined
  }
}
