/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapter: re-exports from platform base + minimal stubs for VSCode observableInternal.
 *--------------------------------------------------------------------------------------------*/

// Disposable
export type { IDisposable } from '../../lifecycle.js'
export { DisposableStore, toDisposable } from '../../lifecycle.js'

// Event (VSCode-compatible shape)
export { Event } from '../../event.js'

// Disposable tracking (noop – no leak detection needed outside VSCode)
import type { IDisposable } from '../../lifecycle.js'
export function markAsDisposed(_disposable: IDisposable): void {}
export function trackDisposable<T extends IDisposable>(disposable: T): T {
  return disposable
}

// Equality
export type EqualityComparer<T> = (a: T, b: T) => boolean
export const strictEquals: EqualityComparer<unknown> = (a, b) => a === b

// Error utilities
export class BugIndicatingError extends Error {
  constructor(message?: string) {
    super(message ? `BugIndicatingError: ${message}` : 'BugIndicatingError')
    this.name = 'BugIndicatingError'
  }
}

export function onBugIndicatingError(error: unknown): void {
  console.error('[BugIndicatingError]', error)
}

export function onUnexpectedError(error: unknown): void {
  console.error('[UnexpectedError]', error)
}

export function assertFn(condition: () => boolean): void {
  if (!condition()) {
    throw new BugIndicatingError('Assertion failed')
  }
}

// IValueWithChangeEvent (used by observableFromEvent / utils)
import type { Event } from '../../event.js'
export interface IValueWithChangeEvent<T> {
  readonly onDidChange: Event<void>
  get value(): T
}
