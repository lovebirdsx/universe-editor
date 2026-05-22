/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IProgressService (platform/progress/common/progress.ts).
 *  Single entry point for surfacing long-running async work in the UI.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import { createDecorator } from '../di/instantiation.js'

export const enum ProgressLocation {
  /** Quiet spinner in the status bar (no message popup). */
  Window = 10,
  /** Toast / notification center entry with optional cancel button and percent bar. */
  Notification = 15,
  /** Modal dialog — blocks interaction until done or cancelled. */
  Dialog = 20,
}

export interface IProgressStep {
  message?: string
  /**
   * When `total` is unspecified, this is a delta in [0..100] that accumulates
   * toward an implicit total of 100. When `total` is provided, this is a delta
   * in absolute units (matching `total`).
   */
  increment?: number
  total?: number
}

export interface IProgress<T> {
  report(value: T): void
}

export interface IProgressOptions {
  readonly location: ProgressLocation
  readonly title: string
  /** When true, the UI shows a cancel control and the injected token will flip. */
  readonly cancellable?: boolean
  /** Short tag identifying the originating feature; surfaced as tooltip / logs. */
  readonly source?: string
  /** Milliseconds before the UI mounts (default 150). Short tasks stay invisible. */
  readonly delay?: number
}

export interface IProgressService {
  readonly _serviceBrand: undefined

  /**
   * Run `task` while showing progress at `options.location`. The task receives a
   * progress reporter and a cancellation token. The returned promise settles with
   * the task's result (or rejection); UI is always cleaned up.
   */
  withProgress<R>(
    options: IProgressOptions,
    task: (progress: IProgress<IProgressStep>, token: CancellationToken) => Promise<R>,
  ): Promise<R>
}

export const IProgressService = createDecorator<IProgressService>('progressService')
