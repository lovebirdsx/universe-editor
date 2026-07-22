/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AuthenticationPanel — the "Authentication" category. Two parts:
 *
 *   1. Saved credentials — a library of API-key / gateway profiles kept in the
 *      editor's own store (`aiSettings.json`). The user
 *      *applies* a profile to inject it into `~/.claude/settings.json` (the file
 *      the CLI + agent read). Switching credentials no longer destroys the others
 *      — they stay in the library.
 *
 *   2. Log in with Claude — the single shared OAuth login (`claude auth login`),
 *      stored in `~/.claude/.credentials.json`. Not a profile; shows live status.
 *
 *  The credential that is *currently active* (matching settings.json env, or the
 *  OAuth login when no env credential is set) is marked "In use".
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, KeyRound, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { localize, INotificationService, Severity } from '@universe-editor/platform'
import { Button, IconButton, Input } from '@universe-editor/workbench-ui'
import { useService } from '../../useService.js'
import type {
  ClaudeAuthStatus,
  ClaudeCredentialDraft,
  ClaudeCredentialProfile,
} from '../../../../shared/ipc/claudeConfigService.js'
import type { UseClaudeConfig } from './useClaudeConfig.js'
import { runClaudeLogin } from './claudeLogin.js'
import { ConfigFileLink } from '../ConfigFileLink.js'
import styles from '../AgentSettingsEditor.module.css'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'
const SMALL_FAST_MODEL = 'ANTHROPIC_SMALL_FAST_MODEL'

/** True when the profile's credentials exactly match the active settings.json env. */
function isProfileActive(
  profile: ClaudeCredentialProfile,
  env: Record<string, string>,
  model: string | undefined,
): boolean {
  if (profile.kind === 'apiKey') {
    return !env[AUTH_TOKEN] && !env[BASE_URL] && !!env[API_KEY] && env[API_KEY] === profile.apiKey
  }
  if (env[AUTH_TOKEN] !== profile.authToken || env[BASE_URL] !== profile.baseUrl) return false
  // A model preset is part of the gateway identity: if the profile pins a model,
  // it is only "in use" when settings.model matches too.
  const pinned = profile.model?.trim()
  return !pinned || model === pinned
}

/** Whether the OAuth login is the credential the agent will currently use. */
function isLoginActive(env: Record<string, string>, auth: ClaudeAuthStatus): boolean {
  return !env[API_KEY] && !env[AUTH_TOKEN] && !env[BASE_URL] && auth.loggedIn && !auth.expired
}

