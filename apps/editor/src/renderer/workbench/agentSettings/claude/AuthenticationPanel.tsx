/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AuthenticationPanel — the "Authentication" category. Two parts:
 *
 *   1. Authentication — the picker mirrors which credential is actually in
 *      effect, reverse-looked up from disk (`activeAuth`): a provider entry
 *      (injected as `ANTHROPIC_API_KEY` for the official endpoint, or
 *      `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` for a gateway), or
 *      `@subscription` (the shared Claude OAuth login). The model / sub-agent
 *      model picks (each with an optional `[1m]` lane) are structured from the
 *      selected provider's candidates. A gateway credential that matches no
 *      provider entry is shown as an unattributed external credential.
 *
 *   2. Log in with Claude — the single shared OAuth login (`claude auth login`),
 *      stored in `~/.claude/.credentials.json`. Shows live status; "Use this
 *      login" switches the credential to `@subscription`.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert } from 'lucide-react'
import {
  INotificationService,
  Severity,
  localize,
  type AiResolvedProvider,
} from '@universe-editor/platform'
import { Button, Checkbox, Input, Select } from '@universe-editor/workbench-ui'
import { useService } from '../../useService.js'
import type { ClaudeAuthStatus } from '../../../../shared/ipc/claudeConfigService.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../shared/ipc/claudeConfigService.js'
import { deriveClaudeAuth } from '../../../../shared/ai/providerDerivation.js'
import { maskKey } from '../../../../shared/ai/maskKey.js'
import type { UseClaudeConfig } from './useClaudeConfig.js'
import { hasOneM } from '../../../services/acp/modelOneM.js'
import { runClaudeLogin } from './claudeLogin.js'
import { ConfigFileLink } from '../ConfigFileLink.js'
import { useProviderRegistry } from '../useProviderRegistry.js'
import {
  DerivationError,
  GatewayProviderPicker,
  missingProviderPiece,
} from '../GatewayProviderPicker.js'
import styles from '../AgentSettingsEditor.module.css'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

const CLAUDE_PROTOCOL = 'anthropic-messages' as const

/** Model candidates a resolved provider declares under the agent's protocol. */
function candidateModels(provider: AiResolvedProvider | undefined): readonly string[] {
  const p = provider?.protocols.find((pr) => pr.protocol === CLAUDE_PROTOCOL)
  if (p === undefined || p.discover || p.models.length === 0) return []
  return p.models.map((m) => m.channelModel)
}

/**
 * The option list for one row: the provider's candidates, with `current` pinned
 * on top when it isn't among them. The pinned entry covers both a value from a
 * provider the user has since switched away from and one whose `[1m]` lane the
 * candidate list spells differently — either way it is the id actually in effect
 * and must stay visible and selected.
 */
function pinCurrent(candidates: readonly string[], current: string): readonly string[] {
  if (current === '' || candidates.includes(current)) return candidates
  return [current, ...candidates]
}

export function AuthenticationPanel({ config }: { config: UseClaudeConfig }) {
  const { authStatus, configPath, authority, activeAuth } = config

  return (
    <div className={styles['panel']}>
      <AuthenticationSection config={config} />

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>
          {localize('agentSettings.auth.login', 'Log in with Claude')}
        </h2>
        <LoginForm
          authStatus={authStatus}
          authority={authority}
          isActive={activeAuth.kind === 'subscription'}
          onUseLogin={() => void config.applyAuthentication(AGENT_SUBSCRIPTION_AUTH)}
          reloadAuthStatus={config.reloadAuthStatus}
        />
      </section>

      {configPath && (
        <div className={styles['pathHint']}>
          {localize('agentSettings.auth.path.prefix', 'Active credential stored in')}{' '}
          <ConfigFileLink path={configPath} {...(authority !== undefined ? { authority } : {})} />
        </div>
      )}
    </div>
  )
}

