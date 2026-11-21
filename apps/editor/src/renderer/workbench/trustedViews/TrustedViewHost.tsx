/*---------------------------------------------------------------------------------------------
 *  TrustedViewHost — mounts one `contributes.trustedViews` component (sidebar
 *  view or editor tab). Loading and render failures degrade to a local
 *  placeholder; a broken extension must never take the workbench down.
 *
 *  Each mount owns one session. A component starts loading only after the
 *  translator registered its view and the host-side provider announced itself;
 *  `onDidInvalidateSessions` (extension-host restart / provider disposal)
 *  remounts the session so it can re-resolve against the new host.
 *--------------------------------------------------------------------------------------------*/

import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { localize, type IEditorInput } from '@universe-editor/platform'
import type {
  TrustedViewComponentProps,
  TrustedViewContext,
} from '@universe-editor/trusted-view-api'
import { useService } from '../useService.js'
import { ITrustedViewService } from '../../services/trustedViews/TrustedViewService.js'
import { TrustedViewEditorInput } from '../../services/editor/TrustedViewEditorInput.js'
import type { IViewComponentProps } from '../../services/views/ViewComponentRegistry.js'
import styles from './TrustedViewHost.module.css'

export interface ITrustedViewHostProps {
  readonly viewId: string
  readonly state?: unknown
  readonly setTitle?: (title: string) => void
  /** Fired once the view's manifest contribution is known (late registration included). */
  readonly onRegistration?: (extensionId: string, name: string) => void
}

interface ILoadedView {
  readonly component: ComponentType<TrustedViewComponentProps>
  readonly context: TrustedViewContext
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function errorText(err: Error): string {
  return err.message
}

class TrustedViewErrorBoundary extends Component<
  { readonly extensionId: string; readonly children: ReactNode },
  { readonly error: Error | null }
> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className={styles.message} data-testid="trusted-view-error">
          {localize('trustedView.renderError', 'Trusted view from {0} crashed: {1}', {
            0: this.props.extensionId,
            1: errorText(this.state.error),
          })}
        </div>
      )
    }
    return this.props.children
  }
}

export function TrustedViewHost({
  viewId,
  state,
  setTitle,
  onRegistration,
}: ITrustedViewHostProps) {
  const trustedViews = useService(ITrustedViewService)
  const [generation, setGeneration] = useState(0)
  const [loaded, setLoaded] = useState<ILoadedView | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const currentSessionId = useRef<string>('')

  useEffect(() => {
    const subscription = trustedViews.onDidInvalidateSessions((event) => {
      if (event.viewId !== undefined && event.viewId !== viewId) return
      setGeneration((value) => value + 1)
    })
    return () => subscription.dispose()
  }, [trustedViews, viewId])

  // A timed-out session is not terminal: when the late registration/provider
  // arrives the service reports that exact session so only this mount remounts.
  useEffect(() => {
    const subscription = trustedViews.onDidBecomeAvailable((event) => {
      if (event.viewId !== viewId || event.sessionId !== currentSessionId.current) return
      setGeneration((value) => value + 1)
    })
    return () => subscription.dispose()
  }, [trustedViews, viewId])

  // Late contribution registration: an editor tab can restore before the
  // extension host re-scans / the user trusts the extension. Report the name
  // as soon as it is known so the tab label is not stuck on the raw view id.
  useEffect(() => {
    if (!onRegistration) return
    const report = (): void => {
      const registration = trustedViews.getView(viewId)
      if (!registration) return
      onRegistration(registration.extensionId, registration.contribution.name)
    }
    report()
    const subscription = trustedViews.onDidChangeView((changed) => {
      if (changed === viewId) report()
    })
    return () => subscription.dispose()
  }, [trustedViews, viewId, onRegistration])

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    const handle = trustedViews.beginSession(viewId, {
      ...(state !== undefined ? { state } : {}),
      ...(setTitle !== undefined ? { setTitle } : {}),
    })
    currentSessionId.current = handle.sessionId
    handle.ready.then(
      (component) => {
        if (cancelled) return
        setLoaded({ component, context: handle.context })
      },
      (err: unknown) => {
        if (cancelled) return
        setError(toError(err))
      },
    )
    return () => {
      cancelled = true
      handle.dispose()
    }
  }, [trustedViews, viewId, generation, state, setTitle])

  const extensionId = trustedViews.getView(viewId)?.extensionId ?? 'unknown'
  const LoadedComponent = loaded?.component

  return (
    <div
      className={styles.root}
      data-testid="trusted-view"
      data-view-id={viewId}
      data-extension-id={extensionId}
    >
      {error !== null ? (
        <div className={styles.message} data-testid="trusted-view-error">
          <span>
            {localize('trustedView.loadError', 'Could not load trusted view {0} from {1}: {2}', {
              0: viewId,
              1: extensionId,
              2: errorText(error),
            })}
          </span>
          <button
            type="button"
            data-testid="trusted-view-retry"
            onClick={() => setGeneration((value) => value + 1)}
          >
            {localize('trustedView.retry', 'Retry')}
          </button>
        </div>
      ) : loaded !== null && LoadedComponent !== undefined ? (
        <TrustedViewErrorBoundary extensionId={extensionId}>
          <LoadedComponent context={loaded.context} />
        </TrustedViewErrorBoundary>
      ) : (
        <div className={styles.message} data-testid="trusted-view-loading">
          {localize('trustedView.loading', 'Loading trusted view…')}
        </div>
      )}
    </div>
  )
}

/** ViewComponentRegistry binding shared by every contributed trusted view. */
export function TrustedViewView({ viewId }: IViewComponentProps) {
  if (viewId === undefined) return null
  return <TrustedViewHost viewId={viewId} />
}

/** Editor binding for `TrustedViewEditorInput`. */
export function TrustedViewEditor({ input }: { input: IEditorInput }) {
  const trusted = input instanceof TrustedViewEditorInput ? input : undefined
  const setTitle = useCallback(
    (title: string) => {
      trusted?.setTitle(title)
    },
    [trusted],
  )
  const onRegistration = useCallback(
    (_extensionId: string, name: string) => {
      trusted?.setContributionName(name)
    },
    [trusted],
  )
  if (!trusted) return null
  return (
    <TrustedViewHost
      viewId={trusted.viewId}
      state={trusted.state}
      setTitle={setTitle}
      onRegistration={onRegistration}
    />
  )
}
