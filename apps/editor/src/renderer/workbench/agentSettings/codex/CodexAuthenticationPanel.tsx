/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexAuthenticationPanel — the "Authentication" category. Two parts:
 *
 *   1. Authentication — the single selection that decides which credential the
 *      agent uses: a provider entry (a self-contained `[model_providers.codex-gateway]`
 *      block + `model_provider = "codex-gateway"`), or `@subscription` (the shared
 *      ChatGPT login via auth.json). The model pick is structured from the
 *      selected provider's candidates.
 *
 *   2. Log in with ChatGPT — the single shared OAuth login (`codex login`, run via
 *      the official Codex CLI), stored in `~/.codex/auth.json`. Shows live status.
 *
 *  `activeAuth.drift` (from `resolveActiveAuth`) surfaces when the on-disk files
 *  no longer match the declared selection — e.g. the user hand-edited config.toml.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert } from 'lucide-react'
import {
  INotificationService,
  Severity,
  localize,
  type AiResolvedProvider,
} from '@universe-editor/platform'
import { Button, Input, Select } from '@universe-editor/workbench-ui'
import { useService } from '../../useService.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../shared/ipc/claudeConfigService.js'
import { deriveCodexGateway } from '../../../../shared/ai/providerDerivation.js'
import { maskKey } from '../../../../shared/ai/maskKey.js'
import type { UseCodexConfig } from './useCodexConfig.js'
import { runCodexLogin } from './codexLogin.js'
import { ConfigFileLink, getSiblingConfigPath } from '../ConfigFileLink.js'
import { useProviderRegistry } from '../useProviderRegistry.js'
import {
  DerivationError,
  GatewayProviderPicker,
  missingProviderPiece,
} from '../GatewayProviderPicker.js'
import styles from '../AgentSettingsEditor.module.css'

const CODEX_PROTOCOL = 'openai-responses' as const

/** Model candidates a resolved provider declares under the agent's protocol. */
function candidateModels(provider: AiResolvedProvider | undefined): readonly string[] {
  const p = provider?.protocols.find((pr) => pr.protocol === CODEX_PROTOCOL)
  if (p === undefined || p.discover || p.models.length === 0) return []
  return p.models.map((m) => m.channelModel)
}

export function CodexAuthenticationPanel({ config }: { config: UseCodexConfig }) {
  const { configPath, authority } = config
  const authPath = configPath ? getSiblingConfigPath(configPath, 'auth.json') : undefined

  return (
    <div className={styles['panel']}>
      <AuthenticationSection config={config} />

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>
          {localize('codexSettings.auth.login', 'Log in with ChatGPT')}
        </h2>
        <LoginForm config={config} />
      </section>

      {configPath && authPath && (
        <div className={styles['pathHint']}>
          {localize('codexSettings.auth.path.settingsPrefix', 'Settings in')}{' '}
          <ConfigFileLink path={configPath} {...(authority !== undefined ? { authority } : {})} />
          {localize('codexSettings.auth.path.credentialsPrefix', '; credentials in')}{' '}
          <ConfigFileLink
            path={authPath}
            label="auth.json"
            {...(authority !== undefined ? { authority } : {})}
          />
        </div>
      )}
    </div>
  )
}

