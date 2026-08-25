/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useAutoVerify — probes a provider card's connectivity without a manual button.
 *  On mount the last answer is restored from storage (5 minute TTL); when it is
 *  missing or stale, a probe fires for entries that can be tested (an effective
 *  protocol and an effective base URL). Editing any connection-relevant field
 *  re-probes after a short debounce, bypassing the TTL; entries that cannot be
 *  tested sit at "not tested".
 *
 *  The trigger is a fingerprint of the effective connection, not the reload
 *  token: every provider-list reload produces a new array reference, so a
 *  reference comparison would re-probe on unrelated model metadata changes.
 *  A stale in-flight result is dropped via a token so it can neither paint
 *  nor be cached.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  StorageScope,
  type AiProviderEntry,
  type AiProviderVerifyCode,
  type IAiModelService,
  type IStorageService,
} from '@universe-editor/platform'
import { declaredProtocols } from '../../../../shared/ai/protocolMapEdit.js'
import { effectiveConnection, findInherited } from '../../../../shared/ai/providerInheritance.js'
import { verifyFailureMessage } from '../../../services/ai/verifyResult.js'

/** How long a probe answer is still worth showing. */
const CONNECTIVITY_TTL_MS = 5 * 60 * 1000
const AUTO_VERIFY_DEBOUNCE_MS = 600

const connectivityKey = (id: string): string => `ai.settings.connectivity.${id}`

/** Cached as a code, not a message: the display language can change between reads. */
interface StoredConnectivity {
  readonly ok: boolean
  readonly modelCount: number
  readonly code?: AiProviderVerifyCode
  readonly status?: number
  readonly at: number
}

export type ConnectState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

export function useAutoVerify(
  aiModel: IAiModelService,
  provider: AiProviderEntry,
  allProviders: readonly AiProviderEntry[],
  storage: IStorageService,
): { readonly connect: ConnectState } {
  const [connect, setConnect] = useState<ConnectState>({ kind: 'idle' })

  const { baseUrl, apiKey } = effectiveConnection(provider, allProviders)

  const effectiveProtocol = useMemo(() => {
    const inheritedMap = findInherited(provider, allProviders, 'protocolMap')
    const effectiveMap = provider.protocolMap ?? inheritedMap?.value
    return provider.defaultProtocol ?? declaredProtocols(effectiveMap)[0]
  }, [provider, allProviders])

  const testable = effectiveProtocol !== undefined && baseUrl !== undefined
  // The apiKey is part of the fingerprint — editing it must re-probe — but the
  // fingerprint itself never leaves this hook, so the key is not logged.
  const fingerprint = JSON.stringify({ protocol: effectiveProtocol, baseUrl, apiKey })

  const tokenRef = useRef(0)
  const fingerprintRef = useRef<string | undefined>(undefined)

  const verify = useCallback(async () => {
    if (effectiveProtocol === undefined || baseUrl === undefined) return
    const token = ++tokenRef.current
    setConnect({ kind: 'checking' })
    // Dial what the resolver would dial, not just what this entry declares: a
    // purely inheriting entry keeps its address and key on an ancestor.
    const result = await aiModel.verifyProvider({
      id: provider.id,
      protocol: effectiveProtocol,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    })
    if (token !== tokenRef.current) return
    console.debug('aiModels: verify', {
      provider: provider.id,
      ok: result.ok,
      modelCount: result.modelCount,
      ...(result.ok ? {} : { code: result.code, status: result.status }),
    })
    setConnect(
      result.ok
        ? { kind: 'ok', modelCount: result.modelCount }
        : { kind: 'fail', error: verifyFailureMessage(result) },
    )
    const stored: StoredConnectivity = {
      ok: result.ok,
      modelCount: result.modelCount,
      ...(result.code !== undefined ? { code: result.code } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
      at: Date.now(),
    }
    void storage.set(connectivityKey(provider.id), stored, StorageScope.GLOBAL)
  }, [aiModel, provider.id, effectiveProtocol, baseUrl, apiKey, storage])

  const verifyRef = useRef(verify)
  const testableRef = useRef(testable)
  useEffect(() => {
    verifyRef.current = verify
    testableRef.current = testable
  })

  // A probe in flight when the card unmounts must not paint or write cache.
  useEffect(
    () => () => {
      tokenRef.current++
    },
    [],
  )

  // Mount: restore the cached answer; probe when missing or stale (and testable).
  useEffect(() => {
    let active = true
    void storage
      .get<StoredConnectivity>(connectivityKey(provider.id), StorageScope.GLOBAL)
      .then((stored) => {
        if (!active || !testableRef.current) return
        if (stored && Date.now() - stored.at <= CONNECTIVITY_TTL_MS) {
          setConnect(
            stored.ok
              ? { kind: 'ok', modelCount: stored.modelCount }
              : {
                  kind: 'fail',
                  error: verifyFailureMessage({
                    ok: false,
                    modelCount: 0,
                    ...(stored.code !== undefined ? { code: stored.code } : {}),
                    ...(stored.status !== undefined ? { status: stored.status } : {}),
                  }),
                },
          )
          return
        }
        void verifyRef.current()
      })
    return () => {
      active = false
    }
  }, [storage, provider.id])

  // Connection edits: re-probe after a debounce, bypassing the TTL. The first
  // render only seeds the fingerprint so the mount path and this path never
  // double-fire.
  useEffect(() => {
    if (fingerprintRef.current === undefined) {
      fingerprintRef.current = fingerprint
      return
    }
    if (fingerprintRef.current === fingerprint) return
    fingerprintRef.current = fingerprint
    // The connection changed: an in-flight answer no longer describes this
    // entry, so invalidate it right away — not when the debounced probe starts,
    // which could be up to 600ms of a stale result painting over the edit.
    tokenRef.current++
    if (!testable) {
      setConnect({ kind: 'idle' })
      void storage.remove(connectivityKey(provider.id), StorageScope.GLOBAL)
      return
    }
    const timer = setTimeout(() => void verifyRef.current(), AUTO_VERIFY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [fingerprint, testable, provider.id, storage])

  return { connect }
}
