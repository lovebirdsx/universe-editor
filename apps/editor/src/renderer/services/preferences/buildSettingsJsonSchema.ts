/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Builds a JSON Schema for settings.json from the live ConfigurationRegistry.
 *  Used by JsonSchemaBridgeContribution to feed Monaco's JSON language service
 *  with completion + hover docs for every registered setting key.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  type IConfigurationPropertySchema,
  type IJSONSchema,
} from '@universe-editor/platform'

function toJsonSchemaNode(prop: IConfigurationPropertySchema): IJSONSchema {
  const node: IJSONSchema = {}
  if (prop.type !== undefined) node.type = prop.type
  if (prop.default !== undefined) node.default = prop.default
  if (prop.description !== undefined) {
    node.description = prop.description
    node.markdownDescription = prop.description
  }
  if (prop.enum !== undefined) node.enum = [...prop.enum]
  if (prop.enumDescriptions !== undefined) node.enumDescriptions = [...prop.enumDescriptions]
  if (prop.minimum !== undefined) node.minimum = prop.minimum
  if (prop.maximum !== undefined) node.maximum = prop.maximum
  if (prop.items !== undefined) node.items = toJsonSchemaNode(prop.items)
  if (prop.anyOf !== undefined) node.anyOf = prop.anyOf.map(toJsonSchemaNode)
  if (prop.properties !== undefined) {
    node.properties = Object.fromEntries(
      Object.entries(prop.properties).map(([k, v]) => [k, toJsonSchemaNode(v)]),
    )
  }
  if (prop.additionalProperties !== undefined) {
    node.additionalProperties =
      typeof prop.additionalProperties === 'boolean'
        ? prop.additionalProperties
        : toJsonSchemaNode(prop.additionalProperties)
  }
  return node
}

export interface IBuildSettingsJsonSchemaOptions {
  /**
   * Reject unknown keys (`additionalProperties: false`). Used for the read-only
   * VSCode settings layer so settings this editor doesn't support surface as
   * warnings, mirroring keybindings.json. The editor's own settings.json stays
   * permissive — a key whose contribution registers later must not be flagged.
   */
  strict?: boolean
}

export function buildSettingsJsonSchema(
  options: IBuildSettingsJsonSchemaOptions = {},
): IJSONSchema {
  const properties: Record<string, IJSONSchema> = {}
  for (const node of ConfigurationRegistry.getConfigurationNodes()) {
    for (const [key, prop] of Object.entries(node.properties)) {
      properties[key] = toJsonSchemaNode(prop)
    }
  }
  return {
    type: 'object',
    properties,
    // settings.json is jsonc (comments + trailing commas). The editor's own file
    // permits any extra keys to avoid spurious "unknown property" errors when a
    // setting's contribution registers later; the strict VSCode variant rejects
    // them so unsupported settings surface as warnings.
    additionalProperties: options.strict ? false : true,
  }
}
