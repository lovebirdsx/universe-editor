/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over ICodexConfigService: loads `~/.codex/config.toml` + auth status
 *  once, exposes the live value, and offers a `patch` that writes through to disk
 *  and refreshes local state. All panels in the Codex settings share this so edits
 *  stay consistent with the on-disk files the agent + CLI also read.
 *
 *  The on-disk files are the single source of truth: `applyAuthentication` drives
 *  the matching `applyCredential` intent (a self-contained gateway, or the
 *  ChatGPT login) and the model pick writes config.toml `model`; `activeAuth` is
 *  reverse-looked up from disk via `resolveActiveAuth` — what is actually in
 *  effect, with no declared selection left to drift from it.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import {
  IAiModelService,
  INotificationService,
  Severity,
  localize,
  resolveProviderEntries,
  type AiResolvedProvider,
} from '@universe-editor/platform'
import {
  ICodexConfigService,
  type CodexAuthStatus,
  type CodexSettings,
  type CodexSettingsPatch,
} from '../../../../shared/ipc/codexConfigService.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../shared/ipc/claudeConfigService.js'
import type { AgentActiveAuth } from '../../../../shared/ai/agentActiveAuth.js'
import { deriveCodexGateway, findProviderById } from '../../../../shared/ai/providerDerivation.js'
import { useService } from '../../useService.js'
import { useRemoteAuthority } from '../../useRemoteAuthority.js'

export interface UseCodexConfig {
  readonly settings: CodexSettings
  readonly loaded: boolean
  readonly configPath: string
  /** Remote-ssh authority when the workspace folder is remote; undefined for local. */
  readonly authority: string | undefined
  readonly authStatus: CodexAuthStatus
  /** Which credential is actually in effect, reverse-looked up from disk. */
  readonly activeAuth: AgentActiveAuth
  patch(patch: CodexSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<CodexAuthStatus>
  /** Apply the matching credential (the effective provider is read back from disk). */
  applyAuthentication(authentication: string | undefined): Promise<void>
  /** Write config.toml `model` (undefined clears it). */
  setModel(model: string | undefined): Promise<void>
}

const LOGGED_OUT: CodexAuthStatus = { active: 'none', hasApiKey: false }
const NO_ACTIVE_AUTH: AgentActiveAuth = { kind: 'none' }

export function useCodexConfig(): UseCodexConfig {
  const service = useService<ICodexConfigService>(ICodexConfigService)
  const ai = useService<IAiModelService>(IAiModelService)
  const notification = useService(INotificationService)
  // Remote workspace: configure the remote `~/.codex`; local leaves authority
  // undefined so main routes to the local store.
  const authority = useRemoteAuthority()
  const [settings, setSettings] = useState<CodexSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [authStatus, setAuthStatus] = useState<CodexAuthStatus>(LOGGED_OUT)
  const [activeAuth, setActiveAuth] = useState<AgentActiveAuth>(NO_ACTIVE_AUTH)

  const loadAll = useCallback(async () => {
    const [next, path, status, auth] = await Promise.all([
      service.read(authority),
      service.configPath(authority),
      service.readAuthStatus(authority),
      service.resolveActiveAuth(authority),
    ])
    setSettings(next)
    setConfigPath(path)
    setAuthStatus(status)
    setActiveAuth(auth)
    setLoaded(true)
  }, [service, authority])

  const reload = useCallback(() => loadAll(), [loadAll])

  const reloadAuthStatus = useCallback(async () => {
    const status = await service.readAuthStatus(authority)
    setAuthStatus(status)
    return status
  }, [service, authority])

  useEffect(() => {
    let active = true
    void (async () => {
      const [next, path, status, auth] = await Promise.all([
        service.read(authority),
        service.configPath(authority),
        service.readAuthStatus(authority),
        service.resolveActiveAuth(authority),
      ])
      if (!active) return
      setSettings(next)
      setConfigPath(path)
      setAuthStatus(status)
      setActiveAuth(auth)
      setLoaded(true)
    })()
    // Refresh live when auth.json / config.toml changes on disk (e.g. once the
    // browser OAuth flow from `codex login` completes) — the watch now also
    // covers config.toml, so the settings snapshot must refresh too.
    const sub = service.onDidChangeAuth(() => {
      void (async () => {
        const [next, status, auth] = await Promise.all([
          service.read(authority),
          service.readAuthStatus(authority),
          service.resolveActiveAuth(authority),
        ])
        if (!active) return
        setSettings(next)
        setAuthStatus(status)
        setActiveAuth(auth)
      })()
    })
    return () => {
      active = false
      sub.dispose()
    }
  }, [service, authority])

  const patch = useCallback(
    async (p: CodexSettingsPatch) => {
      await service.patch(p, authority)
      setSettings(await service.read(authority))
    },
    [service, authority],
  )

  const resolveProviders = useCallback(async (): Promise<readonly AiResolvedProvider[]> => {
    const [entries, knowledge] = await Promise.all([ai.getProviders(), ai.getModelKnowledge()])
    return resolveProviderEntries(entries, knowledge).providers
  }, [ai])

  const applyAuthentication = useCallback(
    async (authentication: string | undefined) => {
      if (!authentication || authentication === AGENT_SUBSCRIPTION_AUTH) {
        // Clear the API key + gateway so the ChatGPT login takes over.
        const status = await service.applyCredential({ kind: 'chatgpt' }, authority)
        setAuthStatus(status)
      } else {
        const providers = await resolveProviders()
        const derived = deriveCodexGateway(findProviderById(providers, authentication))
        if (derived === undefined) {
          notification.notify({
            severity: Severity.Error,
            message: localize(
              'codexSettings.auth.applyGatewayError',
              'This credential could not be applied — its provider is missing a base URL or API key.',
            ),
          })
          return
        }
        const status = await service.applyCredential({ kind: 'gateway', ...derived }, authority)
        setAuthStatus(status)
      }
      setSettings(await service.read(authority))
      setActiveAuth(await service.resolveActiveAuth(authority))
    },
    [service, authority, resolveProviders, notification],
  )

  const setModel = useCallback(
    async (model: string | undefined) => {
      await patch(model !== undefined ? { model } : { model: null })
    },
    [patch],
  )

  return {
    settings,
    loaded,
    configPath,
    authority,
    authStatus,
    activeAuth,
    patch,
    reload,
    reloadAuthStatus,
    applyAuthentication,
    setModel,
  }
}
