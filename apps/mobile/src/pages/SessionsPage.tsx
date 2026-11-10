import type { MobileSessionHistoryEntry, MobileSessionRef } from '@universe-editor/mobile-protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NoticeBar } from '../components/NoticeBar.js'
import { Spinner } from '../components/Spinner.js'
import { errorCode } from '../errors.js'
import {
  buildSessionCatalog,
  countSessionCatalog,
  filterSessionCatalog,
  groupSessionCatalog,
  type SessionCatalogFilter,
  type SessionCatalogRow,
} from '../history/sessionCatalog.js'
import { formatUpdatedAt } from '../inbox/groupSessions.js'
import type { MobileClient } from '../state/mobileClient.js'
import { useStore } from '../state/useStore.js'
import { commandErrorText, strings } from '../strings.js'

export type SessionsClient = Pick<
  MobileClient,
  'listSessionHistory' | 'resumeSession' | 'getInboxStore' | 'getSocketStateStore'
>

/** Workspace context carried alongside a catalog row opened from a closed workspace. */
export interface SessionWorkspaceHint {
  readonly folder: string
  readonly authority?: string
}

export interface SessionsPageProps {
  readonly client: SessionsClient
  /** False while the page is kept mounted behind an open session. */
  readonly active?: boolean | undefined
  readonly notice?: string | undefined
  readonly onDismissNotice?: (() => void) | undefined
  readonly onBack: () => void
  readonly onOpenSessionRef: (ref: MobileSessionRef, workspaceHint?: SessionWorkspaceHint) => void
}

const FILTERS: readonly { readonly id: SessionCatalogFilter; readonly label: string }[] = [
  { id: 'all', label: strings.sessionsFilterAll },
  { id: 'live', label: strings.sessionsFilterLive },
  { id: 'closed', label: strings.sessionsFilterClosed },
]

const COUNTS: Readonly<
  Record<SessionCatalogFilter, (counts: ReturnType<typeof countSessionCatalog>) => number>
> = {
  all: (counts) => counts.all,
  live: (counts) => counts.live,
  closed: (counts) => counts.closed,
}