function AuthenticationSection({ config }: { config: UseCodexConfig }) {
  const { agentSettings, activeAuth, applyAuthentication, setModel } = config
  const { providers } = useProviderRegistry()
  const authentication = agentSettings.authentication

  const resolved = useMemo(
    () =>
      authentication && authentication !== AGENT_SUBSCRIPTION_AUTH
        ? providers.find((p) => p.id === authentication)
        : undefined,
    [authentication, providers],
  )
  const candidates = useMemo(() => candidateModels(resolved), [resolved])
  const currentModel = agentSettings.model
  const modelOptions = useMemo(
    () =>
      currentModel && !candidates.includes(currentModel)
        ? [currentModel, ...candidates]
        : candidates,
    [candidates, currentModel],
  )

  const onAuthChange = useCallback(
    async (value: string) => {
      const next = value === '' ? undefined : value
      await applyAuthentication(next)
      if (next && next !== AGENT_SUBSCRIPTION_AUTH) {
        const nextCandidates = candidateModels(providers.find((p) => p.id === next))
        if (currentModel && !nextCandidates.includes(currentModel)) await setModel(undefined)
      }
    },
    [applyAuthentication, setModel, providers, currentModel],
  )

  return (
    <section className={styles['section']}>
      <h2 className={styles['sectionTitle']}>
        {localize('codexSettings.auth.title', 'Authentication')}
      </h2>

      <div className={styles['field']}>
        <label className={styles['label']}>
          {localize('codexSettings.auth.form.provider', 'Provider')}
        </label>
        <GatewayProviderPicker
          providers={providers}
          protocol={CODEX_PROTOCOL}
          value={authentication ?? ''}
          onChange={(value) => void onAuthChange(value)}
          subscriptionLabel={localize(
            'codexSettings.auth.subscription',
            'Use ChatGPT subscription login',
          )}
        >
          {(selected) =>
            selected === undefined ? (
              <div className={styles['desc']}>
                {localize(
                  'codexSettings.auth.subscription.desc',
                  'Uses the shared ChatGPT login below — the built-in openai provider runs on the OAuth tokens.',
                )}
              </div>
            ) : (
              <>
                <CodexDerivationPreview resolved={selected} />
                <div className={styles['field']}>
                  <label className={styles['label']}>
                    {localize('codexSettings.auth.form.model', 'Model')}
                  </label>
                  {modelOptions.length > 0 ? (
                    <Select
                      value={currentModel ?? ''}
                      options={[
                        {
                          value: '',
                          label: localize('codexSettings.auth.form.model.none', 'Use default'),
                        },
                        ...modelOptions.map((m) => ({ value: m, label: m })),
                      ]}
                      onChange={(v) => void setModel(v || undefined)}
                    />
                  ) : (
                    <Input
                      value={currentModel ?? ''}
                      placeholder="gpt-5.5"
                      onChange={(e) => void setModel(e.target.value || undefined)}
                    />
                  )}
                </div>
              </>
            )
          }
        </GatewayProviderPicker>
      </div>

      {activeAuth.drift && (
        <div className={styles['deriveError']}>
          {localize(
            'codexSettings.auth.drift',
            'The on-disk config.toml / auth.json no longer matches this selection (it may have been changed externally). Re-select it to re-apply the credential.',
          )}
        </div>
      )}
    </section>
  )
}

function CodexDerivationPreview({ resolved }: { readonly resolved: AiResolvedProvider }) {
  const missing = missingProviderPiece(resolved, CODEX_PROTOCOL)
  if (missing !== undefined) return <DerivationError missing={missing} />
  const derived = deriveCodexGateway(resolved)
  if (derived === undefined) return null
  return (
    <div className={styles['derivePreview']} data-testid="derivePreview">
      <div className={styles['deriveRow']}>
        <span className={styles['deriveKey']}>name</span>
        <span className={styles['deriveValue']}>{derived.providerName}</span>
      </div>
      <div className={styles['deriveRow']}>
        <span className={styles['deriveKey']}>base_url</span>
        <span className={styles['deriveValue']}>{derived.baseUrl}</span>
      </div>
      <div className={styles['deriveRow']}>
        <span className={styles['deriveKey']}>experimental_bearer_token</span>
        <span className={styles['deriveValue']}>{maskKey(derived.apiKey)}</span>
      </div>
    </div>
  )
}

