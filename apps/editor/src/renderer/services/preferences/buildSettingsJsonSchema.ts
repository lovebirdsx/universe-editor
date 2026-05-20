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
  const node: IJSONSchema = { type: prop.type }
  if (prop.default !== undefined) node.default = prop.default
  if (prop.description !== undefined) {
    node.description = prop.description
    node.markdownDescription = prop.description
  }
  if (prop.enum !== undefined) node.enum = [...prop.enum]
  if (prop.minimum !== undefined) node.minimum = prop.minimum
  if (prop.maximum !== undefined) node.maximum = prop.maximum
  if (prop.items !== undefined) node.items = toJsonSchemaNode(prop.items)
  return node
}

export function buildSettingsJsonSchema(): IJSONSchema {
  const properties: Record<string, IJSONSchema> = {}
  for (const node of ConfigurationRegistry.getConfigurationNodes()) {
    for (const [key, prop] of Object.entries(node.properties)) {
      properties[key] = toJsonSchemaNode(prop)
    }
  }
  return {
    type: 'object',
    properties,
    // Settings.json allows comments + trailing commas in jsonc; permitting any
    // extra keys avoids spurious "unknown property" errors when a user types a
    // setting whose contribution registers later.
    additionalProperties: true,
  }
}
