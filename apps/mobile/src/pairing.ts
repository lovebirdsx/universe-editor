import {
  MOBILE_PAIR_PATH,
  type PairDevicePlatform,
  type PairRequest,
  type PairResponse,
} from '@universe-editor/mobile-protocol'

export type PairRequestResult =
  | { readonly ok: true; readonly response: PairResponse }
  | { readonly ok: false; readonly code: string; readonly network: boolean }

export type PairRequester = (input: PairRequest) => Promise<PairRequestResult>

export async function requestPair(
  input: PairRequest,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<PairRequestResult> {
  let response: Response
  try {
    response = await fetchImpl(MOBILE_PAIR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    return { ok: false, code: 'network', network: true }
  }

  const payload = await readJson(response)
  if (!response.ok) {
    return { ok: false, code: errorCodeFrom(payload), network: false }
  }
  if (!isPairResponse(payload)) {
    return { ok: false, code: 'internal', network: false }
  }
  return { ok: true, response: payload }
}

export interface DeviceGuess {
  readonly deviceName: string
  readonly platform: PairDevicePlatform
}

/** Coarse UA sniffing is enough for a default the user can edit. */
export function guessDevice(userAgent: string): DeviceGuess {
  if (/iphone/i.test(userAgent)) return { deviceName: 'iPhone', platform: 'ios' }
  if (/ipad/i.test(userAgent)) return { deviceName: 'iPad', platform: 'ios' }
  if (/android/i.test(userAgent)) return { deviceName: 'Android 手机', platform: 'android' }
  return { deviceName: '手机', platform: 'other' }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

function errorCodeFrom(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'internal'
  const code = (payload as Record<string, unknown>)['code']
  return typeof code === 'string' ? code : 'internal'
}

function isPairResponse(value: unknown): value is PairResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['deviceId'] === 'string' &&
    record['deviceId'] !== '' &&
    typeof record['token'] === 'string' &&
    record['token'] !== '' &&
    typeof record['pcName'] === 'string' &&
    typeof record['protocolVersion'] === 'number'
  )
}
