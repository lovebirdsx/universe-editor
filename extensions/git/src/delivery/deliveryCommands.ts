/**
 * Command surface for the renderer's delivery orchestrator. Each command takes
 * one object argument and returns a serializable result; the git extension owns
 * every write, the renderer only sequences calls.
 */
import {
  abortPickDelivery,
  beginDelivery,
  commitSourceDelivery,
  continuePickDelivery,
  inspectDelivery,
  preparePickDelivery,
  promoteAndPushDelivery,
  restoreMainDelivery,
  syncWorktreesDelivery,
  undeliverDelivery,
} from './deliveryGit.js'
import { readDeliveryChangeContext } from './deliveryChangeContext.js'
import { acquireDeliveryLock, heartbeatDeliveryLock, releaseDeliveryLock } from './deliveryLock.js'
import type {
  DeliveryAbortPickInput,
  DeliveryAbortPickResult,
  DeliveryAcquireLockInput,
  DeliveryAcquireLockResult,
  DeliveryBeginInput,
  DeliveryBeginResult,
  DeliveryChangeContextInput,
  DeliveryChangeContextResult,
  DeliveryCommitSourceInput,
  DeliveryCommitSourceResult,
  DeliveryContinuePickInput,
  DeliveryInspectInput,
  DeliveryInspectResult,
  DeliveryLockResult,
  DeliveryLockTokenInput,
  DeliveryPickResult,
  DeliveryPreparePickInput,
  DeliveryPromoteAndPushInput,
  DeliveryPromoteAndPushResult,
  DeliveryRestoreMainInput,
  DeliveryRestoreMainResult,
  DeliverySyncWorktreesInput,
  DeliverySyncWorktreesResult,
  DeliveryUndoInput,
  DeliveryUndoResult,
} from './deliveryTypes.js'

export interface DeliveryCommandRegistration {
  dispose(): void
}

export type DeliveryCommandRegister = (
  id: string,
  handler: (...args: unknown[]) => unknown,
) => DeliveryCommandRegistration

type Log = ((msg: string) => void) | undefined

export function registerDeliveryCommands(
  register: DeliveryCommandRegister,
  log?: Log,
): DeliveryCommandRegistration[] {
  const registrations: DeliveryCommandRegistration[] = []
  const add = <TInput, TResult>(
    name: string,
    run: (input: TInput, log?: Log) => Promise<TResult>,
  ): void => {
    registrations.push(
      register(`git.agentDelivery.${name}`, (...args: unknown[]) => run(args[0] as TInput, log)),
    )
  }

  add<DeliveryInspectInput, DeliveryInspectResult>('inspect', inspectDelivery)
  add<DeliveryAcquireLockInput, DeliveryAcquireLockResult>('acquireLock', acquireDeliveryLock)
  add<DeliveryLockTokenInput, DeliveryLockResult>('heartbeatLock', heartbeatDeliveryLock)
  add<DeliveryLockTokenInput, DeliveryLockResult>('releaseLock', releaseDeliveryLock)
  add<DeliveryBeginInput, DeliveryBeginResult>('begin', beginDelivery)
  add<DeliveryCommitSourceInput, DeliveryCommitSourceResult>('commitSource', commitSourceDelivery)
  add<DeliveryPreparePickInput, DeliveryPickResult>('preparePick', preparePickDelivery)
  add<DeliveryContinuePickInput, DeliveryPickResult>('continuePick', continuePickDelivery)
  add<DeliveryAbortPickInput, DeliveryAbortPickResult>('abortPick', abortPickDelivery)
  add<DeliveryPromoteAndPushInput, DeliveryPromoteAndPushResult>(
    'promoteAndPush',
    promoteAndPushDelivery,
  )
  add<DeliveryRestoreMainInput, DeliveryRestoreMainResult>('restoreMain', restoreMainDelivery)
  add<DeliverySyncWorktreesInput, DeliverySyncWorktreesResult>(
    'syncWorktrees',
    syncWorktreesDelivery,
  )
  add<DeliveryUndoInput, DeliveryUndoResult>('undo', undeliverDelivery)
  add<DeliveryChangeContextInput, DeliveryChangeContextResult>(
    'changeContext',
    readDeliveryChangeContext,
  )
  return registrations
}