/** Show only a hint of a secret: first 4 + last 2 characters. */
function mask(secret: string | undefined): string {
  if (!secret) return ''
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}…${secret.slice(-2)}`
}

/** Renderer-side stable id; crypto.randomUUID is available in the renderer. */
function newId(): string {
  return crypto.randomUUID()
}

export function AuthenticationPanel({ config }: { config: UseClaudeConfig }) {
  const { settings, authStatus, configPath } = config
  const env = useMemo(() => settings.env ?? {}, [settings.env])

  return (
    <div className={styles['panel']}>
      <CredentialLibrary config={config} env={env} model={settings.model} />

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>
          {localize('agentSettings.auth.login', 'Log in with Claude')}
        </h2>
        <LoginForm
          authStatus={authStatus}
          isActive={isLoginActive(env, authStatus)}
          hasEnvCredential={!!env[API_KEY] || !!env[AUTH_TOKEN] || !!env[BASE_URL]}
          patch={config.patch}
          reloadAuthStatus={config.reloadAuthStatus}
        />
      </section>

      {configPath && (
        <div className={styles['pathHint']}>
          {localize('agentSettings.auth.path.prefix', 'Active credential stored in')}{' '}
          <ConfigFileLink path={configPath} />
        </div>
      )}
    </div>
  )
}

function CredentialLibrary({
  config,
  env,
  model,
}: {
  config: UseClaudeConfig
  env: Record<string, string>
  model: string | undefined
}) {
  const notification = useService(INotificationService)
  const {
    profiles,
    credentialDraft,
    applyProfile,
    saveProfile,
    deleteProfile,
    saveCredentialDraft,
  } = config
  const adding = credentialDraft !== undefined && credentialDraft.editingProfileId === undefined

  const apply = useCallback(
    async (profile: ClaudeCredentialProfile) => {
      await applyProfile(profile)
      notification.notify({
        severity: Severity.Info,
        message: localize('agentSettings.auth.applied', 'Now using “{label}”.', {
          label: profile.label,
        }),
      })
    },
    [applyProfile, notification],
  )

  return (
    <section className={styles['section']}>
      <h2 className={styles['sectionTitle']}>
        {localize('agentSettings.auth.library', 'Saved credentials')}
      </h2>

      {profiles.length === 0 && !adding && (
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.library.empty',
            'No saved credentials yet. Add an API key or a gateway token + URL, then switch between them anytime.',
          )}
        </div>
      )}

      <div className={styles['profileList']}>
        {profiles.map((profile) =>
          credentialDraft?.editingProfileId === profile.id ? (
            <ProfileForm
              key={profile.id}
              draft={credentialDraft}
              onChange={(draft) => void saveCredentialDraft(draft)}
              onSave={async (p) => {
                await saveProfile(p)
                await saveCredentialDraft(undefined)
              }}
              onCancel={() => void saveCredentialDraft(undefined)}
            />
          ) : (
            <ProfileRow
              key={profile.id}
              profile={profile}
              active={isProfileActive(profile, env, model)}
              onUse={() => void apply(profile)}
              onEdit={() => void saveCredentialDraft(profileToDraft(profile))}
              onDelete={() => void deleteProfile(profile.id)}
            />
          ),
        )}
      </div>

      {adding ? (
        <ProfileForm
          draft={credentialDraft!}
          onChange={(draft) => void saveCredentialDraft(draft)}
          onSave={async (p) => {
            await saveProfile(p)
            await saveCredentialDraft(undefined)
          }}
          onCancel={() => void saveCredentialDraft(undefined)}
        />
      ) : (
        <div className={styles['toolbar']}>
          <Button variant="ghost" onClick={() => void saveCredentialDraft(EMPTY_DRAFT)}>
            <Plus size={14} strokeWidth={2} />
            {localize('agentSettings.auth.library.add', 'Add credential')}
          </Button>
        </div>
      )}
    </section>
  )
}

function ProfileRow({
  profile,
  active,
  onUse,
  onEdit,
  onDelete,
}: {
  profile: ClaudeCredentialProfile
  active: boolean
  onUse: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const Icon = profile.kind === 'apiKey' ? KeyRound : Network
  const detail =
    profile.kind === 'apiKey'
      ? mask(profile.apiKey)
      : [profile.baseUrl ?? '', profile.model, mask(profile.authToken)].filter((s) => s).join(' · ')
  return (
    <div className={styles['profileRow']}>
      <Icon size={16} strokeWidth={1.75} className={styles['navIcon']} />
      <div className={styles['profileBody']}>
        <div className={styles['radioTitleRow']}>
          <span className={styles['radioTitle']}>{profile.label}</span>
          {active && (
            <span className={styles['activeBadge']}>
              {localize('agentSettings.auth.inUse', 'In use')}
            </span>
          )}
        </div>
        <span className={styles['profileDetail']}>{detail}</span>
      </div>
      <div className={styles['profileActions']}>
        {!active && (
          <Button variant="ghost" onClick={onUse}>
            {localize('agentSettings.auth.use', 'Use')}
          </Button>
        )}
        <IconButton label={localize('agentSettings.auth.edit', 'Edit')} onClick={onEdit}>
          <Pencil size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={localize('agentSettings.auth.delete', 'Delete')} onClick={onDelete}>
          <Trash2 size={14} strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  )
}

function ProfileForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ClaudeCredentialDraft
  onChange: (draft: ClaudeCredentialDraft) => void
  onSave: (profile: ClaudeCredentialProfile) => Promise<void>
  onCancel: () => void
}) {
  const valid =
    draft.label.trim() !== '' &&
    (draft.kind === 'apiKey'
      ? draft.apiKey.trim() !== ''
      : draft.authToken.trim() !== '' && draft.baseUrl.trim() !== '')

  const save = useCallback(async () => {
    const base = {
      id: draft.editingProfileId ?? newId(),
      label: draft.label.trim(),
      kind: draft.kind,
    }
    let profile: ClaudeCredentialProfile
    if (draft.kind === 'apiKey') {
      profile = { ...base, apiKey: draft.apiKey.trim() }
    } else {
      profile = { ...base, authToken: draft.authToken.trim(), baseUrl: draft.baseUrl.trim() }
      if (draft.model.trim()) profile.model = draft.model.trim()
      if (draft.smallFastModel.trim()) profile.smallFastModel = draft.smallFastModel.trim()
    }
    await onSave(profile)
  }, [draft, onSave])

  return (
    <div className={styles['profileForm']}>
      <div className={styles['field']}>
        <label className={styles['label']}>
          {localize('agentSettings.auth.form.kind', 'Type')}
        </label>
        <div className={styles['toolbar']}>
          <button
            type="button"
            className={`${styles['choice']} ${draft.kind === 'apiKey' ? styles['choiceActive'] : ''}`}
            onClick={() => onChange({ ...draft, kind: 'apiKey' })}
          >
            <KeyRound size={14} strokeWidth={1.75} />
            {localize('agentSettings.auth.apiKey', 'Anthropic API key')}
          </button>
          <button
            type="button"
            className={`${styles['choice']} ${draft.kind === 'gateway' ? styles['choiceActive'] : ''}`}
            onClick={() => onChange({ ...draft, kind: 'gateway' })}
          >
            <Network size={14} strokeWidth={1.75} />
            {localize('agentSettings.auth.gateway', 'Custom gateway / Auth token')}
          </button>
        </div>
      </div>

      <div className={styles['field']}>
        <label className={styles['label']}>
          {localize('agentSettings.auth.form.label', 'Name')}
        </label>
        <Input
          value={draft.label}
          placeholder={localize('agentSettings.auth.form.label.ph', 'e.g. Personal, Work gateway')}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
        />
      </div>

      {draft.kind === 'apiKey' ? (
        <div className={styles['field']}>
          <label className={styles['label']}>{`env.${API_KEY}`}</label>
          <Input
            type="password"
            value={draft.apiKey}
            placeholder="sk-ant-…"
            onChange={(e) => onChange({ ...draft, apiKey: e.target.value })}
          />
        </div>
      ) : (
        <>
          <div className={styles['field']}>
            <label className={styles['label']}>{`env.${BASE_URL}`}</label>
            <Input
              value={draft.baseUrl}
              placeholder="https://your-gateway.example.com"
              onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
            />
          </div>
          <div className={styles['field']}>
            <label className={styles['label']}>{`env.${AUTH_TOKEN}`}</label>
            <Input
              type="password"
              value={draft.authToken}
              placeholder="sk-…"
              onChange={(e) => onChange({ ...draft, authToken: e.target.value })}
            />
          </div>
          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('agentSettings.auth.form.model', 'Model')}
            </label>
            <div className={styles['desc']}>
              {localize(
                'agentSettings.auth.form.model.desc',
                'Model to request from this gateway (e.g. kimi-k3). Applied to Settings.model when you use this credential. Leave empty to keep the current model.',
              )}
            </div>
            <Input
              value={draft.model}
              placeholder="kimi-k3"
              onChange={(e) => onChange({ ...draft, model: e.target.value })}
            />
          </div>
          <div className={styles['field']}>
            <label className={styles['label']}>{`env.${SMALL_FAST_MODEL}`}</label>
            <div className={styles['desc']}>
              {localize(
                'agentSettings.auth.form.smallFastModel.desc',
                'Optional fast/background model this gateway serves. Leave empty to unset it.',
              )}
            </div>
            <Input
              value={draft.smallFastModel}
              placeholder="kimi-k3-mini"
              onChange={(e) => onChange({ ...draft, smallFastModel: e.target.value })}
            />
          </div>
        </>
      )}

      <div className={styles['toolbar']}>
        <Button disabled={!valid} onClick={() => void save()}>
          {localize('agentSettings.auth.save', 'Save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {localize('agentSettings.auth.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

const EMPTY_DRAFT: ClaudeCredentialDraft = {
  kind: 'apiKey',
  label: '',
  apiKey: '',
  authToken: '',
  baseUrl: '',
  model: '',
  smallFastModel: '',
}

function profileToDraft(profile: ClaudeCredentialProfile): ClaudeCredentialDraft {
  return {
    editingProfileId: profile.id,
    kind: profile.kind,
    label: profile.label,
    apiKey: profile.apiKey ?? '',
    authToken: profile.authToken ?? '',
    baseUrl: profile.baseUrl ?? '',
    model: profile.model ?? '',
    smallFastModel: profile.smallFastModel ?? '',
  }
}

function LoginForm({
  authStatus,
  isActive,
  hasEnvCredential,
  patch,
  reloadAuthStatus,
}: {
  authStatus: ClaudeAuthStatus
  isActive: boolean
  hasEnvCredential: boolean
  patch: UseClaudeConfig['patch']
  reloadAuthStatus: UseClaudeConfig['reloadAuthStatus']
}) {
  const notification = useService(INotificationService)
  const login = runClaudeLogin()
  const [refreshing, setRefreshing] = useState(false)

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

  const setAsCurrent = useCallback(async () => {
    // Hand control back to the OAuth login by clearing the env credentials that
    // would otherwise take precedence. The saved profiles are untouched.
    await patch({ env: { [API_KEY]: null, [AUTH_TOKEN]: null, [BASE_URL]: null } })
    notification.notify({
      severity: Severity.Info,
      message: localize('agentSettings.auth.login.activated', 'Now using your Claude login.'),
    })
  }, [patch, notification])

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
        {isActive && (
          <span className={styles['activeBadge']}>
            {localize('agentSettings.auth.inUse', 'In use')}
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

      {authStatus.loggedIn && !authStatus.expired && hasEnvCredential && (
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.login.overridden',
            'You are signed in, but a saved credential is currently taking precedence.',
          )}
        </div>
      )}

      <div className={styles['desc']}>
        {localize(
          'agentSettings.auth.login.hint',
          'Opens a terminal and runs the Claude login flow. Follow the prompts, then start an agent session.',
        )}
      </div>
      <div className={styles['toolbar']}>
        <Button onClick={() => void doLogin('claudeai')}>
          {localize('agentSettings.auth.login.subscription', 'Log in with Claude subscription')}
        </Button>
        <Button variant="ghost" onClick={() => void doLogin('console')}>
          {localize('agentSettings.auth.login.console', 'Log in with Anthropic Console')}
        </Button>
        {authStatus.loggedIn && !authStatus.expired && hasEnvCredential && (
          <Button variant="ghost" onClick={() => void setAsCurrent()}>
            {localize('agentSettings.auth.login.setCurrent', 'Use this login')}
          </Button>
        )}
      </div>
    </div>
  )
}
