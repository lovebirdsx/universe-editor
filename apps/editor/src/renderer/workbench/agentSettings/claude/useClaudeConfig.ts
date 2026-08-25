/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over IClaudeConfigService: loads `~/.claude/settings.json` once,
 *  exposes the live value, and offers a `patch` that writes through to disk and
 *  refreshes local state. All panels in the Agent settings editor share this so
 *  edits stay consistent with the on-disk file the agent + CLI also read.
 *
 *  The editor's own selection (which provider / `@subscription` to inject, plus
 *  the model / sub-agent model picks and their `[1m]` toggles) lives in
 *  aiSettings.json's `agentSettings.claude` block — this hook bridges the two:
 *  `applyAuthentication` both persists the selection and writes the matching
 *  credential env, `setModel` / `setSubagentModel` (and their `1m` variants)
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
import { hasOneM, withOneM } from '../../../services/acp/modelOneM.js'
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
  /** Persist the model pick and write the composed `settings.model` (undefined clears it). */
  setModel(model: string | undefined): Promise<void>
  /** Toggle the `[1m]` lane for the model pick and rewrite `settings.model`. */
  setModelOneM(enabled: boolean): Promise<void>
  /** Persist the sub-agent model pick and write `env.CLAUDE_CODE_SUBAGENT_MODEL`. */
  setSubagentModel(model: string | undefined): Promise<void>
  /** Toggle the `[1m]` lane for the sub-agent model pick. */
  setSubagentModelOneM(enabled: boolean): Promise<void>
}

const LOGGED_OUT: ClaudeAuthStatus = { loggedIn: false, expired: false }

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'
const SUBAGENT_MODEL = 'CLAUDE_CODE_SUBAGENT_MODEL'

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

  // Every writer snapshots `agentSettingsRef`, then awaits an IPC round-trip
  // before the ref catches up — and the block is persisted wholesale. Two
  // controls changed in quick succession would therefore both start from the
  // same stale snapshot, and the later write would silently drop the earlier
  // one's field (pick a provider, immediately pick a model → authentication
  // gone). Serializing the whole read-modify-write section is the fix.
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const serialize = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const run = writeQueue.current.then(task, task)
    writeQueue.current = run.catch(() => undefined)
    return run
  }, [])

  const resolveProviders = useCallback(async (): Promise<readonly AiResolvedProvider[]> => {
    const [entries, knowledge] = await Promise.all([ai.getProviders(), ai.getModelKnowledge()])
    return resolveProviderEntries(entries, knowledge).providers
  }, [ai])

  const applyAuthentication = useCallback(
    (authentication: string | undefined) =>
      serialize(async () => {
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
      }),
    [serialize, writeAgentSettings, patch, resolveProviders, notification],
  )

  /**
   * Persist one model pick. `resolve` runs inside the write queue, against the
   * settled state, so a setter that carries a value over from the current pick
   * (the `1m` flag, the bare id) never reads a snapshot another write is about
   * to replace.
   */
  const applyModelPick = useCallback(
    (
      which: 'model' | 'subagentModel',
      resolve: (current: ClaudeAgentSettings) => { bare: string | undefined; oneM: boolean },
    ) =>
      serialize(async () => {
        const current = agentSettingsRef.current
        const { bare, oneM } = resolve(current)
        const next: ClaudeAgentSettings = { ...current }
        const flagKey = which === 'model' ? 'model1m' : 'subagentModel1m'
        if (bare) {
          next[which] = bare
          if (oneM) next[flagKey] = true
          else delete next[flagKey]
        } else {
          delete next[which]
          delete next[flagKey]
        }
        await writeAgentSettings(next)

        const effective = bare ? withOneM(bare, oneM) : null
        // Patch only the one key this pick owns — the credential env the
        // authentication choice injected, and every other key, stay untouched.
        if (which === 'model') {
          await patch({ model: effective })
        } else {
          await patch({ env: { [SUBAGENT_MODEL]: effective } })
        }
      }),
    [serialize, writeAgentSettings, patch],
  )

  const setModel = useCallback(
    (model: string | undefined) =>
      applyModelPick('model', (current) => ({
        bare: model,
        // An id that already carries `[1m]` hides the checkbox, so a flag left
        // over from the previous pick must not silently re-append it later.
        oneM: !!model && !hasOneM(model) && current.model1m === true,
      })),
    [applyModelPick],
  )

  const setModelOneM = useCallback(
    (enabled: boolean) =>
      applyModelPick('model', (current) => ({ bare: current.model, oneM: enabled })),
    [applyModelPick],
  )

  const setSubagentModel = useCallback(
    (model: string | undefined) =>
      applyModelPick('subagentModel', (current) => ({
        bare: model,
        oneM: !!model && !hasOneM(model) && current.subagentModel1m === true,
      })),
    [applyModelPick],
  )

  const setSubagentModelOneM = useCallback(
    (enabled: boolean) =>
      applyModelPick('subagentModel', (current) => ({
        bare: current.subagentModel,
        oneM: enabled,
      })),
    [applyModelPick],
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
    setModelOneM,
    setSubagentModel,
    setSubagentModelOneM,
  }
}
