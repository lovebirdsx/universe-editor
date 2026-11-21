/**
 * Host-side provider + session registry backing `contributes.trustedViews`.
 *
 * The extension owns one {@link TrustedViewProvider} per declared view id; each
 * mounted renderer component becomes a {@link TrustedViewSession}. The renderer
 * owns the component and the trust decision (built-in / dev extension, or an
 * entry in the user-level `extensions.trustedViewExtensions` list); this
 * registry enforces the host-side attribution rule: the calling extension's
 * `context.trustedViews` carries its own id, and a provider/open may only use a
 * view id that **that** extension's manifest declares. A view id declared by
 * two extensions is ambiguous and rejected for both.
 */
import { CancellationToken, Emitter, type Event } from '@universe-editor/platform'
import type {
  Disposable,
  OpenTrustedEditorOptions,
  TrustedViewProvider,
  TrustedViewSession,
  TrustedViewsApi,
} from '@universe-editor/extension-api'
import type {
  IMainThreadTrustedViews,
  ITrustedEditorOpenDto,
} from '@universe-editor/extensions-common'
import type { IScannedExtension } from './extensionScanner.js'

interface IRegisteredProvider {
  readonly extensionId: string
  readonly provider: TrustedViewProvider
}

interface ISessionEntry {
  readonly session: HostTrustedViewSession
  readonly extensionId: string
  readonly viewId: string
  readonly provider: TrustedViewProvider
}

class HostTrustedViewSession implements TrustedViewSession {
  private readonly _onDidDispose = new Emitter<void>()
  readonly onDidDispose: Event<void> = this._onDidDispose.event
  private _disposed = false

  constructor(
    readonly id: string,
    readonly viewId: string,
    readonly state: unknown,
    private readonly _post: (name: string, data: unknown) => void,
  ) {}

  postEvent(name: string, data?: unknown): void {
    if (this._disposed) return
    this._post(name, data)
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onDidDispose.fire()
    this._onDidDispose.dispose()
  }
}

export class HostTrustedViewsRegistry {
  private readonly _providers = new Map<string, IRegisteredProvider>()
  private readonly _sessions = new Map<string, ISessionEntry>()
  /** viewId → owning extension id, from the scanned manifests. */
  private readonly _owners = new Map<string, string>()
  /** viewIds declared by more than one extension: ambiguous, so rejected. */
  private readonly _duplicates = new Set<string>()

  constructor(
    private readonly _mainThread: IMainThreadTrustedViews,
    extensions: readonly IScannedExtension[],
  ) {
    for (const ext of extensions) {
      if (ext.isValid === false) continue
      for (const view of ext.manifest.contributes?.trustedViews ?? []) {
        const owner = this._owners.get(view.id)
        if (owner === undefined) {
          this._owners.set(view.id, ext.id)
          continue
        }
        if (owner === ext.id || this._duplicates.has(view.id)) continue
        this._duplicates.add(view.id)
        console.warn(
          `[ext-host] trusted view "${view.id}" is declared by multiple extensions (${owner}, ${ext.id}); registrations for it are rejected`,
        )
      }
    }
  }

  /** The `context.trustedViews` handed to `extensionId`'s `activate`. */
  createApi(extensionId: string): TrustedViewsApi {
    return {
      registerProvider: (viewId, provider) => this.registerProvider(extensionId, viewId, provider),
      openEditor: (viewId, options) => this.openEditor(extensionId, viewId, options),
    }
  }

  private _assertOwner(extensionId: string, viewId: string): void {
    if (this._duplicates.has(viewId)) {
      throw new Error(`trusted view "${viewId}" is declared by multiple extensions`)
    }
    const owner = this._owners.get(viewId)
    if (owner === undefined) {
      throw new Error(`trusted view "${viewId}" is not declared by any extension manifest`)
    }
    if (owner !== extensionId) {
      throw new Error(
        `trusted view "${viewId}" is not declared by extension "${extensionId}" (owner: "${owner}")`,
      )
    }
  }

