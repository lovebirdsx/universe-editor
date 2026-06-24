/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over ICodexConfigService: loads `~/.codex/config.toml` + auth status
 *  once, exposes the live value, and offers a `patch` that writes through to disk
 *  and refreshes local state. All panels in the Codex settings share this so edits
 *  stay consistent with the on-disk files the agent + CLI also read.
 *
 *  Codex splits credentials (auth.json) from settings (config.toml), so applying a
 *  profile writes the API key into auth.json and the gateway base URL into
 *  config.toml — keeping a single active credential the way `codex` expects.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import {
  ICodexConfigService,
  type CodexAuthStatus,
  type CodexCredentialProfile,
  type CodexSettings,
  type CodexSettingsPatch,
} from '../../../../shared/ipc/codexConfigService.js'
import { useService } from '../../useService.js'

export interface UseCodexConfig {
  readonly settings: CodexSettings
  readonly loaded: boolean
  readonly configPath: string
  readonly authStatus: CodexAuthStatus
  readonly profiles: readonly CodexCredentialProfile[]
  patch(patch: CodexSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<CodexAuthStatus>
  /** Insert or update a profile by id, persisting the whole library. */
  saveProfile(profile: CodexCredentialProfile): Promise<void>
  deleteProfile(id: string): Promise<void>
  /** Make a profile the active credential (auth.json key + config.toml base URL). */
  applyProfile(profile: CodexCredentialProfile): Promise<void>
  /** Set or clear the active API key in auth.json directly. */
  setApiKey(apiKey: string | null): Promise<void>
  /**
   * Hand control to the ChatGPT login: clear any API key in auth.json AND the
   * custom `openai_base_url` in config.toml, so ChatGPT tokens are not sent to a
   * gateway endpoint a previously-applied profile left behind.
   */
  switchToChatgptLogin(): Promise<void>
}

const LOGGED_OUT: CodexAuthStatus = { active: 'none', hasApiKey: false }

const BASE_URL = 'openai_base_url'

export function useCodexConfig(): UseCodexConfig {
  const service = useService<ICodexConfigService>(ICodexConfigService)
  const [settings, setSettings] = useState<CodexSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [authStatus, setAuthStatus] = useState<CodexAuthStatus>(LOGGED_OUT)
  const [profiles, setProfiles] = useState<readonly CodexCredentialProfile[]>([])

  const loadAll = useCallback(async () => {
    const [next, path, status, library] = await Promise.all([
      service.read(),
      service.configPath(),
      service.readAuthStatus(),
      service.readProfiles(),
    ])
    setSettings(next)
    setConfigPath(path)
    setAuthStatus(status)
    setProfiles(library)
    setLoaded(true)
  }, [service])

  const reload = useCallback(() => loadAll(), [loadAll])

  const reloadAuthStatus = useCallback(async () => {
    const status = await service.readAuthStatus()
    setAuthStatus(status)
    return status
  }, [service])

  useEffect(() => {
    let active = true
    void (async () => {
      const [next, path, status, library] = await Promise.all([
        service.read(),
        service.configPath(),
        service.readAuthStatus(),
        service.readProfiles(),
      ])
      if (!active) return
      setSettings(next)
      setConfigPath(path)
      setAuthStatus(status)
      setProfiles(library)
      setLoaded(true)
    })()
    // Refresh login status live when auth.json changes on disk (e.g. once the
    // browser OAuth flow from `codex login` completes), so no manual refresh is
    // needed.
    const sub = service.onDidChangeAuth(() => {
      void (async () => {
        const status = await service.readAuthStatus()
        if (active) setAuthStatus(status)
      })()
    })
    return () => {
      active = false
      sub.dispose()
    }
  }, [service])

  const patch = useCallback(
    async (p: CodexSettingsPatch) => {
      await service.patch(p)
      setSettings(await service.read())
    },
    [service],
  )

  const saveProfile = useCallback(
    async (profile: CodexCredentialProfile) => {
      const current = await service.readProfiles()
      const idx = current.findIndex((p) => p.id === profile.id)
      const next =
        idx >= 0 ? current.map((p) => (p.id === profile.id ? profile : p)) : [...current, profile]
      await service.writeProfiles(next)
      setProfiles(next)
    },
    [service],
  )

  const deleteProfile = useCallback(
    async (id: string) => {
      const current = await service.readProfiles()
      const next = current.filter((p) => p.id !== id)
      await service.writeProfiles(next)
      setProfiles(next)
    },
    [service],
  )

  const setApiKey = useCallback(
    async (apiKey: string | null) => {
      await service.setApiKey(apiKey)
      setAuthStatus(await service.readAuthStatus())
    },
    [service],
  )

  const applyProfile = useCallback(
    async (profile: CodexCredentialProfile) => {
      // The API key lives in auth.json; the gateway base URL in config.toml.
      await service.setApiKey(profile.apiKey ?? null)
      await service.patch({
        [BASE_URL]: profile.kind === 'gateway' ? (profile.baseUrl ?? '') : null,
      })
      setSettings(await service.read())
      setAuthStatus(await service.readAuthStatus())
    },
    [service],
  )

  const switchToChatgptLogin = useCallback(async () => {
    // Drop the API key so the ChatGPT tokens take over, and clear any custom
    // endpoint a gateway profile left in config.toml.
    await service.setApiKey(null)
    await service.patch({ [BASE_URL]: null })
    setSettings(await service.read())
    setAuthStatus(await service.readAuthStatus())
  }, [service])

  return {
    settings,
    loaded,
    configPath,
    authStatus,
    profiles,
    patch,
    reload,
    reloadAuthStatus,
    saveProfile,
    deleteProfile,
    applyProfile,
    setApiKey,
    switchToChatgptLogin,
  }
}
