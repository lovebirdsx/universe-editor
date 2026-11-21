/**
 * Renderer-side owner of trusted-view components (`contributes.trustedViews`).
 *
 * The service keeps the registry the translator fills after the trust gate,
 * imports each view's browser ESM entry (with `universe-app` resource access
 * granted for the extension directory), and owns the per-mount component
 * session: `onView:<id>` activation, provider-registration wait, extension-host
 * `$resolveSession`/`$disposeSession`, event routing back into the component
 * and teardown on extension-host restart.
 *
 * The service never exposes DI or renderer internals to a component; the only
 * bridge is the {@link TrustedViewContext} built here.
 */
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import type { ComponentType } from 'react'
import {
  Disposable,
  Emitter,
  IHostService,
  ILoggerService,
  URI,
  createDecorator,
  dirname,
  relativePathUnder,
  type Event,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import {
  viewActivationEvent,
  type IExtHostTrustedViews,
  type ITrustedViewContribution,
} from '@universe-editor/extensions-common'
import {
  getTrustedViewsRuntime,
  setTrustedViewsRuntime,
  type TrustedViewComponentProps,
  type TrustedViewContext,
  type TrustedViewLocation,
} from '@universe-editor/trusted-view-api'
import { IResourceAccessService } from '../../../shared/ipc/resourceAccessService.js'
import { toResourceUrl } from '../../../shared/appResourceUrl.js'

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000

/** A translated (trusted) view, as recorded by the contribution translator. */
export interface ITrustedViewRegistration {
  readonly viewId: string
  readonly extensionId: string
  readonly extensionLocation: URI
  readonly contribution: ITrustedViewContribution
}

export interface ITrustedViewSessionOptions {
  /** Editor: state from `openTrustedEditor`; view: omitted. */
  readonly state?: unknown
  /** Editor tab label updater; omitted for sidebar views. */
  readonly setTitle?: (title: string) => void
}

export interface ITrustedViewSessionHandle {
  readonly sessionId: string
  readonly context: TrustedViewContext
  /** Resolves with the module's default component once the session is resolved. */
  readonly ready: Promise<ComponentType<TrustedViewComponentProps>>
  dispose(): void
}

/** A session that timed out but can be revived by a late registration. */
export interface ITrustedViewAvailableEvent {
  readonly viewId: string
  readonly sessionId: string
}

export interface ITrustedViewService {
  readonly _serviceBrand: undefined

  /** Fires when a view id is registered or unregistered (re-translation). */
  readonly onDidChangeView: Event<string>
  /** Fires when the extension host restarted / disconnected (all) or one view's provider went away. */
  readonly onDidInvalidateSessions: Event<{ readonly viewId?: string }>
  /**
   * A failed session's missing piece (view registration or provider) arrived.
   * Only failed sessions are reported; healthy sessions are not disturbed.
   */
  readonly onDidBecomeAvailable: Event<ITrustedViewAvailableEvent>

  /** Register a translated trusted view. Throws when the view id is taken. */
  registerView(registration: ITrustedViewRegistration): IDisposable
  hasView(viewId: string): boolean
  getView(viewId: string): ITrustedViewRegistration | undefined

  /** Wire the host proxies for the current connection. */
  setExtHost(
    extHost: IExtHostTrustedViews | undefined,
    activateByEvent?: (event: string) => Promise<void>,
  ): void

  /** Create a session synchronously; `ready` drives loading / error UI. */
  beginSession(viewId: string, options?: ITrustedViewSessionOptions): ITrustedViewSessionHandle

  /** `MainThreadTrustedViews.$registerProvider` — wake sessions waiting on the provider. */
  markProviderRegistered(viewId: string): void
  /**
   * A provider announced itself before its view was translated. Startup-activated
   * extensions (e.g. `onStartupFinished`) can do this while an untrusted extension
   * is still waiting for "Trust and Load"; keep the announcement and replay it on
   * {@link registerView}. Ownership is already enforced host-side from the scanned
   * manifest, so the renderer only has to remember the pair.
   */
  markProviderPending(extensionId: string, viewId: string): void
  /** A provider was disposed: drop its sessions and let components re-resolve. */
  markProviderUnregistered(viewId: string): void
  /** `MainThreadTrustedViews.$postEvent`: route into the mounted session. */
  postEvent(sessionId: string, name: string, data: unknown): void
  /** Extension host teardown: invalidate every session and drop the proxies. */
  reset(): void

  /** Import the view's entry module (cached per view id). */
  loadComponent(viewId: string): Promise<ComponentType<TrustedViewComponentProps>>

  /** Test seam: replace the dynamic `import()` implementation. */
  setModuleLoader(loader: (url: string) => Promise<unknown>): void
  /** Test seam: shrink the provider / registration wait windows. */
  setSessionTimeouts(providerMs: number, registrationMs: number): void
}

export const ITrustedViewService = createDecorator<ITrustedViewService>('trustedViewService')

type TrustedViewModuleLoader = (url: string) => Promise<unknown>

const DEFAULT_LOADER: TrustedViewModuleLoader = (url) => import(/* @vite-ignore */ url)

interface IActiveSession {
  readonly id: string
  readonly viewId: string
  readonly state: unknown
  readonly setTitle: ((title: string) => void) | undefined
  readonly listeners: Set<(name: string, data: unknown) => void>
  readonly styles: HTMLStyleElement[]
  readonly abort: AbortController
  registration: ITrustedViewRegistration | undefined
  resolved: boolean
  /** Timed out on registration/provider; may be revived by a late arrival. */
  failed: boolean
  /** `onDidBecomeAvailable` was already fired for this failed session. */
  revived: boolean
  disposed: boolean
}

export class TrustedViewService extends Disposable implements ITrustedViewService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private _loader: TrustedViewModuleLoader = DEFAULT_LOADER
  private _providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS
  private _registrationTimeoutMs = DEFAULT_REGISTRATION_TIMEOUT_MS

  private readonly _views = new Map<string, ITrustedViewRegistration>()
  private readonly _components = new Map<
    string,
    Promise<ComponentType<TrustedViewComponentProps>>
  >()
  private readonly _sessions = new Map<string, IActiveSession>()
  /** View ids whose host-side provider announced itself. */
  private readonly _providers = new Set<string>()
  /** viewId → extensionId for providers announced before their view translated. */
  private readonly _pendingProviders = new Map<string, string>()
  private _extHost: IExtHostTrustedViews | undefined
  private _activateByEvent: ((event: string) => Promise<void>) | undefined
  private _runtimeInstalled = false

  private readonly _onDidChangeView = this._register(new Emitter<string>())
  readonly onDidChangeView: Event<string> = this._onDidChangeView.event
  private readonly _onDidInvalidateSessions = this._register(
    new Emitter<{ readonly viewId?: string }>(),
  )
  readonly onDidInvalidateSessions: Event<{ readonly viewId?: string }> =
    this._onDidInvalidateSessions.event
  private readonly _onDidBecomeAvailable = this._register(new Emitter<ITrustedViewAvailableEvent>())
  readonly onDidBecomeAvailable: Event<ITrustedViewAvailableEvent> =
    this._onDidBecomeAvailable.event
  private readonly _onDidRegisterProvider = this._register(new Emitter<string>())
  private readonly _onDidReset = this._register(new Emitter<void>())

  constructor(
    @IResourceAccessService private readonly _resourceAccess: IResourceAccessService,
    @ILoggerService loggerService: ILoggerService,
    @IHostService private readonly _host: IHostService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'trustedViews', name: 'Trusted Views' })
  }

  /**
   * Test seam: replace the dynamic `import()` used to load entry modules.
   * A constructor parameter cannot express this — the DI service-argument
   * inference requires every trailing parameter to be a branded service.
   */
  setModuleLoader(loader: TrustedViewModuleLoader): void {
    this._loader = loader
  }

  setSessionTimeouts(providerMs: number, registrationMs: number): void {
    this._providerTimeoutMs = providerMs
    this._registrationTimeoutMs = registrationMs
  }

  // --- registry -----------------------------------------------------------

  registerView(registration: ITrustedViewRegistration): IDisposable {
    if (this._views.has(registration.viewId)) {
      throw new Error(`trusted view id is already registered: ${registration.viewId}`)
    }
    this._views.set(registration.viewId, registration)
    this._logger.info(
      `registered trusted view ${registration.extensionId} / ${registration.viewId} (${registration.contribution.location})`,
    )
    this._adoptPendingProvider(registration)
    this._onDidChangeView.fire(registration.viewId)
    this._reviveFailedSessions(registration.viewId)
    return {
      dispose: () => {
        if (this._views.get(registration.viewId) !== registration) return
        this._views.delete(registration.viewId)
        this._components.delete(registration.viewId)
        this._onDidChangeView.fire(registration.viewId)
        this._invalidateSessions(registration.viewId)
      },
    }
  }

  hasView(viewId: string): boolean {
    return this._views.has(viewId)
  }

  getView(viewId: string): ITrustedViewRegistration | undefined {
    return this._views.get(viewId)
  }

  setExtHost(
    extHost: IExtHostTrustedViews | undefined,
    activateByEvent?: (event: string) => Promise<void>,
  ): void {
    this._extHost = extHost
    this._activateByEvent = activateByEvent
  }

  // --- module loading -----------------------------------------------------

  loadComponent(viewId: string): Promise<ComponentType<TrustedViewComponentProps>> {
    const cached = this._components.get(viewId)
    if (cached) return cached

    const registration = this._views.get(viewId)
    if (!registration) {
      return Promise.reject(new Error(`trusted view "${viewId}" is not registered`))
    }
    const pending = this._importComponent(registration)
    this._components.set(viewId, pending)
    // A failed import must not be cached forever: a later remount retries.
    void pending.catch(() => {
      if (this._components.get(viewId) === pending) this._components.delete(viewId)
    })
    return pending
  }

  private async _importComponent(
    registration: ITrustedViewRegistration,
  ): Promise<ComponentType<TrustedViewComponentProps>> {
    const location = registration.extensionLocation
    if (location.scheme !== 'file') {
      throw new Error(
        `trusted view "${registration.viewId}" lives in a ${location.scheme} extension; only local extensions can provide renderer components`,
      )
    }
    const rootPath = location.fsPath
    const entryPath = URI.joinPath(location, registration.contribution.entry).fsPath
    const relative = relativePathUnder(rootPath, entryPath, this._host.platform)
    if (relative === null || relative === '') {
      throw new Error(
        `trusted view "${registration.viewId}" entry escapes the extension directory: ${registration.contribution.entry}`,
      )
    }
    if (!/\.(?:m?js)$/i.test(entryPath)) {
      throw new Error(
        `trusted view "${registration.viewId}" entry must be a .js/.mjs module: ${registration.contribution.entry}`,
      )
    }

    await this._resourceAccess.allowRoots([dirname(entryPath)])
    this._installRuntime()
    const url = toResourceUrl(entryPath)
    this._logger.debug(`importing trusted view "${registration.viewId}" from ${url}`)
    const module: unknown = await this._loader(url)
    const component = (module as { default?: unknown } | null | undefined)?.default
    if (typeof component !== 'function') {
      throw new Error(
        `trusted view "${registration.viewId}" entry must default-export a React function component`,
      )
    }
    return component as ComponentType<TrustedViewComponentProps>
  }

  private _installRuntime(): void {
    if (this._runtimeInstalled) return
    if (!getTrustedViewsRuntimeOrUndefined()) {
      setTrustedViewsRuntime({ React, jsxRuntime })
    }
    this._runtimeInstalled = true
  }

  // --- sessions -----------------------------------------------------------

  beginSession(
    viewId: string,
    options: ITrustedViewSessionOptions = {},
  ): ITrustedViewSessionHandle {
    const session: IActiveSession = {
      id: crypto.randomUUID(),
      viewId,
      state: options.state,
      setTitle: options.setTitle,
      listeners: new Set(),
      styles: [],
      abort: new AbortController(),
      registration: this._views.get(viewId),
      resolved: false,
      failed: false,
      revived: false,
      disposed: false,
    }
    this._sessions.set(session.id, session)
    const context = this._createContext(session)
    const ready = this._startSession(session)
    void ready.catch(() => {
      if (!session.disposed) session.failed = true
    })
    return {
      sessionId: session.id,
      context,
      ready,
      dispose: () => this._disposeSession(session),
    }
  }

  private async _startSession(
    session: IActiveSession,
  ): Promise<ComponentType<TrustedViewComponentProps>> {
    const registration = await this._waitForRegistration(session)
    session.registration = registration
    this._throwIfDisposed(session)

    try {
      await this._activateByEvent?.(viewActivationEvent(registration.viewId))
    } catch (err) {
      this._logger.warn(
        `failed to activate ${registration.extensionId} for trusted view "${registration.viewId}": ${errorMessage(err)}`,
      )
    }
    this._throwIfDisposed(session)

    const component = await this.loadComponent(registration.viewId)
    this._throwIfDisposed(session)

    await this._waitForProvider(session)
    this._throwIfDisposed(session)

    const extHost = this._extHost
    if (!extHost) throw new Error('extension host is not connected')
    const state = registration.contribution.location === 'view' ? null : (session.state ?? null)
    await extHost.$resolveSession(registration.viewId, session.id, state)
    if (session.disposed) {
      void extHost.$disposeSession(session.id).catch(() => {})
      throw new Error('trusted view session disposed during resolve')
    }
    session.resolved = true
    this._logger.debug(
      `resolved trusted view session ${session.id} for ${registration.extensionId} / ${registration.viewId}`,
    )
    return component
  }

  private _waitForRegistration(session: IActiveSession): Promise<ITrustedViewRegistration> {
    const existing = this._views.get(session.viewId)
    if (existing) return Promise.resolve(existing)
    return new Promise<ITrustedViewRegistration>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new Error(
                `trusted view "${session.viewId}" is not available (extension missing or not trusted)`,
              ),
            ),
          ),
        this._registrationTimeoutMs,
      )
      const subscription = this.onDidChangeView((changed) => {
        if (changed !== session.viewId) return
        const registration = this._views.get(session.viewId)
        if (registration) settle(() => resolve(registration))
      })
      const onAbort = (): void => settle(() => reject(new Error('trusted view session disposed')))
      const settle = (run: () => void): void => {
        clearTimeout(timer)
        subscription.dispose()
        session.abort.signal.removeEventListener('abort', onAbort)
        run()
      }
      session.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private _waitForProvider(session: IActiveSession): Promise<void> {
    if (this._providers.has(session.viewId)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new Error(
                `no provider registered for trusted view "${session.viewId}" (timed out after ${this._providerTimeoutMs}ms)`,
              ),
            ),
          ),
        this._providerTimeoutMs,
      )
      const registered = this._onDidRegisterProvider.event((registeredViewId) => {
        if (registeredViewId === session.viewId) settle(() => resolve())
      })
      const reset = this._onDidReset.event(() =>
        settle(() =>
          reject(new Error('extension host restarted before the view provider registered')),
        ),
      )
      const onAbort = (): void => settle(() => reject(new Error('trusted view session disposed')))
      const settle = (run: () => void): void => {
        clearTimeout(timer)
        registered.dispose()
        reset.dispose()
        session.abort.signal.removeEventListener('abort', onAbort)
        run()
      }
      session.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private _throwIfDisposed(session: IActiveSession): void {
    if (session.disposed) throw new Error('trusted view session disposed')
  }

  private _createContext(session: IActiveSession): TrustedViewContext {
    return {
      get extensionId(): string {
        return session.registration?.extensionId ?? ''
      },
      get viewId(): string {
        return session.viewId
      },
      get sessionId(): string {
        return session.id
      },
      get location(): TrustedViewLocation {
        return session.registration?.contribution.location ?? 'view'
      },
      get state(): unknown {
        // The wire carries null for "no state"; the contract exposes undefined.
        if (session.registration?.contribution.location === 'view') return undefined
        return session.state ?? undefined
      },
      request: async <T>(method: string, ...args: unknown[]): Promise<T> => {
        const extHost = this._extHost
        if (!extHost) throw new Error('extension host is not connected')
        return (await extHost.$request(session.id, method, args)) as T
      },
      onEvent: (listener) => {
        if (session.disposed) return { dispose: () => {} }
        session.listeners.add(listener)
        return {
          dispose: () => {
            session.listeners.delete(listener)
          },
        }
      },
      setTitle: (title) => {
        if (session.registration?.contribution.location !== 'editor') return
        session.setTitle?.(title)
      },
      addStyleSheet: (css) => this._addStyleSheet(session, css),
      log: {
        info: (message) => this._log(session, 'info', message),
        warn: (message) => this._log(session, 'warn', message),
        error: (message) => this._log(session, 'error', message),
      },
    }
  }

  private _log(session: IActiveSession, level: 'info' | 'warn' | 'error', message: string): void {
    const owner = session.registration?.extensionId ?? 'unknown'
    this._logger[level](`[${owner}/${session.viewId}] ${message}`)
  }

  private _addStyleSheet(session: IActiveSession, css: string): IDisposable {
    if (typeof document === 'undefined') return { dispose: () => {} }
    const style = document.createElement('style')
    style.setAttribute('data-trusted-view', session.viewId)
    style.textContent = css
    document.head.appendChild(style)
    session.styles.push(style)
    return {
      dispose: () => {
        const index = session.styles.indexOf(style)
        if (index >= 0) session.styles.splice(index, 1)
        style.parentNode?.removeChild(style)
      },
    }
  }

  private _disposeSession(session: IActiveSession): void {
    if (session.disposed) return
    session.disposed = true
    session.abort.abort()
    this._sessions.delete(session.id)
    session.listeners.clear()
    for (const style of session.styles.splice(0)) style.parentNode?.removeChild(style)
    const extHost = this._extHost
    if (extHost) {
      void extHost.$disposeSession(session.id).catch((err: unknown) => {
        this._logger.debug(
          `failed to dispose trusted view session ${session.id}: ${errorMessage(err)}`,
        )
      })
    }
  }

  private _invalidateSessions(viewId: string): void {
    for (const session of [...this._sessions.values()]) {
      if (session.viewId === viewId) this._disposeSession(session)
    }
    this._onDidInvalidateSessions.fire({ viewId })
  }

  // --- MainThreadTrustedViews callbacks ----------------------------------

  markProviderRegistered(viewId: string): void {
    this._providers.add(viewId)
    this._onDidRegisterProvider.fire(viewId)
    this._reviveFailedSessions(viewId)
  }

  /**
   * A failed session's missing piece arrived: tell its component to remount.
   * Healthy sessions are left alone (they are already resolved or will resolve
   * on their own pending promise).
   */
  private _reviveFailedSessions(viewId: string): void {
    for (const session of [...this._sessions.values()]) {
      if (session.viewId !== viewId || !session.failed || session.revived) continue
      if (session.disposed) continue
      session.revived = true
      this._onDidBecomeAvailable.fire({ viewId, sessionId: session.id })
    }
  }

  markProviderPending(extensionId: string, viewId: string): void {
    const registration = this._views.get(viewId)
    if (registration !== undefined) {
      // The view is already known: this is a normal announcement whose view
      // resolution raced the RPC (or the provider was re-announced).
      if (registration.extensionId === extensionId) this.markProviderRegistered(viewId)
      return
    }
    this._pendingProviders.set(viewId, extensionId)
    this._logger.debug(
      `deferring provider for untranslated trusted view ${extensionId} / ${viewId}`,
    )
  }

  private _adoptPendingProvider(registration: ITrustedViewRegistration): void {
    const extensionId = this._pendingProviders.get(registration.viewId)
    if (extensionId === undefined) return
    this._pendingProviders.delete(registration.viewId)
    if (extensionId !== registration.extensionId) return
    this.markProviderRegistered(registration.viewId)
  }

  markProviderUnregistered(viewId: string): void {
    this._pendingProviders.delete(viewId)
    if (!this._providers.delete(viewId)) return
    this._invalidateSessions(viewId)
  }

  postEvent(sessionId: string, name: string, data: unknown): void {
    const session = this._sessions.get(sessionId)
    if (!session || session.disposed) return
    for (const listener of [...session.listeners]) {
      try {
        listener(name, data)
      } catch (err) {
        this._logger.warn(
          `trusted view event listener threw for ${session.viewId}/${name}: ${errorMessage(err)}`,
        )
      }
    }
  }

  reset(): void {
    this._providers.clear()
    this._pendingProviders.clear()
    // Sessions are torn down without talking to the dead host; components
    // remount from `onDidInvalidateSessions` and re-resolve on the new one.
    for (const session of [...this._sessions.values()]) {
      session.disposed = true
      session.abort.abort()
      this._sessions.delete(session.id)
      session.listeners.clear()
      for (const style of session.styles.splice(0)) style.parentNode?.removeChild(style)
    }
    this._extHost = undefined
    this._activateByEvent = undefined
    this._onDidReset.fire()
    this._onDidInvalidateSessions.fire({})
  }
}

function getTrustedViewsRuntimeOrUndefined(): unknown {
  try {
    return getTrustedViewsRuntime()
  } catch {
    return undefined
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
