/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React hook over IClaudeConfigService: loads `~/.claude/settings.json` once,
 *  exposes the live value, and offers a `patch` that writes through to disk and
 *  refreshes local state. All panels in the Agent settings editor share this so
 *  edits stay consistent with the on-disk file the agent + CLI also read.
 *
 *  Two stores, one direction each:
 *   - `settings.json` — the effective config the agent reads, and the ONLY home of
 *     the model picks. `setModel` / `setSubagentModel` (+ their `1m` variants)
 *     write the composed id straight there, and the panel reads it back from
 *     `settings.model` / `subagentModelEnv`. Nothing is mirrored, so the UI cannot
 *     disagree with what the process runs.
 *   - `aiSettings.json`'s `agentSettings.claude` — the credential selection only.
 *     `applyAuthentication` persists it and writes the matching credential env.
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
import { stripOneM, withOneM } from '../../../services/acp/modelOneM.js'
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
  /** Effective `env.CLAUDE_CODE_SUBAGENT_MODEL`, the sub-agent model in effect. */
  readonly subagentModelEnv: string | undefined
  patch(patch: ClaudeSettingsPatch): Promise<void>
  reload(): Promise<void>
  reloadAuthStatus(): Promise<ClaudeAuthStatus>
  /** Persist the provider/`@subscription` selection and inject/clear the matching env. */
  applyAuthentication(authentication: string | undefined): Promise<void>
  /** Write `settings.model` verbatim (undefined/empty clears it). */
  setModel(model: string | undefined): Promise<void>
  /** Add/remove the `[1m]` lane on the current `settings.model`. */
  setModelOneM(enabled: boolean): Promise<void>
  /** Write `env.CLAUDE_CODE_SUBAGENT_MODEL` verbatim (undefined/empty clears it). */
  setSubagentModel(model: string | undefined): Promise<void>
  /** Add/remove the `[1m]` lane on the current sub-agent model env. */
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

  // Every writer here is a read-modify-write across an IPC round-trip, so two
  // controls changed in quick succession would both read the same pre-write
  // state and the later write would clobber the earlier one (toggle `1m` right
  // after picking a model → the pick is composed against the old id).
  // Serializing the whole section is the fix.
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
   * Write one model pick into settings.json. `resolve` receives the id as it
   * currently stands ON DISK — read inside the write queue, not from React
   * state — so a lane toggle can never compose against a value that another
   * writer, another panel instance, or an external edit already superseded.
   */
  const applyModelPick = useCallback(
    (which: 'model' | 'subagentModel', resolve: (current: string) => string) =>
      serialize(async () => {
        const onDisk = await service.read(authority)
        const current =
          which === 'model' ? onDisk.model : (onDisk.env?.[SUBAGENT_MODEL] as string | undefined)
        const next = resolve(current ?? '').trim()
        const effective = next === '' ? null : next
        // Patch only the one key this pick owns — the credential env the
        // authentication choice injected, and every other key, stay untouched.
        if (which === 'model') {
          await patch({ model: effective })
        } else {
          await patch({ env: { [SUBAGENT_MODEL]: effective } })
        }
      }),
    [serialize, service, authority, patch],
  )

  const setModel = useCallback(
    (model: string | undefined) => applyModelPick('model', () => model ?? ''),
    [applyModelPick],
  )

  const setModelOneM = useCallback(
    (enabled: boolean) =>
      applyModelPick('model', (current) => withOneM(stripOneM(current), enabled)),
    [applyModelPick],
  )

  const setSubagentModel = useCallback(
    (model: string | undefined) => applyModelPick('subagentModel', () => model ?? ''),
    [applyModelPick],
  )

  const setSubagentModelOneM = useCallback(
    (enabled: boolean) =>
      applyModelPick('subagentModel', (current) => withOneM(stripOneM(current), enabled)),
    [applyModelPick],
  )

  const subagentModelEnv = settings.env?.[SUBAGENT_MODEL]

  return {
    settings,
    loaded,
    configPath,
    authority,
    authStatus,
    agentSettings,
    subagentModelEnv,
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
