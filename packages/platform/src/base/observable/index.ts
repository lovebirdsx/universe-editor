/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Public API for the observable reactive primitive library (ported from VSCode).
 *
 *  Core usage:
 *    observableValue(name, initialValue)  – create a mutable observable
 *    derived(owner, reader => ...)        – create a derived/computed observable
 *    transaction(tx => { ... })           – batch multiple set() calls into one notification
 *    autorun(reader => { ... })           – run a side-effect that re-runs on dependencies change
 *--------------------------------------------------------------------------------------------*/

// Core interfaces
export type {
  IObservable,
  IObservableWithChange,
  IObserver,
  IReader,
  IReaderWithStore,
  ISettable,
  ISettableObservable,
  ITransaction,
} from './base.js'

// Primitive factories
export { observableValue, disposableObservableValue } from './observables/observableValue.js'
export { constObservable } from './observables/constObservable.js'
export type { IObservableSignal } from './observables/observableSignal.js'
export { observableSignal } from './observables/observableSignal.js'

// Derived / computed
export {
  derived,
  derivedDisposable,
  derivedHandleChanges,
  derivedOpts,
  derivedWithSetter,
  derivedWithStore,
} from './observables/derived.js'
export type { IDerivedReader } from './observables/derivedImpl.js'

// Autorun (side effects)
export {
  autorun,
  autorunDelta,
  autorunHandleChanges,
  autorunOpts,
  autorunWithStore,
  autorunWithStoreHandleChanges,
} from './reactions/autorun.js'

// Transactions
export {
  asyncTransaction,
  globalTransaction,
  subtransaction,
  transaction,
  TransactionImpl,
} from './transaction.js'

// Change tracking
export type { IChangeContext, IChangeTracker } from './changeTracker.js'
export { recordChanges, recordChangesLazy } from './changeTracker.js'

// Debug
export type { DebugOwner } from './debugName.js'

// Utils (non-cancellation)
export {
  debouncedObservable,
  derivedObservableWithCache,
  derivedObservableWithWritableCache,
  keepObserved,
  mapObservableArrayCached,
  observableFromPromise,
  recomputeInitiallyAndOnChange,
  signalFromObservable,
  throttledObservable,
  wasEventTriggeredRecently,
  isObservable,
} from './utils/utils.js'

// Event → observable bridge
export { observableFromEventOpts, observableFromEvent } from './observables/observableFromEvent.js'