function AuthenticationSection({ config }: { config: UseClaudeConfig }) {
  const {
    activeAuth,
    settings,
    subagentModelEnv,
    applyAuthentication,
    setModel,
    setModelOneM,
    setSubagentModel,
    setSubagentModelOneM,
  } = config
  const { providers } = useProviderRegistry()
  // The picker mirrors the credential actually in effect on disk — the entry it
  // matches, or the subscription login. A gateway credential matching no entry
  // is an external credential and stays unselected.
  const authentication = useMemo(
    () =>
      activeAuth.kind === 'provider' && activeAuth.providerId !== undefined
        ? activeAuth.providerId
        : activeAuth.kind === 'subscription'
          ? AGENT_SUBSCRIPTION_AUTH
          : undefined,
    [activeAuth],
  )
  const external = activeAuth.kind === 'provider' && activeAuth.providerId === undefined

  const resolved = useMemo(
    () =>
      authentication && authentication !== AGENT_SUBSCRIPTION_AUTH
        ? providers.find((p) => p.id === authentication)
        : undefined,
    [authentication, providers],
  )
  const candidates = useMemo(() => candidateModels(resolved), [resolved])
  // The rows show the EFFECTIVE ids from settings.json — the exact strings the
  // agent reads. There is no separate stored pick to disagree with them.
  const currentModel = settings.model ?? ''
  const currentSubagent = subagentModelEnv ?? ''
  // A value the provider no longer offers must still be visible as an option,
  // not vanish while it is the one actually in effect.
  const modelOptions = useMemo(
    () => pinCurrent(candidates, currentModel),
    [candidates, currentModel],
  )
  const subagentOptions = useMemo(
    () => pinCurrent(candidates, currentSubagent),
    [candidates, currentSubagent],
  )

  const onAuthChange = useCallback(
    (value: string) => {
      void applyAuthentication(value === '' ? undefined : value)
    },
    [applyAuthentication],
  )

  return (
    <section className={styles['section']}>
      <h2 className={styles['sectionTitle']}>
        {localize('agentSettings.auth.title', 'Authentication')}
      </h2>

      <div className={styles['field']}>
        <label className={styles['label']}>
          {localize('agentSettings.auth.form.provider', 'Provider')}
        </label>
        <GatewayProviderPicker
          providers={providers}
          protocol={CLAUDE_PROTOCOL}
          value={authentication ?? ''}
          onChange={(value) => void onAuthChange(value)}
          subscriptionLabel={localize(
            'agentSettings.auth.subscription',
            'Use Claude subscription login',
          )}
        >
          {(selected) =>
            selected === undefined ? (
              authentication === AGENT_SUBSCRIPTION_AUTH ? (
                <div className={styles['desc']}>
                  {localize(
                    'agentSettings.auth.subscription.desc',
                    'Uses the shared Claude OAuth login below — no credential env is written.',
                  )}
                </div>
              ) : external ? null : (
                <div className={styles['desc']}>
                  {localize(
                    'agentSettings.auth.none.desc',
                    'No provider selected — the Claude OAuth login (below) is used when available.',
                  )}
                </div>
              )
            ) : (
              <>
                <ClaudeDerivationPreview resolved={selected} />
                <ModelPicks
                  model={currentModel}
                  subagent={currentSubagent}
                  modelOptions={modelOptions}
                  subagentOptions={subagentOptions}
                  onModel={(m) => void setModel(m || undefined)}
                  onModelOneM={(v) => void setModelOneM(v)}
                  onSubagent={(m) => void setSubagentModel(m || undefined)}
                  onSubagentOneM={(v) => void setSubagentModelOneM(v)}
                />
              </>
            )
          }
        </GatewayProviderPicker>
      </div>

      {external && (
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.externalCredential',
            'A credential configured outside the editor is currently in effect, so its cost cannot be attributed.',
          )}
        </div>
      )}
    </section>
  )
}

