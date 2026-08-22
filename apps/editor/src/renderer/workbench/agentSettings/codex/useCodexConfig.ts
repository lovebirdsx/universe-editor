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
import {
  IAiModelService,
  INotificationService,
  IStorageService,
  Severity,
  StorageScope,
  localize,
} from '@universe-editor/platform'
import {
  ICodexConfigService,
  type CodexAuthStatus,
  type CodexCredentialDraft,
  type CodexCredentialIntent,
  type CodexCredentialProfile,
  type CodexSettings,
  type CodexSettingsPatch,
} from '../../../../shared/ipc/codexConfigService.js'
import {
  deriveCodexProvider,
  resolveProviderRef,
} from '../../../../shared/ai/providerDerivation.js'
import { useService } from '../../useService.js'
import { useRemoteAuthority } from '../../useRemoteAuthority.js'

export interface UseCodexConfig {
  readonly settings: CodexSettings
  readonly loaded: boolean
  readonly configPath: string
  /** Remote-ssh authority when the workspace folder is remote; undefined for local. */
  readonly authority: string | undefined
  readonly authStatus: CodexAuthStatus
  readonly profiles: readonly CodexCredentialProfile[]
  /** Id of the saved profile matching the credential currently in effect. */
  readonly activeProfileId: string | undefined
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
  const ai = useService<IAiModelService>(IAiModelService)
  const notification = useService(INotificationService)
  const storage = useService(IStorageService)
  // Remote workspace: configure the remote `~/.codex`; local leaves authority
  // undefined so main routes to the local store.
  const authority = useRemoteAuthority()
  const [settings, setSettings] = useState<CodexSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [authStatus, setAuthStatus] = useState<CodexAuthStatus>(LOGGED_OUT)
  const [profiles, setProfiles] = useState<readonly CodexCredentialProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>()
  const [credentialDraft, setCredentialDraft] = useState<CodexCredentialDraft | undefined>()
  const draftWrite = useRef<Promise<void>>(Promise.resolve())

  const loadAll = useCallback(async () => {
    const [next, path, status, library, activeId, draft] = await Promise.all([
      service.read(authority),
      service.configPath(authority),
      service.readAuthStatus(authority),
      service.readProfiles(),
      service.matchActiveProfile(authority),
      storage.get<CodexCredentialDraft>(CREDENTIAL_DRAFT_KEY, StorageScope.GLOBAL),
    ])
    setSettings(next)
    setConfigPath(path)
    setAuthStatus(status)
    setProfiles(library)
    setActiveProfileId(activeId)
    setCredentialDraft(draft)
    setLoaded(true)
  }, [service, storage, authority])

  const reload = useCallback(() => loadAll(), [loadAll])

  const reloadAuthStatus = useCallback(async () => {
    const status = await service.readAuthStatus(authority)
    setAuthStatus(status)
    return status
  }, [service, authority])

  useEffect(() => {
    let active = true
    void (async () => {
      const [next, path, status, library, activeId, draft] = await Promise.all([
        service.read(authority),
        service.configPath(authority),
        service.readAuthStatus(authority),
        service.readProfiles(),
        service.matchActiveProfile(authority),
        storage.get<CodexCredentialDraft>(CREDENTIAL_DRAFT_KEY, StorageScope.GLOBAL),
      ])
      if (!active) return
      setSettings(next)
      setConfigPath(path)
      setAuthStatus(status)
      setProfiles(library)
      setActiveProfileId(activeId)
      setCredentialDraft(draft)
      setLoaded(true)
    })()
    // Refresh login status live when auth.json changes on disk (e.g. once the
    // browser OAuth flow from `codex login` completes), so no manual refresh is
    // needed. The active-profile match depends on auth.json too.
    const sub = service.onDidChangeAuth(() => {
      void (async () => {
        const [status, activeId] = await Promise.all([
          service.readAuthStatus(authority),
          service.matchActiveProfile(authority),
        ])
        if (!active) return
        setAuthStatus(status)
        setActiveProfileId(activeId)
      })()
    })
    return () => {
      active = false
      sub.dispose()
    }
  }, [service, storage, authority])

  const patch = useCallback(
    async (p: CodexSettingsPatch) => {
      await service.patch(p, authority)
      setSettings(await service.read(authority))
    },
    [service, authority],
  )

  const applyProfile = useCallback(
    async (profile: CodexCredentialProfile) => {
      // One atomic main-process step keeps auth.json + config.toml consistent.
      let intent: CodexCredentialIntent
      if (profile.kind === 'gateway') {
        const ref = profile.providerRef
        const [providers, types] = await Promise.all([ai.getProviders(), ai.getProviderTypes()])
        const resolved = ref !== undefined ? resolveProviderRef(ref, providers, types) : undefined
        const derived =
          resolved !== undefined ? deriveCodexProvider(resolved.instance, resolved.type) : undefined
        if (derived === undefined) {
          notification.notify({
            severity: Severity.Error,
            message: localize(
              'codexSettings.auth.applyGatewayError',
              'This gateway credential could not be applied — its provider is missing a base URL or API key.',
            ),
          })
          return
        }
        intent = { kind: 'gateway', ...derived }
      } else {
        intent = { kind: 'apiKey', apiKey: profile.apiKey ?? '' }
      }
      const status = await service.applyCredential(intent, authority)
      setSettings(await service.read(authority))
      setAuthStatus(status)
      setActiveProfileId(await service.matchActiveProfile(authority))
    },
    [service, authority, ai, notification],
  )

  const saveProfile = useCallback(
    async (profile: CodexCredentialProfile) => {
      const current = await service.readProfiles()
      const idx = current.findIndex((p) => p.id === profile.id)
      const next =
        idx >= 0 ? current.map((p) => (p.id === profile.id ? profile : p)) : [...current, profile]
      // Read the active match before writing the edit: afterwards the edited
      // profile no longer matches the on-disk credential until it is re-applied.
      const wasActive = (await service.matchActiveProfile(authority)) === profile.id
      await service.writeProfiles(next)
      setProfiles(next)
      // Editing the in-use profile (e.g. rotating its key) must push the new
      // key into auth.json / config.toml too, or the agent keeps using the old
      // credential until the profile is switched away and back.
      if (wasActive) {
        await applyProfile(profile)
        return
      }
      // Editing a profile may make another one stop / start matching.
      setActiveProfileId(await service.matchActiveProfile(authority))
    },
    [service, applyProfile, authority],
  )

  const deleteProfile = useCallback(
    async (id: string) => {
      const current = await service.readProfiles()
      const next = current.filter((p) => p.id !== id)
      await service.writeProfiles(next)
      setProfiles(next)
      setActiveProfileId(await service.matchActiveProfile(authority))
    },
    [service, authority],
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

  const switchToChatgptLogin = useCallback(async () => {
    // Clear the API key + gateway provider so the ChatGPT tokens take over.
    const status = await service.applyCredential({ kind: 'chatgpt' }, authority)
    setSettings(await service.read(authority))
    setAuthStatus(status)
    setActiveProfileId(await service.matchActiveProfile(authority))
  }, [service, authority])

  return {
    settings,
    loaded,
    configPath,
    authority,
    authStatus,
    profiles,
    activeProfileId,
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
