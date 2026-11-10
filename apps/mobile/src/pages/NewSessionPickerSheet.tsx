import type {
  MobileAgentCandidate,
  MobileWorkspaceCandidate,
} from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { strings } from '../strings.js'

export interface AgentPickerSheetProps {
  readonly agents: readonly MobileAgentCandidate[]
  readonly selectedId: string | undefined
  readonly disabled: boolean
  readonly onSelect: (id: string) => void
  readonly onClose: () => void
}

export function AgentPickerSheet({
  agents,
  selectedId,
  disabled,
  onSelect,
  onClose,
}: AgentPickerSheetProps) {
  return (
    <BottomSheet
      title={strings.newSessionAgentLabel}
      testId="new-session-agent-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
    >
      <div className="choice-list" role="listbox" aria-label={strings.newSessionAgentLabel}>
        {agents.map((agent) => {
          const selected = agent.id === selectedId
          return (
            <button
              key={agent.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={`choice${selected ? ' choice--selected' : ''}`}
              data-testid="new-session-agent"
              data-agent-id={agent.id}
              disabled={disabled}
              onClick={() => {
                onSelect(agent.id)
                onClose()
              }}
            >
              <span className="choice__label">{agent.name}</span>
              {agent.isDefault && <span className="session-badge">{strings.configCurrent}</span>}
            </button>
          )
        })}
      </div>
    </BottomSheet>
  )
}

export interface WorkspacePickerSheetProps {
  readonly workspaces: readonly MobileWorkspaceCandidate[]
  readonly selectedFolder: string | undefined
  readonly disabled: boolean
  readonly onSelect: (folder: string) => void
  readonly onClose: () => void
}

export function WorkspacePickerSheet({
  workspaces,
  selectedFolder,
  disabled,
  onSelect,
  onClose,
}: WorkspacePickerSheetProps) {
  const [query, setQuery] = useState('')
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const node = selectedRef.current
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
  }, [])

  const needle = query.trim().toLowerCase()
  const matches =
    needle === ''
      ? workspaces
      : workspaces.filter(
          (workspace) =>
            workspace.name.toLowerCase().includes(needle) ||
            workspace.folder.toLowerCase().includes(needle) ||
            (workspace.authority?.toLowerCase().includes(needle) ?? false),
        )
  const openGroup = matches.filter((workspace) => workspace.isOpen)
  const recentGroup = matches.filter((workspace) => !workspace.isOpen)

  const renderWorkspace = (workspace: MobileWorkspaceCandidate) => {
    const selected = workspace.folder === selectedFolder
    return (
      <button
        key={workspace.folder}
        ref={selected ? selectedRef : undefined}
        type="button"
        role="option"
        aria-selected={selected}
        className={`choice${selected ? ' choice--selected' : ''}`}
        data-testid="new-session-workspace"
        data-folder={workspace.folder}
        disabled={disabled}
        onClick={() => {
          onSelect(workspace.folder)
          onClose()
        }}
      >
        <span className="choice__label new-session-option__text">
          <span>{workspace.name}</span>
          <span className="new-session-option__path">{workspace.folder}</span>
        </span>
        {workspace.isOpen && (
          <span className="session-badge">{strings.newSessionWorkspaceOpen}</span>
        )}
        {workspace.gitDirty === true && (
          <span className="session-badge" title={strings.workspaceDirtyTitle}>
            {strings.badgeWorkspaceDirty}
          </span>
        )}
        {isRemoteWorkspace(workspace) && (
          <span className="session-badge">{strings.newSessionWorkspaceRemote}</span>
        )}
      </button>
    )
  }

  return (
    <BottomSheet
      title={strings.newSessionWorkspaceLabel}
      testId="new-session-workspace-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
    >
      <div className="new-session-picker">
        <div className="new-session-search">
          <label className="visually-hidden" htmlFor="new-session-workspace-search">
            {strings.newSessionSearchLabel}
          </label>
          <input
            id="new-session-workspace-search"
            className="sheet__input"
            data-testid="new-session-workspace-search"
            type="search"
            autoComplete="off"
            enterKeyHint="search"
            placeholder={strings.newSessionSearchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {matches.length === 0 ? (
          <p className="sheet__hint" data-testid="new-session-workspace-empty">
            {strings.newSessionNoMatch}
          </p>
        ) : (
          <div
            className="new-session-picker__list"
            role="listbox"
            aria-label={strings.newSessionWorkspaceLabel}
          >
            {openGroup.length > 0 && (
              <div
                className="new-session-picker__group"
                role="group"
                aria-label={strings.newSessionGroupOpen}
                data-testid="new-session-workspace-group-open"
              >
                <div className="new-session-picker__group-title" aria-hidden="true">
                  {strings.newSessionGroupOpen}
                </div>
                <div className="choice-list">{openGroup.map(renderWorkspace)}</div>
              </div>
            )}
            {recentGroup.length > 0 && (
              <div
                className="new-session-picker__group"
                role="group"
                aria-label={strings.newSessionGroupRecent}
                data-testid="new-session-workspace-group-recent"
              >
                <div className="new-session-picker__group-title" aria-hidden="true">
                  {strings.newSessionGroupRecent}
                </div>
                <div className="choice-list">{recentGroup.map(renderWorkspace)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  )
}

export function isRemoteWorkspace(workspace: MobileWorkspaceCandidate): boolean {
  return workspace.authority !== undefined || workspace.folder.startsWith('remote-ssh:')
}
