/**
 * Drives lazy activation of extensions. Holds the activated / in-flight maps,
 * matches an activation event against each extension's declared events, imports
 * the entry module and calls its `activate` exactly once. Errors are isolated:
 * a failed `activate` is logged to stderr and never tears down the host or other
 * extensions.
 */
import { pathToFileURL } from 'node:url'
import type { ExtensionContext } from '@universe-editor/extension-api'
import { matchesActivationEvent } from '@universe-editor/extensions-common'
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

export class ExtensionActivationService {
  private readonly _activated = new Map<string, ActivatedExtension>()
  private readonly _activating = new Map<string, Promise<void>>()

  constructor(
    private readonly _extensions: readonly IScannedExtension[],
    private readonly _storage?: IExtensionStorage,
  ) {}

  /** Activate every extension whose declared events match `event`. */
  async activateByEvent(event: string): Promise<void> {
    const pending: Promise<void>[] = []
    for (const ext of this._extensions) {
      if (matchesActivationEvent(ext.manifest.activationEvents ?? [], event)) {
        pending.push(this._activate(ext))
      }
    }
    await Promise.all(pending)
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
    const context = await createExtensionContext(ext, this._storage)
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
      console.error(`[ext-host] activate failed ${ext.id}: ${(err as Error).stack ?? String(err)}`)
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