  registerProvider(extensionId: string, viewId: string, provider: TrustedViewProvider): Disposable {
    this._assertOwner(extensionId, viewId)
    if (this._providers.has(viewId)) {
      throw new Error(`a trusted view provider is already registered for: ${viewId}`)
    }
    this._providers.set(viewId, { extensionId, provider })
    console.info(`[ext-host] trusted view provider registered: ${extensionId} / ${viewId}`)
    void this._mainThread.$registerProvider(extensionId, viewId).catch((err: unknown) => {
      console.warn(
        `[ext-host] failed to announce trusted view provider ${viewId}: ${(err as Error).message}`,
      )
    })
    return {
      dispose: () => this.unregisterProvider(viewId),
    }
  }

  unregisterProvider(viewId: string): void {
    if (!this._providers.delete(viewId)) return
    for (const [sessionId, entry] of [...this._sessions]) {
      if (entry.viewId === viewId) this.disposeSession(sessionId)
    }
    void this._mainThread.$unregisterProvider(viewId).catch((err: unknown) => {
      console.warn(
        `[ext-host] failed to unannounce trusted view provider ${viewId}: ${(err as Error).message}`,
      )
    })
  }

  /** IExtHostTrustedViews.$resolveSession */
  async resolveSession(viewId: string, sessionId: string, state: unknown): Promise<void> {
    const registration = this._providers.get(viewId)
    if (!registration) {
      throw new Error(`no trusted view provider is registered for "${viewId}"`)
    }
    // The renderer may re-resolve a session id after a host restart/remount;
    // disposing the stale one first makes the operation idempotent.
    this.disposeSession(sessionId)
    const session = new HostTrustedViewSession(sessionId, viewId, state, (name, data) => {
      void this._mainThread.$postEvent(sessionId, name, data).catch((err: unknown) => {
        console.warn(
          `[ext-host] failed to post trusted view event ${name} to ${sessionId}: ${(err as Error).message}`,
        )
      })
    })
    try {
      await registration.provider.resolveSession?.(session)
    } catch (err) {
      // A session the provider failed to initialize must not stay routable.
      session.dispose()
      throw err
    }
    this._sessions.set(sessionId, {
      session,
      extensionId: registration.extensionId,
      viewId,
      provider: registration.provider,
    })
  }

  /** IExtHostTrustedViews.$request */
  request(
    sessionId: string,
    method: string,
    args: readonly unknown[],
    token: CancellationToken = CancellationToken.None,
  ): Promise<unknown> {
    const entry = this._sessions.get(sessionId)
    if (!entry) {
      return Promise.reject(new Error(`unknown trusted view session: ${sessionId}`))
    }
    try {
      return Promise.resolve(entry.provider.handleRequest(entry.session, method, args, token))
    } catch (err) {
      return Promise.reject(err as Error)
    }
  }

  /** IExtHostTrustedViews.$disposeSession */
  disposeSession(sessionId: string): void {
    const entry = this._sessions.get(sessionId)
    if (!entry) return
    this._sessions.delete(sessionId)
    entry.session.dispose()
  }

  /** `context.trustedViews.openEditor`: ask the renderer to open/focus the editor tab. */
  openEditor(
    extensionId: string,
    viewId: string,
    options: OpenTrustedEditorOptions = {},
  ): Promise<void> {
    try {
      this._assertOwner(extensionId, viewId)
    } catch (err) {
      return Promise.reject(err as Error)
    }
    const dto: ITrustedEditorOpenDto = {
      title: options.title ?? null,
      state: options.state ?? null,
      key: options.key ?? null,
      preserveFocus: options.preserveFocus ?? false,
    }
    return this._mainThread.$openEditor(extensionId, viewId, dto)
  }

  dispose(): void {
    for (const viewId of [...this._providers.keys()]) this.unregisterProvider(viewId)
    for (const sessionId of [...this._sessions.keys()]) this.disposeSession(sessionId)
  }
}
