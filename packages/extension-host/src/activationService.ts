/**
 * Drives lazy activation of extensions. Holds the activated / in-flight maps,
 * matches an activation event against each extension's declared events, imports
 * the entry module and calls its `activate` exactly once. Errors are isolated:
 * a failed `activate` is logged to stderr and never tears down the host or other
 * extensions.
 */
import { pathToFileURL } from 'node:url'
import type { ExtensionContext } from '@universe-editor/extension-api'
import {
  getUntrustedWorkspaceSupportType,
  matchesActivationEvent,
} from '@universe-editor/extensions-common'
import type { IScannedExtension } from './extensionScanner.js'
import { createExtensionContext, type IExtensionStorage } from './apiFactory.js'

interface ActivatedExtension {
  readonly context: ExtensionContext
  readonly deactivate?: () => unknown
}

interface ExtensionModule {
  activate?: (context: ExtensionContext) => unknown
  deactivate?: () => unknown
}

/** Reported when an extension's `activate` throws, so the renderer can surface it. */
export interface IActivationErrorReport {
  readonly extensionId: string
  readonly displayName?: string
  readonly message: string
  readonly stack?: string
}

export class ExtensionActivationService {
  private readonly _activated = new Map<string, ActivatedExtension>()
  private readonly _activating = new Map<string, Promise<void>>()
  /** Every activation event seen so far, replayed after a trust grant. */
  private readonly _firedEvents = new Set<string>()

  constructor(
    private readonly _extensions: readonly IScannedExtension[],
    private readonly _isTrusted: () => boolean,
    private readonly _storage?: IExtensionStorage,
    private readonly _globalStorageHome?: string,
    private readonly _onActivationError?: (report: IActivationErrorReport) => void,
  ) {}

  /** Activate every extension whose declared events match `event`. */
  async activateByEvent(event: string): Promise<void> {
    this._firedEvents.add(event)
    const pending: Promise<void>[] = []
    for (const ext of this._extensions) {
      if (!this._isActivatable(ext)) continue
      if (matchesActivationEvent(ext.manifest.activationEvents ?? [], event)) {
        pending.push(this._activate(ext))
      }
    }
    await Promise.all(pending)
  }

  /**
   * Re-run every activation event seen so far. Called after a trust grant so
   * extensions that were gated off (and whose `onLanguage:` / other events fired
   * while untrusted, e.g. for already-open documents) now activate — without the
   * renderer having to replay document opens.
   */
  async replayFiredEvents(): Promise<void> {
    await Promise.all([...this._firedEvents].map((event) => this.activateByEvent(event)))
  }

  /**
   * VSCode `DisabledByTrustRequirement`: an extension whose untrusted-workspace
   * support is `false` is not activated at all in an untrusted workspace. A
   * `'limited'` extension still activates and gates itself via `workspace.isTrusted`.
   */
  private _isActivatable(ext: IScannedExtension): boolean {
    if (this._isTrusted()) return true
    // Built-ins ship with the app — implicitly trusted, like VSCode system extensions.
    if (ext.builtin) return true
    const support = getUntrustedWorkspaceSupportType({
      hasMain: ext.mainPath !== undefined,
      ...(ext.manifest.capabilities?.untrustedWorkspaces !== undefined
        ? { untrustedWorkspaces: ext.manifest.capabilities.untrustedWorkspaces }
        : {}),
    })
    if (support === false) {
      console.error(`[ext-host] ${ext.id} not activated: requires a trusted workspace`)
      return false
    }
    return true
  }

  private _activate(ext: IScannedExtension): Promise<void> {
    if (this._activated.has(ext.id)) return Promise.resolve()
    const inFlight = this._activating.get(ext.id)
    if (inFlight) return inFlight

    const promise = this._doActivate(ext).finally(() => {
      this._activating.delete(ext.id)
    })
    this._activating.set(ext.id, promise)
    return promise
  }

  private async _doActivate(ext: IScannedExtension): Promise<void> {
    const context = await createExtensionContext(ext, this._storage, this._globalStorageHome)
    try {
      let deactivate: (() => unknown) | undefined
      if (ext.mainPath) {
        const mod = (await import(pathToFileURL(ext.mainPath).href)) as ExtensionModule
        await mod.activate?.(context)
        deactivate = mod.deactivate
      }
      this._activated.set(ext.id, {
        context,
        ...(deactivate !== undefined ? { deactivate } : {}),
      })
      console.error(`[ext-host] activated ${ext.id}`)
    } catch (err) {
      const error = err as Error
      console.error(`[ext-host] activate failed ${ext.id}: ${error.stack ?? String(err)}`)
      this._onActivationError?.({
        extensionId: ext.id,
        ...(ext.manifest.displayName !== undefined
          ? { displayName: ext.manifest.displayName }
          : {}),
        message: error.message || String(err),
        ...(error.stack !== undefined ? { stack: error.stack } : {}),
      })
    }
  }

  /**
   * Deactivate every activated extension: call its `deactivate` hook and dispose
   * its `context.subscriptions`. Runs on host shutdown so extensions can release
   * OS resources they own — most importantly child processes they spawned (e.g.
   * the typescript plugin's tsserver), which otherwise orphan when the host dies.
   * Synchronous best-effort: errors are swallowed so one bad extension can't
   * block the rest, and a returned promise from `deactivate` is not awaited (the
   * host is about to exit; the disposables' synchronous kill is what matters).
   */
  disposeAll(): void {
    for (const [id, activated] of this._activated) {
      try {
        activated.deactivate?.()
      } catch (err) {
        console.error(`[ext-host] deactivate failed ${id}: ${(err as Error).message}`)
      }
      for (const sub of activated.context.subscriptions) {
        try {
          sub.dispose()
        } catch (err) {
          console.error(`[ext-host] subscription dispose failed ${id}: ${(err as Error).message}`)
        }
      }
    }
    this._activated.clear()
  }
}
