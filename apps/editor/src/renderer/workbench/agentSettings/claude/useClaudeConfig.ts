/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over IClaudeConfigService: loads `~/.claude/settings.json` once,
 *  exposes the live value, and offers a `patch` that writes through to disk and
 *  refreshes local state. All panels in the Agent settings editor share this so
 *  edits stay consistent with the on-disk file the agent + CLI also read.
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
  IClaudeConfigService,
  type ClaudeAuthStatus,
  type ClaudeCredentialDraft,
  type ClaudeCredentialProfile,
  type ClaudeSettings,
  type ClaudeSettingsPatch,
} from '../../../../shared/ipc/claudeConfigService.js'
import { deriveClaudeEnv, resolveProviderRef } from '../../../../shared/ai/providerDerivation.js'
import { useService } from '../../useService.js'
import { useRemoteAuthority } from '../../useRemoteAuthority.js'
import { isProfileActive } from './credentialMatch.js'

export interface UseClaudeConfig {
  readonly settings: ClaudeSettings
  readonly loaded: boolean
  readonly configPath: string
  /** Remote-ssh authority when the workspace folder is remote; undefined for local. */
  readonly authority: string | undefined
  readonly authStatus: ClaudeAuthStatus
  readonly profiles: readonly ClaudeCredentialProfile[]
  readonly credentialDraft: ClaudeCredentialDraft | undefined
  patch(patch: ClaudeSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<ClaudeAuthStatus>
  /** Insert or update a profile by id, persisting the whole library. */
  saveProfile(profile: ClaudeCredentialProfile): Promise<void>
  deleteProfile(id: string): Promise<void>
  saveCredentialDraft(draft: ClaudeCredentialDraft | undefined): Promise<void>
  /** Write a profile's credentials into settings.json as the active auth. */
  applyProfile(profile: ClaudeCredentialProfile): Promise<void>
}

const LOGGED_OUT: ClaudeAuthStatus = { loggedIn: false, expired: false }

// The unfinished Authentication form is UI state, not configuration — it lives
// in global storage rather than aiSettings.json.
const CREDENTIAL_DRAFT_KEY = 'agentSettings.claude.credentialDraft'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'
const SMALL_FAST_MODEL = 'ANTHROPIC_SMALL_FAST_MODEL'

export function useClaudeConfig(): UseClaudeConfig {
  const service = useService<IClaudeConfigService>(IClaudeConfigService)
  const ai = useService<IAiModelService>(IAiModelService)
  const notification = useService(INotificationService)
  const storage = useService(IStorageService)
  // Remote workspace: configure the remote `~/.claude`; local: leave authority
  // undefined so main routes to the local store.
  const authority = useRemoteAuthority()
  const [settings, setSettings] = useState<ClaudeSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [authStatus, setAuthStatus] = useState<ClaudeAuthStatus>(LOGGED_OUT)
  const [profiles, setProfiles] = useState<readonly ClaudeCredentialProfile[]>([])
  const [credentialDraft, setCredentialDraft] = useState<ClaudeCredentialDraft | undefined>()
  const draftWrite = useRef<Promise<void>>(Promise.resolve())

  const reload = useCallback(async () => {
    const [next, path, status, library, draft] = await Promise.all([
      service.read(authority),
      service.configPath(authority),
      service.readAuthStatus(authority),
      service.readProfiles(),
      storage.get<ClaudeCredentialDraft>(CREDENTIAL_DRAFT_KEY, StorageScope.GLOBAL),
    ])
    setSettings(next)
    setConfigPath(path)
    setAuthStatus(status)
    setProfiles(library)
    setCredentialDraft(draft)
    setLoaded(true)
  }, [service, storage, authority])

  const reloadAuthStatus = useCallback(async () => {
    const status = await service.readAuthStatus(authority)
    setAuthStatus(status)
    return status
  }, [service, authority])

  useEffect(() => {
    let active = true
    void (async () => {
      const [next, path, status, library, draft] = await Promise.all([
        service.read(authority),
        service.configPath(authority),
        service.readAuthStatus(authority),
        service.readProfiles(),
        storage.get<ClaudeCredentialDraft>(CREDENTIAL_DRAFT_KEY, StorageScope.GLOBAL),
      ])
      if (!active) return
      setSettings(next)
      setConfigPath(path)
      setAuthStatus(status)
      setProfiles(library)
      setCredentialDraft(draft)
      setLoaded(true)
    })()
    return () => {
      active = false
    }
  }, [service, storage, authority])

  const patch = useCallback(
    async (p: ClaudeSettingsPatch) => {
      await service.patch(p, authority)
      const next = await service.read(authority)
      setSettings(next)
    },
    [service, authority],
  )

  const applyProfile = useCallback(
    async (profile: ClaudeCredentialProfile) => {
      if (profile.kind === 'apiKey') {
        await patch({
          env: {
            [API_KEY]: profile.apiKey ?? '',
            [AUTH_TOKEN]: null,
            [BASE_URL]: null,
            [SMALL_FAST_MODEL]: null,
          },
        })
        return
      }
      // gateway: resolve the provider instance, then inject the derived token +
      // base URL (plus the bundled model preset when present). A blank model
      // field means "don't touch the current model" (null skips it).
      const ref = profile.providerRef
      const [providers, types] = await Promise.all([ai.getProviders(), ai.getProviderTypes()])
      const resolved = ref !== undefined ? resolveProviderRef(ref, providers, types) : undefined
      const derived =
        resolved !== undefined ? deriveClaudeEnv(resolved.instance, resolved.type) : undefined
      if (derived === undefined) {
        notification.notify({
          severity: Severity.Error,
          message: localize(
            'agentSettings.auth.applyGatewayError',
            'This gateway credential could not be applied — its provider is missing a base URL or API key.',
          ),
        })
        return
      }
      const model = profile.model?.trim() ? profile.model.trim() : undefined
      await patch({
        ...(model !== undefined ? { model } : {}),
        env: {
          [AUTH_TOKEN]: derived.authToken,
          [BASE_URL]: derived.baseUrl,
          [API_KEY]: null,
          [SMALL_FAST_MODEL]: profile.smallFastModel?.trim() ? profile.smallFastModel.trim() : null,
        },
      })
    },
    [patch, ai, notification],
  )

  const saveProfile = useCallback(
    async (profile: ClaudeCredentialProfile) => {
      const current = await service.readProfiles()
      const previous = current.find((p) => p.id === profile.id)
      const next =
        previous !== undefined
          ? current.map((p) => (p.id === profile.id ? profile : p))
          : [...current, profile]
      // Editing the in-use credential (e.g. rotating its key) must push the new
      // values into settings.json too, or the agent keeps using the old key
      // until the profile is switched away and back.
      const currentSettings = await service.read(authority)
      const [providers, types] = await Promise.all([ai.getProviders(), ai.getProviderTypes()])
      const wasActive =
        previous !== undefined &&
        isProfileActive(
          previous,
          currentSettings.env ?? {},
          currentSettings.model,
          providers,
          types,
        )
      await service.writeProfiles(next)
      setProfiles(next)
      if (wasActive) await applyProfile(profile)
    },
    [service, applyProfile, authority, ai],
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
    (draft: ClaudeCredentialDraft | undefined) => {
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

  return {
    settings,
    loaded,
    configPath,
    authority,
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
  }
}