function LoginForm({ config }: { config: UseCodexConfig }) {
  const notification = useService(INotificationService)
  const login = runCodexLogin()
  const { authStatus, activeAuth, reloadAuthStatus, applyAuthentication } = config
  const chatgpt = authStatus.chatgpt
  const signedIn = !!chatgpt && !chatgpt.expired
  // ChatGPT is actually in effect only when resolveActiveAuth reports the
  // subscription kind (a gateway provider overrides it even while signed in).
  const chatgptActive = activeAuth.kind === 'subscription'
  const overridden = signedIn && !chatgptActive
  const [refreshing, setRefreshing] = useState(false)

  const doRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const status = await reloadAuthStatus()
      const cg = status.chatgpt
      const message =
        cg && !cg.expired
          ? cg.planType
            ? localize('codexSettings.auth.login.signedInPlan', 'Signed in ({plan})', {
                plan: cg.planType,
              })
            : localize('codexSettings.auth.login.signedIn', 'Signed in')
          : cg?.expired
            ? localize('codexSettings.auth.login.expired', 'Login expired — please sign in again.')
            : localize('codexSettings.auth.login.signedOut', 'Not signed in')
      notification.notify({ severity: Severity.Info, message })
    } finally {
      setRefreshing(false)
    }
  }, [reloadAuthStatus, notification])

  const doLogin = useCallback(async () => {
    await login()
    // The login runs in a terminal and rewrites ~/.codex/auth.json with a
    // ChatGPT token block. Once a fresh login takes effect, switch the selection
    // to it so it is actually used instead of a lingering gateway provider.
    setTimeout(() => {
      void (async () => {
        const status = await reloadAuthStatus()
        if (status.chatgpt && !status.chatgpt.expired) {
          await applyAuthentication(AGENT_SUBSCRIPTION_AUTH)
        }
      })()
    }, 4000)
  }, [login, reloadAuthStatus, applyAuthentication])

  const setAsCurrent = useCallback(async () => {
    await applyAuthentication(AGENT_SUBSCRIPTION_AUTH)
    notification.notify({
      severity: Severity.Info,
      message: localize('codexSettings.auth.login.activated', 'Now using your ChatGPT login.'),
    })
  }, [applyAuthentication, notification])

  return (
    <div className={styles['authForm']}>
      <div className={styles['statusRow']}>
        {signedIn && (
          <span className={styles['statusOk']}>
            <CheckCircle2 size={14} strokeWidth={2} />
            {chatgpt?.planType
              ? localize('codexSettings.auth.login.signedInPlan', 'Signed in ({plan})', {
                  plan: chatgpt.planType,
                })
              : localize('codexSettings.auth.login.signedIn', 'Signed in')}
          </span>
        )}
        {chatgpt?.expired && (
          <span className={styles['statusWarn']}>
            <CircleAlert size={14} strokeWidth={2} />
            {localize('codexSettings.auth.login.expired', 'Login expired — please sign in again.')}
          </span>
        )}
        {!chatgpt && (
          <span className={styles['statusMuted']}>
            {localize('codexSettings.auth.login.signedOut', 'Not signed in')}
          </span>
        )}
        {chatgptActive && (
          <span className={styles['activeBadge']}>
            {localize('codexSettings.auth.inUse', 'In use')}
          </span>
        )}
        <button
          type="button"
          className={styles['linkButton']}
          disabled={refreshing}
          onClick={() => void doRefresh()}
        >
          {refreshing
            ? localize('codexSettings.auth.login.refreshing', 'Refreshing…')
            : localize('codexSettings.auth.login.refresh', 'Refresh')}
        </button>
      </div>

      {overridden && (
        <div className={styles['desc']}>
          {localize(
            'codexSettings.auth.login.overridden',
            'You are signed in, but a provider credential is currently taking precedence.',
          )}
        </div>
      )}

      <div className={styles['desc']}>
        {localize(
          'codexSettings.auth.login.hint',
          'Opens a terminal and runs `codex login` (requires the official Codex CLI on your PATH). Follow the prompts, then start an agent session.',
        )}
      </div>
      <div className={styles['toolbar']}>
        <Button onClick={() => void doLogin()}>
          {localize('codexSettings.auth.login.start', 'Log in with ChatGPT')}
        </Button>
        {overridden && (
          <Button variant="ghost" onClick={() => void setAsCurrent()}>
            {localize('codexSettings.auth.login.setCurrent', 'Use this login')}
          </Button>
        )}
      </div>
    </div>
  )
}
