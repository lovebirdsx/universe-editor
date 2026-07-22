/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over IClaudeConfigService: loads `~/.claude/settings.json` once,
 *  exposes the live value, and offers a `patch` that writes through to disk and
 *  refreshes local state. All panels in the Agent settings editor share this so
 *  edits stay consistent with the on-disk file the agent + CLI also read.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import {
  IClaudeConfigService,
  type ClaudeAuthStatus,
  type ClaudeCredentialProfile,
  type ClaudeSettings,
  type ClaudeSettingsPatch,
} from '../../../../shared/ipc/claudeConfigService.js'
import { useService } from '../../useService.js'

export interface UseClaudeConfig {
  readonly settings: ClaudeSettings
  readonly loaded: boolean
  readonly configPath: string
  readonly authStatus: ClaudeAuthStatus
  readonly profiles: readonly ClaudeCredentialProfile[]
  patch(patch: ClaudeSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<ClaudeAuthStatus>
  /** Insert or update a profile by id, persisting the whole library. */
  saveProfile(profile: ClaudeCredentialProfile): Promise<void>
  deleteProfile(id: string): Promise<void>
  /** Write a profile's credentials into settings.json as the active auth. */
  applyProfile(profile: ClaudeCredentialProfile): Promise<void>
}

const LOGGED_OUT: ClaudeAuthStatus = { loggedIn: false, expired: false }

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'
const SMALL_FAST_MODEL = 'ANTHROPIC_SMALL_FAST_MODEL'

export function useClaudeConfig(): UseClaudeConfig {
  const service = useService<IClaudeConfigService>(IClaudeConfigService)
  const [settings, setSettings] = useState<ClaudeSettings>({})
  const [loaded, setLoaded] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [authStatus, setAuthStatus] = useState<ClaudeAuthStatus>(LOGGED_OUT)
  const [profiles, setProfiles] = useState<readonly ClaudeCredentialProfile[]>([])

  const reload = useCallback(async () => {
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
    return () => {
      active = false
    }
  }, [service])

  const patch = useCallback(
    async (p: ClaudeSettingsPatch) => {
      await service.patch(p)
      const next = await service.read()
      setSettings(next)
    },
    [service],
  )

  const saveProfile = useCallback(
    async (profile: ClaudeCredentialProfile) => {
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
      // gateway: inject token + url, plus the bundled model preset when present.
      // A blank model field means "don't touch the current model" (null skips it).
      const model = profile.model?.trim() ? profile.model.trim() : undefined
      await patch({
        ...(model !== undefined ? { model } : {}),
        env: {
          [AUTH_TOKEN]: profile.authToken ?? '',
          [BASE_URL]: profile.baseUrl ?? '',
          [API_KEY]: null,
          [SMALL_FAST_MODEL]: profile.smallFastModel?.trim() ? profile.smallFastModel.trim() : null,
        },
      })
    },
    [patch],
  )

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
  }
}