function ModelPicks({
  model,
  subagent,
  modelOptions,
  subagentOptions,
  onModel,
  onModelOneM,
  onSubagent,
  onSubagentOneM,
}: {
  model: string
  subagent: string
  modelOptions: readonly string[]
  subagentOptions: readonly string[]
  onModel: (value: string) => void
  onModelOneM: (enabled: boolean) => void
  onSubagent: (value: string) => void
  onSubagentOneM: (enabled: boolean) => void
}) {
  return (
    <>
      <ModelPickRow
        label={localize('agentSettings.auth.form.model', 'Model')}
        hint="settings.model"
        value={model}
        options={modelOptions}
        emptyLabel={localize('agentSettings.auth.form.model.none', 'Use default')}
        placeholder="claude-opus-4-8"
        testIdPrefix="model"
        onValue={onModel}
        onOneM={onModelOneM}
      />
      <ModelPickRow
        label={localize('agentSettings.auth.form.subagentModel', 'Sub Agent Model')}
        hint="env.CLAUDE_CODE_SUBAGENT_MODEL"
        value={subagent}
        options={subagentOptions}
        emptyLabel={localize('agentSettings.auth.form.subagentModel.none', 'Unset')}
        placeholder="claude-sonnet-4-6"
        testIdPrefix="subagentModel"
        onValue={onSubagent}
        onOneM={onSubagentOneM}
      />
    </>
  )
}

function ModelPickRow({
  label,
  hint,
  value,
  options,
  emptyLabel,
  placeholder,
  testIdPrefix,
  onValue,
  onOneM,
}: {
  label: string
  hint?: string
  value: string
  options: readonly string[]
  emptyLabel: string
  placeholder: string
  testIdPrefix: string
  onValue: (value: string) => void
  onOneM: (enabled: boolean) => void
}) {
  // `value` is the effective id, so the suffix IS the checkbox state — there is
  // no separate flag that could disagree with it. Empty means "no pick", which
  // has no lane to toggle.
  const showOneM = value.trim() !== ''
  const oneM = hasOneM(value)
  return (
    <div className={styles['field']}>
      <label className={styles['label']}>{label}</label>
      {hint !== undefined && <span className={styles['desc']}>{hint}</span>}
      <div className={styles['modelRow']}>
        {options.length > 0 ? (
          <Select
            className={styles['modelControl']}
            value={value}
            options={[
              { value: '', label: emptyLabel },
              ...options.map((m) => ({ value: m, label: m })),
            ]}
            onChange={onValue}
          />
        ) : (
          <Input
            className={styles['modelControl']}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onValue(e.target.value)}
          />
        )}
        {showOneM && (
          <span
            className={styles['oneMHint']}
            data-tooltip={localize(
              'agentSettings.auth.form.oneM.tip',
              'Request the 1M-token context variant — appends [1m] to the model id written to settings.json.',
            )}
          >
            <Checkbox
              checked={oneM}
              onChange={onOneM}
              label="1m"
              aria-label="1m"
              data-testid={`${testIdPrefix}-1m`}
            />
          </span>
        )}
      </div>
    </div>
  )
}

function ClaudeDerivationPreview({ resolved }: { readonly resolved: AiResolvedProvider }) {
  const missing = missingProviderPiece(resolved, CLAUDE_PROTOCOL)
  if (missing !== undefined) return <DerivationError missing={missing} />
  const derived = deriveClaudeAuth(resolved)
  if (derived === undefined) return null
  if (derived.kind === 'apiKey') {
    return (
      <div className={styles['derivePreview']} data-testid="derivePreview">
        <div className={styles['deriveRow']}>
          <span className={styles['deriveKey']}>{API_KEY}</span>
          <span className={styles['deriveValue']}>{maskKey(derived.apiKey)}</span>
        </div>
      </div>
    )
  }
  return (
    <div className={styles['derivePreview']} data-testid="derivePreview">
      <div className={styles['deriveRow']}>
        <span className={styles['deriveKey']}>{BASE_URL}</span>
        <span className={styles['deriveValue']}>{derived.baseUrl}</span>
      </div>
      <div className={styles['deriveRow']}>
        <span className={styles['deriveKey']}>{AUTH_TOKEN}</span>
        <span className={styles['deriveValue']}>{maskKey(derived.authToken)}</span>
      </div>
    </div>
  )
}

