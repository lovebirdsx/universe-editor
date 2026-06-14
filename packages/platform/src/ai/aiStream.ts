/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Stream reassembly helpers for the receiving end of a cross-process AI stream.
 *  The IPC layer can only carry discrete chunk events; this rebuilds them into a
 *  clean AsyncIterable, mirroring VSCode's extHostLanguageModels reassembly.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource, DeferredPromise } from '../base/async.js'
import type { IDisposable } from '../base/lifecycle.js'
import type { AiRequestResult, AiResponse } from './aiModelService.js'
import type { AiResponseChunk } from './aiModelTypes.js'

/**
 * Routes discrete chunk / end events (already filtered to a single request) into
 * an {@link AiResponse}. The caller wires its transport subscriptions to call
 * `acceptChunk` / `acceptEnd`; this object owns the reassembly and the split
 * between `stream` (chunk consumer) and `result` (final-result / error waiter).
 *
 * Both `stream.reject` and `result.error` fire on failure — matching VSCode's
 * two-path error delivery so a stream consumer and a result waiter each see it.
 */
export class AiResponseReassembler {
  private readonly _source = new AsyncIterableSource<AiResponseChunk>()
  private readonly _result = new DeferredPromise<AiRequestResult>()
  private _usage: { inputTokens: number; outputTokens: number } | undefined

  /** Disposed automatically when the stream ends; the caller passes its subs in. */
  private _subscriptions: IDisposable | undefined

  constructor() {
    // A consumer may read only `stream` and never await `result`. Keep an
    // internal handler so a `result` rejection in that case is not reported as
    // an unhandled rejection — external awaiters still observe the rejection.
    this._result.p.catch(() => undefined)
  }

  bindSubscriptions(subscriptions: IDisposable): void {
    if (this._result.isSettled) {
      subscriptions.dispose()
      return
    }
    this._subscriptions = subscriptions
  }

  get response(): AiResponse {
    return { stream: this._source.asyncIterable, result: this._result.p }
  }

  acceptChunk(chunk: AiResponseChunk): void {
    if (this._result.isSettled) return
    if (chunk.type === 'usage') {
      this._usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens }
    }
    this._source.emitOne(chunk)
  }

  acceptEnd(error?: unknown): void {
    if (this._result.isSettled) return
    if (error !== undefined) {
      this._source.reject(error)
      this._result.error(error)
    } else {
      this._source.resolve()
      this._result.complete(this._usage ? { usage: this._usage } : {})
    }
    this._subscriptions?.dispose()
    this._subscriptions = undefined
  }
}
