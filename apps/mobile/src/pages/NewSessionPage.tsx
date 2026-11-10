import type {
  MobileAgentCandidate,
  MobileWorkspaceCandidate,
} from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { Spinner } from '../components/Spinner.js'
import { replaceWithSession } from '../routing.js'
import type { MobileClient } from '../state/mobileClient.js'
import { sessionRouteKey } from '../state/refs.js'
import { useStore } from '../state/useStore.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import {
  AgentPickerSheet,
  isRemoteWorkspace,
  WorkspacePickerSheet,
} from './NewSessionPickerSheet.js'

export type NewSessionClient = Pick<
  MobileClient,
  'listAgents' | 'listWorkspaces' | 'newSession' | 'getSocketStateStore'
>

export interface NewSessionPageProps {
  readonly client: NewSessionClient
  readonly onBack: () => void
  readonly onCreated: (sessionKey: string) => void
}

type PickerKind = 'agent' | 'workspace'

export function NewSessionPage({ client, onBack, onCreated }: NewSessionPageProps) {
  const socketState = useStore(client.getSocketStateStore())
  const online = socketState === 'connected'
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<readonly MobileAgentCandidate[]>([])
  const [workspaces, setWorkspaces] = useState<readonly MobileWorkspaceCandidate[]>([])
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const [folder, setFolder] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [picker, setPicker] = useState<PickerKind | undefined>(undefined)

  useEffect(() => {
    setPicker(undefined)
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
        // The gateway returns recent workspaces newest-first; only lift the open
        // ones so the picker can group them without losing recency order.
        const sorted = [...nextWorkspaces].sort((a, b) => Number(b.isOpen) - Number(a.isOpen))
        setWorkspaces(sorted)
        setAgentId((current) =>
          current !== undefined && nextAgents.some((agent) => agent.id === current)
            ? current
            : (nextAgents.find((agent) => agent.isDefault)?.id ?? nextAgents[0]?.id),
        )
        setFolder((current) =>
          current !== undefined && sorted.some((workspace) => workspace.folder === current)
            ? current
            : (sorted.find((workspace) => workspace.isOpen)?.folder ?? sorted[0]?.folder),
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
      const result = await client.newSession(agentId, {
        folder: workspace.folder,
        ...(workspace.authority !== undefined ? { authority: workspace.authority } : {}),
      })
      const ref = result?.ref
      if (ref === undefined) {
        setError(commandErrorText('invalid_response'))
        setSubmitting(false)
        return
      }
      const sessionKey = sessionRouteKey(ref)
      replaceWithSession(sessionKey)
      onCreated(sessionKey)
    } catch (err) {
      setSubmitting(false)
      setError(commandErrorText(errorCode(err)))
    }
  }

  const selectedWorkspace = workspaces.find((candidate) => candidate.folder === folder)
  const selectedAgent = agents.find((agent) => agent.id === agentId)
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
              <h2 className="new-session-label" id="new-session-agent-heading">
                {strings.newSessionAgentLabel}
              </h2>
              {selectedAgent === undefined ? (
                <p className="muted">{strings.newSessionNoAgents}</p>
              ) : (
                <>
                  <button
                    type="button"
                    className="choice new-session-select"
                    data-testid="new-session-agent-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={picker === 'agent'}
                    aria-labelledby="new-session-agent-heading new-session-agent-value"
                    disabled={disabled}
                    onClick={() => setPicker('agent')}
                  >
                    <span className="new-session-select__text" id="new-session-agent-value">
                      <span className="new-session-select__name">{selectedAgent.name}</span>
                    </span>
                    {selectedAgent.isDefault && (
                      <span className="session-badge">{strings.configCurrent}</span>
                    )}
                    <span className="new-session-select__chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                  {picker === 'agent' && (
                    <AgentPickerSheet
                      agents={agents}
                      selectedId={agentId}
                      disabled={disabled}
                      onSelect={setAgentId}
                      onClose={() => setPicker(undefined)}
                    />
                  )}
                </>
              )}
            </section>
            <section className="new-session-section">
              <h2 className="new-session-label" id="new-session-workspace-heading">
                {strings.newSessionWorkspaceLabel}
              </h2>
              {selectedWorkspace === undefined ? (
                <p className="muted">{strings.newSessionNoWorkspaces}</p>
              ) : (
                <>
                  <button
                    type="button"
                    className="choice new-session-select"
                    data-testid="new-session-workspace-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={picker === 'workspace'}
                    aria-labelledby="new-session-workspace-heading new-session-workspace-value"
                    disabled={disabled}
                    onClick={() => setPicker('workspace')}
                  >
                    <span className="new-session-select__text" id="new-session-workspace-value">
                      <span className="new-session-select__name">{selectedWorkspace.name}</span>
                      <span className="new-session-select__detail">{selectedWorkspace.folder}</span>
                    </span>
                    {selectedWorkspace.isOpen && (
                      <span className="session-badge">{strings.newSessionWorkspaceOpen}</span>
                    )}
                    {selectedWorkspace.gitDirty === true && (
                      <span className="session-badge" title={strings.workspaceDirtyTitle}>
                        {strings.badgeWorkspaceDirty}
                      </span>
                    )}
                    {isRemoteWorkspace(selectedWorkspace) && (
                      <span className="session-badge">{strings.newSessionWorkspaceRemote}</span>
                    )}
                    <span className="new-session-select__chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                  {picker === 'workspace' && (
                    <WorkspacePickerSheet
                      workspaces={workspaces}
                      selectedFolder={folder}
                      disabled={disabled}
                      onSelect={setFolder}
                      onClose={() => setPicker(undefined)}
                    />
                  )}
                </>
              )}
              {selectedWorkspace !== undefined && !selectedWorkspace.isOpen && (
                <p className="sheet__hint" data-testid="new-session-open-hint">
                  {strings.newSessionWorkspaceWillOpen}
                </p>
              )}
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
