/**
 * Manifest validation — parses a raw extension `package.json` into the typed
 * {@link IExtensionManifest}, rejecting malformed manifests so one bad extension
 * can't corrupt the contribution registry. zod gives a precise error message.
 *
 * NOT part of the package barrel (`index.ts`): importing this pulls in `zod`, and
 * the renderer only needs the pure types. The host + Node-side packaging /
 * management services import this subpath directly (`.../manifest-schema.js`).
 */
import { z } from 'zod'
import { isValidActivationEvent } from './activation.js'
import type { IExtensionManifest } from './manifest.js'

const commandContributionSchema = z.object({
  command: z.string().min(1),
  title: z.string().min(1),
  category: z.string().optional(),
  icon: z.string().optional(),
})

const menuItemSchema = z
  .object({
    command: z.string().min(1).optional(),
    submenu: z.string().min(1).optional(),
    when: z.string().optional(),
    group: z.string().optional(),
    icon: z.string().optional(),
  })
  .refine((m) => m.command !== undefined || m.submenu !== undefined, {
    message: 'menu item must have either "command" or "submenu"',
  })

const submenuSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
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

const jsonValidationSchema = z.object({
  fileMatch: z.union([z.string().min(1), z.array(z.string().min(1))]),
  url: z.string().min(1),
})

const contributesSchema = z
  .object({
    commands: z.array(commandContributionSchema).optional(),
    menus: z.record(z.array(menuItemSchema)).optional(),
    submenus: z.array(submenuSchema).optional(),
    keybindings: z.array(keybindingSchema).optional(),
    configuration: z.union([configurationSchema, z.array(configurationSchema)]).optional(),
    jsonValidation: z.array(jsonValidationSchema).optional(),
  })
  // Tolerate contribution points we don't understand yet (forward-compat).
  .passthrough()

const repositorySchema = z.union([
  z.string().min(1),
  z.object({ type: z.string().optional(), url: z.string().min(1) }),
])

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  publisher: z.string().optional(),
  main: z.string().optional(),
  engines: z.object({ universe: z.string().min(1) }),
  activationEvents: z
    .array(
      z.string().refine(isValidActivationEvent, {
        message:
          'unknown activation event (expected "*", "onStartupFinished", or "onCommand:"/"onLanguage:"/"onView:" with an id)',
      }),
    )
    .optional(),
  contributes: contributesSchema.optional(),
  // Marketplace display metadata (additive, all optional).
  categories: z.array(z.string().min(1)).optional(),
  keywords: z.array(z.string().min(1)).optional(),
  icon: z.string().min(1).optional(),
  repository: repositorySchema.optional(),
  homepage: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
  preview: z.boolean().optional(),
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
