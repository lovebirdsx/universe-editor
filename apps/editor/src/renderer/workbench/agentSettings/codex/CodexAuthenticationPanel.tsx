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
  CodexCredentialKind,
  CodexCredentialProfile,
} from '../../../../shared/ipc/codexConfigService.js'
import type { UseCodexConfig } from './useCodexConfig.js'
import { runCodexLogin } from './codexLogin.js'
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

  return (
    <div className={styles['panel']}>
      <CredentialLibrary config={config} apiKeyActive={apiKeyActive} />

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>
          {localize('codexSettings.auth.login', 'Log in with ChatGPT')}
        </h2>
        <LoginForm config={config} />
      </section>

      {configPath && (
        <div className={styles['pathHint']}>
          {localize('codexSettings.auth.path', 'Settings in {path}; credentials in auth.json', {
            path: configPath,
          })}
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
  const { profiles, applyProfile, saveProfile, deleteProfile, settings } = config
  const [editing, setEditing] = useState<CodexCredentialProfile | null>(null)
  const [adding, setAdding] = useState(false)

  const activeBaseUrl = typeof settings.openai_base_url === 'string' ? settings.openai_base_url : ''

  const isActive = useCallback(
    (profile: CodexCredentialProfile): boolean => {
      // The API key value never leaves the main process, so we can only match on
      // the gateway base URL + the fact an API key is the active credential.
      if (!apiKeyActive) return false
      if (profile.kind === 'gateway') return activeBaseUrl === (profile.baseUrl ?? '')
      return activeBaseUrl === ''
    },
    [apiKeyActive, activeBaseUrl],
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
          editing?.id === profile.id ? (
            <ProfileForm
              key={profile.id}
              initial={profile}
              onSave={async (p) => {
                await saveProfile(p)
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <ProfileRow
              key={profile.id}
              profile={profile}
              active={isActive(profile)}
              onUse={() => void apply(profile)}
              onEdit={() => setEditing(profile)}
              onDelete={() => void deleteProfile(profile.id)}
            />
          ),
        )}
      </div>

      {adding ? (
        <ProfileForm
          onSave={async (p) => {
            await saveProfile(p)
            setAdding(false)
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className={styles['toolbar']}>
          <Button variant="ghost" onClick={() => setAdding(true)}>
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
  initial,
  onSave,
  onCancel,
}: {
  initial?: CodexCredentialProfile
  onSave: (profile: CodexCredentialProfile) => Promise<void>
  onCancel: () => void
}) {
  const [kind, setKind] = useState<CodexCredentialKind>(initial?.kind ?? 'apiKey')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')

  const valid =
    label.trim() !== '' && apiKey.trim() !== '' && (kind === 'apiKey' || baseUrl.trim() !== '')

  const save = useCallback(async () => {
    const base = { id: initial?.id ?? newId(), label: label.trim(), kind }
    const profile: CodexCredentialProfile =
      kind === 'apiKey'
        ? { ...base, apiKey: apiKey.trim() }
        : { ...base, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() }
    await onSave(profile)
  }, [initial?.id, label, kind, apiKey, baseUrl, onSave])

  return (
    <div className={styles['profileForm']}>
      <div className={styles['field']}>
        <label className={styles['label']}>
          {localize('codexSettings.auth.form.kind', 'Type')}
        </label>
        <div className={styles['toolbar']}>
          <button
            type="button"
            className={`${styles['choice']} ${kind === 'apiKey' ? styles['choiceActive'] : ''}`}
            onClick={() => setKind('apiKey')}
          >
            <KeyRound size={14} strokeWidth={1.75} />
            {localize('codexSettings.auth.apiKey', 'OpenAI API key')}
          </button>
          <button
            type="button"
            className={`${styles['choice']} ${kind === 'gateway' ? styles['choiceActive'] : ''}`}
            onClick={() => setKind('gateway')}
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
          value={label}
          placeholder={localize('codexSettings.auth.form.label.ph', 'e.g. Personal, Work gateway')}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      {kind === 'gateway' && (
        <div className={styles['field']}>
          <label className={styles['label']}>{'config.toml openai_base_url'}</label>
          <Input
            value={baseUrl}
            placeholder="https://your-gateway.example.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
      )}

      <div className={styles['field']}>
        <label className={styles['label']}>{'auth.json OPENAI_API_KEY'}</label>
        <Input
          type="password"
          value={apiKey}
          placeholder="sk-…"
          onChange={(e) => setApiKey(e.target.value)}
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

function LoginForm({ config }: { config: UseCodexConfig }) {
  const notification = useService(INotificationService)
  const login = runCodexLogin()
  const { authStatus, reloadAuthStatus, switchToChatgptLogin } = config
  const chatgpt = authStatus.chatgpt
  const signedIn = !!chatgpt && !chatgpt.expired
  const chatgptActive = authStatus.active === 'chatgpt'
  // A valid ChatGPT login that is being overridden by an active API key.
  const overridden = signedIn && authStatus.active === 'apiKey'

  const doLogin = useCallback(async () => {
    await login()
    // The login runs in a terminal and rewrites ~/.codex/auth.json with a
    // ChatGPT token block (auth_mode "chatgpt"). The disk watch refreshes the
    // status automatically; we only schedule a follow-up to clear any custom
    // gateway base URL once a fresh, un-overridden ChatGPT login takes effect.
    setTimeout(() => {
      void (async () => {
        const status = await reloadAuthStatus()
        if (status.active === 'chatgpt') await config.patch({ openai_base_url: null })
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
          onClick={() => void reloadAuthStatus()}
        >
          {localize('codexSettings.auth.login.refresh', 'Refresh')}
        </button>
      </div>

      {overridden && (
        <div className={styles['desc']}>
          {localize(
            'codexSettings.auth.login.overridden',
            'You are signed in, but a saved API key is currently taking precedence.',
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