export function SessionsPage({
  client,
  active,
  notice,
  onDismissNotice,
  onBack,
  onOpenSessionRef,
}: SessionsPageProps) {
  const inbox = useStore(client.getInboxStore())
  const socketState = useStore(client.getSocketStateStore())
  const online = socketState === 'connected'
  const isActive = active !== false
  const aliveRef = useRef(true)

  const [history, setHistory] = useState<readonly MobileSessionHistoryEntry[] | undefined>(
    undefined,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SessionCatalogFilter>('all')
  const [reloadKey, setReloadKey] = useState(0)
  const [openingKey, setOpeningKey] = useState<string | undefined>(undefined)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isActive || !online) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void client
      .listSessionHistory()
      .then((rows) => {
        if (cancelled) return
        setHistory(rows)
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
  }, [client, isActive, online, reloadKey])

  const catalog = useMemo(
    () => buildSessionCatalog(history ?? [], inbox.sessions),
    [history, inbox.sessions],
  )
  const searched = useMemo(() => filterSessionCatalog(catalog, 'all', query), [catalog, query])
  const counts = useMemo(() => countSessionCatalog(searched), [searched])
  const visible = useMemo(
    () => filterSessionCatalog(catalog, filter, query),
    [catalog, filter, query],
  )
  const groups = useMemo(() => groupSessionCatalog(visible), [visible])

  const openRow = (row: SessionCatalogRow): void => {
    if (openingKey !== undefined || !online) return
    if (row.ref !== undefined) {
      onOpenSessionRef(row.ref)
      return
    }
    const durableId = row.durableId
    if (durableId === undefined) return
    setOpeningKey(row.key)
    setError(undefined)
    void client
      .resumeSession(durableId, row.windowId, row.folder, row.authority)
      .then((result) => {
        if (!aliveRef.current) return
        setOpeningKey(undefined)
        if (row.folder === undefined) {
          onOpenSessionRef(result.ref)
        } else {
          onOpenSessionRef(result.ref, {
            folder: row.folder,
            ...(row.authority !== undefined ? { authority: row.authority } : {}),
          })
        }
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return
        setOpeningKey(undefined)
        setError(commandErrorText(errorCode(err)))
      })
  }

  const refresh = (): void => setReloadKey((value) => value + 1)

  return (
    <div className="sessions-page">
      <header className="sessions-header">
        <button
          type="button"
          className="session-header__back"
          aria-label={strings.sessionsBack}
          onClick={onBack}
        >
          ‹
        </button>
        <h1 className="sessions-title">{strings.sessionsTitle}</h1>
        <button
          type="button"
          className="text-button"
          data-testid="sessions-refresh"
          disabled={!online || loading}
          onClick={refresh}
        >
          {strings.sessionsRefresh}
        </button>
      </header>
      <main className="sessions-body">
        {!online && (
          <div className="offline-banner" role="status">
            <span className="offline-banner__dot" aria-hidden="true" />
            <span>{strings.sessionsOfflineBanner}</span>
          </div>
        )}
        {notice !== undefined && onDismissNotice !== undefined && (
          <NoticeBar text={notice} onDismiss={onDismissNotice} />
        )}
        {error !== undefined && history !== undefined && (
          <NoticeBar text={error} onDismiss={() => setError(undefined)} />
        )}
        {history === undefined ? (
          renderFirstLoad()
        ) : catalog.length === 0 ? (
          <div className="state-card" data-testid="sessions-empty">
            <p>{strings.sessionsEmptyTitle}</p>
            <p className="muted">{strings.sessionsEmptyBody}</p>
          </div>
        ) : (
          <>
            <input
              type="search"
              className="field__input"
              data-testid="sessions-search"
              value={query}
              placeholder={strings.sessionsSearchPlaceholder}
              aria-label={strings.sessionsSearchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="sessions-filters" role="group">
              {FILTERS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`sessions-filter${filter === option.id ? ' sessions-filter--active' : ''}`}
                  data-testid={`sessions-filter-${option.id}`}
                  aria-pressed={filter === option.id}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                  <span className="sessions-filter__count">{COUNTS[option.id](counts)}</span>
                </button>
              ))}
            </div>
            {visible.length === 0 ? (
              <div className="state-card" data-testid="sessions-no-match">
                <p>{strings.sessionsNoMatch}</p>
              </div>
            ) : (
              <div className={`inbox-groups${online ? '' : ' inbox-groups--stale'}`}>
                {groups.map((group) => (
                  <section
                    key={group.bucket}
                    className="inbox-group"
                    aria-labelledby={`sessions-bucket-${group.bucket}`}
                  >
                    <h2 id={`sessions-bucket-${group.bucket}`} className="inbox-group__title">
                      {group.label}
                      <span className="inbox-group__count">{group.rows.length}</span>
                    </h2>
                    <ul className="inbox-group__list">
                      {group.rows.map((row) => (
                        <li key={row.key}>
                          <SessionCatalogRowView
                            row={row}
                            disabled={!online || openingKey !== undefined}
                            opening={openingKey === row.key}
                            onOpen={() => openRow(row)}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )

  function renderFirstLoad() {
    if (error !== undefined) {
      return (
        <div className="state-card" data-testid="sessions-error">
          <p>{error}</p>
          <button
            type="button"
            className="button button--primary"
            disabled={!online}
            onClick={refresh}
          >
            {strings.sessionRetry}
          </button>
        </div>
      )
    }
    if (!online) {
      return (
        <div className="state-card" data-testid="sessions-offline">
          <p>{strings.sessionsOffline}</p>
        </div>
      )
    }
    return (
      <div className="state-card state-card--row" data-testid="sessions-loading">
        <Spinner />
        <p>{strings.sessionsLoading}</p>
      </div>
    )
  }
}

interface SessionCatalogRowViewProps {
  readonly row: SessionCatalogRow
  readonly disabled: boolean
  readonly opening: boolean
  readonly onOpen: () => void
}

function SessionCatalogRowView({ row, disabled, opening, onOpen }: SessionCatalogRowViewProps) {
  const badges: string[] = []
  if (row.live) badges.push(strings.sessionsLiveBadge)
  if (row.pinned) badges.push(strings.sessionsPinnedBadge)
  return (
    <button
      type="button"
      className="session-card"
      data-testid="sessions-row"
      data-session-key={row.key}
      disabled={disabled}
      aria-busy={opening || undefined}
      onClick={onOpen}
    >
      <span
        className={`session-card__dot ${
          row.live ? `session-card__dot--${row.status ?? 'completed'}` : 'session-card__dot--closed'
        }`}
        aria-hidden="true"
      />
      <span className="session-card__main">
        <span className="session-card__topline">
          <span className="session-card__title">{row.title}</span>
          <span className="session-card__time">{formatUpdatedAt(row.updatedAt)}</span>
        </span>
        {row.firstPrompt !== undefined && (
          <span className="sessions-row__prompt">{row.firstPrompt}</span>
        )}
        <span className="session-card__meta">
          <span className="session-card__agent">{row.agentLabel}</span>
          {row.workspaceName !== '' && (
            <span className="session-card__workspace">{row.workspaceName}</span>
          )}
        </span>
        {!row.live && row.windowId === undefined && row.folder !== undefined && (
          <span className="sessions-row__hint" data-testid="sessions-row-open-hint">
            {strings.sessionsWillOpenWorkspace}
          </span>
        )}
        {badges.length > 0 && (
          <span className="session-card__badges">
            {badges.map((badge) => (
              <span key={badge} className="session-badge">
                {badge}
              </span>
            ))}
          </span>
        )}
        {opening && (
          <span className="sessions-row__opening">
            <Spinner size="small" label={strings.sessionsOpening} />
            {strings.sessionsOpening}
          </span>
        )}
      </span>
    </button>
  )
}
