/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexAuthenticationPanel — the "Authentication" category. Two parts:
 *
 *   1. Saved credentials — a library of API-key / gateway profiles kept in the
 *      editor's own store. Applying a profile writes its API key into
 *      `~/.codex/auth.json` (OPENAI_API_KEY) and, for gateway profiles, the
 *      matching `openai_base_url` into config.toml.
 *
 *   2. Log in with ChatGPT — the single shared OAuth login (`codex login`, run via
 *      the official Codex CLI), stored in `~/.codex/auth.json`. Shows live status.
 *
 *  The credential currently *active* (an API key in auth.json, or the ChatGPT
 *  login when no key is set) is marked "In use".
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useState } from 'react'
import { CheckCircle2, CircleAlert, KeyRound, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { localize, INotificationService, Severity } from '@universe-editor/platform'
import { Button, IconButton, Input } from '@universe-editor/workbench-ui'
import { useService } from '../../useService.js'
import type {
  CodexCredentialDraft,
  CodexCredentialProfile,
} from '../../../../shared/ipc/codexConfigService.js'
import type { UseCodexConfig } from './useCodexConfig.js'
import { runCodexLogin } from './codexLogin.js'
import { ConfigFileLink, getSiblingConfigPath } from '../ConfigFileLink.js'
import styles from '../AgentSettingsEditor.module.css'

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

export function CodexAuthenticationPanel({ config }: { config: UseCodexConfig }) {
  const { authStatus, configPath } = config
  const apiKeyActive = authStatus.active === 'apiKey'
  const authPath = configPath ? getSiblingConfigPath(configPath, 'auth.json') : undefined

  return (
    <div className={styles['panel']}>
      <CredentialLibrary config={config} apiKeyActive={apiKeyActive} />

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>
          {localize('codexSettings.auth.login', 'Log in with ChatGPT')}
        </h2>
        <LoginForm config={config} />
      </section>

      {configPath && authPath && (
        <div className={styles['pathHint']}>
          {localize('codexSettings.auth.path.settingsPrefix', 'Settings in')}{' '}
          <ConfigFileLink path={configPath} />
          {localize('codexSettings.auth.path.credentialsPrefix', '; credentials in')}{' '}
          <ConfigFileLink path={authPath} label="auth.json" />
        </div>
      )}
    </div>
  )
}

function CredentialLibrary({
  config,
  apiKeyActive,
}: {
  config: UseCodexConfig
  apiKeyActive: boolean
}) {
  const notification = useService(INotificationService)
  const {
    profiles,
    credentialDraft,
    applyProfile,
    saveProfile,
    deleteProfile,
    saveCredentialDraft,
    settings,
  } = config
  const adding = credentialDraft !== undefined && credentialDraft.editingProfileId === undefined

  // What codex *actually* uses is decided by config.toml's `model_provider`:
  // - `codex-gateway` → our self-contained gateway provider is active.
  // - empty/unset → the built-in `openai` provider runs on auth.json (ChatGPT
  //   login or API key). So an API-key / ChatGPT login is only "in use" when no
  //   custom provider overrides it.
  const modelProvider = typeof settings.model_provider === 'string' ? settings.model_provider : ''
  const gatewayActive = modelProvider === 'codex-gateway'
  const builtinActive = modelProvider === ''
  const gatewayBaseUrl = (() => {
    const providers = settings.model_providers
    if (!gatewayActive || !providers || typeof providers !== 'object') return ''
    const gw = (providers as Record<string, unknown>)['codex-gateway']
    if (!gw || typeof gw !== 'object') return ''
    const url = (gw as Record<string, unknown>)['base_url']
    return typeof url === 'string' ? url : ''
  })()

  const isActive = useCallback(
    (profile: CodexCredentialProfile): boolean => {
      // The API key value never leaves the main process, so gateway profiles
      // match on the active provider's base URL, API-key profiles on the mode.
      if (profile.kind === 'gateway')
        return gatewayActive && gatewayBaseUrl === (profile.baseUrl ?? '')
      return apiKeyActive && builtinActive
    },
    [apiKeyActive, builtinActive, gatewayActive, gatewayBaseUrl],
  )

  const apply = useCallback(
    async (profile: CodexCredentialProfile) => {
      await applyProfile(profile)
      notification.notify({
        severity: Severity.Info,
        message: localize('codexSettings.auth.applied', 'Now using “{label}”.', {
          label: profile.label,
        }),
      })
    },
    [applyProfile, notification],
  )

  return (
    <section className={styles['section']}>
      <h2 className={styles['sectionTitle']}>
        {localize('codexSettings.auth.library', 'Saved credentials')}
      </h2>

      {profiles.length === 0 && !adding && (
        <div className={styles['desc']}>
          {localize(
            'codexSettings.auth.library.empty',
            'No saved credentials yet. Add an OpenAI API key or a compatible gateway (key + base URL), then switch between them anytime.',
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
              active={isActive(profile)}
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
            {localize('codexSettings.auth.library.add', 'Add credential')}
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
  profile: CodexCredentialProfile
  active: boolean
  onUse: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const Icon = profile.kind === 'apiKey' ? KeyRound : Network
  const detail =
    profile.kind === 'apiKey'
      ? mask(profile.apiKey)
      : `${profile.baseUrl ?? ''} · ${mask(profile.apiKey)}`
  return (
    <div className={styles['profileRow']}>
      <Icon size={16} strokeWidth={1.75} className={styles['navIcon']} />
      <div className={styles['profileBody']}>
        <div className={styles['radioTitleRow']}>
          <span className={styles['radioTitle']}>{profile.label}</span>
          {active && (
            <span className={styles['activeBadge']}>
              {localize('codexSettings.auth.inUse', 'In use')}
            </span>
          )}
        </div>
        <span className={styles['profileDetail']}>{detail}</span>
      </div>
      <div className={styles['profileActions']}>
        {!active && (
          <Button variant="ghost" onClick={onUse}>
            {localize('codexSettings.auth.use', 'Use')}
          </Button>
        )}
        <IconButton label={localize('codexSettings.auth.edit', 'Edit')} onClick={onEdit}>
          <Pencil size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={localize('codexSettings.auth.delete', 'Delete')} onClick={onDelete}>
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
  draft: CodexCredentialDraft
  onChange: (draft: CodexCredentialDraft) => void
  onSave: (profile: CodexCredentialProfile) => Promise<void>
  onCancel: () => void
}) {
  const valid =
    draft.label.trim() !== '' &&
    draft.apiKey.trim() !== '' &&
    (draft.kind === 'apiKey' || draft.baseUrl.trim() !== '')

  const save = useCallback(async () => {
    const base = {
      id: draft.editingProfileId ?? newId(),
      label: draft.label.trim(),
      kind: draft.kind,
    }
    const profile: CodexCredentialProfile =
      draft.kind === 'apiKey'
        ? { ...base, apiKey: draft.apiKey.trim() }
        : { ...base, apiKey: draft.apiKey.trim(), baseUrl: draft.baseUrl.trim() }
    await onSave(profile)
  }, [draft, onSave])

  return (
    <div className={styles['profileForm']}>
      <div className={styles['field']}>
        <label className={styles['label']}>
          {localize('codexSettings.auth.form.kind', 'Type')}
        </label>
        <div className={styles['toolbar']}>
          <button
            type="button"
            className={`${styles['choice']} ${draft.kind === 'apiKey' ? styles['choiceActive'] : ''}`}
            onClick={() => onChange({ ...draft, kind: 'apiKey' })}
          >
            <KeyRound size={14} strokeWidth={1.75} />
            {localize('codexSettings.auth.apiKey', 'OpenAI API key')}
          </button>
          <button
            type="button"
            className={`${styles['choice']} ${draft.kind === 'gateway' ? styles['choiceActive'] : ''}`}
            onClick={() => onChange({ ...draft, kind: 'gateway' })}
          >
            <Network size={14} strokeWidth={1.75} />
            {localize('codexSettings.auth.gateway', 'Compatible gateway (key + URL)')}
          </button>
        </div>
      </div>

      <div className={styles['field']}>
        <label className={styles['label']}>
          {localize('codexSettings.auth.form.label', 'Name')}
        </label>
        <Input
          value={draft.label}
          placeholder={localize('codexSettings.auth.form.label.ph', 'e.g. Personal, Work gateway')}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
        />
      </div>

      {draft.kind === 'gateway' && (
        <div className={styles['field']}>
          <label className={styles['label']}>{'config.toml openai_base_url'}</label>
          <Input
            value={draft.baseUrl}
            placeholder="https://your-gateway.example.com/v1"
            onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
          />
        </div>
      )}

      <div className={styles['field']}>
        <label className={styles['label']}>{'auth.json OPENAI_API_KEY'}</label>
        <Input
          type="password"
          value={draft.apiKey}
          placeholder="sk-…"
          onChange={(e) => onChange({ ...draft, apiKey: e.target.value })}
        />
      </div>

      <div className={styles['toolbar']}>
        <Button disabled={!valid} onClick={() => void save()}>
          {localize('codexSettings.auth.save', 'Save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {localize('codexSettings.auth.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

const EMPTY_DRAFT: CodexCredentialDraft = {
  kind: 'apiKey',
  label: '',
  apiKey: '',
  baseUrl: '',
}

function profileToDraft(profile: CodexCredentialProfile): CodexCredentialDraft {
  return {
    editingProfileId: profile.id,
    kind: profile.kind,
    label: profile.label,
    apiKey: profile.apiKey ?? '',
    baseUrl: profile.baseUrl ?? '',
  }
}

function LoginForm({ config }: { config: UseCodexConfig }) {
  const notification = useService(INotificationService)
  const login = runCodexLogin()
  const { authStatus, settings, reloadAuthStatus, switchToChatgptLogin } = config
  const chatgpt = authStatus.chatgpt
  const signedIn = !!chatgpt && !chatgpt.expired
  // ChatGPT only actually runs when the built-in `openai` provider is selected,
  // i.e. config.toml's `model_provider` is empty. A custom provider (e.g.
  // `codex-gateway`) overrides it even while auth.json still reports `chatgpt`.
  const builtinActive =
    typeof settings.model_provider !== 'string' || settings.model_provider === ''
  const chatgptActive = authStatus.active === 'chatgpt' && builtinActive
  // A valid ChatGPT login that is not actually in use (an API key or a custom
  // provider currently takes precedence) — offer a one-click "Use this login".
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
    // ChatGPT token block. The disk watch refreshes status automatically; we
    // also tear down any lingering gateway provider once a fresh ChatGPT login
    // takes effect, so it is actually used instead of the custom provider.
    setTimeout(() => {
      void (async () => {
        const status = await reloadAuthStatus()
        if (status.chatgpt && !status.chatgpt.expired) {
          await config.switchToChatgptLogin()
        }
      })()
    }, 4000)
  }, [login, reloadAuthStatus, config])

  const setAsCurrent = useCallback(async () => {
    // Clear the API key AND the custom endpoint so the ChatGPT login takes over.
    await switchToChatgptLogin()
    notification.notify({
      severity: Severity.Info,
      message: localize('codexSettings.auth.login.activated', 'Now using your ChatGPT login.'),
    })
  }, [switchToChatgptLogin, notification])

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
            'You are signed in, but a saved credential is currently taking precedence.',
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
