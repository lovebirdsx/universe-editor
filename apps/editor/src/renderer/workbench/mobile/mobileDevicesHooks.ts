/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Stateful hooks behind the Mobile Devices settings page. The view consumes
 *  these; every gateway interaction (status, devices, pairing, audit) lives here
 *  so it can be exercised with a fake IMobileGatewayService.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  type IMobileGatewayService,
  type MobileAuditEntry,
  type MobileDeviceInfo,
  type MobileGatewayConfigPatch,
  type MobileGatewayConfigState,
  type MobileGatewayStatus,
  type MobilePairingSession,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  findNewDevice,
  isFixedPairingExpiry,
  pairingRemainingMs,
  preferredPairUrlIndex,
} from './mobileDevicesModel.js'

export interface MobileGatewayConfigController {
  readonly state: MobileGatewayConfigState | undefined
  /** Local save failure or the file's parse error, whichever is current. */
  readonly error: string | undefined
  readonly update: (patch: MobileGatewayConfigPatch) => Promise<void>
}

export function useMobileGatewayConfig(
  gateway: IMobileGatewayService,
): MobileGatewayConfigController {
  const [state, setState] = useState<MobileGatewayConfigState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let active = true
    // Subscribe before the initial read so an edit landing in between is not lost.
    const subscription = gateway.onDidChangeConfig((next) => {
      if (!active) return
      setState(next)
      setError(undefined)
    })
    void gateway
      .getConfig()
      .then((next) => {
        if (active) setState(next)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
      subscription.dispose()
    }
  }, [gateway])

  const update = useCallback(
    async (patch: MobileGatewayConfigPatch) => {
      setError(undefined)
      setState((previous) => {
        if (previous === undefined) return previous
        return {
          config: { ...previous.config, ...patch },
          ...(previous.error !== undefined ? { error: previous.error } : {}),
        }
      })
      try {
        const result = await gateway.updateConfig(patch)
        if (result.ok) {
          setState(result.state)
          return
        }
        setError(result.errors.join('; '))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      const current = await gateway.getConfig().catch(() => undefined)
      if (current !== undefined) setState(current)
    },
    [gateway],
  )

  return { state, error: error ?? state?.error, update }
}