function LoginForm({
  authStatus,
  authority,
  isActive,
  onUseLogin,
  reloadAuthStatus,
}: {
  authStatus: ClaudeAuthStatus
  authority: string | undefined
  isActive: boolean
  onUseLogin: () => void
  reloadAuthStatus: UseClaudeConfig['reloadAuthStatus']
}) {
  const notification = useService(INotificationService)
  const login = runClaudeLogin()
  const [refreshing, setRefreshing] = useState(false)
  const signedIn = authStatus.loggedIn && !authStatus.expired
  // Signed in but not the credential in effect ⇒ a provider credential is
  // taking precedence; offer to switch the login back to active.
  const overridden = signedIn && !isActive

  const doLogin = useCallback(
    async (kind: 'claudeai' | 'console') => {
      await login(kind)
      // The login runs in a terminal; poll once shortly after so the status row
      // reflects a freshly written ~/.claude/.credentials.json without a reopen.
      setTimeout(() => void reloadAuthStatus(), 4000)
    },
    [login, reloadAuthStatus],
  )

  const doRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const status = await reloadAuthStatus()
      const message =
        status.loggedIn && !status.expired
          ? status.subscriptionType
            ? localize('agentSettings.auth.login.signedInPlan', 'Signed in ({plan})', {
                plan: status.subscriptionType,
              })
            : localize('agentSettings.auth.login.signedIn', 'Signed in')
          : status.loggedIn && status.expired
            ? localize('agentSettings.auth.login.expired', 'Login expired — please sign in again.')
            : localize('agentSettings.auth.login.signedOut', 'Not signed in')
      notification.notify({ severity: Severity.Info, message })
    } finally {
      setRefreshing(false)
    }
  }, [reloadAuthStatus, notification])

  const setAsCurrent = useCallback(() => {
    onUseLogin()
    notification.notify({
      severity: Severity.Info,
      message: localize('agentSettings.auth.login.activated', 'Now using your Claude login.'),
    })
  }, [onUseLogin, notification])

  return (
    <div className={styles['authForm']}>
      <div className={styles['statusRow']}>
        {authStatus.loggedIn && !authStatus.expired && (
          <span className={styles['statusOk']}>
            <CheckCircle2 size={14} strokeWidth={2} />
            {authStatus.subscriptionType
              ? localize('agentSettings.auth.login.signedInPlan', 'Signed in ({plan})', {
                  plan: authStatus.subscriptionType,
                })
              : localize('agentSettings.auth.login.signedIn', 'Signed in')}
          </span>
        )}
        {authStatus.loggedIn && authStatus.expired && (
          <span className={styles['statusWarn']}>
            <CircleAlert size={14} strokeWidth={2} />
            {localize('agentSettings.auth.login.expired', 'Login expired — please sign in again.')}
          </span>
        )}
        {!authStatus.loggedIn && (
          <span className={styles['statusMuted']}>
            {localize('agentSettings.auth.login.signedOut', 'Not signed in')}
          </span>
        )}
        <button
          type="button"
          className={styles['linkButton']}
          disabled={refreshing}
          onClick={() => void doRefresh()}
        >
          {refreshing
            ? localize('agentSettings.auth.login.refreshing', 'Refreshing…')
            : localize('agentSettings.auth.login.refresh', 'Refresh')}
        </button>
      </div>

      {overridden && (
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.login.overridden',
            'You are signed in, but a provider credential is currently taking precedence.',
          )}
        </div>
      )}

      <div className={styles['desc']}>
        {localize(
          'agentSettings.auth.login.hint',
          'Opens a terminal and runs the Claude login flow. Follow the prompts, then start an agent session.',
        )}
      </div>
      {authority !== undefined && (
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.login.remoteHint',
            'Runs `claude auth login` in a terminal on the remote host; requires the claude CLI on its PATH.',
          )}
        </div>
      )}
      <div className={styles['toolbar']}>
        <Button onClick={() => void doLogin('claudeai')}>
          {localize('agentSettings.auth.login.subscription', 'Log in with Claude subscription')}
        </Button>
        <Button variant="ghost" onClick={() => void doLogin('console')}>
          {localize('agentSettings.auth.login.console', 'Log in with Anthropic Console')}
        </Button>
        {overridden && (
          <Button variant="ghost" onClick={setAsCurrent}>
            {localize('agentSettings.auth.login.setCurrent', 'Use this login')}
          </Button>
        )}
      </div>
    </div>
  )
}
