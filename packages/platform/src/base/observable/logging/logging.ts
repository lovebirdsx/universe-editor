/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Noop logging stubs for VSCode observableInternal (logging stripped for production).
 *--------------------------------------------------------------------------------------------*/

export interface IObservableLogger {
  handleObservableCreated(obs: unknown, location: unknown): void
  handleOnListenerCountChanged(obs: unknown, count: number): void
  handleObservableUpdated(obs: unknown, info: unknown): void
  handleDerivedCleared(obs: unknown): void
  handleDerivedDependencyChanged(obs: unknown, dep: unknown, change: unknown): void
  handleDerivedRecomputed(obs: unknown, info: unknown): void
  handleDerivedCycle(obs: unknown): void
  handleAutorunCreated(obs: unknown, location: unknown): void
  handleAutorunDisposed(obs: unknown): void
  handleAutorunStarted(obs: unknown): void
  handleAutorunTriggered(obs: unknown): void
  handleAutorunFinished(obs: unknown): void
  handleAutorunDependencyChanged(obs: unknown, dep: unknown, change: unknown): void
  handleBeginTransaction(tx: unknown): void
  handleEndTransaction(tx: unknown): void
}

let _logger: IObservableLogger | undefined

export function getLogger(): IObservableLogger | undefined {
  return _logger
}

export function logObservable(_observable: unknown): void {}

export function addLogger(logger: IObservableLogger): void {
  _logger = logger
}

export function setLogObservableFn(_fn: unknown): void {}
