/**
 * Manifest validation (host-only). Parses a raw extension `package.json` into the
 * typed `IExtensionManifest` shared shape, rejecting malformed manifests so a
 * single bad extension can't corrupt the contribution registry. zod gives us a
 * precise error message we forward to stderr.
 */
import { z } from 'zod'
import type { IExtensionManifest } from '@universe-editor/extensions-common'

const commandContributionSchema = z.object({
  command: z.string().min(1),
  title: z.string().min(1),
  category: z.string().optional(),
  icon: z.string().optional(),
})

const menuItemSchema = z.object({
  command: z.string().min(1),
  when: z.string().optional(),
  group: z.string().optional(),
  icon: z.string().optional(),
})

const keybindingSchema = z.object({
  command: z.string().min(1),
  key: z.string().min(1),
  mac: z.string().optional(),
  when: z.string().optional(),
})

const configPropertySchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'object', 'array', 'null']),
    default: z.unknown().optional(),
    description: z.string().optional(),
    enum: z.array(z.unknown()).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  })
  .passthrough()

const configurationSchema = z.object({
  title: z.string().optional(),
  properties: z.record(configPropertySchema),
})

const contributesSchema = z
  .object({
    commands: z.array(commandContributionSchema).optional(),
    menus: z.record(z.array(menuItemSchema)).optional(),
    keybindings: z.array(keybindingSchema).optional(),
    configuration: z.union([configurationSchema, z.array(configurationSchema)]).optional(),
  })
  // Tolerate contribution points we don't understand yet (forward-compat).
  .passthrough()

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  publisher: z.string().optional(),
  main: z.string().optional(),
  engines: z.object({ universe: z.string().min(1) }),
  activationEvents: z.array(z.string()).optional(),
  contributes: contributesSchema.optional(),
})

/** Parse + validate a raw manifest object. Throws with a readable message on failure. */
export function parseManifest(raw: unknown): IExtensionManifest {
  const result = manifestSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new Error(`invalid manifest: ${issues}`)
  }
  return result.data as IExtensionManifest
}
