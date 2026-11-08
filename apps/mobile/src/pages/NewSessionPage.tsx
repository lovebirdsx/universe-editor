import type {
  MobileAgentCandidate,
  MobileWorkspaceCandidate,
} from '@universe-editor/mobile-protocol'
import { MAX_PROMPT_LENGTH } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { Spinner } from '../components/Spinner.js'
import { navigateToSession } from '../routing.js'
import type { MobileClient } from '../state/mobileClient.js'
import { sessionRouteKey } from '../state/refs.js'
import { useStore } from '../state/useStore.js'
import { commandErrorText, strings } from '../strings.js'

export type NewSessionClient = Pick<
  MobileClient,
  'listAgents' | 'listWorkspaces' | 'newSession' | 'getSocketStateStore'
>

export interface NewSessionPageProps {
  readonly client: NewSessionClient
  readonly onBack: () => void
  readonly onCreated: (sessionKey: string) => void
}

export function NewSessionPage({ client, onBack, onCreated }: NewSessionPageProps) {
  const socketState = useStore(client.getSocketStateStore())
  const online = socketState === 'connected'
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<readonly MobileAgentCandidate[]>([])
  const [workspaces, setWorkspaces] = useState<readonly MobileWorkspaceCandidate[]>([])
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const [folder, setFolder] = useState<string | undefined>(undefined)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!online) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void Promise.all([client.listAgents(), client.listWorkspaces()])
      .then(([nextAgents, nextWorkspaces]) => {
        if (cancelled) return
        setAgents(nextAgents)
        const sorted = [...nextWorkspaces].sort(
          (a, b) => Number(b.isOpen) - Number(a.isOpen) || a.name.localeCompare(b.name),
        )
        setWorkspaces(sorted)
        setAgentId(
          (current) =>
            current ?? nextAgents.find((agent) => agent.isDefault)?.id ?? nextAgents[0]?.id,
        )
        setFolder(
          (current) =>
            current ?? sorted.find((workspace) => workspace.isOpen)?.folder ?? sorted[0]?.folder,
        )
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoading(false)
        setError(commandErrorText(errorCode(err)))
      })
    return () => {
      cancelled = true
    }
  }, [client, online, reloadKey])

  const submit = async (): Promise<void> => {
    if (agentId === undefined || folder === undefined) {
      setError(strings.newSessionRequired)
      return
    }
    const workspace = workspaces.find((candidate) => candidate.folder === folder)
    if (workspace === undefined) {
      setError(strings.newSessionRequired)
      return
    }
    setSubmitting(true)
    setError(undefined)
    try {
      const result = await client.newSession(
        agentId,
        {
          folder: workspace.folder,
          ...(workspace.authority !== undefined ? { authority: workspace.authority } : {}),
        },
        prompt.trim() === '' ? undefined : prompt,
      )
      const ref = result?.ref
      if (ref === undefined) {
        setError(commandErrorText('invalid_response'))
        setSubmitting(false)
        return
      }
      const sessionKey = sessionRouteKey(ref)
      navigateToSession(sessionKey)
      onCreated(sessionKey)
    } catch (err) {
      setSubmitting(false)
      setError(commandErrorText(errorCode(err)))
    }
  }

  const selectedWorkspace = workspaces.find((candidate) => candidate.folder === folder)
  const disabled = !online || submitting || loading

  return (
    <div className="new-session-page">
      <header className="new-session-header">
        <button
          type="button"
          className="session-header__back"
          aria-label={strings.newSessionBack}
          onClick={onBack}
        >
          ‹
        </button>
        <h1 className="new-session-title">{strings.newSessionTitle}</h1>
      </header>
      <main className="new-session-body">
        {!online && (
          <div className="offline-banner" role="status">
            <span className="offline-banner__dot" aria-hidden="true" />
            <span>{strings.inboxOfflineBanner}</span>
          </div>
        )}
        {error !== undefined && (
          <p className="pair-form__error" role="alert" data-testid="new-session-error">
            {error}
          </p>
        )}
        {loading ? (
          <div className="state-card state-card--row">
            <Spinner />
            <p>{strings.newSessionLoading}</p>
          </div>
        ) : (
          <>
            <section className="new-session-section">
              <h2 className="new-session-label">{strings.newSessionAgentLabel}</h2>
              {agents.length === 0 ? (
                <p className="muted">{strings.newSessionNoAgents}</p>
              ) : (
                <div
                  className="choice-list"
                  role="listbox"
                  aria-label={strings.newSessionAgentLabel}
                >
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      role="option"
                      aria-selected={agent.id === agentId}
                      className={`choice${agent.id === agentId ? ' choice--selected' : ''}`}
                      data-testid="new-session-agent"
                      data-agent-id={agent.id}
                      disabled={disabled}
                      onClick={() => setAgentId(agent.id)}
                    >
                      <span className="choice__label">{agent.name}</span>
                      {agent.isDefault && (
                        <span className="session-badge">{strings.configCurrent}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="new-session-section">
              <h2 className="new-session-label">{strings.newSessionWorkspaceLabel}</h2>
              {workspaces.length === 0 ? (
                <p className="muted">{strings.newSessionNoWorkspaces}</p>
              ) : (
                <div
                  className="choice-list"
                  role="listbox"
                  aria-label={strings.newSessionWorkspaceLabel}
                >
                  {workspaces.map((workspace) => {
                    const remote =
                      workspace.authority !== undefined ||
                      workspace.folder.startsWith('remote-ssh:')
                    return (
                      <button
                        key={workspace.folder}
                        type="button"
                        role="option"
                        aria-selected={workspace.folder === folder}
                        className={`choice${workspace.folder === folder ? ' choice--selected' : ''}`}
                        data-testid="new-session-workspace"
                        data-folder={workspace.folder}
                        disabled={disabled}
                        onClick={() => setFolder(workspace.folder)}
                      >
                        <span className="choice__label">{workspace.name}</span>
                        {workspace.isOpen && (
                          <span className="session-badge">{strings.newSessionWorkspaceOpen}</span>
                        )}
                        {remote && (
                          <span className="session-badge">{strings.newSessionWorkspaceRemote}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              {selectedWorkspace !== undefined && !selectedWorkspace.isOpen && (
                <p className="sheet__hint" data-testid="new-session-open-hint">
                  {strings.newSessionWorkspaceWillOpen}
                </p>
              )}
            </section>
            <section className="new-session-section">
              <label className="new-session-label" htmlFor="new-session-prompt">
                {strings.newSessionPromptLabel}
              </label>
              <textarea
                id="new-session-prompt"
                className="sheet__textarea new-session-prompt"
                data-testid="new-session-prompt"
                rows={3}
                maxLength={MAX_PROMPT_LENGTH}
                value={prompt}
                disabled={disabled}
                placeholder={strings.newSessionPromptPlaceholder}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </section>
            <button
              type="button"
              className="button button--primary new-session-submit"
              data-testid="new-session-submit"
              disabled={disabled}
              onClick={() => void submit()}
            >
              {submitting ? strings.newSessionSubmitting : strings.newSessionSubmit}
            </button>
            {!online && (
              <button
                type="button"
                className="text-button"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                {strings.toolCallDetailRetry}
              </button>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
