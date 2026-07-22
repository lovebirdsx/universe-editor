/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over ICodexConfigService: loads `~/.codex/config.toml` + auth status
 *  once, exposes the live value, and offers a `patch` that writes through to disk
 *  and refreshes local state. All panels in the Codex settings share this so edits
 *  stay consistent with the on-disk files the agent + CLI also read.
 *
 *  Codex splits credentials (auth.json) from settings (config.toml). Switching
 *  credentials goes through `applyCredential`, one atomic main-process step that
 *  keeps both files consistent across the three login modes (gateway / API key /
 *  ChatGPT).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { IStorageService, StorageScope } from '@universe-editor/platform'
import {
  ICodexConfigService,
  type CodexAuthStatus,
  type CodexCredentialDraft,
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
  readonly credentialDraft: CodexCredentialDraft | undefined
  patch(patch: CodexSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<CodexAuthStatus>
  /** Insert or update a profile by id, persisting the whole library. */
  saveProfile(profile: CodexCredentialProfile): Promise<void>
  deleteProfile(id: string): Promise<void>
  saveCredentialDraft(draft: CodexCredentialDraft | undefined): Promise<void>
  /** Make a profile the active credential (atomic auth.json + config.toml). */
  applyProfile(profile: CodexCredentialProfile): Promise<void>
  /**
   * Hand control to the ChatGPT login: clears any API key + gateway provider so
   * the built-in `openai` provider runs on the ChatGPT OAuth tokens.
   */
  switchToChatgptLogin(): Promise<void>
}

const LOGGED_OUT: CodexAuthStatus = { active: 'none', hasApiKey: false }

// The unfinished Authentication form is UI state, not configuration — it lives
// in global storage rather than aiSettings.json.
const CREDENTIAL_DRAFT_KEY = 'agentSettings.codex.credentialDraft'

export function useCodexConfig(): UseCodexConfig {
  const service = useService<ICodexConfigService>(ICodexConfigService)
  const storage = useService(IStorageService)
  const [settings, setSettings] = useState<CodexSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [authStatus, setAuthStatus] = useState<CodexAuthStatus>(LOGGED_OUT)
  const [profiles, setProfiles] = useState<readonly CodexCredentialProfile[]>([])
  const [credentialDraft, setCredentialDraft] = useState<CodexCredentialDraft | undefined>()
  const draftWrite = useRef<Promise<void>>(Promise.resolve())

  const loadAll = useCallback(async () => {
    const [next, path, status, library, draft] = await Promise.all([
      service.read(),
      service.configPath(),
      service.readAuthStatus(),
      service.readProfiles(),
      storage.get<CodexCredentialDraft>(CREDENTIAL_DRAFT_KEY, StorageScope.GLOBAL),
    ])
    setSettings(next)
    setConfigPath(path)
    setAuthStatus(status)
    setProfiles(library)
    setCredentialDraft(draft)
    setLoaded(true)
  }, [service, storage])

  const reload = useCallback(() => loadAll(), [loadAll])

  const reloadAuthStatus = useCallback(async () => {
    const status = await service.readAuthStatus()
    setAuthStatus(status)
    return status
  }, [service])

  useEffect(() => {
    let active = true
    void (async () => {
      const [next, path, status, library, draft] = await Promise.all([
        service.read(),
        service.configPath(),
        service.readAuthStatus(),
        service.readProfiles(),
        storage.get<CodexCredentialDraft>(CREDENTIAL_DRAFT_KEY, StorageScope.GLOBAL),
      ])
      if (!active) return
      setSettings(next)
      setConfigPath(path)
      setAuthStatus(status)
      setProfiles(library)
      setCredentialDraft(draft)
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
  }, [service, storage])

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

  const saveCredentialDraft = useCallback(
    (draft: CodexCredentialDraft | undefined) => {
      setCredentialDraft(draft)
      const write = draftWrite.current
        .catch(() => undefined)
        .then(async () => {
          if (draft === undefined) await storage.remove(CREDENTIAL_DRAFT_KEY, StorageScope.GLOBAL)
          else await storage.set(CREDENTIAL_DRAFT_KEY, draft, StorageScope.GLOBAL)
        })
      draftWrite.current = write
      return write
    },
    [storage],
  )

  const applyProfile = useCallback(
    async (profile: CodexCredentialProfile) => {
      // One atomic main-process step keeps auth.json + config.toml consistent.
      const status =
        profile.kind === 'gateway'
          ? await service.applyCredential({
              kind: 'gateway',
              baseUrl: profile.baseUrl ?? '',
              apiKey: profile.apiKey ?? '',
              providerName: profile.label,
            })
          : await service.applyCredential({ kind: 'apiKey', apiKey: profile.apiKey ?? '' })
      setSettings(await service.read())
      setAuthStatus(status)
    },
    [service],
  )

  const switchToChatgptLogin = useCallback(async () => {
    // Clear the API key + gateway provider so the ChatGPT tokens take over.
    const status = await service.applyCredential({ kind: 'chatgpt' })
    setSettings(await service.read())
    setAuthStatus(status)
  }, [service])

  return {
    settings,
    loaded,
    configPath,
    authStatus,
    profiles,
    credentialDraft,
    patch,
    reload,
    reloadAuthStatus,
    saveProfile,
    deleteProfile,
    saveCredentialDraft,
    applyProfile,
    switchToChatgptLogin,
  }
}
