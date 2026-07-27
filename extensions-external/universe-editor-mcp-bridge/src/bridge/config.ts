import { z } from 'zod'

const configSchema = z.object({
  timeoutMs: z.coerce.number().int().positive().default(60000),
  connectTimeoutMs: z.coerce.number().int().positive().default(15000),
})

export type BridgeConfig = z.infer<typeof configSchema>

export function readConfig(): BridgeConfig {
  return configSchema.parse({
    timeoutMs: process.env.UNIVERSE_EDITOR_TIMEOUT_MS,
    connectTimeoutMs: process.env.UNIVERSE_EDITOR_CONNECT_TIMEOUT_MS,
  })
}
