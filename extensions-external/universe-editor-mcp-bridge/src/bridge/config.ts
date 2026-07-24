import { z } from 'zod'

import { EDITOR_PID_ENV } from '../env.js'

const configSchema = z.object({
  editorPid: z.coerce.number().int().positive().optional(),
  timeoutMs: z.coerce.number().int().positive().default(60000),
  connectTimeoutMs: z.coerce.number().int().positive().default(15000),
})

export type BridgeConfig = z.infer<typeof configSchema>

export function readConfig(): BridgeConfig {
  return configSchema.parse({
    editorPid: process.env[EDITOR_PID_ENV]?.trim() || undefined,
    timeoutMs: process.env.UNIVERSE_EDITOR_TIMEOUT_MS,
    connectTimeoutMs: process.env.UNIVERSE_EDITOR_CONNECT_TIMEOUT_MS,
  })
}
