import type { TriggerPayloadValue } from '../../../shared/triggers/types.js'
import { POLL_MAX_PAYLOAD_VALUE_LENGTH } from './pollCommandFetcher.js'

/** Same shape the prompt template can address through `{{event.<field>}}`. */
const FIELD_NAME = /^[A-Za-z0-9_]{1,64}$/
/** Poll keys may contain spaces; NUL / newlines would corrupt log and state keys. */
const SOURCE_KEY = /^poll:[^\u0000\r\n]{1,512}$/u
const MAX_FIELDS = 64

/** Renderer input crosses IPC; keep only scalar fields the template can use. */
export function sanitizeManualPayload(
  input: unknown,
): Readonly<Record<string, TriggerPayloadValue>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const entries: [string, TriggerPayloadValue][] = []
  for (const [key, value] of Object.entries(input)) {
    if (entries.length >= MAX_FIELDS) break
    if (!FIELD_NAME.test(key)) continue
    if (typeof value === 'string') {
      entries.push([key, value.slice(0, POLL_MAX_PAYLOAD_VALUE_LENGTH)])
    } else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      entries.push([key, value])
    }
  }
  // fromEntries defines properties (no `__proto__` setter), so a literal
  // `__proto__` field cannot mutate the prototype.
  return Object.fromEntries(entries)
}

export function sanitizeManualSourceKey(input: unknown): string | undefined {
  return typeof input === 'string' && SOURCE_KEY.test(input) ? input : undefined
}
