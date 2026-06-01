/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Multi-source configuration resolution. A declarative ConfigItem describes one
 *  setting; pluggable IConfigSource implementations (cli / env / file / …) supply
 *  raw values; ConfigResolver picks the first valid value by source priority.
 *  Pure: no IO, no electron/fs imports — sources inject their inputs.
 *--------------------------------------------------------------------------------------------*/

import { asBoolean, asString, asStringArray } from './configValidators.js'

export type ConfigItemType = 'string' | 'boolean' | 'string[]'

/** Maps a ConfigItemType to its resolved value type. */
export type ConfigItemValue<K extends ConfigItemType> = K extends 'string'
  ? string
  : K extends 'boolean'
    ? boolean
    : string[]

export interface ConfigItem<K extends ConfigItemType = ConfigItemType> {
  /** Stable identifier used to index resolver output. */
  readonly id: string
  readonly type: K
  /** CLI flag name without the leading `--` (e.g. 'user-data-dir'). Omit to skip cli. */
  readonly cli?: string
  /** Short CLI alias character without the leading `-` (e.g. 'h' for -h). Requires `cli`. */
  readonly cliAlias?: string
  /** Environment variable name (any key, e.g. 'ELECTRON_RENDERER_URL'). Omit to skip env. */
  readonly env?: string
  /** Dotted path inside the file source's JSON object. Omit to skip file. */
  readonly filePath?: string
  readonly default?: ConfigItemValue<K>
  /** Help text. Items with a description are rendered as user-facing CLI options. */
  readonly description?: string
  /** Value placeholder shown in --help (e.g. '<path>'). Only meaningful for valued items. */
  readonly args?: string
  /**
   * Optional validation of the normalized value. Returning false makes the
   * resolver skip this source and continue to the next priority.
   */
  readonly validate?: (value: ConfigItemValue<K>) => boolean
}

/** A raw value located by a source, before type normalization. */
export type RawConfigValue = string | string[] | boolean | undefined

export interface IConfigSource {
  /** Diagnostic origin label: 'cli' | 'env' | 'file' | 'settings' | … */
  readonly name: string
  /** Locate the raw value for an item, or undefined when this source has none. */
  getRawValue(item: ConfigItem): RawConfigValue
}

export interface ResolvedConfig<K extends ConfigItemType> {
  readonly value: ConfigItemValue<K> | undefined
  /** Name of the source that supplied the value, or 'default'. */
  readonly origin: string
}

function normalize<K extends ConfigItemType>(
  type: K,
  raw: RawConfigValue,
): ConfigItemValue<K> | undefined {
  switch (type) {
    case 'string':
      return asString(raw) as ConfigItemValue<K> | undefined
    case 'boolean':
      return asBoolean(raw) as ConfigItemValue<K> | undefined
    case 'string[]':
      return asStringArray(raw) as ConfigItemValue<K> | undefined
    default:
      return undefined
  }
}

/**
 * Resolves config items against an ordered list of sources. Lower index = higher
 * priority. Sources can be replaced/appended at runtime (e.g. a lazily-loaded
 * file source, or an adapter over a settings service).
 */
export class ConfigResolver {
  private _sources: readonly IConfigSource[]

  constructor(sources: readonly IConfigSource[] = []) {
    this._sources = sources
  }

  setSources(sources: readonly IConfigSource[]): void {
    this._sources = sources
  }

  appendSource(source: IConfigSource): void {
    this._sources = [...this._sources, source]
  }

  resolve<K extends ConfigItemType>(item: ConfigItem<K>): ResolvedConfig<K> {
    for (const source of this._sources) {
      const value = normalize(item.type, source.getRawValue(item))
      if (value === undefined) continue
      if (item.validate && !item.validate(value)) continue
      return { value, origin: source.name }
    }
    return { value: item.default, origin: 'default' }
  }

  /** Convenience: resolved value only, dropping origin. */
  get<K extends ConfigItemType>(item: ConfigItem<K>): ConfigItemValue<K> | undefined {
    return this.resolve(item).value
  }
}
