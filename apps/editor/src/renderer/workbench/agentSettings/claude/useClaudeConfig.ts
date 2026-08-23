/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over IClaudeConfigService: loads `~/.claude/settings.json` once,
 *  exposes the live value, and offers a `patch` that writes through to disk and
 *  refreshes local state. All panels in the Agent settings editor share this so
 *  edits stay consistent with the on-disk file the agent + CLI also read.
 *
 *  The editor's own selection (which provider / `@subscription` to inject, plus
 *  the model and fast-model picks) lives in aiSettings.json's `agentSettings.claude`
 *  block — this hook bridges the two: `applyAuthentication` both persists the
 *  selection and writes the matching credential env, `setModel` / `setSmallFastModel`
 *  write settings.json alongside their persisted picks.
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
  AGENT_SUBSCRIPTION_AUTH,
  IClaudeConfigService,
  type ClaudeAgentSettings,
  type ClaudeAuthStatus,
  type ClaudeSettings,
  type ClaudeSettingsPatch,
} from '../../../../shared/ipc/claudeConfigService.js'
import { deriveClaudeAuth, findProviderById } from '../../../../shared/ai/providerDerivation.js'
import { useService } from '../../useService.js'
import { useRemoteAuthority } from '../../useRemoteAuthority.js'

export interface UseClaudeConfig {
  readonly settings: ClaudeSettings
  readonly loaded: boolean
  readonly configPath: string
  /** Remote-ssh authority when the workspace folder is remote; undefined for local. */
  readonly authority: string | undefined
  readonly authStatus: ClaudeAuthStatus
  readonly agentSettings: ClaudeAgentSettings
  patch(patch: ClaudeSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<ClaudeAuthStatus>
  /** Persist the provider/`@subscription` selection and inject/clear the matching env. */
  applyAuthentication(authentication: string | undefined): Promise<void>
  /** Persist the model pick and write settings.model (undefined clears it). */
  setModel(model: string | undefined): Promise<void>
  /** Persist the fast-model pick and write env.ANTHROPIC_SMALL_FAST_MODEL. */
  setSmallFastModel(model: string | undefined): Promise<void>
}

const LOGGED_OUT: ClaudeAuthStatus = { loggedIn: false, expired: false }

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'
const SMALL_FAST_MODEL = 'ANTHROPIC_SMALL_FAST_MODEL'

export function useClaudeConfig(): UseClaudeConfig {
  const service = useService<IClaudeConfigService>(IClaudeConfigService)
  const ai = useService<IAiModelService>(IAiModelService)
  const notification = useService(INotificationService)
  // Remote workspace: configure the remote `~/.claude`; local: leave authority
  // undefined so main routes to the local store.
  const authority = useRemoteAuthority()
  const [settings, setSettings] = useState<ClaudeSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [authStatus, setAuthStatus] = useState<ClaudeAuthStatus>(LOGGED_OUT)
  const [agentSettings, setAgentSettings] = useState<ClaudeAgentSettings>({})
  const agentSettingsRef = useRef<ClaudeAgentSettings>({})

  const loadAll = useCallback(async () => {
    const [next, path, status, stored] = await Promise.all([
      service.read(authority),
      service.configPath(authority),
      service.readAuthStatus(authority),
      service.readAgentSettings(),
    ])
    setSettings(next)
    setConfigPath(path)
    setAuthStatus(status)
    setAgentSettings(stored)
    agentSettingsRef.current = stored
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
      const [next, path, status, stored] = await Promise.all([
        service.read(authority),
        service.configPath(authority),
        service.readAuthStatus(authority),
        service.readAgentSettings(),
      ])
      if (!active) return
      setSettings(next)
      setConfigPath(path)
      setAuthStatus(status)
      setAgentSettings(stored)
      agentSettingsRef.current = stored
      setLoaded(true)
    })()
    return () => {
      active = false
    }
  }, [service, authority])

  const patch = useCallback(
    async (p: ClaudeSettingsPatch) => {
      await service.patch(p, authority)
      setSettings(await service.read(authority))
    },
    [service, authority],
  )

  const writeAgentSettings = useCallback(
    async (next: ClaudeAgentSettings) => {
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
      const next: ClaudeAgentSettings = { ...agentSettingsRef.current }
      if (authentication) next.authentication = authentication
      else delete next.authentication
      await writeAgentSettings(next)

      if (!authentication || authentication === AGENT_SUBSCRIPTION_AUTH) {
        await patch({ env: { [API_KEY]: null, [AUTH_TOKEN]: null, [BASE_URL]: null } })
        return
      }
      const providers = await resolveProviders()
      const derived = deriveClaudeAuth(findProviderById(providers, authentication))
      if (derived === undefined) {
        notification.notify({
          severity: Severity.Error,
          message: localize(
            'agentSettings.auth.applyGatewayError',
            'This credential could not be applied — its provider is missing a base URL or API key.',
          ),
        })
        return
      }
      if (derived.kind === 'apiKey') {
        await patch({ env: { [API_KEY]: derived.apiKey, [AUTH_TOKEN]: null, [BASE_URL]: null } })
      } else {
        await patch({
          env: { [AUTH_TOKEN]: derived.authToken, [BASE_URL]: derived.baseUrl, [API_KEY]: null },
        })
      }
    },
    [writeAgentSettings, patch, resolveProviders, notification],
  )

  const setModel = useCallback(
    async (model: string | undefined) => {
      const next: ClaudeAgentSettings = { ...agentSettingsRef.current }
      if (model) next.model = model
      else delete next.model
      await writeAgentSettings(next)
      await patch(model !== undefined ? { model } : { model: null })
    },
    [writeAgentSettings, patch],
  )

  const setSmallFastModel = useCallback(
    async (model: string | undefined) => {
      const next: ClaudeAgentSettings = { ...agentSettingsRef.current }
      if (model) next.smallFastModel = model
      else delete next.smallFastModel
      await writeAgentSettings(next)
      await patch({ env: { [SMALL_FAST_MODEL]: model ?? null } })
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
    patch,
    reload,
    reloadAuthStatus,
    applyAuthentication,
    setModel,
    setSmallFastModel,
  }
}
