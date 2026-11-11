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
  hasPendingWork,
  inspectDelivery,
  preparePickDelivery,
  promoteAndPushDelivery,
  restoreMainDelivery,
  syncWorktreesDelivery,
  undeliverDelivery,
} from './deliveryGit.js'
import { readDeliveryChangeContext } from './deliveryChangeContext.js'
import { acquireDeliveryLock, heartbeatDeliveryLock, releaseDeliveryLock } from './deliveryLock.js'
import {
  inspectPushBranch,
  pushBranch,
  type PushBranchExecuteInput,
  type PushBranchExecuteResult,
  type PushBranchInspectInput,
  type PushBranchInspectResult,
} from './pushBranch.js'
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
  DeliveryFailure,
  DeliveryInspectInput,
  DeliveryInspectResult,
  DeliveryLockResult,
  DeliveryLockTokenInput,
  DeliveryPickResult,
  DeliveryPendingWorkInput,
  DeliveryPendingWorkResult,
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

const commandFailure = (name: string, err: unknown): { ok: false; error: DeliveryFailure } => ({
  ok: false,
  error: {
    code: 'git_failed',
    message: `git delivery command '${name}' failed`,
    detail: err instanceof Error ? err.message : String(err),
  },
})

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
      register(`git.agentDelivery.${name}`, async (...args: unknown[]) => {
        // A thrown handler would reject the extension-host command proxy and
        // lose the failure shape the renderer expects; always return a result.
        try {
          return await run(args[0] as TInput, log)
        } catch (err) {
          return commandFailure(name, err)
        }
      }),
    )
  }

  add<DeliveryInspectInput, DeliveryInspectResult>('inspect', inspectDelivery)
  add<DeliveryPendingWorkInput, DeliveryPendingWorkResult>('hasPendingWork', hasPendingWork)
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
  add<PushBranchInspectInput, PushBranchInspectResult>('inspectPushBranch', inspectPushBranch)
  add<PushBranchExecuteInput, PushBranchExecuteResult>('pushBranch', pushBranch)
  return registrations
}
