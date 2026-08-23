/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over ICodexConfigService: loads `~/.codex/config.toml` + auth status
 *  once, exposes the live value, and offers a `patch` that writes through to disk
 *  and refreshes local state. All panels in the Codex settings share this so edits
 *  stay consistent with the on-disk files the agent + CLI also read.
 *
 *  The editor's own selection (which provider / `@subscription` to use, plus the
 *  model pick) lives in aiSettings.json's `agentSettings.codex` block.
 *  `applyAuthentication` persists it and drives the matching `applyCredential`
 *  intent (a self-contained gateway, or the ChatGPT login). `activeAuth` is the
 *  drift-detection result from `resolveActiveAuth` — what is actually in effect on
 *  disk versus the declared selection.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
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
  type CodexActiveAuth,
  type CodexAgentSettings,
  type CodexAuthStatus,
  type CodexSettings,
  type CodexSettingsPatch,
} from '../../../../shared/ipc/codexConfigService.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../shared/ipc/claudeConfigService.js'
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
  readonly agentSettings: CodexAgentSettings
  /** Drift-detection: what is in effect on disk versus the declared selection. */
  readonly activeAuth: CodexActiveAuth
  patch(patch: CodexSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<CodexAuthStatus>
  /** Persist the provider/`@subscription` selection and apply the matching credential. */
  applyAuthentication(authentication: string | undefined): Promise<void>
  /** Persist the model pick and write config.toml `model` (undefined clears it). */
  setModel(model: string | undefined): Promise<void>
}

const LOGGED_OUT: CodexAuthStatus = { active: 'none', hasApiKey: false }
const NO_ACTIVE_AUTH: CodexActiveAuth = { kind: 'none', drift: false }

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
  const [agentSettings, setAgentSettings] = useState<CodexAgentSettings>({})
  const [activeAuth, setActiveAuth] = useState<CodexActiveAuth>(NO_ACTIVE_AUTH)
  const agentSettingsRef = useRef<CodexAgentSettings>({})

  const loadAll = useCallback(async () => {
    const [next, path, status, stored, active] = await Promise.all([
      service.read(authority),
      service.configPath(authority),
      service.readAuthStatus(authority),
      service.readAgentSettings(),
      service.resolveActiveAuth(authority),
    ])
    setSettings(next)
    setConfigPath(path)
    setAuthStatus(status)
    setAgentSettings(stored)
    agentSettingsRef.current = stored
    setActiveAuth(active)
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
      const [next, path, status, stored, auth] = await Promise.all([
        service.read(authority),
        service.configPath(authority),
        service.readAuthStatus(authority),
        service.readAgentSettings(),
        service.resolveActiveAuth(authority),
      ])
      if (!active) return
      setSettings(next)
      setConfigPath(path)
      setAuthStatus(status)
      setAgentSettings(stored)
      agentSettingsRef.current = stored
      setActiveAuth(auth)
      setLoaded(true)
    })()
    // Refresh login status + drift live when auth.json / config.toml changes on
    // disk (e.g. once the browser OAuth flow from `codex login` completes).
    const sub = service.onDidChangeAuth(() => {
      void (async () => {
        const [status, auth] = await Promise.all([
          service.readAuthStatus(authority),
          service.resolveActiveAuth(authority),
        ])
        if (!active) return
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

  const writeAgentSettings = useCallback(
    async (next: CodexAgentSettings) => {
      await service.writeAgentSettings(next)
      agentSettingsRef.current = next
      setAgentSettings(next)
    },
    [service],
  )

  const resolveProviders = useCallback(async (): Promise<readonly AiResolvedProvider[]> => {
    const [entries, knowledge] = await Promise.all([ai.getProviders(), ai.getModelKnowledge()])
    return resolveProviderEntries(entries, knowledge).providers
  }, [ai])

  const applyAuthentication = useCallback(
    async (authentication: string | undefined) => {
      const next: CodexAgentSettings = { ...agentSettingsRef.current }
      if (authentication) next.authentication = authentication
      else delete next.authentication
      await writeAgentSettings(next)

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
    [service, authority, writeAgentSettings, resolveProviders, notification],
  )

  const setModel = useCallback(
    async (model: string | undefined) => {
      const next: CodexAgentSettings = { ...agentSettingsRef.current }
      if (model) next.model = model
      else delete next.model
      await writeAgentSettings(next)
      await patch(model !== undefined ? { model } : { model: null })
    },
    [writeAgentSettings, patch],
  )

  return {
    settings,
    loaded,
    configPath,
    authority,
    authStatus,
    agentSettings,
    activeAuth,
    patch,
    reload,
    reloadAuthStatus,
    applyAuthentication,
    setModel,
  }
}