export function useGatewayStatus(gateway: IMobileGatewayService): MobileGatewayStatus | undefined {
  const [status, setStatus] = useState<MobileGatewayStatus | undefined>(undefined)

  useEffect(() => {
    let active = true
    void gateway
      .getStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch(() => undefined)
    const subscription = gateway.onDidChangeStatus((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
      subscription.dispose()
    }
  }, [gateway])

  return status
}

export function useGatewayDevices(
  gateway: IMobileGatewayService,
): readonly MobileDeviceInfo[] | undefined {
  const [devices, setDevices] = useState<readonly MobileDeviceInfo[] | undefined>(undefined)

  useEffect(() => {
    let active = true
    void gateway
      .listDevices()
      .then((next) => {
        if (active) setDevices(next)
      })
      .catch(() => undefined)
    const subscription = gateway.onDidChangeDevices((next) => {
      if (active) setDevices(next)
    })
    return () => {
      active = false
      subscription.dispose()
    }
  }, [gateway])

  return devices
}

export type PairingPhase = 'idle' | 'starting' | 'active' | 'expired' | 'succeeded'

export interface PairingViewState {
  readonly phase: PairingPhase
  readonly session: MobilePairingSession | undefined
  readonly pairUrls: readonly string[]
  readonly selectedUrlIndex: number
  readonly selectedUrl: string | undefined
  readonly remainingMs: number
  readonly fixedExpiry: boolean
  readonly error: string | undefined
}

interface PairingController extends PairingViewState {
  readonly start: () => Promise<void>
  readonly cancel: () => Promise<void>
  readonly selectUrl: (index: number) => void
}

export function usePairingSession(
  gateway: IMobileGatewayService,
  devices: readonly MobileDeviceInfo[] | undefined,
): PairingController {
  const [phase, setPhase] = useState<PairingPhase>('idle')
  const [session, setSession] = useState<MobilePairingSession | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selectedUrlIndex, setSelectedUrlIndex] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  /**
   * Devices that existed when pairing started: anything appearing afterwards is
   * the pairing result. `null` means the first device list had not arrived yet —
   * it becomes the baseline instead of being mistaken for a new device.
   */
  const baselineRef = useRef<ReadonlySet<string> | null>(null)
  const activeRef = useRef(false)
  activeRef.current = phase === 'active' || phase === 'starting'

  const start = useCallback(async () => {
    setError(undefined)
    setPhase('starting')
    setNow(Date.now())
    baselineRef.current =
      devices === undefined ? null : new Set(devices.map((device) => device.deviceId))
    try {
      const next = await gateway.startPairing()
      setSession(next)
      setSelectedUrlIndex(preferredPairUrlIndex(next.pairUrls))
      setPhase('active')
    } catch (err) {
      setPhase('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [gateway, devices])

  const cancel = useCallback(async () => {
    setPhase('idle')
    setSession(undefined)
    setError(undefined)
    await gateway.cancelPairing().catch(() => undefined)
  }, [gateway])

  const selectUrl = useCallback((index: number) => {
    setSelectedUrlIndex(index)
  }, [])

  // Expiry is recomputed from wall-clock time, not from a decrementing counter,
  // so a suspended window or a slow tick never shows more time than is left.
  useEffect(() => {
    if (phase !== 'active' || session === undefined) return
    if (isFixedPairingExpiry(session.expiresAt)) return
    const tick = (): void => {
      const current = Date.now()
      setNow(current)
      if (current >= session.expiresAt) setPhase('expired')
    }
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [phase, session])

  // A new device appearing while a code is on screen is the pairing result.
  useEffect(() => {
    if (phase !== 'active' || devices === undefined) return
    if (baselineRef.current === null) {
      baselineRef.current = new Set(devices.map((device) => device.deviceId))
      return
    }
    if (findNewDevice(baselineRef.current, devices) !== undefined) {
      setPhase('succeeded')
      setSession(undefined)
      setError(undefined)
    }
  }, [devices, phase])

  // Leaving the page invalidates an unused code rather than leaving it live.
  useEffect(
    () => () => {
      if (activeRef.current) void gateway.cancelPairing().catch(() => undefined)
    },
    [gateway],
  )

  const pairUrls = session?.pairUrls ?? []
  const selectedUrl = pairUrls[selectedUrlIndex] ?? pairUrls[0]

  return {
    phase,
    session,
    pairUrls,
    selectedUrlIndex,
    selectedUrl,
    remainingMs: session === undefined ? 0 : pairingRemainingMs(session.expiresAt, now),
    fixedExpiry: session !== undefined && isFixedPairingExpiry(session.expiresAt),
    error,
    start,
    cancel,
    selectUrl,
  }
}

interface QrCodeState {
  readonly dataUrl: string | undefined
  readonly error: string | undefined
}

/**
 * Render the pairing URL as an inline SVG data URL. The URL carries the
 * one-time code, so it is only ever handed to the QR renderer — never logged.
 */
export function useQrCodeDataUrl(text: string | undefined): QrCodeState {
  const [state, setState] = useState<QrCodeState>({ dataUrl: undefined, error: undefined })

  useEffect(() => {
    if (text === undefined) {
      setState({ dataUrl: undefined, error: undefined })
      return
    }
    let active = true
    void QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 })
      .then((svg) => {
        if (active) {
          setState({
            dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
            error: undefined,
          })
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setState({
            dataUrl: undefined,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    return () => {
      active = false
    }
  }, [text])

  return state
}

export function useRecentAudit(
  gateway: IMobileGatewayService,
  enabled: boolean,
): readonly MobileAuditEntry[] | undefined {
  const [entries, setEntries] = useState<readonly MobileAuditEntry[] | undefined>(undefined)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void gateway
      .getRecentAudit(20)
      .then((next) => {
        if (active) setEntries(next)
      })
      .catch(() => {
        if (active) setEntries([])
      })
    return () => {
      active = false
    }
  }, [gateway, enabled])

  return entries
}
