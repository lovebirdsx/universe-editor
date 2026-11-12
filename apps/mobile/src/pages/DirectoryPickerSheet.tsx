import {
  parentWorkspaceRelativePath,
  type MobileDirectoryListing,
} from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { Spinner } from '../components/Spinner.js'
import { errorCode } from '../errors.js'
import { commandErrorText, strings } from '../strings.js'

export interface DirectoryPickerSheetProps {
  readonly initialRelativePath: string
  readonly disabled: boolean
  /** Configured project roots inside the workspace (workspace-relative). */
  readonly projectRoots: readonly string[]
  /** `relativePath` is '' for the workspace root. */
  readonly listDirectory: (relativePath: string) => Promise<MobileDirectoryListing>
  readonly onSelect: (relativePath: string) => void
  readonly onClose: () => void
}

function directoryErrorMessage(error: unknown): string {
  const code = errorCode(error)
  if (code === 'bad_request') return strings.directoryPickerInvalid
  if (code === 'workspace_not_open') return strings.directoryPickerWorkspaceUnavailable
  if (code === undefined) return strings.directoryPickerFailed
  return commandErrorText(code)
}

export function DirectoryPickerSheet({
  initialRelativePath,
  disabled,
  projectRoots,
  listDirectory,
  onSelect,
  onClose,
}: DirectoryPickerSheetProps) {
  const [currentPath, setCurrentPath] = useState(initialRelativePath)
  const [listing, setListing] = useState<MobileDirectoryListing | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [reloadKey, setReloadKey] = useState(0)
  // The page passes an inline closure; keeping it in a ref avoids reloading the
  // current directory on every parent render.
  const listDirectoryRef = useRef(listDirectory)
  useEffect(() => {
    listDirectoryRef.current = listDirectory
  }, [listDirectory])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setListing(undefined)
    void listDirectoryRef
      .current(currentPath)
      .then((next) => {
        if (cancelled) return
        setListing(next)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(directoryErrorMessage(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentPath, reloadKey])

  const parent =
    currentPath === ''
      ? undefined
      : (listing?.parentRelativePath ?? parentWorkspaceRelativePath(currentPath))

  return (
    <BottomSheet
      title={strings.directoryPickerTitle}
      testId="new-session-directory-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
    >
      <div className="new-session-picker">
        <div className="directory-picker__path" data-testid="new-session-directory-path">
          {currentPath === '' ? strings.newSessionDirectoryRoot : currentPath}
        </div>
        <div className="directory-picker__actions">
          <button
            type="button"
            className="text-button"
            data-testid="new-session-directory-up"
            disabled={disabled || parent === undefined}
            onClick={() => {
              if (parent !== undefined) setCurrentPath(parent)
            }}
          >
            {strings.directoryPickerUp}
          </button>
          {loading && <Spinner />}
        </div>
        {projectRoots.length > 0 && (
          <div
            className="new-session-picker__group"
            data-testid="new-session-directory-project-roots"
          >
            <div className="new-session-picker__group-title" aria-hidden="true">
              {strings.directoryPickerProjectRoots}
            </div>
            <div
              className="choice-list"
              role="group"
              aria-label={strings.directoryPickerProjectRoots}
            >
              {projectRoots.map((root) => {
                const current = root === currentPath
                return (
                  <button
                    key={root}
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    className={`choice${current ? ' choice--selected' : ''}`}
                    data-testid="new-session-directory-project-root"
                    data-relative-path={root}
                    disabled={disabled}
                    onClick={() => {
                      if (current) setReloadKey((value) => value + 1)
                      else setCurrentPath(root)
                    }}
                  >
                    <span className="choice__label">{root}</span>
                    <span className="new-session-select__chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {error !== undefined ? (
          <div className="directory-picker__error">
            <p className="sheet__hint" role="alert" data-testid="new-session-directory-error">
              {error}
            </p>
            <button
              type="button"
              className="text-button"
              data-testid="new-session-directory-retry"
              disabled={disabled}
              onClick={() => setReloadKey((value) => value + 1)}
            >
              {strings.directoryPickerRetry}
            </button>
          </div>
        ) : listing !== undefined ? (
          listing.entries.length === 0 ? (
            <p className="sheet__hint" data-testid="new-session-directory-empty">
              {strings.directoryPickerEmpty}
            </p>
          ) : (
            <div
              className="new-session-picker__list"
              role="listbox"
              aria-label={strings.directoryPickerTitle}
            >
              <div className="choice-list">
                {listing.entries.map((entry) => (
                  <button
                    key={entry.relativePath}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="choice"
                    data-testid="new-session-directory-entry"
                    data-relative-path={entry.relativePath}
                    disabled={disabled}
                    onClick={() => setCurrentPath(entry.relativePath)}
                  >
                    <span className="choice__label">{entry.name}</span>
                    <span className="new-session-select__chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : null}
        {listing?.truncated === true && (
          <p className="sheet__hint" data-testid="new-session-directory-truncated">
            {strings.directoryPickerTruncated}
          </p>
        )}
        <button
          type="button"
          className="button button--primary"
          data-testid="new-session-directory-select"
          disabled={disabled || loading || listing === undefined}
          onClick={() => {
            onSelect(currentPath)
            onClose()
          }}
        >
          {strings.directoryPickerSelect}
        </button>
      </div>
    </BottomSheet>
  )
}
