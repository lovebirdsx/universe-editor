export const MOBILE_PAIR_PATH = '/api/pair'
export const MOBILE_WS_PATH = '/ws'
export const MOBILE_PAIR_PAGE_PATH = '/pair'

/**
 * 32 symbols. I/L/O and 0 are omitted because they are easy to confuse on a
 * phone screen; 1 stays because neither I nor L is present.
 */
export const PAIR_CODE_ALPHABET = '123456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const PAIR_CODE_LENGTH = 8

export const PAIR_DEVICE_PLATFORMS = ['ios', 'android', 'other'] as const
export type PairDevicePlatform = (typeof PAIR_DEVICE_PLATFORMS)[number]

export interface PairRequest {
  code: string
  deviceName: string
  platform: PairDevicePlatform
}

export interface PairResponse {
  deviceId: string
  token: string
  pcName: string
  protocolVersion: number
}

export type RandomValuesSource = (values: Uint8Array) => Uint8Array

interface CryptoWithRandomValues {
  getRandomValues: RandomValuesSource
}

function defaultRandomValues(values: Uint8Array): Uint8Array {
  const crypto = (globalThis as { crypto?: CryptoWithRandomValues }).crypto
  if (crypto === undefined) {
    throw new Error('crypto.getRandomValues is not available')
  }
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  return getRandomValues(values)
}

/**
 * Returns a fresh pairing code. The injectable source exists so tests can use a
 * deterministic stream and callers can supply a platform RNG.
 */
export function generatePairCode(
  getRandomValues: RandomValuesSource = defaultRandomValues,
): string {
  // The alphabet has exactly 32 entries, so the low 5 bits of a random byte are
  // uniform. Masking is bias-free here; a non-power-of-two alphabet would need
  // rejection sampling.
  const bytes = getRandomValues(new Uint8Array(PAIR_CODE_LENGTH))
  let code = ''
  for (let index = 0; index < PAIR_CODE_LENGTH; index += 1) {
    code += PAIR_CODE_ALPHABET.charAt((bytes[index] ?? 0) & 31)
  }
  return code
}

/** Strips display separators and case so `ab-cd 2345` and `ABCD2345` compare equal. */
export function normalizePairCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase()
}

export function isValidPairCodeShape(input: string): boolean {
  const normalized = normalizePairCode(input)
  if (normalized.length !== PAIR_CODE_LENGTH) return false
  for (const char of normalized) {
    if (!PAIR_CODE_ALPHABET.includes(char)) return false
  }
  return true
}

/** Display form (`XXXX-XXXX`). Returns the normalized string unchanged when malformed. */
export function formatPairCode(input: string): string {
  const normalized = normalizePairCode(input)
  if (normalized.length !== PAIR_CODE_LENGTH) return normalized
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

/** The one-time code lives in the fragment so it never reaches server logs or Referer. */
export function buildPairUrl(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, '')
  return `${base}${MOBILE_PAIR_PAGE_PATH}#code=${encodeURIComponent(normalizePairCode(code))}`
}

/**
 * Extracts the normalized code from a URL fragment. Returns `undefined` when the
 * fragment is absent or has no `code` parameter; callers validate the shape.
 */
export function parsePairFragment(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (raw === '') return undefined
  const code = new URLSearchParams(raw).get('code')
  if (code === null) return undefined
  const normalized = normalizePairCode(code)
  return normalized === '' ? undefined : normalized
}
